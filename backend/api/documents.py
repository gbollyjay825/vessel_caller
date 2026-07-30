from __future__ import annotations

import logging
from html import escape
from io import BytesIO

from django.core.files.storage import default_storage
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    Image,
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


logger = logging.getLogger(__name__)


def _logo(logo_key: str) -> Image | None:
    """Return a bounded private logo, never a public URL.

    A corrupted or unavailable logo must not prevent an invoice or report from
    being produced.  ImageReader validates enough of the source for ReportLab
    to safely lay it out before the document is built.
    """
    if not logo_key:
        return None
    try:
        with default_storage.open(logo_key, "rb") as source:
            image = ImageReader(source)
            width, height = image.getSize()
        if width <= 0 or height <= 0:
            return None
        logo = Image(default_storage.open(logo_key, "rb"), width=30 * mm, height=18 * mm)
        logo._restrictSize(30 * mm, 18 * mm)
        return logo
    except (OSError, ValueError):
        logger.warning("Organization logo could not be rendered into PDF", exc_info=True)
        return None


def simple_pdf(title: str, rows: list[tuple[str, object]], *, logo_key: str = "") -> bytes:
    """Build a print-safe, multi-page invoice/report document.

    Canvas ``drawString`` silently ran through column boundaries and page
    margins.  Platypus paragraphs and a repeated table heading allow long
    organization names, locations, descriptions, and measurements to wrap
    predictably on every page.
    """
    output = BytesIO()
    document = SimpleDocTemplate(
        output,
        pagesize=A4,
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
        title=title,
        author="Vessel Caller",
        pageCompression=1,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "VesselTitle",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=17,
        leading=21,
        spaceAfter=0,
        textColor=colors.HexColor("#102A43"),
    )
    label_style = ParagraphStyle(
        "VesselLabel",
        parent=styles["BodyText"],
        fontName="Helvetica-Bold",
        fontSize=8.5,
        leading=11,
        textColor=colors.HexColor("#243B53"),
    )
    value_style = ParagraphStyle(
        "VesselValue",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=8.5,
        leading=11,
        textColor=colors.HexColor("#102A43"),
        wordWrap="CJK",
    )
    header_style = ParagraphStyle(
        "VesselHeader",
        parent=label_style,
        textColor=colors.white,
    )

    logo = _logo(logo_key)
    heading = Table(
        [[Paragraph(escape(title), title_style), logo or ""]],
        colWidths=[document.width - 34 * mm, 34 * mm],
        hAlign="LEFT",
    )
    heading.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (1, 0), (1, 0), "RIGHT"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )

    table_rows = [[Paragraph("Field", header_style), Paragraph("Value", header_style)]]
    for label, value in rows:
        table_rows.append(
            [
                Paragraph(escape(str(label)), label_style),
                Paragraph(
                    escape(str(value if value is not None and value != "" else "—")),
                    value_style,
                ),
            ]
        )
    detail_table = Table(
        table_rows,
        colWidths=[48 * mm, document.width - 48 * mm],
        repeatRows=1,
        splitByRow=1,
        splitInRow=1,
        hAlign="LEFT",
    )
    detail_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#173F67")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#CBD5E1")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BACKGROUND", (0, 1), (-1, -1), colors.white),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8FAFC")]),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    document.build([KeepTogether([heading, Spacer(1, 7 * mm)]), detail_table])
    return output.getvalue()
