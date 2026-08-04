from django.db import migrations


ADDITIONAL_TERMINALS = ("ECMT", "Intels", "NNPC")


def add_calabar_berth_terminals(apps, schema_editor):
    OrganizationSettings = apps.get_model("organizations", "OrganizationSettings")
    for settings in OrganizationSettings.objects.iterator():
        terminals = list(settings.terminals or [])
        additions = [terminal for terminal in ADDITIONAL_TERMINALS if terminal not in terminals]
        if additions:
            settings.terminals = [*terminals, *additions]
            settings.save(update_fields=("terminals",))


class Migration(migrations.Migration):
    dependencies = [("organizations", "0001_initial")]

    operations = [migrations.RunPython(add_calabar_berth_terminals, migrations.RunPython.noop)]
