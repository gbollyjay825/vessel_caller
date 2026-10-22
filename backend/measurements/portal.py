from __future__ import annotations

import hashlib
import json
import secrets
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.http import HttpResponse
from django.middleware.csrf import get_token
from django.utils import timezone
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from rest_framework import serializers
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from organizations.models import Organization

from .models import AgencyLink, AgencyPortalSession, MeasurementPlan
from .serializers import cargo_line_data, date_string, participant_data, plan_context
from .serializers import SubmissionLineSerializer
from .services import (
    Conflict,
    create_submission,
    event,
    get_plan,
    latest_submissions,
    participant_for,
)
from .views import MeasurementView, validated
from .reports import PDFDownloadNegotiation

COOKIE = "vessel_agency_browser"


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def fingerprint(plan):
    # Other agencies submitting must not invalidate this agency's independent form.
    source = {
        "plan": {
            key: value
            for key, value in plan_context(plan).items()
            if key
            in {"id", "callId", "vesselName", "callReference", "title", "location", "scheduledAt"}
        },
        "lines": [cargo_line_data(item) for item in plan.lines.all()],
        "participants": [participant_data(item) for item in plan.participants.all()],
    }
    return digest(json.dumps(source, sort_keys=True, separators=(",", ":")))


def assert_open(plan):
    final = plan.reconciliations.order_by("-revision").first()
    if (
        plan.status == "cancelled"
        or plan.vessel_call.status == "cancelled"
        or (final and final.status == "final")
    ):
        raise Conflict("This voyage is no longer open for agency readings")


def link_data(link):
    return {
        "id": link.pk,
        "participantId": link.participant_id,
        "expiresAt": date_string(link.expires_at),
        "revokedAt": date_string(link.revoked_at),
        "submittedAt": date_string(link.submission.recorded_at) if link.submission_id else None,
    }


class LinkSerializer(serializers.Serializer):
    expiryDays = serializers.IntegerField(min_value=1, max_value=30, default=7)


class AgencyLinksView(MeasurementView):
    def get(self, request, plan_id):
        plan = get_plan(request, plan_id)
        return Response(
            {
                "links": [
                    link_data(item)
                    for item in AgencyLink.objects.filter(participant__plan=plan).select_related(
                        "submission"
                    )
                ]
            }
        )


class CreateAgencyLinkView(MeasurementView):
    @transaction.atomic
    def post(self, request, plan_id, participant_id):
        data = validated(LinkSerializer, request)
        plan = get_plan(request, plan_id, lock=True)
        assert_open(plan)
        participant = participant_for(plan, participant_id)
        if participant.submissions.exists():
            raise Conflict("This agency already submitted a reading; staff can record a revision")
        now = timezone.now()
        AgencyLink.objects.filter(participant=participant, revoked_at__isnull=True).update(
            revoked_at=now
        )
        token = secrets.token_urlsafe(48)
        link = AgencyLink.objects.create(
            participant=participant,
            token_digest=digest(token),
            input_fingerprint=fingerprint(plan),
            expires_at=now + timedelta(days=data["expiryDays"]),
            created_by=request.user,
        )
        event(
            plan,
            request,
            "agency_link_created",
            {
                "linkId": link.pk,
                "participantId": participant.pk,
                "expiresAt": date_string(link.expires_at),
            },
        )
        response = Response(
            {
                "link": link_data(link),
                "url": f"{settings.FRONTEND_URL}/agency-reading#token={token}",
            },
            status=201,
        )
        response["Cache-Control"] = "private, no-store"
        return response


class RevokeAgencyLinkView(MeasurementView):
    @transaction.atomic
    def post(self, request, plan_id, link_id):
        plan = get_plan(request, plan_id, lock=True)
        link = (
            AgencyLink.objects.select_for_update()
            .filter(pk=link_id, participant__plan=plan)
            .first()
        )
        if not link:
            raise NotFound("Agency link not found")
        if not link.revoked_at:
            link.revoked_at = timezone.now()
            link.save(update_fields=["revoked_at"])
            event(plan, request, "agency_link_revoked", {"linkId": link.pk})
        return Response(
            {
                "links": [
                    link_data(item)
                    for item in AgencyLink.objects.filter(participant__plan=plan).select_related(
                        "submission"
                    )
                ]
            }
        )


class PortalThrottle(SimpleRateThrottle):
    rate = "60/min"
    scope = "agency_portal"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class PortalView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [PortalThrottle]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        response["Referrer-Policy"] = "no-referrer"
        response["X-Robots-Tag"] = "noindex, nofollow"
        return response


class PortalCsrfView(PortalView):
    @method_decorator(ensure_csrf_cookie)
    def get(self, request):
        return Response({"csrfToken": get_token(request)})


def locked_link(link_id):
    candidate = (
        AgencyLink.objects.filter(pk=link_id)
        .values("participant__plan_id", "participant__plan__organization_id")
        .first()
    )
    if not candidate:
        raise NotFound("This agency link is unavailable. Ask the coordinator for a new link.")
    org = (
        Organization.objects.select_for_update()
        .filter(
            pk=candidate["participant__plan__organization_id"],
            kind=Organization.Kind.CUSTOMER,
            access_status=Organization.AccessStatus.ACTIVE,
        )
        .first()
    )
    if not org:
        raise NotFound("This agency link is unavailable. Ask the coordinator for a new link.")
    plan = (
        MeasurementPlan.objects.select_for_update()
        .select_related("vessel_call", "organization")
        .get(pk=candidate["participant__plan_id"], organization=org)
    )
    link = (
        AgencyLink.objects.select_for_update(of=("self",))
        .select_related("participant", "submission")
        .get(pk=link_id)
    )
    if link.revoked_at or link.expires_at <= timezone.now():
        raise NotFound(
            "This agency link has expired or was revoked. Ask the coordinator for a new link."
        )
    return link, plan


def get_context(request):
    context_id = (
        request.query_params.get("contextId")
        if request.method == "GET"
        else request.data.get("contextId")
    )
    browser_nonce = request.get_signed_cookie(COOKIE, default="", max_age=30 * 24 * 60 * 60)
    context = (
        AgencyPortalSession.objects.filter(
            pk=context_id, browser_digest=digest(browser_nonce), expires_at__gt=timezone.now()
        ).first()
        if browser_nonce
        else None
    )
    if not context:
        raise NotFound("Reopen your agency link to start a secure session.")
    link, plan = locked_link(context.link_id)
    return context, link, plan


def report_data(submission, *, own):
    result = {
        "id": submission.pk,
        "participantId": submission.participant_id,
        "agencyName": submission.participant.name,
        "agencyRole": submission.participant.role,
        "submittedAt": date_string(submission.recorded_at),
        "status": "submitted",
        "lines": [
            {
                "lineId": item.line_id,
                "quantity": str(item.quantity) if item.quantity is not None else None,
                "status": item.status,
                **({"note": item.note} if own else {}),
            }
            for item in submission.lines.all()
        ],
    }
    if own:
        result.update(
            representative=submission.representative,
            observedAt=date_string(submission.observed_at),
            sourceReference=submission.source_reference,
            notes=submission.notes,
        )
    return result


def context_data(context, link, plan):
    own = link.submission
    rows = []
    for item in plan.lines.all():
        row = cargo_line_data(item)
        row.pop("manifestQuantity")
        row.pop("baselineReference")
        rows.append(row)
    return {
        "contextId": context.pk,
        "inputFingerprint": fingerprint(plan),
        "agency": {
            "id": link.participant_id,
            "name": link.participant.name,
            "role": link.participant.role,
            "representative": link.participant.representative,
        },
        "voyage": {
            key: value
            for key, value in plan_context(plan).items()
            if key in {"vesselName", "callReference", "title", "location", "scheduledAt"}
        },
        "lines": rows,
        "ownReport": report_data(own, own=True) if own else None,
        "completedPeers": [
            report_data(item, own=False)
            for item in latest_submissions(plan)
            if own and item.participant_id != link.participant_id
        ],
    }


class ExchangeSerializer(serializers.Serializer):
    token = serializers.CharField(min_length=40, max_length=128, trim_whitespace=False)


@method_decorator(csrf_protect, name="dispatch")
class PortalExchangeView(PortalView):
    @transaction.atomic
    def post(self, request):
        data = validated(ExchangeSerializer, request)
        link_id = (
            AgencyLink.objects.filter(token_digest=digest(data["token"]))
            .values_list("pk", flat=True)
            .first()
        )
        link, plan = locked_link(link_id)
        if not link.submission_id:
            assert_open(plan)
            if fingerprint(plan) != link.input_fingerprint:
                raise Conflict("This voyage changed. Ask the coordinator for a new agency link.")
        browser_nonce = request.get_signed_cookie(
            COOKIE, default="", max_age=30 * 24 * 60 * 60
        ) or secrets.token_urlsafe(48)
        context = AgencyPortalSession.objects.create(
            link=link, browser_digest=digest(browser_nonce), expires_at=link.expires_at
        )
        response = Response({"contextId": context.pk})
        response.set_signed_cookie(
            COOKIE,
            browser_nonce,
            max_age=30 * 24 * 60 * 60,
            httponly=True,
            secure=settings.SESSION_COOKIE_SECURE,
            samesite="Strict",
            path="/api/agency-portal",
        )
        return response


class PortalContextView(PortalView):
    @transaction.atomic
    def get(self, request):
        context, link, plan = get_context(request)
        return Response({"context": context_data(context, link, plan)})


class GuestSubmissionSerializer(serializers.Serializer):
    contextId = serializers.CharField(max_length=32)
    requestId = serializers.CharField(min_length=1, max_length=100)
    inputFingerprint = serializers.CharField(min_length=64, max_length=64)
    representative = serializers.CharField(max_length=255)
    observedAt = serializers.DateTimeField()
    sourceReference = serializers.CharField(max_length=255)
    notes = serializers.CharField(max_length=10000, allow_blank=True, default="")
    lines = SubmissionLineSerializer(many=True, allow_empty=False)

    def validate_lines(self, value):
        if len(value) > 100:
            raise ValidationError("At most 100 cargo items are allowed")
        return value

    def to_internal_value(self, data):
        if isinstance(data, dict) and set(data) - set(self.fields):
            raise ValidationError({"fields": "Submit only the fields shown in your agency form"})
        return super().to_internal_value(data)


@method_decorator(csrf_protect, name="dispatch")
class PortalSubmissionView(PortalView):
    @transaction.atomic
    def post(self, request):
        data = validated(GuestSubmissionSerializer, request)
        context, link, plan = get_context(request)
        body_digest = digest(json.dumps(data, sort_keys=True, default=str, separators=(",", ":")))
        if link.submission_id:
            if link.request_id != data["requestId"] or link.request_digest != body_digest:
                raise Conflict(
                    "This agency already submitted. Ask the coordinator to record a correction."
                )
            return Response({"context": context_data(context, link, plan)})
        assert_open(plan)
        if (
            data["inputFingerprint"] != link.input_fingerprint
            or fingerprint(plan) != link.input_fingerprint
        ):
            raise Conflict("This voyage changed. Ask the coordinator for a new agency link.")
        if link.participant.submissions.exists():
            raise Conflict("A reading is already recorded for this agency")
        create_submission(
            plan,
            {
                **data,
                "version": plan.version,
                "participantId": link.participant_id,
                "reason": "",
                "evidenceIds": [],
            },
            request,
            guest=True,
        )
        link.submission = link.participant.submissions.latest("revision")
        link.request_id = data["requestId"]
        link.request_digest = body_digest
        link.save(update_fields=["submission", "request_id", "request_digest"])
        return Response({"context": context_data(context, link, plan)}, status=201)


class PortalReceiptView(PortalView):
    content_negotiation_class = PDFDownloadNegotiation

    @transaction.atomic
    def get(self, request):
        _, link, plan = get_context(request)
        if not link.submission_id:
            raise Conflict("Submit your reading before downloading its receipt")
        from .reports import submission_pdf

        response = HttpResponse(
            submission_pdf(plan, link.submission), content_type="application/pdf"
        )
        response["Content-Disposition"] = (
            f'attachment; filename="agency-reading-{link.submission_id}.pdf"'
        )
        return response
