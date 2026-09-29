from __future__ import annotations

import uuid

from django.db import models


def measurement_id():
    return uuid.uuid4().hex


class ImmutableQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise TypeError("Measurement source records cannot be bulk-updated")

    def delete(self):
        raise TypeError("Measurement history cannot be deleted")


class ImmutableRecord(models.Model):
    """Source records and financial calculations are append-only."""

    objects = ImmutableQuerySet.as_manager()

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise TypeError(f"{type(self).__name__} is immutable; create a new revision")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise TypeError(f"{type(self).__name__} is immutable")


class MeasurementPlan(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=measurement_id)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.PROTECT, related_name="measurement_plans"
    )
    vessel_call = models.ForeignKey(
        "operations.VesselCall", on_delete=models.PROTECT, related_name="measurement_plans"
    )
    title = models.CharField(max_length=255)
    scheduled_at = models.DateTimeField()
    ends_at = models.DateTimeField(null=True, blank=True)
    location = models.CharField(max_length=255, blank=True)
    method = models.CharField(max_length=100)
    stage = models.CharField(max_length=100)
    scope = models.TextField()
    lead_surveyor = models.CharField(max_length=255)
    notes = models.TextField(blank=True)
    status = models.CharField(
        max_length=20,
        default="scheduled",
        choices=[(s, s) for s in ("scheduled", "in-progress", "reconciled", "cancelled")],
    )
    cancellation_reason = models.TextField(blank=True)
    version = models.PositiveIntegerField(default=1)
    created_by = models.ForeignKey(
        "accounts.User", on_delete=models.PROTECT, related_name="created_measurement_plans"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-scheduled_at", "id")


class Participant(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=measurement_id)
    plan = models.ForeignKey(MeasurementPlan, on_delete=models.CASCADE, related_name="participants")
    name = models.CharField(max_length=255)
    role = models.CharField(max_length=100)
    representative = models.CharField(max_length=255, blank=True)
    required_submission = models.BooleanField(default=True)
    required_approval = models.BooleanField(default=True)

    class Meta:
        ordering = ("pk",)


class CargoLine(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=measurement_id)
    plan = models.ForeignKey(MeasurementPlan, on_delete=models.CASCADE, related_name="lines")
    position = models.PositiveIntegerField(default=0)
    description = models.CharField(max_length=255)
    category = models.CharField(max_length=100)
    direction = models.CharField(max_length=100)
    container_size = models.CharField(max_length=20, blank=True)
    load_status = models.CharField(max_length=50, blank=True)
    unit = models.CharField(max_length=20, choices=[(s, s) for s in ("tonnes", "count", "m3")])
    basis = models.CharField(max_length=255)
    manifest_quantity = models.DecimalField(max_digits=18, decimal_places=3, null=True, blank=True)
    baseline_reference = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ("position", "id")
        constraints = [
            models.CheckConstraint(
                condition=models.Q(manifest_quantity__gte=0)
                | models.Q(manifest_quantity__isnull=True),
                name="measurement_manifest_nonnegative",
            )
        ]


class MeasurementEvidence(ImmutableRecord):
    id = models.CharField(primary_key=True, max_length=32, default=measurement_id)
    plan = models.ForeignKey(MeasurementPlan, on_delete=models.PROTECT, related_name="evidence")
    object_key = models.CharField(max_length=1024, unique=True)
    file_name = models.CharField(max_length=255)
    content_type = models.CharField(max_length=100)
    size = models.PositiveBigIntegerField()
    checksum = models.CharField(max_length=128)
    uploaded_by = models.ForeignKey(
        "accounts.User", on_delete=models.PROTECT, related_name="measurement_evidence_uploads"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("created_at", "id")


class MeasurementSubmission(ImmutableRecord):
    id = models.CharField(primary_key=True, max_length=32, default=measurement_id)
    plan = models.ForeignKey(MeasurementPlan, on_delete=models.PROTECT, related_name="submissions")
    participant = models.ForeignKey(
        Participant, on_delete=models.PROTECT, related_name="submissions"
    )
    revision = models.PositiveIntegerField()
    observed_at = models.DateTimeField()
    source_reference = models.CharField(max_length=255)
    notes = models.TextField(blank=True)
    reason = models.TextField(blank=True)
    recorded_by = models.ForeignKey(
        "accounts.User", on_delete=models.PROTECT, related_name="measurement_submissions"
    )
    recorded_at = models.DateTimeField(auto_now_add=True)
    evidence = models.ManyToManyField(MeasurementEvidence, related_name="submissions")

    class Meta:
        ordering = ("recorded_at", "id")
        constraints = [
            models.UniqueConstraint(
                fields=("participant", "revision"), name="measurement_unique_submission_revision"
            )
        ]


class SubmissionLine(ImmutableRecord):
    submission = models.ForeignKey(
        MeasurementSubmission, on_delete=models.PROTECT, related_name="lines"
    )
    line = models.ForeignKey(CargoLine, on_delete=models.PROTECT)
    status = models.CharField(
        max_length=20, choices=[("reported", "reported"), ("not-applicable", "not-applicable")]
    )
    quantity = models.DecimalField(max_digits=18, decimal_places=3, null=True, blank=True)
    note = models.TextField(blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=("submission", "line"), name="measurement_unique_return_line"
            ),
            models.CheckConstraint(
                condition=models.Q(status="reported", quantity__gte=0, quantity__isnull=False)
                | models.Q(status="not-applicable", quantity__isnull=True),
                name="measurement_valid_return_quantity",
            ),
        ]


class Reconciliation(models.Model):
    objects = ImmutableQuerySet.as_manager()
    id = models.CharField(primary_key=True, max_length=32, default=measurement_id)
    plan = models.ForeignKey(
        MeasurementPlan, on_delete=models.PROTECT, related_name="reconciliations"
    )
    revision = models.PositiveIntegerField()
    status = models.CharField(
        max_length=20, default="draft", choices=[(s, s) for s in ("draft", "final", "superseded")]
    )
    reason = models.TextField()
    created_by = models.ForeignKey(
        "accounts.User", on_delete=models.PROTECT, related_name="prepared_reconciliations"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    finalized_by = models.ForeignKey(
        "accounts.User",
        on_delete=models.PROTECT,
        null=True,
        related_name="finalized_reconciliations",
    )
    finalized_at = models.DateTimeField(null=True)
    submissions = models.ManyToManyField(MeasurementSubmission, related_name="reconciliations")
    evidence = models.ManyToManyField(MeasurementEvidence, related_name="reconciliations")
    input_fingerprint = models.CharField(max_length=64)
    snapshot = models.JSONField(default=dict)

    class Meta:
        ordering = ("revision",)
        constraints = [
            models.UniqueConstraint(
                fields=("plan", "revision"), name="measurement_unique_reconciliation_revision"
            )
        ]

    def save(self, *args, **kwargs):
        if not self._state.adding:
            previous = type(self).objects.get(pk=self.pk)
            if not previous.finalized_at and set(kwargs.get("update_fields") or ()) not in (
                {"status"},
                {"snapshot"},
                {"status", "finalized_by", "finalized_at", "snapshot"},
            ):
                raise TypeError("Reconciliation inputs are immutable; create a new proposal")
            if previous.finalized_at and (
                set(kwargs.get("update_fields") or ()) != {"status"} or self.status != "superseded"
            ):
                raise TypeError("Final reconciliations are immutable")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise TypeError("Reconciliation history cannot be deleted")


class ReconciliationLine(ImmutableRecord):
    reconciliation = models.ForeignKey(
        Reconciliation, on_delete=models.PROTECT, related_name="lines"
    )
    line = models.ForeignKey(CargoLine, on_delete=models.PROTECT)
    quantity = models.DecimalField(max_digits=18, decimal_places=3)
    manifest_quantity = models.DecimalField(max_digits=18, decimal_places=3, null=True)
    variance = models.DecimalField(max_digits=19, decimal_places=3, null=True)
    reason = models.TextField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=("reconciliation", "line"), name="measurement_unique_reconciled_line"
            ),
            models.CheckConstraint(
                condition=models.Q(quantity__gte=0), name="measurement_final_nonnegative"
            ),
        ]


class ReconciliationApproval(ImmutableRecord):
    id = models.CharField(primary_key=True, max_length=32, default=measurement_id)
    reconciliation = models.ForeignKey(
        Reconciliation, on_delete=models.PROTECT, related_name="approvals"
    )
    participant = models.ForeignKey(Participant, on_delete=models.PROTECT)
    decision = models.CharField(
        max_length=20, choices=[("agreed", "agreed"), ("disputed", "disputed")]
    )
    representative = models.CharField(max_length=255)
    reference = models.CharField(max_length=255)
    evidence = models.ManyToManyField(MeasurementEvidence, related_name="approvals")
    input_fingerprint = models.CharField(max_length=64)
    recorded_by = models.ForeignKey(
        "accounts.User", on_delete=models.PROTECT, related_name="recorded_reconciliation_approvals"
    )
    recorded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("recorded_at", "id")


class DisparityAssessment(models.Model):
    objects = ImmutableQuerySet.as_manager()
    id = models.CharField(primary_key=True, max_length=32, default=measurement_id)
    plan = models.ForeignKey(MeasurementPlan, on_delete=models.PROTECT, related_name="assessments")
    reconciliation = models.ForeignKey(
        Reconciliation, on_delete=models.PROTECT, related_name="assessments"
    )
    payer = models.CharField(max_length=255)
    currency = models.CharField(max_length=3, default="USD")
    policy = models.CharField(
        max_length=30,
        choices=[
            ("manifest-disparity", "manifest-disparity"),
            ("quantity-adjustment", "quantity-adjustment"),
        ],
    )
    tariff_reference = models.CharField(max_length=255)
    opening_charges_reference = models.CharField(max_length=255)
    reason = models.TextField()
    status = models.CharField(
        max_length=20, choices=[(s, s) for s in ("ready", "no-charge", "held", "issued")]
    )
    total = models.DecimalField(max_digits=18, decimal_places=2)
    configuration = models.JSONField(default=dict)
    created_by = models.ForeignKey(
        "accounts.User", on_delete=models.PROTECT, related_name="disparity_assessments"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("created_at", "id")

    def save(self, *args, **kwargs):
        if not self._state.adding and (
            set(kwargs.get("update_fields") or ()) != {"status"} or self.status != "issued"
        ):
            raise TypeError("Assessments are immutable; create a new assessment")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise TypeError("Assessments cannot be deleted")


class AssessmentLine(ImmutableRecord):
    assessment = models.ForeignKey(
        DisparityAssessment, on_delete=models.PROTECT, related_name="lines"
    )
    line = models.ForeignKey(CargoLine, on_delete=models.PROTECT)
    description = models.CharField(max_length=255)
    unit = models.CharField(max_length=20)
    baseline_quantity = models.DecimalField(max_digits=18, decimal_places=3)
    final_quantity = models.DecimalField(max_digits=18, decimal_places=3)
    variance = models.DecimalField(max_digits=19, decimal_places=3)
    rate = models.DecimalField(max_digits=12, decimal_places=4)
    tolerance = models.DecimalField(max_digits=18, decimal_places=3)
    tolerance_mode = models.CharField(max_length=20)
    chargeable_quantity = models.DecimalField(max_digits=18, decimal_places=3)
    entitlement = models.DecimalField(max_digits=18, decimal_places=2)
    opening_billed_amount = models.DecimalField(max_digits=18, decimal_places=2)
    prior_invoiced_amount = models.DecimalField(max_digits=18, decimal_places=2)
    amount = models.DecimalField(max_digits=18, decimal_places=2)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=("assessment", "line"), name="measurement_unique_assessed_line"
            )
        ]
