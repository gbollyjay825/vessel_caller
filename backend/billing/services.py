from __future__ import annotations

from decimal import Decimal

from django.db.models import Sum

from .models import Invoice, InvoiceStatusEvent, InvoiceStatusStep


DEFAULT_WORKFLOW_STEPS = (
    ("draft", "Draft", 10, False, False, False),
    ("submitted", "Submitted", 20, False, False, False),
    ("under-review", "Under Review", 30, False, False, False),
    ("approved", "Approved", 40, False, False, False),
    ("paid", "Paid", 50, True, True, True),
)


def ensure_default_steps(organization) -> list[InvoiceStatusStep]:
    """Provision new organizations deterministically; the migration handles existing ones."""
    for code, label, position, is_paid, is_terminal, is_protected in DEFAULT_WORKFLOW_STEPS:
        InvoiceStatusStep.objects.get_or_create(
            organization=organization,
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
    return list(organization.invoice_status_steps.all())


def active_default_step(organization_id: str) -> InvoiceStatusStep:
    from organizations.models import Organization

    organization = Organization.objects.get(pk=organization_id)
    ensure_default_steps(organization)
    step = (
        InvoiceStatusStep.objects.filter(
            organization_id=organization_id, active=True, is_paid=False, is_terminal=False
        )
        .order_by("position")
        .first()
    )
    if not step:
        raise ValueError("No active non-paid invoice status step is configured")
    return step


def paid_step(organization_id: str) -> InvoiceStatusStep:
    from organizations.models import Organization

    organization = Organization.objects.get(pk=organization_id)
    ensure_default_steps(organization)
    step = InvoiceStatusStep.objects.filter(organization_id=organization_id, is_paid=True).first()
    if not step:
        raise ValueError("Paid invoice status step is not configured")
    return step


def workflow_step_data(step: InvoiceStatusStep | None, *, legacy_status: str = "") -> dict:
    if step is None:
        return {
            "id": None,
            "code": "void" if legacy_status == Invoice.Status.VOID else "",
            "label": "Void" if legacy_status == Invoice.Status.VOID else "",
            "position": None,
            "active": False,
            "isPaid": False,
            "isTerminal": legacy_status == Invoice.Status.VOID,
            "isProtected": legacy_status == Invoice.Status.VOID,
        }
    return {
        "id": step.id,
        "code": step.code,
        "label": step.label,
        "position": step.position,
        "active": step.active,
        "isPaid": step.is_paid,
        "isTerminal": step.is_terminal,
        "isProtected": step.is_protected,
    }


def append_status_event(
    invoice: Invoice,
    *,
    from_step: InvoiceStatusStep | None,
    to_step: InvoiceStatusStep | None,
    source: str,
    actor=None,
    note: str = "",
) -> InvoiceStatusEvent:
    return InvoiceStatusEvent.objects.create(
        invoice=invoice,
        from_step=from_step,
        to_step=to_step,
        from_code=from_step.code if from_step else "",
        from_label=from_step.label if from_step else "",
        to_code=to_step.code if to_step else "void",
        to_label=to_step.label if to_step else "Void",
        source=source,
        actor=actor,
        note=note,
    )


def transition_invoice(
    invoice: Invoice,
    step: InvoiceStatusStep | None,
    *,
    source: str,
    actor=None,
    note: str = "",
) -> InvoiceStatusEvent | None:
    previous = invoice.current_status
    if previous == step and invoice.status != Invoice.Status.VOID:
        return None
    invoice.current_status = step
    invoice.status = Invoice.Status.VOID if step is None else (Invoice.Status.PAID if step.is_paid else Invoice.Status.UNPAID)
    invoice.save(update_fields=("current_status", "status"))
    return append_status_event(invoice, from_step=previous, to_step=step, source=source, actor=actor, note=note)


def reconcile_payment_status(invoice: Invoice, *, actor=None, source: str) -> InvoiceStatusEvent | None:
    """Enter Paid once cleared; restore the latest valid non-paid step on reversal."""
    if invoice.status == Invoice.Status.VOID:
        return None
    total = invoice.payments.filter(reversed_at__isnull=True).aggregate(total=Sum("amount"))["total"] or Decimal("0")
    if total >= invoice.dues:
        return transition_invoice(invoice, paid_step(invoice.organization_id), source=source, actor=actor)
    if invoice.current_status and not invoice.current_status.is_paid:
        return None
    candidate = None
    for event in invoice.status_events.select_related("to_step").order_by("-created_at", "-id"):
        step = event.to_step
        if step and step.active and not step.is_paid and not step.is_terminal:
            candidate = step
            break
    return transition_invoice(invoice, candidate or active_default_step(invoice.organization_id), source=source, actor=actor)
