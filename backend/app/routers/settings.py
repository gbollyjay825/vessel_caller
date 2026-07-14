"""Charge configuration / notifications / port profile (Admin)."""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Organization, Settings, User
from ..schemas import SettingsUpdate
from ..security import require_roles
from ..services import bump_rev, settings_to_dict

router = APIRouter(prefix="/api/settings", tags=["settings"])

_FIELD_MAP = {
    "commissionRate": "commission_rate", "exchangeRate": "exchange_rate",
    "liquidDuesRates": "liquid_dues_rates", "dryDuesRate": "dry_dues_rate",
    "portName": "port_name", "terminals": "terminals", "smtp": "smtp", "sms": "sms",
}


@router.put("")
def update_settings(body: SettingsUpdate, user: User = Depends(require_roles("Admin")),
                    db: Session = Depends(get_db)):
    s = db.get(Settings, user.org_id)
    for key, col in _FIELD_MAP.items():
        val = getattr(body, key)
        if val is not None:
            setattr(s, col, val)
    org = db.get(Organization, user.org_id)
    rev = bump_rev(db, org)
    db.commit()
    return {"settings": settings_to_dict(s), "rev": rev}
