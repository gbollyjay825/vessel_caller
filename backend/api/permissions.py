from __future__ import annotations

from django.conf import settings
from django.db import connection
from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import APIException
from rest_framework.permissions import BasePermission

from accounts.models import User
from accounts.platform_access import active_platform_grant
from organizations.models import Organization

ROLE_PERMISSIONS = {
    "Viewer": {
        "organization.view",
        "calls.view",
        "inspections.view",
        "invoices.view",
        "settings.view",
        "analytics.view",
        "documents.view",
    },
    "Operations": {
        "organization.view",
        "calls.view",
        "calls.manage",
        "inspections.view",
        "inspections.manage",
        "invoices.view",
        "settings.view",
        "analytics.view",
        "documents.view",
        "evidence.manage",
    },
    "Finance": {
        "organization.view",
        "calls.view",
        "inspections.view",
        "invoices.view",
        "invoices.manage",
        "invoices.pay",
        "settings.view",
        "analytics.view",
        "documents.view",
    },
    "Admin": {
        "organization.view",
        "organization.manage",
        "users.view",
        "users.manage",
        "audit.view",
        "audit.export",
        "calls.view",
        "calls.manage",
        "inspections.view",
        "inspections.manage",
        "invoices.view",
        "invoices.manage",
        "invoices.pay",
        "settings.view",
        "settings.manage",
        "analytics.view",
        "documents.view",
        "evidence.manage",
    },
}


def _requires_customer_lifecycle_lock(request, view) -> bool:
    method = getattr(request, "method", "GET").upper()
    return method not in {"GET", "HEAD", "OPTIONS"} or method in getattr(
        view, "lifecycle_capability_methods", frozenset()
    )


def _lock_active_customer_identity(request, view) -> bool:
    """Lock the ACTIVE customer organization, then its ACTIVE request actor."""

    user = getattr(request, "user", None)
    if not user or not user.is_authenticated:
        return False
    if user.organization.kind != Organization.Kind.CUSTOMER:
        return False
    if not _requires_customer_lifecycle_lock(request, view):
        return bool(user.is_active)
    # TenantLifecycleAPIView opens this transaction before DRF permissions.
    # Refuse to mutate or mint a capability if an endpoint omits that guard.
    if not connection.in_atomic_block:
        return False
    organization = (
        Organization.objects.select_for_update()
        .filter(
            pk=user.organization_id,
            kind=Organization.Kind.CUSTOMER,
            access_status=Organization.AccessStatus.ACTIVE,
        )
        .first()
    )
    if not organization:
        return False
    locked_user = (
        User.objects.select_for_update()
        .filter(
            pk=user.pk,
            organization=organization,
            status=User.Status.ACTIVE,
        )
        .first()
    )
    if not locked_user:
        return False
    locked_user.organization = organization
    request.user = locked_user
    request._tenant_lifecycle_locked_organization_id = str(organization.pk)
    return True


class IsActiveAccount(BasePermission):
    def has_permission(self, request, view):
        user = getattr(request, "user", None)
        if not user or not user.is_authenticated or not user.is_active:
            return False
        if user.organization.kind == Organization.Kind.CUSTOMER:
            return _lock_active_customer_identity(request, view)
        return True


def role_definitions() -> list[dict[str, object]]:
    """Return the API role matrix from the same source used for authorization."""
    return [
        {"role": role, "permissions": sorted(ROLE_PERMISSIONS[role])}
        for role in ("Admin", "Operations", "Finance", "Viewer")
    ]


def effective_permissions(user) -> list[str]:
    if not getattr(user, "is_authenticated", False) or not user.is_active:
        return []
    if user.organization.kind != Organization.Kind.CUSTOMER:
        return []
    if user.mfa_enrollment_required:
        return []
    return sorted(ROLE_PERMISSIONS.get(user.role, set()))


class HasVesselPermission(BasePermission):
    required_permission = ""

    def has_permission(self, request, view):
        permission = getattr(view, "required_permission", self.required_permission)
        if not _lock_active_customer_identity(request, view):
            return False
        if getattr(request.user, "mfa_enrollment_required", False):
            return False
        return permission in ROLE_PERMISSIONS.get(getattr(request.user, "role", ""), set())


class IsSystemAdminAccount(BasePermission):
    """Require an explicit operational platform grant, without session assurance."""

    def has_permission(self, request, view):
        user = getattr(request, "user", None)
        if not user or not user.is_authenticated or not user.is_active:
            return False
        if user.is_staff or user.is_superuser:
            return False
        if not user.email_verified_at or user.organization.kind != Organization.Kind.PLATFORM:
            return False
        grant = active_platform_grant(user)
        return bool(grant and user.mfa_enabled)


class IsSystemAdmin(IsSystemAdminAccount):
    """Require a platform grant and an MFA-authenticated session."""

    def has_permission(self, request, view):
        if not super().has_permission(request, view):
            return False
        verified_at = request.session.get("mfa_verified_at")
        if not isinstance(verified_at, (int, float)):
            return False
        return 0 <= timezone.now().timestamp() - verified_at


class RecentSystemMFARequired(APIException):
    status_code = status.HTTP_403_FORBIDDEN
    default_detail = "Recent multi-factor verification is required"
    default_code = "system_mfa_step_up_required"


class IsRecentSystemAdminMFA(IsSystemAdmin):
    def has_permission(self, request, view):
        if not IsSystemAdminAccount.has_permission(self, request, view):
            return False
        verified_at = request.session.get("mfa_verified_at")
        now = timezone.now().timestamp()
        if not isinstance(verified_at, (int, float)) or not (
            0 <= now - verified_at <= settings.SYSTEM_ADMIN_MFA_STEP_UP_SECONDS
        ):
            raise RecentSystemMFARequired()
        return True
