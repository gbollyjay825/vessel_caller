from __future__ import annotations

import json
import io
import logging
from datetime import timedelta
from types import SimpleNamespace

import pytest
import boto3
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.core.management import CommandError, call_command
from django.contrib.auth.models import AnonymousUser
from django.contrib.sessions.middleware import SessionMiddleware
from django.http import HttpResponse
from django.test import RequestFactory, override_settings
from django.utils import timezone
from rest_framework.exceptions import ErrorDetail, NotFound, ValidationError

from accounts.backends import EmailBackend
from accounts.emailing import deliver
from accounts.middleware import ManagedSessionMiddleware
from accounts.models import User, UserSession
from accounts.security import decrypt_secret, use_recovery_code, verify_password_compat
from api.domain import rate_for_inspection
from api.exceptions import _plain, api_exception_handler, csrf_failure
from api.management.commands.import_legacy_sqlite import as_json, aware_datetime
from api.permissions import HasVesselPermission, effective_permissions
from api.serializers import number
from api.storage import (
    delete_object,
    object_exists,
    object_key,
    presign_download,
    presign_upload,
    safe_name,
)
from audit.services import _sanitize
from operations.models import Inspection
from organizations.models import OrganizationSettings
from vessel_caller.logging import JsonFormatter

from .test_services_and_importer import create_legacy_database

pytestmark = pytest.mark.django_db


def test_api_exception_normalization_branches():
    assert _plain({"field": (ErrorDetail("bad"), 1)}) == {"field": ["bad", 1]}
    assert api_exception_handler(RuntimeError("internal"), {}) is None

    missing = api_exception_handler(NotFound("Missing"), {})
    assert missing.data == {
        "detail": "Missing",
        "errors": None,
        "requestId": "",
    }

    request = SimpleNamespace(request_id="request-123")
    invalid = api_exception_handler(
        ValidationError({"field": [ErrorDetail("Invalid")]}),
        {"request": request},
    )
    assert invalid.data == {
        "detail": "The request could not be completed",
        "errors": {"field": ["Invalid"]},
        "requestId": "request-123",
    }

    csrf = csrf_failure(request, reason="test")
    assert csrf.status_code == 403
    assert json.loads(csrf.content)["requestId"] == "request-123"


def test_optional_serialization_and_logging_branches():
    assert number(None) is None
    record = logging.LogRecord(
        name="vessel-caller-test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="message",
        args=(),
        exc_info=None,
    )
    record.request_id = "request-123"
    payload = json.loads(JsonFormatter().format(record))
    assert payload["requestId"] == "request-123"


def test_auth_backend_permission_and_security_branches(admin, viewer):
    backend = EmailBackend()
    assert backend.authenticate(None, email="", password="x") is None
    assert backend.authenticate(None, email="missing@example.test", password="x") is None
    viewer.status = User.Status.SUSPENDED
    viewer.save(update_fields=("status",))
    assert (
        backend.authenticate(None, email=viewer.email, password="A-strong-viewer-password-2026!")
        is None
    )
    assert verify_password_compat(viewer, "wrong") is False
    assert decrypt_secret("invalid-ciphertext") == ""
    assert use_recovery_code(admin, "missing") is False
    assert effective_permissions(AnonymousUser()) == []
    admin.mfa_grace_ends_at = timezone.now() - timedelta(seconds=1)
    assert effective_permissions(admin) == []
    permission = HasVesselPermission()
    permission.required_permission = "calls.view"
    assert permission.has_permission(SimpleNamespace(user=admin), SimpleNamespace()) is False
    admin.mfa_grace_ends_at = None
    assert permission.has_permission(SimpleNamespace(user=admin), SimpleNamespace()) is True


def test_managed_session_missing_expired_and_touch_branches(admin):
    factory = RequestFactory()

    def request_with_session():
        request = factory.get("/api/auth/me")
        SessionMiddleware(lambda req: HttpResponse()).process_request(request)
        request.session.save()
        request.user = admin
        return request

    missing = request_with_session()
    ManagedSessionMiddleware(lambda req: HttpResponse("ok"))(missing)
    assert not missing.user.is_authenticated

    expired = request_with_session()
    UserSession.objects.create(
        session_key=expired.session.session_key,
        user=admin,
        absolute_expires_at=timezone.now() - timedelta(seconds=1),
    )
    ManagedSessionMiddleware(lambda req: HttpResponse("ok"))(expired)
    assert not expired.user.is_authenticated

    touched = request_with_session()
    managed = UserSession.objects.create(
        session_key=touched.session.session_key,
        user=admin,
        absolute_expires_at=timezone.now() + timedelta(days=1),
        last_seen_at=timezone.now() - timedelta(hours=1),
    )
    ManagedSessionMiddleware(lambda req: HttpResponse("ok"))(touched)
    managed.refresh_from_db()
    assert managed.last_seen_at > timezone.now() - timedelta(minutes=1)


def test_email_delivery_backends_and_resend_status(monkeypatch):
    with override_settings(EMAIL_DELIVERY_BACKEND="console"):
        assert (
            deliver(
                to_email="x@example.test",
                subject="Subject",
                template="email_changed",
                context={},
                idempotency_key="console-1",
            )
            == "console:console-1"
        )
    with override_settings(EMAIL_DELIVERY_BACKEND="unknown"):
        with pytest.raises(RuntimeError):
            deliver(
                to_email="x@example.test",
                subject="Subject",
                template="unknown",
                context={},
                idempotency_key="unknown-1",
            )

    class FakeResponse:
        def __init__(self, status, body):
            self.status = status
            self.body = body

        def read(self):
            return self.body

    class FakeConnection:
        next_status = 202
        next_body = json.dumps({"id": "provider-1"}).encode()

        def __init__(self, *args, **kwargs):
            self.request_args = None

        def request(self, *args, **kwargs):
            self.request_args = (args, kwargs)

        def getresponse(self):
            return FakeResponse(self.next_status, self.next_body)

        def close(self):
            return None

    monkeypatch.setattr("accounts.emailing.http.client.HTTPSConnection", FakeConnection)
    with override_settings(
        EMAIL_DELIVERY_BACKEND="resend",
        RESEND_API_KEY="test-key",
        EMAIL_FROM="noreply@example.test",
    ):
        assert (
            deliver(
                to_email="x@example.test",
                subject="Subject",
                template="invitation",
                context={"actionUrl": "https://example.test"},
                idempotency_key="resend-1",
            )
            == "provider-1"
        )
        FakeConnection.next_status = 500
        with pytest.raises(RuntimeError):
            deliver(
                to_email="x@example.test",
                subject="Subject",
                template="reset_password",
                context={},
                idempotency_key="resend-2",
            )
        FakeConnection.next_status = 199
        with pytest.raises(RuntimeError):
            deliver(
                to_email="x@example.test",
                subject="Subject",
                template="reset_password",
                context={},
                idempotency_key="resend-3",
            )
        FakeConnection.next_status = 202
        FakeConnection.next_body = b"not-json"
        with pytest.raises(RuntimeError, match="invalid response"):
            deliver(
                to_email="x@example.test",
                subject="Subject",
                template="reset_password",
                context={},
                idempotency_key="resend-invalid-json",
            )


def test_rate_selection_and_audit_sanitization(organization):
    settings_obj = organization.settings
    inspection = Inspection(cargo_type="Dry", jetty=None)
    assert rate_for_inspection(inspection, settings_obj) == settings_obj.dry_dues_rate
    inspection.cargo_type = "Liquid"
    inspection.jetty = {"type": "International"}
    assert rate_for_inspection(inspection, settings_obj) == settings_obj.international_liquid_rate
    inspection.jetty = {"type": "Local", "category": "Government"}
    assert rate_for_inspection(inspection, settings_obj) == settings_obj.government_liquid_rate
    inspection.jetty = {"type": "Local", "category": "Private"}
    assert rate_for_inspection(inspection, settings_obj) == settings_obj.private_liquid_rate
    inspection.jetty = {}
    assert rate_for_inspection(inspection, settings_obj) == 0
    assert _sanitize([{"token": "secret"}, 1]) == [{"token": "[REDACTED]"}, 1]


def test_user_manager_validation_and_superuser_creation():
    with pytest.raises(ValueError):
        User.objects.create_user(
            email="",
            password="irrelevant",
            name="No Email",
            organization=None,
        )
    superuser = User.objects.create_superuser(
        email="staff@example.test",
        password="A-strong-staff-password-2026!",
        name="Staff",
        organization_name="Staff Org",
    )
    assert superuser.is_staff and superuser.is_superuser
    assert OrganizationSettings.objects.filter(organization=superuser.organization).exists()


def test_spaces_presigning_existence_and_deletion_branches(monkeypatch):
    class FakeS3:
        fail_head = False

        def generate_presigned_url(self, operation, Params, ExpiresIn):
            return f"https://spaces.example/{operation}/{Params['Key']}"

        def head_object(self, **kwargs):
            if self.fail_head:
                raise RuntimeError("missing")
            return {
                "ContentLength": 1,
                "ContentType": "image/png",
                "Metadata": {"declared-size": "1", "sha256": "0" * 64},
            }

        def delete_object(self, **kwargs):
            return {"ok": True}

        def get_object(self, **kwargs):
            return {"Body": io.BytesIO(b"x")}

    fake = FakeS3()
    monkeypatch.setenv("VC_SPACES_KEY", "key")
    monkeypatch.setenv("VC_SPACES_SECRET", "secret")
    monkeypatch.setenv("VC_SPACES_BUCKET", "bucket")
    monkeypatch.setenv("VC_SPACES_ENDPOINT_URL", "https://spaces.example")
    monkeypatch.setattr(boto3, "client", lambda *args, **kwargs: fake)
    request = RequestFactory().get("/")
    request.__dict__["_tenant_lifecycle_locked_organization_id"] = "org-1"
    key = object_key("org-1", "in-1", "../../ unsafe image.png")
    assert key.startswith("organizations/org-1/inspections/in-1/")
    assert safe_name("////") == "evidence"
    upload = presign_upload(
        request,
        key=key,
        content_type="image/png",
        size=1,
        checksum="sha256:" + ("0" * 64),
    )
    assert upload["uploadUrl"].startswith("https://spaces.example/put_object")
    assert presign_download(request, key=key).startswith("https://spaces.example/get_object")
    assert object_exists(key) is True
    fake.fail_head = True
    assert object_exists(key) is False
    delete_object(key)


def test_local_storage_existing_object_and_legacy_command_guards(
    tmp_path, organization, monkeypatch
):
    key = "organizations/test/existing.png"
    default_storage.save(key, ContentFile(b"x"))
    monkeypatch.delenv("VC_SPACES_KEY", raising=False)
    assert object_exists(key) is True
    delete_object(key)
    assert object_exists(key) is False
    assert as_json({"x": 1}) == {"x": 1}
    assert as_json("not-json", {"fallback": True}) == {"fallback": True}
    assert aware_datetime(None) is None
    assert aware_datetime("not-a-date") is None
    missing = tmp_path / "missing.sqlite3"
    with pytest.raises(CommandError):
        call_command("import_legacy_sqlite", missing)
    source = tmp_path / "legacy.sqlite3"
    create_legacy_database(source)
    with pytest.raises(CommandError, match="Unknown SQLite schema fingerprint"):
        call_command("import_legacy_sqlite", source, dry_run=True)
    call_command(
        "import_legacy_sqlite",
        source,
        dry_run=True,
        allow_unknown_schema=True,
    )
    with pytest.raises(CommandError, match="Target database is not empty"):
        call_command(
            "import_legacy_sqlite",
            source,
            allow_unknown_schema=True,
        )
