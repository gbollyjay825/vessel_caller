from __future__ import annotations

import importlib
from datetime import date
from decimal import Decimal

import pytest

from billing.models import Invoice, InvoiceStatusStep
from billing.services import (
    active_default_step,
    ensure_default_steps,
    paid_step,
    reconcile_payment_status,
    transition_invoice,
    workflow_step_data,
)
from operations.models import Inspection, VesselCall
from .conftest import authenticated


pytestmark = pytest.mark.django_db


@pytest.fixture
def invoice(admin):
    steps = {step.code: step for step in ensure_default_steps(admin.organization)}
    call = VesselCall.objects.create(
        organization=admin.organization,
        vessel_name="MV Workflow",
        reference="ROT-WORKFLOW",
        nrt=Decimal("100"),
    )
    inspection = Inspection.objects.create(
        organization=admin.organization,
        vessel_call=call,
        vessel_name=call.vessel_name,
        cargo_type=Inspection.CargoType.LIQUID,
        reference="INS-WORKFLOW",
        reconciled_tonnage=Decimal("100"),
    )
    return Invoice.objects.create(
        organization=admin.organization,
        vessel_call=call,
        inspection=inspection,
        invoice_no="INV-WORKFLOW",
        cargo_type="Liquid",
        issued_on=date(2026, 7, 1),
        due_on=date(2026, 7, 15),
        dues=Decimal("100"),
        rate=Decimal("1"),
        commission_usd=Decimal("3.5"),
        commission_ngn=Decimal("5600"),
        exchange_rate=Decimal("1600"),
        current_status=steps["pending-director-finance-review"],
    )


def test_default_steps_keep_paid_protected_and_terminal(admin):
    steps = {step.code: step for step in ensure_default_steps(admin.organization)}
    assert list(steps) == [
        "pending-director-finance-review",
        "pending-audit-review",
        "pending-md-review",
        "pending-accounts-review",
        "approved",
        "paid",
    ]
    assert steps["paid"].is_paid and steps["paid"].is_terminal and steps["paid"].is_protected
    assert workflow_step_data(None, legacy_status=Invoice.Status.VOID)["label"] == "Void"
    assert workflow_step_data(None)["code"] == ""


def test_director_review_migration_preserves_legacy_history(invoice, admin):
    legacy = InvoiceStatusStep.objects.create(
        organization=admin.organization,
        code="draft",
        label="Draft",
        position=700,
        active=True,
    )
    invoice.current_status = legacy
    invoice.save(update_fields=("current_status",))

    migration = importlib.import_module("billing.migrations.0004_director_review_workflow")
    migration.install_director_review_workflow(importlib.import_module("django.apps").apps, None)

    legacy.refresh_from_db()
    invoice.refresh_from_db()
    assert legacy.active is False
    assert invoice.current_status.code == "pending-director-finance-review"
    event = invoice.status_events.order_by("-created_at", "-id").first()
    assert event is not None
    assert event.from_code == "draft"
    assert event.to_code == "pending-director-finance-review"


def test_only_admin_can_configure_invoice_steps(admin, finance, viewer):
    body = {"label": "Awaiting documents"}
    assert (
        authenticated(viewer).post("/api/invoice-status-steps", body, format="json").status_code
        == 403
    )
    assert (
        authenticated(finance).post("/api/invoice-status-steps", body, format="json").status_code
        == 403
    )
    response = authenticated(admin).post("/api/invoice-status-steps", body, format="json")
    assert response.status_code == 201
    assert response.data["step"]["code"] == "awaiting-documents"
    assert (
        authenticated(admin)
        .post("/api/invoice-status-steps", {"label": "No", "code": "paid"}, format="json")
        .status_code
        == 400
    )


def test_invoice_status_steps_are_visible_to_readers_and_reject_duplicate_codes(admin, viewer):
    admin_client = authenticated(admin)
    created = admin_client.post(
        "/api/invoice-status-steps", {"label": "Awaiting documents"}, format="json"
    )
    assert created.status_code == 201
    assert (
        admin_client.post(
            "/api/invoice-status-steps",
            {"label": "Another label", "code": created.data["step"]["code"]},
            format="json",
        ).status_code
        == 400
    )
    visible = authenticated(viewer).get("/api/invoice-status-steps")
    assert visible.status_code == 200
    assert any(step["id"] == created.data["step"]["id"] for step in visible.data["steps"])


def test_finance_can_transition_non_paid_status_but_not_paid(invoice, finance):
    steps = {step.code: step for step in ensure_default_steps(finance.organization)}
    client = authenticated(finance)
    response = client.patch(
        f"/api/invoices/{invoice.id}/status",
        {"statusId": steps["pending-audit-review"].id},
        format="json",
    )
    assert response.status_code == 200
    invoice.refresh_from_db()
    assert (
        invoice.status == Invoice.Status.UNPAID
        and invoice.current_status_id == steps["pending-audit-review"].id
    )
    assert (
        client.patch(
            f"/api/invoices/{invoice.id}/status", {"statusId": steps["paid"].id}, format="json"
        ).status_code
        == 400
    )


def test_payment_marks_paid_and_reversal_restores_last_active_non_paid_status(invoice, finance):
    steps = {step.code: step for step in ensure_default_steps(finance.organization)}
    client = authenticated(finance)
    assert (
        client.patch(
            f"/api/invoices/{invoice.id}/status",
            {"statusId": steps["pending-audit-review"].id},
            format="json",
        ).status_code
        == 200
    )
    paid = client.post(
        f"/api/invoices/{invoice.id}/payments",
        {
            "amount": "100",
            "paidOn": "2026-07-02",
            "method": "Bank transfer",
            "reference": "PAY-WORKFLOW",
        },
        format="json",
    )
    assert paid.status_code == 201
    invoice.refresh_from_db()
    assert invoice.status == Invoice.Status.PAID and invoice.current_status_id == steps["paid"].id
    reversed_payment = client.post(
        f"/api/payments/{paid.data['payment']['id']}/reverse",
        {"reason": "Duplicate transfer"},
        format="json",
    )
    assert reversed_payment.status_code == 200
    invoice.refresh_from_db()
    assert (
        invoice.status == Invoice.Status.UNPAID
        and invoice.current_status_id == steps["pending-audit-review"].id
    )
    assert list(invoice.status_events.values_list("to_code", flat=True)) == [
        "pending-audit-review",
        "paid",
        "pending-audit-review",
    ]


def test_workflow_service_noop_void_and_default_fallback(invoice, admin):
    steps = {step.code: step for step in ensure_default_steps(admin.organization)}
    assert (
        transition_invoice(
            invoice, steps["pending-director-finance-review"], source="manual", actor=admin
        )
        is None
    )
    # An unpaid invoice already assigned to an active non-paid stage should
    # retain its status when an unrelated payment reconciliation occurs.
    assert reconcile_payment_status(invoice, actor=admin, source="payment") is None
    invoice.status = Invoice.Status.VOID
    invoice.save(update_fields=("status",))
    assert reconcile_payment_status(invoice, actor=admin, source="reversal") is None
    invoice.status = Invoice.Status.PAID
    invoice.current_status = steps["paid"]
    invoice.save(update_fields=("status", "current_status"))
    assert reconcile_payment_status(invoice, actor=admin, source="reversal") is not None
    invoice.refresh_from_db()
    assert invoice.current_status_id == active_default_step(admin.organization_id).id


def test_paid_step_requires_the_protected_paid_configuration(admin, monkeypatch):
    InvoiceStatusStep.objects.filter(organization=admin.organization, is_paid=True).delete()
    monkeypatch.setattr("billing.services.ensure_default_steps", lambda _organization: [])
    with pytest.raises(ValueError, match="Paid"):
        paid_step(admin.organization_id)


def test_admin_can_update_and_reorder_steps_but_cannot_change_paid(admin):
    client = authenticated(admin)
    steps = {step.code: step for step in ensure_default_steps(admin.organization)}
    created = client.post(
        "/api/invoice-status-steps",
        {"label": "Awaiting documents"},
        format="json",
    )
    assert created.status_code == 201
    created_id = created.data["step"]["id"]

    updated = client.patch(
        f"/api/invoice-status-steps/{created_id}",
        {"label": "Documents received", "active": False},
        format="json",
    )
    assert updated.status_code == 200
    assert updated.data["step"]["label"] == "Documents received"
    assert updated.data["step"]["active"] is False
    assert (
        client.patch(
            f"/api/invoice-status-steps/{steps['paid'].id}",
            {"label": "Settled"},
            format="json",
        ).status_code
        == 400
    )
    assert (
        client.patch(
            "/api/invoice-status-steps/iss-missing",
            {"label": "Missing"},
            format="json",
        ).status_code
        == 404
    )

    all_steps = list(ensure_default_steps(admin.organization))
    assert any(step.id == created_id for step in all_steps)
    ids = [step.id for step in all_steps]
    assert (
        client.post(
            "/api/invoice-status-steps/reorder", {"ids": ids[:-1] + [ids[0]]}, format="json"
        ).status_code
        == 400
    )
    paid_id = steps["paid"].id
    reordered_ids = [paid_id] + [step_id for step_id in ids if step_id != paid_id]
    assert (
        client.post(
            "/api/invoice-status-steps/reorder", {"ids": reordered_ids}, format="json"
        ).status_code
        == 400
    )
    valid_ids = [step_id for step_id in ids if step_id != paid_id] + [paid_id]
    reordered = client.post("/api/invoice-status-steps/reorder", {"ids": valid_ids}, format="json")
    assert reordered.status_code == 200
    assert [step["id"] for step in reordered.data["steps"]] == valid_ids


def test_invoice_transition_rejects_missing_void_and_inactive_step(invoice, admin):
    client = authenticated(admin)
    steps = {step.code: step for step in ensure_default_steps(admin.organization)}
    assert (
        client.patch(
            "/api/invoices/iv-missing/status",
            {"statusId": steps["pending-director-finance-review"].id},
            format="json",
        ).status_code
        == 404
    )
    inactive = client.post(
        "/api/invoice-status-steps",
        {"label": "On hold", "active": False},
        format="json",
    )
    assert inactive.status_code == 201
    assert (
        client.patch(
            f"/api/invoices/{invoice.id}/status",
            {"statusId": inactive.data["step"]["id"]},
            format="json",
        ).status_code
        == 400
    )
    invoice.status = Invoice.Status.VOID
    invoice.save(update_fields=("status",))
    assert (
        client.patch(
            f"/api/invoices/{invoice.id}/status",
            {"statusId": steps["pending-director-finance-review"].id},
            format="json",
        ).status_code
        == 409
    )
