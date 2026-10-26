from django.db import IntegrityError, transaction
from rest_framework import serializers
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response

from api.domain import bump_revision
from audit.services import record_event

from .models import Agency
from .services import Conflict
from .views import MeasurementView, validated


class AgencySerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255)
    role = serializers.CharField(max_length=100)
    representative = serializers.CharField(max_length=255, allow_blank=True, default="")
    active = serializers.BooleanField(default=True)

    def validate(self, attrs):
        for key in ("name", "role", "representative"):
            attrs[key] = " ".join(attrs[key].split())
        return attrs


class AgencyUpdateSerializer(AgencySerializer):
    version = serializers.IntegerField(min_value=1)


def agency_data(agency):
    return {
        "id": agency.pk,
        "name": agency.name,
        "role": agency.role,
        "representative": agency.representative,
        "active": agency.active,
        "version": agency.version,
    }


def record_change(request, agency, before=None):
    bump_revision(agency.organization_id)
    record_event(
        organization=agency.organization,
        actor=request.user,
        action="agency.updated" if before else "agency.created",
        category="measurements",
        target=agency,
        target_label=agency.name,
        request=request,
        before=before,
        after=agency_data(agency),
    )


class AgenciesView(MeasurementView):
    def get_permissions(self):
        self.required_permission = (
            "measurements.view" if self.request.method == "GET" else "settings.manage"
        )
        return super().get_permissions()

    def get(self, request):
        return Response(
            {
                "agencies": [
                    agency_data(item)
                    for item in Agency.objects.filter(organization_id=request.user.organization_id)
                ]
            }
        )

    @transaction.atomic
    def post(self, request):
        data = validated(AgencySerializer, request)
        if Agency.objects.filter(organization_id=request.user.organization_id).count() >= 500:
            raise ValidationError("An organization can have at most 500 agencies")
        try:
            with transaction.atomic():
                agency = Agency.objects.create(
                    organization_id=request.user.organization_id, created_by=request.user, **data
                )
        except IntegrityError as exc:
            raise ValidationError("An agency with this name and role already exists") from exc
        record_change(request, agency)
        return Response({"agency": agency_data(agency)}, status=201)


class AgencyDetailView(MeasurementView):
    required_permission = "settings.manage"

    @transaction.atomic
    def patch(self, request, agency_id):
        data = validated(AgencyUpdateSerializer, request)
        agency = (
            Agency.objects.select_for_update()
            .filter(pk=agency_id, organization_id=request.user.organization_id)
            .first()
        )
        if not agency:
            raise NotFound("Agency not found")
        if data.pop("version") != agency.version:
            raise Conflict("This agency changed. Refresh before editing it.")
        before = agency_data(agency)
        for field, value in data.items():
            setattr(agency, field, value)
        agency.version += 1
        try:
            with transaction.atomic():
                agency.save()
        except IntegrityError as exc:
            raise ValidationError("An agency with this name and role already exists") from exc
        record_change(request, agency, before)
        return Response({"agency": agency_data(agency)})
