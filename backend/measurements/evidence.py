from __future__ import annotations

import logging
import uuid

from django.db import transaction
from rest_framework import serializers, status
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from api.tenant_lifecycle import TenantLifecycleAPIView as APIView

from api.permissions import HasVesselPermission
from api.storage import (
    delete_object,
    object_metadata,
    validate_invoice_attachment,
    presign_download,
    presign_upload,
    promote_object,
    safe_name,
)
from audit.services import record_event

from .models import MeasurementEvidence, MeasurementPlan
from .serializers import evidence_data

logger = logging.getLogger(__name__)

MAX_SIZE = 15 * 1024 * 1024


class EvidenceUploadSerializer(serializers.Serializer):
    fileName = serializers.CharField(max_length=255)
    contentType = serializers.ChoiceField(
        choices=["application/pdf", "image/jpeg", "image/png", "image/webp"]
    )
    size = serializers.IntegerField(min_value=1, max_value=MAX_SIZE)
    checksum = serializers.RegexField(regex=r"^sha256:[0-9a-f]{64}$")
    objectKey = serializers.CharField(max_length=1024, required=False)


def get_plan(request, plan_id, *, lock=False):
    queryset = MeasurementPlan.objects.all()
    if lock:
        queryset = queryset.select_for_update()
    plan = queryset.filter(pk=plan_id, organization_id=request.user.organization_id).first()
    if plan is None:
        raise NotFound("Measurement plan not found")
    return plan


def prefix(plan, area):
    return f"organizations/{plan.organization_id}/measurements/{plan.id}/{area}/"


def cleanup_committed_upload(source):
    """The immutable evidence row has committed; a leftover temporary copy is harmless."""
    try:
        delete_object(source)
    except Exception:
        logger.warning("Temporary measurement upload cleanup failed", exc_info=True)


def metadata_matches(metadata, data):
    return bool(
        metadata
        and metadata["size"] == data["size"]
        and metadata["size"] <= MAX_SIZE
        and (not metadata["contentType"] or metadata["contentType"] == data["contentType"])
        and (not metadata["declaredSize"] or str(metadata["declaredSize"]) == str(data["size"]))
        and metadata["checksum"] == data["checksum"].removeprefix("sha256:")
    )


class MeasurementEvidencePresignView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "measurements.manage"

    def post(self, request, plan_id):
        plan = get_plan(request, plan_id)
        serializer = EvidenceUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        key = prefix(plan, "uploads") + f"{uuid.uuid4().hex}-{safe_name(data['fileName'])}"
        return Response(
            presign_upload(
                request,
                key=key,
                content_type=data["contentType"],
                size=data["size"],
                checksum=data["checksum"],
            )
        )


class MeasurementEvidenceView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "measurements.manage"

    @transaction.atomic
    def post(self, request, plan_id):
        plan = get_plan(request, plan_id, lock=True)
        serializer = EvidenceUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        source = data.get("objectKey", "")
        if not source.startswith(prefix(plan, "uploads")) or "/../" in source:
            raise ValidationError({"objectKey": ["Object is outside this measurement plan"]})
        # A lost finalize response can be retried after promotion consumed the upload.
        existing = plan.evidence.filter(
            checksum=data["checksum"],
            file_name=data["fileName"],
            content_type=data["contentType"],
            size=data["size"],
        ).first()
        if existing:
            return Response({"evidence": evidence_data(existing)})
        metadata = object_metadata(source)
        if not metadata_matches(metadata, data):
            raise ValidationError(
                {"objectKey": ["Uploaded file size, type or checksum does not match"]}
            )
        try:
            validate_invoice_attachment(source, data["contentType"], data["size"])
        except (ValueError, OSError) as exc:
            raise ValidationError(
                {"contentType": ["File content does not match its declared type"]}
            ) from exc
        destination = prefix(plan, "evidence") + f"{uuid.uuid4().hex}-{safe_name(data['fileName'])}"
        promoted = promote_object(source, destination, preserve_source=True)
        if not metadata_matches(promoted, data):
            delete_object(destination)
            raise ValidationError({"objectKey": ["Uploaded file could not be finalized immutably"]})
        try:
            validate_invoice_attachment(destination, data["contentType"], data["size"])
        except (ValueError, OSError) as exc:
            delete_object(destination)
            raise ValidationError(
                {"contentType": ["File content does not match its declared type"]}
            ) from exc
        try:
            evidence = MeasurementEvidence.objects.create(
                plan=plan,
                object_key=destination,
                file_name=data["fileName"],
                content_type=data["contentType"],
                size=data["size"],
                checksum=data["checksum"],
                uploaded_by=request.user,
            )
        except Exception:
            delete_object(destination)
            raise
        record_event(
            organization=request.user.organization,
            actor=request.user,
            action="measurement.evidence_added",
            category="operations",
            target=evidence,
            target_label=evidence.file_name,
            request=request,
            after={"planId": plan.id, "evidenceId": evidence.id, "checksum": evidence.checksum},
        )
        transaction.on_commit(lambda: cleanup_committed_upload(source))
        return Response({"evidence": evidence_data(evidence)}, status=status.HTTP_201_CREATED)


class MeasurementEvidenceDetailView(APIView):
    lifecycle_capability_methods = frozenset({"GET"})
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "measurements.view"

    def get(self, request, plan_id, evidence_id):
        plan = get_plan(request, plan_id)
        evidence = plan.evidence.filter(pk=evidence_id).first()
        if evidence is None:
            raise NotFound("Measurement evidence not found")
        return Response(
            {
                "evidence": evidence_data(evidence),
                "downloadUrl": presign_download(request, key=evidence.object_key),
            }
        )
