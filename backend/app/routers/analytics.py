"""Analytics computed live from the database (not a hardcoded dataset).

Buckets inspections/invoices by calendar month and by product so the figures
always reflect the org's real vessel calls."""
from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Inspection, Invoice, User, VesselCall
from ..security import get_current_user

router = APIRouter(prefix="/api/analytics", tags=["analytics"])

_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
_PRODUCT_NAMES = {"PMS": "Premium Motor Spirit", "AGO": "Automotive Gas Oil", "DPK": "Dual Purpose Kerosene"}


def _month_keys(n: int) -> list[str]:
    today = date.today()
    y, m = today.year, today.month
    keys = []
    for _ in range(n):
        keys.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    return list(reversed(keys))


@router.get("")
def analytics(months: int = Query(12, ge=1, le=36),
              user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    keys = _month_keys(months)
    idx = {k: i for i, k in enumerate(keys)}
    series = [{"key": k, "month": _MONTHS[int(k[5:7]) - 1], "year": k[:4],
               "liquidT": 0.0, "dryT": 0.0, "revenue": 0.0, "calls": 0} for k in keys]

    inspections = db.query(Inspection).filter(Inspection.org_id == user.org_id).all()
    for ins in inspections:
        k = (ins.date or "")[:7]
        if k in idx:
            row = series[idx[k]]
            if ins.cargo_type == "Dry":
                row["dryT"] += ins.reconciled_tonnage or 0
            else:
                row["liquidT"] += ins.reconciled_tonnage or 0

    invoices = db.query(Invoice).filter(Invoice.org_id == user.org_id).all()
    invoiced = collected = outstanding = 0.0
    liquid_r = dry_r = 0.0
    for v in invoices:
        invoiced += v.dues or 0
        if v.status == "paid":
            collected += v.dues or 0
        else:
            outstanding += v.dues or 0
        if v.cargo_type == "Dry":
            dry_r += v.dues or 0
        else:
            liquid_r += v.dues or 0
        k = (v.issued or "")[:7]
        if k in idx:
            series[idx[k]]["revenue"] += v.dues or 0

    calls = db.query(VesselCall).filter(VesselCall.org_id == user.org_id).all()
    for c in calls:
        k = (c.berth_date or c.registered or "")[:7]
        if k in idx:
            series[idx[k]]["calls"] += 1

    # product mix (by liquid tonnage) + a dry/bulk bucket
    prod_t: dict[str, float] = {}
    for ins in inspections:
        if ins.cargo_type != "Dry" and ins.product:
            prod_t[ins.product] = prod_t.get(ins.product, 0) + (ins.reconciled_tonnage or 0)
    total_liq_t = sum(prod_t.values()) or 1
    products = [
        {"key": k, "name": _PRODUCT_NAMES.get(k, k), "tonnage": round(t),
         "share": round(t / total_liq_t, 4),
         "revenue": round(liquid_r * (t / total_liq_t))}
        for k, t in sorted(prod_t.items(), key=lambda kv: -kv[1])
    ]

    liquid_t = sum(r["liquidT"] for r in series)
    dry_t = sum(r["dryT"] for r in series)
    return {
        "series": series,
        "products": products,
        "totals": {
            "throughput": round(liquid_t + dry_t), "liquidT": round(liquid_t), "dryT": round(dry_t),
            "revenue": round(invoiced), "liquidR": round(liquid_r), "dryR": round(dry_r),
            "invoiced": round(invoiced), "collected": round(collected), "outstanding": round(outstanding),
            "calls": len(calls),
        },
    }
