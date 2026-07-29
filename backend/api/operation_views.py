from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from django.core import signing
from django.db import transaction
from django.db.models import F, Max
from django.http import FileResponse, HttpResponse
from django.utils.text import slugify
from django.utils import timezone
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_exempt
from rest_framework import status
from rest_framework.exceptions import APIException, NotFound, ValidationError
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from audit.services import record_event
from billing.models import Invoice, InvoiceStatusEvent, InvoiceStatusStep, Payment
from billing.services import (
    ensure_default_steps,
    reconcile_payment_status,
    transition_invoice,
    workflow_step_data,
)
from operations.models import EvidenceAttachment, Inspection, VesselCall
from organizations.models import Organization, OrganizationSettings

from .documents import simple_pdf
from .domain import bump_revision, finalize_inspection, next_number
from .pagination import StandardPagination
from .permissions import HasVesselPermission
from .serializers import (
    CancelSerializer,
    EvidenceFinalizeSerializer,
    EvidencePresignSerializer,
    LogoFinalizeSerializer,
    LogoPresignSerializer,
    InspectionSerializer,
    InvoiceStatusReorderSerializer,
    InvoiceStatusStepSerializer,
    InvoiceStatusStepUpdateSerializer,
    InvoiceTransitionSerializer,
    PaymentCreateSerializer,
    ReversalSerializer,
    VesselCallSerializer,
    call_data,
    evidence_data,
    inspection_data,
    inspection_report_sections,
    invoice_data,
    organization_data,
    payment_data,
    settings_data,
)
from .storage import (
    delete_object,
    local_download,
    local_upload,
    object_key,
    logo_key,
    logo_upload_key,
    object_metadata,
    permanent_object_key,
    presign_download,
    presign_upload,
    promote_object,
    validate_logo,
)


class Conflict(APIException):
    status_code = status.HTTP_409_CONFLICT
    default_detail = "The resource changed. Refresh and try again"
    default_code = "conflict"


def _check_version(instance, provided):
    if provided is not None and instance.version != provided:
        raise Conflict()


class VesselCallsView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "calls.view"

    def get(self, request):
        queryset = request.user.organization.vessel_calls.all()
        paginator = StandardPagination()
        page = paginator.paginate_queryset(queryset, request) or []
        return paginator.get_paginated_response([call_data(item) for item in page])

    @transaction.atomic
    def post(self, request):
        serializer = VesselCallSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        for field in ("vesselName", "reference"):
            if not data.get(field):
                raise ValidationError({field: ["This field is required"]})
        if request.user.organization.vessel_calls.filter(reference=data["reference"]).exists():
            raise Conflict(f"Rotation number {data['reference']} is already registered")
        call = VesselCall.objects.create(
            organization=request.user.organization,
            vessel_name=data["vesselName"].strip(),
            reference=data["reference"].strip(),
            vessel_type=data.get("type", ""),
            flag=data.get("flag", ""),
            nrt=data.get("nrt", 0),
            eta=data.get("eta"),
            sailing_eta=data.get("sailingEta"),
            berth=data.get("berth", ""),
            berth_date=data.get("berthDate"),
            notes=data.get("notes", ""),
            created_by=request.user,
        )
        revision = bump_revision(request.user.organization_id)
        record_event(
            organization=request.user.organization,
            actor=request.user,
            action="vessel_call.created",
            category="operations",
            target=call,
            target_label=call.reference,
            request=request,
            after=call_data(call),
        )
        return Response(
            {"call": call_data(call), "rev": revision},
            status=status.HTTP_201_CREATED,
        )

    def get_permissions(self):
        if self.request.method == "POST":
            self.required_permission = "calls.manage"
        return super().get_permissions()


class VesselCallDetailView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "calls.view"

    def _get(self, request, call_id, lock=False):
        queryset = VesselCall.objects.select_for_update() if lock else VesselCall.objects
        call = queryset.filter(pk=call_id, organization=request.user.organization).first()
        if not call:
            raise NotFound("Vessel call not found")
        return call

    def get(self, request, call_id):
        return Response({"call": call_data(self._get(request, call_id))})

    @transaction.atomic
    def patch(self, request, call_id):
        serializer = VesselCallSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        call = self._get(request, call_id, lock=True)
        if call.status == VesselCall.Status.CANCELLED:
            raise Conflict("A cancelled call cannot be edited")
        data = serializer.validated_data
        _check_version(call, data.pop("version", None))
        before = call_data(call)
        mapping = {
            "vesselName": "vessel_name",
            "reference": "reference",
            "type": "vessel_type",
            "flag": "flag",
            "nrt": "nrt",
            "eta": "eta",
            "sailingEta": "sailing_eta",
            "berth": "berth",
            "berthDate": "berth_date",
            "status": "status",
            "notes": "notes",
        }
        for key, field in mapping.items():
            if key in data:
                setattr(call, field, data[key])
        call.version += 1
        call.save()
        revision = bump_revision(call.organization_id)
        record_event(
            organization=call.organization,
            actor=request.user,
            action="vessel_call.updated",
            category="operations",
            target=call,
            target_label=call.reference,
            request=request,
            before=before,
            after=call_data(call),
        )
        return Response({"call": call_data(call), "rev": revision})

    def get_permissions(self):
        if self.request.method == "PATCH":
            self.required_permission = "calls.manage"
        return super().get_permissions()


class VesselCallStatusView(VesselCallDetailView):
    required_permission = "calls.manage"

    def post(self, request, call_id):
        return self.patch(request, call_id)


class VesselCallCancelView(VesselCallDetailView):
    required_permission = "calls.manage"

    @transaction.atomic
    def post(self, request, call_id):
        serializer = CancelSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        call = self._get(request, call_id, lock=True)
        _check_version(call, serializer.validated_data.get("version"))
        if call.status == VesselCall.Status.COMPLETED:
            raise Conflict("A completed call cannot be cancelled")
        if call.status == VesselCall.Status.CANCELLED:
            return Response({"call": call_data(call), "rev": call.organization.revision})
        before = call_data(call)
        call.status = VesselCall.Status.CANCELLED
        call.cancellation_reason = serializer.validated_data["reason"].strip()
        call.cancelled_at = timezone.now()
        call.version += 1
        call.save()
        revision = bump_revision(call.organization_id)
        record_event(
            organization=call.organization,
            actor=request.user,
            action="vessel_call.cancelled",
            category="operations",
            target=call,
            target_label=call.reference,
            request=request,
            before=before,
            after=call_data(call),
        )
        return Response({"call": call_data(call), "rev": revision})


class InspectionsView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "inspections.view"

    def get(self, request):
        queryset = request.user.organization.inspections.all()
        paginator = StandardPagination()
        page = paginator.paginate_queryset(queryset, request) or []
        return paginator.get_paginated_response([inspection_data(item) for item in page])

    @transaction.atomic
    def post(self, request):
        serializer = InspectionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        call_id = data.get("callId")
        if not call_id:
            raise ValidationError({"callId": ["This field is required"]})
        call = (
            VesselCall.objects.select_for_update()
            .filter(pk=call_id, organization=request.user.organization)
            .first()
        )
        if not call:
            raise NotFound("Vessel call not found")
        if call.status == VesselCall.Status.CANCELLED:
            raise Conflict("A cancelled call cannot be inspected")
        key = request.headers.get("Idempotency-Key", "")[:128]
        if key:
            existing = Inspection.objects.filter(
                organization=request.user.organization, idempotency_key=key
            ).first()
            if existing:
                response = {
                    "inspection": inspection_data(existing),
                    "rev": request.user.organization.revision,
                }
                try:
                    response["invoice"] = invoice_data(existing.invoice)
                except Invoice.DoesNotExist:
                    response["invoice"] = None
                return Response(response)
        inspection = Inspection.objects.create(
            organization=request.user.organization,
            vessel_call=call,
            reference=next_number(request.user.organization, "inspection", "INS"),
            vessel_name=call.vessel_name,
            cargo_type=data.get("cargoType", "Liquid"),
            product=data.get("product") or "",
            reconciled_tonnage=data.get("reconciledTonnage", 0),
            jetty=data.get("jetty"),
            liquid=data.get("liquid"),
            dry=data.get("dry"),
            status=Inspection.Status.DRAFT,
            idempotency_key=key,
            created_by=request.user,
        )
        call.status = VesselCall.Status.IN_PROGRESS
        call.version += 1
        call.save(update_fields=("status", "version", "updated_at"))
        revision = bump_revision(call.organization_id)
        record_event(
            organization=call.organization,
            actor=request.user,
            action="inspection.draft_created",
            category="operations",
            target=inspection,
            target_label=inspection.reference,
            request=request,
            after=inspection_data(inspection),
        )
        if data.get("status") == "completed":
            inspection, invoice, revision = finalize_inspection(inspection.id, call.organization_id)
            return Response(
                {
                    "inspection": inspection_data(inspection),
                    "invoice": invoice_data(invoice),
                    "call": call_data(invoice.vessel_call),
                    "rev": revision,
                },
                status=status.HTTP_201_CREATED,
            )
        return Response(
            {"inspection": inspection_data(inspection), "rev": revision},
            status=status.HTTP_201_CREATED,
        )

    def get_permissions(self):
        if self.request.method == "POST":
            self.required_permission = "inspections.manage"
        return super().get_permissions()


class InspectionDetailView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "inspections.view"

    def _get(self, request, inspection_id, lock=False):
        queryset = Inspection.objects.select_for_update() if lock else Inspection.objects
        inspection = queryset.filter(
            pk=inspection_id, organization=request.user.organization
        ).first()
        if not inspection:
            raise NotFound("Inspection not found")
        return inspection

    def get(self, request, inspection_id):
        return Response({"inspection": inspection_data(self._get(request, inspection_id))})

    @transaction.atomic
    def patch(self, request, inspection_id):
        serializer = InspectionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        inspection = self._get(request, inspection_id, lock=True)
        if inspection.status != Inspection.Status.DRAFT:
            raise Conflict("Only draft inspections can be edited")
        data = serializer.validated_data
        _check_version(inspection, data.pop("version", None))
        before = inspection_data(inspection)
        mapping = {
            "cargoType": "cargo_type",
            "product": "product",
            "reconciledTonnage": "reconciled_tonnage",
            "jetty": "jetty",
            "liquid": "liquid",
            "dry": "dry",
        }
        for key, field in mapping.items():
            if key in data:
                value = data[key] or "" if field == "product" else data[key]
                setattr(inspection, field, value)
        inspection.version += 1
        inspection.save()
        revision = bump_revision(inspection.organization_id)
        record_event(
            organization=inspection.organization,
            actor=request.user,
            action="inspection.draft_updated",
            category="operations",
            target=inspection,
            target_label=inspection.reference,
            request=request,
            before=before,
            after=inspection_data(inspection),
        )
        return Response({"inspection": inspection_data(inspection), "rev": revision})

    def get_permissions(self):
        if self.request.method == "PATCH":
            self.required_permission = "inspections.manage"
        return super().get_permissions()


class InspectionFinalizeView(InspectionDetailView):
    required_permission = "inspections.manage"

    @transaction.atomic
    def post(self, request, inspection_id):
        inspection = self._get(request, inspection_id, lock=True)
        _check_version(inspection, request.data.get("version"))
        was_draft = inspection.status == Inspection.Status.DRAFT
        inspection, invoice, revision = finalize_inspection(
            inspection.id, request.user.organization_id
        )
        if was_draft:
            record_event(
                organization=inspection.organization,
                actor=request.user,
                action="inspection.finalized",
                category="operations",
                target=inspection,
                target_label=inspection.reference,
                request=request,
                after={"invoiceId": invoice.id, **inspection_data(inspection)},
            )
        return Response(
            {
                "inspection": inspection_data(inspection),
                "invoice": invoice_data(invoice),
                "call": call_data(invoice.vessel_call),
                "rev": revision,
            }
        )


class PaymentCreateView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "invoices.pay"

    @transaction.atomic
    def post(self, request, invoice_id):
        serializer = PaymentCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        invoice = (
            Invoice.objects.select_for_update(of=("self",))
            .filter(pk=invoice_id, organization=request.user.organization)
            .first()
        )
        if not invoice:
            raise NotFound("Invoice not found")
        if invoice.status == Invoice.Status.VOID:
            raise Conflict("A void invoice cannot be paid")
        key = request.headers.get("Idempotency-Key", "")[:128]
        if key:
            existing = invoice.payments.filter(idempotency_key=key).first()
            if existing:
                return Response(
                    {
                        "payment": payment_data(existing),
                        "invoice": invoice_data(invoice),
                        "rev": invoice.organization.revision,
                    }
                )
        data = serializer.validated_data
        payment = Payment.objects.create(
            invoice=invoice,
            amount=data.get("amount", invoice.dues),
            paid_on=data["paidOn"],
            method=data["method"],
            reference=data["reference"],
            recorded_by=request.user,
            idempotency_key=key,
        )
        reconcile_payment_status(
            invoice, actor=request.user, source=InvoiceStatusEvent.Source.PAYMENT
        )
        revision = bump_revision(invoice.organization_id)
        record_event(
            organization=invoice.organization,
            actor=request.user,
            action="payment.recorded",
            category="billing",
            target=payment,
            target_label=payment.reference,
            request=request,
            after=payment_data(payment),
        )
        return Response(
            {
                "payment": payment_data(payment),
                "invoice": invoice_data(invoice),
                "rev": revision,
            },
            status=status.HTTP_201_CREATED,
        )


class PaymentReverseView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "invoices.pay"

    @transaction.atomic
    def post(self, request, payment_id):
        serializer = ReversalSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        payment = (
            Payment.objects.select_for_update()
            .select_related("invoice__organization")
            .filter(pk=payment_id, invoice__organization=request.user.organization)
            .first()
        )
        if not payment:
            raise NotFound("Payment not found")
        if payment.reversed_at:
            return Response(
                {
                    "payment": payment_data(payment),
                    "invoice": invoice_data(payment.invoice),
                    "rev": payment.invoice.organization.revision,
                }
            )
        payment.reversed_at = timezone.now()
        payment.reversed_by = request.user
        payment.reversal_reason = serializer.validated_data["reason"]
        payment.save(update_fields=("reversed_at", "reversed_by", "reversal_reason"))
        invoice = Invoice.objects.select_for_update().get(pk=payment.invoice_id)
        reconcile_payment_status(
            invoice, actor=request.user, source=InvoiceStatusEvent.Source.REVERSAL
        )
        revision = bump_revision(invoice.organization_id)
        record_event(
            organization=invoice.organization,
            actor=request.user,
            action="payment.reversed",
            category="billing",
            target=payment,
            target_label=payment.reference,
            request=request,
            after=payment_data(payment),
        )
        return Response(
            {
                "payment": payment_data(payment),
                "invoice": invoice_data(invoice),
                "rev": revision,
            }
        )


def invoice_status_step_data(step: InvoiceStatusStep) -> dict:
    return workflow_step_data(step)


class InvoiceStatusStepsView(APIView):
    """List steps for invoice readers; only organization admins configure them."""

    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "invoices.view"

    def get(self, request):
        return Response(
            {
                "steps": [
                    invoice_status_step_data(step)
                    for step in ensure_default_steps(request.user.organization)
                ]
            }
        )

    @transaction.atomic
    def post(self, request):
        serializer = InvoiceStatusStepSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        code = data.get("code") or slugify(data["label"])
        if not code or code in {"paid", "void"}:
            raise ValidationError({"code": ["Paid and Void are protected system statuses"]})
        organization = Organization.objects.select_for_update().get(pk=request.user.organization_id)
        # Initialize the protected defaults before allocating a custom position.
        # Otherwise a first custom step would take position 10 and collide when
        # the draft default is subsequently provisioned.
        ensure_default_steps(organization)
        if organization.invoice_status_steps.filter(code=code).exists():
            raise ValidationError({"code": ["This status code already exists"]})
        position = (
            organization.invoice_status_steps.aggregate(last=Max("position"))["last"] or 0
        ) + 10
        step = InvoiceStatusStep.objects.create(
            organization=organization,
            code=code,
            label=data["label"].strip(),
            position=position,
            active=data["active"],
        )
        revision = bump_revision(organization.id)
        record_event(
            organization=organization,
            actor=request.user,
            action="invoice_status_step.created",
            category="billing",
            target=step,
            target_label=step.label,
            request=request,
            after=invoice_status_step_data(step),
        )
        return Response(
            {"step": invoice_status_step_data(step), "rev": revision},
            status=status.HTTP_201_CREATED,
        )

    def get_permissions(self):
        if self.request.method == "POST":
            self.required_permission = "organization.manage"
        return super().get_permissions()


class InvoiceStatusStepDetailView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "organization.manage"

    @transaction.atomic
    def patch(self, request, step_id):
        serializer = InvoiceStatusStepUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        step = (
            InvoiceStatusStep.objects.select_for_update()
            .filter(pk=step_id, organization=request.user.organization)
            .first()
        )
        if not step:
            raise NotFound("Invoice status step not found")
        if step.is_protected:
            raise ValidationError({"detail": ["Paid is a protected system status"]})
        before = invoice_status_step_data(step)
        for field, value in serializer.validated_data.items():
            setattr(step, field, value.strip() if field == "label" else value)
        step.save(update_fields=tuple(serializer.validated_data.keys()) + ("updated_at",))
        revision = bump_revision(step.organization_id)
        record_event(
            organization=request.user.organization,
            actor=request.user,
            action="invoice_status_step.updated",
            category="billing",
            target=step,
            target_label=step.label,
            request=request,
            before=before,
            after=invoice_status_step_data(step),
        )
        return Response({"step": invoice_status_step_data(step), "rev": revision})


class InvoiceStatusStepReorderView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "organization.manage"

    @transaction.atomic
    def post(self, request):
        serializer = InvoiceStatusReorderSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        steps = list(
            InvoiceStatusStep.objects.select_for_update().filter(
                organization=request.user.organization
            )
        )
        ids = serializer.validated_data["ids"]
        if len(ids) != len(set(ids)) or set(ids) != {step.id for step in steps}:
            raise ValidationError({"ids": ["Submit every organization status exactly once"]})
        by_id = {step.id: step for step in steps}
        ordered = [by_id[identifier] for identifier in ids]
        if not ordered[-1].is_paid or any(step.is_paid for step in ordered[:-1]):
            raise ValidationError({"ids": ["Paid is terminal and must remain last"]})
        # Move positions out of the unique range before assigning requested positions.
        InvoiceStatusStep.objects.filter(pk__in=ids).update(position=F("position") + 10_000)
        for index, step in enumerate(ordered, start=1):
            step.position = index * 10
            step.save(update_fields=("position", "updated_at"))
        revision = bump_revision(request.user.organization_id)
        record_event(
            organization=request.user.organization,
            actor=request.user,
            action="invoice_status_steps.reordered",
            category="billing",
            target=request.user.organization,
            target_label=request.user.organization.name,
            request=request,
            after={"ids": ids},
        )
        return Response(
            {"steps": [invoice_status_step_data(step) for step in ordered], "rev": revision}
        )


class InvoiceTransitionView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "invoices.manage"

    @transaction.atomic
    def patch(self, request, invoice_id):
        serializer = InvoiceTransitionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        invoice = (
            # Lock only the invoice row.  `current_status` is nullable, so
            # PostgreSQL rejects locking the outer-joined related row.
            Invoice.objects.select_for_update(of=("self",))
            .select_related("current_status", "organization")
            .filter(pk=invoice_id, organization=request.user.organization)
            .first()
        )
        if not invoice:
            raise NotFound("Invoice not found")
        if invoice.status == Invoice.Status.VOID:
            raise Conflict("A void invoice cannot be transitioned")
        step = InvoiceStatusStep.objects.filter(
            pk=serializer.validated_data["statusId"],
            organization=request.user.organization,
            active=True,
        ).first()
        if not step:
            raise ValidationError({"statusId": ["Choose an active invoice status"]})
        if step.is_paid:
            raise ValidationError({"statusId": ["Paid is set only by payment reconciliation"]})
        event = transition_invoice(
            invoice,
            step,
            source=InvoiceStatusEvent.Source.MANUAL,
            actor=request.user,
            note=serializer.validated_data.get("note", ""),
        )
        revision = (
            bump_revision(invoice.organization_id) if event else invoice.organization.revision
        )
        if event:
            record_event(
                organization=invoice.organization,
                actor=request.user,
                action="invoice.status_transitioned",
                category="billing",
                target=invoice,
                target_label=invoice.invoice_no,
                request=request,
                before={"status": event.from_code},
                after={"status": event.to_code, "note": event.note or None},
            )
        return Response({"invoice": invoice_data(invoice), "rev": revision})


class OrganizationView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "organization.view"

    def get(self, request):
        members = (
            request.user.organization.users.order_by("created_at")
            if request.user.role == "Admin"
            else None
        )
        return Response({"org": organization_data(request.user.organization, members=members)})

    @transaction.atomic
    def put(self, request):
        organization = Organization.objects.select_for_update().get(pk=request.user.organization_id)
        before = organization_data(organization)
        mapping = {
            "name": "name",
            "rcNumber": "rc_number",
            "email": "email",
            "phone": "phone",
            "address": "address",
            "designatedPort": "primary_port",
            "primaryPort": "primary_port",
            "ports": "ports",
            "registered": "registered",
        }
        for key, field in mapping.items():
            if key in request.data:
                setattr(organization, field, request.data[key] or "")
        organization.save()
        revision = bump_revision(organization.id)
        organization.revision = revision
        record_event(
            organization=organization,
            actor=request.user,
            action="organization.updated",
            category="settings",
            target=organization,
            target_label=organization.name,
            request=request,
            before=before,
            after=organization_data(organization),
        )
        return Response({"org": organization_data(organization), "rev": revision})

    def get_permissions(self):
        if self.request.method == "PUT":
            self.required_permission = "organization.manage"
        return super().get_permissions()


class OrganizationLogoView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "organization.manage"

    def get(self, request):
        key = request.user.organization.logo_object_key
        return Response(
            {
                "hasLogo": bool(key),
                "downloadUrl": presign_download(request, key=key) if key else None,
            }
        )

    def post(self, request):
        serializer = LogoPresignSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        key = logo_upload_key(request.user.organization_id, data["fileName"])
        return Response(
            presign_upload(
                request,
                key=key,
                content_type=data["contentType"],
                size=data["size"],
                checksum=data["checksum"],
            )
        )

    @transaction.atomic
    def put(self, request):
        serializer = LogoFinalizeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        key = data["objectKey"]
        if not key.startswith(f"organizations/{request.user.organization_id}/logos/uploads/"):
            raise ValidationError(
                {"objectKey": ["Logo upload does not belong to this organization"]}
            )
        metadata = object_metadata(key)
        if (
            not metadata
            or metadata["size"] != data["size"]
            or metadata["checksum"] != data["checksum"].removeprefix("sha256:")
        ):
            raise ValidationError({"objectKey": ["Uploaded logo could not be verified"]})
        try:
            validate_logo(key, data["contentType"], data["size"])
        except (OSError, ValueError) as exc:
            raise ValidationError({"objectKey": [str(exc)]}) from exc
        org = Organization.objects.select_for_update().get(pk=request.user.organization_id)
        destination = logo_key(org.id, data["fileName"])
        if not promote_object(key, destination):
            raise ValidationError({"objectKey": ["Logo could not be finalized"]})
        previous = org.logo_object_key
        org.logo_object_key = destination
        org.save(update_fields=("logo_object_key", "updated_at"))
        if previous:
            delete_object(previous)
        revision = bump_revision(org.id)
        record_event(
            organization=org,
            actor=request.user,
            action="organization.logo_updated",
            category="settings",
            target=org,
            target_label=org.name,
            request=request,
        )
        return Response(
            {
                "hasLogo": True,
                "downloadUrl": presign_download(request, key=destination),
                "rev": revision,
            }
        )

    @transaction.atomic
    def delete(self, request):
        org = Organization.objects.select_for_update().get(pk=request.user.organization_id)
        previous = org.logo_object_key
        org.logo_object_key = ""
        org.save(update_fields=("logo_object_key", "updated_at"))
        if previous:
            delete_object(previous)
        return Response(status=status.HTTP_204_NO_CONTENT)


class SettingsView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "settings.view"

    def get(self, request):
        return Response({"settings": settings_data(request.user.organization.settings)})

    @transaction.atomic
    def put(self, request):
        settings_obj = OrganizationSettings.objects.select_for_update().get(
            organization=request.user.organization
        )
        before = settings_data(settings_obj)
        if "commissionRate" in request.data:
            settings_obj.commission_rate = Decimal(str(request.data["commissionRate"]))
        if "exchangeRate" in request.data:
            settings_obj.exchange_rate = Decimal(str(request.data["exchangeRate"]))
        if "dryDuesRate" in request.data:
            settings_obj.dry_dues_rate = Decimal(str(request.data["dryDuesRate"]))
        if "portName" in request.data:
            settings_obj.port_name = request.data["portName"]
        if "terminals" in request.data:
            settings_obj.terminals = request.data["terminals"]
        rates = request.data.get("liquidDuesRates")
        if rates:
            for key, field in {
                "government": "government_liquid_rate",
                "private": "private_liquid_rate",
                "international": "international_liquid_rate",
            }.items():
                if key in rates:
                    setattr(settings_obj, field, Decimal(str(rates[key])))
        settings_obj.full_clean()
        settings_obj.save()
        revision = bump_revision(request.user.organization_id)
        record_event(
            organization=request.user.organization,
            actor=request.user,
            action="settings.updated",
            category="settings",
            target=settings_obj,
            target_label=request.user.organization.name,
            request=request,
            before=before,
            after=settings_data(settings_obj),
        )
        return Response({"settings": settings_data(settings_obj), "rev": revision})

    def get_permissions(self):
        if self.request.method == "PUT":
            self.required_permission = "settings.manage"
        return super().get_permissions()


class StateView(APIView):
    def get(self, request):
        organization = request.user.organization
        ensure_default_steps(organization)
        requested_rev = request.query_params.get("rev")
        if requested_rev is not None and str(organization.revision) == requested_rev:
            return Response({"changed": False, "rev": organization.revision})
        members = organization.users.order_by("created_at") if request.user.role == "Admin" else []
        return Response(
            {
                "rev": organization.revision,
                "org": organization_data(organization, members=members),
                "settings": settings_data(organization.settings),
                "calls": [call_data(item) for item in organization.vessel_calls.all()],
                "inspections": [inspection_data(item) for item in organization.inspections.all()],
                "invoices": [invoice_data(item) for item in organization.invoices.all()],
                "invoiceStatusSteps": [
                    invoice_status_step_data(item)
                    for item in organization.invoice_status_steps.all()
                ],
            }
        )


class AnalyticsView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "analytics.view"

    def get(self, request):
        try:
            months = max(1, min(36, int(request.query_params.get("months", 12))))
        except ValueError as exc:
            raise ValidationError({"months": ["Enter an integer from 1 to 36"]}) from exc
        today = timezone.localdate()
        keys = []
        year, month = today.year, today.month
        for _ in range(months):
            keys.append(f"{year:04d}-{month:02d}")
            month -= 1
            if month == 0:
                year -= 1
                month = 12
        keys.reverse()
        series: dict[str, dict[str, Any]] = {
            key: {
                "key": key,
                "month": date(int(key[:4]), int(key[5:]), 1).strftime("%b"),
                "year": key[:4],
                "liquidT": 0.0,
                "dryT": 0.0,
                "revenue": 0.0,
                "calls": 0,
            }
            for key in keys
        }
        organization = request.user.organization
        products: dict[str, Decimal] = {}
        for inspection in organization.inspections.filter(status=Inspection.Status.COMPLETED):
            key = (inspection.completed_at or inspection.created_at).strftime("%Y-%m")
            if key in series:
                metric = "dryT" if inspection.cargo_type == "Dry" else "liquidT"
                series[key][metric] += float(inspection.reconciled_tonnage)
            if inspection.cargo_type != "Dry" and inspection.product:
                products[inspection.product] = (
                    products.get(inspection.product, Decimal("0")) + inspection.reconciled_tonnage
                )
        invoiced = collected = outstanding = Decimal("0")
        liquid_revenue = dry_revenue = Decimal("0")
        for invoice in organization.invoices.exclude(status=Invoice.Status.VOID):
            invoiced += invoice.dues
            if invoice.status == Invoice.Status.PAID:
                collected += invoice.dues
            else:
                outstanding += invoice.dues
            if invoice.cargo_type == "Dry":
                dry_revenue += invoice.dues
            else:
                liquid_revenue += invoice.dues
            key = invoice.issued_on.strftime("%Y-%m")
            if key in series:
                series[key]["revenue"] += float(invoice.dues)
        for call in organization.vessel_calls.exclude(status=VesselCall.Status.CANCELLED):
            key = (call.berth_date or call.registered_at.date()).strftime("%Y-%m")
            if key in series:
                series[key]["calls"] += 1
        total_product = sum(products.values(), Decimal("0"))
        product_rows = []
        for key, tonnage in sorted(products.items(), key=lambda item: item[1], reverse=True):
            share = tonnage / total_product if total_product else Decimal("0")
            product_rows.append(
                {
                    "key": key,
                    "name": key,
                    "tonnage": round(float(tonnage)),
                    "share": round(float(share), 4),
                    "revenue": round(float(liquid_revenue * share)),
                }
            )
        series_rows = list(series.values())
        liquid_t = sum(item["liquidT"] for item in series_rows)
        dry_t = sum(item["dryT"] for item in series_rows)
        return Response(
            {
                "series": series_rows,
                "products": product_rows,
                "totals": {
                    "throughput": round(liquid_t + dry_t),
                    "liquidT": round(liquid_t),
                    "dryT": round(dry_t),
                    "revenue": round(float(invoiced)),
                    "liquidR": round(float(liquid_revenue)),
                    "dryR": round(float(dry_revenue)),
                    "invoiced": round(float(invoiced)),
                    "collected": round(float(collected)),
                    "outstanding": round(float(outstanding)),
                    "calls": organization.vessel_calls.exclude(
                        status=VesselCall.Status.CANCELLED
                    ).count(),
                },
            }
        )


class EvidencePresignView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "evidence.manage"

    def post(self, request):
        serializer = EvidencePresignSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        inspection = request.user.organization.inspections.filter(pk=data["inspectionId"]).first()
        if not inspection:
            raise NotFound("Inspection not found")
        key = object_key(inspection.organization_id, inspection.id, data["fileName"])
        return Response(
            presign_upload(
                request,
                key=key,
                content_type=data["contentType"],
                size=data["size"],
                checksum=data["checksum"],
            )
        )


class EvidenceFinalizeView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "evidence.manage"

    def post(self, request):
        serializer = EvidenceFinalizeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        inspection = request.user.organization.inspections.filter(pk=data["inspectionId"]).first()
        expected_prefix = (
            f"organizations/{request.user.organization_id}/inspections/{inspection.id}/uploads/"
            if inspection
            else ""
        )
        if not inspection:
            raise NotFound("Inspection not found")
        if not data["objectKey"].startswith(expected_prefix):
            raise ValidationError({"objectKey": ["Object is outside this inspection"]})
        metadata = object_metadata(data["objectKey"])
        if not metadata:
            raise ValidationError({"objectKey": ["Uploaded object was not found"]})
        checksum_hex = data["checksum"].removeprefix("sha256:")
        metadata_matches = (
            metadata["size"] == data["size"]
            and metadata["size"] <= 15 * 1024 * 1024
            and (not metadata["contentType"] or metadata["contentType"] == data["contentType"])
            and (not metadata["declaredSize"] or metadata["declaredSize"] == str(data["size"]))
            and metadata["checksum"] == checksum_hex
        )
        if not metadata_matches:
            raise ValidationError(
                {"objectKey": ["Uploaded object metadata does not match the signed request"]}
            )
        final_key = permanent_object_key(
            inspection.organization_id,
            inspection.id,
            data["fileName"],
        )
        final_metadata = promote_object(data["objectKey"], final_key)
        if (
            not final_metadata
            or final_metadata["size"] != metadata["size"]
            or final_metadata["checksum"] != metadata["checksum"]
        ):
            raise ValidationError(
                {"objectKey": ["Uploaded object could not be finalized immutably"]}
            )
        evidence = EvidenceAttachment.objects.create(
            organization=request.user.organization,
            inspection=inspection,
            object_key=final_key,
            file_name=data["fileName"],
            content_type=data["contentType"],
            size=data["size"],
            checksum=data["checksum"],
            uploaded_by=request.user,
        )
        revision = bump_revision(request.user.organization_id)
        record_event(
            organization=request.user.organization,
            actor=request.user,
            action="evidence.created",
            category="operations",
            target=evidence,
            target_label=evidence.file_name,
            request=request,
            after=evidence_data(evidence),
        )
        return Response(
            {"evidence": evidence_data(evidence), "rev": revision},
            status=status.HTTP_201_CREATED,
        )


class InspectionEvidenceView(APIView):
    def get(self, request, inspection_id):
        inspection = request.user.organization.inspections.filter(pk=inspection_id).first()
        if not inspection:
            raise NotFound("Inspection not found")
        return Response({"results": [evidence_data(item) for item in inspection.evidence.all()]})


class EvidenceDetailView(APIView):
    def _get(self, request, evidence_id):
        evidence = request.user.organization.evidence.filter(pk=evidence_id).first()
        if not evidence:
            raise NotFound("Evidence not found")
        return evidence

    def get(self, request, evidence_id):
        evidence = self._get(request, evidence_id)
        return Response(
            {
                "evidence": evidence_data(evidence),
                "downloadUrl": presign_download(request, key=evidence.object_key),
            }
        )

    def delete(self, request, evidence_id):
        if request.user.role not in {"Admin", "Operations"}:
            raise NotFound("Evidence not found")
        evidence = self._get(request, evidence_id)
        delete_object(evidence.object_key)
        evidence.delete()
        bump_revision(request.user.organization_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


@method_decorator(csrf_exempt, name="dispatch")
class LocalEvidenceUploadView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def put(self, request, token):
        try:
            local_upload(token, request.body, request.content_type or "")
        except (signing.BadSignature, ValueError) as exc:
            raise ValidationError("Upload is invalid or expired") from exc
        return Response(status=status.HTTP_204_NO_CONTENT)


class LocalEvidenceDownloadView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request, token):
        try:
            handle = local_download(token)
        except (signing.BadSignature, OSError) as exc:
            raise NotFound("Download link is invalid or expired") from exc
        return FileResponse(handle, as_attachment=True)


class InvoiceDocumentView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "documents.view"

    def get(self, request, invoice_id):
        invoice = (
            request.user.organization.invoices.select_related("vessel_call", "inspection")
            .filter(pk=invoice_id)
            .first()
        )
        if not invoice:
            raise NotFound("Invoice not found")
        content = simple_pdf(
            f"Invoice {invoice.invoice_no}",
            [
                ("Vessel", invoice.vessel_call.vessel_name),
                ("Rotation", invoice.vessel_call.reference),
                ("Issued", invoice.issued_on),
                ("Due", invoice.due_on),
                (
                    "Status",
                    workflow_step_data(invoice.current_status, legacy_status=invoice.status)[
                        "label"
                    ],
                ),
                ("Rate (USD)", invoice.rate),
                ("Harbour dues (USD)", invoice.dues),
                ("Commission (USD)", invoice.commission_usd),
                ("Commission (NGN)", invoice.commission_ngn),
            ],
            logo_key=invoice.organization.logo_object_key,
        )
        response = HttpResponse(content, content_type="application/pdf")
        response["Content-Disposition"] = f'attachment; filename="{invoice.invoice_no}.pdf"'
        return response


class InspectionDocumentView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "documents.view"

    def get(self, request, inspection_id):
        inspection = request.user.organization.inspections.filter(pk=inspection_id).first()
        if not inspection:
            raise NotFound("Inspection not found")
        rows: list[tuple[str, object]] = []
        for section in inspection_report_sections(inspection):
            rows.append((section["title"], ""))
            rows.extend((field["label"], field["value"]) for field in section["fields"])
        content = simple_pdf(
            f"Inspection {inspection.reference}",
            rows,
            logo_key=inspection.organization.logo_object_key,
        )
        return HttpResponse(content, content_type="application/pdf")


class VesselCallDocumentView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "documents.view"

    def get(self, request, call_id):
        call = request.user.organization.vessel_calls.filter(pk=call_id).first()
        if not call:
            raise NotFound("Vessel call not found")
        content = simple_pdf(
            f"Vessel Call {call.reference}",
            [
                ("Vessel", call.vessel_name),
                ("Rotation", call.reference),
                ("Type", call.vessel_type),
                ("Flag", call.flag),
                ("NRT", call.nrt),
                ("Berth", call.berth),
                ("Status", call.status),
            ],
        )
        return HttpResponse(content, content_type="application/pdf")
