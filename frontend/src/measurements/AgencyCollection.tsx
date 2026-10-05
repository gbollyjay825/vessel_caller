import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Link } from "../lib/navigation";
import { cargoInputLabel, dateLabel, latestReconciliation, latestReturns } from "./helpers";
import { readingQuantity } from "./comparison";
import { UNIT_LABELS } from "./cargoTemplates";
import { ErrorMessage, Section } from "./shared";
import { ReturnForm } from "./WorkflowForms";
import type { MeasurementPlan, SubmissionInput } from "./types";
import "../styles/agency-collection.css";

export interface AgencyLinkInfo {
  id: string;
  participantId: string;
  expiresAt: string;
  revokedAt: string | null;
  submittedAt: string | null;
}
export interface CreatedAgencyLink { link: AgencyLinkInfo; url: string }

export function AgencyCollection({ plan, canManage, links = [], onSubmit, onCreateLink, onRevokeLink, onDownloadSubmission }: {
  plan: MeasurementPlan;
  canManage: boolean;
  links?: AgencyLinkInfo[];
  onSubmit: (input: SubmissionInput, version: number) => Promise<unknown>;
  onCreateLink?: (participantId: string, days: number) => Promise<CreatedAgencyLink>;
  onRevokeLink?: (id: string) => Promise<unknown>;
  onDownloadSubmission?: (id: string) => Promise<unknown>;
}) {
  const [reporting, setReporting] = useState<{ participantId: string; version: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  const returns = latestReturns(plan);
  const final = latestReconciliation(plan, "final");
  const draft = latestReconciliation(plan, "draft");
  const closed = plan.status === "cancelled" || Boolean(final && !draft);
  const editable = canManage && !closed;
  return <div className="content-inner measurement-workspace agency-collection">
    <Link className="measurement-back" to="/app/measurements"><Icon name="chevronLeft" size={16} /> Voyage log</Link>
    <div className="page-head"><div><h1>Report vessel load</h1><p className="desc">{plan.vesselName} · {plan.callReference}</p></div><span className="collection-count">{returns.size} of {plan.participants.length} agencies submitted</span></div>
    <ol className="collection-steps" aria-label="Voyage input steps">{["Setup vessel", "Owner declaration", "Agencies", "Report vessel load"].map((label, index) => <li key={label} aria-current={index === 3 ? "step" : undefined}><span>{index < 3 ? <Icon name="check" size={14} /> : 4}</span>{label}</li>)}</ol>
    <details className="card collection-baseline"><summary><Icon name="ship" size={18} /><span><strong>{plan.vesselName} · {plan.callReference}</strong><small>Owner declaration · {plan.lines.length} cargo {plan.lines.length === 1 ? "item" : "items"}</small></span><span>View declaration</span></summary><dl><div><dt>Voyage</dt><dd>{plan.callReference}</dd></div><div><dt>Terminal / berth</dt><dd>{plan.location || "Not recorded"}</dd></div></dl><div className="measurement-table-wrap"><table className="measurement-table"><caption className="hide-sr">Owner declaration for this voyage</caption><thead><tr><th>Cargo item</th><th>Owner declared</th><th>Reference</th></tr></thead><tbody>{plan.lines.map(line => <tr key={line.id}><th>{cargoInputLabel(line, plan.lines)}</th><td>{readingQuantity(line.manifestQuantity)} <small>{UNIT_LABELS[line.unit]}</small></td><td>{line.baselineReference || "Not provided"}</td></tr>)}</tbody></table></div></details>
    {closed && <div className="measurement-notice" role="status">{plan.status === "cancelled" ? "This voyage sheet is cancelled. Readings cannot be entered." : "This voyage sheet has a final result. Its submitted readings are preserved."}</div>}
    {reporting && editable && <Section title="Enter agency reading" action={<button type="button" className="icon-btn" aria-label="Close agency reading" onClick={() => setReporting(null)}><Icon name="x" size={18} /></button>}>
      {reporting.version !== plan.version && <div className="measurement-notice warning" role="alert">This voyage sheet changed. Close the form and reopen it to use the latest version.</div>}
      <ReturnForm key={reporting.participantId} plan={plan} initialParticipantId={reporting.participantId} collectionOnly onCancel={() => setReporting(null)} onSave={async input => { if (!editable) throw new Error("This voyage sheet is no longer available for reporting."); await onSubmit(input, reporting.version); setReporting(null); }} />
    </Section>}
    <Section title="Agency readings" description="Each agency reports its own measurement. Completed readings stay separate.">
      <div className="collection-agency-grid">{plan.participants.map(party => {
        const submission = returns.get(party.id);
        return <AgencyCard key={party.id} name={party.name} role={party.role} representative={party.representative} submittedAt={submission?.recordedAt} canManage={editable} now={now} links={links.filter(link => link.participantId === party.id)} onRecord={() => setReporting({ participantId: party.id, version: plan.version })} onCreateLink={onCreateLink ? days => onCreateLink(party.id, days) : undefined} onRevokeLink={onRevokeLink} onDownload={submission && onDownloadSubmission ? () => onDownloadSubmission(submission.id) : undefined}>
          {submission && <div className="collection-reading-table"><table className="measurement-table"><caption className="hide-sr">Submitted readings for {party.name}</caption><thead><tr><th>Cargo item</th><th>Measured quantity</th></tr></thead><tbody>{plan.lines.map(line => {
            const reading = submission.lines.find(entry => entry.lineId === line.id);
            return <tr key={line.id}><th>{cargoInputLabel(line, plan.lines)}</th><td>{reading?.status === "not-applicable" ? "N/A" : readingQuantity(reading?.quantity)}<small>{UNIT_LABELS[line.unit]}</small></td></tr>;
          })}</tbody></table></div>}
        </AgencyCard>;
      })}</div>
    </Section>
    {plan.reconciliations.length > 0 && <p className="measurement-help"><Link to={`/app/measurements/${plan.id}?workspace=reconciliation`}>View previous reconciliation records</Link></p>}
  </div>;
}

function AgencyCard({ name, role, representative, submittedAt, canManage, now, links, onRecord, onCreateLink, onRevokeLink, onDownload, children }: {
  name: string; role: string; representative: string; submittedAt?: string; canManage: boolean;
  now: number; links: AgencyLinkInfo[]; onRecord: () => void; onCreateLink?: (days: number) => Promise<CreatedAgencyLink>;
  onRevokeLink?: (id: string) => Promise<unknown>; onDownload?: () => Promise<unknown>; children: React.ReactNode;
}) {
  const [days, setDays] = useState(7);
  const [created, setCreated] = useState<CreatedAgencyLink | null>(null);
  const [revoked, setRevoked] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const activeLinks = [...links, ...(created && !links.some(link => link.id === created.link.id) ? [created.link] : [])].filter(link => !link.revokedAt && !revoked.includes(link.id) && !link.submittedAt && new Date(link.expiresAt).getTime() > now);
  const run = async (action: () => Promise<unknown>) => { setPending(true); setError(null); try { await action(); } catch (failure) { setError(failure); } finally { setPending(false); } };
  return <article className="collection-agency-card" aria-label={`Agency ${name}`}>
    <div className="collection-agency-head"><div><h3>{name}</h3><p>{role}{representative ? ` · ${representative}` : ""}</p></div><span className={`collection-agency-status ${submittedAt ? "submitted" : "awaiting"}`}>{submittedAt ? "Submitted" : "Awaiting reading"}</span></div>
    {submittedAt ? <><p className="measurement-help">Submitted {dateLabel(submittedAt)}</p>{children}{onDownload && <button className="btn btn-secondary" type="button" disabled={pending} onClick={() => void run(onDownload)}><Icon name="download" size={16} /> Download agency PDF</button>}</> : <p className="collection-no-reading">No reading submitted yet.</p>}
    {canManage && <div className="collection-agency-actions"><button type="button" className="btn btn-secondary" disabled={pending} onClick={onRecord}>{submittedAt ? "Revise reading" : "Enter reading"}</button>{!submittedAt && onCreateLink && <details className="collection-link-controls"><summary>Send agency a link</summary><p>The agency can submit without signing in. After submitting, it gets its own PDF and can view completed readings for this voyage.</p><label className="measurement-field"><span>Link valid for</span><select value={days} disabled={pending} onChange={event => setDays(Number(event.target.value))}><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option></select></label><button type="button" className="btn btn-primary" disabled={pending} onClick={() => void run(async () => { setCreated(await onCreateLink(days)); setCopied(false); })}>{pending ? "Preparing…" : activeLinks.length ? "Replace secure link" : "Generate secure link"}</button></details>}</div>}
    {canManage && created && !submittedAt && activeLinks.some(link => link.id === created.link.id) && <div className="collection-share-link"><label className="measurement-field"><span>Link for {name}</span><input readOnly value={created.url} onFocus={event => event.currentTarget.select()} /></label><p>Expires {dateLabel(created.link.expiresAt)}. Share this link only with the agency’s representative.</p><button className="btn btn-secondary" type="button" disabled={pending} onClick={() => void run(async () => { await navigator.clipboard.writeText(created.url); setCopied(true); })}>{copied ? "Copied" : "Copy link"}</button></div>}
    {canManage && onRevokeLink && activeLinks.map(link => <div className="collection-link-status" key={link.id}><small>Link active until {dateLabel(link.expiresAt)}</small><button type="button" className="link-btn" disabled={pending} onClick={() => void run(async () => { await onRevokeLink(link.id); setRevoked(current => [...current, link.id]); if (created?.link.id === link.id) setCreated(null); })}>Revoke link</button></div>)}
    <ErrorMessage error={error} />
  </article>;
}
