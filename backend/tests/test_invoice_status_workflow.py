from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from billing.models import Invoice
from billing.services import ensure_default_steps
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
        issued_on=date(2026, 7, 1), due_on=date(2026, 7, 15),
        dues=Decimal("100"), rate=Decimal("1"), commission_usd=Decimal("3.5"),
        commission_ngn=Decimal("5600"), exchange_rate=Decimal("1600"),
        current_status=steps["draft"],
    )


def test_default_steps_keep_paid_protected_and_terminal(admin):
    steps = {step.code: step for step in ensure_default_steps(admin.organization)}
    assert list(steps) == ["draft", "submitted", "under-review", "approved", "paid"]
    assert steps["paid"].is_paid and steps["paid"].is_terminal and steps["paid"].is_protected


def test_only_admin_can_configure_invoice_steps(admin, finance, viewer):
    body = {"label": "Awaiting documents"}
    assert authenticated(viewer).post("/api/invoice-status-steps", body, format="json").status_code == 403
    assert authenticated(finance).post("/api/invoice-status-steps", body, format="json").status_code == 403
    response = authenticated(admin).post("/api/invoice-status-steps", body, format="json")
    assert response.status_code == 201
    assert response.data["step"]["code"] == "awaiting-documents"
    assert authenticated(admin).post("/api/invoice-status-steps", {"label": "No", "code": "paid"}, format="json").status_code == 400


def test_finance_can_transition_non_paid_status_but_not_paid(invoice, finance):
    steps = {step.code: step for step in ensure_default_steps(finance.organization)}
    client = authenticated(finance)
    response = client.patch(f"/api/invoices/{invoice.id}/status", {"statusId": steps["submitted"].id}, format="json")
    assert response.status_code == 200
    invoice.refresh_from_db()
    assert invoice.status == Invoice.Status.UNPAID and invoice.current_status_id == steps["submitted"].id
    assert client.patch(f"/api/invoices/{invoice.id}/status", {"statusId": steps["paid"].id}, format="json").status_code == 400


def test_payment_marks_paid_and_reversal_restores_last_active_non_paid_status(invoice, finance):
    steps = {step.code: step for step in ensure_default_steps(finance.organization)}
    client = authenticated(finance)
    assert client.patch(f"/api/invoices/{invoice.id}/status", {"statusId": steps["submitted"].id}, format="json").status_code == 200
    paid = client.post(f"/api/invoices/{invoice.id}/payments", {"amount": "100", "paidOn": "2026-07-02", "method": "Bank transfer", "reference": "PAY-WORKFLOW"}, format="json")
    assert paid.status_code == 201
    invoice.refresh_from_db()
    assert invoice.status == Invoice.Status.PAID and invoice.current_status_id == steps["paid"].id
    reversed_payment = client.post(f"/api/payments/{paid.data['payment']['id']}/reverse", {"reason": "Duplicate transfer"}, format="json")
    assert reversed_payment.status_code == 200
    invoice.refresh_from_db()
    assert invoice.status == Invoice.Status.UNPAID and invoice.current_status_id == steps["submitted"].id
    assert list(invoice.status_events.values_list("to_code", flat=True)) == ["submitted", "paid", "submitted"]
