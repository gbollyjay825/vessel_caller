import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0002_platform_access_grant"),
        ("organizations", "0003_organization_platform_lifecycle"),
    ]

    operations = [
        migrations.AddField(
            model_name="emailoutbox",
            name="organization",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="email_outbox",
                to="organizations.organization",
            ),
        ),
        migrations.AddField(
            model_name="emailoutbox",
            name="allow_suspended_organization",
            field=models.BooleanField(db_default=False, default=False),
        ),
    ]
