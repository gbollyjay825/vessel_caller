import pytest

from audit.models import AuditEvent
from audit.services import record_event

pytestmark = pytest.mark.django_db


def test_audit_events_are_immutable(admin):
    event = record_event(
        organization=admin.organization,
        actor=admin,
        action="test.event",
        category="test",
        target=admin,
        before={"password": "secret"},
    )
    assert event.before["password"] == "[REDACTED]"
    event.action = "changed"
    with pytest.raises(TypeError):
        event.save()
    with pytest.raises(TypeError):
        AuditEvent.objects.filter(pk=event.pk).delete()
