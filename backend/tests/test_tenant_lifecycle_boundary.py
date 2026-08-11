from __future__ import annotations

import inspect

import pytest
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.test import APIRequestFactory, force_authenticate

from api.operation_views import (
    EvidenceDetailView,
    InvoiceAttachmentDetailView,
    OrganizationLogoView,
)
from api.permissions import HasVesselPermission
from api.tenant_lifecycle import TenantLifecycleAPIView
from api.urls import urlpatterns
from organizations.models import OrganizationSettings


pytestmark = pytest.mark.django_db


def _view_classes():
    for pattern in urlpatterns:
        view_class = getattr(pattern.callback, "view_class", None)
        if view_class is not None:
            yield view_class


def _declares_unsafe_handler(view_class) -> bool:
    return any(method in view_class.__dict__ for method in ("post", "put", "patch", "delete"))


def test_every_customer_api_route_uses_the_shared_lifecycle_boundary():
    """Make future tenant routes fail CI if they omit the common lock wrapper."""

    failures: list[str] = []
    for view_class in set(_view_classes()):
        module = view_class.__module__
        customer_module = module in {
            "api.auth_views",
            "api.operation_views",
            "api.user_views",
        }
        permissions = set(getattr(view_class, "permission_classes", ()))
        tenant_permission = HasVesselPermission in permissions
        if (customer_module and _declares_unsafe_handler(view_class)) or tenant_permission:
            if not issubclass(view_class, TenantLifecycleAPIView):
                failures.append(f"{module}.{view_class.__name__}")
    assert failures == []


def test_every_signed_download_capability_get_declares_the_lifecycle_guard():
    expected = {
        OrganizationLogoView,
        EvidenceDetailView,
        InvoiceAttachmentDetailView,
    }
    discovered = {
        view_class
        for view_class in set(_view_classes())
        if "get" in view_class.__dict__ and "presign_download(" in inspect.getsource(view_class.get)
    }
    assert discovered == expected
    assert all(
        "GET" in getattr(view_class, "lifecycle_capability_methods", frozenset())
        and issubclass(view_class, TenantLifecycleAPIView)
        for view_class in discovered
    )


class _TransactionProbeView(TenantLifecycleAPIView):
    def put(self, request):
        settings = OrganizationSettings.objects.get(pk=request.data["settingsId"])
        settings.port_name = request.data["portName"]
        settings.save(update_fields=("port_name",))
        if request.data.get("fail"):
            raise ValidationError("deliberate handled failure")
        return Response({"portName": settings.port_name})


def test_handled_api_errors_rollback_the_outer_lifecycle_transaction(admin):
    factory = APIRequestFactory()
    view = _TransactionProbeView.as_view()
    settings = admin.organization.settings
    original = settings.port_name

    failed = factory.put(
        "/test/lifecycle-rollback",
        {"settingsId": settings.pk, "portName": "Must Roll Back", "fail": True},
        format="json",
    )
    force_authenticate(failed, user=admin)
    failed_response = view(failed)
    assert failed_response.status_code == 400
    settings.refresh_from_db()
    assert settings.port_name == original

    successful = factory.put(
        "/test/lifecycle-commit",
        {"settingsId": settings.pk, "portName": "Committed Port"},
        format="json",
    )
    force_authenticate(successful, user=admin)
    successful_response = view(successful)
    assert successful_response.status_code == 200
    settings.refresh_from_db()
    assert settings.port_name == "Committed Port"
