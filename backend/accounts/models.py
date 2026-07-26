from __future__ import annotations

import uuid

from django.conf import settings
from django.contrib.auth.models import AbstractBaseUser, PermissionsMixin
from django.db import models
from django.utils import timezone

from .managers import UserManager


def prefixed(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def user_id() -> str:
    return prefixed("u")


def invitation_id() -> str:
    return prefixed("inv")


def token_id() -> str:
    return prefixed("tok")


def challenge_id() -> str:
    return prefixed("mfa")


class User(AbstractBaseUser, PermissionsMixin):
    class Role(models.TextChoices):
        ADMIN = "Admin", "Admin"
        OPERATIONS = "Operations", "Operations"
        FINANCE = "Finance", "Finance"
        VIEWER = "Viewer", "Viewer"

    class Status(models.TextChoices):
        INVITED = "invited", "Invited"
        ACTIVE = "active", "Active"
        SUSPENDED = "suspended", "Suspended"
        REMOVED = "removed", "Removed"

    id = models.CharField(primary_key=True, max_length=32, default=user_id)
    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.PROTECT,
        related_name="users",
    )
    name = models.CharField(max_length=255)
    email = models.EmailField(unique=True)
    pending_email = models.EmailField(blank=True)
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.VIEWER)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.INVITED)
    email_verified_at = models.DateTimeField(null=True, blank=True)
    mfa_secret = models.TextField(blank=True)
    mfa_enabled_at = models.DateTimeField(null=True, blank=True)
    mfa_grace_ends_at = models.DateTimeField(null=True, blank=True)
    is_staff = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    removed_at = models.DateTimeField(null=True, blank=True)

    objects = UserManager()
    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["name"]

    class Meta:
        ordering = ("created_at", "id")
        constraints = [
            models.CheckConstraint(
                condition=models.Q(role__in=["Admin", "Operations", "Finance", "Viewer"]),
                name="accounts_user_valid_role",
            ),
            models.CheckConstraint(
                condition=models.Q(status__in=["invited", "active", "suspended", "removed"]),
                name="accounts_user_valid_status",
            ),
        ]

    @staticmethod
    def now():
        return timezone.now()

    @property
    def is_active(self) -> bool:  # type: ignore[override]
        return self.status == self.Status.ACTIVE

    @property
    def mfa_enabled(self) -> bool:
        return bool(self.mfa_enabled_at and self.mfa_secret)

    @property
    def mfa_enrollment_required(self) -> bool:
        return (
            self.role in {self.Role.ADMIN, self.Role.FINANCE}
            and not self.mfa_enabled
            and bool(self.mfa_grace_ends_at and self.mfa_grace_ends_at <= timezone.now())
        )

    def __str__(self) -> str:
        return self.email


class Invitation(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        ACCEPTED = "accepted", "Accepted"
        REVOKED = "revoked", "Revoked"
        EXPIRED = "expired", "Expired"

    id = models.CharField(primary_key=True, max_length=32, default=invitation_id)
    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="invitations",
    )
    name = models.CharField(max_length=255)
    email = models.EmailField()
    role = models.CharField(max_length=20, choices=User.Role.choices)
    token_hash = models.CharField(max_length=64, unique=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="sent_invitations",
    )
    expires_at = models.DateTimeField()
    accepted_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=("organization", "email"),
                condition=models.Q(status="pending"),
                name="accounts_one_pending_invitation",
            )
        ]


class ActionToken(models.Model):
    class Kind(models.TextChoices):
        VERIFY_EMAIL = "verify_email", "Verify email"
        RESET_PASSWORD = "reset_password", "Reset password"
        CHANGE_EMAIL = "change_email", "Change email"

    id = models.CharField(primary_key=True, max_length=32, default=token_id)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="action_tokens"
    )
    kind = models.CharField(max_length=30, choices=Kind.choices)
    token_hash = models.CharField(max_length=64, unique=True)
    metadata = models.JSONField(default=dict, blank=True)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=("kind", "token_hash"))]


class UserSession(models.Model):
    session_key = models.CharField(primary_key=True, max_length=40)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="sessions"
    )
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=512, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField(default=timezone.now)
    absolute_expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ("-last_seen_at",)


class MFAChallenge(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=challenge_id)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="mfa_challenges"
    )
    expires_at = models.DateTimeField()
    attempts = models.PositiveSmallIntegerField(default=0)
    used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)


class MFARecoveryCode(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="recovery_codes"
    )
    code_hash = models.CharField(max_length=128)
    used_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=("user", "used_at"))]


class EmailOutbox(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        SENDING = "sending", "Sending"
        SENT = "sent", "Sent"
        FAILED = "failed", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    to_email = models.EmailField()
    template = models.CharField(max_length=80)
    subject = models.CharField(max_length=255)
    context = models.JSONField(default=dict)
    idempotency_key = models.CharField(max_length=128, unique=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    attempts = models.PositiveSmallIntegerField(default=0)
    provider_id = models.CharField(max_length=255, blank=True)
    last_error = models.TextField(blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
