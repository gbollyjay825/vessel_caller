import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "../app/store";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { ProductBrand } from "../components/ProductBrand";
import { Link, useLocation, useNavigate, useParams } from "../lib/navigation";
import { measurementApi } from "../measurements/api";
import { UNIT_LABELS } from "../measurements/cargoTemplates";
import { quantityDifference, readingQuantity } from "../measurements/comparison";
import {
  calculateVariation, currentReport, useCloseoutPreview, useCloseoutPreviews,
  type PreviewInvoice, type PreviewInvoiceInput, type PreviewReport,
} from "../measurements/closeoutPreview";
import { dateLabel } from "../measurements/helpers";
import { ErrorMessage } from "../measurements/shared";
import type { Actor, MeasurementPlan } from "../measurements/types";
import { VoyageWorkflowNav } from "../measurements/VoyageWorkflowNav";
import "../styles/measurements.css";
import "../styles/variation-invoice.css";

const STATUS_LABELS: Record<PreviewInvoice["status"], string> = {
  draft: "Draft preview", "no-charge": "No additional charge", "overpayment-review": "Overpayment for review", held: "Billing on hold",
};
const decimalLabel = (value: string, minimum = 2) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(minimum, "0")}`;
};
const money = (value: string, currency: string) => `${currency} ${decimalLabel(value)}`;
const statusClass = (status: PreviewInvoice["status"]) => status === "overpayment-review" ? "review" : status === "held" ? "held" : "";
const rowKey = (line: { planId: string; lineId: string }) => `${line.planId}:${line.lineId}`;
const validAmount = (value: string, decimals = 2) => new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`).test(value);
const differenceLabel = (value: string | null) => {
  if (value === null) return "Unknown";
  const label = readingQuantity(value.replace(/^[+-]/, ""));
  if (label === "NIL (0)") return "0";
  if (label === "Not provided") return "Unknown";
  return `${value.startsWith("-") ? "−" : "+"}${label}`;
};

function initialInput(report: PreviewReport, previous?: PreviewInvoice): PreviewInvoiceInput {
  return {
    payer: previous?.payer ?? "", currency: previous?.currency ?? "USD", tariffReference: previous?.tariffReference ?? "",
    originalInvoiceReference: previous?.originalInvoiceReference ?? "", paymentStatus: previous?.paymentStatus ?? "unconfirmed",
    originalPaidAmount: previous?.originalPaidAmount ?? "", previousVariationReference: previous?.previousVariationReference ?? "",
    lines: report.lines.map(line => {
      const saved = previous?.lines.find(item => rowKey(item) === rowKey(line));
      return { planId: line.planId, lineId: line.lineId, rate: saved?.rate ?? "", previousVariationAmount: saved?.previousVariationAmount ?? "0" };
    }),
  };
}

function InvoiceDocument({ invoice, report, vesselName, voyageReference }: { invoice: PreviewInvoice; report: PreviewReport; vesselName: string; voyageReference: string }) {
  return <article className="variation-invoice-document" aria-label="Saved voyage invoice preview">
    <div className="variation-document-head"><div><ProductBrand className="document-brand" /><h2>{invoice.status === "draft" ? "Additional invoice" : invoice.status === "overpayment-review" ? "Review overpayment" : invoice.status === "no-charge" ? "No additional invoice" : "Invoice review"}</h2><p>{vesselName} · {voyageReference}</p></div><div className="variation-document-number"><span className={`variation-status ${statusClass(invoice.status)}`}>{STATUS_LABELS[invoice.status]}</span><strong>{invoice.number}</strong><p>Prepared {dateLabel(invoice.createdAt)}</p><p>Reconciliation revision {report.revision}</p></div></div>
    <dl className="variation-document-facts"><div><dt>Billed to</dt><dd>{invoice.payer}</dd></div><div><dt>Original declaration invoice</dt><dd>{invoice.originalInvoiceReference}<br />{invoice.paymentStatus === "paid" ? "Paid — recorded in this preview" : "Payment unconfirmed"}</dd></div><div><dt>Original payment amount</dt><dd>{invoice.originalPaidAmount ? money(invoice.originalPaidAmount, invoice.currency) : "Not recorded"}<br />Original declaration payment; excluded from any additional charge.</dd></div><div><dt>Rate reference</dt><dd>{invoice.tariffReference}</dd></div><div><dt>Previous variation reference</dt><dd>{invoice.previousVariationReference || "No previous variation charges recorded"}</dd></div><div><dt>Prepared by</dt><dd>{invoice.createdBy.name}<br />NPA final quantities reviewed by {report.approvedBy.name}</dd></div></dl>
    <div className="variation-table-scroll" role="region" aria-label="Saved invoice quantities and amounts" tabIndex={0}><table className="variation-table"><caption>Variation = NPA final quantity minus the paid owner declaration. Only extra load creates an additional charge.</caption><thead><tr><th scope="col">Cargo item / unit</th><th scope="col">Owner declaration</th><th scope="col">NPA final</th><th scope="col">Difference</th><th scope="col">Rate</th><th scope="col">Previous variation</th><th scope="col">Additional amount</th></tr></thead><tbody>{invoice.lines.map(line => <tr key={rowKey(line)} className={line.status === "overpayment-review" || line.status === "held" ? "variation-row-review" : ""}><th scope="row">{line.description}<small>{UNIT_LABELS[line.unit]}</small></th><td>{readingQuantity(line.declaredQuantity)}</td><td className="variation-quantity-final">{readingQuantity(line.finalQuantity)}</td><td>{differenceLabel(line.variance)}</td><td>{money(line.rate, invoice.currency)}<small>per {UNIT_LABELS[line.unit]}</small></td><td>{money(line.previousVariationAmount, invoice.currency)}</td><td>{line.status === "overpayment-review" ? <strong>Overpayment for review</strong> : line.status === "held" ? <strong>On hold</strong> : <>{money(line.amount, invoice.currency)}{(invoice.status === "held" || invoice.status === "overpayment-review") && <small>Held with this review</small>}</>}</td></tr>)}</tbody></table></div>
    <div className="variation-document-total"><span>{invoice.status === "draft" ? "Additional amount to invoice" : invoice.status === "no-charge" ? "Additional charge" : "Amount held for review"}</span><strong>{money(invoice.total, invoice.currency)}</strong></div>
    <p className="variation-document-note"><strong>UI preview — not an issued invoice.</strong> Payment status, rates and previous charges were entered for review and have not been verified against accounting records. No payment, credit note or refund has been created. {invoice.status === "overpayment-review" && "A lower final quantity is flagged for review; it is not offset against other cargo items."}</p>
    <div className="variation-document-actions"><Link className="btn btn-secondary" to={`/app/measurements/voyages/${encodeURIComponent(report.callId)}/reconciliation`}>View reconciliation report</Link><button className="btn btn-secondary" type="button" onClick={() => window.print()}><Icon name="fileText" size={16} /> Print / save PDF</button><Link className="btn btn-primary" to="/app/dashboard">View activity dashboard <Icon name="chevronRight" size={16} /></Link></div>
  </article>;
}

function InvoiceEditor({ report, plans, orgId, callId, actor, vesselName, voyageReference, canEdit, onSaved }: { report: PreviewReport; plans: MeasurementPlan[]; orgId?: string; callId: string; actor: Actor; vesselName: string; voyageReference: string; canEdit: boolean; onSaved?: (invoice: PreviewInvoice) => void }) {
  const preview = useCloseoutPreview(orgId, callId);
  const saved = preview.record.invoices.filter(item => item.reportId === report.id).at(-1);
  const [isEditing, setIsEditing] = useState(() => !saved);
  const [viewedInvoiceId, setViewedInvoiceId] = useState<string | null>(null);
  const viewedInvoice = preview.record.invoices.find(item => item.id === viewedInvoiceId) ?? saved;
  const viewedReport = viewedInvoice ? preview.record.reports.find(item => item.id === viewedInvoice.reportId) : undefined;
  const [input, setInput] = useState<PreviewInvoiceInput>(() => initialInput(report, saved));
  const [saveError, setSaveError] = useState<string | null>(null);
  const calculation = calculateVariation(report, input.lines);
  const ratesValid = input.lines.every(line => validAmount(line.rate, 4) && validAmount(line.previousVariationAmount));
  const hasPreviousCharges = input.lines.some(line => Number(line.previousVariationAmount) > 0);
  const detailsValid = Boolean(input.payer.trim() && input.tariffReference.trim() && input.originalInvoiceReference.trim() && (!input.originalPaidAmount || validAmount(input.originalPaidAmount)) && (!hasPreviousCharges || input.previousVariationReference.trim()));
  const canSave = canEdit && ratesValid && detailsValid && calculation.issues.length === 0 && (calculation.status !== "draft" || input.paymentStatus === "paid");
  const setField = <K extends keyof PreviewInvoiceInput>(key: K, value: PreviewInvoiceInput[K]) => { setSaveError(null); setInput(current => ({ ...current, [key]: value })); };
  const updateLine = (key: string, field: "rate" | "previousVariationAmount", value: string) => { setSaveError(null); setInput(current => ({ ...current, lines: current.lines.map(line => rowKey(line) === key ? { ...line, [field]: value } : line) })); };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    const result = preview.createInvoice(plans, report.id, input, actor);
    if (!result) setSaveError("The preview could not be saved. Review the current reconciliation and try again.");
    else { setSaveError(null); setViewedInvoiceId(result.id); setIsEditing(false); onSaved?.(result); }
  };
  const outcome = ratesValid ? calculation.status : "held";
  const actionLabel = outcome === "draft" ? saved ? "Save draft preview" : "Generate draft preview" : outcome === "overpayment-review" ? "Flag overpayment for review" : outcome === "no-charge" ? "Save no-charge outcome" : "Save billing hold";
  return <>
    <p className="variation-reconciliation-reference variation-invoice-noprint"><strong>Reconciliation revision {report.revision}</strong> · Reviewed by {report.approvedBy.name} · {dateLabel(report.approvedAt)} <Link to={`/app/measurements/voyages/${encodeURIComponent(callId)}/reconciliation`}>View report</Link></p>
    <ErrorMessage error={preview.error} />
    {isEditing && <form onSubmit={save} className="variation-layout">
      <div className="variation-main">
        <section className="variation-payment-card" aria-labelledby="variation-payment-title"><div className="variation-section-eyebrow">1 · Confirm the paid declaration</div><h2 id="variation-payment-title">Original declaration invoice</h2><p className="variation-section-description">The vessel owner has already paid for the declared load. Keep that invoice separate from any additional quantity below.</p><fieldset disabled={!canEdit} className="variation-fields" style={{ border: 0, padding: 0, margin: 0 }}>
          <label className="measurement-field"><span>Vessel owner / payer</span><input value={input.payer} required onChange={event => setField("payer", event.target.value)} placeholder="Name shown on the original invoice" /></label>
          <label className="measurement-field"><span>Original invoice reference</span><input value={input.originalInvoiceReference} required onChange={event => setField("originalInvoiceReference", event.target.value)} placeholder="Declaration invoice number" /></label>
          <label className="measurement-field"><span>Declaration payment status</span><select value={input.paymentStatus} onChange={event => setField("paymentStatus", event.target.value as PreviewInvoiceInput["paymentStatus"])}><option value="unconfirmed">Payment not confirmed</option><option value="paid">Paid — recorded for preview</option></select><small>Entered for this UI review. Accounting verification will be added later.</small></label>
          <label className="measurement-field"><span>Original paid amount (optional)</span><input value={input.originalPaidAmount} inputMode="decimal" onChange={event => setField("originalPaidAmount", event.target.value)} placeholder="Amount already paid" /><small>{input.currency}; excluded from the additional charge.</small></label>
          <label className="measurement-field"><span>Invoice currency</span><select value={input.currency} onChange={event => setField("currency", event.target.value as PreviewInvoiceInput["currency"])}><option value="USD">USD — US dollar</option><option value="NGN">NGN — Nigerian naira</option></select><small>All rates and amounts are entered in this currency. No exchange conversion.</small></label>
          <label className="measurement-field"><span>Rate / tariff reference</span><input value={input.tariffReference} required onChange={event => setField("tariffReference", event.target.value)} placeholder="Reference for the rates entered below" /><small>Enter agreed rates for preview; an NPA tariff is not prefilled.</small></label>
        </fieldset></section>
        <section className="variation-lines-card" aria-labelledby="variation-lines-title"><div className="variation-section-eyebrow">2 · Calculate the variation</div><h2 id="variation-lines-title">Additional load</h2><p className="variation-section-description">Compare the paid declaration with NPA’s final quantity. Each cargo item keeps its own unit.</p>
          <div className="variation-table-scroll" role="region" aria-label="Variation calculation table" tabIndex={0}><table className="variation-table"><thead><tr><th scope="col">Cargo item / unit</th><th scope="col">Paid declaration</th><th scope="col">NPA final</th><th scope="col">Difference</th><th scope="col">Rate ({input.currency})</th><th scope="col">Previous variation ({input.currency})</th><th scope="col">Additional amount</th></tr></thead><tbody>{report.lines.map((line, index) => {
            const configured = input.lines[index]; const result = calculation.lines.find(item => rowKey(item) === rowKey(line));
            const baselineMissing = line.declaredQuantity === null;
            return <tr key={rowKey(line)} className={result?.status === "overpayment-review" || baselineMissing ? "variation-row-review" : ""}><th scope="row">{line.description}<small>{UNIT_LABELS[line.unit]}</small></th><td>{readingQuantity(line.declaredQuantity)}{baselineMissing && <small>Declaration required</small>}</td><td className="variation-quantity-final">{readingQuantity(line.quantity)}</td><td>{differenceLabel(quantityDifference(line.quantity, line.declaredQuantity))}</td><td><label className="measurement-field"><span className="variation-field-label">Rate for {line.description}</span><input value={configured.rate} inputMode="decimal" disabled={!canEdit} required onChange={event => updateLine(rowKey(line), "rate", event.target.value)} placeholder="Enter rate" /><small>per {UNIT_LABELS[line.unit]}</small></label></td><td><label className="measurement-field"><span className="variation-field-label">Previous variation charge for {line.description}</span><input value={configured.previousVariationAmount} disabled={!canEdit} inputMode="decimal" required onChange={event => updateLine(rowKey(line), "previousVariationAmount", event.target.value)} /></label></td><td>{result?.status === "overpayment-review" ? <strong>Review overpayment</strong> : result?.status === "held" || baselineMissing ? <span>On hold</span> : validAmount(configured.rate, 4) && validAmount(configured.previousVariationAmount) && result ? money(result.amount, input.currency) : "Enter a rate"}</td></tr>;
          })}</tbody></table></div>
          <p className="variation-section-description">Additional amount = positive difference × rate − previous charges for that same variation. The original declaration payment is excluded.</p>
          <label className="measurement-field"><span>Previous variation reference{hasPreviousCharges ? "" : " (optional)"}</span><input value={input.previousVariationReference} disabled={!canEdit} required={hasPreviousCharges} onChange={event => setField("previousVariationReference", event.target.value)} placeholder="Only for additional quantity charged previously" /><small>Record previous variation charges once. Saved draft previews have not been issued or paid.</small></label>
        </section>
      </div>
      <aside className="variation-summary" aria-labelledby="variation-summary-title"><h2 id="variation-summary-title">Additional invoice summary</h2><span className={`variation-status ${statusClass(outcome)}`}>{ratesValid ? STATUS_LABELS[outcome] : "Rates required"}</span><dl><div><dt>Cargo items</dt><dd>{report.lines.length}</dd></div><div><dt>Reconciliation</dt><dd>Revision {report.revision}</dd></div><div className="variation-total"><dt>Additional amount</dt><dd>{ratesValid ? money(calculation.total, input.currency) : "—"}</dd></div></dl>
        {outcome === "overpayment-review" ? <p>One or more final quantities are lower than the paid declaration. Flag the overpayment for review. No credit or refund will be created.</p> : outcome === "held" && ratesValid ? <p>A declaration is missing or a previous variation charge exceeds the current entitlement. Keep billing on hold for review.</p> : outcome === "no-charge" && ratesValid ? <p>No additional amount is due for these cargo items.</p> : <p>Only the additional load is included. The original declaration is not charged again.</p>}
        {ratesValid && input.paymentStatus === "unconfirmed" && outcome === "draft" && <p role="status">Record the declaration as paid before preparing the draft invoice.</p>}
        {ratesValid && calculation.issues.length > 0 && <p role="status">{calculation.issues[0]}</p>}
        {!canEdit && <p>Read-only access. A billing user can prepare this preview.</p>}
        {canEdit && <button className="btn btn-primary" type="submit" disabled={!canSave}>{actionLabel}</button>}
        {saveError && <p role="alert">{saveError}</p>}
        <p>Saved in this browser for UI review. No invoice is issued.</p>
      </aside>
    </form>}
    {!isEditing && viewedInvoice && <div className="measurement-notice variation-invoice-noprint" role="status"><strong>{STATUS_LABELS[viewedInvoice.status]} saved.</strong><p>The document below is ready for review. No invoice has been issued.</p>{canEdit && <button type="button" className="link-btn" onClick={() => { setViewedInvoiceId(null); setIsEditing(true); }}>Edit draft details <Icon name="chevronRight" size={14} /></button>}</div>}
    {viewedInvoice && viewedReport && <><p className="variation-section-description variation-invoice-noprint">Saved document: {viewedInvoice.id === saved?.id ? "current draft preview" : "previous preview version; retained for review"}.</p><InvoiceDocument invoice={viewedInvoice} report={viewedReport} vesselName={vesselName} voyageReference={voyageReference} /></>}
    {preview.record.invoices.length > 0 && <details className="variation-history"><summary>Saved preview history ({preview.record.invoices.length})</summary><ul className="variation-history-list">{[...preview.record.invoices].reverse().map(invoice => <li key={invoice.id}><span><strong>{invoice.number}</strong><small>{dateLabel(invoice.createdAt)} · {invoice.createdBy.name}</small></span><span>{STATUS_LABELS[invoice.status]}<small>{money(invoice.total, invoice.currency)}{invoice.reportId !== report.id ? " · Previous reconciliation" : ""}</small><button type="button" className="link-btn" onClick={() => { setViewedInvoiceId(invoice.id); setIsEditing(false); }} aria-label={`View ${invoice.number}`}>View saved preview</button></span></li>)}</ul></details>}
  </>;
}

export function VariationInvoice() {
  const { callId = "" } = useParams<{ callId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const search = new URLSearchParams(location.search);
  const requestedPreviewId = search.has("previewId") ? search.get("previewId") : null;
  const { org, user, can } = useAuth();
  const store = useStore();
  const records = useQuery({ queryKey: ["measurement-plans", org?.id, callId], queryFn: () => measurementApi.list(callId), refetchInterval: 30_000 });
  const plans = records.data?.plans.filter(plan => plan.callId === callId) ?? [];
  const preview = useCloseoutPreview(org?.id, callId);
  const report = currentReport(plans, preview.record);
  const call = store.calls?.find(item => item.id === callId);
  const vesselName = call?.vesselName ?? plans[0]?.vesselName ?? "Vessel";
  const voyageReference = call?.reference ?? plans[0]?.callReference ?? callId;
  const historicalInvoice = preview.record.invoices.at(-1);
  const historicalReport = historicalInvoice ? preview.record.reports.find(item => item.id === historicalInvoice.reportId) : undefined;
  const selectedInvoice = requestedPreviewId !== null ? preview.record.invoices.find(item => item.id === requestedPreviewId) : undefined;
  const selectedReport = selectedInvoice ? preview.record.reports.find(item => item.id === selectedInvoice.reportId) : undefined;
  const currentInvoice = report ? preview.record.invoices.filter(item => item.reportId === report.id).at(-1) : undefined;
  const currentInvoicePath = `/app/measurements/voyages/${encodeURIComponent(callId)}/variation-invoice`;
  let body: ReactNode;
  if (records.isPending) body = <div className="measurement-loading" role="status">Loading voyage quantities…</div>;
  else if (requestedPreviewId !== null && (!selectedInvoice || !selectedReport)) body = <section className="variation-empty variation-invoice-noprint"><h2>Saved invoice preview not found</h2><p>This invoice preview is not available for this voyage in the current browser.</p><Link className="btn btn-primary" to={currentInvoicePath}>Back to current voyage invoice</Link></section>;
  else if (selectedInvoice && selectedReport && (records.error || currentInvoice?.id !== selectedInvoice.id || report?.id !== selectedReport.id)) body = <><p className="measurement-notice warning variation-invoice-noprint" role="status">Viewing saved invoice {selectedInvoice.number}. This saved preview is read-only{records.error ? "; current readings could not be verified" : report?.id !== selectedReport.id ? "; its reconciliation is no longer current" : "; a newer draft version exists"}. <Link to={currentInvoicePath}>Open current voyage invoice</Link></p><InvoiceDocument invoice={selectedInvoice} report={selectedReport} vesselName={selectedReport.sourcePlans[0]?.vesselName ?? vesselName} voyageReference={selectedReport.sourcePlans[0]?.callReference ?? voyageReference} /></>;
  else if (records.error) body = null;
  else if (report) body = <InvoiceEditor key={`${report.id}:${requestedPreviewId ?? "current"}`} report={report} plans={plans} orgId={org?.id} callId={callId} actor={{ id: user?.id ?? "preview-user", name: user?.name ?? "NPA reviewer" }} vesselName={vesselName} voyageReference={voyageReference} canEdit={call?.status !== "cancelled" && can("measurements.bill")} onSaved={requestedPreviewId !== null ? invoice => navigate(`${currentInvoicePath}?previewId=${encodeURIComponent(invoice.id)}`, { replace: true }) : undefined} />;
  else body = <><section className="variation-empty variation-invoice-noprint"><Icon name="fileText" size={28} className="ico" /><h2>Review NPA’s final quantities first</h2><p>{preview.record.reports.length ? "The readings have changed since the saved reconciliation. Review and approve the current quantities before preparing an additional invoice." : "A current reconciliation report is needed to compare the final load with the owner’s paid declaration."}</p><Link className="btn btn-primary" to={`/app/measurements/voyages/${encodeURIComponent(callId)}/reconciliation`}>Open reconciliation report <Icon name="chevronRight" size={16} /></Link></section>{historicalInvoice && historicalReport && <><p className="measurement-notice warning variation-invoice-noprint">Historical preview only. Its reconciliation is no longer current; no new invoice can be prepared from these quantities.</p><InvoiceDocument invoice={historicalInvoice} report={historicalReport} vesselName={vesselName} voyageReference={voyageReference} /></>}</>;
  return <div className="content-inner measurement-workspace variation-invoice-page">
    <Link className="measurement-back" to="/app/measurements"><Icon name="chevronLeft" size={16} /> Voyages</Link>
    <div className="page-head"><div><h1>Voyage invoice</h1><p className="desc"><strong>{vesselName}</strong> · {voyageReference}</p></div><span className="variation-preview-label">UI preview</span></div>
    <VoyageWorkflowNav callId={callId} active="variation-invoice" />
    <p className="variation-definition variation-invoice-noprint">Variation is NPA’s final quantity minus the owner’s paid declaration. An additional invoice covers only the extra load; a lower final quantity is flagged for review.</p>
    {call?.status === "cancelled" && <p role="status" className="measurement-notice warning variation-invoice-noprint">This voyage is cancelled. Saved previews remain available for reference; new invoice drafts are disabled.</p>}
    <ErrorMessage error={records.error || preview.error} />
    {body}
  </div>;
}

export function VariationInvoices() {
  const { org } = useAuth();
  const store = useStore();
  const preview = useCloseoutPreviews(org?.id);
  const recordsQuery = useQuery({ queryKey: ["measurement-plans", org?.id, undefined], queryFn: () => measurementApi.list(), refetchInterval: 30_000 });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const invoices = preview.records.flatMap(record => {
    const call = store.calls?.find(item => item.id === record.callId);
    const livePlans = recordsQuery.data?.plans.filter(plan => plan.callId === record.callId);
    const approved = livePlans ? currentReport(livePlans, record) : undefined;
    return record.invoices.map((invoice, index) => {
      const report = record.reports.find(item => item.id === invoice.reportId);
      const vesselName = call?.vesselName ?? report?.sourcePlans[0]?.vesselName ?? "Vessel";
      const reference = call?.reference ?? report?.sourcePlans[0]?.callReference ?? record.callId;
      const freshness = recordsQuery.isPending ? "Checking readings…" : recordsQuery.error ? "Freshness unavailable" : approved?.id !== invoice.reportId ? "Reconciliation needs review" : index < record.invoices.length - 1 ? "Previous draft version" : "Current preview";
      return { invoice, vesselName, reference, freshness };
    });
  }).sort((left, right) => right.invoice.createdAt.localeCompare(left.invoice.createdAt));
  const filtered = invoices.filter(item => (status === "all" || item.invoice.status === status) && `${item.vesselName} ${item.reference} ${item.invoice.number} ${item.invoice.originalInvoiceReference} ${item.invoice.payer}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className="content-inner measurement-workspace variation-invoices-page"><div className="page-head"><div><h1>Invoices</h1><p className="desc">Each voyage’s paid declaration and any additional invoice from NPA’s final reconciliation.</p></div><span className="variation-preview-label">UI preview</span></div>
    <p className="variation-section-description">Browser-saved draft previews. No invoices have been issued and no accounting payment has been verified. Previous draft versions are retained for review.</p><ErrorMessage error={preview.error || recordsQuery.error} />
    {invoices.length > 0 ? <><div className="variation-list-toolbar"><label className="measurement-field"><span>Find an invoice</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Vessel, voyage, invoice or payer" /></label><label className="measurement-field"><span>Outcome</span><select value={status} onChange={event => setStatus(event.target.value)}><option value="all">All outcomes</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><div className="variation-table-scroll" role="region" aria-label="Voyage invoice previews" tabIndex={0}><table className="variation-table variation-list-table"><thead><tr><th scope="col">Voyage</th><th scope="col">Additional invoice / review</th><th scope="col">Original declaration invoice</th><th scope="col">Payer</th><th scope="col">Outcome</th><th scope="col">Additional amount</th></tr></thead><tbody>{filtered.length ? filtered.map(({ invoice, vesselName, reference, freshness }) => <tr key={invoice.id}><th scope="row"><Link to={`/app/measurements/voyages/${encodeURIComponent(invoice.callId)}/variation-invoice`}>{vesselName}</Link><small>{reference}</small></th><td><Link to={`/app/measurements/voyages/${encodeURIComponent(invoice.callId)}/variation-invoice?previewId=${encodeURIComponent(invoice.id)}`} aria-label={`Open invoice preview ${invoice.number}`}>{invoice.number}</Link><small>{dateLabel(invoice.createdAt)} · {freshness}</small></td><td>{invoice.originalInvoiceReference}<small>{invoice.paymentStatus === "paid" ? "Paid — recorded for preview" : "Payment unconfirmed"}</small></td><td>{invoice.payer}</td><td><span className={`variation-status ${statusClass(invoice.status)}`}>{STATUS_LABELS[invoice.status]}</span></td><td className="variation-numeric">{money(invoice.total, invoice.currency)}</td></tr>) : <tr><td colSpan={6}>No preview invoices match these filters.</td></tr>}</tbody></table></div></> : <section className="variation-empty"><Icon name="fileText" size={28} className="ico" /><h2>No invoice previews yet</h2><p>Open a voyage, review the NPA reconciliation, then record the original paid declaration invoice and prepare an additional invoice for any extra load. Voyages with no additional charge or overpayment can also be recorded for review.</p><Link className="btn btn-primary" to="/app/measurements">Open voyages <Icon name="chevronRight" size={16} /></Link></section>}
  </div>;
}
