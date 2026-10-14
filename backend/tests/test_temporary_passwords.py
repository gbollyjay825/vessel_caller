from __future__ import annotations

import json
from datetime import timedelta

import pyotp
import pytest
from django.conf import settings
from django.core.cache import cache
from django.contrib.sessions.models import Session
from django.db import connection
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import ActionToken, EmailOutbox, User, UserSession
from accounts.security import encrypt_secret, issue_action_token, token_hash
from accounts.services import InactiveAccountError, start_mfa_challenge, start_session
from audit.models import AuditEvent
from organizations.models import Organization

from .conftest import authenticated

pytestmark = pytest.mark.django_db
NEW_PASSWORD = "My-new-voyage-password-2026!"


@pytest.fixture(autouse=True)
def isolated_postgres(monkeypatch):
    assert connection.vendor == "postgresql", "Temporary-password access tests require PostgreSQL"
    cache.clear()
    monkeypatch.setattr("accounts.services._publish_outbox_email", lambda outbox_id: None)


def provision(admin, *, role="Operations", email="new.member@example.test"):
    response = authenticated(admin).post(
        "/api/users/temporary-password",
        {"name": "New Member", "email": email, "role": role},
        format="json",
    )
    assert response.status_code == 201, response.data
    return (
        User.objects.get(pk=response.data["user"]["id"]),
        response.data["temporaryPassword"],
        response,
    )


def challenge(user, password, *, client=None):
    client = client or APIClient()
    response = client.post(
        "/api/auth/login", {"email": user.email, "password": password}, format="json"
    )
    assert response.status_code == 202, response.data
    return client, response.data["passwordChangeToken"], response


def complete(client, token, password=NEW_PASSWORD):
    return client.post(
        "/api/auth/complete-temporary-password",
        {"token": token, "password": password},
        format="json",
    )


def test_creation_returns_password_once_without_proving_email_or_sending_email(admin, caplog):
    user, raw, response = provision(admin, email="New.Member@EXAMPLE.test")
    assert user.email == "new.member@example.test"
    assert len(raw) >= 32 and user.check_password(raw) and user.password != raw
    assert user.password_change_required and not user.is_active
    assert user.admin_provisioned_by == admin and user.admin_provisioned_at is not None
    assert user.email_verified_at is None
    assert user.temporary_password_expires_at > timezone.now() + timedelta(days=6, hours=23)
    assert response["Cache-Control"] == "no-store"
    assert (
        response.data["signInUrl"]
        == settings.FRONTEND_URL + f"/login?organizationId={admin.organization_id}"
    )
    assert response.data["user"]["emailVerified"] is False
    assert response.data["user"]["adminProvisioned"] is True
    assert not EmailOutbox.objects.exists()
    listing = authenticated(admin).get("/api/users").json()
    assert raw not in json.dumps(listing) and 'temporaryPassword"' not in json.dumps(listing)
    event = AuditEvent.objects.get(action="user.admin_provisioned", target_id=user.pk)
    assert raw not in json.dumps(event.after) and raw not in caplog.text
    retry = authenticated(admin).post(
        "/api/users/temporary-password",
        {"name": "Retry", "email": user.email, "role": "Admin"},
        format="json",
    )
    assert retry.status_code == 400 and raw not in json.dumps(retry.json())
    assert User.objects.filter(email=user.email).count() == 1


@pytest.mark.parametrize("role", ["Admin", "Operations", "Finance", "Viewer"])
def test_first_login_has_no_workspace_session_then_changes_password_and_obeys_role(admin, role):
    user, raw, _ = provision(admin, role=role)
    client, token, response = challenge(user, raw)
    assert response["Cache-Control"] == "no-store"
    assert set(response.data) == {
        "passwordChangeRequired",
        "passwordChangeToken",
        "passwordChangeExpiresAt",
    }
    assert not UserSession.objects.filter(user=user).exists()
    assert not Session.objects.exists()
    for path in ("/api/auth/me", "/api/state", "/api/users", "/api/profile"):
        assert client.get(path).status_code == 403
    pending = authenticated(user)
    assert pending.get("/api/auth/me").status_code == 403
    assert (
        pending.post(
            "/api/users/temporary-password",
            {
                "name": "Blocked",
                "email": "blocked@example.test",
                "role": "Viewer",
            },
            format="json",
        ).status_code
        == 403
    )
    token_obj = ActionToken.objects.get(token_hash=token_hash(token))
    assert token not in json.dumps(token_obj.metadata) and raw not in json.dumps(token_obj.metadata)
    assert token_obj.expires_at <= timezone.now() + timedelta(minutes=5)
    response = complete(client, token)
    assert response.status_code == 200, response.data
    assert response["Cache-Control"] == "no-store"
    assert response.data["user"]["role"] == role
    assert response.data["user"]["emailVerified"] is False
    user.refresh_from_db()
    assert (
        user.is_active
        and not user.password_change_required
        and user.temporary_password_expires_at is None
    )
    assert (
        user.email_verified_at is None
        and user.check_password(NEW_PASSWORD)
        and not user.check_password(raw)
    )
    assert UserSession.objects.filter(user=user).count() == 1
    assert client.get("/api/auth/me").status_code == 200
    assert client.get("/api/users").status_code == (200 if role == "Admin" else 403)
    assert ("users.manage" in response.data["permissions"]) == (role == "Admin")
    if role in {"Admin", "Finance"}:
        assert user.mfa_grace_ends_at > timezone.now()
    assert complete(APIClient(), token).status_code == 400
    assert (
        APIClient()
        .post("/api/auth/login", {"email": user.email, "password": raw}, format="json")
        .status_code
        == 401
    )
    assert (
        APIClient()
        .post("/api/auth/login", {"email": user.email, "password": NEW_PASSWORD}, format="json")
        .status_code
        == 200
    )
    assert not EmailOutbox.objects.exists()


@pytest.mark.parametrize("invalid_password", ["short", "12345678901234567890", "password1234"])
def test_replacement_password_validation_preserves_challenge(admin, invalid_password):
    user, raw, _ = provision(admin)
    client, token, _ = challenge(user, raw)
    response = complete(client, token, invalid_password)
    assert response.status_code == 400
    user.refresh_from_db()
    assert user.password_change_required and user.check_password(raw)
    assert complete(client, token).status_code == 200


def test_temporary_password_cannot_be_reused_or_related_to_identity(admin):
    user, raw, _ = provision(admin)
    client, token, _ = challenge(user, raw)
    response = complete(client, token, raw)
    assert response.status_code == 400 and raw not in json.dumps(response.json())
    response = complete(client, token, "new.member@example.test")
    assert response.status_code == 400
    assert complete(client, token).status_code == 200


@pytest.mark.parametrize(
    "restriction", ["expiry", "suspended", "removed", "tenant", "staff", "superuser"]
)
def test_restricted_temporary_user_cannot_sign_in_or_complete(admin, restriction):
    user, raw, _ = provision(admin)
    client, token, _ = challenge(user, raw)
    if restriction == "expiry":
        user.temporary_password_expires_at = timezone.now() - timedelta(seconds=1)
    elif restriction in {"suspended", "removed"}:
        user.status = restriction
    elif restriction == "tenant":
        user.organization.access_status = Organization.AccessStatus.SUSPENDED
        user.organization.suspended_at = timezone.now()
        user.organization.suspension_reason = "Temporary-password test"
        user.organization.save()
    else:
        setattr(user, "is_" + restriction, True)
    user.save()
    assert (
        APIClient()
        .post("/api/auth/login", {"email": user.email, "password": raw}, format="json")
        .status_code
        == 401
    )
    assert complete(client, token).status_code == 400
    assert not UserSession.objects.filter(user=user).exists()


def test_expired_rotated_and_password_version_changed_challenges_fail(admin):
    user, raw, _ = provision(admin)
    client, first, _ = challenge(user, raw)
    _, second, _ = challenge(user, raw)
    assert complete(client, first).status_code == 400
    ActionToken.objects.filter(token_hash=token_hash(second)).update(
        expires_at=timezone.now() - timedelta(seconds=1)
    )
    assert complete(client, second).status_code == 400
    _, third, _ = challenge(user, raw)
    user.set_password("Another-temporary-password-2026!")
    user.save(update_fields=("password",))
    assert complete(client, third).status_code == 400
    assert not UserSession.objects.filter(user=user).exists()


def test_enrolled_mfa_cannot_be_bypassed_after_password_change(admin):
    user, raw, _ = provision(admin, role="Admin")
    secret = pyotp.random_base32()
    user.mfa_secret = encrypt_secret(secret)
    user.mfa_enabled_at = timezone.now()
    user.save()
    client, token, _ = challenge(user, raw)
    response = complete(client, token)
    assert response.status_code == 202 and response.data["mfaRequired"] is True
    assert not UserSession.objects.filter(user=user).exists()
    assert client.get("/api/auth/me").status_code == 403
    response = client.post(
        "/api/auth/mfa/verify",
        {
            "challengeId": response.data["challengeId"],
            "code": pyotp.TOTP(secret).now(),
        },
        format="json",
    )
    assert response.status_code == 200 and response.data["user"]["role"] == "Admin"
    assert client.get("/api/users").status_code == 200


def test_pending_temp_admin_does_not_defeat_last_admin_safeguard(admin):
    pending, _, _ = provision(admin, role="Admin")
    assert (
        authenticated(pending)
        .patch(
            f"/api/users/{admin.id}",
            {"role": "Viewer"},
            format="json",
        )
        .status_code
        == 403
    )
    assert authenticated(pending).delete(f"/api/users/{admin.id}").status_code == 403
    assert (
        authenticated(admin)
        .patch(
            f"/api/users/{admin.id}",
            {"role": "Viewer"},
            format="json",
        )
        .status_code
        == 400
    )
    admin.refresh_from_db()
    assert admin.role == "Admin" and admin.is_active


@pytest.mark.parametrize("fixture_name", ["operations", "finance", "viewer"])
def test_only_tenant_admin_can_create(request, fixture_name):
    actor = request.getfixturevalue(fixture_name)
    assert (
        authenticated(actor)
        .post(
            "/api/users/temporary-password",
            {
                "name": "Blocked",
                "email": "blocked@example.test",
                "role": "Viewer",
            },
            format="json",
        )
        .status_code
        == 403
    )


def test_no_anonymous_creation_or_cross_tenant_transfer_or_elevation(admin, viewer):
    payload = {"name": "Blocked", "email": "blocked@example.test", "role": "System Admin"}
    assert (
        APIClient().post("/api/users/temporary-password", payload, format="json").status_code == 403
    )
    assert (
        authenticated(admin)
        .post("/api/users/temporary-password", payload, format="json")
        .status_code
        == 400
    )
    other = Organization.objects.create(name="Other", email="other@example.test", registered=True)
    _, _, response = provision(admin, email="belongs@example.test")
    user = User.objects.get(pk=response.data["user"]["id"])
    assert user.organization == admin.organization and not user.is_staff and not user.is_superuser
    cross_payload = {
        "name": "Other",
        "email": viewer.email,
        "role": "Admin",
        "organization": other.id,
        "is_staff": True,
        "is_superuser": True,
    }
    assert (
        authenticated(admin)
        .post("/api/users/temporary-password", cross_payload, format="json")
        .status_code
        == 400
    )
    viewer.refresh_from_db()
    assert viewer.role == "Viewer" and viewer.organization == admin.organization


def test_existing_unverified_account_does_not_gain_trusted_provisioning(organization):
    user = User.objects.create_user(
        email="unverified@example.test",
        password=NEW_PASSWORD,
        name="Unverified",
        organization=organization,
        status="active",
    )
    assert user.admin_provisioned_at is None and not user.login_identity_approved
    response = APIClient().post(
        "/api/auth/login", {"email": user.email, "password": NEW_PASSWORD}, format="json"
    )
    assert response.status_code == 401


def test_temp_login_ends_old_identity_session_and_has_csrf_protection(admin):
    client = APIClient()
    assert (
        client.post(
            "/api/auth/login",
            {"email": admin.email, "password": "A-strong-admin-password-2026!"},
            format="json",
        ).status_code
        == 200
    )
    user, raw, _ = provision(admin)
    challenge(user, raw, client=client)
    assert client.get("/api/auth/me").status_code == 403
    assert not UserSession.objects.filter(user=admin, revoked_at__isnull=True).exists()
    protected = APIClient(enforce_csrf_checks=True)
    assert (
        protected.post(
            "/api/auth/login", {"email": user.email, "password": raw}, format="json"
        ).status_code
        == 403
    )
    assert (
        protected.post(
            "/api/auth/complete-temporary-password",
            {"token": "invalid", "password": NEW_PASSWORD},
            format="json",
        ).status_code
        == 403
    )


def test_alt_reset_and_session_services_cannot_bypass_change(admin):
    user, raw, _ = provision(admin)
    client = APIClient()
    assert (
        client.post("/api/auth/forgot-password", {"email": user.email}, format="json").status_code
        == 202
    )
    assert not EmailOutbox.objects.exists()
    _, reset = issue_action_token(user, ActionToken.Kind.RESET_PASSWORD, hours=1)
    assert (
        client.post(
            "/api/auth/reset-password", {"token": reset, "password": NEW_PASSWORD}, format="json"
        ).status_code
        == 400
    )
    with pytest.raises(InactiveAccountError):
        start_session(None, user)
    with pytest.raises(InactiveAccountError):
        start_mfa_challenge(user)
    user.refresh_from_db()
    assert user.password_change_required and user.check_password(raw)


@pytest.mark.parametrize("action", ["remove", "suspend", "change_role"])
def test_admin_can_manage_pending_temp_admin_without_losing_last_usable_admin(admin, action):
    user, _, _ = provision(admin, role="Admin")
    client = authenticated(admin)
    if action == "remove":
        assert client.delete(f"/api/users/{user.id}").status_code == 200
    else:
        payload = {"status": "suspended"} if action == "suspend" else {"role": "Viewer"}
        assert client.patch(f"/api/users/{user.id}", payload, format="json").status_code == 200
    admin.refresh_from_db()
    assert admin.role == "Admin" and admin.is_active


@pytest.mark.parametrize("privilege", ["is_staff", "is_superuser"])
def test_staff_flags_do_not_substitute_for_tenant_admin_provisioning(admin, privilege):
    setattr(admin, privilege, True)
    admin.save()
    response = authenticated(admin).post(
        "/api/users/temporary-password",
        {"name": "Blocked", "email": "blocked@example.test", "role": "Admin"},
        format="json",
    )
    assert response.status_code == 403
    assert not User.objects.filter(email="blocked@example.test").exists()


def test_provisioning_fields_cannot_be_spoofed_by_admin_user_patch(admin, viewer):
    response = authenticated(admin).patch(
        f"/api/users/{viewer.id}",
        {
            "name": "Still Viewer",
            "adminProvisioned": True,
            "admin_provisioned_at": timezone.now().isoformat(),
            "passwordChangeRequired": False,
            "email_verified_at": timezone.now().isoformat(),
        },
        format="json",
    )
    assert response.status_code == 200
    viewer.refresh_from_db()
    assert viewer.admin_provisioned_at is None and viewer.admin_provisioned_by is None


def test_admin_regeneration_recovers_lost_or_expired_temp_password_without_changing_membership(
    admin,
):
    user, previous, _ = provision(admin, role="Finance")
    client, old_token, _ = challenge(user, previous)
    _, old_reset = issue_action_token(user, ActionToken.Kind.RESET_PASSWORD, hours=1)
    user.temporary_password_expires_at = timezone.now() - timedelta(seconds=1)
    user.save(update_fields=("temporary_password_expires_at",))
    response = authenticated(admin).post(
        f"/api/users/{user.id}/temporary-password",
        {
            "role": "Admin",
            "name": "Do not replace",
            "email": "other@example.test",
        },
        format="json",
    )
    assert response.status_code == 201
    assert response["Cache-Control"] == "no-store"
    replacement = response.data["temporaryPassword"]
    assert replacement != previous and len(replacement) >= 32
    user.refresh_from_db()
    assert (
        user.role == "Finance"
        and user.name == "New Member"
        and user.email == "new.member@example.test"
    )
    assert user.email_verified_at is None and user.admin_provisioned_by == admin
    assert user.check_password(replacement) and not user.check_password(previous)
    assert user.temporary_password_expires_at > timezone.now() + timedelta(days=6, hours=23)
    assert not user.is_active and user.password_change_required
    assert complete(client, old_token).status_code == 400
    assert (
        client.post(
            "/api/auth/reset-password",
            {"token": old_reset, "password": NEW_PASSWORD},
            format="json",
        ).status_code
        == 400
    )
    assert (
        APIClient()
        .post("/api/auth/login", {"email": user.email, "password": previous}, format="json")
        .status_code
        == 401
    )
    refreshed, token, _ = challenge(user, replacement)
    assert complete(refreshed, token).status_code == 200
    event = AuditEvent.objects.get(action="user.temporary_password_regenerated", target_id=user.pk)
    assert replacement not in json.dumps(event.after) and previous not in json.dumps(event.after)
    assert not EmailOutbox.objects.exists()


@pytest.mark.parametrize(
    "state", ["activated", "ordinary", "suspended", "removed", "staff", "superuser", "self"]
)
def test_regeneration_cannot_overwrite_other_credentials_or_restore_restricted_user(
    admin, viewer, state
):
    user, raw, _ = provision(admin)
    original_hash = user.password
    expected = 400
    if state == "activated":
        client, token, _ = challenge(user, raw)
        assert complete(client, token).status_code == 200
        user.refresh_from_db()
        original_hash = user.password
    elif state == "ordinary":
        user = viewer
        original_hash = user.password
    elif state in {"suspended", "removed"}:
        user.status = state
        user.save()
    elif state == "self":
        user = admin
        original_hash = user.password
        expected = 403
    else:
        setattr(user, "is_" + state, True)
        user.save()
        expected = 403
    response = authenticated(admin).post(
        f"/api/users/{user.id}/temporary-password", {}, format="json"
    )
    assert response.status_code == expected
    user.refresh_from_db()
    assert user.password == original_hash
    assert "temporaryPassword" not in response.data


def test_regeneration_is_tenant_admin_only_and_does_not_disclose_cross_tenant_user(
    admin, operations
):
    user, _, _ = provision(admin)
    assert (
        APIClient().post(f"/api/users/{user.id}/temporary-password", {}, format="json").status_code
        == 403
    )
    assert (
        authenticated(operations)
        .post(f"/api/users/{user.id}/temporary-password", {}, format="json")
        .status_code
        == 403
    )
    other_org = Organization.objects.create(
        name="Other", email="other@example.test", registered=True
    )
    other = User.objects.create_user(
        email="other@example.test",
        password=NEW_PASSWORD,
        name="Other Admin",
        role="Admin",
        status="active",
        organization=other_org,
        email_verified_at=timezone.now(),
    )
    assert (
        authenticated(other)
        .post(f"/api/users/{user.id}/temporary-password", {}, format="json")
        .status_code
        == 404
    )
