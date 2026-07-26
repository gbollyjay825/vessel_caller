from __future__ import annotations

import uuid

from django.core.validators import MinValueValidator
from django.db import models


def invoice_id() -> str:
    return f"iv-{uuid.uuid4().hex[:12]}"


def payment_id() -> str:
    return f"pay-{uuid.uuid4().hex[:12]}"


class NumberSequence(models.Model):
    organization = models.ForeignKey("organizations.Organization", on_delete=models.CASCADE)
    kind = models.CharField(max_length=20)
    year = models.PositiveSmallIntegerField()
    value = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=("organization", "kind", "year"),
                name="billing_unique_number_sequence",
            )
        ]


class Invoice(models.Model):
    class Status(models.TextChoices):
        UNPAID = "unpaid", "Unpaid"
        PAID = "paid", "Paid"
        VOID = "void", "Void"

    id = models.CharField(primary_key=True, max_length=32, default=invoice_id)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.PROTECT, related_name="invoices"
    )
    vessel_call = models.ForeignKey(
        "operations.VesselCall", on_delete=models.PROTECT, related_name="invoices"
    )
    inspection = models.OneToOneField(
        "operations.Inspection",
        on_delete=models.PROTECT,
        related_name="invoice",
    )
    invoice_no = models.CharField(max_length=100)
    cargo_type = models.CharField(max_length=20)
    issued_on = models.DateField()
    due_on = models.DateField()
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.UNPAID)
    dues = models.DecimalField(max_digits=18, decimal_places=2, validators=[MinValueValidator(0)])
    rate = models.DecimalField(max_digits=12, decimal_places=4, validators=[MinValueValidator(0)])
    commission_usd = models.DecimalField(
        max_digits=18, decimal_places=2, validators=[MinValueValidator(0)]
    )
    commission_ngn = models.DecimalField(
        max_digits=18, decimal_places=2, validators=[MinValueValidator(0)]
    )
    exchange_rate = models.DecimalField(
        max_digits=14, decimal_places=4, validators=[MinValueValidator(0)]
    )
    void_reason = models.TextField(blank=True)
    voided_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-issued_on", "-created_at")
        constraints = [
            models.UniqueConstraint(
                fields=("organization", "invoice_no"),
                name="billing_unique_invoice_number",
            ),
            models.CheckConstraint(
                condition=models.Q(dues__gte=0), name="billing_invoice_nonnegative_dues"
            ),
        ]


class Payment(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=payment_id)
    invoice = models.ForeignKey(Invoice, on_delete=models.PROTECT, related_name="payments")
    amount = models.DecimalField(
        max_digits=18, decimal_places=2, validators=[MinValueValidator("0.01")]
    )
    paid_on = models.DateField()
    method = models.CharField(max_length=100)
    reference = models.CharField(max_length=255)
    recorded_by = models.ForeignKey(
        "accounts.User", on_delete=models.PROTECT, related_name="recorded_payments"
    )
    recorded_at = models.DateTimeField(auto_now_add=True)
    reversed_at = models.DateTimeField(null=True, blank=True)
    reversed_by = models.ForeignKey(
        "accounts.User",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="reversed_payments",
    )
    reversal_reason = models.TextField(blank=True)
    idempotency_key = models.CharField(max_length=128, blank=True)

    class Meta:
        ordering = ("-recorded_at",)
        constraints = [
            models.UniqueConstraint(
                fields=("invoice", "reference"), name="billing_unique_payment_reference"
            ),
            models.CheckConstraint(
                condition=models.Q(amount__gt=0), name="billing_payment_positive_amount"
            ),
            models.UniqueConstraint(
                fields=("invoice", "idempotency_key"),
                condition=~models.Q(idempotency_key=""),
                name="billing_unique_payment_idempotency",
            ),
        ]
