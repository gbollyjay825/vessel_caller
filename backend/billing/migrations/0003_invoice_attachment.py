from django.db import migrations, models
import django.db.models.deletion
import billing.models


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0001_initial"),
        ("billing", "0002_invoice_status_workflow"),
        ("organizations", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="InvoiceAttachment",
            fields=[
                ("id", models.CharField(default=billing.models.invoice_attachment_id, max_length=32, primary_key=True, serialize=False)),
                ("object_key", models.CharField(max_length=1024, unique=True)),
                ("file_name", models.CharField(max_length=255)),
                ("content_type", models.CharField(max_length=100)),
                ("size", models.PositiveBigIntegerField()),
                ("checksum", models.CharField(max_length=128)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("invoice", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="attachments", to="billing.invoice")),
                ("organization", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="invoice_attachments", to="organizations.organization")),
                ("uploaded_by", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="uploaded_invoice_attachments", to="accounts.user")),
            ],
            options={"ordering": ("created_at",)},
        ),
    ]
