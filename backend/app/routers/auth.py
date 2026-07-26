"""Authentication: register a new organization (+ first Admin), log in, whoami."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..db import get_db
from ..ids import new_id
from ..models import Organization, Settings, User
from ..schemas import LoginRequest, RegisterRequest
from ..security import create_access_token, get_current_user, hash_password, verify_password
from ..services import org_to_dict, user_to_dict

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register", status_code=status.HTTP_201_CREATED)
def register(body: RegisterRequest, db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == body.email.lower()).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with that email already exists")

    org = Organization(
        id=new_id("org"), registered=True, name=body.orgName, rc_number=body.rcNumber,
        email=body.email.lower(), phone=body.phone, address=body.address,
        primary_port=body.designatedPort,
        ports=body.ports or [body.designatedPort],
    )
    db.add(org)
    db.add(Settings(org_id=org.id, port_name=body.designatedPort,
                    terminals=["Calabar New Port — Berth 3", "Calabar Bulk Terminal", "UNICEM Jetty"]))
    admin = User(
        id=new_id("u"), org_id=org.id, name=body.name, email=body.email.lower(),
        password_hash=hash_password(body.password), role="Admin", active=True,
    )
    db.add(admin)
    db.commit()
    return {"token": create_access_token(admin), "user": user_to_dict(admin),
            "org": org_to_dict(org, [admin])}


@router.post("/login")
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == body.email.lower()).first()
    if not user or not verify_password(body.password, user.password_hash) or not user.active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    return {"token": create_access_token(user), "user": user_to_dict(user)}


@router.get("/me")
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    org = db.get(Organization, user.org_id)
    members = db.query(User).filter(User.org_id == org.id).all() if user.role == "Admin" else []
    return {"user": user_to_dict(user), "org": org_to_dict(org, members)}


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(_: User = Depends(get_current_user)):
    # Stateless JWT — the client discards the token. (A revocation list would
    # live here if we needed server-side logout.)
    return None
