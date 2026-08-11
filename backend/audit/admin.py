from django.contrib import admin

from .models import AuditEvent, PlatformAuditEvent


@admin.register(AuditEvent)
class AuditEventAdmin(admin.ModelAdmin):
    list_display = ("occurred_at", "organization", "actor", "action", "target_type")
    readonly_fields = tuple(field.name for field in AuditEvent._meta.fields)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(PlatformAuditEvent)
class PlatformAuditEventAdmin(admin.ModelAdmin):
    list_display = ("occurred_at", "organization", "actor", "action", "target_type")
    readonly_fields = tuple(field.name for field in PlatformAuditEvent._meta.fields)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
