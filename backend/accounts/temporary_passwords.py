"""Admin-provisioned membership with a strictly limited first sign-in.

Temporary credentials are ordinary password hashes; their plaintext exists
only in the creation response. Login produces a short-lived hash-only action
capability, never a UserSession, until a different password has been chosen.
"""

from __future__ import annotations

import secrets
from datetime import timedelta

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone
from django.utils.crypto import constant_time_compare, salted_hmac
from rest_framework.exceptions import APIException, NotFound, PermissionDenied, ValidationError

from audit.services import record_identity_event
from organizations.models import Organization

from .models import ActionToken, Invitation, MFAChallenge, OrganizationJoinRequest, User
from .security import token_hash
from .services import revoke_sessions

TEMPORARY_PASSWORD_DAYS = 7
PASSWORD_CHANGE_MINUTES = 5
CHANGE_ERROR = "This password-change request is invalid or expired. Sign in again."


class PendingInvitationConflict(APIException):
    status_code = 409
    default_code = "pending_invitation"

    def __init__(self):
        super().__init__(
            {
                "code": "pending_invitation",
                "email": [
                    "An email invitation is pending. Replace it with a temporary-password user to continue."
                ],
            }
        )


def _credential_version(user: User) -> str:
    return salted_hmac("vessel-caller.temporary-password.v1", user.password).hexdigest()


def _new_temporary_password() -> str:
    # 192 random bits plus guaranteed character classes accepted by the normal
    # password validators. This value is never persisted or emailed.
    return secrets.token_urlsafe(24) + "aA7!"


def _temporary_identity_available(user: User, *, now=None) -> bool:
    now = now or timezone.now()
    return bool(
        user.status == User.Status.ACTIVE
        and user.organization.kind == Organization.Kind.CUSTOMER
        and user.organization.is_access_active
        and not user.is_staff
        and not user.is_superuser
        and user.admin_provisioned_at
        and user.password_change_required
        and user.temporary_password_expires_at
        and user.temporary_password_expires_at > now
    )


@transaction.atomic
def provision_temporary_user(
    *,
    actor: User,
    name: str,
    email: str,
    role: str,
    request,
    replace_pending_invitation: bool = False,
):
    organization = (
        Organization.objects.select_for_update()
        .filter(
            pk=actor.organization_id,
            kind=Organization.Kind.CUSTOMER,
            access_status=Organization.AccessStatus.ACTIVE,
        )
        .first()
    )
    if not organization:
        raise ValidationError("This organization cannot add users")
    # Recheck the actor after acquiring the lifecycle lock. Staff privilege or
    # a platform grant never substitutes for a customer Admin membership.
    admin = User.objects.select_for_update().get(pk=actor.pk, organization=organization)
    if not admin.is_active or admin.role != User.Role.ADMIN or admin.is_staff or admin.is_superuser:
        raise PermissionDenied("An active organization Admin must add this user")
    email = email.strip().lower()
    now = timezone.now()
    if (
        User.objects.filter(email__iexact=email).exists()
        or Invitation.objects.filter(
            email__iexact=email, status=Invitation.Status.PENDING, expires_at__gt=now
        )
        .exclude(organization=organization)
        .exists()
        or OrganizationJoinRequest.objects.filter(
            email__iexact=email,
            status__in=(
                OrganizationJoinRequest.Status.UNVERIFIED,
                OrganizationJoinRequest.Status.PENDING,
            ),
        ).exists()
    ):
        raise ValidationError(
            {"email": ["A user or pending invitation with this email already exists"]}
        )
    # Invitation creation, resend and acceptance take this same organization
    # lifecycle lock first. A replacement cannot race acceptance into granting
    # two different credentials or roles. Never lock or change another tenant's
    # invitation, nor advertise its availability through the replaceable error.
    invitations = list(
        Invitation.objects.select_for_update().filter(
            organization=organization,
            email__iexact=email,
            status=Invitation.Status.PENDING,
        )
    )
    if not replace_pending_invitation and any(item.expires_at > now for item in invitations):
        raise PendingInvitationConflict()
    raw_password = _new_temporary_password()
    try:
        # Savepoint keeps the transaction usable when the global unique email
        # constraint wins a race from an Admin in a different organization.
        with transaction.atomic():
            user = User.objects.create_user(
                email=email,
                password=raw_password,
                name=name.strip(),
                role=role,
                organization=organization,
                status=User.Status.ACTIVE,
                admin_provisioned_at=now,
                admin_provisioned_by=admin,
                password_change_required=True,
                temporary_password_expires_at=now + timedelta(days=TEMPORARY_PASSWORD_DAYS),
            )
    except IntegrityError as exc:
        raise ValidationError({"email": ["A user with this email already exists"]}) from exc
    for invitation in invitations:
        # Even an expired pending invitation must not be resurrected by resend
        # after the user has been provisioned. Revocation and the new identity
        # commit together, so a failed create leaves the invitation usable.
        invitation.status = Invitation.Status.REVOKED
        invitation.revoked_at = now
        invitation.save(update_fields=("status", "revoked_at"))
        record_identity_event(
            organization=organization,
            actor=admin,
            action="invitation.revoked",
            target=invitation,
            target_label=invitation.email,
            request=request,
            before={"status": Invitation.Status.PENDING},
            after={
                "status": Invitation.Status.REVOKED,
                "reason": "temporary_password_user_created",
                "userId": user.id,
            },
        )
    record_identity_event(
        organization=organization,
        actor=admin,
        action="user.admin_provisioned",
        target=user,
        target_label=user.email,
        request=request,
        after={
            "role": user.role,
            "passwordChangeRequired": True,
            "temporaryPasswordExpiresAt": user.temporary_password_expires_at.isoformat(),
            "emailVerified": False,
        },
    )
    return user, raw_password


@transaction.atomic
def regenerate_temporary_password(*, actor: User, user_id: str, request):
    organization = (
        Organization.objects.select_for_update()
        .filter(
            pk=actor.organization_id,
            kind=Organization.Kind.CUSTOMER,
            access_status=Organization.AccessStatus.ACTIVE,
        )
        .first()
    )
    if not organization:
        raise NotFound("User not found")
    admin = User.objects.select_for_update().get(pk=actor.pk, organization=organization)
    if not admin.is_active or admin.role != User.Role.ADMIN or admin.is_staff or admin.is_superuser:
        raise PermissionDenied("An active organization Admin must add this user")
    user = User.objects.select_for_update().filter(pk=user_id, organization=organization).first()
    if user is None:
        raise NotFound("User not found")
    if user.pk == admin.pk or user.is_staff or user.is_superuser:
        raise PermissionDenied("This user cannot receive a temporary password")
    if (
        user.status != User.Status.ACTIVE
        or not user.admin_provisioned_at
        or not user.password_change_required
    ):
        raise ValidationError(
            "Only users awaiting their first password change can receive a new temporary password"
        )
    raw_password = _new_temporary_password()
    now = timezone.now()
    user.set_password(raw_password)
    user.temporary_password_expires_at = now + timedelta(days=TEMPORARY_PASSWORD_DAYS)
    user.save(update_fields=("password", "temporary_password_expires_at", "updated_at"))
    # Invalidate every outstanding capability bound to the old credential,
    # including a separately issued recovery token; none grants a shortcut.
    ActionToken.objects.filter(user=user, used_at__isnull=True).update(used_at=now)
    MFAChallenge.objects.filter(user=user, used_at__isnull=True).update(used_at=now)
    revoke_sessions(user)
    record_identity_event(
        organization=organization,
        actor=admin,
        action="user.temporary_password_regenerated",
        target=user,
        target_label=user.email,
        request=request,
        after={
            "role": user.role,
            "passwordChangeRequired": True,
            "temporaryPasswordExpiresAt": user.temporary_password_expires_at.isoformat(),
        },
    )
    return user, raw_password


@transaction.atomic
def temporary_password_challenge(*, email: str, password: str, request):
    candidate = User.objects.filter(email=email, password_change_required=True).first()
    if candidate is None:
        return None
    organization = (
        Organization.objects.select_for_update()
        .filter(
            pk=candidate.organization_id,
            kind=Organization.Kind.CUSTOMER,
            access_status=Organization.AccessStatus.ACTIVE,
        )
        .first()
    )
    user = (
        User.objects.select_for_update().filter(pk=candidate.pk, organization=organization).first()
        if organization is not None
        else None
    )
    temporary_expiry = user.temporary_password_expires_at if user is not None else None
    if (
        user is None
        or temporary_expiry is None
        or not _temporary_identity_available(user)
        or not user.check_password(password)
    ):
        # Match the usual missing/disabled-account hash cost without exposing
        # which account state rejected the credential.
        if user is None or not _temporary_identity_available(user):
            User().set_password(password)
        return None
    raw = secrets.token_urlsafe(48)
    ActionToken.objects.filter(
        user=user,
        kind=ActionToken.Kind.TEMPORARY_PASSWORD_CHANGE,
        used_at__isnull=True,
    ).delete()
    challenge = ActionToken.objects.create(
        user=user,
        kind=ActionToken.Kind.TEMPORARY_PASSWORD_CHANGE,
        token_hash=token_hash(raw),
        metadata={"credentialVersion": _credential_version(user)},
        expires_at=min(
            timezone.now() + timedelta(minutes=PASSWORD_CHANGE_MINUTES),
            temporary_expiry,
        ),
    )
    record_identity_event(
        organization=organization,
        actor=user,
        action="account.temporary_password_verified",
        target=user,
        target_label=user.email,
        request=request,
    )
    return challenge, raw


@transaction.atomic
def complete_temporary_password(*, raw: str, password: str, request) -> User:
    hashed = token_hash(raw)
    candidate = (
        ActionToken.objects.filter(
            token_hash=hashed,
            kind=ActionToken.Kind.TEMPORARY_PASSWORD_CHANGE,
            used_at__isnull=True,
        )
        .values("user_id", "user__organization_id")
        .first()
    )
    if not candidate:
        raise ValidationError({"token": [CHANGE_ERROR]})
    organization = (
        Organization.objects.select_for_update()
        .filter(
            pk=candidate["user__organization_id"],
            kind=Organization.Kind.CUSTOMER,
            access_status=Organization.AccessStatus.ACTIVE,
        )
        .first()
    )
    user = (
        User.objects.select_for_update()
        .filter(pk=candidate["user_id"], organization=organization)
        .first()
        if organization is not None
        else None
    )
    challenge = (
        ActionToken.objects.select_for_update()
        .filter(
            token_hash=hashed,
            user=user,
            kind=ActionToken.Kind.TEMPORARY_PASSWORD_CHANGE,
            used_at__isnull=True,
        )
        .first()
        if user is not None
        else None
    )
    now = timezone.now()
    if (
        user is None
        or challenge is None
        or challenge.expires_at <= now
        or not _temporary_identity_available(user, now=now)
        or not constant_time_compare(
            challenge.metadata.get("credentialVersion", ""), _credential_version(user)
        )
    ):
        raise ValidationError({"token": [CHANGE_ERROR]})
    try:
        validate_password(password, user=user)
    except DjangoValidationError as exc:
        raise ValidationError({"password": list(exc.messages)}) from exc
    if user.check_password(password):
        raise ValidationError(
            {"password": ["Choose a password different from the temporary password"]}
        )
    user.set_password(password)
    user.password_change_required = False
    user.temporary_password_expires_at = None
    # Grace starts when the account can first obtain a normal session. Existing
    # enrollment continues through the normal MFA challenge without bypass.
    if user.role in {User.Role.ADMIN, User.Role.FINANCE} and not user.mfa_enabled:
        from django.conf import settings

        user.mfa_grace_ends_at = now + timedelta(days=settings.MFA_GRACE_DAYS)
    user.save(
        update_fields=(
            "password",
            "password_change_required",
            "temporary_password_expires_at",
            "mfa_grace_ends_at",
            "updated_at",
        )
    )
    challenge.used_at = now
    challenge.save(update_fields=("used_at",))
    ActionToken.objects.filter(
        user=user, kind=ActionToken.Kind.TEMPORARY_PASSWORD_CHANGE, used_at__isnull=True
    ).update(used_at=now)
    revoke_sessions(user)
    record_identity_event(
        organization=organization,
        actor=user,
        action="account.temporary_password_replaced",
        target=user,
        target_label=user.email,
        request=request,
        after={"passwordChangeRequired": False, "emailVerified": bool(user.email_verified_at)},
    )
    return user
