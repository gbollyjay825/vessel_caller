from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin

from .models import (
    ActionToken,
    EmailOutbox,
    Invitation,
    MFAChallenge,
    MFARecoveryCode,
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


admin.site.register(Invitation)
admin.site.register(ActionToken)
admin.site.register(UserSession)
admin.site.register(MFAChallenge)
admin.site.register(MFARecoveryCode)
admin.site.register(EmailOutbox)
