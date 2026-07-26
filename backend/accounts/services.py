from __future__ import annotations

import json
import secrets
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import login, logout, update_session_auth_hash
from django.contrib.sessions.models import Session
from django.db import transaction
from django.utils import timezone

from .models import EmailOutbox, User, UserSession
from .security import encrypt_secret
from .tasks import deliver_outbox_email


def queue_email(
    *,
    to_email: str,
    subject: str,
    template: str,
    context: dict,
    idempotency_key: str,
) -> EmailOutbox:
    outbox, created = EmailOutbox.objects.get_or_create(
        idempotency_key=idempotency_key,
        defaults={
            "to_email": to_email,
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
        transaction.on_commit(lambda: deliver_outbox_email.delay(str(outbox.pk)))
    return outbox


def start_session(request, user: User) -> UserSession:
    login(request, user, backend="accounts.backends.EmailBackend")
    request.session.cycle_key()
    request.session.save()
    now = timezone.now()
    session = UserSession.objects.create(
        session_key=request.session.session_key,
        user=user,
        ip_address=_client_ip(request),
        user_agent=request.META.get("HTTP_USER_AGENT", "")[:512],
        last_seen_at=now,
        absolute_expires_at=now + timedelta(seconds=settings.SESSION_ABSOLUTE_AGE),
    )
    return session


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
    request.session.save()
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
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    return (
        forwarded.split(",", 1)[0].strip() if forwarded else request.META.get("REMOTE_ADDR")
    ) or None


def opaque_token() -> str:
    return secrets.token_urlsafe(48)
