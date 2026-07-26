from django.contrib import admin

from .models import Invoice, NumberSequence, Payment

admin.site.register(Invoice)
admin.site.register(Payment)
admin.site.register(NumberSequence)
