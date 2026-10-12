import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "../app/store";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { Link } from "../lib/navigation";
import { measurementApi } from "../measurements/api";
import { currentReport, reconciliationIssues, useCloseoutPreviews } from "../measurements/closeoutPreview";
import type { CloseoutRecord, PreviewInvoice } from "../measurements/closeoutPreview";
import { dateLabel, latestReturns } from "../measurements/helpers";
import { ErrorMessage } from "../measurements/shared";
import type { MeasurementPlan } from "../measurements/types";
import type { VesselCall } from "../types";
import "../styles/measurements.css";
import "../styles/activity-dashboard.css";

type VoyageStage = "declaration" | "collecting" | "ready" | "approved" | "draft" | "no-charge" | "review" | "held" | "cancelled";
type ActivityVoyage = {
  callId: string; vesselName: string; reference: string; arrival: string; plans: MeasurementPlan[];
  stage: VoyageStage; received: number; expected: number; blockers: string[]; pendingAgencies: string[];
  missingDeclarations: string[]; approved: boolean; invoice?: PreviewInvoice;
};
type ActivityEntry = { id: string; callId: string; at: string; actor: string; title: string; reference: string; href: string; preview: boolean };
type Access = { manage: boolean; approve: boolean; bill: boolean };
const EMPTY_PLANS: MeasurementPlan[] = [];
const STAGES: Record<VoyageStage, { label: string; order: number }> = {
  declaration: { label: "Owner declaration", order: 5 }, collecting: { label: "Agency readings", order: 4 },
  ready: { label: "NPA review", order: 2 }, approved: { label: "Invoice to prepare", order: 3 },
  draft: { label: "Invoice draft prepared", order: 6 }, "no-charge": { label: "No additional charge", order: 7 },
  review: { label: "Overpayment review", order: 0 }, held: { label: "Billing review", order: 1 }, cancelled: { label: "Cancelled", order: 8 },
};
const voyagePath = (callId: string, suffix: string) => `/app/measurements/voyages/${encodeURIComponent(callId)}/${suffix}`;
const preparedStage = (stage: VoyageStage) => stage === "draft" || stage === "no-charge";
const needsAttention = (stage: VoyageStage) => !preparedStage(stage) && stage !== "cancelled";
function amountCents(amount: string): bigint | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) return null;
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
function moneyLabel(currency: string, amount: string | bigint): string {
  const cents = typeof amount === "bigint" ? amount : amountCents(amount);
  if (cents === null) return "Amount unavailable";
  const fractionalDigits = new Intl.NumberFormat(undefined, { useGrouping: false, minimumIntegerDigits: 2 }).format(cents % 100n);
  return new Intl.NumberFormat(undefined, { style: "currency", currency, currencyDisplay: "code", minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .formatToParts(cents / 100n).map(part => part.type === "fraction" ? fractionalDigits : part.value).join("");
}
const declaredQuantityValid = (value: string | null) => value !== null && /^\d{1,15}(?:\.\d{1,6})?$/.test(value.trim());
const readableNames = (names: string[]) => names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");

export function activityVoyages(calls: VesselCall[], plans: MeasurementPlan[], records: CloseoutRecord[]): ActivityVoyage[] {
  const byCall = new Map<string, { call?: VesselCall; plans: MeasurementPlan[] }>();
  for (const call of calls) byCall.set(call.id, { call, plans: [] });
  for (const plan of plans) {
    const entry = byCall.get(plan.callId) ?? { plans: [] };
    entry.plans.push(plan); byCall.set(plan.callId, entry);
  }
  const previewByCall = new Map(records.map(record => [record.callId, record]));
  return [...byCall].map(([callId, entry]) => {
    const cancelled = entry.call?.status === "cancelled";
    const activePlans = entry.plans.filter(plan => plan.status !== "cancelled");
    const record = previewByCall.get(callId);
    const report = currentReport(activePlans, record);
    const blockers = reconciliationIssues(activePlans);
    const invoice = report ? record?.invoices.filter(item => item.reportId === report.id).at(-1) : undefined;
    const expected = activePlans.reduce((sum, plan) => sum + plan.participants.length, 0);
    let received = 0;
    const pendingNames = new Set<string>();
    for (const plan of activePlans) {
      const readings = latestReturns(plan);
      for (const party of plan.participants) {
        const reading = readings.get(party.id);
        if (reading) received++;
        if (party.requiredSubmission && (!reading || plan.lines.some(line => {
          const row = reading.lines.find(item => item.lineId === line.id);
          return !row || (row.status === "reported" ? !declaredQuantityValid(row.quantity) : !row.note.trim());
        }))) pendingNames.add(party.name);
      }
    }
    const missingDeclarations = [...new Set(activePlans.flatMap(plan => plan.lines.filter(line => !declaredQuantityValid(line.manifestQuantity)).map(line => line.description)))];
    const stage: VoyageStage = cancelled ? "cancelled" : !activePlans.length || missingDeclarations.length ? "declaration"
      : invoice?.status === "overpayment-review" ? "review" : invoice?.status === "held" ? "held"
      : invoice?.status === "no-charge" ? "no-charge" : invoice?.status === "draft" ? "draft"
      : report ? "approved" : blockers.length ? "collecting" : "ready";
    return {
      callId, vesselName: entry.call?.vesselName ?? entry.plans[0]?.vesselName ?? "Vessel",
      reference: entry.call?.reference ?? entry.plans[0]?.callReference ?? callId,
      arrival: entry.call?.eta ?? "", plans: activePlans, stage, expected, received, blockers,
      pendingAgencies: [...pendingNames], missingDeclarations, approved: Boolean(report) && !cancelled,
      invoice: cancelled ? undefined : invoice,
    };
  }).sort((left, right) => STAGES[left.stage].order - STAGES[right.stage].order
    || (Date.parse(right.arrival) || 0) - (Date.parse(left.arrival) || 0)
    || left.reference.localeCompare(right.reference));
}

export function voyageGuidance(voyage: ActivityVoyage, access: Access) {
  const readingsHref = voyagePath(voyage.callId, "readings");
  const reconciliationHref = voyagePath(voyage.callId, "reconciliation");
  const variationHref = voyagePath(voyage.callId, "variation-invoice");
  if (voyage.stage === "review") return { title: "Review the lower final quantity", detail: "NPA’s final quantity is below the owner’s declaration. Review the overpayment flag before this voyage proceeds.", next: "No credit note or refund is created automatically.", action: access.bill ? "Review overpayment" : "View invoice", href: variationHref };
  if (voyage.stage === "held") return { title: "Resolve the billing hold", detail: "The variation needs review because a previous charge exceeds the amount now calculated.", next: "Review the previous variation charges before preparing an invoice.", action: access.bill ? "Review billing hold" : "View invoice", href: variationHref };
  if (voyage.stage === "ready") return { title: "Reconcile the readings", detail: "The owner declaration and required agency readings are complete. Compare the figures and set NPA’s final quantities.", next: access.manage && access.approve ? "Then prepare any variation against the paid declaration." : "An authorised NPA reviewer will approve the final quantities.", action: access.manage && access.approve ? "Reconcile readings" : "View reconciliation", href: reconciliationHref };
  if (voyage.stage === "approved") return { title: "Prepare the voyage invoice", detail: "The reconciliation report is approved in this preview. Confirm the paid declaration and enter the rate for any additional load.", next: access.bill ? "Only the additional quantity will be included." : "An authorised billing user will prepare the invoice preview.", action: access.bill ? "Prepare invoice" : "View invoice", href: variationHref };
  if (voyage.stage === "collecting") return {
    title: "Collect the remaining agency readings",
    detail: voyage.pendingAgencies.length ? `Readings are still needed from ${readableNames(voyage.pendingAgencies)}.` : voyage.blockers[0] ?? "Complete the readings before reconciliation.",
    next: access.manage ? "Enter a reading or get a link for the agency. Then continue to NPA review." : "An authorised user can collect the remaining readings.",
    action: access.manage && voyage.plans.length === 1 ? "Collect agency readings" : "View readings",
    href: access.manage && voyage.plans.length === 1 ? `/app/measurements/${encodeURIComponent(voyage.plans[0].id)}` : readingsHref,
  };
  if (voyage.stage === "declaration") return voyage.plans.length ? {
    title: "Review the owner declaration", detail: voyage.missingDeclarations.length ? `The owner’s declared quantity is missing or invalid for ${readableNames(voyage.missingDeclarations)}.` : "The owner declaration needs review before reconciliation.",
    next: "Check the declaration first; agency readings are kept separately.", action: "Review owner declaration", href: readingsHref,
  } : {
    title: "Start the owner declaration", detail: "This voyage has no owner declaration yet. Record the declared load, then choose the agencies that will measure it.",
    next: "Each agency will enter its own reading before NPA reconciles the figures.", action: access.manage ? "Start declaration" : "View readings", href: access.manage ? `/app/measurements/new?callId=${encodeURIComponent(voyage.callId)}` : readingsHref,
  };
  return { title: "Prepared preview", detail: "This voyage’s preview is ready to review.", next: "No invoice has been issued.", action: "View preview", href: variationHref };
}

function activityEntries(plans: MeasurementPlan[], records: CloseoutRecord[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const plan of plans) {
    for (const submission of plan.submissions) {
      const agency = plan.participants.find(party => party.id === submission.participantId)?.name ?? "Agency";
      entries.push({ id: `submission:${plan.id}:${submission.id}`, callId: plan.callId, at: submission.recordedAt,
        actor: submission.recordedBy.name, title: `${agency} submitted a reading${submission.revision > 1 ? ` · revision ${submission.revision}` : ""}`,
        reference: submission.sourceReference || plan.callReference, href: voyagePath(plan.callId, "readings"), preview: false });
    }
    for (const report of plan.reconciliations) {
      if (report.status !== "final" || !report.finalizedAt) continue;
      entries.push({ id: `final:${plan.id}:${report.id}`, callId: plan.callId, at: report.finalizedAt,
        actor: report.finalizedBy?.name ?? "Recorded NPA reviewer", title: `Reconciliation finalized · revision ${report.revision}`,
        reference: plan.callReference, href: voyagePath(plan.callId, "reconciliation"), preview: false });
    }
  }
  const titles = { "report-approved": "Reconciliation report approved", "invoice-drafted": "Variation invoice drafted", "no-charge-recorded": "No additional charge recorded", "overpayment-flagged": "Overpayment flagged for review", "billing-held": "Variation held for review" };
  for (const record of records) for (const event of record.events) entries.push({
    id: `preview:${event.id}`, callId: event.callId, at: event.at, actor: event.actor.name,
    title: titles[event.action], reference: event.reference,
    href: voyagePath(event.callId, event.action === "report-approved" ? "reconciliation" : "variation-invoice"), preview: true,
  });
  return entries.sort((left, right) => (Date.parse(right.at) || 0) - (Date.parse(left.at) || 0) || left.id.localeCompare(right.id));
}

function VoyageRow({ voyage, access, prepared = false }: { voyage: ActivityVoyage; access: Access; prepared?: boolean }) {
  const guidance = voyageGuidance(voyage, access);
  return <li className="activity-voyage-row" aria-label={`${voyage.vesselName} · ${voyage.reference}`}>
    <div className="activity-voyage-identity"><strong>{voyage.vesselName}</strong><span>{voyage.reference}</span></div>
    <div className="activity-voyage-state"><span className={`activity-stage ${voyage.stage}`}>{STAGES[voyage.stage].label}</span><small>{prepared && voyage.invoice ? `${voyage.invoice.number}${voyage.stage === "draft" ? ` · ${moneyLabel(voyage.invoice.currency, voyage.invoice.total)}` : ""}` : voyage.expected ? `${voyage.received} of ${voyage.expected} agency readings received` : "Owner declaration not started"}</small></div>
    <Link className="activity-row-action" to={guidance.href}>{prepared ? "View preview" : guidance.action}<Icon name="chevronRight" size={14} /></Link>
  </li>;
}

function EventList({ entries, voyages }: { entries: ActivityEntry[]; voyages: Map<string, ActivityVoyage> }) {
  return <ol className="activity-history-list">{entries.map(event => {
    const voyage = voyages.get(event.callId);
    return <li key={event.id}><div><Link to={event.href}>{event.title}</Link><small>{event.preview && <span className="activity-preview-tag">Preview</span>}{voyage?.vesselName} · {voyage?.reference} · {event.actor} · {event.reference}</small></div><time dateTime={event.at}>{dateLabel(event.at)}</time></li>;
  })}</ol>;
}

export function ActivityDashboard() {
  const { org, can } = useAuth();
  const store = useStore();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const recordsQuery = useQuery({ queryKey: ["measurement-plans", org?.id, undefined], queryFn: () => measurementApi.list(), refetchInterval: 30_000 });
  const previews = useCloseoutPreviews(org?.id);
  const plans = recordsQuery.data?.plans ?? EMPTY_PLANS;
  const voyages = useMemo(() => activityVoyages(store.calls ?? [], plans, previews.records), [store.calls, plans, previews.records]);
  const access: Access = { manage: can("measurements.manage"), approve: can("measurements.approve"), bill: can("measurements.bill") };
  const query = search.trim().toLocaleLowerCase();
  const visible = voyages.filter(voyage => (status === "all" || (status === "variation" ? ["approved", "review", "held"].includes(voyage.stage) : status === "prepared" ? preparedStage(voyage.stage) : voyage.stage === status))
    && (!query || [voyage.vesselName, voyage.reference, ...voyage.plans.flatMap(plan => [plan.title, ...plan.participants.map(party => party.name)])].join(" ").toLocaleLowerCase().includes(query)));
  const attention = visible.filter(voyage => needsAttention(voyage.stage));
  const recommendation = attention[0];
  const guidance = recommendation ? voyageGuidance(recommendation, access) : null;
  const prepared = visible.filter(voyage => preparedStage(voyage.stage));
  const collectingCount = visible.filter(voyage => voyage.stage === "collecting").length;
  const counts = [
    { label: "Declaration", count: visible.filter(voyage => voyage.stage === "declaration").length, detail: "to record or review", icon: "ship" },
    { label: "Agency readings", count: collectingCount, detail: `${collectingCount === 1 ? "voyage" : "voyages"} awaiting readings`, icon: "ruler" },
    { label: "NPA review", count: visible.filter(voyage => voyage.stage === "ready").length, detail: "ready to reconcile", icon: "clipboard" },
    { label: "Invoice", count: visible.filter(voyage => ["approved", "review", "held"].includes(voyage.stage)).length, detail: "to prepare or review", icon: "invoice" },
  ];
  const totals = new Map<string, bigint>();
  for (const voyage of prepared.filter(item => item.invoice?.status === "draft")) {
    const invoice = voyage.invoice!; const cents = amountCents(invoice.total);
    if (cents !== null) totals.set(invoice.currency, (totals.get(invoice.currency) ?? 0n) + cents);
  }
  const visibleIds = new Set(visible.map(voyage => voyage.callId));
  const events = activityEntries(plans, previews.records).filter(event => visibleIds.has(event.callId)).slice(0, 12);
  const voyageById = new Map(voyages.map(voyage => [voyage.callId, voyage]));
  const filtered = search.trim() !== "" || status !== "all";

  return <div className="content-inner measurement-workspace activity-dashboard">
    <div className="page-head"><div><div className="activity-dashboard-title"><h1>Dashboard</h1><span className="activity-preview-chip">UI preview</span></div><p className="desc">Continue the next step for each voyage.</p></div>{access.manage && <Link className="btn btn-secondary" to="/app/measurements/new"><Icon name="plus" size={16} /> Measure voyage</Link>}</div>
    <ErrorMessage error={recordsQuery.error} /><ErrorMessage error={previews.error ? new Error(previews.error) : null} />
    {recordsQuery.isPending ? <div className="measurement-loading" role="status">Loading voyage activity…</div> : !recordsQuery.error && <>
      <section className={`activity-next-action ${recommendation?.stage === "review" || recommendation?.stage === "held" ? "needs-review" : ""}`} aria-labelledby="next-action-heading">
        <div><span className="activity-eyebrow">{recommendation ? "Next action" : voyages.length === 0 ? "Get started" : "You’re up to date"}</span><h2 id="next-action-heading">{guidance?.title ?? (filtered && !visible.length ? "No voyages match this view" : voyages.length === 0 ? "Start with the owner’s declaration" : "Nothing needs attention in this view")}</h2>
          {recommendation && <p className="activity-next-voyage"><strong>{recommendation.vesselName}</strong><span>{recommendation.reference}</span></p>}
          <p className="activity-next-detail">{guidance?.detail ?? (filtered && !visible.length ? "Change the search or stage to see your voyages." : voyages.length === 0 ? "Set up a voyage, record the declared load and choose the agencies that will report their readings." : prepared.length ? `${prepared.length} ${prepared.length === 1 ? "preview is" : "previews are"} prepared for review below.` : "Open Voyages to review the readings already recorded.")}</p>
          {guidance && <p className="activity-next-after">{guidance.next}</p>}
        </div>
        <div className="activity-next-cta">{guidance ? <Link className="btn btn-primary" to={guidance.href}>{guidance.action}<Icon name="arrowRight" size={16} /></Link> : filtered ? <button type="button" className="btn btn-secondary" onClick={() => { setSearch(""); setStatus("all"); }}>Clear filters</button> : voyages.length === 0 && access.manage ? <Link className="btn btn-primary" to="/app/measurements/new">Measure voyage <Icon name="arrowRight" size={16} /></Link> : <Link className="btn btn-secondary" to={prepared.length ? "/app/variation-invoices" : "/app/measurements"}>{prepared.length ? "View prepared previews" : "View voyages"}<Icon name="chevronRight" size={15} /></Link>}</div>
      </section>
      <ol className="activity-workflow-strip" aria-label="Voyages at each step">{counts.map((item, index) => <li key={item.label} aria-label={item.label}><span className="activity-workflow-number">{index + 1}</span><div><span>{item.label}</span><p><strong>{item.count}</strong> {item.detail}</p></div></li>)}</ol>
      <section className="activity-attention" aria-labelledby="attention-heading">
        <div className="activity-section-head"><h2 id="attention-heading">Voyages needing attention <span>{attention.length}</span></h2><Link className="link-btn" to="/app/measurements">All voyages <Icon name="chevronRight" size={13} /></Link></div>
        <div className="activity-toolbar"><label className="activity-search"><Icon name="search" size={16} /><input aria-label="Search voyages or agencies" type="search" placeholder="Search vessel, voyage or agency" value={search} onChange={event => setSearch(event.target.value)} /></label><select aria-label="Filter by step" value={status} onChange={event => setStatus(event.target.value)}><option value="all">All steps</option><option value="declaration">Declaration</option><option value="collecting">Agency readings</option><option value="ready">NPA review</option><option value="variation">Invoice</option><option value="prepared">Prepared previews</option><option value="cancelled">Cancelled</option></select><span className="activity-view-count" role="status">{visible.length} {visible.length === 1 ? "voyage" : "voyages"}</span></div>
        {attention.length ? <ul className="activity-voyage-list">{attention.map(voyage => <VoyageRow key={voyage.callId} voyage={voyage} access={access} />)}</ul> : <p className="activity-no-work">{filtered && !visible.length ? "No matching voyages. Clear the filters to see all work." : "No pending steps in this view."}</p>}
      </section>
      {prepared.length > 0 && <details className="activity-prepared"><summary><span>Prepared previews <strong>{prepared.length}</strong></span><small>Invoice drafts and no-charge outcomes</small></summary><ul className="activity-voyage-list">{prepared.map(voyage => <VoyageRow key={voyage.callId} voyage={voyage} access={access} prepared />)}</ul>{totals.size > 0 && <p className="activity-draft-totals">Draft amounts: {[...totals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, cents], index) => <span key={currency}>{index > 0 && " · "}<strong>{moneyLabel(currency, cents)}</strong></span>)}<small>Preview amounts; no invoices issued.</small></p>}</details>}
      <section className="activity-recent" aria-labelledby="recent-activity-heading"><div className="activity-section-head"><h2 id="recent-activity-heading">Recent activity</h2><span className="activity-secondary-label">Latest recorded actions</span></div>{events.length ? <><EventList entries={events.slice(0, 3)} voyages={voyageById} />{events.length > 3 && <details className="activity-more-history"><summary>Show {events.length - 3} more recorded {events.length === 4 ? "action" : "actions"}</summary><EventList entries={events.slice(3)} voyages={voyageById} /></details>}</> : <p className="activity-no-work">Agency submissions and report activity will appear here.</p>}</section>
      <p className="activity-dashboard-footnote">Approvals and invoice drafts are saved in this browser for UI review. Changed readings require a fresh reconciliation. No invoice, credit note or payment is issued.</p>
    </>}
  </div>;
}
