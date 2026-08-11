from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin

from organizations.models import Organization

from .models import (
    ActionToken,
    EmailOutbox,
    Invitation,
    MFAChallenge,
    MFARecoveryCode,
    PlatformAccessGrant,
    PlatformMutationRequest,
    User,
    UserSession,
)


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    ordering = ("email",)
    list_display = ("email", "name", "organization", "role", "status", "last_login")
    list_filter = ("role", "status")
    search_fields = ("email", "name")
    fieldsets = (
        (None, {"fields": ("email", "password")}),
        ("Organization", {"fields": ("organization", "name", "role", "status")}),
        ("Security", {"fields": ("email_verified_at", "mfa_enabled_at", "last_login")}),
        ("Django", {"fields": ("is_staff", "is_superuser", "groups", "user_permissions")}),
    )
    add_fieldsets = (
        (None, {"fields": ("email", "name", "organization", "role", "password1", "password2")}),
    )

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("organization")

    @staticmethod
    def _platform_identity(obj) -> bool:
        return bool(obj and obj.organization.kind == Organization.Kind.PLATFORM)

    def has_change_permission(self, request, obj=None):
        if self._platform_identity(obj):
            return False
        return super().has_change_permission(request, obj)

    def has_delete_permission(self, request, obj=None):
        if self._platform_identity(obj):
            return False
        return super().has_delete_permission(request, obj)

    def get_readonly_fields(self, request, obj=None):
        if self._platform_identity(obj):
            return tuple(field.name for field in User._meta.fields)
        return super().get_readonly_fields(request, obj)

    def formfield_for_foreignkey(self, db_field, request, **kwargs):
        if db_field.name == "organization":
            kwargs["queryset"] = Organization.objects.filter(kind=Organization.Kind.CUSTOMER)
        return super().formfield_for_foreignkey(db_field, request, **kwargs)


admin.site.register(Invitation)
admin.site.register(ActionToken)
admin.site.register(UserSession)
admin.site.register(MFAChallenge)
admin.site.register(MFARecoveryCode)
admin.site.register(EmailOutbox)


class ReadOnlySecurityRecordAdmin(admin.ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(PlatformAccessGrant)
class PlatformAccessGrantAdmin(ReadOnlySecurityRecordAdmin):
    list_display = ("user", "role", "granted_at", "expires_at", "revoked_at")
    readonly_fields = tuple(field.name for field in PlatformAccessGrant._meta.fields)


@admin.register(PlatformMutationRequest)
class PlatformMutationRequestAdmin(ReadOnlySecurityRecordAdmin):
    list_display = ("actor", "action", "status", "created_at", "completed_at")
    readonly_fields = tuple(field.name for field in PlatformMutationRequest._meta.fields)
