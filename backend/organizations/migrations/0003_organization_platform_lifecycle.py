from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("organizations", "0002_add_calabar_berth_terminals")]

    operations = [
        migrations.AddField(
            model_name="organization",
            name="kind",
            field=models.CharField(
                choices=[("customer", "Customer"), ("platform", "Platform")],
                db_default="customer",
                default="customer",
                max_length=20,
            ),
        ),
        migrations.AddField(
            model_name="organization",
            name="access_status",
            field=models.CharField(
                choices=[("active", "Active"), ("suspended", "Suspended")],
                db_default="active",
                default="active",
                max_length=20,
            ),
        ),
        migrations.AddField(
            model_name="organization",
            name="suspended_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="organization",
            name="suspension_reason",
            field=models.TextField(blank=True, db_default=""),
        ),
        migrations.AddConstraint(
            model_name="organization",
            constraint=models.CheckConstraint(
                condition=models.Q(("kind__in", ["customer", "platform"])),
                name="organizations_valid_kind",
            ),
        ),
        migrations.AddConstraint(
            model_name="organization",
            constraint=models.CheckConstraint(
                condition=models.Q(("access_status__in", ["active", "suspended"])),
                name="organizations_valid_access_status",
            ),
        ),
        migrations.AddConstraint(
            model_name="organization",
            constraint=models.UniqueConstraint(
                condition=models.Q(("kind", "platform")),
                fields=("kind",),
                name="organizations_one_platform_container",
            ),
        ),
        migrations.AddConstraint(
            model_name="organization",
            constraint=models.CheckConstraint(
                condition=(
                    models.Q(
                        ("access_status", "active"),
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
