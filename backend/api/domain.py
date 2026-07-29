from __future__ import annotations

from datetime import timedelta
from decimal import Decimal, ROUND_HALF_UP

from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

from billing.models import Invoice, NumberSequence
from billing.services import active_default_step, append_status_event
from operations.models import Inspection, VesselCall
from organizations.models import Organization, OrganizationSettings

CENT = Decimal("0.01")


def money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def bump_revision(organization_id: str) -> int:
    Organization.objects.filter(pk=organization_id).update(revision=F("revision") + 1)
    return Organization.objects.values_list("revision", flat=True).get(pk=organization_id)


def next_number(organization, kind: str, prefix: str) -> str:
    year = timezone.localdate().year
    sequence, _ = NumberSequence.objects.select_for_update().get_or_create(
        organization=organization,
        kind=kind,
        year=year,
        defaults={"value": 0},
    )
    sequence.value += 1
    sequence.save(update_fields=("value",))
    return f"{prefix}-{year}-{sequence.value:04d}"


def rate_for_inspection(inspection: Inspection, settings_obj: OrganizationSettings) -> Decimal:
    if inspection.cargo_type == Inspection.CargoType.DRY:
        return settings_obj.dry_dues_rate
    jetty = inspection.jetty or {}
    if jetty.get("type") == "International":
        return settings_obj.international_liquid_rate
    if jetty.get("type") == "Local" and jetty.get("category") == "Government":
        return settings_obj.government_liquid_rate
    if jetty.get("type") == "Local" and jetty.get("category") == "Private":
        return settings_obj.private_liquid_rate
    return Decimal("0")


@transaction.atomic
def finalize_inspection(
    inspection_id: str, organization_id: str
) -> tuple[Inspection, Invoice, int]:
    inspection = (
        Inspection.objects.select_for_update()
        .select_related("vessel_call", "organization")
        .get(pk=inspection_id, organization_id=organization_id)
    )
    try:
        existing = inspection.invoice
    except Invoice.DoesNotExist:
        existing = None
    if existing:
        return inspection, existing, inspection.organization.revision
    call = VesselCall.objects.select_for_update().get(pk=inspection.vessel_call_id)
    settings_obj = OrganizationSettings.objects.select_for_update().get(
        organization_id=organization_id
    )
    now = timezone.now()
    inspection.status = Inspection.Status.COMPLETED
    inspection.completed_at = now
    inspection.version += 1
    inspection.save(update_fields=("status", "completed_at", "version", "updated_at"))
    call.status = VesselCall.Status.COMPLETED
    call.berth_date = call.berth_date or timezone.localdate()
    call.version += 1
    call.save(update_fields=("status", "berth_date", "version", "updated_at"))
    rate = rate_for_inspection(inspection, settings_obj)
    dues = money(call.nrt * rate)
    commission_usd = money(dues * settings_obj.commission_rate / Decimal("100"))
    commission_ngn = money(commission_usd * settings_obj.exchange_rate)
    try:
        invoice = Invoice.objects.create(
            organization=inspection.organization,
            vessel_call=call,
            inspection=inspection,
            invoice_no=next_number(inspection.organization, "invoice", "INV"),
            cargo_type=inspection.cargo_type,
            issued_on=now.date(),
            due_on=(now + timedelta(days=14)).date(),
            status=Invoice.Status.UNPAID,
            current_status=active_default_step(organization_id),
            dues=dues,
            rate=rate,
            commission_usd=commission_usd,
            commission_ngn=commission_ngn,
            exchange_rate=settings_obj.exchange_rate,
        )
        append_status_event(
            invoice,
            from_step=None,
            to_step=invoice.current_status,
            source="created",
            note="Invoice created from completed inspection",
        )
    except IntegrityError:
        invoice = Invoice.objects.get(inspection=inspection)
    revision = bump_revision(organization_id)
    return inspection, invoice, revision
