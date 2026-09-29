from __future__ import annotations

import hashlib

import pytest
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.utils import timezone

from measurements.documents import reconciliation_pdf
from measurements.models import MeasurementEvidence, MeasurementPlan
from operations.models import VesselCall

from .conftest import authenticated

pytestmark = pytest.mark.django_db


@pytest.fixture
def plan(organization, operations):
    call = VesselCall.objects.create(
        organization=organization, vessel_name="Evidence Test", reference="EVIDENCE-1"
    )
    return MeasurementPlan.objects.create(
        organization=organization,
        vessel_call=call,
        title="Cargo evidence",
        scheduled_at=timezone.now(),
        method="Draft survey",
        stage="Discharge",
        scope="Wheat parcel",
        lead_surveyor="Surveyor",
        created_by=operations,
    )


def upload(client, plan, content=b"%PDF-1.4\n%%EOF", content_type="application/pdf"):
    data = {
        "fileName": "signed-return.pdf",
        "contentType": content_type,
        "size": len(content),
        "checksum": "sha256:" + hashlib.sha256(content).hexdigest(),
    }
    result = client.post(f"/api/measurement-plans/{plan.id}/evidence/presign", data, format="json")
    assert result.status_code == 200, result.content
    data["objectKey"] = result.json()["objectKey"]
    default_storage.save(data["objectKey"], ContentFile(content))
    return data, client.post(f"/api/measurement-plans/{plan.id}/evidence", data, format="json")


def test_pdf_upload_is_private_immutable_and_retry_safe(
    plan, operations, viewer, django_capture_on_commit_callbacks
):
    client = authenticated(operations)
    with django_capture_on_commit_callbacks(execute=True):
        data, result = upload(client, plan)
    assert result.status_code == 201, result.content
    evidence = MeasurementEvidence.objects.get(pk=result.json()["evidence"]["id"])
    assert "/evidence/" in evidence.object_key
    assert not default_storage.exists(data["objectKey"])
    retried = client.post(f"/api/measurement-plans/{plan.id}/evidence", data, format="json")
    assert retried.status_code == 200
    assert retried.json()["evidence"]["id"] == evidence.id
    assert plan.evidence.count() == 1
    url = f"/api/measurement-plans/{plan.id}/evidence/{evidence.id}"
    assert authenticated(viewer).get(url).status_code == 200
    assert client.delete(url).status_code == 405
    with pytest.raises(TypeError, match="immutable"):
        evidence.delete()


def test_reject_wrong_file_signature_checksum_scope_and_viewer_upload(plan, operations, viewer):
    client = authenticated(operations)
    data, response = upload(client, plan, b"<html>This is not a PDF</html>")
    assert response.status_code == 400
    assert plan.evidence.count() == 0
    assert (
        authenticated(viewer)
        .post(f"/api/measurement-plans/{plan.id}/evidence/presign", data, format="json")
        .status_code
        == 403
    )
    data["objectKey"] = "organizations/other/measurements/another/uploads/document.pdf"
    assert (
        client.post(f"/api/measurement-plans/{plan.id}/evidence", data, format="json").status_code
        == 400
    )
    data["objectKey"] = (
        f"organizations/{plan.organization_id}/measurements/{plan.id}/uploads/corrupt.pdf"
    )
    default_storage.save(data["objectKey"], ContentFile(b"%PDF-CORRUPTED"))
    assert (
        client.post(f"/api/measurement-plans/{plan.id}/evidence", data, format="json").status_code
        == 400
    )


def test_evidence_other_tenant_is_not_visible(plan, operations):
    from accounts.models import User
    from organizations.models import Organization

    other = Organization.objects.create(name="Other tenant", email="other@example.test")
    user = User.objects.create_user(
        email="other@example.test",
        organization=other,
        name="Other",
        role="Operations",
        status="active",
        email_verified_at=timezone.now(),
    )
    client = authenticated(user)
    assert (
        client.post(
            f"/api/measurement-plans/{plan.id}/evidence/presign", {}, format="json"
        ).status_code
        == 404
    )
    assert client.get(f"/api/measurement-plans/{plan.id}/evidence/unknown").status_code == 404


def test_pdf_uses_frozen_context_and_escapes_untrusted_text(monkeypatch):
    from types import SimpleNamespace

    record = {
        "id": "recon-test",
        "revision": 1,
        "status": "final",
        "reason": "Signed <agreement> & decisions",
        "lines": [
            {
                "lineId": "line-1",
                "quantity": "19508.000",
                "variance": "8.000",
                "reason": "Agreed survey",
            }
        ],
        "approvals": [],
        "finalizedAt": "2026-09-29T10:00:00Z",
        "finalizedBy": "reviewer",
    }
    reconciliation = SimpleNamespace(
        snapshot={
            "plan": {
                "vesselName": "Frozen Vessel",
                "callReference": "ROT-1",
                "title": "Wheat",
                "scope": "Parcel A",
            },
            "participants": [{"id": "party-1", "name": "Agent", "role": "Agent"}],
            "lines": [
                {
                    "id": "line-1",
                    "description": "Bulk wheat",
                    "direction": "Import",
                    "unit": "tonnes",
                    "manifestQuantity": "19500.000",
                }
            ],
            "submissions": [
                {
                    "participantId": "party-1",
                    "lines": [{"lineId": "line-1", "status": "reported", "quantity": "19500.000"}],
                }
            ],
            "evidence": [{"fileName": "signed.pdf", "checksum": "sha256:" + "a" * 64}],
        }
    )
    monkeypatch.setattr("measurements.documents.reconciliation_data", lambda _: record)
    monkeypatch.setattr("reportlab.rl_config.pageCompression", 0)
    payload = reconciliation_pdf(reconciliation)
    assert payload.startswith(b"%PDF-")
    text = payload.decode("latin1")
    assert "Frozen Vessel" in text
    assert "19508.000" in text and "19500.000" in text
    assert "agreement" in text and "decisions" in text
    assert "NPA-issued document" in text


def test_pdf_wraps_long_scope_across_pages(monkeypatch):
    from types import SimpleNamespace

    record = {"id": "long-record", "revision": 1, "status": "draft", "lines": [], "approvals": []}
    monkeypatch.setattr("measurements.documents.reconciliation_data", lambda _: record)
    payload = reconciliation_pdf(
        SimpleNamespace(snapshot={"plan": {"scope": "Cargo details " * 380}})
    )
    assert payload.startswith(b"%PDF-")


def test_database_failure_preserves_upload_for_retry(
    plan, operations, monkeypatch, django_capture_on_commit_callbacks
):
    client = authenticated(operations)
    content = b"%PDF-1.4\n%%EOF"
    data = {
        "fileName": "recoverable.pdf",
        "contentType": "application/pdf",
        "size": len(content),
        "checksum": "sha256:" + hashlib.sha256(content).hexdigest(),
    }
    presigned = client.post(
        f"/api/measurement-plans/{plan.id}/evidence/presign", data, format="json"
    )
    assert presigned.status_code == 200
    source = presigned.json()["objectKey"]
    data["objectKey"] = source
    default_storage.save(source, ContentFile(content))
    manager = MeasurementEvidence.objects
    real_create = manager.create

    def fail_create(**kwargs):
        raise RuntimeError("Simulated database failure")

    monkeypatch.setattr(manager, "create", fail_create)
    with pytest.raises(RuntimeError, match="Simulated database failure"):
        client.post(f"/api/measurement-plans/{plan.id}/evidence", data, format="json")
    assert default_storage.exists(source)
    assert not plan.evidence.exists()
    monkeypatch.setattr(manager, "create", real_create)
    with django_capture_on_commit_callbacks(execute=True):
        retried = client.post(f"/api/measurement-plans/{plan.id}/evidence", data, format="json")
    assert retried.status_code == 201, retried.content
    evidence = plan.evidence.get()
    assert default_storage.exists(evidence.object_key)
    assert not default_storage.exists(source)


def test_temporary_cleanup_failure_does_not_lose_committed_evidence(
    plan, operations, monkeypatch, django_capture_on_commit_callbacks, caplog
):
    def fail_cleanup(key):
        raise OSError("Simulated temporary object cleanup failure")

    monkeypatch.setattr("measurements.evidence.delete_object", fail_cleanup)
    with django_capture_on_commit_callbacks(execute=True):
        data, response = upload(authenticated(operations), plan)
    assert response.status_code == 201
    evidence = plan.evidence.get()
    assert default_storage.exists(evidence.object_key)
    assert default_storage.exists(data["objectKey"])
    assert "Temporary measurement upload cleanup failed" in caplog.text
