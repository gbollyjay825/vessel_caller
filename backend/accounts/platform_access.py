from __future__ import annotations

from datetime import UTC, datetime, timedelta

from django.conf import settings
from django.contrib.sessions.models import Session
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from organizations.models import Organization

from .models import PlatformAccessGrant, User, UserSession


SYSTEM_ADMIN_PERMISSIONS = (
    "platform.organizations.view",
    "platform.organizations.manage",
    "platform.organization_users.view",
    "platform.organization_users.manage",
    "platform.audit.view",
    "platform.audit.export",
)


def active_platform_grant(user: User) -> PlatformAccessGrant | None:
    if not user.pk:
        return None
    return (
        PlatformAccessGrant.objects.filter(
            user=user,
            role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
            revoked_at__isnull=True,
        )
        .filter(Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now()))
        .first()
    )


@transaction.atomic
def lock_operational_platform_access(
    user: User,
) -> tuple[User, PlatformAccessGrant] | None:
    """Lock and revalidate the platform organization, identity, and grant in order."""

    organization = (
        Organization.objects.select_for_update()
        .filter(
            pk=user.organization_id,
            kind=Organization.Kind.PLATFORM,
            access_status=Organization.AccessStatus.ACTIVE,
        )
        .first()
    )
    if not organization:
        return None
    actor = (
        User.objects.select_for_update()
        .select_related("organization")
        .filter(
            pk=user.pk,
            organization=organization,
            status=User.Status.ACTIVE,
            email_verified_at__isnull=False,
            is_staff=False,
            is_superuser=False,
        )
        .first()
    )
    if not actor or not actor.mfa_enabled or not actor.mfa_secret:
        return None
    grant = (
        PlatformAccessGrant.objects.select_for_update()
        .filter(
            user=actor,
            role=PlatformAccessGrant.Role.SYSTEM_ADMIN,
            revoked_at__isnull=True,
        )
        .filter(Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now()))
        .first()
    )
    return (actor, grant) if grant else None


def platform_access_data(user: User, request=None) -> dict | None:
    grant = active_platform_grant(user)
    if not grant:
        return None
    enabled = bool(
        user.status == User.Status.ACTIVE
        and user.email_verified_at
        and user.organization.kind == Organization.Kind.PLATFORM
        and not user.is_staff
        and not user.is_superuser
    )
    verified_at = request.session.get("mfa_verified_at") if request is not None else None
    now = timezone.now()
    assurance_expires_at = None
    assurance_valid = False
    if isinstance(verified_at, (int, float)):
        verified = datetime.fromtimestamp(verified_at, tz=UTC)
        if verified <= now:
            assurance_expires_at = verified + timedelta(
                seconds=settings.SYSTEM_ADMIN_MFA_STEP_UP_SECONDS
            )
            assurance_valid = assurance_expires_at > now
    return {
        "role": grant.role,
        "permissions": list(SYSTEM_ADMIN_PERMISSIONS) if enabled and user.mfa_enabled else [],
        "mfaEnrollmentRequired": not user.mfa_enabled,
        "authorized": enabled and user.mfa_enabled,
        "expiresAt": grant.expires_at.isoformat() if grant.expires_at else None,
        "assuranceExpiresAt": (assurance_expires_at.isoformat() if assurance_expires_at else None),
        "stepUpRequired": bool(enabled and user.mfa_enabled and not assurance_valid),
    }


def revoke_organization_sessions(organization: Organization) -> int:
    user_ids = list(organization.users.values_list("id", flat=True))
    if not user_ids:
        return 0
    sessions = UserSession.objects.filter(
        user_id__in=user_ids,
        revoked_at__isnull=True,
    )
    session_keys = list(sessions.values_list("session_key", flat=True))
    updated = sessions.update(revoked_at=timezone.now())
    if session_keys:
        Session.objects.filter(session_key__in=session_keys).delete()
    return updated
