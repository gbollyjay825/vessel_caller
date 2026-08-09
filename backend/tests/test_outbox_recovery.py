from __future__ import annotations

import logging
from datetime import timedelta
from types import SimpleNamespace

import pytest
from django.utils import timezone

from accounts.models import EmailOutbox
from accounts.services import queue_email
from accounts.tasks import dispatch_pending_outbox
from vessel_caller.celery import (
    OUTBOX_DISPATCH_INTERVAL_SECONDS,
    OUTBOX_DISPATCH_TASK,
    OutboxDispatcherStep,
)


pytestmark = pytest.mark.django_db


def create_outbox(idempotency_key: str, *, status: str = EmailOutbox.Status.PENDING):
    return EmailOutbox.objects.create(
        to_email=f"{idempotency_key}@example.test",
        subject="Outbox recovery test",
        template="invoice",
        context={"ciphertext": "opaque-test-value"},
        idempotency_key=idempotency_key,
        status=status,
    )


def test_broker_publication_failure_leaves_one_encrypted_pending_row_for_recovery(
    monkeypatch,
    caplog,
    django_capture_on_commit_callbacks,
):
    attempts = 0

    def unavailable_broker(*args, **kwargs):
        nonlocal attempts
        del args, kwargs
        attempts += 1
        raise OSError("broker unavailable")

    monkeypatch.setattr(
        "accounts.services.deliver_outbox_email.apply_async",
        unavailable_broker,
    )
    with caplog.at_level(logging.ERROR), django_capture_on_commit_callbacks(execute=True):
        outbox = queue_email(
            to_email="recipient@example.test",
            subject="Invoice status updated",
            template="invoice",
            context={"message": "Private transition context"},
            idempotency_key="broker-gap-event-recipient",
        )

    outbox.refresh_from_db()
    assert attempts == 1
    assert outbox.status == EmailOutbox.Status.PENDING
    assert "ciphertext" in outbox.context
    assert "Private transition context" not in str(outbox.context)
    assert "periodic recovery will retry" in caplog.text

    # An API retry does not create or publish a second row. The periodic
    # dispatcher owns recovery of the original durable record.
    with django_capture_on_commit_callbacks(execute=True):
        repeated = queue_email(
            to_email="recipient@example.test",
            subject="Invoice status updated",
            template="invoice",
            context={"message": "Private transition context"},
            idempotency_key="broker-gap-event-recipient",
        )
    assert repeated.pk == outbox.pk
    assert attempts == 1


def test_dispatcher_selects_pending_and_stale_sending_but_not_terminal_rows(monkeypatch):
    pending = create_outbox("recover-pending")
    stale = create_outbox("recover-stale", status=EmailOutbox.Status.SENDING)
    fresh = create_outbox("ignore-fresh", status=EmailOutbox.Status.SENDING)
    create_outbox("ignore-failed", status=EmailOutbox.Status.FAILED)
    create_outbox("ignore-sent", status=EmailOutbox.Status.SENT)
    EmailOutbox.objects.filter(pk=stale.pk).update(
        updated_at=timezone.now() - timedelta(minutes=11)
    )

    published: list[tuple[str, bool]] = []

    def capture_publish(*, args, retry):
        published.append((args[0], retry))

    monkeypatch.setattr(
        "accounts.tasks.deliver_outbox_email.apply_async",
        capture_publish,
    )

    assert dispatch_pending_outbox() == 2
    assert published == [(str(pending.pk), False), (str(stale.pk), False)]

    # A repeated sweep republishes the same durable IDs rather than deriving
    # new idempotency keys. Delivery and Resend therefore remain idempotent.
    assert dispatch_pending_outbox() == 2
    assert published[2:] == published[:2]
    fresh.refresh_from_db()
    assert fresh.status == EmailOutbox.Status.SENDING


def test_dispatcher_is_bounded_and_stops_after_a_broker_error(monkeypatch, caplog):
    first = create_outbox("bounded-1")
    create_outbox("bounded-2")
    create_outbox("bounded-3")
    monkeypatch.setattr("accounts.tasks.OUTBOX_DISPATCH_BATCH_SIZE", 2)
    attempts: list[str] = []

    def reject_publish(*, args, retry):
        assert retry is False
        attempts.append(args[0])
        raise OSError("broker unavailable")

    monkeypatch.setattr(
        "accounts.tasks.deliver_outbox_email.apply_async",
        reject_publish,
    )
    with caplog.at_level(logging.ERROR):
        assert dispatch_pending_outbox() == 0

    assert attempts == [str(first.pk)]
    assert "a later sweep will retry" in caplog.text
    assert EmailOutbox.objects.filter(status=EmailOutbox.Status.PENDING).count() == 3


class FakeTimerHandle:
    def __init__(self):
        self.cancelled = False

    def cancel(self):
        self.cancelled = True


class FakeTimer:
    def __init__(self):
        self.handle = FakeTimerHandle()
        self.interval = None
        self.callback = None
        self.args = ()
        self.priority = None

    def call_repeatedly(self, interval, callback, *, args, priority):
        self.interval = interval
        self.callback = callback
        self.args = args
        self.priority = priority
        return self.handle


class FakeCeleryApp:
    def __init__(self, *, fail=False):
        self.fail = fail
        self.calls = []

    def send_task(self, name, **options):
        self.calls.append((name, options))
        if self.fail:
            raise OSError("broker unavailable")


def test_worker_bootstep_schedules_short_lived_dispatch_and_cancels_cleanly(caplog):
    timer = FakeTimer()
    celery_app = FakeCeleryApp()
    worker = SimpleNamespace(timer=timer, app=celery_app)
    step = OutboxDispatcherStep(worker)

    step.start(worker)
    assert timer.interval == OUTBOX_DISPATCH_INTERVAL_SECONDS
    assert timer.priority == 10
    assert timer.callback is not None
    timer.callback(*timer.args)
    assert celery_app.calls == [
        (
            OUTBOX_DISPATCH_TASK,
            {"expires": OUTBOX_DISPATCH_INTERVAL_SECONDS, "retry": False},
        )
    ]

    step.stop(worker)
    assert timer.handle.cancelled is True

    failing_app = FakeCeleryApp(fail=True)
    with caplog.at_level(logging.ERROR):
        OutboxDispatcherStep._publish(failing_app)
    assert "Could not publish the periodic email outbox dispatcher" in caplog.text
