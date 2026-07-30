from __future__ import annotations

import hashlib
from urllib.parse import urlsplit

import pytest

from .conftest import authenticated

pytestmark = pytest.mark.django_db


def create_flow(client, reference="ROT-EXTENDED"):
    call = client.post(
        "/api/vessel-calls",
        {
            "vesselName": "MV Extended",
            "reference": reference,
            "type": "Bulk",
            "nrt": 1200,
            "eta": "2026-07-20T12:00:00Z",
        },
        format="json",
    ).json()["call"]
    inspection = client.post(
        "/api/inspections",
        {
            "callId": call["id"],
            "cargoType": "Dry",
            "reconciledTonnage": 1100,
        },
        format="json",
    ).json()["inspection"]
    finalized = client.post(
        f"/api/inspections/{inspection['id']}/finalize", {}, format="json"
    ).json()
    return call, inspection, finalized["invoice"]


def test_lists_status_state_analytics_org_settings_and_documents(admin):
    client = authenticated(admin)
    call, inspection, invoice = create_flow(client)
    assert client.get("/api/vessel-calls").json()["count"] == 1
    assert client.get(f"/api/vessel-calls/{call['id']}").status_code == 200
    assert client.get("/api/inspections").json()["count"] == 1
    assert client.get(f"/api/inspections/{inspection['id']}").status_code == 200
    state = client.get("/api/state").json()
    unchanged = client.get(f"/api/state?rev={state['rev']}")
    assert unchanged.json() == {"changed": False, "rev": state["rev"]}
    analytics = client.get("/api/analytics?months=12")
    assert analytics.status_code == 200
    assert analytics.json()["totals"]["invoiced"] > 0
    assert client.get("/api/organization").status_code == 200
    updated_org = client.put(
        "/api/organization",
        {"phone": "+234800000000", "ports": ["Port of Calabar", "Onne"]},
        format="json",
    )
    assert updated_org.status_code == 200
    assert updated_org.json()["org"]["phone"] == "+234800000000"
    assert client.get("/api/settings").status_code == 200
    settings = client.put(
        "/api/settings",
        {
            "commissionRate": "4.2500",
            "exchangeRate": "1700.0000",
            "dryDuesRate": "2.5000",
            "portName": "Calabar",
            "terminals": ["A", "B"],
        },
        format="json",
    )
    assert settings.status_code == 200
    assert settings.json()["settings"]["commissionRate"] == 4.25
    for path in (
        f"/api/vessel-calls/{call['id']}/document",
        f"/api/inspections/{inspection['id']}/document",
        f"/api/invoices/{invoice['id']}/document",
    ):
        response = client.get(path)
        assert response.status_code == 200
        assert response["Content-Type"] == "application/pdf"
        assert bytes(response.content).startswith(b"%PDF")


def test_private_evidence_local_signed_upload_download_and_delete(admin):
    client = authenticated(admin)
    _, inspection, _ = create_flow(client, "ROT-EVIDENCE")
    payload = b"\x89PNG\r\n\x1a\nproduction-evidence"
    checksum = f"sha256:{hashlib.sha256(payload).hexdigest()}"
    presigned = client.post(
        "/api/evidence/presign",
        {
            "inspectionId": inspection["id"],
            "fileName": "evidence.png",
            "contentType": "image/png",
            "size": len(payload),
            "checksum": checksum,
        },
        format="json",
    )
    assert presigned.status_code == 200
    upload_path = urlsplit(presigned.json()["uploadUrl"]).path
    uploaded = client.generic("PUT", upload_path, payload, content_type="image/png")
    assert uploaded.status_code == 204
    finalized = client.post(
        "/api/evidence",
        {
            "inspectionId": inspection["id"],
            "objectKey": presigned.json()["objectKey"],
            "fileName": "evidence.png",
            "contentType": "image/png",
            "size": len(payload),
            "checksum": checksum,
        },
        format="json",
    )
    assert finalized.status_code == 201, finalized.content
    evidence = finalized.json()["evidence"]
    listing = client.get(f"/api/inspections/{inspection['id']}/evidence")
    assert listing.json()["results"][0]["id"] == evidence["id"]
    metadata = client.get(f"/api/evidence/{evidence['id']}")
    assert metadata.status_code == 200
    download_path = urlsplit(metadata.json()["downloadUrl"]).path
    downloaded = client.get(download_path)
    assert downloaded.status_code == 200
    assert b"".join(downloaded.streaming_content) == payload
    assert client.delete(f"/api/evidence/{evidence['id']}").status_code == 204


def test_private_invoice_attachment_upload_download_and_delete(admin, finance, viewer):
    client = authenticated(admin)
    _, _, invoice = create_flow(client, "ROT-INVOICE-UPLOAD")
    payload = b"%PDF-1.4\nprivate invoice attachment"
    checksum = f"sha256:{hashlib.sha256(payload).hexdigest()}"
    request_data = {
        "invoiceId": invoice["id"],
        "fileName": "supporting-invoice.pdf",
        "contentType": "application/pdf",
        "size": len(payload),
        "checksum": checksum,
    }

    assert authenticated(viewer).post(
        "/api/invoice-attachments/presign", request_data, format="json"
    ).status_code == 403
    presigned = client.post("/api/invoice-attachments/presign", request_data, format="json")
    assert presigned.status_code == 200
    upload_path = urlsplit(presigned.json()["uploadUrl"]).path
    assert client.generic("PUT", upload_path, payload, content_type="application/pdf").status_code == 204

    finalized = client.post(
        "/api/invoice-attachments",
        {**request_data, "objectKey": presigned.json()["objectKey"]},
        format="json",
    )
    assert finalized.status_code == 201, finalized.content
    attachment = finalized.json()["attachment"]
    assert "objectKey" not in attachment
    assert not attachment["fileName"].startswith("data:")
    assert client.get(f"/api/invoices/{invoice['id']}/attachments").json()["results"] == [attachment]

    metadata = authenticated(viewer).get(f"/api/invoice-attachments/{attachment['id']}")
    assert metadata.status_code == 200
    download_path = urlsplit(metadata.json()["downloadUrl"]).path
    downloaded = authenticated(viewer).get(download_path)
    assert downloaded.status_code == 200
    assert b"".join(downloaded.streaming_content) == payload
    assert authenticated(viewer).delete(f"/api/invoice-attachments/{attachment['id']}").status_code == 404
    assert authenticated(finance).delete(f"/api/invoice-attachments/{attachment['id']}").status_code == 200


def test_invoice_attachment_rejects_bad_type_and_cross_invoice_key(admin):
    client = authenticated(admin)
    _, _, invoice = create_flow(client, "ROT-INVOICE-UPLOAD-INVALID")
    checksum = "sha256:" + "a" * 64
    assert client.post(
        "/api/invoice-attachments/presign",
        {
            "invoiceId": invoice["id"],
            "fileName": "malware.exe",
            "contentType": "application/octet-stream",
            "size": 1,
            "checksum": checksum,
        },
        format="json",
    ).status_code == 400


def test_invoice_attachment_finalize_rejects_a_mismatched_file_signature(admin):
    client = authenticated(admin)
    _, _, invoice = create_flow(client, "ROT-INVOICE-UPLOAD-MAGIC")
    payload = b"not a PDF"
    checksum = f"sha256:{hashlib.sha256(payload).hexdigest()}"
    request_data = {
        "invoiceId": invoice["id"],
        "fileName": "invoice.pdf",
        "contentType": "application/pdf",
        "size": len(payload),
        "checksum": checksum,
    }
    presigned = client.post("/api/invoice-attachments/presign", request_data, format="json")
    assert presigned.status_code == 200
    upload_path = urlsplit(presigned.json()["uploadUrl"]).path
    assert client.generic("PUT", upload_path, payload, content_type="application/pdf").status_code == 204
    assert client.post(
        "/api/invoice-attachments",
        {**request_data, "objectKey": presigned.json()["objectKey"]},
        format="json",
    ).status_code == 400
    assert client.post(
        "/api/invoice-attachments",
        {
            "invoiceId": invoice["id"],
            "objectKey": "organizations/other/invoices/iv-other/uploads/file.pdf",
            "fileName": "invoice.pdf",
            "contentType": "application/pdf",
            "size": 1,
            "checksum": checksum,
        },
        format="json",
    ).status_code == 400


def test_duplicate_rotation_missing_resources_and_status_transition(admin):
    client = authenticated(admin)
    call = client.post(
        "/api/vessel-calls",
        {"vesselName": "Status Ship", "reference": "ROT-STATUS", "nrt": 50},
        format="json",
    ).json()["call"]
    duplicate = client.post(
        "/api/vessel-calls",
        {"vesselName": "Duplicate", "reference": "ROT-STATUS", "nrt": 1},
        format="json",
    )
    assert duplicate.status_code == 409
    status_update = client.post(
        f"/api/vessel-calls/{call['id']}/status",
        {
            "status": "in-progress",
            "berth": "Berth 2",
            "version": call["version"],
        },
        format="json",
    )
    assert status_update.status_code == 200
    assert status_update.json()["call"]["status"] == "in-progress"
    assert client.get("/api/vessel-calls/missing").status_code == 404
    assert client.get("/api/inspections/missing").status_code == 404
