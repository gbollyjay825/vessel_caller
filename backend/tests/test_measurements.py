from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from decimal import Decimal
from threading import Barrier

import pytest
from django.db import close_old_connections, connection
from django.utils import timezone

from accounts.models import User
from billing.models import Invoice
from measurements.models import (
    MeasurementEvidence,
    MeasurementPlan,
    MeasurementSubmission,
    Reconciliation,
)
from operations.models import VesselCall
from organizations.models import Organization

from .conftest import authenticated

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


def create_plan(operations, payload):
    response = authenticated(operations).post("/api/measurement-plans", payload, format="json")
    assert response.status_code == 201, response.content
    return response.json()["plan"]


def add_evidence(plan, operations):
    item = MeasurementEvidence.objects.create(
        plan_id=plan["id"],
        file_name="signed.pdf",
        object_key=f"evidence/{plan['id']}/{timezone.now().timestamp()}.pdf",
        content_type="application/pdf",
        size=20,
        checksum="a" * 64,
        uploaded_by=operations,
    )
    return item.pk


def post_action(user, plan, action, payload, expected=201):
    response = authenticated(user).post(
        f"/api/measurement-plans/{plan['id']}/{action}",
        {"version": plan["version"], **payload},
        format="json",
    )
    assert response.status_code == expected, response.content
    return response.json()["plan"] if expected < 300 else response


def submit(user, plan, evidence, quantity="19508", reason="", participant=None, expected=201):
    return post_action(
        user,
        plan,
        "submissions",
        {
            "participantId": participant or plan["participants"][0]["id"],
            "observedAt": timezone.now().isoformat(),
            "sourceReference": "Return 001",
            "notes": "",
            "reason": reason,
            "lines": [
                {"lineId": line["id"], "status": "reported", "quantity": quantity, "note": ""}
                for line in plan["lines"]
            ],
            "evidenceIds": [evidence],
        },
        expected,
    )


def propose(user, plan, quantity="19508", expected=201):
    return post_action(
        user,
        plan,
        "reconciliations",
        {
            "reason": "All parties reviewed the draft survey",
            "lines": [
                {"lineId": line["id"], "quantity": quantity, "reason": "Verified cargo tally"}
                for line in plan["lines"]
            ],
            "evidenceIds": [],
        },
        expected,
    )


def acknowledge(user, plan, evidence, decision="agreed", expected=201):
    rid = plan["reconciliations"][-1]["id"]
    return post_action(
        user,
        plan,
        f"reconciliations/{rid}/approvals",
        {
            "participantId": plan["participants"][0]["id"],
            "decision": decision,
            "representative": "A One",
            "reference": "Signed sheet 01",
            "evidenceIds": [evidence],
        },
        expected,
    )


def finalize(user, plan, expected=200):
    return post_action(
        user, plan, f"reconciliations/{plan['reconciliations'][-1]['id']}/finalize", {}, expected
    )


def assessment_payload(plan, **overrides):
    result = {
        "reconciliationId": plan["reconciliations"][-1]["id"],
        "payer": "Shipping Agent",
        "currency": "USD",
        "policy": "manifest-disparity",
        "tariffReference": "Approved tariff 2026",
        "reason": "Agreed additional cargo",
        "openingChargesReference": "No prior cargo charges",
        "lines": [
            {
                "lineId": line["id"],
                "rate": "2.17",
                "tolerance": "0",
                "toleranceMode": "threshold",
                "previouslyBilledQuantity": None,
                "openingBilledAmount": "0",
            }
            for line in plan["lines"]
        ],
    }
    result.update(overrides)
    return result


def ready_plan(operations, admin, payload, quantity="19508"):
    plan = create_plan(operations, payload)
    evidence = add_evidence(plan, operations)
    plan = submit(operations, plan, evidence, quantity)
    plan = propose(operations, plan, quantity)
    plan = acknowledge(operations, plan, evidence)
    return finalize(admin, plan), evidence


def test_bulk_workflow_immutable_snapshot_and_invoice_retry(
    operations, admin, finance, call, plan_payload
):
    plan, evidence = ready_plan(operations, admin, plan_payload)
    final = plan["reconciliations"][-1]
    assert Decimal(final["lines"][0]["variance"]) == Decimal("8")
    assert final["snapshot"]["submissions"][0]["evidenceIds"] == [evidence]
    assert final["snapshot"]["approvals"][0]["representative"] == "A One"
    assert final["snapshot"]["reconciliation"]["finalizedBy"]["id"] == admin.pk
    call.refresh_from_db()
    assert call.status == "pending"
    frozen = deepcopy(final["snapshot"])
    old_version = plan["version"]
    plan = post_action(finance, plan, "assessments", assessment_payload(plan))
    assessment = plan["assessments"][-1]
    assert assessment["status"] == "ready"
    assert Decimal(assessment["total"]) == Decimal("17.36")
    issue_url = f"/api/measurement-plans/{plan['id']}/assessments/{assessment['id']}/issue"
    first = authenticated(finance).post(issue_url, {"version": plan["version"]}, format="json")
    assert first.status_code == 200, first.content
    second = authenticated(finance).post(issue_url, {"version": old_version}, format="json")
    assert second.status_code == 200
    assert first.json()["invoice"]["id"] == second.json()["invoice"]["id"]
    assert Invoice.objects.filter(assessment_id=assessment["id"]).count() == 1
    invoice = Invoice.objects.get(assessment_id=assessment["id"])
    assert invoice.inspection_id is None
    assert invoice.purpose == "disparity"
    assert invoice.dues == Decimal("17.36")
    assert invoice.commission_usd == 0
    call.vessel_name = "Renamed later"
    call.save()
    stored = Reconciliation.objects.get(pk=final["id"])
    assert stored.snapshot == frozen
    stored.reason = "Mutation attempt"
    with pytest.raises(TypeError):
        stored.save()
    previous = MeasurementSubmission.objects.get(pk=plan["submissions"][0]["id"])
    previous.source_reference = "Mutation attempt"
    with pytest.raises(TypeError):
        previous.save()


def test_tenant_and_role_boundaries(operations, admin, finance, viewer, plan_payload):
    plan = create_plan(operations, plan_payload)
    other_org = Organization.objects.create(name="Other tenant")
    outsider = User.objects.create_user(
        email="outside@example.test",
        password="Password12345!",
        organization=other_org,
        role="Admin",
        status="active",
        name="Outside",
    )
    assert authenticated(outsider).get(f"/api/measurement-plans/{plan['id']}").status_code == 404
    assert authenticated(outsider).get("/api/measurement-plans").json()["plans"] == []
    assert (
        authenticated(outsider)
        .post("/api/measurement-plans", plan_payload, format="json")
        .status_code
        == 404
    )
    for user in (viewer, finance):
        assert (
            authenticated(user)
            .post("/api/measurement-plans", plan_payload, format="json")
            .status_code
            == 403
        )
    assert authenticated(viewer).get(f"/api/measurement-plans/{plan['id']}").status_code == 200
    evidence = add_evidence(plan, operations)
    plan = submit(operations, plan, evidence)
    plan = propose(operations, plan)
    plan = acknowledge(operations, plan, evidence)
    finalize(operations, plan, expected=403)
    finalize(finance, plan, expected=403)
    plan = finalize(admin, plan)
    post_action(operations, plan, "assessments", assessment_payload(plan), expected=403)


def test_missing_return_evidence_foreign_refs_and_no_missing_as_zero(operations, plan_payload):
    plan = create_plan(operations, plan_payload)
    propose(operations, plan, expected=400)
    second = create_plan(operations, {**plan_payload, "title": "Other parcel"})
    foreign_evidence = add_evidence(second, operations)
    submit(operations, plan, foreign_evidence, expected=400)
    evidence = add_evidence(plan, operations)
    submit(operations, plan, evidence, participant=second["participants"][0]["id"], expected=400)
    submit(operations, plan, evidence, quantity=None, expected=400)
    plan = submit(operations, plan, evidence, quantity="0")
    assert Decimal(plan["submissions"][0]["lines"][0]["quantity"]) == 0


def test_return_revision_stales_approvals_and_is_append_only(operations, admin, plan_payload):
    plan = create_plan(operations, plan_payload)
    evidence = add_evidence(plan, operations)
    plan = submit(operations, plan, evidence)
    plan = propose(operations, plan)
    plan = acknowledge(operations, plan, evidence)
    old_submission = deepcopy(plan["submissions"][0])
    submit(operations, plan, evidence, "19509", expected=400)
    plan = submit(operations, plan, evidence, "19509", reason="Corrected tally")
    assert plan["submissions"][0] == old_submission
    acknowledge(operations, plan, evidence, expected=409)
    finalize(admin, plan, expected=409)
    plan = propose(operations, plan, "19509")
    finalize(admin, plan, expected=400)
    plan = acknowledge(operations, plan, evidence)
    plan = finalize(admin, plan)
    assert plan["reconciliations"][0]["status"] == "superseded"
    assert plan["reconciliations"][-1]["revision"] == 2


def test_independent_finalizer_and_dispute_history(operations, admin, plan_payload):
    plan = create_plan(operations, plan_payload)
    evidence = add_evidence(plan, operations)
    plan = submit(operations, plan, evidence)
    plan = propose(admin, plan)
    plan = acknowledge(operations, plan, evidence, "disputed")
    second_admin = User.objects.create_user(
        email="reviewer@example.test",
        password="Password12345!",
        organization=admin.organization,
        name="Reviewer",
        role="Admin",
        status="active",
    )
    finalize(second_admin, plan, expected=400)
    plan = acknowledge(operations, plan, evidence)
    finalize(admin, plan, expected=400)
    plan = finalize(second_admin, plan)
    assert len(plan["reconciliations"][-1]["approvals"]) == 2
    repeated = finalize(second_admin, {**plan, "version": 1})
    assert repeated["version"] == plan["version"]
    acknowledge(operations, plan, evidence, expected=409)
    submit(operations, plan, evidence, reason="Correction", expected=409)


@pytest.mark.parametrize(
    "manifest,final,tolerance,mode,opening,status,total",
    [
        ("19500", "19508", "2", "deductible", "0", "ready", "13.02"),
        ("19500", "19508", "2", "threshold", "0", "ready", "17.36"),
        ("19500", "19508", "8", "threshold", "0", "no-charge", "0"),
        ("19500", "19500", "0", "threshold", "0", "no-charge", "0"),
        ("19500", "19499", "0", "threshold", "0", "held", "0"),
        ("0", "8", "0", "threshold", "2", "ready", "15.36"),
        ("19500", "19508", "0", "threshold", "20", "held", "-2.64"),
    ],
)
def test_signed_disparity_tolerance_and_opening(
    operations,
    admin,
    finance,
    plan_payload,
    manifest,
    final,
    tolerance,
    mode,
    opening,
    status,
    total,
):
    plan_payload["lines"][0]["manifestQuantity"] = manifest
    plan, _ = ready_plan(operations, admin, plan_payload, final)
    payload = assessment_payload(plan)
    payload["lines"][0].update(tolerance=tolerance, toleranceMode=mode, openingBilledAmount=opening)
    plan = post_action(finance, plan, "assessments", payload)
    assessment = plan["assessments"][-1]
    assert assessment["status"] == status
    assert Decimal(assessment["total"]) == Decimal(total)
    assert Decimal(assessment["lines"][0]["variance"]) == Decimal(final) - Decimal(manifest)
    if status != "ready":
        post_action(finance, plan, f"assessments/{assessment['id']}/issue", {}, expected=409)


def test_unknown_manifest_quantity_adjustment_and_explicit_policy(
    operations, admin, finance, plan_payload
):
    plan_payload["lines"][0]["manifestQuantity"] = None
    plan, _ = ready_plan(operations, admin, plan_payload)
    assert plan["reconciliations"][-1]["lines"][0]["variance"] is None
    post_action(finance, plan, "assessments", assessment_payload(plan), expected=400)
    payload = assessment_payload(plan, policy="quantity-adjustment")
    post_action(finance, plan, "assessments", payload, expected=400)
    payload["lines"][0]["previouslyBilledQuantity"] = "19500"
    invalid = {**payload, "currency": "NGN"}
    post_action(finance, plan, "assessments", invalid, expected=400)
    plan = post_action(finance, plan, "assessments", payload)
    assert Decimal(plan["assessments"][-1]["total"]) == Decimal("17.36")


def test_amendment_only_invoices_remaining_and_keeps_prior_final(
    operations, admin, finance, plan_payload
):
    plan, evidence = ready_plan(operations, admin, plan_payload)
    first_final = deepcopy(plan["reconciliations"][-1])
    plan = post_action(finance, plan, "assessments", assessment_payload(plan))
    plan = post_action(
        finance, plan, f"assessments/{plan['assessments'][-1]['id']}/issue", {}, expected=200
    )
    plan = propose(operations, plan, "19510")
    assert plan["reconciliations"][0]["status"] == "final"
    post_action(
        finance,
        plan,
        "assessments",
        assessment_payload(plan, reconciliationId=first_final["id"]),
        expected=409,
    )
    plan = submit(
        operations, plan, evidence, "19510", reason="Second survey confirms revised result"
    )
    finalize(admin, plan, expected=409)
    plan = propose(operations, plan, "19510")
    plan = acknowledge(operations, plan, evidence)
    plan = finalize(admin, plan)
    assert plan["reconciliations"][0]["status"] == "superseded"
    assert plan["reconciliations"][0]["snapshot"] == first_final["snapshot"]
    changed_config = assessment_payload(plan)
    changed_config["lines"][0]["rate"] = "3"
    post_action(finance, plan, "assessments", changed_config, expected=409)
    plan = post_action(finance, plan, "assessments", assessment_payload(plan))
    latest = plan["assessments"][-1]
    assert Decimal(latest["total"]) == Decimal("4.34")
    assert Decimal(latest["lines"][0]["priorInvoicedAmount"]) == Decimal("17.36")
    plan = post_action(finance, plan, f"assessments/{latest['id']}/issue", {}, expected=200)
    plan = post_action(finance, plan, "assessments", assessment_payload(plan))
    assert plan["assessments"][-1]["status"] == "no-charge"
    assert Invoice.objects.filter(purpose="disparity").count() == 2


def test_latest_assessment_and_version_are_required(operations, admin, finance, plan_payload):
    plan, _ = ready_plan(operations, admin, plan_payload)
    stale = {**plan, "version": 1}
    post_action(finance, stale, "assessments", assessment_payload(plan), expected=409)
    response = authenticated(finance).post(
        f"/api/measurement-plans/{plan['id']}/assessments", assessment_payload(plan), format="json"
    )
    assert response.status_code == 400
    plan = post_action(finance, plan, "assessments", assessment_payload(plan))
    first_assessment = plan["assessments"][-1]["id"]
    plan = post_action(finance, plan, "assessments", assessment_payload(plan))
    assert plan["assessments"][0]["superseded"] is True
    assert plan["assessments"][-1]["superseded"] is False
    post_action(finance, plan, f"assessments/{first_assessment}/issue", {}, expected=409)


def test_count_lines_complete_scope_and_schedule_validation(operations, admin, plan_payload):
    plan_payload["lines"][0].update(
        unit="count",
        category="Container",
        containerSize="45",
        loadStatus="laden",
        manifestQuantity="18.5",
    )
    response = authenticated(operations).post("/api/measurement-plans", plan_payload, format="json")
    assert response.status_code == 400
    plan_payload["lines"][0]["manifestQuantity"] = "18"
    plan = create_plan(operations, plan_payload)
    evidence = add_evidence(plan, operations)
    submit(operations, plan, evidence, "18.5", expected=400)
    plan = submit(operations, plan, evidence, "22")
    plan = propose(operations, plan, "22")
    assert Decimal(plan["reconciliations"][-1]["lines"][0]["variance"]) == 4
    response = authenticated(operations).patch(
        f"/api/measurement-plans/{plan['id']}",
        {"version": plan["version"], "participants": plan_payload["participants"]},
        format="json",
    )
    assert response.status_code == 409
    response = authenticated(operations).patch(
        f"/api/measurement-plans/{plan['id']}",
        {"version": plan["version"], "endsAt": "2000-01-01T00:00:00Z"},
        format="json",
    )
    assert response.status_code == 400


def test_cancellation_audit_and_patch(operations, plan_payload):
    plan = create_plan(operations, plan_payload)
    response = authenticated(operations).patch(
        f"/api/measurement-plans/{plan['id']}",
        {
            "version": plan["version"],
            "scheduledAt": timezone.now().isoformat(),
            "notes": "Rescheduled",
        },
        format="json",
    )
    assert response.status_code == 200, response.content
    plan = response.json()["plan"]
    response = authenticated(operations).patch(
        f"/api/measurement-plans/{plan['id']}",
        {"version": plan["version"], "status": "cancelled"},
        format="json",
    )
    assert response.status_code == 400
    response = authenticated(operations).patch(
        f"/api/measurement-plans/{plan['id']}",
        {"version": plan["version"], "status": "cancelled", "reason": "Cargo cancelled"},
        format="json",
    )
    assert response.status_code == 200
    assert response.json()["plan"]["cancellationReason"] == "Cargo cancelled"
    plan = response.json()["plan"]
    evidence = add_evidence(plan, operations)
    submit(operations, plan, evidence, expected=409)


@pytest.mark.django_db(transaction=True)
def test_concurrent_finalization_and_invoice_are_exactly_once(
    operations, admin, finance, plan_payload
):
    if connection.vendor != "postgresql":
        pytest.skip("Row-lock concurrency requires PostgreSQL")
    plan = create_plan(operations, plan_payload)
    evidence = add_evidence(plan, operations)
    plan = submit(operations, plan, evidence)
    plan = propose(operations, plan)
    plan = acknowledge(operations, plan, evidence)

    def concurrent_post(user, url, version):
        barrier = Barrier(2)

        def perform():
            close_old_connections()
            try:
                actor = User.objects.get(pk=user.pk)
                barrier.wait(timeout=10)
                response = authenticated(actor).post(url, {"version": version}, format="json")
                return response.status_code, response.json()
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: perform(), range(2)))
        assert [code for code, _ in results] == [200, 200], results
        return results

    rid = plan["reconciliations"][-1]["id"]
    results = concurrent_post(
        admin,
        f"/api/measurement-plans/{plan['id']}/reconciliations/{rid}/finalize",
        plan["version"],
    )
    plan = results[0][1]["plan"]
    plan = post_action(finance, plan, "assessments", assessment_payload(plan))
    aid = plan["assessments"][-1]["id"]
    results = concurrent_post(
        finance, f"/api/measurement-plans/{plan['id']}/assessments/{aid}/issue", plan["version"]
    )
    assert results[0][1]["invoice"]["id"] == results[1][1]["invoice"]["id"]
    assert Invoice.objects.filter(assessment_id=aid).count() == 1
    assert Reconciliation.objects.filter(plan_id=plan["id"], status="final").count() == 1
    assert MeasurementPlan.objects.get(pk=plan["id"]).version == plan["version"] + 1


def test_suspended_tenant_is_denied_every_measurement_action(
    operations, admin, finance, plan_payload
):
    plan, evidence = ready_plan(operations, admin, plan_payload)
    plan = post_action(finance, plan, "assessments", assessment_payload(plan))
    operations.organization.access_status = Organization.AccessStatus.SUSPENDED
    operations.organization.suspended_at = timezone.now()
    operations.organization.suspension_reason = "Access suspended for verification"
    operations.organization.save(
        update_fields=("access_status", "suspended_at", "suspension_reason")
    )
    for user in (operations, admin, finance):
        user.refresh_from_db()
        client = authenticated(user)
        assert client.get("/api/measurement-plans").status_code == 403
        assert client.get(f"/api/measurement-plans/{plan['id']}").status_code == 403
        assert client.post("/api/measurement-plans", plan_payload, format="json").status_code == 403
        assert (
            client.patch(
                f"/api/measurement-plans/{plan['id']}",
                {"version": plan["version"], "notes": "Denied"},
                format="json",
            ).status_code
            == 403
        )
        for action in (
            "submissions",
            "reconciliations",
            f"reconciliations/{plan['reconciliations'][-1]['id']}/approvals",
            f"reconciliations/{plan['reconciliations'][-1]['id']}/finalize",
            "assessments",
            f"assessments/{plan['assessments'][-1]['id']}/issue",
        ):
            assert (
                client.post(
                    f"/api/measurement-plans/{plan['id']}/{action}",
                    {"version": plan["version"]},
                    format="json",
                ).status_code
                == 403
            )


def test_one_negative_line_holds_entire_assessment(operations, admin, finance, plan_payload):
    second = deepcopy(plan_payload["lines"][0])
    second.update(description="Parcel B", manifestQuantity="19509")
    plan_payload["lines"].append(second)
    plan, _ = ready_plan(operations, admin, plan_payload)
    plan = post_action(finance, plan, "assessments", assessment_payload(plan))
    assessment = plan["assessments"][-1]
    assert Decimal(assessment["total"]) > 0
    assert assessment["status"] == "held"
    post_action(finance, plan, f"assessments/{assessment['id']}/issue", {}, expected=409)


def test_voided_prior_invoice_stales_assessment(operations, admin, finance, plan_payload):
    plan, _ = ready_plan(operations, admin, plan_payload)
    plan = post_action(finance, plan, "assessments", assessment_payload(plan))
    first = plan["assessments"][-1]["id"]
    plan = post_action(finance, plan, f"assessments/{first}/issue", {}, expected=200)
    plan = post_action(finance, plan, "assessments", assessment_payload(plan))
    assert plan["assessments"][-1]["status"] == "no-charge"
    invoice = Invoice.objects.get(assessment_id=first)
    invoice.status = Invoice.Status.VOID
    invoice.save(update_fields=("status",))
    plan = post_action(finance, plan, "assessments", assessment_payload(plan))
    assert plan["assessments"][-1]["status"] == "ready"
    assert Decimal(plan["assessments"][-1]["total"]) == Decimal("17.36")


def test_not_applicable_requires_explanation_and_never_becomes_zero(operations, plan_payload):
    plan = create_plan(operations, plan_payload)
    evidence = add_evidence(plan, operations)
    payload = {
        "participantId": plan["participants"][0]["id"],
        "observedAt": timezone.now().isoformat(),
        "sourceReference": "Return 002",
        "evidenceIds": [evidence],
        "lines": [
            {
                "lineId": plan["lines"][0]["id"],
                "status": "not-applicable",
                "quantity": None,
                "note": "",
            }
        ],
    }
    post_action(operations, plan, "submissions", payload, expected=400)
    payload["lines"][0]["note"] = "Not measured by this stakeholder"
    plan = post_action(operations, plan, "submissions", payload)
    assert plan["submissions"][-1]["lines"][0]["quantity"] is None
    assert plan["submissions"][-1]["lines"][0]["status"] == "not-applicable"
    with pytest.raises(TypeError):
        MeasurementSubmission.objects.filter(plan_id=plan["id"]).update(source_reference="Mutated")
    with pytest.raises(TypeError):
        MeasurementEvidence.objects.filter(pk=evidence).delete()


def test_foreign_or_duplicate_lines_are_rejected(operations, plan_payload):
    plan = create_plan(operations, plan_payload)
    evidence = add_evidence(plan, operations)
    other = create_plan(operations, {**plan_payload, "title": "Second plan"})
    payload = {
        "participantId": plan["participants"][0]["id"],
        "observedAt": timezone.now().isoformat(),
        "sourceReference": "Return 002",
        "evidenceIds": [evidence],
        "lines": [
            {
                "lineId": other["lines"][0]["id"],
                "status": "reported",
                "quantity": "19508",
                "note": "",
            }
        ],
    }
    post_action(operations, plan, "submissions", payload, expected=400)
    payload["lines"][0]["lineId"] = plan["lines"][0]["id"]
    payload["lines"].append(deepcopy(payload["lines"][0]))
    post_action(operations, plan, "submissions", payload, expected=400)
