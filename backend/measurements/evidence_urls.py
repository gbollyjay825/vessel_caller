from django.urls import path

from .documents import ReconciliationDocumentView
from .evidence import (
    MeasurementEvidenceDetailView,
    MeasurementEvidencePresignView,
    MeasurementEvidenceView,
)

urlpatterns = [
    path(
        "measurement-plans/<str:plan_id>/evidence/presign", MeasurementEvidencePresignView.as_view()
    ),
    path("measurement-plans/<str:plan_id>/evidence", MeasurementEvidenceView.as_view()),
    path(
        "measurement-plans/<str:plan_id>/evidence/<str:evidence_id>",
        MeasurementEvidenceDetailView.as_view(),
    ),
    path(
        "measurement-plans/<str:plan_id>/reconciliations/<str:reconciliation_id>/document",
        ReconciliationDocumentView.as_view(),
    ),
]
