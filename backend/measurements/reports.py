"""Server-generated agency receipts and side-by-side voyage readings."""

from io import BytesIO
from pathlib import Path
from xml.sax.saxutils import escape

from django.http import HttpResponse
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.negotiation import DefaultContentNegotiation

from operations.models import VesselCall

from .models import MeasurementPlan
from .serializers import cargo_line_data, participant_data, plan_context, submission_data
from .services import get_plan, latest_submissions
from .views import MeasurementView


class PDFDownloadNegotiation(DefaultContentNegotiation):
    def select_renderer(self, request, renderers, format_suffix=None):
        # Successful downloads return an explicit PDF HttpResponse. Keep JSON
        # available for permission/validation errors even when PDF was requested.
        return renderers[0], renderers[0].media_type


def readings_data(plan):
    return {
        "plan": plan_context(plan),
        "agencies": [participant_data(p) for p in plan.participants.all()],
        "lines": [cargo_line_data(line) for line in plan.lines.all()],
        "submissions": [submission_data(s) for s in latest_submissions(plan)],
    }


def report_pdf(title, subtitle, headers, rows, notes=(), sections=()):
    output = BytesIO()
    styles = getSampleStyleSheet()
    for name in ("BodyText", "Heading2", "Title"):
        styles[name].textColor = colors.HexColor("#006b29")
    styles["BodyText"].fontSize = 8
    styles["BodyText"].leading = 11

    def text(value):
        return Paragraph(escape(str(value)), styles["BodyText"])

    logo = Image(
        str(Path(__file__).parent / "assets" / "npa-logo.png"),
        width=13 * mm,
        height=13 * mm,
        kind="proportional",
    )
    story = [
        Table(
            [[logo, Paragraph("NPA Vessel Caller", styles["Heading2"])]],
            colWidths=[18 * mm, 240 * mm],
        ),
        Paragraph(escape(title), styles["Title"]),
        text(subtitle),
        Spacer(1, 5 * mm),
    ]
    width = 265 * mm
    for column_names, table_rows in [(headers, rows), *sections]:
        col_widths = [70 * mm] + [(width - 70 * mm) / (len(column_names) - 1)] * (
            len(column_names) - 1
        )
        table = Table(
            [[text(v) for v in row] for row in [column_names, *table_rows]],
            colWidths=col_widths,
            repeatRows=1,
            splitInRow=1,
        )
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e9f4ed")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LINEBELOW", (0, 0), (-1, -1), 0.3, colors.HexColor("#cfdfd4")),
                    ("TOPPADDING", (0, 0), (-1, -1), 8),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ]
            )
        )
        story.append(table)
        story.append(Spacer(1, 4 * mm))
    story.extend([Spacer(1, 4 * mm), *[text(note) for note in notes]])

    def footer(canvas, doc):
        canvas.setFont("Helvetica", 8)
        canvas.drawString(
            16 * mm, 10 * mm, "NPA Vessel Caller | Recorded quantities; not an invoice"
        )
        canvas.drawRightString(281 * mm, 10 * mm, str(doc.page))

    SimpleDocTemplate(
        output,
        pagesize=landscape(A4),
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=14 * mm,
        bottomMargin=18 * mm,
        title=title,
        author="NPA Vessel Caller",
    ).build(story, onFirstPage=footer, onLaterPages=footer)
    return output.getvalue()


def reading_value(value):
    if value is None:
        return "Not submitted"
    if value.get("status") == "not-applicable":
        return "N/A"
    return value.get("quantity") if value.get("quantity") is not None else "Not provided"


def submission_pdf(plan, submission):
    snapshot = submission.snapshot
    context = snapshot.get("plan", plan_context(plan))
    party = snapshot.get("participant", participant_data(submission.participant))
    lines = snapshot.get("lines", [cargo_line_data(line) for line in plan.lines.all()])
    values = {row["lineId"]: row for row in submission_data(submission)["lines"]}
    rows = [
        [
            f"{line['description']} ({line['unit']})",
            reading_value(values.get(line["id"])),
            values.get(line["id"], {}).get("note", ""),
        ]
        for line in lines
    ]
    return report_pdf(
        "Agency reading receipt",
        f"{context['vesselName']} | {context['callReference']} | {party['name']}",
        ["Cargo item / unit", "Agency reading", "Note"],
        rows,
        [
            f"Agency: {party['name']} | Role: {party['role']} | Representative: {submission.representative or party['representative']}",
            f"Observed: {submission.observed_at.isoformat()} | Submitted: {submission.recorded_at.isoformat()}",
            f"Source reference: {submission.source_reference} | Receipt: {submission.pk} | Revision: {submission.revision}",
            submission.notes,
        ],
    )


def pdf_response(content, filename):
    response = HttpResponse(content, content_type="application/pdf")
    response["Content-Disposition"] = f'attachment; filename="{filename}.pdf"'
    response["Cache-Control"] = "private, no-store"
    return response


class SubmissionReceiptView(MeasurementView):
    content_negotiation_class = PDFDownloadNegotiation
    required_permission = "measurements.view"

    def get(self, request, plan_id, submission_id):
        plan = get_plan(request, plan_id)
        submission = plan.submissions.filter(pk=submission_id).first()
        if not submission:
            raise NotFound("Agency reading not found")
        return pdf_response(submission_pdf(plan, submission), f"agency-reading-{submission.pk}")


class VoyageReadingsView(MeasurementView):
    required_permission = "measurements.view"

    def get(self, request, call_id):
        call = VesselCall.objects.filter(
            pk=call_id, organization_id=request.user.organization_id
        ).first()
        if not call:
            raise NotFound("Voyage not found")
        plans = MeasurementPlan.objects.filter(
            vessel_call=call, organization_id=request.user.organization_id
        )
        sheets = [readings_data(plan) for plan in plans]
        return Response(
            {
                "callId": call.pk,
                "vesselName": call.vessel_name,
                "callReference": call.reference,
                "sheets": sheets,
            }
        )


class VoyageReadingsDocumentView(MeasurementView):
    required_permission = "measurements.view"
    content_negotiation_class = PDFDownloadNegotiation

    def get(self, request, call_id):
        call = VesselCall.objects.filter(
            pk=call_id, organization_id=request.user.organization_id
        ).first()
        if not call:
            raise NotFound("Voyage not found")
        sections = []
        for plan in call.measurement_plans.filter(organization_id=request.user.organization_id):
            parties = list(plan.participants.all())
            latest = {
                item.participant_id: {row.line_id: row for row in item.lines.all()}
                for item in latest_submissions(plan)
            }
            for offset in range(0, max(1, len(parties)), 4):
                group = parties[offset : offset + 4]
                headers = [f"Cargo item / unit - {plan.title}", "Owner declaration"] + [
                    p.name for p in group
                ]
                rows = []
                for line in plan.lines.all():
                    readings = []
                    for party in group:
                        value = latest.get(party.pk, {}).get(line.pk)
                        readings.append(
                            "Not submitted"
                            if value is None
                            else "N/A"
                            if value.status == "not-applicable"
                            else str(value.quantity)
                        )
                    rows.append(
                        [
                            f"{line.description} ({line.unit})",
                            str(line.manifest_quantity)
                            if line.manifest_quantity is not None
                            else "Not provided",
                            *readings,
                        ]
                    )
                sections.append((headers, rows))
        if not sections:
            raise NotFound("No readings are recorded for this voyage")
        first, *rest = sections
        return pdf_response(
            report_pdf(
                "Readings",
                f"{call.vessel_name} | {call.reference}",
                *first,
                notes=[
                    "Independent agency readings. These quantities have not been selected as the NPA final reconciliation."
                ],
                sections=rest,
            ),
            f"readings-{call.pk}",
        )


class MeasurementActivityView(MeasurementView):
    required_permission = "analytics.view"

    def get(self, request):
        from django.db.models import Count, Q
        from audit.models import AuditEvent
        from billing.models import Invoice

        org = request.user.organization_id
        plans = MeasurementPlan.objects.filter(organization_id=org).exclude(status="cancelled")
        pending = plans.annotate(
            expected=Count(
                "participants", filter=Q(participants__required_submission=True), distinct=True
            ),
            received=Count(
                "participants",
                filter=Q(
                    participants__required_submission=True, participants__submissions__isnull=False
                ),
                distinct=True,
            ),
        )
        events = AuditEvent.objects.filter(
            organization_id=org, category="measurements"
        ).select_related("actor")[:30]
        invoices = Invoice.objects.filter(organization_id=org, purpose="disparity").exclude(
            status=Invoice.Status.VOID
        )
        return Response(
            {
                "summary": {
                    "activePlans": plans.count(),
                    "awaitingReadings": sum(plan.received < plan.expected for plan in pending),
                    "reconciledPlans": plans.filter(status="reconciled").count(),
                    "variationInvoices": invoices.count(),
                },
                "events": [
                    {
                        "id": str(item.pk),
                        "at": item.occurred_at.isoformat(),
                        "action": item.action,
                        "reference": item.target_id,
                        "label": item.target_label,
                        "actor": item.actor.name if item.actor else "Agency submission",
                    }
                    for item in events
                ],
            }
        )
