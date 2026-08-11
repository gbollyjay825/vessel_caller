import logging
import os
from typing import Any

from celery import Celery, bootsteps


log = logging.getLogger(__name__)
OUTBOX_DISPATCH_INTERVAL_SECONDS = 60.0
OUTBOX_DISPATCH_TASK = "accounts.tasks.dispatch_pending_outbox"


class OutboxDispatcherStep(bootsteps.StartStopStep):
    """Periodically ask the active worker to recover durable outbox rows."""

    requires = {"celery.worker.components:Timer"}

    def __init__(self, worker: Any, **kwargs: Any) -> None:
        self._timer: Any | None = None
        super().__init__(worker, **kwargs)

    @staticmethod
    def _publish(celery_app: Celery) -> None:
        try:
            celery_app.send_task(
                OUTBOX_DISPATCH_TASK,
                expires=OUTBOX_DISPATCH_INTERVAL_SECONDS,
                retry=False,
            )
        except Exception:
            log.exception("Could not publish the periodic email outbox dispatcher")

    def start(self, worker: Any) -> None:
        self._timer = worker.timer.call_repeatedly(
            OUTBOX_DISPATCH_INTERVAL_SECONDS,
            self._publish,
            args=(worker.app,),
            priority=10,
        )

    def stop(self, worker: Any) -> None:
        del worker
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None


os.environ.setdefault("DJANGO_SETTINGS_MODULE", "vessel_caller.settings.production")

app = Celery("vessel_caller")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()
app.steps["worker"].add(OutboxDispatcherStep)
