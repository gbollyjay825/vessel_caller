from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from django.utils import timezone

from api.documents import simple_pdf
from api.serializers import invoice_data
from billing.models import Invoice, InvoiceStatusEvent, Payment
from billing.services import active_default_step, transition_invoice
from operations.models import VesselCall
from organizations.models import Organization
from .conftest import authenticated

pytestmark = pytest.mark.django_db


@pytest.fixture
def disparity_invoice(admin):
    call = VesselCall.objects.create(
        organization=admin.organization,
        vessel_name="MV Reconciled",
        reference="ROT-MEASURE-1",
        nrt=Decimal("80000"),
    )
    invoice = Invoice.objects.create(
        organization=admin.organization,
        vessel_call=call,
        inspection=None,
        purpose=Invoice.Purpose.DISPARITY,
        payer="Cargo Receiver",
        currency="USD",
        invoice_no="INV-MEASURE-1",
        cargo_type="",
        issued_on=date.today(),
        due_on=date.today(),
        dues=Decimal("100.00"),
        rate=0,
        commission_usd=0,
        commission_ngn=0,
        exchange_rate=1500,
        line_items=[
            {
                "lineId": "containers",
                "description": "20 foot containers",
                "unit": "count",
                "baselineQuantity": "100",
                "finalQuantity": "110",
                "variance": "10",
                "rate": "10.00",
                "tolerance": "0",
                "toleranceMode": "threshold",
                "chargeableQuantity": "10",
                "entitlement": "100.00",
                "openingBilledAmount": "0.00",
                "priorInvoicedAmount": "0.00",
                "amount": "100.00",
            }
        ],
    )
    transition_invoice(
        invoice,
        active_default_step(admin.organization_id),
        source=InvoiceStatusEvent.Source.CREATED,
        actor=admin,
    )
    return invoice


def test_disparity_invoice_is_in_state_without_inspection_and_has_its_own_pdf(
    admin, disparity_invoice, monkeypatch
):
    captured_rows = []

    def capture_document(title, rows, **kwargs):
        captured_rows.extend(rows)
        return simple_pdf(title, rows, **kwargs)

    monkeypatch.setattr("api.operation_views.simple_pdf", capture_document)
    client = authenticated(admin)
    payload = client.get("/api/state").json()["invoices"][0]
    assert payload["purpose"] == "disparity"
    assert payload["inspectionId"] is None
    assert payload["currency"] == "USD" and payload["payer"] == "Cargo Receiver"
    assert payload["paidAmount"] == 0 and payload["outstandingAmount"] == 100
    assert payload["workflowStatus"]["code"] == "pending-director-finance-review"
    assert payload["lineItems"] == disparity_invoice.line_items
    response = client.get(f"/api/invoices/{disparity_invoice.id}/document")
    assert response.status_code == 200
    assert response.content.startswith(b"%PDF")
    text = "\n".join(f"{label}: {value}" for label, value in captured_rows)
    assert "Measurement disparity" in text and "20 foot containers" in text
    assert "Cargo Receiver" in text and "Total disparity (USD)" in text
    assert "Harbour dues" not in text and "Commission" not in text


def test_partial_payments_settle_only_the_balance_and_preserve_workflow(admin, disparity_invoice):
    client = authenticated(admin)
    url = f"/api/invoices/{disparity_invoice.id}/payments"
    payment = {
        "paidOn": "2026-09-29",
        "method": "Bank transfer",
        "reference": "PART-1",
        "amount": "40.00",
    }
    partial = client.post(url, payment, format="json", HTTP_IDEMPOTENCY_KEY="first")
    assert partial.status_code == 201, partial.content
    assert partial.data["invoice"]["paidAmount"] == 40
    assert partial.data["invoice"]["outstandingAmount"] == 60
    assert partial.data["invoice"]["workflowStatus"]["code"] == "pending-director-finance-review"
    analytics = client.get("/api/analytics").data["totals"]
    assert (
        analytics["invoiced"] == 100
        and analytics["collected"] == 40
        and analytics["outstanding"] == 60
    )
    assert analytics["liquidR"] == 0 and analytics["dryR"] == 0
    overpaid = client.post(
        url, {**payment, "reference": "TOO-MUCH", "amount": "60.01"}, format="json"
    )
    assert overpaid.status_code == 400
    settled = client.post(
        url,
        {"paidOn": "2026-09-29", "method": "Bank transfer", "reference": "PART-2"},
        format="json",
        HTTP_IDEMPOTENCY_KEY="settlement",
    )
    assert settled.status_code == 201, settled.content
    assert settled.data["payment"]["amount"] == 60
    assert settled.data["invoice"]["status"] == "paid"
    assert settled.data["invoice"]["workflowStatus"]["code"] == "paid"
    repeated = client.post(url, payment, format="json", HTTP_IDEMPOTENCY_KEY="settlement")
    assert (
        repeated.status_code == 200
        and repeated.data["payment"]["id"] == settled.data["payment"]["id"]
    )
    refused = client.post(url, {**payment, "reference": "EXTRA"}, format="json")
    assert refused.status_code == 409
    reversed_payment = client.post(
        f"/api/payments/{settled.data['payment']['id']}/reverse",
        {"reason": "Transfer reversed"},
        format="json",
    )
    assert reversed_payment.status_code == 200
    assert reversed_payment.data["invoice"]["paidAmount"] == 40
    assert reversed_payment.data["invoice"]["outstandingAmount"] == 60
    assert (
        reversed_payment.data["invoice"]["workflowStatus"]["code"]
        == "pending-director-finance-review"
    )
    assert Payment.objects.filter(invoice=disparity_invoice).count() == 2


def test_disparity_documents_remain_organization_scoped(admin, viewer, disparity_invoice):
    other = Organization.objects.create(name="Other Org")
    viewer.organization = other
    viewer.save(update_fields=["organization"])
    assert (
        authenticated(viewer).get(f"/api/invoices/{disparity_invoice.id}/document").status_code
        == 404
    )


def test_legacy_paid_snapshot_without_ledger_retains_balance(disparity_invoice):
    disparity_invoice.status = "paid"
    disparity_invoice.save(update_fields=["status"])
    payload = invoice_data(disparity_invoice)
    assert payload["paidAmount"] == 100 and payload["outstandingAmount"] == 0


def test_issued_disparity_pdf_keeps_frozen_voyage_after_call_rename(
    operations, admin, finance, monkeypatch
):
    from .test_measurements import assessment_payload, post_action, ready_plan

    call = VesselCall.objects.create(
        organization=operations.organization,
        vessel_name="MV Original Voyage",
        reference="ROT-ORIGINAL",
        created_by=operations,
    )
    payload = {
        "callId": call.id,
        "title": "Voyage snapshot regression",
        "scheduledAt": timezone.now().isoformat(),
        "method": "Draft survey",
        "stage": "Discharge",
        "scope": "Bulk wheat parcel",
        "leadSurveyor": "Surveyor One",
        "participants": [{"name": "Shipping Agent", "role": "agent"}],
        "lines": [
            {
                "description": "Wheat",
                "category": "Bulk",
                "direction": "import",
                "unit": "tonnes",
                "basis": "Metric tonnes",
                "manifestQuantity": "19500",
                "baselineReference": "Manifest 1",
            }
        ],
    }
    plan, _ = ready_plan(operations, admin, payload)
    plan = post_action(finance, plan, "assessments", assessment_payload(plan))
    assessment_id = plan["assessments"][-1]["id"]
    plan = post_action(finance, plan, f"assessments/{assessment_id}/issue", {}, expected=200)
    invoice_id = plan["assessments"][-1]["invoiceId"]
    documents = []

    def capture_document(title, rows, **kwargs):
        documents.append(dict(rows))
        return simple_pdf(title, rows, **kwargs)

    monkeypatch.setattr("api.operation_views.simple_pdf", capture_document)
    client = authenticated(finance)
    document_url = f"/api/invoices/{invoice_id}/document"
    assert client.get(document_url).status_code == 200
    changed = authenticated(operations).patch(
        f"/api/vessel-calls/{call.id}",
        {"version": call.version, "vesselName": "MV Renamed Later", "reference": "ROT-RENAMED"},
        format="json",
    )
    assert changed.status_code == 200, changed.content
    call.refresh_from_db()
    assert call.vessel_name == "MV Renamed Later" and call.reference == "ROT-RENAMED"
    assert client.get(document_url).status_code == 200
    assert documents[0]["Vessel"] == documents[1]["Vessel"] == "MV Original Voyage"
    assert documents[0]["Rotation"] == documents[1]["Rotation"] == "ROT-ORIGINAL"
    assert (
        documents[0]["Total disparity (USD)"]
        == documents[1]["Total disparity (USD)"]
        == Decimal("17.36")
    )


def test_duplicate_container_descriptions_retain_approved_context_in_api_and_pdfs(
    operations, admin, finance, monkeypatch
):
    from measurements.models import CargoLine
    from reportlab.platypus import Paragraph
    from .test_measurements import assessment_payload, post_action, ready_plan

    call = VesselCall.objects.create(
        organization=operations.organization,
        vessel_name="MV Container Context",
        reference="ROT-CONTAINER-CONTEXT",
    )
    cargo = [
        {
            "direction": "import",
            "containerSize": "20",
            "loadStatus": "laden",
            "basis": "Import tally",
        },
        {
            "direction": "export",
            "containerSize": "40",
            "loadStatus": "empty",
            "basis": "Export tally",
        },
    ]
    payload = {
        "callId": call.id,
        "title": "Container classifications",
        "scheduledAt": timezone.now().isoformat(),
        "method": "Container tally",
        "stage": "Completed cargo operations",
        "scope": "Separate import and export container lines",
        "leadSurveyor": "Surveyor One",
        "participants": [{"name": "Terminal", "role": "operator"}],
        "lines": [
            {
                "description": "Containers",
                "category": "Container",
                "unit": "count",
                "manifestQuantity": "100",
                "baselineReference": "Container manifest",
                **context,
            }
            for context in cargo
        ],
    }
    plan, _ = ready_plan(operations, admin, payload, quantity="110")
    expected = {
        line["id"]: {
            key: line[key]
            for key in ("category", "direction", "containerSize", "loadStatus", "basis")
        }
        for line in plan["reconciliations"][-1]["snapshot"]["lines"]
    }
    plan = post_action(finance, plan, "assessments", assessment_payload(plan))
    assessment = plan["assessments"][-1]
    for line in assessment["lines"]:
        assert {key: line[key] for key in expected[line["lineId"]]} == expected[line["lineId"]]
    plan = post_action(finance, plan, f"assessments/{assessment['id']}/issue", {}, expected=200)
    invoice = Invoice.objects.get(pk=plan["assessments"][-1]["invoiceId"])
    assert {line["containerSize"] for line in invoice.line_items} == {"20", "40"}
    for line in invoice.line_items:
        assert {key: line[key] for key in expected[line["lineId"]]} == expected[line["lineId"]]

    # Even a later maintenance change to mutable planning rows cannot rewrite approved context.
    CargoLine.objects.filter(plan_id=plan["id"]).update(
        category="Changed category",
        direction="changed",
        container_size="45",
        load_status="changed",
        basis="Changed basis",
    )
    refreshed = authenticated(finance).get(f"/api/measurement-plans/{plan['id']}").json()["plan"]
    for line in refreshed["assessments"][-1]["lines"]:
        assert {key: line[key] for key in expected[line["lineId"]]} == expected[line["lineId"]]

    paragraphs = []

    def capture_paragraph(text, *args, **kwargs):
        paragraphs.append(text)
        return Paragraph(text, *args, **kwargs)

    monkeypatch.setattr("measurements.documents.Paragraph", capture_paragraph)
    rid = plan["reconciliations"][-1]["id"]
    sheet = authenticated(finance).get(
        f"/api/measurement-plans/{plan['id']}/reconciliations/{rid}/document"
    )
    assert sheet.status_code == 200 and sheet.content.startswith(b"%PDF-")
    for context in cargo:
        assert any(
            f"{context['containerSize']}-foot" in text
            and context["direction"] in text
            and context["loadStatus"] in text
            and context["basis"] in text
            and "Container" in text
            for text in paragraphs
        )
    assert not any("Changed basis" in text for text in paragraphs)

    rows = []

    def capture_invoice(title, document_rows, **kwargs):
        rows.extend(document_rows)
        return simple_pdf(title, document_rows, **kwargs)

    monkeypatch.setattr("api.operation_views.simple_pdf", capture_invoice)
    result = authenticated(finance).get(f"/api/invoices/{invoice.id}/document")
    assert result.status_code == 200 and result.content.startswith(b"%PDF-")
    for context in cargo:
        assert ("Container size", f"{context['containerSize']}-foot") in rows
        assert ("Direction", context["direction"]) in rows
        assert ("Load status", context["loadStatus"]) in rows
        assert ("Measurement basis", context["basis"]) in rows
    assert ("Category", "Container") in rows
    assert ("Measurement basis", "Changed basis") not in rows
