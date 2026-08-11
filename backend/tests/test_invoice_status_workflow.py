from __future__ import annotations

import importlib
from datetime import date
from decimal import Decimal

import pytest
from django.contrib import admin as django_admin
from django.test import RequestFactory

from accounts.models import EmailOutbox, User
from audit.models import AuditEvent
from billing.models import Invoice, InvoiceStatusEvent, InvoiceStatusStep
from billing.services import (
    active_default_step,
    ensure_default_steps,
    paid_step,
    queue_invoice_status_notification,
    reconcile_payment_status,
    transition_invoice,
    workflow_step_data,
)
from operations.models import Inspection, VesselCall
from organizations.models import Organization
from .conftest import authenticated


pytestmark = pytest.mark.django_db


@pytest.fixture
def invoice(admin):
    steps = {step.code: step for step in ensure_default_steps(admin.organization)}
    call = VesselCall.objects.create(
        organization=admin.organization,
        vessel_name="MV Workflow",
        reference="ROT-WORKFLOW",
        nrt=Decimal("100"),
    )
    inspection = Inspection.objects.create(
        organization=admin.organization,
        vessel_call=call,
        vessel_name=call.vessel_name,
        cargo_type=Inspection.CargoType.LIQUID,
        reference="INS-WORKFLOW",
        reconciled_tonnage=Decimal("100"),
    )
    return Invoice.objects.create(
        organization=admin.organization,
        vessel_call=call,
        inspection=inspection,
        invoice_no="INV-WORKFLOW",
        cargo_type="Liquid",
        issued_on=date(2026, 7, 1),
        due_on=date(2026, 7, 15),
        dues=Decimal("100"),
        rate=Decimal("1"),
        commission_usd=Decimal("3.5"),
        commission_ngn=Decimal("5600"),
        exchange_rate=Decimal("1600"),
        current_status=steps["pending-director-finance-review"],
    )


def test_default_steps_keep_paid_protected_and_terminal(admin):
    steps = {step.code: step for step in ensure_default_steps(admin.organization)}
    assert list(steps) == [
        "pending-director-finance-review",
        "pending-audit-review",
        "pending-md-review",
        "pending-accounts-review",
        "approved",
        "paid",
    ]
    assert steps["paid"].is_paid and steps["paid"].is_terminal and steps["paid"].is_protected
    assert workflow_step_data(None, legacy_status=Invoice.Status.VOID)["label"] == "Void"
    assert workflow_step_data(None)["code"] == ""


def test_director_review_migration_preserves_legacy_history(invoice, admin):
    legacy = InvoiceStatusStep.objects.create(
        organization=admin.organization,
        code="draft",
        label="Draft",
        position=700,
        active=True,
    )
    invoice.current_status = legacy
    invoice.save(update_fields=("current_status",))

    migration = importlib.import_module("billing.migrations.0004_director_review_workflow")
    migration.install_director_review_workflow(importlib.import_module("django.apps").apps, None)

    legacy.refresh_from_db()
    invoice.refresh_from_db()
    assert legacy.active is False
    assert invoice.current_status.code == "pending-director-finance-review"
    event = invoice.status_events.order_by("-created_at", "-id").first()
    assert event is not None
    assert event.from_code == "draft"
    assert event.to_code == "pending-director-finance-review"


def test_only_admin_can_configure_invoice_steps(admin, finance, viewer):
    body = {"label": "Awaiting documents"}
    assert (
        authenticated(viewer).post("/api/invoice-status-steps", body, format="json").status_code
        == 403
    )
    assert (
        authenticated(finance).post("/api/invoice-status-steps", body, format="json").status_code
        == 403
    )
    response = authenticated(admin).post("/api/invoice-status-steps", body, format="json")
    assert response.status_code == 201
    assert response.data["step"]["code"] == "awaiting-documents"
    assert (
        authenticated(admin)
        .post("/api/invoice-status-steps", {"label": "No", "code": "paid"}, format="json")
        .status_code
        == 400
    )


def test_invoice_status_steps_are_visible_to_readers_and_reject_duplicate_codes(admin, viewer):
    admin_client = authenticated(admin)
    created = admin_client.post(
        "/api/invoice-status-steps", {"label": "Awaiting documents"}, format="json"
    )
    assert created.status_code == 201
    assert (
        admin_client.post(
            "/api/invoice-status-steps",
            {"label": "Another label", "code": created.data["step"]["code"]},
            format="json",
        ).status_code
        == 400
    )
    visible = authenticated(viewer).get("/api/invoice-status-steps")
    assert visible.status_code == 200
    assert any(step["id"] == created.data["step"]["id"] for step in visible.data["steps"])


def test_finance_can_transition_non_paid_status_but_not_paid(invoice, finance):
    steps = {step.code: step for step in ensure_default_steps(finance.organization)}
    client = authenticated(finance)
    response = client.patch(
        f"/api/invoices/{invoice.id}/status",
        {"statusId": steps["pending-audit-review"].id},
        format="json",
    )
    assert response.status_code == 200
    invoice.refresh_from_db()
    assert (
        invoice.status == Invoice.Status.UNPAID
        and invoice.current_status_id == steps["pending-audit-review"].id
    )
    assert (
        client.patch(
            f"/api/invoices/{invoice.id}/status", {"statusId": steps["paid"].id}, format="json"
        ).status_code
        == 400
    )


def test_payment_marks_paid_and_reversal_restores_last_active_non_paid_status(invoice, finance):
    steps = {step.code: step for step in ensure_default_steps(finance.organization)}
    client = authenticated(finance)
    assert (
        client.patch(
            f"/api/invoices/{invoice.id}/status",
            {"statusId": steps["pending-audit-review"].id},
            format="json",
        ).status_code
        == 200
    )
    paid = client.post(
        f"/api/invoices/{invoice.id}/payments",
        {
            "amount": "100",
            "paidOn": "2026-07-02",
            "method": "Bank transfer",
            "reference": "PAY-WORKFLOW",
        },
        format="json",
    )
    assert paid.status_code == 201
    invoice.refresh_from_db()
    assert invoice.status == Invoice.Status.PAID and invoice.current_status_id == steps["paid"].id
    reversed_payment = client.post(
        f"/api/payments/{paid.data['payment']['id']}/reverse",
        {"reason": "Duplicate transfer"},
        format="json",
    )
    assert reversed_payment.status_code == 200
    invoice.refresh_from_db()
    assert (
        invoice.status == Invoice.Status.UNPAID
        and invoice.current_status_id == steps["pending-audit-review"].id
    )
    assert list(invoice.status_events.values_list("to_code", flat=True)) == [
        "pending-audit-review",
        "paid",
        "pending-audit-review",
    ]


def test_workflow_service_noop_void_and_default_fallback(invoice, admin):
    steps = {step.code: step for step in ensure_default_steps(admin.organization)}
    assert (
        transition_invoice(
            invoice, steps["pending-director-finance-review"], source="manual", actor=admin
        )
        is None
    )
    # An unpaid invoice already assigned to an active non-paid stage should
    # retain its status when an unrelated payment reconciliation occurs.
    assert reconcile_payment_status(invoice, actor=admin, source="payment") is None
    invoice.status = Invoice.Status.VOID
    invoice.save(update_fields=("status",))
    assert reconcile_payment_status(invoice, actor=admin, source="reversal") is None
    invoice.status = Invoice.Status.PAID
    invoice.current_status = steps["paid"]
    invoice.save(update_fields=("status", "current_status"))
    assert reconcile_payment_status(invoice, actor=admin, source="reversal") is not None
    invoice.refresh_from_db()
    assert invoice.current_status_id == active_default_step(admin.organization_id).id


def test_paid_step_requires_the_protected_paid_configuration(admin, monkeypatch):
    InvoiceStatusStep.objects.filter(organization=admin.organization, is_paid=True).delete()
    monkeypatch.setattr("billing.services.ensure_default_steps", lambda _organization: [])
    with pytest.raises(ValueError, match="Paid"):
        paid_step(admin.organization_id)


def test_admin_can_update_and_reorder_steps_but_cannot_change_paid(admin):
    client = authenticated(admin)
    steps = {step.code: step for step in ensure_default_steps(admin.organization)}
    created = client.post(
        "/api/invoice-status-steps",
        {"label": "Awaiting documents"},
        format="json",
    )
    assert created.status_code == 201
    created_id = created.data["step"]["id"]

    updated = client.patch(
        f"/api/invoice-status-steps/{created_id}",
        {"label": "Documents received", "active": False},
        format="json",
    )
    assert updated.status_code == 200
    assert updated.data["step"]["label"] == "Documents received"
    assert updated.data["step"]["active"] is False
    assert (
        client.patch(
            f"/api/invoice-status-steps/{steps['paid'].id}",
            {"label": "Settled"},
            format="json",
        ).status_code
        == 400
    )
    assert (
        client.patch(
            "/api/invoice-status-steps/iss-missing",
            {"label": "Missing"},
            format="json",
        ).status_code
        == 404
    )

    all_steps = list(ensure_default_steps(admin.organization))
    assert any(step.id == created_id for step in all_steps)
    ids = [step.id for step in all_steps]
    assert (
        client.post(
            "/api/invoice-status-steps/reorder", {"ids": ids[:-1] + [ids[0]]}, format="json"
        ).status_code
        == 400
    )
    paid_id = steps["paid"].id
    reordered_ids = [paid_id] + [step_id for step_id in ids if step_id != paid_id]
    assert (
        client.post(
            "/api/invoice-status-steps/reorder", {"ids": reordered_ids}, format="json"
        ).status_code
        == 400
    )
    valid_ids = [step_id for step_id in ids if step_id != paid_id] + [paid_id]
    reordered = client.post("/api/invoice-status-steps/reorder", {"ids": valid_ids}, format="json")
    assert reordered.status_code == 200
    assert [step["id"] for step in reordered.data["steps"]] == valid_ids


def test_invoice_transition_rejects_missing_void_and_inactive_step(invoice, admin):
    client = authenticated(admin)
    steps = {step.code: step for step in ensure_default_steps(admin.organization)}
    assert (
        client.patch(
            "/api/invoices/iv-missing/status",
            {"statusId": steps["pending-director-finance-review"].id},
            format="json",
        ).status_code
        == 404
    )
    inactive = client.post(
        "/api/invoice-status-steps",
        {"label": "On hold", "active": False},
        format="json",
    )
    assert inactive.status_code == 201
    assert (
        client.patch(
            f"/api/invoices/{invoice.id}/status",
            {"statusId": inactive.data["step"]["id"]},
            format="json",
        ).status_code
        == 400
    )
    invoice.status = Invoice.Status.VOID
    invoice.save(update_fields=("status",))
    assert (
        client.patch(
            f"/api/invoices/{invoice.id}/status",
            {"statusId": steps["pending-director-finance-review"].id},
            format="json",
        ).status_code
        == 409
    )


def test_notification_defaults_and_migration_policy(admin):
    steps = {step.code: step for step in ensure_default_steps(admin.organization)}
    for step in steps.values():
        if step.is_paid:
            assert step.notify_on_entry is False
            assert step.notification_roles == []
        else:
            assert step.notify_on_entry is True
            assert step.notification_roles == [User.Role.ADMIN, User.Role.FINANCE]

    InvoiceStatusStep.objects.filter(organization=admin.organization).update(
        notify_on_entry=False,
        notification_roles=[],
    )
    migration = importlib.import_module("billing.migrations.0005_invoice_status_notifications")
    migration.configure_existing_status_notifications(
        importlib.import_module("django.apps").apps, None
    )

    for step in InvoiceStatusStep.objects.filter(organization=admin.organization):
        if step.is_paid:
            assert step.notify_on_entry is False
            assert step.notification_roles == []
        else:
            assert step.notify_on_entry is True
            assert step.notification_roles == [User.Role.ADMIN, User.Role.FINANCE]


def test_admin_configures_canonical_notification_policy_and_api_exposes_it(admin, finance, viewer):
    client = authenticated(admin)
    step = ensure_default_steps(admin.organization)[0]

    for user in (finance, viewer):
        assert (
            authenticated(user)
            .patch(
                f"/api/invoice-status-steps/{step.id}",
                {"notifyOnEntry": False, "notificationRoles": []},
                format="json",
            )
            .status_code
            == 403
        )

    invalid_payloads = (
        {"label": "No recipients", "notifyOnEntry": True, "notificationRoles": []},
        {
            "label": "Invalid role",
            "notifyOnEntry": True,
            "notificationRoles": ["admin"],
        },
        {
            "label": "Duplicate role",
            "notifyOnEntry": True,
            "notificationRoles": [User.Role.ADMIN, User.Role.ADMIN],
        },
    )
    for payload in invalid_payloads:
        assert client.post("/api/invoice-status-steps", payload, format="json").status_code == 400

    default_created = client.post(
        "/api/invoice-status-steps", {"label": "Silent custom step"}, format="json"
    )
    assert default_created.status_code == 201
    assert default_created.data["step"]["notifyOnEntry"] is False
    assert default_created.data["step"]["notificationRoles"] == []

    configured = client.post(
        "/api/invoice-status-steps",
        {
            "label": "Notify custom step",
            "notifyOnEntry": True,
            "notificationRoles": [User.Role.VIEWER, User.Role.ADMIN],
        },
        format="json",
    )
    assert configured.status_code == 201
    assert configured.data["step"]["notifyOnEntry"] is True
    assert configured.data["step"]["notificationRoles"] == [
        User.Role.ADMIN,
        User.Role.VIEWER,
    ]

    visible = authenticated(viewer).get("/api/invoice-status-steps")
    configured_output = next(
        item for item in visible.data["steps"] if item["id"] == configured.data["step"]["id"]
    )
    assert configured_output["notifyOnEntry"] is True
    assert configured_output["notificationRoles"] == [User.Role.ADMIN, User.Role.VIEWER]

    other_organization = Organization.objects.create(name="Other Shipping")
    other_admin = User.objects.create_user(
        email="admin@other-shipping.test",
        password="Other-admin-password-2026!",
        organization=other_organization,
        name="Other Admin",
        role=User.Role.ADMIN,
        status=User.Status.ACTIVE,
    )
    assert (
        authenticated(other_admin)
        .patch(
            f"/api/invoice-status-steps/{step.id}",
            {"notifyOnEntry": False},
            format="json",
        )
        .status_code
        == 404
    )


def test_paid_allows_notification_only_updates_with_audit_and_noop_detection(admin):
    client = authenticated(admin)
    paid = paid_step(admin.organization_id)
    starting_revision = admin.organization.revision

    updated = client.patch(
        f"/api/invoice-status-steps/{paid.id}",
        {
            "notifyOnEntry": True,
            "notificationRoles": [User.Role.VIEWER, User.Role.ADMIN],
        },
        format="json",
    )
    assert updated.status_code == 200
    assert updated.data["step"]["notificationRoles"] == [User.Role.ADMIN, User.Role.VIEWER]
    assert updated.data["rev"] == starting_revision + 1

    audit = AuditEvent.objects.get(
        action="invoice_status_step.updated",
        target_id=paid.id,
    )
    assert isinstance(audit.before, dict)
    assert isinstance(audit.after, dict)
    assert audit.before["notifyOnEntry"] is False
    assert audit.before["notificationRoles"] == []
    assert audit.after["notifyOnEntry"] is True
    assert audit.after["notificationRoles"] == [User.Role.ADMIN, User.Role.VIEWER]

    audit_count = AuditEvent.objects.filter(action="invoice_status_step.updated").count()
    noop = client.patch(
        f"/api/invoice-status-steps/{paid.id}",
        {
            "notifyOnEntry": True,
            "notificationRoles": [User.Role.VIEWER, User.Role.ADMIN],
        },
        format="json",
    )
    assert noop.status_code == 200
    assert noop.data["rev"] == updated.data["rev"]
    assert AuditEvent.objects.filter(action="invoice_status_step.updated").count() == audit_count

    assert (
        client.patch(
            f"/api/invoice-status-steps/{paid.id}",
            {"notificationRoles": []},
            format="json",
        ).status_code
        == 400
    )
    for protected_change in ({"label": "Settled"}, {"active": False}):
        assert (
            client.patch(
                f"/api/invoice-status-steps/{paid.id}",
                protected_change,
                format="json",
            ).status_code
            == 400
        )


def test_status_notice_targets_active_roles_excludes_actor_and_is_event_idempotent(
    invoice,
    admin,
    operations,
    finance,
    viewer,
    django_capture_on_commit_callbacks,
):
    client = authenticated(admin)
    steps = {step.code: step for step in ensure_default_steps(admin.organization)}
    target = steps["pending-audit-review"]
    configured = client.patch(
        f"/api/invoice-status-steps/{target.id}",
        {
            "notifyOnEntry": True,
            "notificationRoles": [
                User.Role.VIEWER,
                User.Role.OPERATIONS,
                User.Role.FINANCE,
                User.Role.ADMIN,
            ],
        },
        format="json",
    )
    assert configured.status_code == 200

    viewer.status = User.Status.SUSPENDED
    viewer.save(update_fields=("status", "updated_at"))
    User.objects.create_user(
        email="invited-operations@acme.test",
        password="Invited-operations-password-2026!",
        organization=admin.organization,
        name="Invited Operations",
        role=User.Role.OPERATIONS,
        status=User.Status.INVITED,
    )

    with django_capture_on_commit_callbacks(execute=False):
        response = client.patch(
            f"/api/invoices/{invoice.id}/status",
            {"statusId": target.id},
            format="json",
        )
    assert response.status_code == 200
    event = InvoiceStatusEvent.objects.get(invoice=invoice, to_step=target)
    notices = EmailOutbox.objects.filter(
        template="invoice",
        subject="Invoice status updated",
    )
    assert set(notices.values_list("to_email", flat=True)) == {operations.email, finance.email}
    assert notices.count() == 2
    assert all(set(item.context) == {"ciphertext"} for item in notices)
    assert all(invoice.invoice_no not in str(item.context) for item in notices)

    queue_invoice_status_notification(event)
    queue_invoice_status_notification(event)
    assert notices.count() == 2

    event_count = invoice.status_events.count()
    assert (
        client.patch(
            f"/api/invoices/{invoice.id}/status",
            {"statusId": target.id},
            format="json",
        ).status_code
        == 200
    )
    assert invoice.status_events.count() == event_count
    assert notices.count() == 2


def test_disabled_policy_and_sole_actor_enqueue_nothing(invoice, admin):
    client = authenticated(admin)
    steps = {step.code: step for step in ensure_default_steps(admin.organization)}
    disabled = steps["pending-audit-review"]
    assert (
        client.patch(
            f"/api/invoice-status-steps/{disabled.id}",
            {"notifyOnEntry": False, "notificationRoles": [User.Role.FINANCE]},
            format="json",
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/invoices/{invoice.id}/status",
            {"statusId": disabled.id},
            format="json",
        ).status_code
        == 200
    )
    assert not EmailOutbox.objects.filter(subject="Invoice status updated").exists()

    actor_only = steps["pending-md-review"]
    assert (
        client.patch(
            f"/api/invoice-status-steps/{actor_only.id}",
            {"notifyOnEntry": True, "notificationRoles": [User.Role.ADMIN]},
            format="json",
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/invoices/{invoice.id}/status",
            {"statusId": actor_only.id},
            format="json",
        ).status_code
        == 200
    )
    assert not EmailOutbox.objects.filter(subject="Invoice status updated").exists()


def test_payment_status_notices_partial_paid_reversal_and_replays(
    invoice, admin, operations, finance
):
    admin_client = authenticated(admin)
    finance_client = authenticated(finance)
    steps = {step.code: step for step in ensure_default_steps(admin.organization)}
    initial = steps["pending-director-finance-review"]
    paid = steps["paid"]
    assert (
        admin_client.patch(
            f"/api/invoice-status-steps/{initial.id}",
            {
                "notifyOnEntry": True,
                "notificationRoles": [User.Role.ADMIN, User.Role.OPERATIONS],
            },
            format="json",
        ).status_code
        == 200
    )
    assert (
        admin_client.patch(
            f"/api/invoice-status-steps/{paid.id}",
            {"notifyOnEntry": True, "notificationRoles": [User.Role.ADMIN]},
            format="json",
        ).status_code
        == 200
    )

    partial = finance_client.post(
        f"/api/invoices/{invoice.id}/payments",
        {
            "amount": "40",
            "paidOn": "2026-07-02",
            "method": "Bank transfer",
            "reference": "PAY-PARTIAL-NOTICE",
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="payment-partial-notice",
    )
    assert partial.status_code == 201
    assert not EmailOutbox.objects.filter(subject="Invoice status updated").exists()
    assert invoice.status_events.count() == 0

    full_payload = {
        "amount": "60",
        "paidOn": "2026-07-03",
        "method": "Bank transfer",
        "reference": "PAY-FULL-NOTICE",
    }
    full = finance_client.post(
        f"/api/invoices/{invoice.id}/payments",
        full_payload,
        format="json",
        HTTP_IDEMPOTENCY_KEY="payment-full-notice",
    )
    assert full.status_code == 201
    invoice.refresh_from_db()
    assert invoice.status == Invoice.Status.PAID
    assert (
        EmailOutbox.objects.filter(
            to_email=admin.email,
            subject="Invoice status updated",
        ).count()
        == 1
    )
    assert EmailOutbox.objects.filter(subject="Invoice payment recorded").count() == 2

    blocked = finance_client.patch(
        f"/api/invoices/{invoice.id}/status",
        {"statusId": steps["pending-audit-review"].id},
        format="json",
    )
    assert blocked.status_code == 409
    assert invoice.status_events.count() == 1

    replay = finance_client.post(
        f"/api/invoices/{invoice.id}/payments",
        full_payload,
        format="json",
        HTTP_IDEMPOTENCY_KEY="payment-full-notice",
    )
    assert replay.status_code == 200
    assert EmailOutbox.objects.filter(subject="Invoice status updated").count() == 1
    assert EmailOutbox.objects.filter(subject="Invoice payment recorded").count() == 2

    reversal = finance_client.post(
        f"/api/payments/{full.data['payment']['id']}/reverse",
        {"reason": "Duplicate partial allocation"},
        format="json",
    )
    assert reversal.status_code == 200
    invoice.refresh_from_db()
    assert invoice.status == Invoice.Status.UNPAID
    assert invoice.current_status_id == initial.id
    status_recipients = list(
        EmailOutbox.objects.filter(subject="Invoice status updated")
        .order_by("created_at")
        .values_list("to_email", flat=True)
    )
    assert status_recipients.count(admin.email) == 2
    assert status_recipients.count(operations.email) == 1
    assert len(status_recipients) == 3
    assert EmailOutbox.objects.filter(subject="Invoice payment reversed").count() == 1

    repeated_reversal = finance_client.post(
        f"/api/payments/{full.data['payment']['id']}/reverse",
        {"reason": "Repeated request"},
        format="json",
    )
    assert repeated_reversal.status_code == 200
    assert EmailOutbox.objects.filter(subject="Invoice status updated").count() == 3
    assert EmailOutbox.objects.filter(subject="Invoice payment reversed").count() == 1


def test_cannot_deactivate_last_non_paid_step_and_reversal_retains_safe_fallback(
    invoice, admin, finance
):
    steps = list(ensure_default_steps(admin.organization))
    fallback = next(step for step in steps if not step.is_paid and not step.is_terminal)
    InvoiceStatusStep.objects.filter(organization=admin.organization).exclude(
        pk=fallback.pk
    ).filter(
        is_paid=False,
        is_terminal=False,
    ).update(active=False)

    response = authenticated(admin).patch(
        f"/api/invoice-status-steps/{fallback.id}",
        {"active": False},
        format="json",
    )
    assert response.status_code == 400
    fallback.refresh_from_db()
    assert fallback.active is True

    payment = authenticated(finance).post(
        f"/api/invoices/{invoice.id}/payments",
        {
            "amount": "100",
            "paidOn": "2026-07-05",
            "method": "Bank transfer",
            "reference": "PAY-LAST-FALLBACK",
        },
        format="json",
    )
    assert payment.status_code == 201
    reversal = authenticated(finance).post(
        f"/api/payments/{payment.data['payment']['id']}/reverse",
        {"reason": "Fallback verification"},
        format="json",
    )
    assert reversal.status_code == 200
    invoice.refresh_from_db()
    assert invoice.current_status_id == fallback.id


def test_invoice_status_events_are_immutable(invoice, admin):
    steps = {step.code: step for step in ensure_default_steps(admin.organization)}
    event = transition_invoice(
        invoice,
        steps["pending-audit-review"],
        source=InvoiceStatusEvent.Source.MANUAL,
        actor=admin,
    )
    assert event is not None

    event.note = "Tampered"
    with pytest.raises(TypeError, match="immutable"):
        event.save()
    with pytest.raises(TypeError, match="immutable"):
        InvoiceStatusEvent.objects.filter(pk=event.pk).update(note="Tampered")
    with pytest.raises(TypeError, match="immutable"):
        InvoiceStatusEvent.objects.filter(pk=event.pk).delete()
    with pytest.raises(TypeError, match="immutable"):
        event.delete()


def test_invoice_status_workflow_django_admin_is_read_only():
    request = RequestFactory().get("/staff/")
    for model in (InvoiceStatusStep, InvoiceStatusEvent):
        model_admin = django_admin.site._registry[model]
        assert model_admin.has_add_permission(request) is False
        assert model_admin.has_change_permission(request) is False
        assert model_admin.has_delete_permission(request) is False


def test_transition_service_rejects_cross_organization_and_inactive_steps(invoice, admin):
    other_organization = Organization.objects.create(name="Other Workflow Organization")
    other_step = InvoiceStatusStep.objects.create(
        organization=other_organization,
        code="other-review",
        label="Other Review",
        position=10,
    )
    with pytest.raises(ValueError, match="another organization"):
        transition_invoice(
            invoice,
            other_step,
            source=InvoiceStatusEvent.Source.MANUAL,
            actor=admin,
        )

    own_step = ensure_default_steps(admin.organization)[1]
    own_step.active = False
    own_step.save(update_fields=("active", "updated_at"))
    with pytest.raises(ValueError, match="active"):
        transition_invoice(
            invoice,
            own_step,
            source=InvoiceStatusEvent.Source.MANUAL,
            actor=admin,
        )
    assert invoice.status_events.count() == 0
    assert not EmailOutbox.objects.filter(subject="Invoice status updated").exists()
