"""Legacy authentication & authorization.

Passwords are hashed with pbkdf2_sha256 (pure-python, no native deps).
Sessions are stateless JWT bearer tokens. Roles are enforced server-side via
FastAPI dependencies — the UI gating is cosmetic; this is the real gate.
"""
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import User

settings = get_settings()
_pwd = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")
_bearer = HTTPBearer(auto_error=True)


def hash_password(raw: str) -> str:
    return _pwd.hash(raw)


def verify_password(raw: str, hashed: str) -> bool:
    try:
        return _pwd.verify(raw, hashed)
    except ValueError:
        return False


def create_access_token(user: User) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user.id,
        "org": user.org_id,
        "role": user.role,
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_expire_minutes),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    cred_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired session",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(creds.credentials, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.PyJWTError:
        raise cred_exc
    user = db.get(User, payload.get("sub"))
    if user is None or not user.active:
        raise cred_exc
    return user


def require_roles(*roles: str):
    """Dependency factory — 403 unless the current user holds one of `roles`."""
    def _dep(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires one of: {', '.join(roles)}",
            )
        return user
    return _dep
