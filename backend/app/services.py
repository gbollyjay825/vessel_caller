"""Business logic: harbour-dues maths, invoice issuing, the per-org change
counter, and ORM→JSON serialization (camelCase to match the frontend types)."""
from __future__ import annotations

import math

from sqlalchemy import func
from sqlalchemy.orm import Session

from .models import Invoice, Inspection, Organization, Settings, User, VesselCall


# ---- money maths (mirrors the frontend calc engine exactly) ----
def round2(x: float) -> float:
    """Half-up to 2dp, matching JS Math.round for non-negative values."""
    return math.floor(x * 100 + 0.5) / 100


def rate_for_inspection(cargo_type: str, jetty: dict | None, s: Settings):
    if cargo_type == "Dry":
        return s.dry_dues_rate
    j = jetty or {}
    rates = s.liquid_dues_rates or {}
    if j.get("type") == "International":
        return rates.get("international")
    if j.get("type") == "Local" and j.get("category") == "Government":
        return rates.get("government")
    if j.get("type") == "Local" and j.get("category") == "Private":
        return rates.get("private")
    return None


def calc_dues(nrt: float, rate) -> float:
    if not rate or rate <= 0:
        return 0.0
    return round2((nrt or 0) * rate)


def calc_commission(dues: float, s: Settings) -> tuple:
    usd = round2(dues * (s.commission_rate / 100))
    ngn = round(usd * s.exchange_rate)
    return usd, ngn


def bump_rev(db: Session, org: Organization) -> int:
    org.rev = (org.rev or 0) + 1
    db.add(org)
    return org.rev


def next_number(db: Session, model, column, org_id: str, prefix: str) -> str:
    """e.g. INS-2026-0312 → next sequential number scoped to the org."""
    rows = db.query(getattr(model, column)).filter(model.org_id == org_id).all()
    top = 0
    for (ref,) in rows:
        try:
            top = max(top, int(str(ref).split("-")[2]))
        except (IndexError, ValueError):
            continue
    return f"{prefix}-2026-{top + 1:04d}"


# ---- serialization (camelCase, the shape the frontend consumes) ----
def user_to_dict(u: User) -> dict:
    return {"id": u.id, "name": u.name, "email": u.email, "role": u.role, "active": u.active}


def org_to_dict(o: Organization, members: list) -> dict:
    return {
        "id": o.id, "registered": o.registered, "name": o.name, "rcNumber": o.rc_number,
        "email": o.email, "phone": o.phone, "address": o.address,
        "designatedPort": o.primary_port, "primaryPort": o.primary_port,
        "ports": o.ports or [], "logo": o.logo, "rev": o.rev,
        "members": [user_to_dict(m) for m in members],
    }


def settings_to_dict(s: Settings) -> dict:
    return {
        "commissionRate": s.commission_rate, "exchangeRate": s.exchange_rate,
        "liquidDuesRates": s.liquid_dues_rates, "dryDuesRate": s.dry_dues_rate,
        "portName": s.port_name, "terminals": s.terminals or [],
        "smtp": s.smtp, "sms": s.sms,
    }


def call_to_dict(c: VesselCall) -> dict:
    return {
        "id": c.id, "vesselName": c.vessel_name, "reference": c.reference, "type": c.type,
        "flag": c.flag, "nrt": c.nrt, "eta": c.eta, "sailingEta": c.sailing_eta,
        "berth": c.berth, "berthDate": c.berth_date, "status": c.status,
        "notes": c.notes, "registered": c.registered,
    }


def inspection_to_dict(i: Inspection) -> dict:
    return {
        "id": i.id, "reference": i.reference, "callId": i.call_id, "vesselName": i.vessel_name,
        "cargoType": i.cargo_type, "product": i.product, "reconciledTonnage": i.reconciled_tonnage,
        "jetty": i.jetty, "liquid": i.liquid, "dry": i.dry, "date": i.date, "status": i.status,
    }


def invoice_to_dict(v: Invoice) -> dict:
    return {
        "id": v.id, "invoiceNo": v.invoice_no, "callId": v.call_id, "inspectionId": v.inspection_id,
        "cargoType": v.cargo_type, "issued": v.issued, "due": v.due, "status": v.status,
        "dues": v.dues, "rate": v.rate, "commissionUsd": v.commission_usd,
        "commissionNgn": v.commission_ngn, "fx": v.fx, "payment": v.payment,
    }


def org_state(db: Session, org: Organization) -> dict:
    """The bulk state payload the frontend loads/polls."""
    members = db.query(User).filter(User.org_id == org.id).order_by(User.created_at).all()
    settings = db.get(Settings, org.id)
    calls = db.query(VesselCall).filter(VesselCall.org_id == org.id).all()
    inspections = db.query(Inspection).filter(Inspection.org_id == org.id).all()
    invoices = db.query(Invoice).filter(Invoice.org_id == org.id).all()
    return {
        "rev": org.rev,
        "org": org_to_dict(org, members),
        "settings": settings_to_dict(settings),
        "calls": [call_to_dict(c) for c in calls],
        "inspections": [inspection_to_dict(i) for i in inspections],
        "invoices": [invoice_to_dict(v) for v in invoices],
    }
