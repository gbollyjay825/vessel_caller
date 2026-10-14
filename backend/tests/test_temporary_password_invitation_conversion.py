from __future__ import annotations

import json
from datetime import timedelta

import pytest
from django.core.cache import cache
from django.db import connection
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import (
    EmailOutbox,
    Invitation,
    OrganizationJoinRequest,
    OrganizationSignupLink,
    User,
    UserSession,
)
from accounts.security import token_hash
from accounts.temporary_passwords import provision_temporary_user
from audit.models import AuditEvent
from organizations.models import Organization

from .conftest import authenticated
from .test_temporary_passwords import NEW_PASSWORD, challenge, complete

pytestmark = pytest.mark.django_db
EMAIL = "invited.member@example.test"
INVITATION_TOKEN = "isolated-pending-invitation-token"


@pytest.fixture(autouse=True)
def isolated_postgres(monkeypatch):
    assert connection.vendor == "postgresql", "Invitation conversion tests require PostgreSQL"
    cache.clear()
    monkeypatch.setattr("accounts.services._publish_outbox_email", lambda outbox_id: None)


def invitation_for(admin, *, organization=None, **overrides):
    return Invitation.objects.create(
        **{
            "organization": organization or admin.organization,
            "invited_by": admin,
            "name": "Email Invite Recipient",
            "email": EMAIL,
            "role": User.Role.OPERATIONS,
            "token_hash": token_hash(INVITATION_TOKEN),
            "expires_at": timezone.now() + timedelta(days=7),
            **overrides,
        }
    )


def create_member(admin, **overrides):
    return authenticated(admin).post(
        "/api/users/temporary-password",
        {"name": "New Member", "email": EMAIL, "role": User.Role.VIEWER, **overrides},
        format="json",
    )


def accept_invitation(raw=INVITATION_TOKEN):
    return APIClient().post(
        "/api/invitations/accept",
        {"token": raw, "password": NEW_PASSWORD},
        format="json",
    )


@pytest.mark.parametrize("overrides", [{}, {"replacePendingInvitation": False}])
def test_same_tenant_pending_invitation_requires_explicit_replacement(admin, overrides):
    invitation = invitation_for(admin)
    original_hash = invitation.token_hash
    response = create_member(admin, **overrides)
    assert response.status_code == 409
    assert response.json()["errors"] == {
        "code": "pending_invitation",
        "email": [
            "An email invitation is pending. Replace it with a temporary-password user to continue."
        ],
    }
    invitation.refresh_from_db()
    assert invitation.status == Invitation.Status.PENDING and invitation.revoked_at is None
    assert invitation.token_hash == original_hash
    assert not User.objects.filter(email=EMAIL).exists()
    assert not EmailOutbox.objects.exists() and not AuditEvent.objects.exists()


@pytest.mark.parametrize("role", User.Role.values)
def test_replacement_revokes_old_link_and_returns_selected_role_credentials_once(
    admin, role, caplog
):
    invitation = invitation_for(admin)
    response = create_member(
        admin, email="Invited.Member@EXAMPLE.test", role=role, replacePendingInvitation=True
    )
    assert response.status_code == 201, response.json()
    raw_password = response.data["temporaryPassword"]
    member = User.objects.get(email=EMAIL)
    assert member.role == role and member.name == "New Member"
    assert member.check_password(raw_password) and member.password != raw_password
    assert member.organization_id == admin.organization_id
    assert member.admin_provisioned_by == admin and member.admin_provisioned_at
    assert member.password_change_required and not member.is_active
    assert member.email_verified_at is None and member.mfa_grace_ends_at is None
    assert not member.is_staff and not member.is_superuser
    assert member.temporary_password_expires_at > timezone.now() + timedelta(days=6, hours=23)
    assert response["Cache-Control"] == "no-store" and response["Pragma"] == "no-cache"
    assert response.data["signInUrl"].endswith("/login")
    invitation.refresh_from_db()
    assert invitation.status == Invitation.Status.REVOKED and invitation.revoked_at
    assert invitation.accepted_at is None and invitation.role == User.Role.OPERATIONS
    assert accept_invitation().status_code == 400
    assert (
        authenticated(admin)
        .post(f"/api/invitations/{invitation.pk}/resend", {}, format="json")
        .status_code
        == 404
    )
    assert not EmailOutbox.objects.exists() and not UserSession.objects.filter(user=member).exists()
    event = AuditEvent.objects.get(action="invitation.revoked", target_id=invitation.pk)
    assert event.after == {
        "status": "revoked",
        "reason": "temporary_password_user_created",
        "userId": member.id,
    }
    assert (
        AuditEvent.objects.filter(action="user.admin_provisioned", target_id=member.pk).count() == 1
    )
    safe_values = json.dumps(
        list(AuditEvent.objects.values("before", "after")), default=str
    ) + json.dumps(authenticated(admin).get("/api/users").json())
    assert raw_password not in safe_values and INVITATION_TOKEN not in safe_values
    assert raw_password not in caplog.text and INVITATION_TOKEN not in caplog.text
    client, token, _ = challenge(member, raw_password)
    assert client.get("/api/auth/me").status_code == 403
    completed = complete(client, token)
    assert completed.status_code == 200 and completed.data["user"]["role"] == role
    member.refresh_from_db()
    assert member.is_active and member.check_password(NEW_PASSWORD)


@pytest.mark.parametrize("invitation_status", ["pending", "expired", "revoked", "accepted"])
def test_nonusable_invitation_does_not_block_or_reactivate_when_creating_user(
    admin, invitation_status
):
    invitation = invitation_for(
        admin,
        status=invitation_status,
        expires_at=timezone.now() - timedelta(seconds=1),
    )
    response = create_member(admin)
    assert response.status_code == 201, response.json()
    invitation.refresh_from_db()
    if invitation_status == "pending":
        assert invitation.status == "revoked" and invitation.revoked_at
        assert (
            authenticated(admin)
            .post(f"/api/invitations/{invitation.pk}/resend", {}, format="json")
            .status_code
            == 404
        )
    else:
        assert invitation.status == invitation_status
    assert accept_invitation().status_code == 400
    assert not EmailOutbox.objects.exists()


@pytest.mark.parametrize("own_pending_invitation", [False, True])
@pytest.mark.parametrize("replacement", [False, True])
def test_other_tenant_pending_invitation_is_not_disclosed_or_modified(
    admin, own_pending_invitation, replacement
):
    other = Organization.objects.create(name="Private Other Tenant", email="other@example.test")
    foreign = invitation_for(admin, organization=other)
    own = (
        invitation_for(admin, token_hash=token_hash("own-invitation-token"))
        if own_pending_invitation
        else None
    )
    response = create_member(admin, replacePendingInvitation=replacement)
    assert response.status_code == 400
    assert response.json()["errors"] == {
        "email": ["A user or pending invitation with this email already exists"]
    }
    assert other.name not in json.dumps(response.json()) and str(other.id) not in json.dumps(
        response.json()
    )
    foreign.refresh_from_db()
    assert foreign.status == "pending" and foreign.revoked_at is None
    if own:
        own.refresh_from_db()
        assert own.status == "pending" and own.revoked_at is None
    assert not User.objects.filter(email=EMAIL).exists() and not AuditEvent.objects.exists()


@pytest.mark.parametrize("status", User.Status.values)
@pytest.mark.parametrize("cross_tenant", [False, True])
def test_existing_user_is_never_overwritten_or_transferred(admin, status, cross_tenant):
    invitation = invitation_for(admin)
    organization = (
        Organization.objects.create(name="Other", email="other@example.test")
        if cross_tenant
        else admin.organization
    )
    member = User.objects.create_user(
        name="Existing Member",
        email=EMAIL,
        password=NEW_PASSWORD,
        organization=organization,
        role=User.Role.OPERATIONS,
        status=status,
    )
    previous = User.objects.filter(pk=member.pk).values().get()
    response = create_member(admin, role=User.Role.ADMIN, replacePendingInvitation=True)
    assert response.status_code == 400 and "code" not in response.json()["errors"]
    assert User.objects.filter(pk=member.pk).values().get() == previous
    invitation.refresh_from_db()
    assert invitation.status == "pending" and invitation.revoked_at is None
    assert not AuditEvent.objects.exists() and not EmailOutbox.objects.exists()


@pytest.mark.parametrize("join_status", ["unverified", "pending"])
def test_open_join_request_is_not_overridden_by_invitation_replacement(admin, join_status):
    invitation = invitation_for(admin)
    link = OrganizationSignupLink.objects.create(
        organization=admin.organization,
        created_by=admin,
        token_hash=token_hash("join-link-token"),
        expires_at=timezone.now() + timedelta(days=7),
    )
    join_request = OrganizationJoinRequest.objects.create(
        organization=admin.organization,
        signup_link=link,
        name="Join Request Member",
        email=EMAIL,
        verification_expires_at=timezone.now() + timedelta(days=1),
        status=join_status,
        password_hash="verified-password-hash" if join_status == "pending" else "",
        email_verified_at=timezone.now() if join_status == "pending" else None,
    )
    response = create_member(admin, replacePendingInvitation=True)
    assert response.status_code == 400 and "code" not in response.json()["errors"]
    invitation.refresh_from_db()
    join_request.refresh_from_db()
    assert invitation.status == "pending" and invitation.revoked_at is None
    assert join_request.status == join_status and not User.objects.filter(email=EMAIL).exists()


@pytest.mark.parametrize("fixture_name", ["operations", "finance", "viewer"])
def test_non_admin_cannot_replace_invitation(admin, request, fixture_name):
    invitation = invitation_for(admin)
    response = create_member(request.getfixturevalue(fixture_name), replacePendingInvitation=True)
    assert response.status_code == 403
    invitation.refresh_from_db()
    assert invitation.status == "pending" and not User.objects.filter(email=EMAIL).exists()


def test_invalid_replacement_flag_does_not_modify_invitation(admin):
    invitation = invitation_for(admin)
    response = create_member(admin, replacePendingInvitation="override")
    assert response.status_code == 400 and "replacePendingInvitation" in response.json()["errors"]
    invitation.refresh_from_db()
    assert invitation.status == "pending" and not User.objects.filter(email=EMAIL).exists()


def test_invitation_and_user_creation_rollback_together_on_audit_failure(admin, monkeypatch):
    invitation = invitation_for(admin)

    def unavailable_audit(**kwargs):
        raise RuntimeError("Audit unavailable")

    monkeypatch.setattr("accounts.temporary_passwords.record_identity_event", unavailable_audit)
    with pytest.raises(RuntimeError, match="Audit unavailable"):
        provision_temporary_user(
            actor=admin,
            name="New Member",
            email=EMAIL,
            role=User.Role.VIEWER,
            request=None,
            replace_pending_invitation=True,
        )
    invitation.refresh_from_db()
    assert invitation.status == "pending" and invitation.revoked_at is None
    assert not User.objects.filter(email=EMAIL).exists() and not AuditEvent.objects.exists()
