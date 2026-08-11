import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0001_initial"),
        ("organizations", "0003_organization_platform_lifecycle"),
    ]

    operations = [
        migrations.CreateModel(
            name="PlatformAccessGrant",
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
                (
                    "role",
                    models.CharField(
                        choices=[("SystemAdmin", "System administrator")],
                        max_length=32,
                    ),
                ),
                ("reason", models.TextField()),
                ("granted_at", models.DateTimeField(auto_now_add=True)),
                ("expires_at", models.DateTimeField(blank=True, null=True)),
                ("revoked_at", models.DateTimeField(blank=True, null=True)),
                (
                    "granted_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="platform_access_grants_created",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "revoked_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="platform_access_grants_revoked",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="platform_access_grants",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ("-granted_at",),
                "indexes": [
                    models.Index(
                        fields=["role", "revoked_at", "expires_at"],
                        name="accounts_pl_role_a3e35d_idx",
                    )
                ],
                "constraints": [
                    models.UniqueConstraint(
                        condition=models.Q(("revoked_at__isnull", True)),
                        fields=("user", "role"),
                        name="accounts_one_active_platform_grant",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("role", "SystemAdmin")),
                        name="accounts_valid_platform_role",
                    ),
                ],
            },
        ),
        migrations.CreateModel(
            name="PlatformMutationRequest",
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
                ("key", models.CharField(max_length=128)),
                ("action", models.CharField(max_length=120)),
                ("request_hash", models.CharField(max_length=64)),
                (
                    "status",
                    models.CharField(
                        choices=[("pending", "Pending"), ("completed", "Completed")],
                        default="pending",
                        max_length=20,
                    ),
                ),
                ("response_status", models.PositiveSmallIntegerField(blank=True, null=True)),
                ("response_body", models.JSONField(blank=True, null=True)),
                ("completed_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "actor",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="platform_mutation_requests",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "target_organization",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="platform_mutation_requests",
                        to="organizations.organization",
                    ),
                ),
            ],
            options={
                "indexes": [
                    models.Index(
                        fields=["actor", "-created_at"],
                        name="accounts_pl_actor_i_c6f6c6_idx",
                    )
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("actor", "key"),
                        name="accounts_unique_platform_mutation_key",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(("status__in", ["pending", "completed"])),
                        name="accounts_valid_platform_mutation_status",
                    ),
                ],
            },
        ),
    ]
