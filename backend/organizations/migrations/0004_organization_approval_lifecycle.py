import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0004_invitation_deliverable"),
        ("organizations", "0003_organization_platform_lifecycle"),
    ]

    operations = [
        migrations.AddField(
            model_name="organization",
            name="approval_reason",
            field=models.TextField(blank=True, db_default=""),
        ),
        migrations.AddField(
            model_name="organization",
            name="approved_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="organization",
            name="approved_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="customer_organizations_approved",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AlterField(
            model_name="organization",
            name="access_status",
            field=models.CharField(
                choices=[
                    ("pending_approval", "Pending approval"),
                    ("active", "Active"),
                    ("suspended", "Suspended"),
                ],
                db_default="active",
                default="active",
                max_length=20,
            ),
        ),
        migrations.RemoveConstraint(
            model_name="organization",
            name="organizations_valid_access_status",
        ),
        migrations.RemoveConstraint(
            model_name="organization",
            name="organizations_valid_suspension_state",
        ),
        migrations.AddConstraint(
            model_name="organization",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("access_status__in", ["pending_approval", "active", "suspended"])
                ),
                name="organizations_valid_access_status",
            ),
        ),
        migrations.AddConstraint(
            model_name="organization",
            constraint=models.CheckConstraint(
                condition=(
                    models.Q(
                        ("access_status__in", ["pending_approval", "active"]),
                        ("suspended_at__isnull", True),
                        ("suspension_reason", ""),
                    )
                    | (
                        models.Q(
                            ("access_status", "suspended"),
                            ("suspended_at__isnull", False),
                        )
                        & ~models.Q(("suspension_reason", ""))
                    )
                ),
                name="organizations_valid_suspension_state",
            ),
        ),
    ]
