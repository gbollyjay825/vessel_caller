from __future__ import annotations

from io import BytesIO
from typing import Any
from xml.sax.saxutils import escape

from django.http import HttpResponse
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from api.tenant_lifecycle import TenantLifecycleAPIView as APIView

from api.permissions import HasVesselPermission

from .models import Reconciliation
from .serializers import reconciliation_data


def cargo_description(line):
    parts = [line.get("description"), line.get("category"), line.get("direction")]
    if line.get("containerSize"):
        parts.append(f"{line['containerSize']}-foot")
    parts.extend([line.get("loadStatus"), line.get("unit")])
    if line.get("basis"):
        parts.append(f"Basis: {line['basis']}")
    return " / ".join(str(part) for part in parts if part)


def reconciliation_pdf(reconciliation):
    """Render approved sources from the frozen snapshot, never today's call data."""
    current = reconciliation_data(reconciliation)
    snapshot = reconciliation.snapshot or {}
    record = {**snapshot.get("reconciliation", current), "status": current["status"]}
    plan = snapshot.get("plan", {})
    participants = snapshot.get("participants", [])
    cargo_lines = snapshot.get("lines", [])
    submissions = snapshot.get("submissions", [])
    agreed_lines = record.get("lines", [])
    output = BytesIO()
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="Cell", fontName="Helvetica", fontSize=8, leading=11))
    styles.add(
        ParagraphStyle(
            name="SmallNote",
            fontName="Helvetica",
            fontSize=8,
            leading=11,
            textColor=colors.HexColor("#566475"),
        )
    )
    styles.add(ParagraphStyle(name="NumberCell", parent=styles["Cell"], alignment=TA_RIGHT))

    def actor_label(value):
        if isinstance(value, dict):
            return value.get("name") or value.get("id") or "Unknown"
        return value or "Pending"

    def text(value, style="Cell"):
        return Paragraph(escape(str(value if value is not None else "Not supplied")), styles[style])

    def table(rows, widths):
        result = Table(
            [[text(cell) for cell in row] for row in rows],
            colWidths=widths,
            repeatRows=1,
            splitInRow=1,
        )
        result.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eaf0f4")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#173650")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LINEBELOW", (0, 0), (-1, 0), 0.7, colors.HexColor("#a6b7c4")),
                    ("LINEBELOW", (0, 1), (-1, -1), 0.25, colors.HexColor("#dce3e8")),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 6),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ]
            )
        )
        return result

    width = 265 * mm
    story = [
        Paragraph("Voyage measurement reconciliation", styles["Title"]),
        text(
            f"Vessel Caller record | Revision {record.get('revision')} | {record.get('status', '').upper()}",
            "SmallNote",
        ),
        Spacer(1, 5 * mm),
        table(
            [
                ["Vessel / rotation", "Measurement scope", "Location / method"],
                [
                    f"{plan.get('vesselName', '')} / {plan.get('callReference', '')}",
                    f"{plan.get('title', '')}\n{plan.get('scope', '')} / {plan.get('stage', '')}",
                    f"{plan.get('location', '')} / {plan.get('method', '')}",
                ],
            ],
            [width / 3] * 3,
        ),
        Spacer(1, 5 * mm),
    ]
    by_line = {item["lineId"]: item for item in agreed_lines}
    by_participant = {item["participantId"]: item for item in submissions}
    # Limit table width: additional parties get another comparison panel with the same final figures.
    groups = [participants[i : i + 4] for i in range(0, len(participants), 4)] or [[]]
    for group in groups:
        headers = ["Cargo / classification / basis", "Manifest"]
        headers += [f"{p.get('name', '')}\n{p.get('role', '')}" for p in group]
        headers += ["Agreed", "Variance"]
        rows: list[list[Any]] = [headers]
        for line in cargo_lines:
            accepted = by_line.get(line["id"], {})
            values = []
            for participant in group:
                submission = by_participant.get(participant["id"], {})
                reading: dict[str, Any] = next(
                    (v for v in submission.get("lines", []) if v["lineId"] == line["id"]), {}
                )
                values.append(
                    reading.get("quantity")
                    if reading.get("status") == "reported"
                    else reading.get("status", "Missing")
                )
            description = cargo_description(line)
            rows.append(
                [
                    description,
                    line.get("manifestQuantity"),
                    *values,
                    accepted.get("quantity"),
                    accepted.get("variance"),
                ]
            )
        number_width = (width - 67 * mm) / (len(headers) - 1)
        story.extend(
            [table(rows, [67 * mm] + [number_width] * (len(headers) - 1)), Spacer(1, 5 * mm)]
        )
    story.extend(
        [Paragraph("Basis of agreement", styles["Heading2"]), text(record.get("reason", ""))]
    )
    for line in agreed_lines:
        source: dict[str, Any] = next(
            (item for item in cargo_lines if item["id"] == line["lineId"]), {}
        )
        story.append(
            text(f"{cargo_description(source) or line['lineId']}: {line.get('reason', '')}")
        )
    story.extend([Spacer(1, 4 * mm), Paragraph("Recorded acknowledgements", styles["Heading2"])])
    approvals = record.get("approvals", [])
    approval_rows = [["Party", "Decision / representative", "Source reference", "Recorded at / by"]]
    for approval in approvals:
        approval_participant: dict[str, Any] = next(
            (p for p in participants if p["id"] == approval["participantId"]), {}
        )
        approval_rows.append(
            [
                approval_participant.get("name", approval["participantId"]),
                f"{approval.get('decision', '')} / {approval.get('representative', '')}",
                approval.get("reference", ""),
                f"{approval.get('recordedAt', '')} / {actor_label(approval.get('recordedBy'))}",
            ]
        )
    story.extend([table(approval_rows, [width / 4] * 4), Spacer(1, 4 * mm)])
    story.append(
        text(
            f"Finalized at: {record.get('finalizedAt') or 'Not finalized'} | Final approver: {actor_label(record.get('finalizedBy'))}"
        )
    )
    story.append(
        text(
            "Acknowledgements identify recorded paper evidence; they are not representations of electronic stakeholder signatures.",
            "SmallNote",
        )
    )
    evidence = snapshot.get("evidence", [])
    if evidence:
        story.extend(
            [
                Paragraph("Source evidence", styles["Heading2"]),
                table(
                    [["File", "SHA-256 checksum"]]
                    + [[item.get("fileName", ""), item.get("checksum", "")] for item in evidence],
                    [95 * mm, 170 * mm],
                ),
            ]
        )
    story.extend(
        [
            Spacer(1, 4 * mm),
            text(
                f"Record {record['id']}. Generated by Vessel Caller. This is an application reconciliation record, not an NPA-issued document. Quantities alone do not establish a charge.",
                "SmallNote",
            ),
        ]
    )

    def footer(canvas, doc):
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.HexColor("#566475"))
        canvas.drawString(16 * mm, 10 * mm, f"Vessel Caller | {record['id']}")
        canvas.drawRightString(281 * mm, 10 * mm, str(doc.page))

    document = SimpleDocTemplate(
        output,
        pagesize=landscape(A4),
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=14 * mm,
        bottomMargin=18 * mm,
        title="Voyage measurement reconciliation",
        author="Vessel Caller",
    )
    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return output.getvalue()


class ReconciliationDocumentView(APIView):
    permission_classes = [IsAuthenticated, HasVesselPermission]
    required_permission = "measurements.view"

    def get(self, request, plan_id, reconciliation_id):
        reconciliation = Reconciliation.objects.filter(
            pk=reconciliation_id,
            plan_id=plan_id,
            plan__organization_id=request.user.organization_id,
        ).first()
        if reconciliation is None:
            raise NotFound("Reconciliation not found")
        response = HttpResponse(reconciliation_pdf(reconciliation), content_type="application/pdf")
        response["Content-Disposition"] = (
            f'attachment; filename="reconciliation-{reconciliation.id}.pdf"'
        )
        response["Cache-Control"] = "private, no-store"
        return response
