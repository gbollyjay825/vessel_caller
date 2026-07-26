from __future__ import annotations

import uuid

from django.core.validators import MinValueValidator
from django.db import models


def entity_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def call_id() -> str:
    return entity_id("vc")


def inspection_id() -> str:
    return entity_id("in")


def evidence_id() -> str:
    return entity_id("ev")


class VesselCall(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        IN_PROGRESS = "in-progress", "In progress"
        COMPLETED = "completed", "Completed"
        CANCELLED = "cancelled", "Cancelled"

    id = models.CharField(primary_key=True, max_length=32, default=call_id)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.PROTECT, related_name="vessel_calls"
    )
    vessel_name = models.CharField(max_length=255)
    reference = models.CharField(max_length=100)
    vessel_type = models.CharField(max_length=100, blank=True)
    flag = models.CharField(max_length=100, blank=True)
    nrt = models.DecimalField(
        max_digits=16, decimal_places=3, default=0, validators=[MinValueValidator(0)]
    )
    eta = models.DateTimeField(null=True, blank=True)
    sailing_eta = models.DateTimeField(null=True, blank=True)
    berth = models.CharField(max_length=255, blank=True)
    berth_date = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    notes = models.TextField(blank=True)
    cancellation_reason = models.TextField(blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    version = models.PositiveIntegerField(default=1)
    registered_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_by = models.ForeignKey(
        "accounts.User",
        on_delete=models.SET_NULL,
        null=True,
        related_name="created_vessel_calls",
    )

    class Meta:
        ordering = ("-registered_at",)
        constraints = [
            models.UniqueConstraint(
                fields=("organization", "reference"), name="operations_unique_rotation"
            ),
            models.CheckConstraint(
                condition=models.Q(nrt__gte=0), name="operations_call_nonnegative_nrt"
            ),
            models.CheckConstraint(
                condition=models.Q(status__in=["pending", "in-progress", "completed", "cancelled"]),
                name="operations_call_valid_status",
            ),
        ]


class Inspection(models.Model):
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        COMPLETED = "completed", "Completed"
        CANCELLED = "cancelled", "Cancelled"

    class CargoType(models.TextChoices):
        LIQUID = "Liquid", "Liquid"
        DRY = "Dry", "Dry"

    id = models.CharField(primary_key=True, max_length=32, default=inspection_id)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.PROTECT, related_name="inspections"
    )
    vessel_call = models.ForeignKey(
        VesselCall, on_delete=models.PROTECT, related_name="inspections"
    )
    reference = models.CharField(max_length=100)
    vessel_name = models.CharField(max_length=255)
    cargo_type = models.CharField(
        max_length=20, choices=CargoType.choices, default=CargoType.LIQUID
    )
    product = models.CharField(max_length=100, blank=True)
    reconciled_tonnage = models.DecimalField(
        max_digits=16, decimal_places=3, default=0, validators=[MinValueValidator(0)]
    )
    jetty = models.JSONField(null=True, blank=True)
    liquid = models.JSONField(null=True, blank=True)
    dry = models.JSONField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
    idempotency_key = models.CharField(max_length=128, blank=True)
    version = models.PositiveIntegerField(default=1)
    completed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_by = models.ForeignKey(
        "accounts.User",
        on_delete=models.SET_NULL,
        null=True,
        related_name="created_inspections",
    )

    class Meta:
        ordering = ("-created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=("organization", "reference"),
                name="operations_unique_inspection_reference",
            ),
            models.CheckConstraint(
                condition=models.Q(reconciled_tonnage__gte=0),
                name="operations_inspection_nonnegative_tonnage",
            ),
            models.UniqueConstraint(
                fields=("organization", "idempotency_key"),
                condition=~models.Q(idempotency_key=""),
                name="operations_unique_inspection_idempotency",
            ),
        ]


class EvidenceAttachment(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=evidence_id)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.PROTECT, related_name="evidence"
    )
    inspection = models.ForeignKey(Inspection, on_delete=models.CASCADE, related_name="evidence")
    object_key = models.CharField(max_length=1024, unique=True)
    file_name = models.CharField(max_length=255)
    content_type = models.CharField(max_length=100)
    size = models.PositiveBigIntegerField()
    checksum = models.CharField(max_length=128, blank=True)
    uploaded_by = models.ForeignKey(
        "accounts.User", on_delete=models.PROTECT, related_name="uploaded_evidence"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("created_at",)
