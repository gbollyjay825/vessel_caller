from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("accounts", "0004_invitation_deliverable")]

    operations = [
        migrations.AddField(
            model_name="emailoutbox",
            name="allow_pending_approval_organization",
            field=models.BooleanField(db_default=False, default=False),
        ),
    ]
