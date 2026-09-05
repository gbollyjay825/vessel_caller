from django.contrib import admin

from .models import Organization, OrganizationSettings


@admin.register(Organization)
class OrganizationAdmin(admin.ModelAdmin):
    list_display = ("name", "kind", "access_status", "registered", "created_at")
    list_filter = ("kind", "access_status", "registered")
    search_fields = ("id", "name", "email", "rc_number")
    readonly_fields = (
        "kind",
        "access_status",
        "registered",
        "approved_at",
        "approved_by",
        "approval_reason",
        "suspended_at",
        "suspension_reason",
        "revision",
        "created_at",
        "updated_at",
    )

    def has_delete_permission(self, request, obj=None):
        return False

    def has_add_permission(self, request):
        # Customer onboarding must pass through the audited product workflow;
        # a Django staff form would otherwise default straight to ACTIVE.
        return False


admin.site.register(OrganizationSettings)
