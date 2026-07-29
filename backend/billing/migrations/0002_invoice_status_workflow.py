from django.db import migrations, models
import django.db.models.deletion
import billing.models


DEFAULT_STEPS = (
    ("draft", "Draft", 10, False, False, False),
    ("submitted", "Submitted", 20, False, False, False),
    ("under-review", "Under Review", 30, False, False, False),
    ("approved", "Approved", 40, False, False, False),
    ("paid", "Paid", 50, True, True, True),
)


def seed_status_workflow(apps, schema_editor):
    Organization = apps.get_model("organizations", "Organization")
    Invoice = apps.get_model("billing", "Invoice")
    Step = apps.get_model("billing", "InvoiceStatusStep")
    Event = apps.get_model("billing", "InvoiceStatusEvent")
    for organization in Organization.objects.all().iterator():
        steps = {}
        for code, label, position, is_paid, is_terminal, is_protected in DEFAULT_STEPS:
            step, _ = Step.objects.get_or_create(
                organization_id=organization.id,
                code=code,
                defaults={
                    "label": label,
                    "position": position,
                    "active": True,
                    "is_paid": is_paid,
                    "is_terminal": is_terminal,
                    "is_protected": is_protected,
                },
            )
            steps[code] = step
        for invoice in Invoice.objects.filter(organization_id=organization.id).iterator():
            if invoice.status == "paid":
                step = steps["paid"]
            elif invoice.status == "void":
                step = None
            else:
                step = steps["draft"]
            Invoice.objects.filter(pk=invoice.pk).update(current_status_id=step.id if step else None)
            Event.objects.get_or_create(
                invoice_id=invoice.id,
                defaults={
                    "from_step_id": None,
                    "to_step_id": step.id if step else None,
                    "from_code": "",
                    "from_label": "",
                    "to_code": step.code if step else "void",
                    "to_label": step.label if step else "Void",
                    "source": "migration",
                    "note": "Legacy invoice status backfill",
                },
            )


class Migration(migrations.Migration):
    dependencies = [("billing", "0001_initial")]

    operations = [
        migrations.CreateModel(
            name="InvoiceStatusStep",
            fields=[
                ("id", models.CharField(default=billing.models.invoice_status_step_id, max_length=32, primary_key=True, serialize=False)),
                ("code", models.SlugField(max_length=50)),
                ("label", models.CharField(max_length=80)),
                ("position", models.PositiveSmallIntegerField()),
                ("active", models.BooleanField(default=True)),
                ("is_paid", models.BooleanField(default=False)),
                ("is_terminal", models.BooleanField(default=False)),
                ("is_protected", models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("organization", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="invoice_status_steps", to="organizations.organization")),
            ],
            options={"ordering": ("position", "created_at")},
        ),
        migrations.AddConstraint(
            model_name="invoicestatusstep",
            constraint=models.UniqueConstraint(fields=("organization", "code"), name="billing_unique_invoice_status_code"),
        ),
        migrations.AddConstraint(
            model_name="invoicestatusstep",
            constraint=models.UniqueConstraint(fields=("organization", "position"), name="billing_unique_invoice_status_position"),
        ),
        migrations.AddField(
            model_name="invoice",
            name="current_status",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="current_invoices", to="billing.invoicestatusstep"),
        ),
        migrations.CreateModel(
            name="InvoiceStatusEvent",
            fields=[
                ("id", models.CharField(default=billing.models.invoice_status_event_id, max_length=32, primary_key=True, serialize=False)),
                ("from_code", models.CharField(blank=True, max_length=50)),
                ("from_label", models.CharField(blank=True, max_length=80)),
                ("to_code", models.CharField(max_length=50)),
                ("to_label", models.CharField(max_length=80)),
                ("source", models.CharField(choices=[("migration", "Migration"), ("created", "Created"), ("manual", "Manual transition"), ("payment", "Payment reconciliation"), ("reversal", "Payment reversal")], max_length=20)),
                ("note", models.TextField(blank=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("actor", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="invoice_status_events", to="accounts.user")),
                ("from_step", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="events_from", to="billing.invoicestatusstep")),
                ("invoice", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="status_events", to="billing.invoice")),
                ("to_step", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="events_to", to="billing.invoicestatusstep")),
            ],
            options={"ordering": ("created_at", "id")},
        ),
        migrations.RunPython(seed_status_workflow, migrations.RunPython.noop),
    ]
