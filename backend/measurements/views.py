from __future__ import annotations

from django.db import transaction
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from api.tenant_lifecycle import TenantLifecycleAPIView as APIView

from api.domain import bump_revision
from api.permissions import HasVesselPermission
from api.serializers import invoice_data
from operations.models import VesselCall

from .models import MeasurementPlan
from .serializers import (
    ApprovalSerializer,
    AssessmentSerializer,
    PlanPatchSerializer,
    PlanSerializer,
    ReconciliationSerializer,
    SubmissionSerializer,
    VersionSerializer,
    plan_data,
)
from .services import (
    Conflict,
    changed,
    check_version,
    create_approval,
    create_assessment,
    create_reconciliation,
    create_structure,
    create_submission,
    event,
    finalize_reconciliation,
    get_plan,
    get_reconciliation,
    issue_assessment,
)


def validated(serializer_type, request):
    serializer = serializer_type(data=request.data)
    serializer.is_valid(raise_exception=True)
    return serializer.validated_data


class MeasurementView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "measurements.manage"


class PlansView(MeasurementView):
    def get_permissions(self):
        self.required_permission = (
            "measurements.view" if self.request.method == "GET" else "measurements.manage"
        )
        return super().get_permissions()

    def get(self, request):
        plans = MeasurementPlan.objects.filter(
            organization_id=request.user.organization_id
        ).select_related("vessel_call", "created_by")
        if request.query_params.get("callId"):
            plans = plans.filter(vessel_call_id=request.query_params["callId"])
        return Response({"plans": [plan_data(plan) for plan in plans]})

    @transaction.atomic
    def post(self, request):
        data = validated(PlanSerializer, request)
        call = (
            VesselCall.objects.select_for_update()
            .filter(pk=data["callId"], organization_id=request.user.organization_id)
            .first()
        )
        if not call:
            raise NotFound("Vessel call not found")
        if call.status == "cancelled":
            raise Conflict("Cannot plan a measurement for a cancelled vessel call")
        plan = MeasurementPlan.objects.create(
            organization_id=request.user.organization_id,
            vessel_call=call,
            title=data["title"],
            scheduled_at=data["scheduledAt"],
            ends_at=data["endsAt"],
            location=data["location"],
            method=data["method"],
            stage=data["stage"],
            scope=data["scope"],
            lead_surveyor=data["leadSurveyor"],
            notes=data["notes"],
            created_by=request.user,
        )
        create_structure(plan, data)
        result = plan_data(plan)
        revision = bump_revision(plan.organization_id)
        event(plan, request, "planned", result)
        return Response({"plan": result, "rev": revision}, status=201)


class PlanDetailView(MeasurementView):
    def get_permissions(self):
        self.required_permission = (
            "measurements.view" if self.request.method == "GET" else "measurements.manage"
        )
        return super().get_permissions()

    def get(self, request, plan_id):
        return Response({"plan": plan_data(get_plan(request, plan_id))})

    @transaction.atomic
    def patch(self, request, plan_id):
        data = validated(PlanPatchSerializer, request)
        plan = get_plan(request, plan_id, lock=True)
        check_version(plan, data["version"])
        before = plan_data(plan)
        if data.get("status") == "cancelled":
            if not data.get("reason"):
                raise ValidationError({"reason": "Cancellation requires a reason"})
            if plan.reconciliations.filter(finalized_at__isnull=False).exists():
                raise Conflict(
                    "A finalized measurement plan cannot be cancelled; create an amendment"
                )
            plan.status = "cancelled"
            plan.cancellation_reason = data["reason"]
        if "participants" in data or "lines" in data:
            if plan.submissions.exists() or plan.reconciliations.exists():
                raise Conflict(
                    "Participants and cargo lines are locked once returns or reconciliations exist"
                )
            if len(data.get("participants", [])) > 30 or len(data.get("lines", [])) > 100:
                raise ValidationError("Maximum 30 participants and 100 cargo lines per plan")
            if "participants" in data:
                plan.participants.all().delete()
            if "lines" in data:
                plan.lines.all().delete()
            create_structure(plan, data)
        mapping = {
            "title": "title",
            "scheduledAt": "scheduled_at",
            "endsAt": "ends_at",
            "location": "location",
            "leadSurveyor": "lead_surveyor",
            "notes": "notes",
        }
        for key, field in mapping.items():
            if key in data:
                setattr(plan, field, data[key])
        if plan.ends_at and plan.ends_at < plan.scheduled_at:
            raise ValidationError("End time cannot precede start time")
        plan.save()
        revision = changed(plan, request, "updated", after=plan_data(plan), before=before)
        return Response({"plan": plan_data(plan), "rev": revision})


class SubmissionView(MeasurementView):
    @transaction.atomic
    def post(self, request, plan_id):
        data = validated(SubmissionSerializer, request)
        plan = get_plan(request, plan_id, lock=True)
        revision = create_submission(plan, data, request)
        return Response({"plan": plan_data(plan), "rev": revision}, status=201)


class ReconciliationView(MeasurementView):
    @transaction.atomic
    def post(self, request, plan_id):
        data = validated(ReconciliationSerializer, request)
        plan = get_plan(request, plan_id, lock=True)
        revision = create_reconciliation(plan, data, request)
        return Response({"plan": plan_data(plan), "rev": revision}, status=201)


class ApprovalView(MeasurementView):
    @transaction.atomic
    def post(self, request, plan_id, reconciliation_id):
        data = validated(ApprovalSerializer, request)
        plan = get_plan(request, plan_id, lock=True)
        reconciliation = get_reconciliation(plan, reconciliation_id)
        revision = create_approval(plan, reconciliation, data, request)
        return Response({"plan": plan_data(plan), "rev": revision}, status=201)


class FinalizeView(MeasurementView):
    required_permission = "measurements.approve"

    @transaction.atomic
    def post(self, request, plan_id, reconciliation_id):
        data = validated(VersionSerializer, request)
        plan = get_plan(request, plan_id, lock=True)
        reconciliation = get_reconciliation(plan, reconciliation_id)
        revision = finalize_reconciliation(plan, reconciliation, data, request)
        return Response({"plan": plan_data(plan), "rev": revision})


class AssessmentView(MeasurementView):
    required_permission = "measurements.bill"

    @transaction.atomic
    def post(self, request, plan_id):
        data = validated(AssessmentSerializer, request)
        plan = get_plan(request, plan_id, lock=True)
        revision = create_assessment(plan, data, request)
        return Response({"plan": plan_data(plan), "rev": revision}, status=201)


class IssueView(MeasurementView):
    required_permission = "measurements.bill"

    @transaction.atomic
    def post(self, request, plan_id, assessment_id):
        data = validated(VersionSerializer, request)
        plan = get_plan(request, plan_id, lock=True)
        revision, invoice = issue_assessment(plan, assessment_id, data, request)
        return Response(
            {"plan": plan_data(plan), "invoice": invoice_data(invoice), "rev": revision}
        )
