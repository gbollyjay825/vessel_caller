from __future__ import annotations

from decimal import Decimal

from rest_framework import serializers


class ParticipantSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255)
    role = serializers.CharField(max_length=100)
    representative = serializers.CharField(max_length=255, allow_blank=True, default="")
    requiredSubmission = serializers.BooleanField(default=True)
    requiredApproval = serializers.BooleanField(default=True)


class CargoLineSerializer(serializers.Serializer):
    description = serializers.CharField(max_length=255)
    category = serializers.CharField(max_length=100)
    direction = serializers.CharField(max_length=100)
    containerSize = serializers.CharField(max_length=20, allow_blank=True, default="")
    loadStatus = serializers.CharField(max_length=50, allow_blank=True, default="")
    unit = serializers.ChoiceField(choices=["tonnes", "count", "m3"])
    basis = serializers.CharField(max_length=255)
    manifestQuantity = serializers.DecimalField(
        max_digits=18, decimal_places=3, min_value=Decimal(0), allow_null=True, default=None
    )
    baselineReference = serializers.CharField(max_length=255, allow_blank=True, default="")

    def validate(self, attrs):
        quantity = attrs.get("manifestQuantity")
        if quantity is not None:
            if attrs["unit"] == "count" and quantity != quantity.to_integral_value():
                raise serializers.ValidationError("Counts must be whole numbers")
            if not attrs.get("baselineReference"):
                raise serializers.ValidationError(
                    "A known manifest quantity needs its source reference"
                )
        return attrs


class PlanSerializer(serializers.Serializer):
    callId = serializers.CharField(max_length=32)
    title = serializers.CharField(max_length=255)
    scheduledAt = serializers.DateTimeField()
    endsAt = serializers.DateTimeField(allow_null=True, default=None)
    location = serializers.CharField(max_length=255, allow_blank=True, default="")
    method = serializers.CharField(max_length=100)
    stage = serializers.CharField(max_length=100)
    scope = serializers.CharField(max_length=5000)
    leadSurveyor = serializers.CharField(max_length=255)
    notes = serializers.CharField(max_length=10000, allow_blank=True, default="")
    participants = ParticipantSerializer(many=True, allow_empty=False)
    lines = CargoLineSerializer(many=True, allow_empty=False)

    def validate(self, attrs):
        if attrs.get("endsAt") and attrs["endsAt"] < attrs["scheduledAt"]:
            raise serializers.ValidationError("End time cannot precede start time")
        if len(attrs["participants"]) > 30 or len(attrs["lines"]) > 100:
            raise serializers.ValidationError(
                "Maximum 30 participants and 100 cargo lines per plan"
            )
        return attrs


class VersionSerializer(serializers.Serializer):
    version = serializers.IntegerField(min_value=1)


class PlanPatchSerializer(VersionSerializer):
    title = serializers.CharField(max_length=255, required=False)
    scheduledAt = serializers.DateTimeField(required=False)
    endsAt = serializers.DateTimeField(allow_null=True, required=False)
    location = serializers.CharField(max_length=255, allow_blank=True, required=False)
    leadSurveyor = serializers.CharField(max_length=255, required=False)
    notes = serializers.CharField(max_length=10000, allow_blank=True, required=False)
    status = serializers.ChoiceField(choices=["cancelled"], required=False)
    reason = serializers.CharField(max_length=10000, required=False)
    participants = ParticipantSerializer(many=True, allow_empty=False, required=False)
    lines = CargoLineSerializer(many=True, allow_empty=False, required=False)


class EvidenceReferencesSerializer(VersionSerializer):
    evidenceIds = serializers.ListField(
        child=serializers.CharField(max_length=32), allow_empty=False, max_length=30
    )


class SubmissionLineSerializer(serializers.Serializer):
    lineId = serializers.CharField(max_length=32)
    status = serializers.ChoiceField(choices=["reported", "not-applicable"])
    quantity = serializers.DecimalField(
        max_digits=18, decimal_places=3, min_value=Decimal(0), allow_null=True
    )
    note = serializers.CharField(max_length=5000, allow_blank=True, default="")

    def validate(self, attrs):
        if attrs["status"] == "reported" and attrs["quantity"] is None:
            raise serializers.ValidationError("A reported line requires an explicit quantity")
        if attrs["status"] == "not-applicable" and (
            attrs["quantity"] is not None or not attrs["note"]
        ):
            raise serializers.ValidationError("Not applicable lines require a note and no quantity")
        return attrs


class SubmissionSerializer(EvidenceReferencesSerializer):
    participantId = serializers.CharField(max_length=32)
    observedAt = serializers.DateTimeField()
    sourceReference = serializers.CharField(max_length=255)
    notes = serializers.CharField(max_length=10000, allow_blank=True, default="")
    reason = serializers.CharField(max_length=10000, allow_blank=True, default="")
    lines = SubmissionLineSerializer(many=True, allow_empty=False)


class ReconciledLineSerializer(serializers.Serializer):
    lineId = serializers.CharField(max_length=32)
    quantity = serializers.DecimalField(max_digits=18, decimal_places=3, min_value=Decimal(0))
    reason = serializers.CharField(max_length=10000)


class ReconciliationSerializer(VersionSerializer):
    reason = serializers.CharField(max_length=10000)
    lines = ReconciledLineSerializer(many=True, allow_empty=False)
    evidenceIds = serializers.ListField(
        child=serializers.CharField(max_length=32), max_length=30, default=list
    )


class ApprovalSerializer(EvidenceReferencesSerializer):
    participantId = serializers.CharField(max_length=32)
    decision = serializers.ChoiceField(choices=["agreed", "disputed"])
    representative = serializers.CharField(max_length=255)
    reference = serializers.CharField(max_length=255)


class AssessmentLineSerializer(serializers.Serializer):
    lineId = serializers.CharField(max_length=32)
    rate = serializers.DecimalField(max_digits=12, decimal_places=4, min_value=Decimal(0))
    tolerance = serializers.DecimalField(max_digits=18, decimal_places=3, min_value=Decimal(0))
    toleranceMode = serializers.ChoiceField(choices=["threshold", "deductible"])
    previouslyBilledQuantity = serializers.DecimalField(
        max_digits=18, decimal_places=3, min_value=Decimal(0), allow_null=True, default=None
    )
    openingBilledAmount = serializers.DecimalField(
        max_digits=18, decimal_places=2, min_value=Decimal(0)
    )


class AssessmentSerializer(VersionSerializer):
    reconciliationId = serializers.CharField(max_length=32)
    payer = serializers.CharField(max_length=255)
    currency = serializers.ChoiceField(choices=["USD"])
    policy = serializers.ChoiceField(choices=["manifest-disparity", "quantity-adjustment"])
    tariffReference = serializers.CharField(max_length=255)
    reason = serializers.CharField(max_length=10000)
    openingChargesReference = serializers.CharField(max_length=255)
    lines = AssessmentLineSerializer(many=True, allow_empty=False)


def decimal_string(value):
    return format(value, "f") if value is not None else None


def date_string(value):
    return value.isoformat() if value else None


def actor_data(user):
    return {"id": user.pk, "name": user.name} if user else None


def evidence_data(item):
    return {
        "id": item.pk,
        "fileName": item.file_name,
        "contentType": item.content_type,
        "size": item.size,
        "checksum": item.checksum,
        "createdAt": date_string(item.created_at),
    }


def participant_data(item):
    return {
        "id": item.pk,
        "name": item.name,
        "role": item.role,
        "representative": item.representative,
        "requiredSubmission": item.required_submission,
        "requiredApproval": item.required_approval,
    }


def cargo_line_data(item):
    return {
        "id": item.pk,
        "description": item.description,
        "category": item.category,
        "direction": item.direction,
        "containerSize": item.container_size,
        "loadStatus": item.load_status,
        "unit": item.unit,
        "basis": item.basis,
        "manifestQuantity": decimal_string(item.manifest_quantity),
        "baselineReference": item.baseline_reference,
    }


def submission_data(item):
    return {
        "id": item.pk,
        "participantId": item.participant_id,
        "revision": item.revision,
        "observedAt": date_string(item.observed_at),
        "sourceReference": item.source_reference,
        "notes": item.notes,
        "reason": item.reason,
        "recordedBy": actor_data(item.recorded_by),
        "recordedAt": date_string(item.recorded_at),
        "lines": [
            {
                "lineId": line.line_id,
                "status": line.status,
                "quantity": decimal_string(line.quantity),
                "note": line.note,
            }
            for line in item.lines.all()
        ],
        "evidenceIds": [e.pk for e in item.evidence.all()],
    }


def approval_data(item):
    return {
        "id": item.pk,
        "participantId": item.participant_id,
        "decision": item.decision,
        "representative": item.representative,
        "reference": item.reference,
        "evidenceIds": [e.pk for e in item.evidence.all()],
        "recordedBy": actor_data(item.recorded_by),
        "recordedAt": date_string(item.recorded_at),
    }


def reconciliation_data(item, include_snapshot=True):
    result = {
        "id": item.pk,
        "revision": item.revision,
        "status": item.status,
        "reason": item.reason,
        "createdBy": actor_data(item.created_by),
        "createdAt": date_string(item.created_at),
        "finalizedBy": actor_data(item.finalized_by),
        "finalizedAt": date_string(item.finalized_at),
        "lines": [
            {
                "lineId": line.line_id,
                "quantity": decimal_string(line.quantity),
                "manifestQuantity": decimal_string(line.manifest_quantity),
                "variance": decimal_string(line.variance),
                "reason": line.reason,
            }
            for line in item.lines.all()
        ],
        "submissionIds": [s.pk for s in item.submissions.all()],
        "evidenceIds": [e.pk for e in item.evidence.all()],
        "approvals": [approval_data(a) for a in item.approvals.all()],
    }
    if include_snapshot:
        result["snapshot"] = item.snapshot
    return result


def assessment_line_data(item):
    result = {
        "lineId": item.line_id,
        "description": item.description,
        "unit": item.unit,
        "toleranceMode": item.tolerance_mode,
    }
    for key, field in [
        ("baselineQuantity", "baseline_quantity"),
        ("finalQuantity", "final_quantity"),
        ("variance", "variance"),
        ("rate", "rate"),
        ("tolerance", "tolerance"),
        ("chargeableQuantity", "chargeable_quantity"),
        ("entitlement", "entitlement"),
        ("openingBilledAmount", "opening_billed_amount"),
        ("priorInvoicedAmount", "prior_invoiced_amount"),
        ("amount", "amount"),
    ]:
        result[key] = decimal_string(getattr(item, field))
    return result


def assessment_data(item, *, superseded=False):
    invoice = getattr(item, "invoice", None)
    return {
        "id": item.pk,
        "reconciliationId": item.reconciliation_id,
        "payer": item.payer,
        "currency": item.currency,
        "policy": item.policy,
        "tariffReference": item.tariff_reference,
        "openingChargesReference": item.opening_charges_reference,
        "reason": item.reason,
        "status": item.status,
        "total": decimal_string(item.total),
        "lines": [assessment_line_data(line) for line in item.lines.all()],
        "invoiceId": invoice.pk if invoice else None,
        "superseded": bool(superseded and not invoice),
        "createdAt": date_string(item.created_at),
    }


def plan_context(plan):
    return {
        "id": plan.pk,
        "callId": plan.vessel_call_id,
        "vesselName": plan.vessel_call.vessel_name,
        "callReference": plan.vessel_call.reference,
        "title": plan.title,
        "scheduledAt": date_string(plan.scheduled_at),
        "endsAt": date_string(plan.ends_at),
        "location": plan.location,
        "method": plan.method,
        "stage": plan.stage,
        "scope": plan.scope,
        "leadSurveyor": plan.lead_surveyor,
        "notes": plan.notes,
        "status": plan.status,
        "cancellationReason": plan.cancellation_reason,
        "version": plan.version,
        "createdBy": actor_data(plan.created_by),
        "createdAt": date_string(plan.created_at),
    }


def plan_data(plan):
    reconciliations = list(plan.reconciliations.all())
    assessments = list(plan.assessments.all())
    latest_reconciliation = reconciliations[-1].pk if reconciliations else None
    latest_assessment = assessments[-1].pk if assessments else None
    return {
        **plan_context(plan),
        "participants": [participant_data(item) for item in plan.participants.all()],
        "lines": [cargo_line_data(item) for item in plan.lines.all()],
        "submissions": [submission_data(item) for item in plan.submissions.all()],
        "reconciliations": [reconciliation_data(item) for item in reconciliations],
        "assessments": [
            assessment_data(
                item,
                superseded=item.pk != latest_assessment
                or item.reconciliation_id != latest_reconciliation,
            )
            for item in assessments
        ],
        "evidence": [evidence_data(item) for item in plan.evidence.all()],
    }
