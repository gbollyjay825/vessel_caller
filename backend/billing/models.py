from __future__ import annotations

import uuid

from django.core.validators import MinValueValidator
from django.db import models


def invoice_id() -> str:
    return f"iv-{uuid.uuid4().hex[:12]}"


def payment_id() -> str:
    return f"pay-{uuid.uuid4().hex[:12]}"


def invoice_status_step_id() -> str:
    return f"iss-{uuid.uuid4().hex[:12]}"


def invoice_status_event_id() -> str:
    return f"ise-{uuid.uuid4().hex[:12]}"


def invoice_attachment_id() -> str:
    return f"iat-{uuid.uuid4().hex[:12]}"


class ImmutableInvoiceStatusEventQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise TypeError("Invoice status events are immutable")

    def delete(self):
        raise TypeError("Invoice status events are immutable")


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


class InvoiceStatusStep(models.Model):
    """An organization-owned, ordered invoice workflow step.

    ``Paid`` is a protected terminal step. Void deliberately remains the
    legacy protected exception rather than an editable customer workflow step.
    """

    id = models.CharField(primary_key=True, max_length=32, default=invoice_status_step_id)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.CASCADE, related_name="invoice_status_steps"
    )
    code = models.SlugField(max_length=50)
    label = models.CharField(max_length=80)
    position = models.PositiveSmallIntegerField()
    active = models.BooleanField(default=True)
    notify_on_entry = models.BooleanField(default=False)
    notification_roles = models.JSONField(default=list, blank=True)
    is_paid = models.BooleanField(default=False)
    is_terminal = models.BooleanField(default=False)
    is_protected = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("position", "created_at")
        constraints = [
            models.UniqueConstraint(
                fields=("organization", "code"), name="billing_unique_invoice_status_code"
            ),
            models.UniqueConstraint(
                fields=("organization", "position"), name="billing_unique_invoice_status_position"
            ),
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
    current_status = models.ForeignKey(
        InvoiceStatusStep,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="current_invoices",
    )
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


class InvoiceStatusEvent(models.Model):
    """Append-only workflow history with denormalized step snapshots."""

    class Source(models.TextChoices):
        MIGRATION = "migration", "Migration"
        CREATED = "created", "Created"
        MANUAL = "manual", "Manual transition"
        PAYMENT = "payment", "Payment reconciliation"
        REVERSAL = "reversal", "Payment reversal"

    id = models.CharField(primary_key=True, max_length=32, default=invoice_status_event_id)
    invoice = models.ForeignKey(Invoice, on_delete=models.PROTECT, related_name="status_events")
    from_step = models.ForeignKey(
        InvoiceStatusStep,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="events_from",
    )
    to_step = models.ForeignKey(
        InvoiceStatusStep,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="events_to",
    )
    from_code = models.CharField(max_length=50, blank=True)
    from_label = models.CharField(max_length=80, blank=True)
    to_code = models.CharField(max_length=50)
    to_label = models.CharField(max_length=80)
    source = models.CharField(max_length=20, choices=Source.choices)
    note = models.TextField(blank=True)
    actor = models.ForeignKey(
        "accounts.User",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="invoice_status_events",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    objects = ImmutableInvoiceStatusEventQuerySet.as_manager()

    class Meta:
        ordering = ("created_at", "id")

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise TypeError("Invoice status events are immutable")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise TypeError("Invoice status events are immutable")


class InvoiceAttachment(models.Model):
    """A private supporting document supplied against an invoice."""

    id = models.CharField(primary_key=True, max_length=32, default=invoice_attachment_id)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.PROTECT, related_name="invoice_attachments"
    )
    invoice = models.ForeignKey(Invoice, on_delete=models.CASCADE, related_name="attachments")
    object_key = models.CharField(max_length=1024, unique=True)
    file_name = models.CharField(max_length=255)
    content_type = models.CharField(max_length=100)
    size = models.PositiveBigIntegerField()
    checksum = models.CharField(max_length=128)
    uploaded_by = models.ForeignKey(
        "accounts.User", on_delete=models.PROTECT, related_name="uploaded_invoice_attachments"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("created_at",)


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
