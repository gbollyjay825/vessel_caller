from __future__ import annotations

import uuid

from django.core.validators import MinValueValidator
from django.db import models


def organization_id() -> str:
    return f"org-{uuid.uuid4().hex[:12]}"


class Organization(models.Model):
    class Kind(models.TextChoices):
        CUSTOMER = "customer", "Customer"
        PLATFORM = "platform", "Platform"

    class AccessStatus(models.TextChoices):
        PENDING_APPROVAL = "pending_approval", "Pending approval"
        ACTIVE = "active", "Active"
        SUSPENDED = "suspended", "Suspended"

    id = models.CharField(primary_key=True, max_length=32, default=organization_id)
    kind = models.CharField(
        max_length=20,
        choices=Kind.choices,
        default=Kind.CUSTOMER,
        db_default=Kind.CUSTOMER,
    )
    access_status = models.CharField(
        max_length=20,
        choices=AccessStatus.choices,
        default=AccessStatus.ACTIVE,
        db_default=AccessStatus.ACTIVE,
    )
    registered = models.BooleanField(default=False)
    name = models.CharField(max_length=255)
    rc_number = models.CharField(max_length=100, blank=True)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=50, blank=True)
    address = models.TextField(blank=True)
    primary_port = models.CharField(max_length=255, default="Port of Calabar")
    ports = models.JSONField(default=list, blank=True)
    logo_object_key = models.CharField(max_length=1024, blank=True)
    revision = models.PositiveBigIntegerField(default=0)
    approved_at = models.DateTimeField(null=True, blank=True)
    approved_by = models.ForeignKey(
        "accounts.User",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="customer_organizations_approved",
    )
    approval_reason = models.TextField(blank=True, db_default="")
    suspended_at = models.DateTimeField(null=True, blank=True)
    suspension_reason = models.TextField(blank=True, db_default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("name", "id")
        constraints = [
            models.CheckConstraint(
                condition=models.Q(kind__in=["customer", "platform"]),
                name="organizations_valid_kind",
            ),
            models.CheckConstraint(
                condition=models.Q(access_status__in=["pending_approval", "active", "suspended"]),
                name="organizations_valid_access_status",
            ),
            models.UniqueConstraint(
                fields=("kind",),
                condition=models.Q(kind="platform"),
                name="organizations_one_platform_container",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        access_status__in=["pending_approval", "active"],
                        suspended_at__isnull=True,
                        suspension_reason="",
                    )
                    | (
                        models.Q(access_status="suspended", suspended_at__isnull=False)
                        & ~models.Q(suspension_reason="")
                    )
                ),
                name="organizations_valid_suspension_state",
            ),
        ]

    def __str__(self) -> str:
        return self.name

    @property
    def is_access_active(self) -> bool:
        return self.access_status == self.AccessStatus.ACTIVE


class OrganizationSettings(models.Model):
    organization = models.OneToOneField(
        Organization,
        on_delete=models.CASCADE,
        primary_key=True,
        related_name="settings",
    )
    commission_rate = models.DecimalField(
        max_digits=7,
        decimal_places=4,
        default="3.5000",
        validators=[MinValueValidator(0)],
    )
    exchange_rate = models.DecimalField(
        max_digits=14,
        decimal_places=4,
        default="1600.0000",
        validators=[MinValueValidator(0)],
    )
    government_liquid_rate = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        default="1.6800",
        validators=[MinValueValidator(0)],
    )
    private_liquid_rate = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        default="2.8800",
        validators=[MinValueValidator(0)],
    )
    international_liquid_rate = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        default="4.2300",
        validators=[MinValueValidator(0)],
    )
    dry_dues_rate = models.DecimalField(
        max_digits=12,
        decimal_places=4,
        default="2.1700",
        validators=[MinValueValidator(0)],
    )
    port_name = models.CharField(max_length=255, default="Port of Calabar")
    terminals = models.JSONField(default=list, blank=True)
    updated_at = models.DateTimeField(auto_now=True)
