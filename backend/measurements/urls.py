from django.urls import include, path

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
