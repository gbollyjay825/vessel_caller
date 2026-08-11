from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("accounts", "0003_email_outbox_organization")]

    operations = [
        migrations.AddField(
            model_name="invitation",
            name="deliverable",
            field=models.BooleanField(db_default=True, default=True),
        ),
    ]
