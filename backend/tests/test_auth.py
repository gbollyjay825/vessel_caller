from __future__ import annotations

from importlib import import_module

import pyotp
import pytest
from django.conf import settings
from django.contrib.sessions.models import Session
from django.http import HttpResponse
from django.test import RequestFactory
from django.apps import apps
from django.utils import timezone
from passlib.hash import pbkdf2_sha256
from rest_framework.test import APIClient

from accounts.middleware import IdentitySafeSessionMiddleware
from accounts.models import ActionToken, EmailOutbox, User, UserSession
from accounts.security import InactiveActionTarget, issue_action_token
from organizations.defaults import CALABAR_BERTH_TERMINALS
from organizations.models import Organization, OrganizationSettings


pytestmark = pytest.mark.django_db


def test_stale_ordinary_response_cannot_delete_a_new_login_cookie(admin):
    client = APIClient()
    credentials = {
        "email": admin.email,
        "password": "A-strong-admin-password-2026!",
    }
    assert client.post("/api/auth/login", credentials, format="json").status_code == 200
    session_a = client.cookies[settings.SESSION_COOKIE_NAME].value

    middleware = IdentitySafeSessionMiddleware(lambda request: HttpResponse("ok"))
    stale_request = RequestFactory().get(
        "/api/state",
        HTTP_COOKIE=f"{settings.SESSION_COOKIE_NAME}={session_a}",
    )
    middleware.process_request(stale_request)

    assert client.post("/api/auth/logout", format="json").status_code == 204
    assert not Session.objects.filter(session_key=session_a).exists()
    assert client.post("/api/auth/login", credentials, format="json").status_code == 200
    session_b = client.cookies[settings.SESSION_COOKIE_NAME].value
    assert session_b != session_a

    stale_response = middleware.process_response(stale_request, HttpResponse("ok"))
    assert settings.SESSION_COOKIE_NAME not in stale_response.cookies
    assert client.cookies[settings.SESSION_COOKIE_NAME].value == session_b
    assert client.get("/api/auth/me").status_code == 200


def test_health_and_readiness_are_public(api_client):
    health = api_client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert health.json()["release"]["sha"]
    assert health.json()["capabilities"] == {
        "organizationAccessStatus": True,
        "systemAdminEmailDeliveryReady": False,
    }
    ready = api_client.get("/api/readiness")
    assert ready.status_code == 200
    assert ready.json()["checks"] == {"database": True, "cache": True}
    assert ready.json()["capabilities"] == {
        "organizationAccessStatus": True,
        "systemAdminEmailDeliveryReady": False,
    }


@pytest.mark.parametrize(
    ("backend", "key", "sender", "expected"),
    [
        ("resend", "provider-key", "Vessel Caller <noreply@vesselcalls.com>", True),
        ("resend", "   ", "Vessel Caller <noreply@vesselcalls.com>", False),
        ("resend", "", "Vessel Caller <noreply@vesselcalls.com>", False),
        ("disabled", "provider-key", "Vessel Caller <noreply@vesselcalls.com>", False),
        ("resend", "provider-key", "", False),
    ],
)
def test_health_reports_effective_system_admin_email_delivery_readiness(
    api_client, settings, backend, key, sender, expected
):
    settings.EMAIL_DELIVERY_BACKEND = backend
    settings.RESEND_API_KEY = key
    settings.EMAIL_FROM = sender

    response = api_client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["capabilities"]["systemAdminEmailDeliveryReady"] is expected


def test_openapi_schema_is_public_and_covers_identity(api_client):
    response = api_client.get("/api/openapi")

    assert response.status_code == 200
    schema = response.json()
    assert schema["openapi"].startswith("3.")
    assert schema["info"]["title"] == "Vessel Caller API"
    assert "/api/auth/login" in schema["paths"]
    assert "/api/users" in schema["paths"]
    assert "/api/system/audit" in schema["paths"]
    assert "/api/system/organizations/{organization_id}/audit" in schema["paths"]
    assert "/api/system/organizations/{organization_id}/approve" in schema["paths"]
    operation_ids = [
        operation["operationId"]
        for path in schema["paths"].values()
        for operation in path.values()
        if isinstance(operation, dict) and "operationId" in operation
    ]
    assert len(operation_ids) == len(set(operation_ids))


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
    assert user.organization.access_status == Organization.AccessStatus.PENDING_APPROVAL
    assert OrganizationSettings.objects.get(organization=user.organization).terminals == list(
        CALABAR_BERTH_TERMINALS
    )
    verification_messages = EmailOutbox.objects.filter(
        to_email=user.email,
        template="verify_email",
    )
    assert verification_messages.count() == 1
    verification_message = verification_messages.get()
    assert verification_message.status == EmailOutbox.Status.SENT
    assert verification_message.allow_pending_approval_organization is True
    resent = api_client.post(
        "/api/auth/resend-verification",
        {"email": user.email},
        format="json",
    )
    assert resent.status_code == 202
    verification_messages = EmailOutbox.objects.filter(
        to_email="new@example.test",
        template="verify_email",
    )
    assert verification_messages.count() == 2
    resent_message = verification_messages.order_by("-created_at").first()
    assert resent_message is not None
    assert resent_message.allow_pending_approval_organization
    assert (
        api_client.post(
            "/api/auth/login",
            {"email": user.email, "password": "A-unique-production-password-2026!"},
            format="json",
        ).status_code
        == 401
    )
    _, raw = issue_action_token(
        user,
        ActionToken.Kind.VERIFY_EMAIL,
        hours=24,
        allow_pending_approval=True,
    )
    verified = api_client.post("/api/auth/verify-email", {"token": raw}, format="json")
    assert verified.status_code == 200
    assert verified.json()["approvalPending"] is True
    assert (
        api_client.post("/api/auth/verify-email", {"token": raw}, format="json").status_code == 400
    )
    user.refresh_from_db()
    assert user.status == User.Status.ACTIVE
    assert user.email_verified_at is not None
    pending_client = APIClient()
    pending_client.force_authenticate(user=user)
    assert pending_client.get("/api/state").status_code == 403
    pending_login = api_client.post(
        "/api/auth/login",
        {"email": user.email, "password": "A-unique-production-password-2026!"},
        format="json",
    )
    assert pending_login.status_code == 401
    reset = api_client.post(
        "/api/auth/forgot-password",
        {"email": user.email},
        format="json",
    )
    assert reset.status_code == 202
    assert not EmailOutbox.objects.filter(
        to_email=user.email,
        template="reset_password",
    ).exists()
    user.organization.access_status = Organization.AccessStatus.ACTIVE
    user.organization.save(update_fields=("access_status", "updated_at"))
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


def test_pending_verification_exception_never_applies_after_suspension(api_client):
    api_client.post(
        "/api/auth/register",
        {
            "name": "Suspended Before Verification",
            "email": "suspended-before-verify@example.test",
            "password": "A-unique-production-password-2026!",
            "orgName": "Suspended Pending Shipping",
            "designatedPort": "Port of Calabar",
        },
        format="json",
    )
    user = User.objects.get(email="suspended-before-verify@example.test")
    token, raw = issue_action_token(
        user,
        ActionToken.Kind.VERIFY_EMAIL,
        hours=24,
        allow_pending_approval=True,
    )
    with pytest.raises(ValueError, match="Only email verification tokens"):
        issue_action_token(
            user,
            ActionToken.Kind.RESET_PASSWORD,
            hours=1,
            allow_pending_approval=True,
        )
    with pytest.raises(InactiveActionTarget):
        issue_action_token(user, ActionToken.Kind.RESET_PASSWORD, hours=1)

    organization = user.organization
    organization.access_status = Organization.AccessStatus.SUSPENDED
    organization.suspended_at = timezone.now()
    organization.suspension_reason = "Verification stopped by support"
    organization.save(
        update_fields=("access_status", "suspended_at", "suspension_reason", "updated_at")
    )
    denied = api_client.post("/api/auth/verify-email", {"token": raw}, format="json")
    assert denied.status_code == 400
    token.refresh_from_db()
    user.refresh_from_db()
    assert token.used_at is None
    assert user.email_verified_at is None
    assert user.status == User.Status.INVITED


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
