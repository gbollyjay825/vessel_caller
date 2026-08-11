from __future__ import annotations

import json
import logging
import secrets
from datetime import timedelta
from functools import partial
from typing import TYPE_CHECKING

from django.conf import settings
from django.contrib.auth import login, logout, update_session_auth_hash
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone
from django.utils.crypto import salted_hmac

from .models import EmailOutbox, MFAChallenge, User, UserSession
from .security import encrypt_secret
from .tasks import deliver_outbox_email

if TYPE_CHECKING:
    from organizations.models import Organization


class InactiveAccountError(Exception):
    pass


MFA_FAILURE_LIMIT = 5
MFA_FAILURE_WINDOW_SECONDS = 15 * 60


def persist_session(request) -> None:
    """Persist once inside the caller's lifecycle lock and refresh its cookie.

    SessionMiddleware is deliberately configured not to save every response.
    Marking this explicit save clean prevents a second, post-transaction write
    from resurrecting a session that a concurrent suspension just revoked.
    ManagedSessionMiddleware emits the cookie without writing the row again.
    """

    request.session.save()
    request.session.modified = False
    raw_request = getattr(request, "_request", request)
    raw_request._vessel_refresh_session_cookie = True


def _mfa_failure_key(user_id: str) -> str:
    digest = salted_hmac("vessel-caller.mfa-failure.v1", str(user_id)).hexdigest()
    return f"auth:mfa:user:{digest}"


def mfa_failure_count(user_id: str) -> int:
    return int(cache.get(_mfa_failure_key(user_id), 0) or 0)


def record_mfa_failure(user_id: str) -> int:
    key = _mfa_failure_key(user_id)
    if cache.add(key, 1, timeout=MFA_FAILURE_WINDOW_SECONDS):
        return 1
    try:
        return int(cache.incr(key))
    except ValueError:
        cache.set(key, 1, timeout=MFA_FAILURE_WINDOW_SECONDS)
        return 1


def clear_mfa_failures(user_id: str) -> None:
    cache.delete(_mfa_failure_key(user_id))


log = logging.getLogger(__name__)


def _publish_outbox_email(outbox_id: str) -> None:
    """Best-effort broker publication for a durable outbox row.

    The database row is the source of truth. A broker outage after commit
    must not turn an otherwise successful API mutation into a false failure;
    the worker's periodic dispatcher will publish any row left pending.
    """

    try:
        deliver_outbox_email.apply_async(args=(outbox_id,), retry=False)
    except Exception:
        log.exception(
            "Could not publish email outbox item %s; periodic recovery will retry",
            outbox_id,
        )


def queue_email(
    *,
    to_email: str,
    subject: str,
    template: str,
    context: dict,
    idempotency_key: str,
    organization: Organization,
    allow_suspended_organization: bool = False,
) -> EmailOutbox:
    if organization is None:
        raise ValueError("Transactional application email requires an organization scope")
    outbox, created = EmailOutbox.objects.get_or_create(
        idempotency_key=idempotency_key,
        defaults={
            "to_email": to_email,
            "organization": organization,
            "allow_suspended_organization": allow_suspended_organization,
            "subject": subject,
            "template": template,
            "context": {
                "ciphertext": encrypt_secret(
                    json.dumps(context, separators=(",", ":"), sort_keys=True)
                )
            },
        },
    )
    if created:
        transaction.on_commit(
            partial(_publish_outbox_email, str(outbox.pk)),
            robust=True,
        )
    return outbox


@transaction.atomic
def lock_active_account(user: User) -> User:
    """Lock an active organization then its user using the lifecycle lock order."""

    from organizations.models import Organization

    organization = (
        Organization.objects.select_for_update()
        .filter(pk=user.organization_id, access_status=Organization.AccessStatus.ACTIVE)
        .first()
    )
    if not organization:
        raise InactiveAccountError
    locked_user = (
        User.objects.select_for_update()
        .select_related("organization")
        .filter(pk=user.pk, organization=organization, status=User.Status.ACTIVE)
        .first()
    )
    if not locked_user:
        raise InactiveAccountError
    return locked_user


@transaction.atomic
def start_session(request, user: User) -> UserSession:
    from organizations.models import Organization

    organization = Organization.objects.select_for_update().get(pk=user.organization_id)
    locked_user = (
        User.objects.select_for_update()
        .select_related("organization")
        .get(pk=user.pk, organization=organization)
    )
    if not locked_user.is_active or not locked_user.email_verified_at:
        raise InactiveAccountError
    login(request, locked_user, backend="accounts.backends.EmailBackend")
    request.session.cycle_key()
    persist_session(request)
    now = timezone.now()
    session = UserSession.objects.create(
        session_key=request.session.session_key,
        user=locked_user,
        ip_address=_client_ip(request),
        user_agent=request.META.get("HTTP_USER_AGENT", "")[:512],
        last_seen_at=now,
        absolute_expires_at=now + timedelta(seconds=settings.SESSION_ABSOLUTE_AGE),
    )
    return session


@transaction.atomic
def start_mfa_challenge(user: User) -> MFAChallenge:
    """Issue a challenge under the organization lock shared with suspension."""

    from organizations.models import Organization

    organization = Organization.objects.select_for_update().get(pk=user.organization_id)
    locked_user = (
        User.objects.select_for_update()
        .select_related("organization")
        .get(pk=user.pk, organization=organization)
    )
    if (
        not locked_user.is_active
        or not locked_user.email_verified_at
        or not locked_user.mfa_enabled
    ):
        raise InactiveAccountError
    MFAChallenge.objects.filter(user=locked_user, used_at__isnull=True).delete()
    return MFAChallenge.objects.create(
        user=locked_user,
        expires_at=timezone.now() + timedelta(minutes=5),
    )


def revoke_sessions(user: User, *, request=None, keep_current: bool = False) -> int:
    current = request.session.session_key if request is not None and keep_current else None
    queryset = UserSession.objects.filter(user=user, revoked_at__isnull=True)
    if current:
        queryset = queryset.exclude(session_key=current)
    keys = list(queryset.values_list("session_key", flat=True))
    updated = queryset.update(revoked_at=timezone.now())
    if keys:
        Session.objects.filter(session_key__in=keys).delete()
    return updated


def rotate_current_session(request, user: User) -> UserSession:
    old_key = request.session.session_key
    old = UserSession.objects.filter(session_key=old_key, user=user).first()
    update_session_auth_hash(request, user)
    persist_session(request)
    new_key = request.session.session_key
    if old:
        values = {
            "user": user,
            "ip_address": old.ip_address,
            "user_agent": old.user_agent,
            "last_seen_at": timezone.now(),
            "absolute_expires_at": old.absolute_expires_at,
        }
        old.delete()
    else:
        now = timezone.now()
        values = {
            "user": user,
            "ip_address": _client_ip(request),
            "user_agent": request.META.get("HTTP_USER_AGENT", "")[:512],
            "last_seen_at": now,
            "absolute_expires_at": now + timedelta(seconds=settings.SESSION_ABSOLUTE_AGE),
        }
    return UserSession.objects.create(session_key=new_key, **values)


def end_current_session(request) -> None:
    key = request.session.session_key
    if key:
        UserSession.objects.filter(session_key=key).update(revoked_at=timezone.now())
    logout(request)


def _client_ip(request):
    from audit.services import client_ip

    return client_ip(request)


def opaque_token() -> str:
    return secrets.token_urlsafe(48)
