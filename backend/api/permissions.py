from __future__ import annotations

from rest_framework.permissions import BasePermission

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


def role_definitions() -> list[dict[str, object]]:
    """Return the API role matrix from the same source used for authorization."""
    return [
        {"role": role, "permissions": sorted(ROLE_PERMISSIONS[role])}
        for role in ("Admin", "Operations", "Finance", "Viewer")
    ]


def effective_permissions(user) -> list[str]:
    if not getattr(user, "is_authenticated", False) or not user.is_active:
        return []
    if user.mfa_enrollment_required:
        return []
    return sorted(ROLE_PERMISSIONS.get(user.role, set()))


class HasVesselPermission(BasePermission):
    required_permission = ""

    def has_permission(self, request, view):
        permission = getattr(view, "required_permission", self.required_permission)
        if getattr(request.user, "mfa_enrollment_required", False):
            return False
        return permission in ROLE_PERMISSIONS.get(getattr(request.user, "role", ""), set())
