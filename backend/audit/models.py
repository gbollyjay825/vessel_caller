from __future__ import annotations

import uuid

from django.db import models


class ImmutableAuditQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise TypeError("Audit events are immutable")

    def delete(self):
        raise TypeError("Audit events are immutable")


class AuditEvent(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization", on_delete=models.PROTECT, related_name="audit_events"
    )
    actor = models.ForeignKey(
        "accounts.User",
        on_delete=models.SET_NULL,
        null=True,
        related_name="audit_events",
    )
    action = models.CharField(max_length=100)
    category = models.CharField(max_length=50)
    target_type = models.CharField(max_length=100, blank=True)
    target_id = models.CharField(max_length=100, blank=True)
    target_label = models.CharField(max_length=255, blank=True)
    request_id = models.CharField(max_length=128, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=512, blank=True)
    before = models.JSONField(null=True, blank=True)
    after = models.JSONField(null=True, blank=True)
    occurred_at = models.DateTimeField(auto_now_add=True)

    objects = ImmutableAuditQuerySet.as_manager()

    class Meta:
        ordering = ("-occurred_at",)
        indexes = [
            models.Index(fields=("organization", "-occurred_at")),
            models.Index(fields=("organization", "action")),
        ]

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise TypeError("Audit events are immutable")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise TypeError("Audit events are immutable")


class PlatformAuditEvent(models.Model):
    """Immutable operator ledger, separate from the tenant-visible audit trail."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.PROTECT,
        related_name="platform_audit_events",
    )
    actor = models.ForeignKey(
        "accounts.User",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="platform_audit_events",
    )
    action = models.CharField(max_length=100)
    target_type = models.CharField(max_length=100, blank=True)
    target_id = models.CharField(max_length=100, blank=True)
    target_label = models.CharField(max_length=255, blank=True)
    reason = models.TextField(blank=True)
    request_id = models.CharField(max_length=128, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.CharField(max_length=512, blank=True)
    before = models.JSONField(null=True, blank=True)
    after = models.JSONField(null=True, blank=True)
    occurred_at = models.DateTimeField(auto_now_add=True)

    objects = ImmutableAuditQuerySet.as_manager()

    class Meta:
        ordering = ("-occurred_at",)
        indexes = [
            models.Index(fields=("organization", "-occurred_at")),
            models.Index(fields=("actor", "-occurred_at")),
            models.Index(fields=("action", "-occurred_at")),
        ]

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise TypeError("Platform audit events are immutable")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise TypeError("Platform audit events are immutable")
