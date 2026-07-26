"""Bulk state for the authenticated user's organization, with rev-polling."""
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Organization, User
from ..security import get_current_user
from ..services import org_state

router = APIRouter(prefix="/api", tags=["state"])


@router.get("/state")
def get_state(rev: Optional[int] = None, user: User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    org = db.get(Organization, user.org_id)
    if rev is not None and rev == org.rev:
        return {"changed": False, "rev": org.rev}
    return org_state(db, org, include_members=user.role == "Admin")
