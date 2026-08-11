from django.db import migrations, models


DEFAULT_NOTIFICATION_ROLES = ["Admin", "Finance"]


def configure_existing_status_notifications(apps, schema_editor):
    Step = apps.get_model("billing", "InvoiceStatusStep")
    Step.objects.filter(is_paid=False).update(
        notify_on_entry=True,
        notification_roles=DEFAULT_NOTIFICATION_ROLES,
    )
    Step.objects.filter(is_paid=True).update(
        notify_on_entry=False,
        notification_roles=[],
    )


def clear_status_notifications(apps, schema_editor):
    Step = apps.get_model("billing", "InvoiceStatusStep")
    Step.objects.update(notify_on_entry=False, notification_roles=[])


class Migration(migrations.Migration):
    dependencies = [("billing", "0004_director_review_workflow")]

    operations = [
        migrations.AddField(
            model_name="invoicestatusstep",
            name="notification_roles",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="invoicestatusstep",
            name="notify_on_entry",
            field=models.BooleanField(default=False),
        ),
        migrations.RunPython(configure_existing_status_notifications, clear_status_notifications),
    ]
