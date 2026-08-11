from __future__ import annotations

from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from accounts.models import ActionToken, Invitation, MFAChallenge, MFARecoveryCode, User
from accounts.notifications import queue_security_notice
from accounts.platform_access import revoke_organization_sessions
from accounts.security import token_hash
from accounts.services import opaque_token, queue_email
from audit.services import record_event, record_platform_event
from billing.services import ensure_default_steps

from .defaults import CALABAR_BERTH_TERMINALS
from .models import Organization, OrganizationSettings


def _invitation_url(raw: str) -> str:
    return f"{settings.FRONTEND_URL}/accept-invitation?token={raw}"


def create_admin_invitation(
    *, organization: Organization, actor: User, name: str, email: str, request=None
) -> Invitation:
    normalized_email = email.strip().lower()
    if User.objects.filter(email=normalized_email).exists():
        raise ValueError("A user with this email already exists")
    if organization.invitations.filter(
        email=normalized_email,
        status=Invitation.Status.PENDING,
    ).exists():
        raise ValueError("A pending invitation already exists for this email")
    raw = opaque_token()
    invitation = Invitation.objects.create(
        organization=organization,
        name=name.strip(),
        email=normalized_email,
        role=User.Role.ADMIN,
        token_hash=token_hash(raw),
        invited_by=actor,
        expires_at=timezone.now() + timedelta(hours=24),
    )
    queue_email(
        to_email=normalized_email,
        subject=f"Join {organization.name} on Vessel Caller",
        template="invitation",
        context={"actionUrl": _invitation_url(raw)},
        idempotency_key=f"system-admin-invite:{invitation.id}",
        organization=organization,
    )
    record_platform_event(
        organization=organization,
        actor=actor,
        action="platform.admin_invitation.created",
        target=invitation,
        target_label=normalized_email,
        reason="Provisioned a customer organization administrator",
        request=request,
        after={"email": normalized_email, "role": User.Role.ADMIN, "expiresInHours": 24},
    )
    record_event(
        organization=organization,
        actor=None,
        action="platform.admin_invitation.created",
        category="platform",
        target=invitation,
        target_label="Vessel Caller System",
        request=request,
        after={"role": User.Role.ADMIN, "expiresInHours": 24},
    )
    organization.revision += 1
    organization.save(update_fields=("revision", "updated_at"))
    return invitation


@transaction.atomic
def create_customer_organization(*, data: dict, actor: User, request=None):
    organization = Organization.objects.create(
        kind=Organization.Kind.CUSTOMER,
        access_status=Organization.AccessStatus.ACTIVE,
        registered=False,
        name=data["name"].strip(),
        rc_number=data.get("rcNumber", "").strip(),
        email=data.get("email", "").strip().lower(),
        phone=data.get("phone", "").strip(),
        address=data.get("address", "").strip(),
        primary_port=data["primaryPort"].strip(),
        ports=data.get("ports") or [data["primaryPort"].strip()],
    )
    OrganizationSettings.objects.create(
        organization=organization,
        port_name=organization.primary_port,
        terminals=list(CALABAR_BERTH_TERMINALS),
    )
    ensure_default_steps(organization)
    invitation = create_admin_invitation(
        organization=organization,
        actor=actor,
        name=data["initialAdmin"]["name"],
        email=data["initialAdmin"]["email"],
        request=request,
    )
    record_platform_event(
        organization=organization,
        actor=actor,
        action="platform.organization.created",
        target=organization,
        target_label=organization.name,
        reason="Provisioned a new customer organization",
        request=request,
        after={"name": organization.name, "status": organization.access_status},
    )
    record_event(
        organization=organization,
        actor=None,
        action="platform.organization.created",
        category="platform",
        target=organization,
        target_label="Vessel Caller System",
        request=request,
        after={"status": organization.access_status},
    )
    return organization, invitation


@transaction.atomic
def suspend_customer_organization(
    *, organization: Organization, actor: User, reason: str, request=None
) -> bool:
    if organization.kind != Organization.Kind.CUSTOMER:
        raise ValueError("Only customer organizations can be suspended")
    if organization.access_status == Organization.AccessStatus.SUSPENDED:
        return False
    now = timezone.now()
    before = {"status": organization.access_status}
    organization.access_status = Organization.AccessStatus.SUSPENDED
    organization.suspended_at = now
    organization.suspension_reason = reason.strip()
    organization.revision += 1
    organization.save(
        update_fields=(
            "access_status",
            "suspended_at",
            "suspension_reason",
            "revision",
            "updated_at",
        )
    )
    revoke_organization_sessions(organization)
    ActionToken.objects.filter(
        user__organization=organization,
        used_at__isnull=True,
    ).delete()
    MFAChallenge.objects.filter(
        user__organization=organization,
        used_at__isnull=True,
    ).delete()
    MFARecoveryCode.objects.filter(user__organization=organization).delete()
    organization.invitations.filter(status=Invitation.Status.PENDING).update(
        status=Invitation.Status.REVOKED,
        revoked_at=now,
    )
    record_platform_event(
        organization=organization,
        actor=actor,
        action="platform.organization.suspended",
        target=organization,
        target_label=organization.name,
        reason=organization.suspension_reason,
        request=request,
        before=before,
        after={"status": organization.access_status, "reason": organization.suspension_reason},
    )
    record_event(
        organization=organization,
        actor=None,
        action="platform.organization.suspended",
        category="platform",
        target=organization,
        target_label="Vessel Caller System",
        request=request,
        before=before,
        after={"status": organization.access_status},
    )
    for admin in organization.users.filter(
        role=User.Role.ADMIN,
        status=User.Status.ACTIVE,
    ):
        queue_security_notice(
            admin,
            event_key=f"organization-suspended:{organization.id}:{organization.revision}:{admin.id}",
            subject="Your organization’s Vessel Caller access was suspended",
            message="Your organization’s Vessel Caller access was suspended. Contact Vessel Caller support if you need assistance.",
            allow_suspended_organization=True,
        )
    return True


@transaction.atomic
def reactivate_customer_organization(
    *, organization: Organization, actor: User, reason: str, request=None
) -> bool:
    if organization.kind != Organization.Kind.CUSTOMER:
        raise ValueError("Only customer organizations can be reactivated")
    if organization.access_status == Organization.AccessStatus.ACTIVE:
        return False
    before = {
        "status": organization.access_status,
        "reason": organization.suspension_reason,
    }
    organization.access_status = Organization.AccessStatus.ACTIVE
    organization.suspended_at = None
    organization.suspension_reason = ""
    organization.revision += 1
    organization.save(
        update_fields=(
            "access_status",
            "suspended_at",
            "suspension_reason",
            "revision",
            "updated_at",
        )
    )
    record_platform_event(
        organization=organization,
        actor=actor,
        action="platform.organization.reactivated",
        target=organization,
        target_label=organization.name,
        reason=reason.strip(),
        request=request,
        before=before,
        after={"status": organization.access_status, "reason": reason.strip()},
    )
    record_event(
        organization=organization,
        actor=None,
        action="platform.organization.reactivated",
        category="platform",
        target=organization,
        target_label="Vessel Caller System",
        request=request,
        before={"status": before["status"]},
        after={"status": organization.access_status},
    )
    for admin in organization.users.filter(
        role=User.Role.ADMIN,
        status=User.Status.ACTIVE,
    ):
        queue_security_notice(
            admin,
            event_key=f"organization-reactivated:{organization.id}:{organization.revision}:{admin.id}",
            subject="Your organization’s Vessel Caller access was restored",
            message="Your organization’s Vessel Caller access was restored. You can sign in again.",
        )
    return True
