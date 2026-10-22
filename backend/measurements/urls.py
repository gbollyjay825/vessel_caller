from django.urls import include, path

from .agencies import AgenciesView, AgencyDetailView
from .portal import (
    AgencyLinksView,
    CreateAgencyLinkView,
    RevokeAgencyLinkView,
    PortalCsrfView,
    PortalExchangeView,
    PortalContextView,
    PortalSubmissionView,
    PortalReceiptView,
)
from .reports import (
    MeasurementActivityView,
    SubmissionReceiptView,
    VoyageReadingsView,
    VoyageReadingsDocumentView,
)


from .views import (
    ApprovalView,
    AssessmentView,
    FinalizeView,
    IssueView,
    PlanDetailView,
    PlansView,
    ReconciliationView,
    SubmissionView,
)

urlpatterns = [
    path("measurement-plans", PlansView.as_view(), name="measurement-plans"),
    path(
        "measurement-plans/<str:plan_id>", PlanDetailView.as_view(), name="measurement-plan-detail"
    ),
    path(
        "measurement-plans/<str:plan_id>/submissions",
        SubmissionView.as_view(),
        name="measurement-submissions",
    ),
    path(
        "measurement-plans/<str:plan_id>/reconciliations",
        ReconciliationView.as_view(),
        name="measurement-reconciliations",
    ),
    path(
        "measurement-plans/<str:plan_id>/reconciliations/<str:reconciliation_id>/approvals",
        ApprovalView.as_view(),
        name="measurement-approvals",
    ),
    path(
        "measurement-plans/<str:plan_id>/reconciliations/<str:reconciliation_id>/finalize",
        FinalizeView.as_view(),
        name="measurement-finalize",
    ),
    path(
        "measurement-plans/<str:plan_id>/assessments",
        AssessmentView.as_view(),
        name="measurement-assessments",
    ),
    path(
        "measurement-plans/<str:plan_id>/assessments/<str:assessment_id>/issue",
        IssueView.as_view(),
        name="measurement-issue",
    ),
    path("", include("measurements.evidence_urls")),
]


urlpatterns += [
    path("measurement-activity", MeasurementActivityView.as_view()),
    path("agencies", AgenciesView.as_view()),
    path("agencies/<str:agency_id>", AgencyDetailView.as_view()),
    path("measurement-plans/<str:plan_id>/agency-links", AgencyLinksView.as_view()),
    path(
        "measurement-plans/<str:plan_id>/participants/<str:participant_id>/agency-links",
        CreateAgencyLinkView.as_view(),
    ),
    path(
        "measurement-plans/<str:plan_id>/agency-links/<str:link_id>/revoke",
        RevokeAgencyLinkView.as_view(),
    ),
    path(
        "measurement-plans/<str:plan_id>/submissions/<str:submission_id>/receipt",
        SubmissionReceiptView.as_view(),
    ),
    path("voyages/<str:call_id>/readings", VoyageReadingsView.as_view()),
    path("voyages/<str:call_id>/readings/document", VoyageReadingsDocumentView.as_view()),
    path("agency-portal/csrf", PortalCsrfView.as_view()),
    path("agency-portal/exchange", PortalExchangeView.as_view()),
    path("agency-portal/context", PortalContextView.as_view()),
    path("agency-portal/submission", PortalSubmissionView.as_view()),
    path("agency-portal/receipt", PortalReceiptView.as_view()),
]
