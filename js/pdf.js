/* ============================================================
   pdf.js — generates the printable invoice / inspection report.

   In production every PDF action button opens GET /api/pdf/:filename
   in a new tab. With no backend here, we render an equivalent,
   print-ready HTML document (browser "Save as PDF") so the whole
   flow — and the figures — are real and verifiable.
   ============================================================ */
import { money, naira, num, tons, pct, date, dateTime } from "./format.js";

const esc = (s) =>
  String(s ?? "—").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );

const STYLE = `
  :root{--ink:#16191d;--slate:#5f6b7a;--line:#e8eaed;--accent:#1b5faa;--accent-tint:#e6eff8;}
  *{box-sizing:border-box}
  body{margin:0;font-family:Inter,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:#f4f5f7;padding:32px;-webkit-font-smoothing:antialiased}
  .sheet{max-width:760px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:10px;padding:48px;box-shadow:0 2px 8px rgba(16,19,29,.06)}
  .top{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;border-bottom:2px solid var(--ink);padding-bottom:20px}
  .brand{display:flex;gap:12px;align-items:center}
  .glyph{width:40px;height:40px;border-radius:8px;background:var(--accent-tint);color:var(--accent);display:grid;place-items:center}
  .brand h1{font-size:18px;margin:0}
  .brand .sub{font-size:12px;color:var(--slate);letter-spacing:.04em;text-transform:uppercase}
  .doctype{text-align:right}
  .doctype .kind{font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
  .doctype .no{font-size:20px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums}
  .doctype .meta{font-size:12px;color:var(--slate);margin-top:4px}
  .pill{display:inline-block;margin-top:8px;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
  .pill.paid{background:#e7f4ec;color:#1f9254}.pill.unpaid{background:#fbf1df;color:#b6781e}.pill.overdue{background:#fbeae7;color:#c0392b}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin:28px 0}
  .col h3{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--slate);margin:0 0 10px}
  .kv{display:flex;justify-content:space-between;gap:16px;padding:5px 0;font-size:13px}
  .kv .k{color:var(--slate)}.kv .v{font-weight:600;text-align:right}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th,td{text-align:left;padding:12px;font-size:13px;border-bottom:1px solid var(--line)}
  th{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--slate);background:#fafbfc}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  .total td{border-top:2px solid var(--ink);border-bottom:none;font-weight:700;font-size:15px;padding-top:14px}
  .grand{background:var(--accent-tint)}
  .note{margin-top:28px;padding:14px 16px;background:#fafbfc;border:1px solid var(--line);border-radius:8px;font-size:12px;color:var(--slate)}
  .sign{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:40px}
  .sign div{border-top:1px solid var(--ink);padding-top:8px;font-size:12px;color:var(--slate)}
  .bar{position:fixed;top:16px;right:16px;display:flex;gap:8px}
  .bar button{font-family:inherit;font-size:13px;font-weight:600;border:1px solid var(--line);background:#fff;color:var(--ink);padding:8px 14px;border-radius:6px;cursor:pointer;box-shadow:0 2px 8px rgba(16,19,29,.12)}
  .bar button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
  @media print{body{background:#fff;padding:0}.sheet{border:none;box-shadow:none;border-radius:0;max-width:none;padding:24px}.bar{display:none}}
`;

const SHIP = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16l1.7-5.3A1 1 0 0 1 5.65 10H18.35a1 1 0 0 1 .95.7L21 16"/><path d="M2.5 18.5c1.3 1.2 2.7 1.2 4 0s2.7-1.2 4 0 2.7 1.2 4 0 2.7-1.2 4 0"/><path d="M12 10V4l4.5 1.8L12 7.6"/></svg>`;

function particulars(doc) {
  return `
    <div class="col">
      <h3>Vessel & Call</h3>
      <div class="kv"><span class="k">Vessel</span><span class="v">${esc(doc.vesselName)}</span></div>
      <div class="kv"><span class="k">Call reference</span><span class="v">${esc(doc.callRef)}</span></div>
      <div class="kv"><span class="k">Vessel type</span><span class="v">${esc(doc.vesselType)}</span></div>
      <div class="kv"><span class="k">Flag / registry</span><span class="v">${esc(doc.flag)}</span></div>
      <div class="kv"><span class="k">Berth / terminal</span><span class="v">${esc(doc.berth)}</span></div>
    </div>
    <div class="col">
      <h3>Cargo & Inspection</h3>
      <div class="kv"><span class="k">Inspection ref</span><span class="v">${esc(doc.inspectionRef)}</span></div>
      <div class="kv"><span class="k">Inspection date</span><span class="v">${date(doc.inspectionDate)}</span></div>
      <div class="kv"><span class="k">Cargo type</span><span class="v">${esc(doc.cargoType)}</span></div>
      <div class="kv"><span class="k">Category</span><span class="v">${doc.cargoCategory === "liquid" ? "Liquid cargo" : "Dry / bulk cargo"}</span></div>
      <div class="kv"><span class="k">Reconciled tonnage</span><span class="v">${tons(doc.reconciledTonnage)}</span></div>
    </div>`;
}

function invoiceBody(doc) {
  return `
    <div class="cols">${particulars(doc)}</div>
    <table>
      <thead><tr><th>Description</th><th>Basis</th><th class="num">Amount (USD)</th></tr></thead>
      <tbody>
        <tr>
          <td><strong>NPA harbour dues</strong></td>
          <td>${tons(doc.reconciledTonnage)} &times; ${money(doc.duesRatePerTon)}/MT</td>
          <td class="num">${money(doc.harbourDues)}</td>
        </tr>
        <tr>
          <td><strong>Agency commission</strong></td>
          <td>${pct(doc.commissionRate)} of harbour dues</td>
          <td class="num">${money(doc.commissionUSD)}</td>
        </tr>
        <tr class="total grand">
          <td>Total due</td>
          <td>USD</td>
          <td class="num">${money(doc.harbourDues + doc.commissionUSD)}</td>
        </tr>
        <tr>
          <td class="k">Commission in Naira</td>
          <td>@ ₦${num(doc.exchangeRate)}/USD</td>
          <td class="num">${naira(doc.commissionNGN)}</td>
        </tr>
      </tbody>
    </table>
    <div class="note">Figures computed server-side from the reconciled inspection tonnage and the prevailing NPA dues rate and exchange rate. This invoice is system-generated and valid without signature.</div>`;
}

function reportBody(doc) {
  const m = doc.measurement || {};
  const measureRows =
    doc.cargoCategory === "liquid"
      ? [
          ["Ullage / sounding", m.ullage != null ? `${m.ullage} m` : "—"],
          ["Observed volume", m.observedVolume != null ? `${num(m.observedVolume)} m³` : "—"],
          ["Temperature", m.temperature != null ? `${m.temperature} °C` : "—"],
          ["Density @15°C", m.density != null ? `${m.density} t/m³` : "—"],
          ["Bill of Lading qty", m.blQuantity != null ? tons(m.blQuantity) : "—"],
          ["Outturn quantity", m.outturnQuantity != null ? tons(m.outturnQuantity) : "—"],
        ]
      : [
          ["Displacement before", m.displacementBefore != null ? tons(m.displacementBefore) : "—"],
          ["Displacement after", m.displacementAfter != null ? tons(m.displacementAfter) : "—"],
          ["Deductibles", m.deductibles != null ? tons(m.deductibles) : "—"],
          ["Ship's constant", m.constant != null ? tons(m.constant) : "—"],
        ];

  return `
    <div class="cols">${particulars(doc)}</div>
    <h3 style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--slate);margin:24px 0 0">Measurement record</h3>
    <table>
      <thead><tr><th>Parameter</th><th class="num">Value</th></tr></thead>
      <tbody>
        ${measureRows.map(([k, v]) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`).join("")}
        <tr class="total"><td>Reconciled tonnage</td><td class="num">${tons(doc.reconciledTonnage)}</td></tr>
      </tbody>
    </table>
    <h3 style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--slate);margin:24px 0 0">Computed charges</h3>
    <table>
      <tbody>
        <tr><td>NPA harbour dues</td><td class="num">${money(doc.harbourDues)}</td></tr>
        <tr><td>Commission (${pct(doc.commissionRate)})</td><td class="num">${money(doc.commissionUSD)} &middot; ${naira(doc.commissionNGN)}</td></tr>
      </tbody>
    </table>
    <div class="sign">
      <div>Inspector — signature & date</div>
      <div>NPA officer — signature & date</div>
    </div>`;
}

export function printableHtml(kind, doc) {
  const isInvoice = kind === "invoice";
  const kindLabel = isInvoice ? "Tax Invoice" : "Inspection Certificate";
  const no = isInvoice
    ? doc.invoiceNo || doc.callRef
    : doc.inspectionRef || doc.callRef;
  const statusPill =
    isInvoice && doc.invoiceStatus
      ? `<span class="pill ${esc(doc.invoiceStatus)}">${esc(doc.invoiceStatus)}</span>`
      : "";

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
  <title>${esc(no)} — ${kindLabel}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet"/>
  <style>${STYLE}</style></head>
  <body>
    <div class="bar">
      <button onclick="window.print()" class="primary">Save as PDF / Print</button>
      <button onclick="window.close()">Close</button>
    </div>
    <div class="sheet">
      <div class="top">
        <div class="brand">
          <div class="glyph">${SHIP}</div>
          <div><h1>${esc(doc.port || "Port of Calabar")}</h1><div class="sub">Vessel Call & Cargo Inspection</div></div>
        </div>
        <div class="doctype">
          <div class="kind">${kindLabel}</div>
          <div class="no">${esc(no)}</div>
          <div class="meta">Issued ${date(doc.issued || doc.inspectionDate)}</div>
          ${statusPill}
        </div>
      </div>
      ${isInvoice ? invoiceBody(doc) : reportBody(doc)}
    </div>
  </body></html>`;
}

/**
 * Write the printable doc into a window. Pass a pre-opened window
 * (opened inside the click handler) so pop-up blockers stay happy.
 * Returns true on success.
 */
export function openPrintable(kind, doc, win) {
  const target = win || window.open("", "_blank");
  if (!target) return false;
  target.document.open();
  target.document.write(printableHtml(kind, doc));
  target.document.close();
  return true;
}
