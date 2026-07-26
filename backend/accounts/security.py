from __future__ import annotations

import base64
import hashlib
import secrets
import string
from datetime import timedelta

import pyotp
from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.contrib.auth.hashers import check_password, make_password
from django.db import transaction
from django.utils import timezone
from passlib.hash import pbkdf2_sha256

from .models import ActionToken, MFARecoveryCode, User

EMPTY_MFA_SECRET = ""  # nosec B105


def token_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


@transaction.atomic
def issue_action_token(
    user: User,
    kind: str,
    *,
    hours: int,
    metadata: dict | None = None,
) -> tuple[ActionToken, str]:
    User.objects.select_for_update().get(pk=user.pk)
    raw = secrets.token_urlsafe(48)
    ActionToken.objects.filter(user=user, kind=kind, used_at__isnull=True).delete()
    obj = ActionToken.objects.create(
        user=user,
        kind=kind,
        token_hash=token_hash(raw),
        metadata=metadata or {},
        expires_at=timezone.now() + timedelta(hours=hours),
    )
    return obj, raw


@transaction.atomic
def consume_action_token(raw: str, kind: str) -> ActionToken | None:
    try:
        token = (
            ActionToken.objects.select_for_update()
            .select_related("user")
            .get(token_hash=token_hash(raw), kind=kind, used_at__isnull=True)
        )
    except ActionToken.DoesNotExist:
        return None
    if token.expires_at <= timezone.now():
        return None
    token.used_at = timezone.now()
    token.save(update_fields=("used_at",))
    return token


def verify_password_compat(user: User, raw: str) -> bool:
    encoded = user.password or ""
    if encoded.startswith("$pbkdf2-sha256$"):
        try:
            valid = pbkdf2_sha256.verify(raw, encoded)
        except (ValueError, TypeError):
            valid = False
        if valid:
            user.set_password(raw)
            user.save(update_fields=("password",))
        return valid
    return check_password(raw, encoded, setter=lambda password: _upgrade(user, password))


def _upgrade(user: User, raw: str) -> None:
    user.set_password(raw)
    user.save(update_fields=("password",))


def _fernet() -> Fernet:
    source = settings.MFA_ENCRYPTION_KEY or settings.SECRET_KEY
    key = base64.urlsafe_b64encode(hashlib.sha256(source.encode()).digest())
    return Fernet(key)


def encrypt_secret(secret: str) -> str:
    return _fernet().encrypt(secret.encode()).decode()


def decrypt_secret(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode()).decode()
    except (InvalidToken, ValueError):
        return ""


def verify_totp(user: User, code: str) -> bool:
    secret = decrypt_secret(user.mfa_secret)
    return bool(secret and pyotp.TOTP(secret).verify(code.replace(" ", ""), valid_window=1))


def generate_recovery_codes(user: User) -> list[str]:
    MFARecoveryCode.objects.filter(user=user).delete()
    alphabet = string.ascii_uppercase + string.digits
    codes = [
        "-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(3))
        for _ in range(10)
    ]
    MFARecoveryCode.objects.bulk_create(
        [MFARecoveryCode(user=user, code_hash=make_password(code)) for code in codes]
    )
    return codes


@transaction.atomic
def use_recovery_code(user: User, raw: str) -> bool:
    locked_user = User.objects.select_for_update().get(pk=user.pk)
    for candidate in locked_user.recovery_codes.select_for_update().filter(used_at__isnull=True):
        if check_password(raw.upper(), candidate.code_hash):
            candidate.used_at = timezone.now()
            candidate.save(update_fields=("used_at",))
            return True
    return False
