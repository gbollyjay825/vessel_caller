from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from decimal import Decimal

from django.db.models import Max
from django.utils import timezone
from rest_framework.exceptions import APIException, NotFound, ValidationError

from api.domain import bump_revision, money, next_number
from audit.services import record_event
from billing.models import Invoice, InvoiceStatusEvent
from billing.services import active_default_step, transition_invoice
from organizations.models import OrganizationSettings

from .models import (
    AssessmentLine,
    CargoLine,
    DisparityAssessment,
    MeasurementPlan,
    MeasurementSubmission,
    Participant,
    Reconciliation,
    ReconciliationApproval,
    ReconciliationLine,
    SubmissionLine,
)
from .serializers import (
    approval_data,
    assessment_line_data,
    cargo_line_data,
    evidence_data,
    participant_data,
    plan_context,
    reconciliation_data,
    submission_data,
)


class Conflict(APIException):
    status_code = 409
    default_detail = "The measurement plan changed. Refresh and try again."
    default_code = "conflict"


def get_plan(request, plan_id, lock=False):
    query = MeasurementPlan.objects.select_related("vessel_call", "organization", "created_by")
    if lock:
        query = query.select_for_update(of=("self",))
    plan = query.filter(pk=plan_id, organization_id=request.user.organization_id).first()
    if not plan:
        raise NotFound("Measurement plan not found")
    return plan


def check_version(plan, version):
    if plan.version != version:
        raise Conflict()
    if plan.status == "cancelled":
        raise Conflict("A cancelled measurement plan cannot be changed")


def event(plan, request, action, after=None, before=None):
    record_event(
        organization=plan.organization,
        actor=request.user,
        action=f"measurement.{action}",
        category="measurements",
        target=plan,
        target_label=plan.title,
        request=request,
        before=before,
        after=after,
    )


def changed(plan, request, action, after=None, before=None):
    plan.version += 1
    plan.save(update_fields=("version", "status", "updated_at"))
    revision = bump_revision(plan.organization_id)
    event(plan, request, action, after, before)
    return revision


def validate_evidence(plan, ids, required=False):
    if len(set(ids)) != len(ids):
        raise ValidationError({"evidenceIds": "Duplicate evidence references are not allowed"})
    evidence = list(plan.evidence.filter(pk__in=ids))
    if len(evidence) != len(ids) or (required and not evidence):
        raise ValidationError(
            {"evidenceIds": "Supporting evidence must belong to this measurement plan"}
        )
    return evidence


def participant_for(plan, participant_id):
    participant = plan.participants.filter(pk=participant_id).first()
    if not participant:
        raise ValidationError({"participantId": "Participant does not belong to this plan"})
    return participant


def validate_lines(plan, data):
    lines = {item.pk: item for item in plan.lines.all()}
    supplied = [item["lineId"] for item in data]
    if len(supplied) != len(set(supplied)) or set(supplied) != set(lines):
        raise ValidationError({"lines": "Supply every cargo line in this plan exactly once"})
    for item in data:
        line = lines[item["lineId"]]
        for field in ("quantity", "previouslyBilledQuantity", "tolerance"):
            value = item.get(field)
            if value is not None and line.unit == "count" and value != value.to_integral_value():
                raise ValidationError(
                    {"lines": f"{line.description}: {field} must be a whole count"}
                )
    return lines


def create_structure(plan, data):
    for item in data.get("participants", []):
        Participant.objects.create(
            plan=plan,
            name=item["name"],
            role=item["role"],
            representative=item["representative"],
            required_submission=item["requiredSubmission"],
            required_approval=item["requiredApproval"],
        )
    for position, item in enumerate(data.get("lines", [])):
        CargoLine.objects.create(
            plan=plan,
            position=position,
            description=item["description"],
            category=item["category"],
            direction=item["direction"],
            container_size=item["containerSize"],
            load_status=item["loadStatus"],
            unit=item["unit"],
            basis=item["basis"],
            manifest_quantity=item["manifestQuantity"],
            baseline_reference=item["baselineReference"],
        )


def latest_submissions(plan):
    latest = {}
    for item in plan.submissions.order_by("revision", "recorded_at"):
        latest[item.participant_id] = item
    return [latest[key] for key in sorted(latest)]


def source_fingerprint(plan, submissions=None):
    if submissions is None:
        submissions = latest_submissions(plan)
    source = {
        "submissions": sorted(item.pk for item in submissions),
        "lines": [cargo_line_data(item) for item in plan.lines.all()],
        "participants": [participant_data(item) for item in plan.participants.all()],
    }
    return hashlib.sha256(
        json.dumps(source, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def get_reconciliation(plan, rid):
    reconciliation = plan.reconciliations.filter(pk=rid).first()
    if not reconciliation:
        raise NotFound("Reconciliation not found")
    return reconciliation


def ensure_current_draft(plan, reconciliation):
    if reconciliation.status != "draft":
        raise Conflict("Only a current draft reconciliation can be approved")
    if reconciliation != plan.reconciliations.order_by("-revision").first():
        raise Conflict("A newer reconciliation exists")
    if reconciliation.input_fingerprint != source_fingerprint(plan):
        raise Conflict("Stakeholder returns changed. Create a new proposal before approval")


def ensure_billable_final(plan, reconciliation):
    latest = plan.reconciliations.order_by("-revision").first()
    if reconciliation.status != "final" or latest != reconciliation:
        raise Conflict("Billing requires the latest final reconciliation with no newer draft")


def create_submission(plan, data, request):
    check_version(plan, data["version"])
    latest_reconciliation = plan.reconciliations.order_by("-revision").first()
    if latest_reconciliation and latest_reconciliation.status == "final":
        raise Conflict("Create an amendment proposal before recording revised returns")
    participant = participant_for(plan, data["participantId"])
    previous = participant.submissions.order_by("-revision").first()
    if previous and not data["reason"]:
        raise ValidationError({"reason": "A revision reason is required"})
    validate_lines(plan, data["lines"])
    evidence = validate_evidence(plan, data["evidenceIds"], required=True)
    submission = MeasurementSubmission.objects.create(
        plan=plan,
        participant=participant,
        revision=previous.revision + 1 if previous else 1,
        observed_at=data["observedAt"],
        source_reference=data["sourceReference"],
        notes=data["notes"],
        reason=data["reason"],
        recorded_by=request.user,
    )
    submission.evidence.set(evidence)
    for item in data["lines"]:
        SubmissionLine.objects.create(
            submission=submission,
            line_id=item["lineId"],
            status=item["status"],
            quantity=item["quantity"],
            note=item["note"],
        )
    plan.status = "in-progress"
    return changed(plan, request, "submission_recorded", submission_data(submission))


def create_reconciliation(plan, data, request):
    check_version(plan, data["version"])
    lines = validate_lines(plan, data["lines"])
    evidence = validate_evidence(plan, data["evidenceIds"])
    submissions = latest_submissions(plan)
    submitted = {item.participant_id for item in submissions}
    missing = [
        p.name for p in plan.participants.all() if p.required_submission and p.pk not in submitted
    ]
    if missing:
        raise ValidationError(
            {"submissions": f"Required stakeholder returns missing: {', '.join(missing)}"}
        )
    if not submissions:
        raise ValidationError(
            {"submissions": "Record at least one stakeholder return before reconciliation"}
        )
    revision = (plan.reconciliations.aggregate(value=Max("revision"))["value"] or 0) + 1
    for old in plan.reconciliations.filter(status="draft"):
        old.status = "superseded"
        old.save(update_fields=("status",))
    reconciliation = Reconciliation.objects.create(
        plan=plan,
        revision=revision,
        reason=data["reason"],
        created_by=request.user,
        input_fingerprint=source_fingerprint(plan, submissions),
    )
    reconciliation.submissions.set(submissions)
    reconciliation.evidence.set(evidence)
    for item in data["lines"]:
        line = lines[item["lineId"]]
        ReconciliationLine.objects.create(
            reconciliation=reconciliation,
            line=line,
            quantity=item["quantity"],
            manifest_quantity=line.manifest_quantity,
            variance=item["quantity"] - line.manifest_quantity
            if line.manifest_quantity is not None
            else None,
            reason=item["reason"],
        )
    reconciliation.snapshot = {
        "plan": plan_context(plan),
        "participants": [participant_data(p) for p in plan.participants.all()],
        "lines": [cargo_line_data(line) for line in plan.lines.all()],
        "submissions": [submission_data(item) for item in submissions],
    }
    reconciliation.save(update_fields=("snapshot",))
    plan.status = "in-progress"
    return changed(plan, request, "reconciliation_proposed", reconciliation_data(reconciliation))


def create_approval(plan, reconciliation, data, request):
    check_version(plan, data["version"])
    ensure_current_draft(plan, reconciliation)
    participant = participant_for(plan, data["participantId"])
    evidence = validate_evidence(plan, data["evidenceIds"], required=True)
    approval = ReconciliationApproval.objects.create(
        reconciliation=reconciliation,
        participant=participant,
        decision=data["decision"],
        representative=data["representative"],
        reference=data["reference"],
        input_fingerprint=reconciliation.input_fingerprint,
        recorded_by=request.user,
    )
    approval.evidence.set(evidence)
    return changed(plan, request, "paper_acknowledgement_recorded", approval_data(approval))


def finalize_reconciliation(plan, reconciliation, data, request):
    if reconciliation.finalized_at:
        return plan.organization.revision
    check_version(plan, data["version"])
    ensure_current_draft(plan, reconciliation)
    if reconciliation.created_by_id == request.user.pk:
        raise ValidationError(
            "Final approval requires an Admin other than the reconciliation preparer"
        )
    latest_approvals = {}
    for approval in reconciliation.approvals.all():
        latest_approvals[approval.participant_id] = approval
    if any(a.decision == "disputed" for a in latest_approvals.values()):
        raise ValidationError("Resolve all recorded stakeholder disputes before final approval")
    for participant in plan.participants.all():
        approval = latest_approvals.get(participant.pk)
        if participant.required_approval and (not approval or approval.decision != "agreed"):
            raise ValidationError(f"An agreed acknowledgement is required from {participant.name}")
    for approval in latest_approvals.values():
        if (
            approval.input_fingerprint != reconciliation.input_fingerprint
            or not approval.evidence.exists()
        ):
            raise Conflict("Supporting acknowledgement evidence is missing or stale")
    for submission in reconciliation.submissions.all():
        if not submission.evidence.exists():
            raise ValidationError("Every stakeholder return requires supporting evidence")
    for previous in plan.reconciliations.filter(status="final"):
        previous.status = "superseded"
        previous.save(update_fields=("status",))
    reconciliation.status = "final"
    reconciliation.finalized_by = request.user
    reconciliation.finalized_at = timezone.now()
    used_ids = set(reconciliation.evidence.values_list("pk", flat=True))
    for submission in reconciliation.submissions.all():
        used_ids.update(submission.evidence.values_list("pk", flat=True))
    for approval in reconciliation.approvals.all():
        used_ids.update(approval.evidence.values_list("pk", flat=True))
    plan.status = "reconciled"
    reconciliation.snapshot = {
        **reconciliation.snapshot,
        "plan": plan_context(plan),
        "reconciliation": reconciliation_data(reconciliation, include_snapshot=False),
        "approvals": [approval_data(a) for a in reconciliation.approvals.all()],
        "evidence": [evidence_data(e) for e in plan.evidence.filter(pk__in=used_ids)],
        "inputFingerprint": reconciliation.input_fingerprint,
    }
    reconciliation.save(update_fields=("status", "finalized_by", "finalized_at", "snapshot"))
    plan.status = "reconciled"
    return changed(plan, request, "reconciliation_finalized", reconciliation.snapshot)


def prior_invoiced(plan):
    prior = {line.pk: Decimal(0) for line in plan.lines.all()}
    for invoice in Invoice.objects.filter(assessment__plan=plan, purpose="disparity").exclude(
        status=Invoice.Status.VOID
    ):
        for item in invoice.line_items:
            if item["lineId"] in prior:
                prior[item["lineId"]] += Decimal(item["amount"])
    return prior


def create_assessment(plan, data, request):
    check_version(plan, data["version"])
    reconciliation = get_reconciliation(plan, data["reconciliationId"])
    ensure_billable_final(plan, reconciliation)
    lines = validate_lines(plan, data["lines"])
    reconciled = {item.line_id: item for item in reconciliation.lines.all()}
    prior = prior_invoiced(plan)
    calculations = []
    config_lines = []
    held = False
    for item in data["lines"]:
        line = lines[item["lineId"]]
        final = reconciled[line.pk]
        baseline = (
            final.manifest_quantity
            if data["policy"] == "manifest-disparity"
            else item["previouslyBilledQuantity"]
        )
        if baseline is None:
            raise ValidationError(
                {
                    "lines": f"{line.description}: this policy requires a known billing baseline; missing is not zero"
                }
            )
        variance = final.quantity - baseline
        chargeable = Decimal(0)
        if variance > item["tolerance"]:
            chargeable = (
                variance if item["toleranceMode"] == "threshold" else variance - item["tolerance"]
            )
        entitlement = money(chargeable * item["rate"])
        amount = entitlement - item["openingBilledAmount"] - prior[line.pk]
        if abs(entitlement) >= Decimal("10000000000000000") or abs(amount) >= Decimal(
            "10000000000000000"
        ):
            raise ValidationError(
                {"lines": "Calculated charge exceeds the supported monetary range"}
            )
        held = held or variance < 0 or amount < 0
        calculations.append(
            dict(
                line=line,
                description=line.description,
                unit=line.unit,
                baseline_quantity=baseline,
                final_quantity=final.quantity,
                variance=variance,
                rate=item["rate"],
                tolerance=item["tolerance"],
                tolerance_mode=item["toleranceMode"],
                chargeable_quantity=chargeable,
                entitlement=entitlement,
                opening_billed_amount=item["openingBilledAmount"],
                prior_invoiced_amount=prior[line.pk],
                amount=amount,
            )
        )
        config_lines.append(
            {
                "lineId": line.pk,
                "baseline": str(baseline),
                "rate": str(item["rate"]),
                "tolerance": str(item["tolerance"]),
                "toleranceMode": item["toleranceMode"],
                "openingBilledAmount": str(item["openingBilledAmount"]),
            }
        )
    configuration = {
        "payer": data["payer"],
        "currency": data["currency"],
        "policy": data["policy"],
        "tariffReference": data["tariffReference"],
        "openingChargesReference": data["openingChargesReference"],
        "lines": sorted(config_lines, key=lambda item: item["lineId"]),
    }
    issued = plan.assessments.filter(invoice__isnull=False).first()
    if issued and configuration != issued.configuration:
        raise Conflict(
            "The billing configuration is locked after issuance; amendments must carry forward the same baseline, rate, tolerance, payer and opening position"
        )
    total = money(sum((item["amount"] for item in calculations), Decimal(0)))
    if abs(total) >= Decimal("10000000000000000"):
        raise ValidationError("Total exceeds the supported monetary range")
    assessment = DisparityAssessment.objects.create(
        plan=plan,
        reconciliation=reconciliation,
        payer=data["payer"],
        currency=data["currency"],
        policy=data["policy"],
        tariff_reference=data["tariffReference"],
        opening_charges_reference=data["openingChargesReference"],
        reason=data["reason"],
        status="held" if held else "ready" if total > 0 else "no-charge",
        total=total,
        configuration=configuration,
        created_by=request.user,
    )
    for item in calculations:
        AssessmentLine.objects.create(assessment=assessment, **item)
    return changed(
        plan,
        request,
        "disparity_assessed",
        {
            "assessmentId": assessment.pk,
            "status": assessment.status,
            "total": str(total),
            "configuration": configuration,
        },
    )


def issue_assessment(plan, assessment_id, data, request):
    assessment = plan.assessments.filter(pk=assessment_id).first()
    if not assessment:
        raise NotFound("Assessment not found")
    existing = Invoice.objects.filter(assessment=assessment).first()
    if existing:
        return plan.organization.revision, existing
    check_version(plan, data["version"])
    ensure_billable_final(plan, assessment.reconciliation)
    if assessment != plan.assessments.order_by("-created_at", "-id").first():
        raise Conflict("A newer assessment exists; review the latest assessment")
    if assessment.status != "ready" or assessment.total <= 0:
        raise Conflict(
            "Only a positive ready assessment can be invoiced; held assessments require credit review"
        )
    prior = prior_invoiced(plan)
    if any(prior[line.line_id] != line.prior_invoiced_amount for line in assessment.lines.all()):
        raise Conflict("Prior invoice amounts changed. Create a new assessment")
    settings = OrganizationSettings.objects.select_for_update().get(
        organization_id=plan.organization_id
    )
    now = timezone.localdate()
    invoice = Invoice.objects.create(
        organization_id=plan.organization_id,
        vessel_call_id=plan.vessel_call_id,
        inspection=None,
        purpose="disparity",
        reconciliation=assessment.reconciliation,
        assessment=assessment,
        payer=assessment.payer,
        currency=assessment.currency,
        line_items=[assessment_line_data(line) for line in assessment.lines.all()],
        invoice_no=next_number(plan.organization, "invoice", "INV"),
        cargo_type="Disparity",
        issued_on=now,
        due_on=now + timedelta(days=14),
        dues=assessment.total,
        rate=0,
        commission_usd=0,
        commission_ngn=0,
        exchange_rate=settings.exchange_rate,
    )
    transition_invoice(
        invoice,
        active_default_step(plan.organization_id),
        source=InvoiceStatusEvent.Source.CREATED,
        actor=request.user,
    )
    assessment.status = "issued"
    assessment.save(update_fields=("status",))
    revision = changed(
        plan,
        request,
        "disparity_invoiced",
        {"assessmentId": assessment.pk, "invoiceId": invoice.pk, "total": str(invoice.dues)},
    )
    return revision, invoice
