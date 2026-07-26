from __future__ import annotations

from datetime import timedelta
from urllib.parse import urlsplit

import pyotp
import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import MFAChallenge
from billing.models import Invoice

from .conftest import authenticated
from .test_operations_extended import create_flow

pytestmark = pytest.mark.django_db


def test_authentication_validation_and_security_error_paths(admin, viewer):
    cache.clear()
    public = APIClient()
    duplicate = public.post(
        "/api/auth/register",
        {
            "name": "Duplicate",
            "email": admin.email,
            "password": "A-valid-duplicate-password-2026!",
            "orgName": "Duplicate",
        },
        format="json",
    )
    assert duplicate.status_code == 202
    for _ in range(8):
        assert (
            public.post(
                "/api/auth/login",
                {"email": admin.email, "password": "wrong"},
                format="json",
            ).status_code
            == 401
        )
    assert (
        public.post(
            "/api/auth/login",
            {"email": admin.email, "password": "wrong"},
            format="json",
        ).status_code
        == 401
    )
    cache.clear()
    assert (
        public.post(
            "/api/auth/login",
            {"email": admin.email, "password": "A-strong-admin-password-2026!"},
            format="json",
        ).status_code
        == 200
    )
    assert (
        public.post(
            "/api/auth/change-password",
            {"currentPassword": "wrong", "password": "A-valid-new-password-2026!"},
            format="json",
        ).status_code
        == 400
    )
    assert public.put("/api/profile", {"email": viewer.email}, format="json").status_code == 400
    assert public.delete("/api/auth/sessions/missing").status_code == 404
    assert public.post("/api/auth/mfa/setup", {}, format="json").status_code == 400
    setup = public.post(
        "/api/auth/mfa/setup",
        {"currentPassword": "A-strong-admin-password-2026!"},
        format="json",
    ).json()
    assert (
        public.post("/api/auth/mfa/confirm", {"code": "000000"}, format="json").status_code == 400
    )
    code = pyotp.TOTP(setup["secret"]).now()
    assert public.post("/api/auth/mfa/confirm", {"code": code}, format="json").status_code == 200
    assert (
        public.post("/api/auth/mfa/recovery-codes", {"code": "000000"}, format="json").status_code
        == 400
    )
    assert (
        public.delete(
            "/api/auth/mfa", {"password": "wrong", "code": "000000"}, format="json"
        ).status_code
        == 400
    )
    public.post("/api/auth/logout")
    assert (
        public.post(
            "/api/auth/mfa/verify",
            {"challengeId": "missing", "code": "000000"},
            format="json",
        ).status_code
        == 401
    )
    expired = MFAChallenge.objects.create(
        user=admin, expires_at=timezone.now() - timedelta(seconds=1)
    )
    assert (
        public.post(
            "/api/auth/mfa/verify",
            {"challengeId": expired.id, "code": "000000"},
            format="json",
        ).status_code
        == 401
    )


def test_user_and_invitation_not_found_conflict_paths(admin, viewer):
    client = authenticated(admin)
    assert client.patch("/api/users/missing", {"role": "Viewer"}, format="json").status_code == 404
    assert client.delete("/api/users/missing").status_code == 404
    assert client.post("/api/users/missing/send-password-reset").status_code == 404
    assert client.post("/api/users/missing/reset-mfa").status_code == 404
    assert client.post(f"/api/users/{admin.id}/reset-mfa").status_code == 400
    duplicate = client.post(
        "/api/invitations",
        {"name": "Existing", "email": viewer.email, "role": "Viewer"},
        format="json",
    )
    assert duplicate.status_code == 400
    assert client.post("/api/invitations/missing/resend").status_code == 404
    assert client.delete("/api/invitations/missing").status_code == 404
    public = APIClient()
    assert (
        public.post(
            "/api/invitations/accept",
            {"token": "missing", "password": "A-valid-invite-password-2026!"},
            format="json",
        ).status_code
        == 400
    )
    assert client.get("/api/audit?action=none&actor=missing").status_code == 200


def test_operational_conflicts_missing_and_idempotency(admin):
    client = authenticated(admin)
    assert (
        client.post("/api/vessel-calls", {"reference": "NO-NAME"}, format="json").status_code == 400
    )
    assert client.post("/api/inspections", {"callId": "missing"}, format="json").status_code == 404
    assert client.post("/api/inspections", {"cargoType": "Dry"}, format="json").status_code == 400
    call = client.post(
        "/api/vessel-calls",
        {"vesselName": "Cancelled", "reference": "ROT-CANCELLED", "nrt": 10},
        format="json",
    ).json()["call"]
    cancelled = client.post(
        f"/api/vessel-calls/{call['id']}/cancel",
        {"reason": "Cancelled in test", "version": call["version"]},
        format="json",
    )
    assert cancelled.status_code == 200
    assert (
        client.post(
            f"/api/vessel-calls/{call['id']}/cancel",
            {"reason": "Again"},
            format="json",
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/vessel-calls/{call['id']}", {"notes": "nope"}, format="json"
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/inspections",
            {"callId": call["id"], "cargoType": "Dry"},
            format="json",
        ).status_code
        == 409
    )
    active = client.post(
        "/api/vessel-calls",
        {"vesselName": "Idempotent", "reference": "ROT-IDEMPOTENT", "nrt": 10},
        format="json",
    ).json()["call"]
    body = {"callId": active["id"], "cargoType": "Dry"}
    first = client.post(
        "/api/inspections",
        body,
        format="json",
        HTTP_IDEMPOTENCY_KEY="same-inspection",
    )
    second = client.post(
        "/api/inspections",
        body,
        format="json",
        HTTP_IDEMPOTENCY_KEY="same-inspection",
    )
    assert second.json()["inspection"]["id"] == first.json()["inspection"]["id"]
    finalized = client.post(
        f"/api/inspections/{first.json()['inspection']['id']}/finalize",
        {},
        format="json",
    )
    assert (
        client.patch(
            f"/api/inspections/{first.json()['inspection']['id']}",
            {"reconciledTonnage": 5},
            format="json",
        ).status_code
        == 409
    )
    invoice = finalized.json()["invoice"]
    payment_body = {
        "paidOn": "2026-07-20",
        "method": "Transfer",
        "reference": "IDEMPOTENT-PAY",
    }
    first_payment = client.post(
        f"/api/invoices/{invoice['id']}/payments",
        payment_body,
        format="json",
        HTTP_IDEMPOTENCY_KEY="same-payment",
    )
    repeated = client.post(
        f"/api/invoices/{invoice['id']}/payments",
        payment_body,
        format="json",
        HTTP_IDEMPOTENCY_KEY="same-payment",
    )
    assert repeated.json()["payment"]["id"] == first_payment.json()["payment"]["id"]
    reverse_path = f"/api/payments/{first_payment.json()['payment']['id']}/reverse"
    assert client.post(reverse_path, {"reason": "Return"}, format="json").status_code == 200
    assert client.post(reverse_path, {"reason": "Return again"}, format="json").status_code == 200
    assert (
        client.post(
            "/api/payments/missing/reverse", {"reason": "Missing"}, format="json"
        ).status_code
        == 404
    )
    assert (
        client.post(
            "/api/invoices/missing/payments",
            payment_body,
            format="json",
        ).status_code
        == 404
    )


def test_evidence_and_document_error_paths(admin, viewer, monkeypatch):
    client = authenticated(admin)
    _, inspection, invoice = create_flow(client, "ROT-EVIDENCE-ERROR")
    assert (
        client.post(
            "/api/evidence",
            {
                "inspectionId": inspection["id"],
                "objectKey": "outside/object",
                "fileName": "x.png",
                "contentType": "image/png",
                "size": 1,
                "checksum": "sha256:" + ("0" * 64),
            },
            format="json",
        ).status_code
        == 400
    )
    assert client.get("/api/evidence/missing").status_code == 404
    assert client.get("/api/inspections/missing/evidence").status_code == 404
    assert client.get("/api/invoices/missing/document").status_code == 404
    bad_upload = client.generic(
        "PUT", "/api/evidence/upload/not-a-token", b"x", content_type="image/png"
    )
    assert bad_upload.status_code == 400
    assert bad_upload.json()["errors"] == ["Upload is invalid or expired"]
    assert "Signature" not in str(bad_upload.json())

    def fail_upload(*_args):
        raise ValueError("sensitive internal storage detail")

    monkeypatch.setattr("api.operation_views.local_upload", fail_upload)
    failed_upload = client.generic(
        "PUT", "/api/evidence/upload/valid-looking-token", b"x", content_type="image/png"
    )
    assert failed_upload.status_code == 400
    assert failed_upload.json()["errors"] == ["Upload is invalid or expired"]
    assert "sensitive internal storage detail" not in str(failed_upload.json())
    assert client.get("/api/evidence/download/not-a-token").status_code == 404
    presigned = client.post(
        "/api/evidence/presign",
        {
            "inspectionId": inspection["id"],
            "fileName": "x.png",
            "contentType": "image/png",
            "size": 1,
            "checksum": "sha256:" + ("0" * 64),
        },
        format="json",
    ).json()
    upload_path = urlsplit(presigned["uploadUrl"]).path
    assert client.generic("PUT", upload_path, b"x", content_type="image/jpeg").status_code == 400
    assert client.generic("PUT", upload_path, b"xx", content_type="image/png").status_code == 400
    assert client.generic("PUT", upload_path, b"x", content_type="image/png").status_code == 400
    viewer_client = authenticated(viewer)
    assert viewer_client.delete("/api/evidence/missing").status_code == 404


def test_local_evidence_upload_preserves_internal_exception_chain(monkeypatch):
    from types import SimpleNamespace

    from rest_framework.exceptions import ValidationError

    from api.operation_views import LocalEvidenceUploadView

    internal_error = ValueError("sensitive internal storage detail")

    def fail_upload(*_args):
        raise internal_error

    monkeypatch.setattr("api.operation_views.local_upload", fail_upload)
    request = SimpleNamespace(body=b"x", content_type="image/png")
    with pytest.raises(ValidationError, match="Upload is invalid or expired") as caught:
        LocalEvidenceUploadView().put(request, "valid-looking-token")

    assert caught.value.__cause__ is internal_error


def test_void_invoice_rejects_payment(admin):
    client = authenticated(admin)
    _, _, invoice_data = create_flow(client, "ROT-VOID")
    invoice = Invoice.objects.get(pk=invoice_data["id"])
    invoice.status = Invoice.Status.VOID
    invoice.save(update_fields=("status",))
    response = client.post(
        f"/api/invoices/{invoice.id}/payments",
        {
            "paidOn": "2026-07-20",
            "method": "Transfer",
            "reference": "VOID-PAY",
        },
        format="json",
    )
    assert response.status_code == 409
