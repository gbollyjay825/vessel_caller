from __future__ import annotations

import pyotp
import pytest
from django.utils import timezone
from django.test import override_settings
from passlib.hash import pbkdf2_sha256
from rest_framework.test import APIClient

from accounts.models import ActionToken, User, UserSession
from accounts.security import issue_action_token


pytestmark = pytest.mark.django_db


def test_health_and_readiness_are_public(api_client):
    health = api_client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert health.json()["release"]["sha"]
    ready = api_client.get("/api/readiness")
    assert ready.status_code == 200
    assert ready.json()["checks"] == {"database": True, "cache": True}


def test_openapi_schema_is_public_and_covers_identity(api_client):
    response = api_client.get("/api/openapi")

    assert response.status_code == 200
    schema = response.json()
    assert schema["openapi"].startswith("3.")
    assert schema["info"]["title"] == "Vessel Caller API"
    assert "/api/auth/login" in schema["paths"]
    assert "/api/users" in schema["paths"]


def test_registration_verification_and_session_login(api_client):
    response = api_client.post(
        "/api/auth/register",
        {
            "name": "New Admin",
            "email": "new@example.test",
            "password": "A-unique-production-password-2026!",
            "orgName": "New Shipping",
            "designatedPort": "Port of Calabar",
        },
        format="json",
    )
    assert response.status_code == 202
    user = User.objects.get(email="new@example.test")
    assert user.status == User.Status.INVITED
    pending_login = api_client.post(
        "/api/auth/login",
        {"email": user.email, "password": "A-unique-production-password-2026!"},
        format="json",
    )
    assert pending_login.status_code == 401
    assert pending_login.json()["detail"] == (
        "Email verification is required before you can sign in. "
        "Use the verification link sent to your email address."
    )
    _, raw = issue_action_token(user, ActionToken.Kind.VERIFY_EMAIL, hours=24)
    verified = api_client.post("/api/auth/verify-email", {"token": raw}, format="json")
    assert verified.status_code == 200
    assert (
        api_client.post("/api/auth/verify-email", {"token": raw}, format="json").status_code == 400
    )
    logged_in = api_client.post(
        "/api/auth/login",
        {"email": user.email, "password": "A-unique-production-password-2026!"},
        format="json",
    )
    assert logged_in.status_code == 200
    assert "token" not in logged_in.json()
    assert logged_in.json()["user"]["role"] == "Admin"
    assert api_client.get("/api/auth/me").status_code == 200
    assert UserSession.objects.filter(user=user, revoked_at__isnull=True).count() == 1
    assert api_client.post("/api/auth/logout").status_code == 204
    assert api_client.get("/api/auth/me").status_code in (401, 403)


@override_settings(PUBLIC_REGISTRATION_ENABLED=False, EMAIL_DELIVERY_BACKEND="disabled")
def test_internal_admin_testing_fails_closed_before_creating_email_onboarding_state(api_client):
    response = api_client.post(
        "/api/auth/register",
        {
            "name": "Blocked Admin",
            "email": "blocked@example.test",
            "password": "A-unique-production-password-2026!",
            "orgName": "Blocked Shipping",
            "designatedPort": "Port of Calabar",
        },
        format="json",
    )

    assert response.status_code == 503
    assert (
        response.json()["detail"]
        == "Organization registration is not open during internal admin testing."
    )
    assert not User.objects.filter(email="blocked@example.test").exists()
    assert (
        api_client.post(
            "/api/auth/forgot-password", {"email": "blocked@example.test"}, format="json"
        ).status_code
        == 503
    )


def test_legacy_passlib_password_upgrades_on_login(organization):
    user = User.objects.create(
        organization=organization,
        name="Legacy User",
        email="legacy@acme.test",
        password=pbkdf2_sha256.hash("Legacy-password-2026!"),
        role=User.Role.VIEWER,
        status=User.Status.ACTIVE,
        email_verified_at=timezone.now(),
    )
    client = APIClient()
    response = client.post(
        "/api/auth/login",
        {"email": user.email, "password": "Legacy-password-2026!"},
        format="json",
    )
    assert response.status_code == 200
    user.refresh_from_db()
    assert not user.password.startswith("$pbkdf2-sha256$")


def test_totp_and_recovery_codes_are_real(api_client, admin):
    logged_in = api_client.post(
        "/api/auth/login",
        {"email": admin.email, "password": "A-strong-admin-password-2026!"},
        format="json",
    )
    assert logged_in.status_code == 200
    setup = api_client.post(
        "/api/auth/mfa/setup",
        {"currentPassword": "A-strong-admin-password-2026!"},
        format="json",
    )
    assert setup.status_code == 200
    code = pyotp.TOTP(setup.json()["secret"]).now()
    confirm = api_client.post("/api/auth/mfa/confirm", {"code": code}, format="json")
    assert confirm.status_code == 200
    recovery = confirm.json()["recoveryCodes"]
    assert len(recovery) == 10
    api_client.post("/api/auth/logout")
    challenge = api_client.post(
        "/api/auth/login",
        {"email": admin.email, "password": "A-strong-admin-password-2026!"},
        format="json",
    )
    assert challenge.status_code == 202
    completed = api_client.post(
        "/api/auth/mfa/verify",
        {"challengeId": challenge.json()["challengeId"], "code": recovery[0]},
        format="json",
    )
    assert completed.status_code == 200
    api_client.post("/api/auth/logout")
    challenge2 = api_client.post(
        "/api/auth/login",
        {"email": admin.email, "password": "A-strong-admin-password-2026!"},
        format="json",
    )
    reused = api_client.post(
        "/api/auth/mfa/verify",
        {"challengeId": challenge2.json()["challengeId"], "code": recovery[0]},
        format="json",
    )
    assert reused.status_code == 401
