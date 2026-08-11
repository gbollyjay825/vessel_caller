import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("audit", "0001_initial"),
        ("accounts", "0002_platform_access_grant"),
        ("organizations", "0003_organization_platform_lifecycle"),
    ]

    operations = [
        migrations.CreateModel(
            name="PlatformAuditEvent",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("action", models.CharField(max_length=100)),
                ("target_type", models.CharField(blank=True, max_length=100)),
                ("target_id", models.CharField(blank=True, max_length=100)),
                ("target_label", models.CharField(blank=True, max_length=255)),
                ("reason", models.TextField(blank=True)),
                ("request_id", models.CharField(blank=True, max_length=128)),
                ("ip_address", models.GenericIPAddressField(blank=True, null=True)),
                ("user_agent", models.CharField(blank=True, max_length=512)),
                ("before", models.JSONField(blank=True, null=True)),
                ("after", models.JSONField(blank=True, null=True)),
                ("occurred_at", models.DateTimeField(auto_now_add=True)),
                (
                    "actor",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="platform_audit_events",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "organization",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="platform_audit_events",
                        to="organizations.organization",
                    ),
                ),
            ],
            options={
                "ordering": ("-occurred_at",),
                "indexes": [
                    models.Index(
                        fields=["organization", "-occurred_at"],
                        name="audit_platf_organiz_9f5762_idx",
                    ),
                    models.Index(
                        fields=["actor", "-occurred_at"],
                        name="audit_platf_actor_i_7171ee_idx",
                    ),
                    models.Index(
                        fields=["action", "-occurred_at"],
                        name="audit_platf_action_62ee61_idx",
                    ),
                ],
            },
        )
    ]
