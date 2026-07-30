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
admin.site.register(InvoiceStatusStep)
admin.site.register(InvoiceStatusEvent)
admin.site.register(InvoiceAttachment)
