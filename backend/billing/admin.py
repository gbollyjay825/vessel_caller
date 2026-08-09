from django.contrib import admin

from .models import (
    Invoice,
    InvoiceAttachment,
    InvoiceStatusEvent,
    InvoiceStatusStep,
    NumberSequence,
    Payment,
)

admin.site.register(Invoice)
admin.site.register(Payment)
admin.site.register(NumberSequence)
admin.site.register(InvoiceAttachment)


@admin.register(InvoiceStatusStep)
class InvoiceStatusStepAdmin(admin.ModelAdmin):
    readonly_fields = tuple(field.name for field in InvoiceStatusStep._meta.fields)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(InvoiceStatusEvent)
class InvoiceStatusEventAdmin(admin.ModelAdmin):
    readonly_fields = tuple(field.name for field in InvoiceStatusEvent._meta.fields)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
