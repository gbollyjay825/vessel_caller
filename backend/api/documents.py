from __future__ import annotations

from io import BytesIO

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas


def simple_pdf(title: str, rows: list[tuple[str, object]]) -> bytes:
    output = BytesIO()
    page = canvas.Canvas(output, pagesize=A4, pageCompression=1)
    page.setTitle(title)
    page.setFont("Helvetica-Bold", 18)
    page.drawString(20 * mm, 275 * mm, title)
    y = 260 * mm
    for label, value in rows:
        page.setFont("Helvetica-Bold", 10)
        page.drawString(20 * mm, y, str(label))
        page.setFont("Helvetica", 10)
        page.drawString(65 * mm, y, str(value if value is not None else "—"))
        y -= 8 * mm
        if y < 20 * mm:
            page.showPage()
            y = 275 * mm
    page.setAuthor("Vessel Caller")
    page.showPage()
    page.save()
    return output.getvalue()
