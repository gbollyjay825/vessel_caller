// Agency readings tracker: one row per agency with how it reports and where its
// secure link stands, plus a side panel to create, copy, email or revoke links.
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Link } from "../lib/navigation";
import { readingQuantity } from "./comparison";
import { UNIT_LABELS } from "./cargoTemplates";
import { cargoInputLabel, dateLabel, latestReconciliation, latestReturns } from "./helpers";
import { AgencyLinkPanel } from "./AgencyLinkPanel";
import { ErrorMessage, Section } from "./shared";
import { ReturnForm } from "./WorkflowForms";
import type { MeasurementPlan, Participant, Submission, SubmissionInput } from "./types";
import "../styles/agency-collection.css";

export interface AgencyLinkInfo {
  id: string;
  participantId: string;
  expiresAt: string;
  revokedAt: string | null;
  submittedAt: string | null;
}
export interface CreatedAgencyLink { link: AgencyLinkInfo; url: string }

type LinkState = { kind: "submitted" } | { kind: "active"; link: AgencyLinkInfo } | { kind: "expired"; link: AgencyLinkInfo } | { kind: "revoked" } | { kind: "none" };
const DAY = 86_400_000;

function linkState(submission: Submission | undefined, links: AgencyLinkInfo[], now: number): LinkState {
  if (submission) return { kind: "submitted" };
  const unused = links.filter(link => !link.submittedAt).sort((left, right) => right.expiresAt.localeCompare(left.expiresAt));
  const active = unused.find(link => !link.revokedAt && Date.parse(link.expiresAt) > now);
  if (active) return { kind: "active", link: active };
  const expired = unused.find(link => !link.revokedAt);
  if (expired) return { kind: "expired", link: expired };
  return unused.length ? { kind: "revoked" } : { kind: "none" };
}

function StatusChip({ state, now }: { state: LinkState; now: number }) {
  if (state.kind === "submitted") return <span className="stage-chip green"><Icon name="check" size={12} strokeWidth={3} />Submitted</span>;
  if (state.kind === "active") {
    const soon = Date.parse(state.link.expiresAt) - now < 2 * DAY;
    return <span className={`stage-chip ${soon ? "red" : ""}`}>Link sent · expires {new Date(state.link.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>;
  }
  if (state.kind === "expired") return <span className="stage-chip red">Link expired</span>;
  if (state.kind === "revoked") return <span className="stage-chip">Link revoked</span>;
  return <span className="stage-chip outline">Not invited</span>;
}

function mailtoFor(email: string, plan: MeasurementPlan, agency: Participant, created: CreatedAgencyLink) {
  const subject = `Reading request: ${plan.vesselName} · ${plan.callReference}`;
  const body = `Hello ${agency.representative || agency.name},\n\nPlease record ${agency.name}’s independent reading for ${plan.vesselName} (voyage ${plan.callReference}). No sign-in is needed:\n\n${created.url}\n\nThe link works for your agency only and expires on ${dateLabel(created.link.expiresAt)}. Photos or a PDF of your tally sheet can be shared with the NPA coordinator.\n\nThank you.`;
  return `mailto:${encodeURIComponent(email.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function LinkPanel({ plan, agency, state, created, onCreate, onRevoke, onClose }: {
  plan: MeasurementPlan; agency: Participant; state: LinkState; created?: CreatedAgencyLink;
  onCreate?: (days: number) => Promise<CreatedAgencyLink>; onRevoke?: (id: string) => Promise<unknown>; onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [days, setDays] = useState(7);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const busy = useRef(false);
  const run = async (action: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try { await action(); } catch (failure) { setError(failure); }
    finally { busy.current = false; setPending(false); }
  };
  const current = created && !created.link.revokedAt && state.kind === "active" && state.link.id === created.link.id ? created : undefined;
  return <aside className="voyage-card voyage-card-pad tracker-panel" aria-labelledby="tracker-panel-heading">
    <div className="tracker-panel-head"><div><h2 id="tracker-panel-heading">{current ? "Share the secure link" : state.kind === "active" ? "Link sent" : "Send a secure link"}</h2><p>{agency.name} · {agency.role}</p></div><button type="button" className="icon-btn" aria-label="Close link panel" onClick={onClose}><Icon name="x" size={18} /></button></div>
    {current ? <>
      <AgencyLinkPanel agencyName={agency.name} link={current} onReplace={onCreate ? () => onCreate(7) : undefined} onRevoke={onRevoke ? () => onRevoke(current.link.id) : undefined} />
      <div className="measurement-field"><label htmlFor={`agency-email-${agency.id}`}>Agency email</label><input id={`agency-email-${agency.id}`} aria-describedby={`agency-email-help-${agency.id}`} type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="name@agency.example" autoComplete="off" /><small id={`agency-email-help-${agency.id}`}>Opens your email app with the link and voyage details filled in.</small></div>
      <a className={`btn btn-primary${email.trim() ? "" : " disabled"}`} aria-disabled={!email.trim()} href={email.trim() ? mailtoFor(email, plan, agency, current) : undefined} onClick={event => { if (!email.trim()) event.preventDefault(); }}><Icon name="mail" size={16} /> Email the link</a>
    </> : state.kind === "active" ? <>
      <p className="tracker-help">A link is active until {dateLabel(state.link.expiresAt)}. For security its address is shown only when it is created — replace it to copy or email it again.</p>
      <div className="readings-actions">
        {onCreate && <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void run(() => onCreate(7))}>{pending ? "Preparing…" : "Replace link"}</button>}
        {onRevoke && <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => void run(() => onRevoke(state.link.id))}>Revoke link</button>}
      </div>
    </> : <>
      <p className="tracker-help">The agency opens the link on any phone or computer and records its own reading. No sign-in is needed, and it only sees other agencies’ figures after submitting.</p>
      <label className="measurement-field"><span>Link expires</span><select value={days} onChange={event => setDays(Number(event.target.value))}><option value={3}>In 3 days</option><option value={7}>In 7 days</option><option value={14}>In 14 days</option></select></label>
      {onCreate ? <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void run(() => onCreate(days))}><Icon name="send" size={16} />{pending ? "Preparing…" : "Create link"}</button> : <p className="tracker-help">Secure agency links are not enabled on this server yet.</p>}
    </>}
    <ErrorMessage error={error} />
  </aside>;
}

function SubmittedReading({ plan, submission }: { plan: MeasurementPlan; submission: Submission }) {
  return <div className="tracker-reading">
    <table className="measurement-table"><caption className="hide-sr">Submitted reading</caption><thead><tr><th>Cargo line</th><th>Reading</th><th>Note</th></tr></thead>
      <tbody>{plan.lines.map(line => {
        const reading = submission.lines.find(entry => entry.lineId === line.id);
        return <tr key={line.id}><th>{cargoInputLabel(line, plan.lines)}</th><td>{reading?.status === "not-applicable" ? "N/A" : readingQuantity(reading?.quantity)}<small>{UNIT_LABELS[line.unit]}</small></td><td>{reading?.note || "—"}</td></tr>;
      })}</tbody>
    </table>
    <p className="tracker-help">Source {submission.sourceReference || "not given"} · observed {dateLabel(submission.observedAt)} · {submission.recordedBy ? `entered by ${submission.recordedBy.name}` : "submitted via secure link"}{submission.evidenceIds.length ? ` · ${submission.evidenceIds.length} supporting ${submission.evidenceIds.length === 1 ? "file" : "files"}` : ""}</p>
  </div>;
}

export function AgencyCollection({ plan, canManage, links = [], onSubmit, onCreateLink, onRevokeLink, onDownloadSubmission, declarationHref }: {
  plan: MeasurementPlan;
  canManage: boolean;
  links?: AgencyLinkInfo[];
  onSubmit: (input: SubmissionInput, version: number) => Promise<unknown>;
  onCreateLink?: (participantId: string, days: number) => Promise<CreatedAgencyLink>;
  onRevokeLink?: (id: string) => Promise<unknown>;
  onDownloadSubmission?: (id: string) => Promise<unknown>;
  declarationHref?: string;
}) {
  const [reporting, setReporting] = useState<{ participantId: string; version: number } | null>(null);
  const [panel, setPanel] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [created, setCreated] = useState<Record<string, CreatedAgencyLink>>({});
  const [revoked, setRevoked] = useState<string[]>([]);
  const [rowError, setRowError] = useState<{ id: string; error: unknown } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  const returns = latestReturns(plan);
  const final = latestReconciliation(plan, "final");
  const draft = latestReconciliation(plan, "draft");
  const closed = plan.status === "cancelled" || Boolean(final && !draft);
  const editable = canManage && !closed;
  const received = plan.participants.filter(party => returns.has(party.id)).length;
  const knownLinks = (participantId: string) => [...links, ...Object.values(created).map(item => item.link).filter(link => !links.some(known => known.id === link.id))]
    .filter(link => link.participantId === participantId).map(link => revoked.includes(link.id) ? { ...link, revokedAt: link.revokedAt ?? new Date(now).toISOString() } : link);
  const create = async (participantId: string, days: number) => {
    if (!onCreateLink) throw new Error("Secure agency links are not available.");
    const next = await onCreateLink(participantId, days);
    // A replacement supersedes every earlier unused link for the agency.
    setRevoked(current => [...current, ...knownLinks(participantId).filter(link => link.id !== next.link.id && !link.submittedAt).map(link => link.id)]);
    setCreated(current => ({ ...current, [participantId]: next }));
    return next;
  };
  const revoke = async (participantId: string, id: string) => {
    await onRevokeLink?.(id);
    setRevoked(current => [...current, id]);
    // Keep the link so the row reads "Link revoked", but forget its address.
    setCreated(current => current[participantId]?.link.id === id ? { ...current, [participantId]: { ...current[participantId], url: "" } } : current);
  };
  const download = async (submissionId: string) => {
    setRowError(null);
    try { await onDownloadSubmission?.(submissionId); } catch (error) { setRowError({ id: submissionId, error }); }
  };
  const selected = panel ? plan.participants.find(party => party.id === panel) : undefined;

  return <div className="tracker-layout">
    <section className="voyage-card agency-tracker" aria-labelledby={`tracker-${plan.id}`}>
      <div className="voyage-card-head">
        <div className="tracker-title">
          <h2 id={`tracker-${plan.id}`}>Agency readings · {received} of {plan.participants.length} submitted</h2>
          <div className="voyage-progress" role="progressbar" aria-label="Agency readings submitted" aria-valuemin={0} aria-valuemax={plan.participants.length} aria-valuenow={received}><span style={{ width: `${plan.participants.length ? Math.round(received / plan.participants.length * 100) : 0}%` }} /></div>
        </div>
        {declarationHref && <Link className="link-btn" to={declarationHref}>View declaration</Link>}
      </div>
      {closed && <div className="measurement-notice tracker-notice" role="status">{plan.status === "cancelled" ? "This voyage sheet is cancelled. Readings cannot be entered." : "This voyage sheet has a final result. Its submitted readings are preserved."}</div>}
      {reporting && editable && <div className="tracker-entry"><Section title={`Enter reading · ${plan.participants.find(party => party.id === reporting.participantId)?.name ?? "agency"}`} action={<button type="button" className="icon-btn" aria-label="Close reading entry" onClick={() => setReporting(null)}><Icon name="x" size={18} /></button>}>
        {reporting.version !== plan.version && <div className="measurement-notice warning" role="alert">This voyage sheet changed. Close the form and reopen it to use the latest version.</div>}
        <ReturnForm key={reporting.participantId} plan={plan} initialParticipantId={reporting.participantId} collectionOnly fixedAgency onCancel={() => setReporting(null)} onSave={async input => { if (!editable) throw new Error("This voyage sheet is no longer available for reporting."); await onSubmit(input, reporting.version); setReporting(null); }} />
      </Section></div>}
      <div className="tracker-scroll" role="region" aria-label="Agencies on this voyage" tabIndex={0}>
        <table className="tracker-table">
          <caption className="hide-sr">Each agency, how it reports, its status and actions</caption>
          <thead><tr><th scope="col">Agency</th><th scope="col">How they report</th><th scope="col">Status</th><th scope="col">Last activity</th><th scope="col"><span className="hide-sr">Actions</span></th></tr></thead>
          <tbody>{plan.participants.map(party => {
            const submission = returns.get(party.id);
            const state = linkState(submission, knownLinks(party.id), now);
            const open = expanded === party.id;
            return [
              <tr key={party.id} className={panel === party.id ? "selected" : undefined}>
                <th scope="row"><strong>{party.name}</strong><small>{[party.role, party.representative].filter(Boolean).join(" · ")}{!party.requiredSubmission && " · optional"}</small></th>
                <td>{submission ? (submission.recordedBy ? "Entered by NPA staff" : "Secure link") : state.kind === "active" || state.kind === "expired" ? "Secure link" : <span className="tracker-muted">Not chosen yet</span>}</td>
                <td><StatusChip state={state} now={now} /></td>
                <td>{submission ? <>{dateLabel(submission.recordedAt)}<small>{submission.revision > 1 ? `Revision ${submission.revision}` : submission.recordedBy ? `by ${submission.recordedBy.name}` : "via link"}{submission.evidenceIds.length ? ` · ${submission.evidenceIds.length} ${submission.evidenceIds.length === 1 ? "file" : "files"}` : ""}</small></> : state.kind === "active" ? <>Waiting for the agency<small>Valid until {dateLabel(state.link.expiresAt)}</small></> : state.kind === "expired" ? <>Expired {dateLabel(state.link.expiresAt)}</> : <span className="tracker-muted">—</span>}</td>
                <td><div className="tracker-actions">
                  {submission && <button type="button" className="btn btn-secondary btn-sm" aria-expanded={open} onClick={() => setExpanded(open ? null : party.id)}>{open ? "Hide" : "View"}<span className="hide-sr"> {party.name} reading</span></button>}
                  {submission && onDownloadSubmission && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void download(submission.id)}><Icon name="download" size={14} />PDF<span className="hide-sr"> for {party.name}</span></button>}
                  {editable && <button type="button" className={`btn btn-sm ${submission ? "btn-secondary" : "btn-primary"}`} onClick={() => { setReporting({ participantId: party.id, version: plan.version }); setPanel(null); }}>{submission ? "Revise reading" : "Enter reading"}<span className="hide-sr"> for {party.name}</span></button>}
                  {editable && !submission && <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setPanel(party.id); setReporting(null); }}>{state.kind === "active" ? "Link options" : "Send link"}<span className="hide-sr"> for {party.name}</span></button>}
                </div>{rowError && submission && rowError.id === submission.id && <ErrorMessage error={rowError.error} />}</td>
              </tr>,
              open && submission ? <tr key={`${party.id}:reading`} className="tracker-detail"><td colSpan={5}><SubmittedReading plan={plan} submission={submission} /></td></tr> : null,
            ];
          })}</tbody>
        </table>
      </div>
      <p className="tracker-legend">Link status: Not invited → Link sent → Submitted, or Expired / Revoked. Each agency records its own reading and sees others only after submitting.</p>
    </section>
    {selected && editable && <LinkPanel key={selected.id} plan={plan} agency={selected} state={linkState(returns.get(selected.id), knownLinks(selected.id), now)} created={created[selected.id]?.url ? created[selected.id] : undefined} onCreate={onCreateLink ? days => create(selected.id, days) : undefined} onRevoke={onRevokeLink ? id => revoke(selected.id, id) : undefined} onClose={() => setPanel(null)} />}
  </div>;
}
