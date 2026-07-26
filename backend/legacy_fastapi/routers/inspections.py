"""Legacy inspection routes. When completed the server numbers it, completes the
call, and issues an invoice with the money snapshotted at the issued rate."""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..db import get_db
from ..ids import new_id
from ..models import Inspection, Invoice, Organization, Settings, User, VesselCall
from ..schemas import InspectionCreate
from ..security import require_roles
from ..services import (bump_rev, calc_commission, calc_dues, call_to_dict, inspection_to_dict,
                        invoice_to_dict, next_number, rate_for_inspection)

router = APIRouter(prefix="/api/inspections", tags=["inspections"])


@router.post("", status_code=status.HTTP_201_CREATED)
def create_inspection(body: InspectionCreate,
                      user: User = Depends(require_roles("Admin", "Operations")),
                      db: Session = Depends(get_db)):
    call = db.get(VesselCall, body.callId)
    if not call or call.org_id != user.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Vessel call not found")

    now = datetime.now(timezone.utc)
    insp = Inspection(
        id=new_id("in"), org_id=user.org_id, call_id=call.id,
        reference=next_number(db, Inspection, "reference", user.org_id, "INS"),
        vessel_name=call.vessel_name, cargo_type=body.cargoType, product=body.product,
        reconciled_tonnage=body.reconciledTonnage, jetty=body.jetty, liquid=body.liquid,
        dry=body.dry, date=now.isoformat(timespec="minutes"), status=body.status,
        created_by=user.id,
    )
    db.add(insp)

    invoice = None
    if body.status == "completed":
        call.status = "completed"
        if not call.berth_date:
            call.berth_date = now.strftime("%Y-%m-%d")
        s = db.get(Settings, user.org_id)
        rate = rate_for_inspection(body.cargoType, body.jetty, s)
        dues = calc_dues(call.nrt, rate)
        usd, ngn = calc_commission(dues, s)
        invoice = Invoice(
            id=new_id("iv"), org_id=user.org_id, call_id=call.id, inspection_id=insp.id,
            invoice_no=next_number(db, Invoice, "invoice_no", user.org_id, "INV"),
            cargo_type=body.cargoType, issued=now.strftime("%Y-%m-%d"),
            due=(now + timedelta(days=14)).strftime("%Y-%m-%d"), status="unpaid",
            dues=dues, rate=rate or 0, commission_usd=usd, commission_ngn=ngn, fx=s.exchange_rate,
            payment=None,
        )
        db.add(invoice)

    org = db.get(Organization, user.org_id)
    rev = bump_rev(db, org)
    db.commit()
    return {
        "inspection": inspection_to_dict(insp),
        "invoice": invoice_to_dict(invoice) if invoice else None,
        "call": call_to_dict(call),
        "rev": rev,
    }
