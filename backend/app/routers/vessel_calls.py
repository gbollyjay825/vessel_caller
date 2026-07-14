"""Vessel call registration + cancellation (Admin/Operations)."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..db import get_db
from ..ids import new_id
from ..models import Organization, User, VesselCall
from ..schemas import CallCreate
from ..security import require_roles
from ..services import bump_rev, call_to_dict

router = APIRouter(prefix="/api/vessel-calls", tags=["vessel-calls"])


@router.post("", status_code=status.HTTP_201_CREATED)
def create_call(body: CallCreate, user: User = Depends(require_roles("Admin", "Operations")),
                db: Session = Depends(get_db)):
    dup = db.query(VesselCall).filter(
        VesselCall.org_id == user.org_id, VesselCall.reference == body.reference).first()
    if dup:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Rotation number {body.reference} is already registered")
    call = VesselCall(
        id=new_id("vc"), org_id=user.org_id, vessel_name=body.vesselName, reference=body.reference,
        type=body.type, flag=body.flag, nrt=body.nrt, eta=body.eta, sailing_eta=body.sailingEta,
        berth=body.berth, berth_date=None, status="pending", notes=body.notes,
        registered=datetime.now(timezone.utc).isoformat(timespec="minutes"),
        created_by=user.id,
    )
    db.add(call)
    org = db.get(Organization, user.org_id)
    rev = bump_rev(db, org)
    db.commit()
    return {"call": call_to_dict(call), "rev": rev}


@router.delete("/{call_id}")
def cancel_call(call_id: str, user: User = Depends(require_roles("Admin", "Operations")),
                db: Session = Depends(get_db)):
    call = db.get(VesselCall, call_id)
    if not call or call.org_id != user.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Vessel call not found")
    db.delete(call)  # inspections + invoices cascade via FK ON DELETE CASCADE
    org = db.get(Organization, user.org_id)
    rev = bump_rev(db, org)
    db.commit()
    return {"ok": True, "rev": rev}
