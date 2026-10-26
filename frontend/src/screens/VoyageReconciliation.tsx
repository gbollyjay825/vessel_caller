import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "../app/store";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { Link, useParams } from "../lib/navigation";
import { measurementApi } from "../measurements/api";
import { UNIT_LABELS } from "../measurements/cargoTemplates";
import { quantityDifference, readingQuantity, tallyResult } from "../measurements/comparison";
import { currentReport, reconciliationIssues, useCloseoutPreview, voyageInputFingerprint, type PreviewReport } from "../measurements/closeoutPreview";
import { cargoInputLabel, dateLabel, latestReconciliation, latestReturns } from "../measurements/helpers";
import { ErrorMessage } from "../measurements/shared";
import { VoyageWorkflowNav } from "../measurements/VoyageWorkflowNav";
import type { Actor, CargoLine, MeasurementPlan, Participant, Submission } from "../measurements/types";
import "../styles/measurements.css";
import "../styles/voyage-reconciliation.css";

type FinalEntry = { planId: string; lineId: string; quantity: string; reason: string };
type Draft = { fingerprint: string; reason: string; lines: FinalEntry[] };
type AgencyColumn = { key: string; name: string; role: string };
const lineKey = (planId: string, lineId: string) => JSON.stringify([planId, lineId]);
const agencyKey = (party: Participant) => JSON.stringify([party.name, party.role].map(value => value.trim().replace(/\s+/g, " ").normalize("NFKC").toLowerCase()));
const activeSheets = (plans: MeasurementPlan[]) => plans.filter(plan => plan.status !== "cancelled");
const displayQuantity = (value: string | null | undefined) => readingQuantity(value) === "Not provided" ? "Unknown" : readingQuantity(value);

function initialDraft(plans: MeasurementPlan[], report?: PreviewReport): Draft {
  return {
    fingerprint: voyageInputFingerprint(plans),
    reason: "",
    lines: activeSheets(plans).flatMap(plan => plan.lines.map(line => {
      const previous = report?.lines.find(entry => entry.planId === plan.id && entry.lineId === line.id);
      const final = latestReconciliation(plan, "final")?.lines.find(entry => entry.lineId === line.id);
      return { planId: plan.id, lineId: line.id, quantity: previous?.quantity ?? final?.quantity ?? "", reason: previous?.reason ?? final?.reason ?? "" };
    })),
  };
}

export function validFinalQuantity(value: string, unit: CargoLine["unit"]): boolean {
  const text = value.trim();
  return /^\d{1,15}(?:\.\d{1,3})?$/.test(text)
    && (unit !== "count" || !text.includes(".") || /\.0{1,3}$/.test(text));
}

function needsLineReason(plan: MeasurementPlan, line: CargoLine, quantity: string): boolean {
  if (quantityDifference(quantity, line.manifestQuantity) !== "0") return true;
  return [...latestReturns(plan).values()].some(submission => {
    const reading = submission.lines.find(item => item.lineId === line.id);
    return reading?.status === "reported" && quantityDifference(quantity, reading.quantity) !== "0";
  });
}

function draftIssues(plans: MeasurementPlan[], draft: Draft): string[] {
  const issues: string[] = [];
  for (const plan of activeSheets(plans)) for (const line of plan.lines) {
    const entry = draft.lines.find(item => item.planId === plan.id && item.lineId === line.id);
    if (!entry || !validFinalQuantity(entry.quantity, line.unit)) issues.push(`Enter a valid NPA final quantity for ${cargoInputLabel(line, plan.lines)}.`);
    else if (!entry.reason.trim()) issues.push(`Explain the final quantity for ${cargoInputLabel(line, plan.lines)}.`);
  }
  if (!draft.reason.trim()) issues.push("Add a review note before approving the report.");
  return issues;
}

function agencyColumns(plans: MeasurementPlan[]): AgencyColumn[] {
  const columns = new Map<string, AgencyColumn>();
  for (const plan of plans) for (const party of plan.participants) {
    const key = agencyKey(party);
    if (!columns.has(key)) columns.set(key, { key, name: party.name, role: party.role });
  }
  return [...columns.values()];
}

function AgencyCell({ line, party, submission, onUse }: { line: CargoLine; party: Participant; submission?: Submission; onUse?: (quantity: string) => void }) {
  if (!submission) return <span className="reconciliation-missing">{party.requiredSubmission ? "Awaiting" : "Not submitted"}</span>;
  const reading = submission.lines.find(entry => entry.lineId === line.id);
  if (!reading) return <span className="reconciliation-missing">Not reported</span>;
  if (reading.status === "not-applicable") return <><strong>N/A</strong><small>{reading.note || "Reason missing"}</small></>;
  const valid = reading.quantity != null && readingQuantity(reading.quantity) !== "Not provided";
  return <>
    {onUse && valid ? <button type="button" className="reconciliation-use-reading" aria-label={`Use ${party.name} reading for ${line.description}`} onClick={() => onUse(reading.quantity!)}>{displayQuantity(reading.quantity)}</button> : <strong>{displayQuantity(reading.quantity)}</strong>}
    <small>Reading v{submission.revision}</small>{reading.note && <small>{reading.note}</small>}
  </>;
}

function ComparisonTable({ plans, lines, editable, onChange }: { plans: MeasurementPlan[]; lines: FinalEntry[]; editable?: boolean; onChange?: (planId: string, lineId: string, patch: Partial<FinalEntry>) => void }) {
  const columns = agencyColumns(plans);
  const finals = new Map(lines.map(line => [lineKey(line.planId, line.lineId), line]));
  return <div className="reconciliation-table-scroll" role="region" aria-label="Reconciliation comparison table" tabIndex={0}>
    <table className="reconciliation-table">
      <caption>Owner declaration, independent agency readings and NPA final quantities</caption>
      <thead><tr><th scope="col" className="reconciliation-cargo">Cargo item / unit</th><th scope="col" className="reconciliation-owner">Owner declaration</th>{columns.map(column => <th key={column.key} scope="col">{column.name}<small>{column.role}</small></th>)}<th scope="col" className="reconciliation-final">NPA final</th><th scope="col">Variation</th></tr></thead>
      {plans.map(plan => {
        const returns = latestReturns(plan);
        return <tbody key={plan.id}>
          <tr className="reconciliation-sheet"><th scope="rowgroup" colSpan={columns.length + 4}>{plan.title}{plan.scope && <small>{plan.scope}</small>}</th></tr>
          {plan.lines.map(line => {
            const entry = finals.get(lineKey(plan.id, line.id));
            const label = cargoInputLabel(line, plan.lines);
            const outcome = tallyResult(entry?.quantity, line.manifestQuantity);
            const hasDifference = entry && validFinalQuantity(entry.quantity, line.unit) && needsLineReason(plan, line, entry.quantity);
            return <tr key={line.id}>
              <th scope="row" className="reconciliation-cargo"><strong>{label}</strong><small>{UNIT_LABELS[line.unit]} · {line.basis}</small></th>
              <td className="reconciliation-owner"><strong>{displayQuantity(line.manifestQuantity)}</strong>{line.baselineReference && <small>{line.baselineReference}</small>}</td>
              {columns.map(column => {
                const parties = plan.participants.filter(party => agencyKey(party) === column.key);
                return <td key={column.key}>{parties.length ? parties.map(party => <div className="reconciliation-agency-value" key={party.id}>{parties.length > 1 && <small>{party.representative}</small>}<AgencyCell line={line} party={party} submission={returns.get(party.id)} onUse={editable ? quantity => onChange?.(plan.id, line.id, { quantity }) : undefined} /></div>) : <span className="reconciliation-missing">—<small>Not participating</small></span>}</td>;
              })}
              <td className="reconciliation-final">{editable ? <>
                <label className="reconciliation-quantity-field"><span className="hide-sr">NPA final quantity · {label} · {plan.title}</span><input type="number" required min="0" step={line.unit === "count" ? "1" : "0.001"} value={entry?.quantity ?? ""} onChange={event => onChange?.(plan.id, line.id, { quantity: event.target.value })} placeholder="Enter final quantity" /><small>{readingQuantity(entry?.quantity) === "NIL (0)" ? "NIL (0)" : UNIT_LABELS[line.unit]}</small></label>
                <label className="reconciliation-reason-field"><span>{hasDifference ? "Reason for difference" : "Final quantity reason"}</span><textarea required rows={2} value={entry?.reason ?? ""} onChange={event => onChange?.(plan.id, line.id, { reason: event.target.value })} aria-label={`Final quantity reason · ${label} · ${plan.title}`} placeholder={hasDifference ? "Explain NPA’s decision" : "How was this quantity confirmed?"} /></label>
              </> : <><strong>{displayQuantity(entry?.quantity)}</strong><small>{UNIT_LABELS[line.unit]}</small>{entry?.reason && <small>{entry.reason}</small>}</>}</td>
              <td><span className={`reconciliation-outcome ${outcome.status}`}>{outcome.difference ?? "—"}</span><small>{outcome.status === "unknown" ? "Final quantity needed" : outcome.label}{outcome.difference != null && ` · ${UNIT_LABELS[line.unit]}`}</small>{outcome.status === "below" && <small className="reconciliation-review-note">Overpayment review</small>}</td>
            </tr>;
          })}
        </tbody>;
      })}
    </table>
  </div>;
}

function ReportSnapshot({ report }: { report: PreviewReport }) {
  const source = report.sourcePlans[0];
  return <div className="reconciliation-report-snapshot">
    <div className="reconciliation-print-header"><img src="/branding/npa-logo.png" width={304} height={136} alt="Nigerian Ports Authority" /><div><h1>Voyage reconciliation report</h1><p>UI preview · {source?.vesselName} · {source?.callReference}</p></div></div>
    <div className="reconciliation-approval-meta"><span className="reconciliation-status">Approved preview · v{report.revision}</span><p>{report.approvedBy.name} · {dateLabel(report.approvedAt)}</p></div>
    <ComparisonTable plans={activeSheets(report.sourcePlans)} lines={report.lines} />
    <div className="reconciliation-review-summary"><h3>Review note</h3><p>{report.reason}</p></div>
    <p className="reconciliation-print-note">UI preview · Saved in this browser. This is not an issued NPA reconciliation record.</p>
  </div>;
}

function ReconciliationWorkspace({ plans, callId, orgId, actor, canEdit, canApprove }: { plans: MeasurementPlan[]; callId: string; orgId?: string; actor?: Actor; canEdit: boolean; canApprove: boolean }) {
  const { record, error, approveReport } = useCloseoutPreview(orgId, callId);
  const approved = currentReport(plans, record);
  const [draft, setDraft] = useState(() => initialDraft(plans, approved));
  const [editing, setEditing] = useState(!approved);
  const [notice, setNotice] = useState<string | null>(null);
  const sheets = activeSheets(plans);
  const cancelledCount = plans.length - sheets.length;
  const fingerprint = voyageInputFingerprint(plans);
  const staleDraft = draft.fingerprint !== fingerprint;
  const readiness = reconciliationIssues(plans);
  const validation = draftIssues(plans, draft);
  const latestSaved = record.reports.at(-1);
  const priorReports = [...record.reports].reverse().filter(report => report.id !== approved?.id);
  const required = sheets.reduce((count, plan) => count + plan.participants.filter(party => party.requiredSubmission).length, 0);
  const received = sheets.reduce((count, plan) => count + plan.participants.filter(party => party.requiredSubmission && latestReturns(plan).has(party.id)).length, 0);
  const updateLine = (planId: string, lineId: string, patch: Partial<FinalEntry>) => setDraft(current => ({ ...current, lines: current.lines.map(line => line.planId === planId && line.lineId === lineId ? { ...line, ...patch } : line) }));
  const refreshDraft = () => {
    setDraft(initialDraft(plans));
    setNotice("Latest declaration and agency readings loaded. Review each final quantity again.");
    setEditing(true);
  };
  const approve = (event: FormEvent) => {
    event.preventDefault();
    if (!canEdit || !canApprove || !actor || staleDraft || readiness.length || validation.length) return;
    const saved = approveReport(plans, { reason: draft.reason.trim(), lines: draft.lines.map(line => ({ ...line, quantity: line.quantity.trim(), reason: line.reason.trim() })) }, actor);
    if (saved) { setEditing(false); setNotice(`Reconciliation report v${saved.revision} approved in this browser preview.`); }
  };
  if (!sheets.length) return <div className="reconciliation-empty" role="status"><h2>No active cargo readings to reconcile</h2><p>{cancelledCount ? "Cancelled cargo sheets remain in Readings and are excluded from new reconciliation reports." : "Record the owner declaration and agency readings for this voyage first."}</p><Link className="btn btn-secondary" to={`/app/measurements/voyages/${encodeURIComponent(callId)}/readings`}>Back to readings</Link></div>;
  return <>
    <p className="reconciliation-preview-notice">UI preview · Report approvals are saved only in this browser.</p>
    <ErrorMessage error={error ? new Error(error) : null} />
    {notice && <div className="reconciliation-feedback" role="status">{notice}</div>}
    {!approved && latestSaved && <div className="reconciliation-stale-notice" role="status"><strong>Readings have changed since report v{latestSaved.revision}.</strong><p>Review the latest inputs and approve a new report. The previous report is retained in history.</p></div>}
    {approved && !editing ? <section className="reconciliation-card reconciliation-approved-section">
      <div className="reconciliation-section-heading"><div><h2>Approved reconciliation report</h2><p>Final quantities are kept separately from every agency’s submitted reading.</p></div><button type="button" className="btn btn-secondary reconciliation-no-print" onClick={() => window.print()}>Print / save PDF</button></div>
      <ReportSnapshot report={approved} />
      <div className="reconciliation-footer reconciliation-no-print">{canEdit && <button type="button" className="link-btn" onClick={() => { setDraft(initialDraft(plans, approved)); setEditing(true); setNotice(null); }}>Create revised report</button>}<Link className="btn btn-primary" to={`/app/measurements/voyages/${encodeURIComponent(callId)}/variation-invoice`}>Continue to invoice <Icon name="chevronRight" size={16} /></Link></div>
    </section> : <form onSubmit={approve} className="reconciliation-card reconciliation-editor">
      <div className="reconciliation-section-heading"><div><h2>Review and set NPA final quantities</h2><p>Compare each cargo item, choose its final quantity and explain any difference.</p></div><span className="reconciliation-progress">{received} / {required} required agency readings received</span></div>
      {cancelledCount > 0 && <p className="reconciliation-context-note">{cancelledCount} cancelled {cancelledCount === 1 ? "sheet is" : "sheets are"} excluded from this report.</p>}
      {staleDraft && <div className="reconciliation-stale-notice" role="alert"><strong>The report inputs have changed.</strong><p>Refresh the report before approving. Your earlier approved versions remain in history.</p><button type="button" className="btn btn-secondary" onClick={refreshDraft}>Refresh report inputs</button></div>}
      {readiness.length > 0 && <div className="reconciliation-readiness"><h3>Before approval</h3><ul>{readiness.map(issue => <li key={issue}>{issue}</li>)}</ul><Link className="link-btn" to={`/app/measurements/voyages/${encodeURIComponent(callId)}/readings`}>Review readings <Icon name="chevronRight" size={14} /></Link></div>}
      <ComparisonTable plans={sheets} lines={draft.lines} editable={canEdit && !staleDraft} onChange={updateLine} />
      {canEdit && <p className="reconciliation-context-note">Click an agency’s quantity to use that reading as NPA’s final quantity, or enter a quantity. Readings are never averaged or added together.</p>}
      <label className="reconciliation-review-field"><span>Review note</span><textarea required rows={3} disabled={!canEdit || staleDraft} value={draft.reason} onChange={event => setDraft(current => ({ ...current, reason: event.target.value }))} placeholder="Record how the final quantities were confirmed" /></label>
      <p className="reconciliation-context-note">A final quantity below the owner’s paid declaration is flagged for overpayment review. A credit note is not generated.</p>
      <div className="reconciliation-footer"><Link className="btn btn-secondary" to={`/app/measurements/voyages/${encodeURIComponent(callId)}/readings`}>Back to readings</Link><div>{!canApprove || !canEdit ? <p className="reconciliation-access-note">You can view this report. An authorised NPA reviewer must approve it.</p> : <><button type="submit" className="btn btn-primary" disabled={!actor || Boolean(error) || staleDraft || readiness.length > 0 || validation.length > 0}>Approve report preview <Icon name="check" size={16} /></button>{validation.length > 0 && <small className="reconciliation-access-note">Complete the final quantities, their reasons and review note to continue.</small>}</>}</div></div>
    </form>}
    {priorReports.length > 0 && <section className="reconciliation-card reconciliation-history reconciliation-no-print"><h2>Report history</h2><p>Earlier approved previews retain the declaration and agency readings used at that time.</p>{priorReports.map(report => <details key={report.id}><summary><strong>Report v{report.revision}</strong><span>{dateLabel(report.approvedAt)} · {report.approvedBy.name}</span></summary><ReportSnapshot report={report} /></details>)}</section>}
  </>;
}

export function VoyageReconciliation() {
  const { callId = "" } = useParams<{ callId: string }>();
  const { org, user, can } = useAuth();
  const store = useStore();
  const records = useQuery({ queryKey: ["measurement-plans", org?.id, callId], queryFn: () => measurementApi.list(callId), refetchInterval: 30_000 });
  const plans = records.data?.plans.filter(plan => plan.callId === callId) ?? [];
  const call = store.calls?.find(item => item.id === callId);
  const vesselName = call?.vesselName ?? plans[0]?.vesselName;
  const reference = call?.reference ?? plans[0]?.callReference;
  return <div className="content-inner measurement-workspace voyage-reconciliation-page">
    <Link className="measurement-back reconciliation-no-print" to="/app/measurements"><Icon name="chevronLeft" size={16} /> Voyages</Link>
    <div className="page-head"><div><h1>Reconciliation report</h1><p className="desc">{vesselName ? <><strong>{vesselName}</strong> · {reference}</> : "NPA review of the voyage’s declared and measured cargo"}</p></div></div>
    <div className="reconciliation-no-print"><VoyageWorkflowNav callId={callId} active="reconciliation" /></div>
    {call?.status === "cancelled" && <p role="status" className="reconciliation-stale-notice reconciliation-no-print">This voyage is cancelled. Its reports remain available for reference; new approvals are disabled.</p>}
    <ErrorMessage error={records.error} />
    {records.isPending ? <div className="measurement-loading" role="status">Loading reconciliation readings…</div> : !records.error && <ReconciliationWorkspace key={`${org?.id ?? ""}:${callId}`} callId={callId} orgId={org?.id} plans={plans} actor={user ? { id: user.id, name: user.name } : undefined} canEdit={call?.status !== "cancelled" && can("measurements.manage")} canApprove={call?.status !== "cancelled" && can("measurements.approve")} />}
  </div>;
}
