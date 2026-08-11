from __future__ import annotations

import pyotp
import pytest
from rest_framework.test import APIClient

from accounts.models import ActionToken
from accounts.security import issue_action_token

pytestmark = pytest.mark.django_db


def login(client, user, password):
    return client.post(
        "/api/auth/login",
        {"email": user.email, "password": password},
        format="json",
    )


def test_password_recovery_change_and_profile_email(admin):
    client = APIClient()
    generic = client.post("/api/auth/forgot-password", {"email": admin.email}, format="json")
    assert generic.status_code == 202
    _, raw = issue_action_token(admin, ActionToken.Kind.RESET_PASSWORD, hours=1)
    reset = client.post(
        "/api/auth/reset-password",
        {"token": raw, "password": "A-new-secure-password-2026!"},
        format="json",
    )
    assert reset.status_code == 200
    assert login(client, admin, "A-new-secure-password-2026!").status_code == 200
    changed = client.post(
        "/api/auth/change-password",
        {
            "currentPassword": "A-new-secure-password-2026!",
            "password": "Another-secure-password-2026!",
        },
        format="json",
    )
    assert changed.status_code == 200
    profile = client.put(
        "/api/profile",
        {
            "name": "Renamed Admin",
            "email": "new-admin@acme.test",
            "currentPassword": "Another-secure-password-2026!",
        },
        format="json",
    )
    assert profile.status_code == 200
    assert profile.json()["verificationRequired"] is True
    admin.refresh_from_db()
    assert admin.email == "admin@acme.test"
    assert admin.pending_email == "new-admin@acme.test"
    _, verify_raw = issue_action_token(
        admin,
        ActionToken.Kind.VERIFY_EMAIL,
        hours=24,
        metadata={"pendingEmail": "new-admin@acme.test"},
    )
    verified = APIClient().post("/api/auth/verify-email", {"token": verify_raw}, format="json")
    assert verified.status_code == 200
    admin.refresh_from_db()
    assert admin.email == "new-admin@acme.test"


def test_session_listing_selective_revoke_and_sign_out_everywhere(admin):
    first = APIClient()
    second = APIClient()
    assert login(first, admin, "A-strong-admin-password-2026!").status_code == 200
    assert login(second, admin, "A-strong-admin-password-2026!").status_code == 200
    listing = first.get("/api/auth/sessions")
    assert listing.status_code == 200
    assert len(listing.json()["results"]) == 2
    real_keys = set(admin.sessions.values_list("session_key", flat=True))
    assert all(item["id"] not in real_keys for item in listing.json()["results"])
    assert not any(key in str(listing.json()) for key in real_keys)
    other = next(item for item in listing.json()["results"] if not item["current"])
    assert first.delete(f"/api/auth/sessions/{other['id']}").status_code == 204
    assert second.get("/api/auth/me").status_code in (401, 403)
    assert first.post("/api/auth/sessions/sign-out-everywhere").status_code == 204
    assert first.get("/api/auth/me").status_code in (401, 403)


def test_mfa_recovery_regeneration_and_disable(admin):
    client = APIClient()
    assert login(client, admin, "A-strong-admin-password-2026!").status_code == 200
    setup = client.post(
        "/api/auth/mfa/setup",
        {"currentPassword": "A-strong-admin-password-2026!"},
        format="json",
    ).json()
    code = pyotp.TOTP(setup["secret"]).now()
    assert client.post("/api/auth/mfa/confirm", {"code": code}, format="json").status_code == 200
    fresh_code = pyotp.TOTP(setup["secret"]).now()
    regenerated = client.post("/api/auth/mfa/recovery-codes", {"code": fresh_code}, format="json")
    assert regenerated.status_code == 200
    disabled = client.delete(
        "/api/auth/mfa",
        {"password": "A-strong-admin-password-2026!"},
        format="json",
    )
    assert disabled.status_code == 204
    admin.refresh_from_db()
    assert not admin.mfa_enabled


def test_resend_and_expired_or_invalid_actions_are_generic(admin):
    client = APIClient()
    assert (
        client.post(
            "/api/auth/resend-verification",
            {"email": "missing@example.test"},
            format="json",
        ).status_code
        == 202
    )
    assert (
        client.post(
            "/api/auth/forgot-password",
            {"email": "missing@example.test"},
            format="json",
        ).status_code
        == 202
    )
    assert (
        client.post(
            "/api/auth/reset-password",
            {"token": "invalid", "password": "A-valid-password-2026!"},
            format="json",
        ).status_code
        == 400
    )


def test_csrf_is_enforced_for_real_session_login(admin):
    client = APIClient(enforce_csrf_checks=True)
    assert login(client, admin, "A-strong-admin-password-2026!").status_code == 403
    csrf = client.get("/api/auth/csrf")
    assert csrf.status_code == 200
    token = csrf.json()["csrfToken"]
    response = client.post(
        "/api/auth/login",
        {"email": admin.email, "password": "A-strong-admin-password-2026!"},
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )
    assert response.status_code == 200
