from django.db import migrations
from django.db.models import F


NEW_STEPS = (
    ("pending-director-finance-review", "Pending Director of Finance Review", 10),
    ("pending-audit-review", "Pending Audit Review", 20),
    ("pending-md-review", "Pending MD Review", 30),
    ("pending-accounts-review", "Pending Accounts Review", 40),
)
LEGACY_CODES = ("draft", "submitted", "under-review")


def install_director_review_workflow(apps, schema_editor):
    Organization = apps.get_model("organizations", "Organization")
    Invoice = apps.get_model("billing", "Invoice")
    Step = apps.get_model("billing", "InvoiceStatusStep")
    Event = apps.get_model("billing", "InvoiceStatusEvent")

    for organization in Organization.objects.all().iterator():
        existing = {step.code: step for step in Step.objects.filter(organization_id=organization.id)}
        # Move every existing record out of the constrained position range
        # before creating/reordering the replacement review stages.
        Step.objects.filter(organization_id=organization.id).update(position=F("position") + 10_000)
        for index, code in enumerate(LEGACY_CODES, start=1):
            step = existing.get(code)
            if step:
                step.active = False
                step.position = 900 + index * 10
                step.save(update_fields=("active", "position", "updated_at"))

        created = {}
        for code, label, position in NEW_STEPS:
            step, _ = Step.objects.get_or_create(
                organization_id=organization.id,
                code=code,
                defaults={
                    "label": label,
                    "position": position,
                    "active": True,
                    "is_paid": False,
                    "is_terminal": False,
                    "is_protected": False,
                },
            )
            # New defaults must be consistent, but preserve an Admin's later
            # label/order changes by only changing rows that are still the old
            # default values or newly created above.
            if step.label != label and step.code not in existing:
                step.label = label
            if step.position != position and step.code not in existing:
                step.position = position
            step.save(update_fields=("label", "position", "updated_at"))
            created[code] = step

        approved = existing.get("approved")
        if approved:
            approved.position = 50
            approved.active = True
            approved.save(update_fields=("position", "active", "updated_at"))
        paid = existing.get("paid")
        if paid:
            paid.position = 60
            paid.active = True
            paid.save(update_fields=("position", "active", "updated_at"))

        default = created["pending-director-finance-review"]
        for invoice in Invoice.objects.filter(
            organization_id=organization.id,
            current_status_id__in=[step.id for code, step in existing.items() if code in LEGACY_CODES],
        ).iterator():
            previous = existing.get(invoice.current_status.code) if invoice.current_status_id else None
            Invoice.objects.filter(pk=invoice.pk).update(current_status_id=default.id, status="unpaid")
            Event.objects.create(
                invoice_id=invoice.id,
                from_step_id=previous.id if previous else None,
                to_step_id=default.id,
                from_code=previous.code if previous else "",
                from_label=previous.label if previous else "",
                to_code=default.code,
                to_label=default.label,
                source="migration",
                note="Legacy review stage mapped to Director of Finance review",
            )


class Migration(migrations.Migration):
    dependencies = [("billing", "0003_invoice_attachment")]

    operations = [migrations.RunPython(install_director_review_workflow, migrations.RunPython.noop)]
