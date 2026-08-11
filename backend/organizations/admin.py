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
        "suspended_at",
        "suspension_reason",
        "revision",
        "created_at",
        "updated_at",
    )

    def has_delete_permission(self, request, obj=None):
        return False


admin.site.register(OrganizationSettings)
