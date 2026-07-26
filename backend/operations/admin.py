from django.contrib import admin

from .models import EvidenceAttachment, Inspection, VesselCall

admin.site.register(VesselCall)
admin.site.register(Inspection)
admin.site.register(EvidenceAttachment)
