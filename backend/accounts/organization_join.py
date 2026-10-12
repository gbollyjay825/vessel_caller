"""Tenant membership via a shared link, email verification and Admin review."""

from __future__ import annotations

from datetime import timedelta

from django.conf import settings
from django.contrib.auth.hashers import make_password
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from audit.services import record_event
from organizations.models import Organization

from .models import OrganizationJoinRequest, OrganizationSignupLink, User
from .security import token_hash
from .services import opaque_token, queue_email


class JoinFlowError(Exception):
    pass


INVALID_LINK = "This sign-up link is invalid, expired or revoked"
INVALID_VERIFICATION = "This verification link is invalid or expired"


def _active_organization(organization_id):
    organization = (
        Organization.objects.select_for_update()
        .filter(
            pk=organization_id,
            kind=Organization.Kind.CUSTOMER,
            access_status=Organization.AccessStatus.ACTIVE,
        )
        .first()
    )
    if not organization:
        raise JoinFlowError(INVALID_LINK)
    return organization


def _locked_link(raw: str):
    digest = token_hash(raw)
    candidate = (
        OrganizationSignupLink.objects.filter(token_hash=digest)
        .values("id", "organization_id")
        .first()
    )
    if not candidate:
        raise JoinFlowError(INVALID_LINK)
    organization = _active_organization(candidate["organization_id"])
    link = (
        OrganizationSignupLink.objects.select_for_update()
        .filter(pk=candidate["id"], organization=organization, token_hash=digest)
        .first()
    )
    if not link or not link.active:
        raise JoinFlowError(INVALID_LINK)
    return organization, link


@transaction.atomic
def create_signup_link(*, actor: User, expires_in_days: int, request=None):
    organization = _active_organization(actor.organization_id)
    # The API permission boundary locks and reloads the actor before reaching
    # this service. Keep this check for direct service callers too.
    actor = User.objects.select_for_update().get(pk=actor.pk, organization=organization)
    if actor.role != User.Role.ADMIN or not actor.is_active:
        raise JoinFlowError("Only an active organization Admin can create a sign-up link")
    if expires_in_days not in {1, 7, 14, 30}:
        raise JoinFlowError("Choose a link lifetime of 1, 7, 14 or 30 days")
    now = timezone.now()
    for previous in organization.signup_links.select_for_update().filter(revoked_at__isnull=True):
        previous.revoked_at = now
        previous.save(update_fields=("revoked_at",))
        record_event(
            organization=organization,
            actor=actor,
            action="organization_signup_link.replaced",
            category="identity",
            target=previous,
            request=request,
        )
    raw = opaque_token()
    link = OrganizationSignupLink.objects.create(
        organization=organization,
        created_by=actor,
        token_hash=token_hash(raw),
        expires_at=now + timedelta(days=expires_in_days),
    )
    record_event(
        organization=organization,
        actor=actor,
        action="organization_signup_link.created",
        category="identity",
        target=link,
        request=request,
        after={"expiresAt": link.expires_at.isoformat()},
    )
    return link, f"{settings.FRONTEND_URL.rstrip('/')}/join-organization#token={raw}"


@transaction.atomic
def resolve_signup_link(raw: str):
    organization, link = _locked_link(raw)
    return organization, link


@transaction.atomic
def submit_join_request(*, raw: str, name: str, email: str, request=None):
    organization, link = _locked_link(raw)
    email = email.strip().lower()
    now = timezone.now()
    # Existing accounts cannot be transferred between organizations through a
    # public request. Return the same public response as a first submission.
    if User.objects.filter(email__iexact=email).exists():
        return None
    # A stale unverified request cannot reserve an address forever. Verified
    # pending requests are retained until their organization's Admin decides.
    OrganizationJoinRequest.objects.filter(
        Q(verification_expires_at__lte=now)
        | Q(signup_link__revoked_at__isnull=False)
        | Q(signup_link__expires_at__lte=now),
        email=email,
        status=OrganizationJoinRequest.Status.UNVERIFIED,
    ).update(
        status=OrganizationJoinRequest.Status.EXPIRED,
        password_hash="",
        verification_token_hash=None,
    )
    if OrganizationJoinRequest.objects.filter(
        email=email,
        status__in=[
            OrganizationJoinRequest.Status.UNVERIFIED,
            OrganizationJoinRequest.Status.PENDING,
        ],
    ).exists():
        # Retries do not rotate the verification token or emit another email.
        # No password is accepted before the email recipient verifies ownership.
        return None
    raw_verification = opaque_token()
    try:
        with transaction.atomic():
            join_request = OrganizationJoinRequest.objects.create(
                organization=organization,
                signup_link=link,
                name=name.strip(),
                email=email,
                verification_token_hash=token_hash(raw_verification),
                verification_expires_at=min(link.expires_at, now + timedelta(hours=24)),
            )
    except IntegrityError:
        # The partial unique email constraint resolves simultaneous submissions
        # across organizations without revealing the existing request.
        return None
    queue_email(
        to_email=email,
        subject=f"Verify your request to join {organization.name}",
        template="verify_email",
        context={
            "actionUrl": f"{settings.FRONTEND_URL.rstrip('/')}/join-organization/verify#token={raw_verification}",
            "message": f"Verify your email and choose your own password to request access to {organization.name}. An administrator must approve your role before you can sign in.",
        },
        idempotency_key=f"organization-join-verify:{join_request.id}",
        organization=organization,
    )
    record_event(
        organization=organization,
        actor=None,
        action="organization_join.requested",
        category="identity",
        target=join_request,
        target_label=email,
        request=request,
    )
    return join_request


@transaction.atomic
def verify_join_request(*, raw: str, password: str, request=None):
    digest = token_hash(raw)
    candidate = (
        OrganizationJoinRequest.objects.filter(
            verification_token_hash=digest, status=OrganizationJoinRequest.Status.UNVERIFIED
        )
        .values("id", "organization_id", "signup_link_id")
        .first()
    )
    if not candidate:
        raise JoinFlowError(INVALID_VERIFICATION)
    try:
        organization = _active_organization(candidate["organization_id"])
    except JoinFlowError as exc:
        raise JoinFlowError(INVALID_VERIFICATION) from exc
    link = OrganizationSignupLink.objects.select_for_update().get(pk=candidate["signup_link_id"])
    member_request = (
        OrganizationJoinRequest.objects.select_for_update()
        .filter(
            pk=candidate["id"],
            verification_token_hash=digest,
            status=OrganizationJoinRequest.Status.UNVERIFIED,
        )
        .first()
    )
    if (
        not link.active
        or not member_request
        or member_request.verification_expires_at <= timezone.now()
    ):
        raise JoinFlowError(INVALID_VERIFICATION)
    member_request.status = OrganizationJoinRequest.Status.PENDING
    member_request.email_verified_at = timezone.now()
    member_request.password_hash = make_password(password)
    member_request.verification_token_hash = None
    member_request.save(
        update_fields=("status", "email_verified_at", "password_hash", "verification_token_hash")
    )
    record_event(
        organization=organization,
        actor=None,
        action="organization_join.email_verified",
        category="identity",
        target=member_request,
        target_label=member_request.email,
        request=request,
    )
    return member_request


@transaction.atomic
def review_join_request(
    *, actor: User, request_id: str, approve: bool, role: str = User.Role.OPERATIONS, request=None
):
    organization = _active_organization(actor.organization_id)
    actor = User.objects.select_for_update().get(pk=actor.pk, organization=organization)
    if actor.role != User.Role.ADMIN or not actor.is_active:
        raise JoinFlowError("Only an active organization Admin can review join requests")
    member_request = (
        OrganizationJoinRequest.objects.select_for_update()
        .filter(pk=request_id, organization=organization)
        .first()
    )
    if not member_request:
        raise JoinFlowError("Join request not found")
    if approve and member_request.status == OrganizationJoinRequest.Status.APPROVED:
        if member_request.role != role:
            raise JoinFlowError("This request was already approved with a different role")
        return member_request, False
    if not approve and member_request.status == OrganizationJoinRequest.Status.REJECTED:
        return member_request, False
    if (
        member_request.status != OrganizationJoinRequest.Status.PENDING
        or not member_request.email_verified_at
    ):
        raise JoinFlowError("Only a verified request awaiting review can be reviewed")
    if role not in User.Role.values:
        raise JoinFlowError("Choose a valid role")
    now = timezone.now()
    if approve:
        if User.objects.filter(email__iexact=member_request.email).exists():
            raise JoinFlowError(
                "An account already uses this email. Review existing users instead."
            )
        try:
            with transaction.atomic():
                user = User.objects.create(
                    organization=organization,
                    email=member_request.email,
                    name=member_request.name,
                    password=member_request.password_hash,
                    role=role,
                    status=User.Status.ACTIVE,
                    email_verified_at=member_request.email_verified_at,
                    mfa_grace_ends_at=(
                        now + timedelta(days=settings.MFA_GRACE_DAYS)
                        if role in {User.Role.ADMIN, User.Role.FINANCE}
                        else None
                    ),
                )
        except IntegrityError as exc:
            raise JoinFlowError(
                "An account already uses this email. Review existing users instead."
            ) from exc
        member_request.user = user
        member_request.role = role
        member_request.status = OrganizationJoinRequest.Status.APPROVED
        queue_email(
            to_email=user.email,
            subject=f"Your access to {organization.name} is approved",
            template="security_notice",
            context={
                "actionUrl": f"{settings.FRONTEND_URL.rstrip('/')}/login",
                "message": f"Your administrator approved access to {organization.name} as {role}. Sign in with the password you chose when verifying your email.",
            },
            idempotency_key=f"organization-join-approved:{member_request.id}",
            organization=organization,
        )
    else:
        member_request.status = OrganizationJoinRequest.Status.REJECTED
    member_request.reviewed_by = actor
    member_request.reviewed_at = now
    member_request.password_hash = ""
    member_request.verification_token_hash = None
    member_request.save()
    record_event(
        organization=organization,
        actor=actor,
        action="organization_join.approved" if approve else "organization_join.rejected",
        category="identity",
        target=member_request,
        target_label=member_request.email,
        request=request,
        after={"status": member_request.status, "role": member_request.role or None},
    )
    return member_request, True
