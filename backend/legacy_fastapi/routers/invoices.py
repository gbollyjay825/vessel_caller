"""Legacy invoice payment tracking (Admin/Finance)."""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Invoice, Organization, User
from ..schemas import InvoicePatch
from ..security import require_roles
from ..services import bump_rev, invoice_to_dict

router = APIRouter(prefix="/api/invoices", tags=["invoices"])


@router.put("/{invoice_id}")
def update_invoice(invoice_id: str, body: InvoicePatch,
                   user: User = Depends(require_roles("Admin", "Finance")),
                   db: Session = Depends(get_db)):
    inv = db.get(Invoice, invoice_id)
    if not inv or inv.org_id != user.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invoice not found")
    data = body.model_dump(exclude_unset=True)
    if "status" in data:
        inv.status = data["status"]
    if "payment" in data:
        payment = data["payment"]
        # a recorded payment settles the snapshotted dues — stamp the amount
        # unless the caller sent one
        if payment and payment.get("amount") is None:
            payment = {**payment, "amount": inv.dues}
        inv.payment = payment
    org = db.get(Organization, user.org_id)
    rev = bump_rev(db, org)
    db.commit()
    return {"invoice": invoice_to_dict(inv), "rev": rev}
