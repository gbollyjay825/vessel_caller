from __future__ import annotations

from importlib import import_module

import pyotp
import pytest
from django.apps import apps
from django.utils import timezone
from passlib.hash import pbkdf2_sha256
from rest_framework.test import APIClient

from accounts.models import ActionToken, EmailOutbox, User, UserSession
from accounts.security import issue_action_token
from organizations.defaults import CALABAR_BERTH_TERMINALS
from organizations.models import OrganizationSettings


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


@pytest.mark.django_db(transaction=True)
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
    assert OrganizationSettings.objects.get(organization=user.organization).terminals == list(
        CALABAR_BERTH_TERMINALS
    )
    verification_messages = EmailOutbox.objects.filter(
        to_email=user.email,
        template="verify_email",
    )
    assert verification_messages.count() == 1
    assert verification_messages.get().status == EmailOutbox.Status.SENT
    assert (
        api_client.post(
            "/api/auth/login",
            {"email": user.email, "password": "A-unique-production-password-2026!"},
            format="json",
        ).status_code
        == 401
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


def test_duplicate_registration_does_not_leak_or_enqueue_another_email(api_client):
    payload = {
        "name": "New Admin",
        "email": "duplicate@example.test",
        "password": "A-unique-production-password-2026!",
        "orgName": "Duplicate Shipping",
        "designatedPort": "Port of Calabar",
    }

    first = api_client.post("/api/auth/register", payload, format="json")
    duplicate = api_client.post("/api/auth/register", payload, format="json")

    assert first.status_code == duplicate.status_code == 202
    assert first.json() == duplicate.json()
    assert User.objects.filter(email=payload["email"]).count() == 1
    assert (
        EmailOutbox.objects.filter(
            to_email=payload["email"],
            template="verify_email",
        ).count()
        == 1
    )


def test_calabar_berth_terminal_data_migration_preserves_existing_settings(organization):
    settings = OrganizationSettings.objects.get(organization=organization)
    settings.terminals = ["Calabar Bulk Terminal", "ECMT"]
    settings.save(update_fields=("terminals",))

    migration = import_module("organizations.migrations.0002_add_calabar_berth_terminals")
    migration.add_calabar_berth_terminals(apps, None)
    settings.refresh_from_db()

    assert settings.terminals == ["Calabar Bulk Terminal", "ECMT", "Intels", "NNPC"]

    migration.add_calabar_berth_terminals(apps, None)
    settings.refresh_from_db()
    assert settings.terminals == ["Calabar Bulk Terminal", "ECMT", "Intels", "NNPC"]


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
