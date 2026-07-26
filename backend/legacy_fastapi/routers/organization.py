"""Legacy organization profile + team management (Admin-gated)."""
import re

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..db import get_db
from ..ids import new_id
from ..models import ROLES, Organization, User
from ..schemas import MemberCreate, MemberUpdate, OrgUpdate
from ..security import hash_password, require_roles
from ..services import bump_rev, org_to_dict, user_to_dict

router = APIRouter(prefix="/api/organization", tags=["organization"])
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _members(db, org_id):
    return db.query(User).filter(User.org_id == org_id).order_by(User.created_at).all()


@router.put("")
def update_org(body: OrgUpdate, user: User = Depends(require_roles("Admin")),
               db: Session = Depends(get_db)):
    org = db.get(Organization, user.org_id)
    data = body.model_dump(exclude_unset=True)
    port = data.pop("designatedPort", None) or data.pop("primaryPort", None)
    if port is not None:
        org.primary_port = port
    field_map = {"name": "name", "rcNumber": "rc_number", "email": "email", "phone": "phone",
                 "address": "address", "ports": "ports", "logo": "logo", "registered": "registered"}
    for key, col in field_map.items():
        if key in data:
            setattr(org, col, data[key])
    rev = bump_rev(db, org)
    db.commit()
    return {"org": org_to_dict(org, _members(db, org.id)), "rev": rev}


@router.post("/members", status_code=status.HTTP_201_CREATED)
def add_member(body: MemberCreate, user: User = Depends(require_roles("Admin")),
               db: Session = Depends(get_db)):
    name = body.name.strip()
    email = body.email.strip().lower()
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Name is required")
    if not EMAIL_RE.fullmatch(email):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Enter a valid email address")
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with that email already exists")
    if body.role not in ROLES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown role")
    member = User(id=new_id("u"), org_id=user.org_id, name=name, email=email,
                  password_hash=hash_password(body.password), role=body.role, active=True)
    db.add(member)
    org = db.get(Organization, user.org_id)
    rev = bump_rev(db, org)
    db.commit()
    return {"member": user_to_dict(member), "rev": rev}


@router.put("/members/{member_id}")
def update_member(member_id: str, body: MemberUpdate,
                  user: User = Depends(require_roles("Admin")), db: Session = Depends(get_db)):
    member = db.get(User, member_id)
    if not member or member.org_id != user.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Member not found")
    data = body.model_dump(exclude_unset=True)
    if "role" in data and data["role"] not in ROLES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown role")
    if "name" in data:
        data["name"] = data["name"].strip()
        if not data["name"]:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Name is required")
    changing_own_access = member.id == user.id and (
        ("role" in data and data["role"] != member.role) or data.get("active") is False
    )
    if changing_own_access:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "You cannot change your own role or deactivate your own account",
        )
    # protect the last admin from being demoted/deactivated
    admins = db.query(User).filter(User.org_id == user.org_id, User.role == "Admin", User.active).count()
    demoting = (data.get("role") and data["role"] != "Admin") or (data.get("active") is False)
    if member.role == "Admin" and member.active and admins <= 1 and demoting:
        raise HTTPException(status.HTTP_409_CONFLICT, "The organization must keep at least one Admin")
    if "name" in data: member.name = data["name"]
    if "role" in data: member.role = data["role"]
    if "active" in data: member.active = data["active"]
    if data.get("password"): member.password_hash = hash_password(data["password"])
    org = db.get(Organization, user.org_id)
    rev = bump_rev(db, org)
    db.commit()
    return {"member": user_to_dict(member), "rev": rev}


@router.delete("/members/{member_id}")
def remove_member(member_id: str, user: User = Depends(require_roles("Admin")),
                  db: Session = Depends(get_db)):
    member = db.get(User, member_id)
    if not member or member.org_id != user.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Member not found")
    if member.id == user.id:
        raise HTTPException(status.HTTP_409_CONFLICT, "You cannot delete your own account")
    admins = db.query(User).filter(User.org_id == user.org_id, User.role == "Admin", User.active).count()
    if member.role == "Admin" and member.active and admins <= 1:
        raise HTTPException(status.HTTP_409_CONFLICT, "The organization must keep at least one Admin")
    db.delete(member)
    org = db.get(Organization, user.org_id)
    rev = bump_rev(db, org)
    db.commit()
    return {"ok": True, "rev": rev}
