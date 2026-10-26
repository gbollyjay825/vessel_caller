from __future__ import annotations

import json
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

import pytest
from django.contrib.auth import authenticate
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import ActionToken, EmailOutbox, Invitation, User, UserSession
from accounts.security import decrypt_secret, encrypt_secret, issue_action_token, token_hash
from organizations.models import Organization

from .conftest import authenticated

pytestmark = pytest.mark.django_db
PASSWORD = "Scoped-original-password-2026!"
NEW_PASSWORD = "Scoped-replacement-password-2026!"


@pytest.fixture(autouse=True)
def isolated_state(monkeypatch):
    cache.clear()
    monkeypatch.setattr("accounts.services._publish_outbox_email", lambda outbox_id: None)


def other_account(email, *, password=PASSWORD, **overrides):
    org = Organization.objects.create(name="Original Organization", email="original@example.test")
    return User.objects.create_user(
        email=email,
        password=password,
        organization=org,
        name="Original Admin",
        role=User.Role.ADMIN,
        status=User.Status.ACTIVE,
        email_verified_at=timezone.now(),
        **overrides,
    )


def login(email, password, organization_id=None, client=None):
    return (client or APIClient()).post(
        "/api/auth/login",
        {
            "email": email,
            "password": password,
            **({"organizationId": organization_id} if organization_id else {}),
        },
        format="json",
    )


def test_generated_account_preserves_existing_account_and_sessions_entirely(admin):
    original = other_account("same@example.test")
    original_client = APIClient()
    assert login(original.email, PASSWORD, client=original_client).status_code == 200
    before_user = User.objects.filter(pk=original.pk).values().get()
    before_sessions = list(UserSession.objects.filter(user=original).values())
    invitation = Invitation.objects.create(
        organization=admin.organization,
        invited_by=admin,
        email=original.email,
        name="Requested Admin",
        role="Operations",
        token_hash=token_hash("old-scope-invite"),
        expires_at=timezone.now() + timedelta(days=7),
    )
    client = authenticated(admin)
    payload = {"name": "Requested Admin", "email": original.email, "role": "Admin"}
    assert client.post("/api/users/temporary-password", payload, format="json").status_code == 409
    created = client.post(
        "/api/users/temporary-password",
        {
            **payload,
            "replacePendingInvitation": True,
        },
        format="json",
    )
    assert created.status_code == 201, created.data
    new = User.objects.get(pk=created.data["user"]["id"])
    assert new.organization == admin.organization and new.role == "Admin"
    assert new.email == original.email and new.pk != original.pk
    assert new.password_change_required and not new.email_verified_at
    assert not new.mfa_enabled and new.admin_provisioned_by == admin
    assert created.data["signInUrl"].endswith(f"/login?organizationId={admin.organization_id}")
    assert User.objects.filter(pk=original.pk).values().get() == before_user
    assert list(UserSession.objects.filter(user=original).values()) == before_sessions
    invitation.refresh_from_db()
    assert invitation.status == "revoked" and invitation.revoked_at
    assert not EmailOutbox.objects.exists()
    temporary = created.data["temporaryPassword"]
    assert login(new.email, temporary, original.organization_id).status_code == 401
    assert login(new.email, PASSWORD, admin.organization_id).status_code == 401
    new_client = APIClient()
    challenge = login(new.email, temporary, admin.organization_id, client=new_client)
    assert challenge.status_code == 202 and challenge.data["passwordChangeRequired"]
    assert not UserSession.objects.filter(user=new).exists()
    completed = new_client.post(
        "/api/auth/complete-temporary-password",
        {
            "token": challenge.data["passwordChangeToken"],
            "password": NEW_PASSWORD,
        },
        format="json",
    )
    assert completed.status_code == 200 and completed.data["user"]["role"] == "Admin"
    assert completed.data["org"]["id"] == admin.organization_id
    assert new_client.get("/api/users").status_code == 200
    assert original_client.get("/api/auth/me").data["org"]["id"] == original.organization_id
    assert User.objects.filter(pk=original.pk).values().get() == before_user


def test_unique_normalized_email_within_org_only(admin):
    other = other_account(admin.email.upper())
    assert other.email == admin.email
    with pytest.raises(IntegrityError), transaction.atomic():
        User.objects.create(email=admin.email.upper(), organization=admin.organization, name="No")
    with pytest.raises(User.DoesNotExist):
        User.objects.get_by_natural_key(admin.email)


def test_unscoped_distinct_password_resolves_only_proven_org(admin):
    other = other_account(admin.email)
    old = login(admin.email, PASSWORD)
    assert old.status_code == 200 and old.data["org"]["id"] == other.organization_id
    current = login(admin.email, "A-strong-admin-password-2026!")
    assert current.status_code == 200 and current.data["org"]["id"] == admin.organization_id


def test_password_proven_chooser_creates_no_session_and_rechecks_selection(admin):
    other = other_account(admin.email, password="A-strong-admin-password-2026!")
    public = APIClient()
    wrong = login(admin.email, "incorrect", client=public)
    assert wrong.status_code == 401
    assert other.organization.name not in json.dumps(wrong.data)
    chooser = login(admin.email, "A-strong-admin-password-2026!", client=public)
    assert chooser.status_code == 202 and chooser.data["organizationSelectionRequired"]
    assert {item["id"] for item in chooser.data["organizations"]} == {
        admin.organization_id,
        other.organization_id,
    }
    assert chooser["Cache-Control"] == "no-store"
    assert not UserSession.objects.exists() and not ActionToken.objects.exists()
    assert public.get("/api/auth/me").status_code == 403
    assert authenticate(email=admin.email, password="A-strong-admin-password-2026!") is None
    assert (
        authenticate(
            email=admin.email,
            password="A-strong-admin-password-2026!",
            organization_id=admin.organization_id,
        )
        == admin
    )
    other.status = "suspended"
    other.save(update_fields=("status",))
    assert (
        login(admin.email, "A-strong-admin-password-2026!", other.organization_id).status_code
        == 401
    )
    assert login(admin.email, "incorrect", admin.organization_id).status_code == 401
    selected = login(admin.email, "A-strong-admin-password-2026!", admin.organization_id)
    assert selected.status_code == 200 and selected.data["org"]["id"] == admin.organization_id


def test_chooser_excludes_inactive_and_unverified_accounts(admin):
    other = other_account(admin.email, password="A-strong-admin-password-2026!")
    other.email_verified_at = None
    other.save(update_fields=("email_verified_at",))
    result = login(admin.email, "A-strong-admin-password-2026!")
    assert result.status_code == 200 and result.data["org"]["id"] == admin.organization_id


def test_selected_account_still_requires_its_own_mfa(admin):
    other = other_account(admin.email, password="A-strong-admin-password-2026!")
    other.mfa_secret = encrypt_secret("JBSWY3DPEHPK3PXP")
    other.mfa_enabled_at = timezone.now()
    other.save(update_fields=("mfa_secret", "mfa_enabled_at"))
    chooser = login(admin.email, "A-strong-admin-password-2026!")
    assert chooser.status_code == 202 and chooser.data["organizationSelectionRequired"]
    selected = login(admin.email, "A-strong-admin-password-2026!", other.organization_id)
    assert selected.status_code == 202 and selected.data["mfaRequired"]
    assert not UserSession.objects.exists()
    assert other.mfa_challenges.get(pk=selected.data["challengeId"]).user_id == other.pk


def test_large_shared_address_set_fails_closed_without_unbounded_hashes(admin, monkeypatch):
    for _ in range(16):
        other_account(admin.email)
    calls = []

    def track_proof(user, raw, **kwargs):
        calls.append(user.pk)
        return True

    monkeypatch.setattr("accounts.backends.verify_password_compat", track_proof)
    assert login(admin.email, PASSWORD).status_code == 401
    assert not calls and not UserSession.objects.exists()
    scoped = login(admin.email, "A-strong-admin-password-2026!", admin.organization_id)
    assert scoped.status_code == 200 and calls == [admin.pk]


def test_verification_resend_is_scoped_and_tokens_bind_each_account(admin):
    other = other_account(admin.email)
    for member in (admin, other):
        member.email_verified_at = None
        member.save(update_fields=("email_verified_at",))
    response = APIClient().post(
        "/api/auth/resend-verification",
        {
            "email": admin.email,
            "organizationId": admin.organization_id,
        },
        format="json",
    )
    assert response.status_code == 202
    outbox = EmailOutbox.objects.get(template="verify_email")
    assert outbox.organization_id == admin.organization_id
    context = json.loads(decrypt_secret(outbox.context["ciphertext"]))
    params = parse_qs(urlparse(context["actionUrl"]).query)
    assert params["organizationId"] == [admin.organization_id]
    verified = APIClient().post(
        "/api/auth/verify-email", {"token": params["token"][0]}, format="json"
    )
    assert verified.status_code == 200
    other.refresh_from_db()
    assert other.email_verified_at is None


@pytest.mark.parametrize("endpoint", ["forgot-password", "resend-verification"])
def test_anonymous_email_fanout_is_bounded_and_scoped_recovery_remains_usable(admin, endpoint):
    for _ in range(16):
        other_account(admin.email)
    if endpoint == "resend-verification":
        User.objects.filter(email=admin.email).update(email_verified_at=None)
    public = APIClient()
    unscoped = public.post(f"/api/auth/{endpoint}", {"email": admin.email}, format="json")
    assert unscoped.status_code == 202 and not EmailOutbox.objects.exists()
    assert "Original Organization" not in json.dumps(unscoped.data)
    scoped = public.post(
        f"/api/auth/{endpoint}",
        {
            "email": admin.email,
            "organizationId": admin.organization_id,
        },
        format="json",
    )
    assert scoped.status_code == 202
    outbox = EmailOutbox.objects.get()
    assert outbox.organization_id == admin.organization_id


def test_platform_operator_email_cannot_be_provisioned_as_customer_account(admin):
    platform = Organization.objects.create(
        name="Platform", email="platform@example.test", kind="platform"
    )
    operator = User.objects.create_user(
        email="reserved@example.test",
        name="Operator",
        password=PASSWORD,
        organization=platform,
        is_staff=True,
    )
    before = User.objects.filter(pk=operator.pk).values().get()
    response = authenticated(admin).post(
        "/api/users/temporary-password",
        {
            "name": "Customer Admin",
            "email": operator.email,
            "role": "Admin",
        },
        format="json",
    )
    assert response.status_code == 400
    assert User.objects.filter(pk=operator.pk).values().get() == before
    assert User.objects.filter(email=operator.email).count() == 1


def test_runtime_advertises_organization_identity_compatibility():
    for path in ("/api/health", "/api/readiness"):
        result = APIClient().get(path)
        assert result.status_code == 200
        assert result.data["capabilities"]["organizationScopedIdentity"] is True


@pytest.mark.parametrize("scoped", [True, False])
def test_recovery_targets_independent_credentials_and_never_cross_revokes(admin, scoped):
    other = other_account(admin.email)
    before = User.objects.filter(pk=other.pk).values().get()
    result = APIClient().post(
        "/api/auth/forgot-password",
        {
            "email": admin.email,
            **({"organizationId": admin.organization_id} if scoped else {}),
        },
        format="json",
    )
    assert result.status_code == 202
    emails = list(EmailOutbox.objects.filter(template="reset_password"))
    assert len(emails) == (1 if scoped else 2)
    outbox = next(item for item in emails if item.organization_id == admin.organization_id)
    context = json.loads(decrypt_secret(outbox.context["ciphertext"]))
    params = parse_qs(urlparse(context["actionUrl"]).query)
    assert params["organizationId"] == [admin.organization_id]
    assert admin.organization.name in outbox.subject
    reset = APIClient().post(
        "/api/auth/reset-password",
        {
            "token": params["token"][0],
            "password": NEW_PASSWORD,
        },
        format="json",
    )
    assert reset.status_code == 200 and reset.data["organizationId"] == admin.organization_id
    assert User.objects.filter(pk=other.pk).values().get() == before
    assert login(other.email, PASSWORD, other.organization_id).status_code == 200
    assert login(admin.email, NEW_PASSWORD, admin.organization_id).status_code == 200


def test_invitation_acceptance_for_same_email_keeps_original_credentials(admin):
    original = other_account("invited@example.test")
    before = User.objects.filter(pk=original.pk).values().get()
    result = authenticated(admin).post(
        "/api/invitations",
        {
            "name": "Additional account",
            "email": original.email,
            "role": "Viewer",
        },
        format="json",
    )
    assert result.status_code == 201
    invitation = Invitation.objects.get(pk=result.data["invitation"]["id"])
    assert invitation.deliverable
    outbox = EmailOutbox.objects.get(idempotency_key=f"invite:{invitation.id}")
    context = json.loads(decrypt_secret(outbox.context["ciphertext"]))
    params = parse_qs(urlparse(context["actionUrl"]).query)
    assert params["organizationId"] == [admin.organization_id]
    accepted = APIClient().post(
        "/api/invitations/accept",
        {
            "token": params["token"][0],
            "password": NEW_PASSWORD,
        },
        format="json",
    )
    assert accepted.status_code == 201 and accepted.data["organizationId"] == admin.organization_id
    assert User.objects.filter(pk=original.pk).values().get() == before
    assert login(original.email, PASSWORD, original.organization_id).status_code == 200
    assert (
        login(original.email, NEW_PASSWORD, admin.organization_id).data["user"]["role"] == "Viewer"
    )


def test_legacy_suppressed_invitation_resend_is_available_in_its_own_scope(admin):
    original = other_account("legacy-invite@example.test")
    before = User.objects.filter(pk=original.pk).values().get()
    invitation = Invitation.objects.create(
        organization=admin.organization,
        invited_by=admin,
        email=original.email,
        name="Additional account",
        role="Viewer",
        token_hash=token_hash("legacy-suppressed"),
        deliverable=False,
        expires_at=timezone.now() + timedelta(days=7),
    )
    result = authenticated(admin).post(
        f"/api/invitations/{invitation.pk}/resend", {}, format="json"
    )
    assert result.status_code == 200
    invitation.refresh_from_db()
    assert invitation.deliverable
    outbox = EmailOutbox.objects.get(template="invitation")
    assert outbox.organization_id == admin.organization_id and outbox.to_email == original.email
    context = json.loads(decrypt_secret(outbox.context["ciphertext"]))
    assert parse_qs(urlparse(context["actionUrl"]).query)["organizationId"] == [
        admin.organization_id
    ]
    assert User.objects.filter(pk=original.pk).values().get() == before


def test_email_change_checks_only_same_organization(admin):
    other = other_account("shared-new@example.test")
    before = User.objects.filter(pk=other.pk).values().get()
    result = authenticated(admin).put(
        "/api/profile",
        {
            "email": other.email,
            "currentPassword": "A-strong-admin-password-2026!",
        },
        format="json",
    )
    assert result.status_code == 200
    admin.refresh_from_db()
    _, raw = issue_action_token(
        admin, ActionToken.Kind.VERIFY_EMAIL, hours=1, metadata={"pendingEmail": other.email}
    )
    result = APIClient().post("/api/auth/verify-email", {"token": raw}, format="json")
    assert result.status_code == 200 and result.data["organizationId"] == admin.organization_id
    admin.refresh_from_db()
    assert admin.email == other.email
    assert User.objects.filter(pk=other.pk).values().get() == before
