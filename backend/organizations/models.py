from __future__ import annotations

import uuid

from django.core.validators import MinValueValidator
from django.db import models


def organization_id() -> str:
    return f"org-{uuid.uuid4().hex[:12]}"


class Organization(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=organization_id)
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
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("name", "id")

    def __str__(self) -> str:
        return self.name


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
