// Variation invoice: approved quantities above the paid declaration, charged at
// the tariff rate. Drafted automatically when the final quantities are approved;
// Finance completes anything missing, checks the draft and prints it.
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBreadcrumbs } from "../app/breadcrumbs";
import { useStore } from "../app/store";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { ProductBrand } from "../components/ProductBrand";
import { Link, useLocation, useParams } from "../lib/navigation";
import { measurementApi } from "../measurements/api";
import { UNIT_LABELS } from "../measurements/cargoTemplates";
import { quantityDifference, readingQuantity } from "../measurements/comparison";
import { additionalLoadAmount, calculateVariation, useCloseoutPreviews, validMoney, type ApprovedReport, type PreviewInvoice, type PreviewInvoiceInput, type PreviewInvoiceStatus, type PreviewReport } from "../measurements/closeoutPreview";
import { dateLabel } from "../measurements/helpers";
import { invoiceInputFor, missingInvoiceDetails } from "../measurements/invoiceDraft";
import { ErrorMessage, PreviewStorageNotice } from "../measurements/shared";
import { perUnitLabel, useVariationTariff, validRate } from "../measurements/tariffs";
import { VoyageFrame, useVoyage, type VoyageData } from "../measurements/VoyageWorkspace";
import { STAGE_LABELS, STAGE_TONES, summarizeVoyages, voyagePath, type VoyageStage, type VoyageSummary } from "../measurements/voyageStatus";
import "../styles/variation-invoice.css";

const STATUS_LABELS: Record<PreviewInvoiceStatus, string> = {
  draft: "Draft invoice", "no-charge": "No additional charge", "overpayment-review": "On hold · overpayment review", held: "On hold",
};
const STATUS_TONES: Record<PreviewInvoiceStatus, string> = { draft: "amber", "no-charge": "green", "overpayment-review": "blue", held: "amber" };
const decimalLabel = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(2, "0")}`;
};
const money = (value: string, currency: string) => `${currency} ${decimalLabel(value)}`;
const rowKey = (line: { planId: string; lineId: string }) => `${line.planId}:${line.lineId}`;
const signed = (value: string | null) => {
  if (value === null) return "Unknown";
  if (value === "0" || /^[+-]?0(\.0+)?$/.test(value)) return "0";
  return `${value.startsWith("-") ? "−" : "+"}${readingQuantity(value.replace(/^[+-]/, ""))}`;
};
const charged = (variance: string | null) => variance !== null && variance !== "0" && !variance.startsWith("-");

function InvoiceDocument({ invoice, report, summary }: { invoice: PreviewInvoice; report: PreviewReport; summary: VoyageSummary }) {
  const additional = additionalLoadAmount(invoice.lines);
  const held = invoice.status === "overpayment-review" || invoice.status === "held";
  const below = invoice.lines.filter(line => line.status === "overpayment-review");
  return <article className="voyage-card invoice-document" aria-label={`Variation invoice ${invoice.number}`}>
    <header className="invoice-doc-head">
      <div className="invoice-doc-title"><ProductBrand className="document-brand" /><h2>Variation invoice</h2><p>Additional load above the paid declaration</p></div>
      <div className="invoice-doc-number"><strong>{invoice.number}</strong><span className={`stage-chip ${STATUS_TONES[invoice.status]}`}>{STATUS_LABELS[invoice.status]}</span><small>Drafted {dateLabel(invoice.createdAt)} · not issued</small></div>
    </header>
    <dl className="invoice-doc-facts">
      <div><dt>Billed to</dt><dd>{invoice.payer}</dd></div>
      <div><dt>Voyage</dt><dd>{summary.vesselName} · {summary.reference}{summary.arrival && <small>Arrived {dateLabel(summary.arrival)}</small>}</dd></div>
      <div><dt>Paid declaration · not charged again</dt><dd>{invoice.originalInvoiceReference}<small>{invoice.originalPaidAmount ? `${money(invoice.originalPaidAmount, invoice.currency)} · ` : ""}{invoice.paymentStatus === "paid" ? "payment confirmed" : "payment not confirmed"}</small></dd></div>
      <div><dt>Final quantities</dt><dd>Version {report.revision}<small>{report.approvedBy ? `Approved by ${report.approvedBy.name}${report.approvedAt ? ` · ${dateLabel(report.approvedAt)}` : ""}` : ""}</small></dd></div>
      <div><dt>Tariff</dt><dd>{invoice.tariffReference}</dd></div>
    </dl>
    <div className="invoice-scroll" role="region" aria-label="Invoice lines" tabIndex={0}>
      <table className="invoice-table">
        <caption className="hide-sr">Each cargo line: paid declaration, NPA final quantity, difference, rate and amount</caption>
        <thead><tr><th scope="col">Cargo line</th><th scope="col">Paid declaration</th><th scope="col">NPA final</th><th scope="col">Difference</th><th scope="col">Rate</th><th scope="col">Amount</th></tr></thead>
        <tbody>{invoice.lines.map(line => {
          const variance = line.variance;
          const above = charged(variance);
          const isBelow = line.status === "overpayment-review";
          return <tr key={rowKey(line)} className={isBelow ? "invoice-below" : undefined}>
            <th scope="row">{line.description}<small>{UNIT_LABELS[line.unit]}</small></th>
            <td>{readingQuantity(line.declaredQuantity)}</td>
            <td>{readingQuantity(line.finalQuantity)}</td>
            <td>{above ? <span className="var-badge above">{signed(variance)}</span> : isBelow ? <span className="var-badge below">{signed(variance)}</span> : <span className="invoice-muted">0</span>}</td>
            <td>{above ? <>{money(line.rate, invoice.currency)}<small>{perUnitLabel(line.unit, line.description)}</small></> : <span className="invoice-muted">—</span>}</td>
            <td>{isBelow ? <strong className="invoice-below-text">Overpayment review<small>not deducted</small></strong> : line.status === "held" ? <strong>On hold</strong> : above ? <strong>{money(line.amount, invoice.currency)}</strong> : <span className="invoice-muted">—</span>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <div className="invoice-totals">
      <div><span>Additional load</span><strong>{money(additional, invoice.currency)}</strong></div>
      <div className="invoice-total-due"><span>Total due</span><strong>{money(invoice.total, invoice.currency)}</strong></div>
      {held && <p role="status">{below.length ? `On hold until the overpayment review for ${below.map(line => line.description).join(", ")} is resolved. Today a lower line holds the whole invoice.` : "On hold for review: an earlier variation charge exceeds what is now due."}</p>}
    </div>
    <p className="invoice-doc-note">Only cargo above the paid declaration is charged. A lower final quantity is referred for overpayment review and is never netted off automatically. No credit note or refund is created.</p>
  </article>;
}

function InvoiceEditor({ voyage, report, initial, canEdit, onSaved, onCancel }: { voyage: VoyageData; report: ApprovedReport; initial: PreviewInvoiceInput; canEdit: boolean; onSaved: (invoice: PreviewInvoice) => void; onCancel?: () => void }) {
  const { user } = useAuth();
  const { toast } = useStore();
  const { preview, plans, summary } = voyage;
  const [input, setInput] = useState<PreviewInvoiceInput>(initial);
  const [error, setError] = useState<string | null>(null);
  const calculation = calculateVariation(report, input.lines);
  const missing = missingInvoiceDetails(input, report);
  const ratesValid = input.lines.every(line => validRate(line.rate) && validMoney(line.previousVariationAmount));
  const hasPrevious = input.lines.some(line => Number(line.previousVariationAmount) > 0);
  const outcome = ratesValid ? calculation.status : "held";
  const canSave = canEdit && !missing.length && ratesValid && calculation.issues.length === 0 && (!hasPrevious || input.previousVariationReference.trim() !== "") && (input.originalPaidAmount === "" || validMoney(input.originalPaidAmount));
  const setField = <K extends keyof PreviewInvoiceInput>(key: K, value: PreviewInvoiceInput[K]) => { setError(null); setInput(current => ({ ...current, [key]: value })); };
  const updateLine = (key: string, field: "rate" | "previousVariationAmount", value: string) => { setError(null); setInput(current => ({ ...current, lines: current.lines.map(line => rowKey(line) === key ? { ...line, [field]: value } : line) })); };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave || !user) return;
    const actor = { id: user.id, name: user.name };
    const declaration = summary.declaration;
    preview.saveDeclaration({ payer: input.payer, agent: declaration?.agent ?? "", invoiceReference: input.originalInvoiceReference, amountPaid: input.originalPaidAmount, currency: input.currency, paidOn: declaration?.paidOn ?? "", paymentStatus: input.paymentStatus }, actor);
    const invoice = preview.createInvoice(plans, report.id, input, actor);
    if (!invoice) { setError("The invoice could not be drafted. Check the approved quantities are still current."); return; }
    toast(invoice.status === "draft" ? `Variation invoice ${invoice.number} drafted` : `${STATUS_LABELS[invoice.status]} recorded`);
    onSaved(invoice);
  };
  return <form onSubmit={save} className="voyage-columns invoice-editor">
    <div className="voyage-main">
      {missing.length > 0 && <div className="measurement-notice warning" role="status"><strong>To draft the invoice automatically, complete:</strong><ul>{missing.map(item => <li key={item}>{item}</li>)}</ul>{missing.some(item => item.startsWith("Rate") || item === "Variation tariff") && <p>Rates come from the <Link to="/app/settings/tariffs">variation tariff</Link>; you can also enter them here for this invoice.</p>}</div>}
      <fieldset disabled={!canEdit} className="voyage-card voyage-card-pad invoice-fieldset">
        <legend className="invoice-legend">Paid declaration</legend>
        <p className="invoice-help">What the vessel owner already paid. It is shown on the invoice and never charged again.</p>
        <div className="invoice-fields">
          <label className="measurement-field"><span>Payer</span><input value={input.payer} onChange={event => setField("payer", event.target.value)} placeholder="Vessel owner or agent" /></label>
          <label className="measurement-field"><span>Declaration invoice number</span><input value={input.originalInvoiceReference} onChange={event => setField("originalInvoiceReference", event.target.value)} /></label>
          <label className="measurement-field"><span>Amount paid (optional)</span><input inputMode="decimal" value={input.originalPaidAmount} onChange={event => setField("originalPaidAmount", event.target.value)} /></label>
          <label className="measurement-field"><span>Payment</span><select value={input.paymentStatus} onChange={event => setField("paymentStatus", event.target.value as PreviewInvoiceInput["paymentStatus"])}><option value="paid">Confirmed paid</option><option value="unconfirmed">Not yet confirmed</option></select></label>
          <label className="measurement-field"><span>Currency</span><select value={input.currency} onChange={event => setField("currency", event.target.value as PreviewInvoiceInput["currency"])}><option value="USD">USD — US dollar</option><option value="NGN">NGN — Nigerian naira</option></select></label>
          <label className="measurement-field"><span>Tariff reference</span><input value={input.tariffReference} onChange={event => setField("tariffReference", event.target.value)} placeholder="For example: Variation tariff 2026 v2" /></label>
        </div>
      </fieldset>
      <fieldset disabled={!canEdit} className="voyage-card invoice-fieldset">
        <legend className="invoice-legend invoice-legend-pad">Additional load</legend>
        <div className="invoice-scroll" role="region" aria-label="Rates and amounts" tabIndex={0}>
          <table className="invoice-table">
            <thead><tr><th scope="col">Cargo line</th><th scope="col">Paid declaration</th><th scope="col">NPA final</th><th scope="col">Difference</th><th scope="col">Rate ({input.currency})</th><th scope="col">Amount</th></tr></thead>
            <tbody>{report.lines.map(line => {
              const configured = input.lines.find(item => rowKey(item) === rowKey(line))!;
              const result = calculation.lines.find(item => rowKey(item) === rowKey(line));
              const variance = quantityDifference(line.quantity, line.declaredQuantity);
              const above = charged(variance);
              return <tr key={rowKey(line)} className={variance?.startsWith("-") ? "invoice-below" : undefined}>
                <th scope="row">{line.description}<small>{UNIT_LABELS[line.unit]}</small></th>
                <td>{readingQuantity(line.declaredQuantity)}</td>
                <td>{readingQuantity(line.quantity)}</td>
                <td>{above ? <span className="var-badge above">{signed(variance)}</span> : variance?.startsWith("-") ? <span className="var-badge below">{signed(variance)}</span> : <span className="invoice-muted">0</span>}</td>
                <td>{above ? <label className="invoice-rate"><span className="hide-sr">Rate for {line.description}</span><input inputMode="decimal" value={configured.rate} onChange={event => updateLine(rowKey(line), "rate", event.target.value)} placeholder="Rate" /><small>{perUnitLabel(line.unit, line.description)}</small></label> : <span className="invoice-muted">Not charged</span>}</td>
                <td>{variance?.startsWith("-") ? <span className="invoice-below-text">Overpayment review</span> : above && result && validRate(configured.rate) ? money(result.amount, input.currency) : <span className="invoice-muted">—</span>}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        <details className="invoice-previous">
          <summary>Earlier variation charges (amendments only)</summary>
          <p className="invoice-help">If a variation invoice was already issued for this voyage, enter what it charged per line so only the remaining amount is invoiced.</p>
          <div className="invoice-fields">{report.lines.map(line => {
            const configured = input.lines.find(item => rowKey(item) === rowKey(line))!;
            return <label key={rowKey(line)} className="measurement-field"><span>Already charged for {line.description} ({input.currency})</span><input inputMode="decimal" value={configured.previousVariationAmount} onChange={event => updateLine(rowKey(line), "previousVariationAmount", event.target.value)} /></label>;
          })}<label className="measurement-field"><span>Earlier invoice reference{hasPrevious ? "" : " (optional)"}</span><input value={input.previousVariationReference} onChange={event => setField("previousVariationReference", event.target.value)} /></label></div>
        </details>
      </fieldset>
    </div>
    <aside className="voyage-aside">
      <section className="voyage-card voyage-card-pad invoice-summary" aria-labelledby="invoice-summary-heading">
        <h2 id="invoice-summary-heading">Outcome</h2>
        <span className={`stage-chip ${STATUS_TONES[outcome]}`}>{ratesValid ? STATUS_LABELS[outcome] : "Rates needed"}</span>
        <dl><div><dt>Additional load</dt><dd>{ratesValid ? money(additionalLoadAmount(calculation.lines), input.currency) : "—"}</dd></div><div className="invoice-total-due"><dt>Total due</dt><dd>{ratesValid ? money(calculation.total, input.currency) : "—"}</dd></div></dl>
        {outcome === "overpayment-review" && ratesValid && <p>A line is below the paid declaration. It goes to overpayment review, and today that holds the whole invoice.</p>}
        {outcome === "no-charge" && ratesValid && <p>Nothing was carried above the paid declaration. The outcome is still recorded.</p>}
        {calculation.issues.length > 0 && ratesValid && <p role="status">{calculation.issues[0]}</p>}
        {error && <p role="alert" className="invoice-error">{error}</p>}
        {canEdit ? <div className="readings-actions">{onCancel && <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>}<button className="btn btn-primary" type="submit" disabled={!canSave}>{outcome === "draft" ? "Draft variation invoice" : "Record outcome"}</button></div> : <p>Read-only. A Finance user completes and drafts the invoice.</p>}
        <PreviewStorageNotice />
      </section>
    </aside>
  </form>;
}

function InvoiceWorkspace({ voyage, requestedId }: { voyage: VoyageData; requestedId: string | null }) {
  const { can, org } = useAuth();
  const { tariff } = useVariationTariff(org?.id);
  const { preview, plans, summary } = voyage;
  const report = summary.report;
  const current = report ? preview.record.invoices.filter(item => item.reportId === report.id).at(-1) : undefined;
  const [editing, setEditing] = useState(false);
  const [viewedId, setViewedId] = useState<string | null>(requestedId);
  const canEdit = can("measurements.bill") && summary.stage !== "cancelled";
  const viewed = viewedId ? preview.record.invoices.find(item => item.id === viewedId) : undefined;
  const viewedReport = viewed ? preview.record.reports.find(item => item.id === viewed.reportId) : undefined;
  const history = [...preview.record.invoices].reverse();

  const historyList = history.length > 0 && <details className="voyage-card voyage-card-pad invoice-history voyage-no-print">
    <summary>Draft history ({history.length})</summary>
    <ul>{history.map(invoice => <li key={invoice.id}><span><strong>{invoice.number}</strong><small>{dateLabel(invoice.createdAt)} · {invoice.createdBy.name}{invoice.reportId !== report?.id ? " · earlier final quantities" : ""}</small></span><span className={`stage-chip ${STATUS_TONES[invoice.status]}`}>{STATUS_LABELS[invoice.status]}</span><button type="button" className="link-btn" aria-label={`View ${invoice.number}`} onClick={() => { setViewedId(invoice.id); setEditing(false); }}>View</button></li>)}</ul>
  </details>;

  if (viewed && viewedReport && viewed.id !== current?.id) return <>
    <div className="measurement-notice warning" role="status">Viewing earlier draft {viewed.number}. It is kept for reference and cannot be changed. <button type="button" className="link-btn" onClick={() => setViewedId(null)}>Back to the current invoice</button></div>
    <InvoiceDocument invoice={viewed} report={viewedReport} summary={summary} />
    {historyList}
  </>;

  const missingDraft = viewedId && !viewed && <div className="measurement-notice warning" role="status">That invoice draft is not saved in this browser. Showing the current invoice instead.</div>;

  if (!report) return <>
    {missingDraft}
    <section className="voyage-card voyage-card-pad invoice-empty">
      <Icon name="fileText" size={28} className="ico" />
      <h2>{summary.pending ? "Waiting for the final quantities to be approved" : "Approve the final quantities first"}</h2>
      <p>{summary.pending ? `Version ${summary.pending.revision} is with a second reviewer. The variation invoice is drafted automatically when it is approved.` : "The variation invoice compares NPA’s approved final quantities with the paid declaration. It is drafted automatically when the readings report is approved."}</p>
      <Link className="btn btn-primary" to={voyagePath(summary.callId, "readings")}>Open readings report <Icon name="chevronRight" size={16} /></Link>
    </section>
    {historyList}
  </>;

  if (current && !editing) return <>
    {missingDraft}
    <div className="measurement-notice invoice-banner voyage-no-print" role="status"><Icon name="check" size={16} strokeWidth={2.5} /> Drafted from final quantities version {report.revision}{report.approvedBy ? `, approved by ${report.approvedBy.name}` : ""}. Payer and paid declaration come from the voyage; rates from the tariff.</div>
    <InvoiceDocument invoice={current} report={report} summary={summary} />
    <div className="voyage-card voyage-footer voyage-no-print">
      <Link className="btn btn-secondary" to={voyagePath(summary.callId, "readings")}>View readings report</Link>
      <div className="readings-actions">
        {canEdit && <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}><Icon name="edit" size={16} /> Edit details</button>}
        <button type="button" className="btn btn-primary" onClick={() => window.print()}><Icon name="fileText" size={16} /> Print / save PDF</button>
      </div>
    </div>
    <PreviewStorageNotice />
    {historyList}
  </>;

  const initial = current ? { payer: current.payer, currency: current.currency, tariffReference: current.tariffReference, originalInvoiceReference: current.originalInvoiceReference, paymentStatus: current.paymentStatus, originalPaidAmount: current.originalPaidAmount, previousVariationReference: current.previousVariationReference, lines: current.lines.map(line => ({ planId: line.planId, lineId: line.lineId, rate: line.rate, previousVariationAmount: line.previousVariationAmount })) }
    : invoiceInputFor(report, plans, summary.declaration, tariff);
  return <>
    {missingDraft}
    <ErrorMessage error={preview.error ? new Error(preview.error) : null} />
    <InvoiceEditor voyage={voyage} report={report} initial={initial} canEdit={canEdit} onSaved={() => setEditing(false)} onCancel={current ? () => setEditing(false) : undefined} />
    {historyList}
  </>;
}

export function VariationInvoice() {
  const { callId = "" } = useParams<{ callId: string }>();
  const location = useLocation();
  const voyage = useVoyage(callId);
  const requested = new URLSearchParams(location.search).get("previewId");
  return <VoyageFrame voyage={voyage} step="variation-invoice">
    <InvoiceWorkspace key={callId} voyage={voyage} requestedId={requested} />
  </VoyageFrame>;
}

const INVOICE_STAGES: VoyageStage[] = ["invoice", "draft", "review", "held", "no-charge"];

export function VariationInvoices() {
  const { org } = useAuth();
  const store = useStore();
  useBreadcrumbs([{ label: "Invoices" }]);
  const previews = useCloseoutPreviews(org?.id);
  const plansQuery = useQuery({ queryKey: ["measurement-plans", org?.id, undefined], queryFn: () => measurementApi.list(), refetchInterval: 30_000 });
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<"all" | VoyageStage>("all");
  const voyages = summarizeVoyages(store.calls ?? [], plansQuery.data?.plans ?? [], previews.records).filter(voyage => INVOICE_STAGES.includes(voyage.stage));
  const query = search.trim().toLocaleLowerCase();
  const visible = voyages.filter(voyage => (stage === "all" || voyage.stage === stage) && (!query || [voyage.vesselName, voyage.reference, voyage.invoice?.number ?? "", voyage.invoice?.payer ?? voyage.declaration?.payer ?? ""].join(" ").toLocaleLowerCase().includes(query)))
    .sort((left, right) => INVOICE_STAGES.indexOf(left.stage) - INVOICE_STAGES.indexOf(right.stage) || (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? ""));
  const totals = new Map<string, number>();
  for (const voyage of voyages) if (voyage.stage === "draft" && voyage.invoice) totals.set(voyage.invoice.currency, (totals.get(voyage.invoice.currency) ?? 0) + Math.round(Number(voyage.invoice.total) * 100));
  return <div className="content-inner measurement-workspace invoices-page">
    <div className="page-head"><div><h1>Invoices</h1><p className="desc">Variation invoices for additional load above each voyage’s paid declaration, drafted when final quantities are approved.</p></div></div>
    <ErrorMessage error={plansQuery.error} />
    {previews.error && <p role="alert" className="measurement-notice error">{previews.error}</p>}
    <div className="invoice-tiles" role="group" aria-label="Invoices by outcome">
      {INVOICE_STAGES.map(key => {
        const count = voyages.filter(voyage => voyage.stage === key).length;
        return <button key={key} type="button" className={`invoice-tile${stage === key ? " on" : ""}`} aria-pressed={stage === key} onClick={() => setStage(current => current === key ? "all" : key)}><strong className={STAGE_TONES[key]}>{count}</strong><span>{STAGE_LABELS[key]}</span></button>;
      })}
    </div>
    {[...totals].length > 0 && <p className="invoice-draft-totals">Drafted, not yet issued: {[...totals].map(([currency, cents]) => money((cents / 100).toFixed(2), currency)).join(" · ")}</p>}
    <div className="filter-bar"><div className="search-input"><Icon name="search" size={17} /><input aria-label="Search invoices" placeholder="Vessel, voyage, invoice or payer" value={search} onChange={event => setSearch(event.target.value)} /></div>{stage !== "all" && <button type="button" className="link-btn" onClick={() => setStage("all")}>Show all outcomes</button>}</div>
    {plansQuery.isPending ? <div className="measurement-loading" role="status">Loading invoices…</div> : visible.length ? <div className="voyage-card invoice-scroll" role="region" aria-label="Variation invoices" tabIndex={0}>
      <table className="invoice-table invoice-list">
        <thead><tr><th scope="col">Voyage</th><th scope="col">Outcome</th><th scope="col">Final quantities</th><th scope="col">Payer</th><th scope="col">Amount</th><th scope="col"><span className="hide-sr">Open</span></th></tr></thead>
        <tbody>{visible.map(voyage => <tr key={voyage.callId}>
          <th scope="row">{voyage.vesselName}<small>{voyage.reference}</small></th>
          <td><span className={`stage-chip ${STAGE_TONES[voyage.stage]}`}>{STAGE_LABELS[voyage.stage]}</span>{voyage.invoice && <small>{voyage.invoice.number}</small>}</td>
          <td>{voyage.report ? <>Version {voyage.report.revision}<small>Approved {dateLabel(voyage.report.approvedAt)}</small></> : "—"}</td>
          <td>{voyage.invoice?.payer || voyage.declaration?.payer || <span className="invoice-muted">Not recorded</span>}</td>
          <td>{voyage.invoice ? money(voyage.invoice.total, voyage.invoice.currency) : <span className="invoice-muted">—</span>}</td>
          <td><Link className="btn btn-secondary btn-sm" to={voyagePath(voyage.callId, "variation-invoice")} aria-label={`Open invoice for ${voyage.vesselName} ${voyage.reference}`}>{voyage.stage === "invoice" ? "Complete" : "Open"}</Link></td>
        </tr>)}</tbody>
      </table>
    </div> : <section className="voyage-card voyage-card-pad invoice-empty"><Icon name="fileText" size={28} className="ico" /><h2>{voyages.length ? "No invoices match" : "No variation invoices yet"}</h2><p>{voyages.length ? "Change the search or outcome filter." : "When a voyage’s final quantities are approved, its variation invoice appears here — drafted automatically from the paid declaration and the tariff."}</p><Link className="btn btn-primary" to="/app/measurements">Open voyages <Icon name="chevronRight" size={16} /></Link></section>}
    <PreviewStorageNotice />
  </div>;
}
