from copy import deepcopy
from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from urllib.parse import parse_qs, urlparse

import pytest
from django.core.cache import cache
from django.db import close_old_connections, connection
from django.utils import timezone
from rest_framework.test import APIClient

from audit.models import AuditEvent
from measurements.models import Agency, AgencyLink, MeasurementPlan, MeasurementSubmission
from operations.models import VesselCall
from organizations.models import Organization
from .conftest import authenticated
from .test_measurements import create_plan, propose, acknowledge, finalize, add_evidence

pytestmark = pytest.mark.django_db


@pytest.fixture
def call(organization, operations):
    return VesselCall.objects.create(
        organization=organization,
        vessel_name="MV Grain",
        reference="MEAS-001",
        created_by=operations,
    )


@pytest.fixture
def plan_payload(call):
    return {
        "callId": call.pk,
        "title": "Discharge reconciliation",
        "scheduledAt": timezone.now().isoformat(),
        "endsAt": None,
        "location": "Apapa",
        "method": "Draft survey",
        "stage": "After discharge",
        "scope": "Wheat parcel A",
        "leadSurveyor": "Surveyor A",
        "notes": "",
        "participants": [
            {
                "name": "Agent",
                "role": "agent",
                "representative": "A One",
                "requiredSubmission": True,
                "requiredApproval": True,
            }
        ],
        "lines": [
            {
                "description": "Wheat",
                "category": "Bulk",
                "direction": "import",
                "containerSize": "",
                "loadStatus": "",
                "unit": "tonnes",
                "basis": "Metric tonnes",
                "manifestQuantity": "19500",
                "baselineReference": "Manifest 100",
            }
        ],
    }


@pytest.fixture(autouse=True)
def portal_cache():
    cache.clear()


def make_link(user, plan, index=0):
    response = authenticated(user).post(
        f"/api/measurement-plans/{plan['id']}/participants/{plan['participants'][index]['id']}/agency-links",
        {"expiryDays": 7},
        format="json",
    )
    assert response.status_code == 201, response.content
    result = response.json()
    return result, parse_qs(urlparse(result["url"]).fragment)["token"][0]


def exchange(token, client=None):
    client = client or APIClient(enforce_csrf_checks=True)
    csrf = client.get("/api/agency-portal/csrf").json()["csrfToken"]
    response = client.post(
        "/api/agency-portal/exchange", {"token": token}, format="json", HTTP_X_CSRFTOKEN=csrf
    )
    assert response.status_code == 200, response.content
    return client, response.json()["contextId"], csrf


def context(client, cid):
    response = client.get("/api/agency-portal/context", {"contextId": cid})
    assert response.status_code == 200, response.content
    return response.json()["context"]


def payload_for(ctx):
    return {
        "contextId": ctx["contextId"],
        "requestId": "request-1",
        "inputFingerprint": ctx["inputFingerprint"],
        "representative": "Agency surveyor",
        "observedAt": timezone.now().isoformat(),
        "sourceReference": "Survey record",
        "notes": "",
        "lines": [
            {"lineId": line["id"], "status": "reported", "quantity": "19508", "note": ""}
            for line in ctx["lines"]
        ],
    }


def post_reading(client, csrf, payload):
    return client.post(
        "/api/agency-portal/submission", payload, format="json", HTTP_X_CSRFTOKEN=csrf
    )


def test_agency_directory_scoped_permissions_versions_and_snapshots(
    admin, operations, viewer, plan_payload
):
    body = {"name": "  Port   Agency ", "role": " Agent ", "representative": "Ada", "active": True}
    assert authenticated(operations).post("/api/agencies", body, format="json").status_code == 403
    response = authenticated(admin).post("/api/agencies", body, format="json")
    assert response.status_code == 201, response.content
    agency = response.json()["agency"]
    assert agency["name"] == "Port Agency"
    assert authenticated(viewer).get("/api/agencies").json()["agencies"] == [agency]
    assert (
        authenticated(admin)
        .post("/api/agencies", {**body, "name": "port agency"}, format="json")
        .status_code
        == 400
    )
    plan_payload["participants"][0]["agencyId"] = agency["id"]
    plan_payload["participants"][0]["name"] = "Spoofed agency"
    plan = create_plan(operations, plan_payload)
    assert plan["participants"][0]["name"] == "Port Agency"
    path = f"/api/agencies/{agency['id']}"
    assert (
        authenticated(admin)
        .patch(path, {**body, "version": 1, "active": False}, format="json")
        .status_code
        == 200
    )
    assert (
        authenticated(admin).patch(path, {**body, "version": 1}, format="json").status_code == 409
    )
    assert (
        authenticated(operations)
        .get(f"/api/measurement-plans/{plan['id']}")
        .json()["plan"]["participants"][0]["name"]
        == "Port Agency"
    )
    assert (
        authenticated(operations)
        .post("/api/measurement-plans", plan_payload, format="json")
        .status_code
        == 400
    )
    other = Organization.objects.create(name="Other")
    Agency.objects.filter(pk=agency["id"]).update(organization=other)
    assert authenticated(viewer).get("/api/agencies").json()["agencies"] == []
    assert (
        authenticated(admin).patch(path, {**body, "version": 2}, format="json").status_code == 404
    )


def test_full_independent_guest_journey_and_private_receipt(operations, plan_payload):
    plan_payload["participants"].append({**plan_payload["participants"][0], "name": "Terminal"})
    plan = create_plan(operations, plan_payload)
    link_a, token_a = make_link(operations, plan)
    _, token_b = make_link(operations, plan, 1)
    assert token_a not in AgencyLink.objects.get(pk=link_a["link"]["id"]).__dict__.values()
    a, ca, csrf_a = exchange(token_a)
    b, cb, csrf_b = exchange(token_b)
    ctx = context(a, ca)
    assert ctx["completedPeers"] == [] and ctx["ownReport"] is None
    assert "manifestQuantity" not in ctx["lines"][0]
    assert "baselineReference" not in ctx["lines"][0]
    payload = payload_for(ctx)
    response = post_reading(a, csrf_a, payload)
    assert response.status_code == 201, response.content
    assert MeasurementSubmission.objects.count() == 1
    record = MeasurementSubmission.objects.get()
    assert record.recorded_by is None and record.source == "agency-link"
    assert record.representative == "Agency surveyor"
    assert response.json()["context"]["ownReport"]["participantId"] == plan["participants"][0]["id"]
    assert context(b, cb)["completedPeers"] == []
    payload_b = payload_for(context(b, cb))
    assert post_reading(b, csrf_b, payload_b).status_code == 201
    peers = context(a, ca)["completedPeers"]
    assert len(peers) == 1 and "representative" not in peers[0] and "notes" not in peers[0]
    assert post_reading(a, csrf_a, payload).status_code == 200
    assert post_reading(a, csrf_a, {**payload, "notes": "altered"}).status_code == 409
    assert MeasurementSubmission.objects.count() == 2
    response = a.get("/api/agency-portal/receipt", {"contextId": ca}, HTTP_ACCEPT="application/pdf")
    assert response.status_code == 200 and response.content.startswith(b"%PDF")
    assert response["Cache-Control"] == "private, no-store"
    assert a.get("/api/agency-portal/context", {"contextId": cb}).status_code == 404
    assert a.get("/api/measurement-plans").status_code == 403
    assert not AuditEvent.objects.filter(after__icontains=token_a).exists()
    staff = authenticated(operations).get(f"/api/measurement-plans/{plan['id']}").json()["plan"]
    assert len(staff["submissions"]) == 2
    receipt = authenticated(operations).get(
        f"/api/measurement-plans/{plan['id']}/submissions/{record.pk}/receipt"
    )
    assert receipt.status_code == 200
    comparison = authenticated(operations).get(f"/api/voyages/{plan['callId']}/readings")
    assert comparison.json()["sheets"][0]["lines"][0]["manifestQuantity"] == "19500.000"
    comparison_pdf = authenticated(operations).get(
        f"/api/voyages/{plan['callId']}/readings/document", HTTP_ACCEPT="application/pdf"
    )
    assert comparison_pdf.status_code == 200 and comparison_pdf.content.startswith(b"%PDF")


@pytest.mark.parametrize("mode", ["expired", "revoked", "replaced", "suspended"])
def test_invalidated_links_also_stop_existing_sessions(operations, plan_payload, mode):
    plan = create_plan(operations, plan_payload)
    link, token = make_link(operations, plan)
    client, cid, csrf = exchange(token)
    if mode == "expired":
        AgencyLink.objects.filter(pk=link["link"]["id"]).update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
    elif mode == "revoked":
        response = authenticated(operations).post(
            f"/api/measurement-plans/{plan['id']}/agency-links/{link['link']['id']}/revoke",
            {},
            format="json",
        )
        assert response.status_code == 200
    elif mode == "replaced":
        make_link(operations, plan)
    else:
        Organization.objects.filter(pk=operations.organization_id).update(
            access_status="suspended",
            suspended_at=timezone.now(),
            suspension_reason="Test suspension",
        )
    assert client.get("/api/agency-portal/context", {"contextId": cid}).status_code == 404
    assert (
        client.post(
            "/api/agency-portal/exchange", {"token": token}, format="json", HTTP_X_CSRFTOKEN=csrf
        ).status_code
        == 404
    )


def test_guest_csrf_cross_context_and_identity_tampering(operations, plan_payload):
    plan = create_plan(operations, plan_payload)
    _, token = make_link(operations, plan)
    unprotected = APIClient(enforce_csrf_checks=True)
    assert (
        unprotected.post("/api/agency-portal/exchange", {"token": token}, format="json").status_code
        == 403
    )
    client, cid, csrf = exchange(token)
    payload = payload_for(context(client, cid))
    assert client.post("/api/agency-portal/submission", payload, format="json").status_code == 403
    assert post_reading(client, csrf, {**payload, "participantId": "other"}).status_code == 400
    assert post_reading(client, csrf, {**payload, "lines": []}).status_code == 400
    assert post_reading(client, csrf, {**payload, "inputFingerprint": "0" * 64}).status_code == 409
    outsider = APIClient()
    assert outsider.get("/api/agency-portal/context", {"contextId": cid}).status_code == 404
    assert (
        client.get(
            "/api/agency-portal/receipt", {"contextId": cid}, HTTP_ACCEPT="application/pdf"
        ).status_code
        == 409
    )
    assert MeasurementSubmission.objects.count() == 0


def test_optional_evidence_still_allows_independent_final_reconciliation(
    operations, admin, plan_payload
):
    plan = create_plan(operations, plan_payload)
    response = authenticated(operations).post(
        f"/api/measurement-plans/{plan['id']}/submissions",
        {
            "version": plan["version"],
            "participantId": plan["participants"][0]["id"],
            "observedAt": timezone.now().isoformat(),
            "sourceReference": "Observation",
            "lines": [
                {"lineId": plan["lines"][0]["id"], "status": "reported", "quantity": "19508"}
            ],
        },
        format="json",
    )
    assert response.status_code == 201, response.content
    plan = response.json()["plan"]
    plan = propose(operations, plan)
    evidence = add_evidence(plan, operations)
    plan = acknowledge(operations, plan, evidence)
    plan = finalize(admin, plan)
    assert plan["reconciliations"][-1]["status"] == "final"


def test_plan_structure_lock_and_link_context_staleness(operations, plan_payload):
    plan = create_plan(operations, plan_payload)
    _, token = make_link(operations, plan)
    client, cid, csrf = exchange(token)
    payload = payload_for(context(client, cid))
    response = authenticated(operations).patch(
        f"/api/measurement-plans/{plan['id']}",
        {"version": plan["version"], "participants": plan_payload["participants"]},
        format="json",
    )
    assert response.status_code == 409
    MeasurementPlan.objects.filter(pk=plan["id"]).update(title="Changed scope")
    assert post_reading(client, csrf, payload).status_code == 409


@pytest.mark.parametrize(
    "field,value", [("quantity", "-1"), ("quantity", None), ("lineId", "other")]
)
def test_invalid_guest_readings_leave_no_partial_submission(operations, plan_payload, field, value):
    plan = create_plan(operations, plan_payload)
    _, token = make_link(operations, plan)
    client, cid, csrf = exchange(token)
    payload = payload_for(context(client, cid))
    payload["lines"][0][field] = value
    assert post_reading(client, csrf, payload).status_code == 400
    assert MeasurementSubmission.objects.count() == 0
    assert AgencyLink.objects.get().submission_id is None


def test_zero_and_not_applicable_are_different(operations, plan_payload):
    plan_payload["lines"].append({**plan_payload["lines"][0], "description": "Other cargo"})
    plan = create_plan(operations, plan_payload)
    _, token = make_link(operations, plan)
    client, cid, csrf = exchange(token)
    payload = payload_for(context(client, cid))
    payload["lines"][0]["quantity"] = "0"
    payload["lines"][1].update(
        status="not-applicable", quantity=None, note="No cargo in this category"
    )
    response = post_reading(client, csrf, payload)
    assert response.status_code == 201
    lines = response.json()["context"]["ownReport"]["lines"]
    assert lines[0]["quantity"] == "0.000" and lines[1]["quantity"] is None


@pytest.mark.django_db(transaction=True)
def test_concurrent_guest_retries_only_record_one_submission(operations, plan_payload):
    assert connection.vendor == "postgresql"
    plan = create_plan(operations, plan_payload)
    _, token = make_link(operations, plan)
    client, cid, csrf = exchange(token)
    payload = payload_for(context(client, cid))
    cookies = deepcopy(client.cookies)
    barrier = Barrier(2)

    def send():
        close_old_connections()
        try:
            other = APIClient(enforce_csrf_checks=True)
            other.cookies = deepcopy(cookies)
            barrier.wait(timeout=10)
            return post_reading(other, csrf, payload).status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: send(), range(2)))
    assert sorted(results) == [200, 201]
    assert MeasurementSubmission.objects.count() == 1


def test_activity_is_tenant_scoped_and_only_counts_latest_agency_reading(
    operations, viewer, plan_payload
):
    plan = create_plan(operations, plan_payload)
    response = authenticated(viewer).get("/api/measurement-activity")
    assert response.status_code == 200
    assert response.json()["summary"]["awaitingReadings"] == 1
    _, token = make_link(operations, plan)
    client, cid, csrf = exchange(token)
    assert post_reading(client, csrf, payload_for(context(client, cid))).status_code == 201
    report = authenticated(viewer).get("/api/measurement-activity").json()
    assert report["summary"]["awaitingReadings"] == 0
    assert report["events"][0]["actor"] == "Agency submission"
    assert "before" not in report["events"][0] and "after" not in report["events"][0]


def test_link_permissions_counts_bad_expiry_and_cross_tenant_denial(
    operations, viewer, admin, plan_payload
):
    plan = create_plan(operations, plan_payload)
    path = f"/api/measurement-plans/{plan['id']}/participants/{plan['participants'][0]['id']}/agency-links"
    assert authenticated(viewer).post(path, {}, format="json").status_code == 403
    assert (
        authenticated(operations).post(path, {"expiryDays": 31}, format="json").status_code == 400
    )
    assert (
        authenticated(operations)
        .post(path.replace(plan["participants"][0]["id"], "missing"), {}, format="json")
        .status_code
        == 400
    )
    link, _ = make_link(operations, plan)
    assert (
        len(
            authenticated(operations)
            .get(f"/api/measurement-plans/{plan['id']}/agency-links")
            .json()["links"]
        )
        == 1
    )
    other = Organization.objects.create(name="Other")
    MeasurementPlan.objects.filter(pk=plan["id"]).update(organization=other)
    assert (
        authenticated(admin).get(f"/api/measurement-plans/{plan['id']}/agency-links").status_code
        == 404
    )
    assert (
        authenticated(admin)
        .post(
            f"/api/measurement-plans/{plan['id']}/agency-links/{link['link']['id']}/revoke",
            {},
            format="json",
        )
        .status_code
        == 404
    )


def test_receipt_snapshot_preserves_voyage_context_after_later_edits(operations, plan_payload):
    plan = create_plan(operations, plan_payload)
    _, token = make_link(operations, plan)
    client, cid, csrf = exchange(token)
    assert post_reading(client, csrf, payload_for(context(client, cid))).status_code == 201
    submission = MeasurementSubmission.objects.get()
    before = deepcopy(submission.snapshot)
    MeasurementPlan.objects.filter(pk=plan["id"]).update(title="Changed later")
    submission.refresh_from_db()
    assert submission.snapshot == before
    response = client.get(
        "/api/agency-portal/receipt", {"contextId": cid}, HTTP_ACCEPT="application/pdf"
    )
    assert response.status_code == 200
