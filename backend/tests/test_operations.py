from __future__ import annotations

import pytest

from billing.models import Invoice, Payment
from operations.models import VesselCall

from .conftest import authenticated

pytestmark = pytest.mark.django_db


def test_vessel_draft_finalize_payment_reversal(admin, viewer):
    client = authenticated(admin)
    created_call = client.post(
        "/api/vessel-calls",
        {
            "vesselName": "MT Sea Eagle",
            "reference": "ROT-2026-0501",
            "type": "Tanker",
            "nrt": "50000",
        },
        format="json",
    )
    assert created_call.status_code == 201, created_call.content
    call = created_call.json()["call"]
    draft = client.post(
        "/api/inspections",
        {
            "callId": call["id"],
            "cargoType": "Liquid",
            "product": "PMS",
            "reconciledTonnage": "48000",
            "jetty": {
                "type": "International",
                "category": None,
                "name": "UNICEM Jetty",
            },
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="inspection-1",
    )
    assert draft.status_code == 201
    inspection = draft.json()["inspection"]
    assert inspection["status"] == "draft"
    updated = client.patch(
        f"/api/inspections/{inspection['id']}",
        {"reconciledTonnage": "49000", "version": inspection["version"]},
        format="json",
    )
    assert updated.status_code == 200
    finalized = client.post(
        f"/api/inspections/{inspection['id']}/finalize",
        {"version": updated.json()["inspection"]["version"]},
        format="json",
    )
    assert finalized.status_code == 200, finalized.content
    invoice = finalized.json()["invoice"]
    assert invoice["dues"] == 211500.0
    again = client.post(f"/api/inspections/{inspection['id']}/finalize", {}, format="json")
    assert again.status_code == 200
    assert again.json()["invoice"]["id"] == invoice["id"]
    assert Invoice.objects.filter(inspection_id=inspection["id"]).count() == 1
    payment = client.post(
        f"/api/invoices/{invoice['id']}/payments",
        {
            "paidOn": "2026-07-01",
            "method": "Bank transfer",
            "reference": "NPA-1",
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="payment-1",
    )
    assert payment.status_code == 201
    assert payment.json()["invoice"]["status"] == "paid"
    reversed_response = client.post(
        f"/api/payments/{payment.json()['payment']['id']}/reverse",
        {"reason": "Bank reversal"},
        format="json",
    )
    assert reversed_response.status_code == 200
    assert reversed_response.json()["invoice"]["status"] == "unpaid"
    assert Payment.objects.filter(reversed_at__isnull=False).count() == 1
    viewer_client = authenticated(viewer)
    assert (
        viewer_client.post(
            "/api/vessel-calls",
            {"vesselName": "Denied", "reference": "DENIED"},
            format="json",
        ).status_code
        == 403
    )


def test_inspection_report_projection_lists_all_liquid_measurements(admin):
    client = authenticated(admin)
    call = client.post(
        "/api/vessel-calls",
        {"vesselName": "MT Liquid", "reference": "ROT-LIQUID", "nrt": 1},
        format="json",
    ).json()["call"]
    inspection = client.post(
        "/api/inspections",
        {
            "callId": call["id"],
            "cargoType": "Liquid",
            "product": "PMS",
            "reconciledTonnage": "20",
            "jetty": {"type": "Local", "category": "Private", "name": "Jetty A"},
            "liquid": {
                "ullage": "2.5",
                "observedVol": "30",
                "temp": "15",
                "blQty": "21",
                "surveyorTonnage": "20",
            },
        },
        format="json",
    ).json()["inspection"]
    detail = client.get(f"/api/inspections/{inspection['id']}").json()["inspection"]
    labels = {field["label"] for section in detail["reportSections"] for field in section["fields"]}
    assert {
        "Jetty type",
        "Ullage / sounding (m)",
        "Observed volume (m³)",
        "Temperature (°C)",
        "Bill of Lading quantity (MT)",
        "Surveyor's reconciled tonnage (MT)",
    } <= labels


def test_inspection_report_projection_lists_all_draft_survey_measurements(admin):
    client = authenticated(admin)
    call = client.post(
        "/api/vessel-calls",
        {"vesselName": "MV Bulk", "reference": "ROT-DRY", "nrt": 1},
        format="json",
    ).json()["call"]
    inspection = client.post(
        "/api/inspections",
        {
            "callId": call["id"],
            "cargoType": "Dry",
            "reconciledTonnage": "90",
            "dry": {"displBefore": "120", "displAfter": "20", "deductibles": "15", "constant": "5"},
        },
        format="json",
    ).json()["inspection"]
    detail = client.get(f"/api/inspections/{inspection['id']}").json()["inspection"]
    labels = {field["label"] for section in detail["reportSections"] for field in section["fields"]}
    assert {
        "Displacement before (MT)",
        "Displacement after (MT)",
        "Deductibles (MT)",
        "Constant (MT)",
    } <= labels


def test_soft_cancel_and_optimistic_conflict(admin):
    client = authenticated(admin)
    call = client.post(
        "/api/vessel-calls",
        {"vesselName": "MV Cancel", "reference": "ROT-CANCEL", "nrt": 10},
        format="json",
    ).json()["call"]
    updated = client.patch(
        f"/api/vessel-calls/{call['id']}",
        {"notes": "updated", "version": call["version"]},
        format="json",
    )
    assert updated.status_code == 200
    stale = client.patch(
        f"/api/vessel-calls/{call['id']}",
        {"notes": "stale", "version": call["version"]},
        format="json",
    )
    assert stale.status_code == 409
    cancelled = client.post(
        f"/api/vessel-calls/{call['id']}/cancel",
        {
            "reason": "Port closure",
            "version": updated.json()["call"]["version"],
        },
        format="json",
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["call"]["status"] == "cancelled"
    assert VesselCall.objects.filter(pk=call["id"]).exists()


def test_invoice_snapshot_survives_rate_change(admin):
    client = authenticated(admin)
    call_id = client.post(
        "/api/vessel-calls",
        {"vesselName": "MT Snapshot", "reference": "ROT-SNAPSHOT", "nrt": 50000},
        format="json",
    ).json()["call"]["id"]
    inspection = client.post(
        "/api/inspections",
        {
            "callId": call_id,
            "cargoType": "Liquid",
            "jetty": {"type": "International"},
        },
        format="json",
    ).json()["inspection"]
    invoice = client.post(
        f"/api/inspections/{inspection['id']}/finalize", {}, format="json"
    ).json()["invoice"]
    client.put(
        "/api/settings",
        {
            "liquidDuesRates": {
                "government": 1.68,
                "private": 2.88,
                "international": 9.99,
            }
        },
        format="json",
    )
    state_invoice = next(
        item for item in client.get("/api/state").json()["invoices"] if item["id"] == invoice["id"]
    )
    assert state_invoice["dues"] == 211500.0
