from __future__ import annotations

import pytest

from accounts.emailing import _render
from accounts.models import EmailOutbox, User
from accounts.notifications import queue_organization_notice

from .conftest import authenticated


pytestmark = pytest.mark.django_db


def test_rendered_notification_escapes_message_and_rejects_non_https_action_urls():
    html = _render(
        "invoice",
        {
            "message": '<img src=x onerror="alert(1)">',
            "actionUrl": "javascript:alert(1)",
        },
    )

    assert "&lt;img" in html
    assert "javascript:" not in html
    assert "Continue securely" not in html


def test_organization_notice_targets_active_roles_and_excludes_actor(
    admin, operations, finance, viewer
):
    queue_organization_notice(
        organization=admin.organization,
        actor=admin,
        recipient_roles=(User.Role.ADMIN, User.Role.OPERATIONS),
        event_key="call-created:vc-1",
        subject="New vessel call registered",
        message="VC-1 was registered.",
        template="vessel_call",
    )

    notices = EmailOutbox.objects.filter(template="vessel_call")
    assert list(notices.values_list("to_email", flat=True)) == [operations.email]
    assert not notices.filter(to_email=admin.email).exists()
    assert not notices.filter(to_email=finance.email).exists()
    assert not notices.filter(to_email=viewer.email).exists()


def test_organization_notice_can_be_queued_without_an_actor(admin):
    queue_organization_notice(
        organization=admin.organization,
        actor=None,
        recipient_roles=(User.Role.ADMIN,),
        event_key="automated-maintenance:1",
        subject="Automated Vessel Caller maintenance",
        message="A scheduled maintenance event was recorded.",
        template="security_notice",
    )

    assert EmailOutbox.objects.filter(
        to_email=admin.email,
        template="security_notice",
        subject="Automated Vessel Caller maintenance",
    ).exists()


def test_access_mfa_and_removal_queue_security_notices(admin, viewer):
    client = authenticated(admin)

    changed = client.patch(
        f"/api/users/{viewer.id}",
        {"role": User.Role.OPERATIONS, "status": User.Status.SUSPENDED},
        format="json",
    )
    assert changed.status_code == 200
    access_notice = EmailOutbox.objects.get(
        to_email="viewer@acme.test",
        template="security_notice",
        subject="Your Vessel Caller access was updated",
    )
    assert access_notice.status in {EmailOutbox.Status.PENDING, EmailOutbox.Status.SENT}

    reset = client.post(f"/api/users/{viewer.id}/reset-mfa")
    assert reset.status_code == 200
    assert EmailOutbox.objects.filter(
        to_email="viewer@acme.test",
        subject="Your Vessel Caller multi-factor authentication was reset",
    ).exists()

    removed = client.delete(f"/api/users/{viewer.id}")
    assert removed.status_code == 200
    assert EmailOutbox.objects.filter(
        to_email="viewer@acme.test", subject="Your Vessel Caller account was removed"
    ).exists()


def test_operations_and_finance_events_notify_the_relevant_team(admin, operations, finance):
    admin_client = authenticated(admin)
    call = admin_client.post(
        "/api/vessel-calls",
        {"vesselName": "MV Notice", "reference": "ROT-NOTICE", "nrt": 10},
        format="json",
    ).json()["call"]
    assert EmailOutbox.objects.filter(
        to_email=operations.email, template="vessel_call", subject="New vessel call registered"
    ).exists()

    inspection = admin_client.post(
        "/api/inspections",
        {"callId": call["id"], "cargoType": "Liquid", "jetty": {"type": "International"}},
        format="json",
    ).json()["inspection"]
    finalized = admin_client.post(
        f"/api/inspections/{inspection['id']}/finalize", {}, format="json"
    )
    assert finalized.status_code == 200
    invoice = finalized.json()["invoice"]
    assert EmailOutbox.objects.filter(
        to_email=operations.email,
        template="inspection",
        subject="Inspection finalized and invoice created",
    ).exists()
    assert EmailOutbox.objects.filter(
        to_email=finance.email,
        template="inspection",
        subject="Inspection finalized and invoice created",
    ).exists()

    finance_client = authenticated(finance)
    paid = finance_client.post(
        f"/api/invoices/{invoice['id']}/payments",
        {"paidOn": "2026-08-07", "method": "Bank transfer", "reference": "PAY-NOTICE"},
        format="json",
    )
    assert paid.status_code == 201
    assert EmailOutbox.objects.filter(
        to_email=admin.email, template="payment", subject="Invoice payment recorded"
    ).exists()
    assert not EmailOutbox.objects.filter(
        to_email=finance.email, template="payment", subject="Invoice payment recorded"
    ).exists()
