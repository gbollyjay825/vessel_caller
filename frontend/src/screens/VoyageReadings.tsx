// Readings report: the paid declaration beside every agency's reading, with
// differences marked, NPA's final agreed quantity per line, and a second
// reviewer's approval. Lines where every agency agrees are accepted for you.
import { Fragment, useState, type FormEvent } from "react";
import { useStore } from "../app/store";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { Link, useParams } from "../lib/navigation";
import { measurementApi } from "../measurements/api";
import { UNIT_LABELS } from "../measurements/cargoTemplates";
import { readingQuantity, tallyResult } from "../measurements/comparison";
import { reconciliationIssues, reportStatus, voyageInputFingerprint, type PreviewReport } from "../measurements/closeoutPreview";
import { dateLabel } from "../measurements/helpers";
import { invoiceInputFor } from "../measurements/invoiceDraft";
import { AUTO_REASON, agencyColumns, agencyKey, cargoContext, cargoHeading, readingRows, rowKey, type AgencyColumn, type ReadingCell, type ReadingRow } from "../measurements/readingsModel";
import { ErrorMessage, PreviewStorageNotice } from "../measurements/shared";
import { useVariationTariff } from "../measurements/tariffs";
import { VoyageFrame, useVoyage, type VoyageData } from "../measurements/VoyageWorkspace";
import { voyagePath } from "../measurements/voyageStatus";
import type { CargoLine, MeasurementPlan } from "../measurements/types";
import "../styles/voyage-readings.css";

type FinalEntry = { planId: string; lineId: string; quantity: string; reason: string };
type Draft = { fingerprint: string; reason: string; lines: FinalEntry[] };
const activeSheets = (plans: MeasurementPlan[]) => plans.filter(plan => plan.status !== "cancelled");
const plainQuantity = (value: string) => value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;

export function validFinalQuantity(value: string, unit: CargoLine["unit"]): boolean {
  const text = value.trim();
  return /^\d{1,15}(?:\.\d{1,3})?$/.test(text)
    && (unit !== "count" || !text.includes(".") || /\.0{1,3}$/.test(text));
}

function initialDraft(plans: MeasurementPlan[], rows: ReadingRow[], base?: PreviewReport): Draft {
  return {
    fingerprint: voyageInputFingerprint(plans),
    reason: base?.reason ?? "",
    lines: rows.map(row => {
      const previous = base?.lines.find(entry => entry.planId === row.plan.id && entry.lineId === row.line.id);
      if (previous) return { planId: row.plan.id, lineId: row.line.id, quantity: plainQuantity(previous.quantity), reason: previous.reason };
      if (row.agree) return { planId: row.plan.id, lineId: row.line.id, quantity: plainQuantity(row.line.manifestQuantity!), reason: AUTO_REASON };
      return { planId: row.plan.id, lineId: row.line.id, quantity: "", reason: "" };
    }),
  };
}

function draftIssues(rows: ReadingRow[], draft: Draft): string[] {
  const issues: string[] = [];
  for (const row of rows) {
    const entry = draft.lines.find(item => item.planId === row.plan.id && item.lineId === row.line.id);
    if (!entry || !validFinalQuantity(entry.quantity, row.line.unit)) issues.push(`Choose the final quantity for ${cargoHeading(row.line)}.`);
    else if (!entry.reason.trim()) issues.push(`Explain the final quantity for ${cargoHeading(row.line)}.`);
  }
  if (!draft.reason.trim()) issues.push("Add a review note.");
  return issues;
}

function columnMeta(column: AgencyColumn, plans: MeasurementPlan[]): string {
  const submissions = plans.flatMap(plan => plan.participants.filter(party => agencyKey(party) === column.key)
    .flatMap(party => plan.submissions.filter(item => item.participantId === party.id)));
  const latest = submissions.sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0];
  if (!latest) return "Awaiting reading";
  const files = latest.evidenceIds.length ? ` · ${latest.evidenceIds.length} ${latest.evidenceIds.length === 1 ? "file" : "files"}` : "";
  return `${latest.recordedBy ? "Entered by NPA" : "Via secure link"} · ${new Date(latest.recordedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}${files}`;
}

function Difference({ value }: { value: string | null }) {
  if (value === null || value === "0") return null;
  const below = value.startsWith("-");
  return <><span className={`var-badge ${below ? "below" : "above"}`} aria-hidden="true">{below ? "−" : "+"}{readingQuantity(value.replace(/^[+-]/, ""))}</span><span className="hide-sr">, {readingQuantity(value.replace(/^[+-]/, ""))} {below ? "below" : "above"} the declaration</span></>;
}

function Reading({ cell, multiple }: { cell: ReadingCell; multiple: boolean }) {
  const who = multiple ? <small className="readings-rep">{cell.party.representative}</small> : null;
  if (cell.state === "awaiting") return <div>{who}<span className="readings-missing">Awaiting</span></div>;
  if (cell.state === "not-submitted") return <div>{who}<span className="readings-missing">Not submitted</span></div>;
  if (cell.state === "not-reported") return <div>{who}<span className="readings-missing">Not reported</span></div>;
  if (cell.state === "na") return <div>{who}<strong>N/A</strong><small>{cell.note || "No reason given"}</small></div>;
  return <div>{who}<strong>{readingQuantity(cell.quantity)}</strong><Difference value={cell.difference} />{cell.note && <small>{cell.note}</small>}</div>;
}

function cellTone(cells: ReadingCell[] | undefined): string {
  if (!cells?.length) return "";
  if (cells.some(cell => cell.difference?.startsWith("-"))) return "below";
  if (cells.some(cell => cell.difference && cell.difference !== "0")) return "above";
  return "";
}

function Outcome({ quantity, declared, unit }: { quantity?: string; declared: string | null; unit: CargoLine["unit"] }) {
  const result = tallyResult(quantity, declared);
  if (result.status === "unknown") return <span className="readings-missing">{declared === null ? "No declaration" : "Final needed"}</span>;
  if (result.status === "tallies") return <span className="var-match"><Icon name="check" size={13} strokeWidth={3} />Matches</span>;
  const amount = readingQuantity(result.difference!.replace(/^[+-]/, ""));
  return result.status === "above"
    ? <><span className="var-badge above">+{amount} above</span><small className="readings-outcome above">Additional load · {UNIT_LABELS[unit].toLowerCase()}</small></>
    : <><span className="var-badge below">−{amount} below</span><small className="readings-outcome below">Overpayment review</small></>;
}

function ReadingsTable({ rows, columns, plans, draft, editable, finals, onChange, differencesOnly }: {
  rows: ReadingRow[]; columns: AgencyColumn[]; plans: MeasurementPlan[]; draft?: Draft; editable: boolean;
  finals?: Map<string, { quantity: string; reason: string }>; onChange?: (planId: string, lineId: string, patch: Partial<FinalEntry>) => void; differencesOnly: boolean;
}) {
  const sheets = new Set(rows.map(row => row.plan.id));
  const visible = rows.filter(row => !differencesOnly || !row.agree);
  return <div className="readings-scroll" role="region" aria-label="Readings compared with the paid declaration" tabIndex={0}>
    <table className="readings-table">
      <caption className="hide-sr">Paid declaration, each agency’s reading and NPA’s final agreed quantity for every cargo line</caption>
      <thead><tr>
        <th scope="col" className="readings-cargo">Cargo line</th>
        <th scope="col" className="readings-declared">Paid declaration</th>
        {columns.map(column => <th scope="col" key={column.key}>{column.name}<small>{column.role}</small><small>{columnMeta(column, plans)}</small></th>)}
        <th scope="col">Spread</th>
        <th scope="col" className="readings-final">NPA final agreed</th>
        <th scope="col" className="readings-vs">vs declaration</th>
      </tr></thead>
      <tbody>
        {visible.map((row, index) => {
          const entry = draft?.lines.find(item => item.planId === row.plan.id && item.lineId === row.line.id);
          const saved = finals?.get(row.key);
          const finalQuantity = editable ? entry?.quantity : saved?.quantity;
          const heading = cargoHeading(row.line);
          const showSheet = sheets.size > 1 && (index === 0 || visible[index - 1].plan.id !== row.plan.id);
          return <Fragment key={row.key}>
            {showSheet && <tr className="readings-sheet"><th scope="rowgroup" colSpan={columns.length + 5}>{row.plan.title}{row.plan.scope && <small>{row.plan.scope}</small>}</th></tr>}
            <tr className={row.agree ? "readings-agree" : undefined}>
              <th scope="row" className="readings-cargo"><strong>{heading}</strong><small>{cargoContext(row.line)}</small></th>
              <td className="readings-declared"><strong>{readingQuantity(row.line.manifestQuantity)}</strong></td>
              {columns.map(column => {
                const cells = row.cells.get(column.key);
                return <td key={column.key} className={cellTone(cells)}>{cells?.length ? cells.map(cell => <Reading key={cell.party.id} cell={cell} multiple={cells.length > 1} />) : <span className="readings-missing">—<small>Not on this sheet</small></span>}</td>;
              })}
              <td>{row.spread ? Number(row.spread.range) === 0 ? <span className="readings-missing">None</span> : <>{readingQuantity(row.spread.range)}<small>{readingQuantity(row.spread.min)}–{readingQuantity(row.spread.max)}</small></> : "—"}</td>
              <td className="readings-final">
                {editable && entry ? row.agree && entry.reason === AUTO_REASON && entry.quantity === plainQuantity(row.line.manifestQuantity ?? "") ? <span className="readings-accepted"><strong>{readingQuantity(entry.quantity)}</strong><span className="var-match"><Icon name="check" size={13} strokeWidth={3} />All agree · accepted</span></span> : <div className="readings-decision">
                  <div className="readings-decision-value"><label className="hide-sr" htmlFor={`final-${row.key}`}>NPA final quantity · {heading} · {row.plan.title}</label><input id={`final-${row.key}`} type="number" min="0" step={row.line.unit === "count" ? "1" : "0.001"} value={entry.quantity} placeholder="Choose" onChange={event => onChange?.(row.plan.id, row.line.id, { quantity: event.target.value })} /><span>{UNIT_LABELS[row.line.unit].toLowerCase()}</span></div>
                  {row.options.length > 0 && <div className="readings-picks" role="group" aria-label={`Use a reading for ${heading}`}>{row.options.map(option => {
                    const selected = entry.quantity !== "" && tallyResult(entry.quantity, option.quantity).status === "tallies";
                    return <button type="button" key={option.quantity} className={`readings-pick${selected ? " selected" : ""}`} aria-pressed={selected} onClick={() => onChange?.(row.plan.id, row.line.id, { quantity: plainQuantity(option.quantity) })}>{readingQuantity(option.quantity)} · {option.parties.join(", ")}</button>;
                  })}</div>}
                  <label className="hide-sr" htmlFor={`reason-${row.key}`}>Reason · {heading} · {row.plan.title}</label>
                  <input id={`reason-${row.key}`} className="readings-reason" value={entry.reason} placeholder="Why this quantity?" onChange={event => onChange?.(row.plan.id, row.line.id, { reason: event.target.value })} />
                </div> : saved ? <><strong>{readingQuantity(saved.quantity)}</strong><small>{saved.reason}</small></> : <span className="readings-missing">—</span>}
              </td>
              <td className="readings-vs"><Outcome quantity={finalQuantity} declared={row.line.manifestQuantity} unit={row.line.unit} /></td>
            </tr>
          </Fragment>;
        })}
        {!visible.length && <tr><td colSpan={columns.length + 5} className="readings-none">Every line matches the declaration. Turn off “Differences only” to see them.</td></tr>}
      </tbody>
    </table>
  </div>;
}

function Timeline({ report, invoiceNumber }: { report: PreviewReport; invoiceNumber?: string }) {
  const status = reportStatus(report);
  const step = (done: boolean, title: string, detail?: string) => <li className={done ? "done" : ""}><span aria-hidden="true">{done && <Icon name="check" size={12} strokeWidth={3} />}</span><div><strong>{title}</strong>{detail && <small>{detail}</small>}</div></li>;
  return <ol className="readings-timeline">
    {report.preparedBy ? step(true, `Prepared by ${report.preparedBy.name}`, report.preparedAt ? dateLabel(report.preparedAt) : undefined) : step(true, "Approved directly", "Saved before the second-review step")}
    {report.preparedBy && step(true, "Submitted for approval")}
    {status === "returned" && step(true, `Returned by ${report.returnedBy?.name}`, `${report.returnedAt ? dateLabel(report.returnedAt) : ""} · “${report.returnComment}”`)}
    {status === "approved" && report.approvedBy && step(true, `Approved by ${report.approvedBy.name} · version ${report.revision} locked`, report.approvedAt ? dateLabel(report.approvedAt) : undefined)}
    {status === "approved" && invoiceNumber && step(true, `Variation invoice ${invoiceNumber} drafted`)}
    {status === "submitted" && step(false, "Waiting for a second reviewer to approve or return it")}
  </ol>;
}

function ReadingsWorkspace({ voyage }: { voyage: VoyageData }) {
  const { user, org, can } = useAuth();
  const { toast } = useStore();
  const { tariff } = useVariationTariff(org?.id);
  const { plans, preview, summary } = voyage;
  const sheets = activeSheets(plans);
  const columns = agencyColumns(sheets);
  const rows = readingRows(sheets, columns);
  const cancelled = summary.stage === "cancelled";
  const canEdit = can("measurements.manage") && !cancelled;
  const canApprove = can("measurements.approve") && !cancelled;
  const actor = user ? { id: user.id, name: user.name } : undefined;
  const fingerprint = voyageInputFingerprint(sheets);
  const approved = summary.report;
  const pending = summary.pending;
  const returned = summary.returned && summary.returned.sourceFingerprint === fingerprint ? summary.returned : undefined;
  const staleApproval = !approved && !pending && preview.record.reports.some(report => reportStatus(report) === "approved");
  const [revising, setRevising] = useState(false);
  const [draft, setDraft] = useState(() => initialDraft(sheets, rows, returned));
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const [returnComment, setReturnComment] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const editing = canEdit && !pending && (!approved || revising);
  const readiness = reconciliationIssues(sheets);
  const staleDraft = draft.fingerprint !== fingerprint;
  const issues = draftIssues(rows, draft);
  const shown = pending ?? (editing ? undefined : approved);
  const finals = shown ? new Map(shown.lines.map(line => [rowKey(line.planId, line.lineId), { quantity: line.quantity, reason: line.reason }])) : undefined;
  const invoice = approved ? preview.record.invoices.filter(item => item.reportId === approved.id).at(-1) : undefined;
  const agreeing = rows.filter(row => row.agree).length;
  const differing = rows.filter(row => row.differs).length;
  const updateLine = (planId: string, lineId: string, patch: Partial<FinalEntry>) => setDraft(current => ({ ...current, lines: current.lines.map(line => line.planId === planId && line.lineId === lineId ? { ...line, ...patch } : line) }));

  if (!sheets.length) return <section className="voyage-card voyage-card-pad readings-empty">
    <h2>No declaration for this voyage yet</h2>
    <p>Record the owner’s paid declaration and invite the agencies. Their readings will appear here side by side.</p>
    {canEdit && <Link className="btn btn-primary" to={`/app/measurements/new?callId=${encodeURIComponent(summary.callId)}`}>Record declaration</Link>}
  </section>;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!actor || !editing || staleDraft || readiness.length || issues.length) return;
    const saved = preview.submitReport(sheets, { reason: draft.reason.trim(), lines: draft.lines.map(line => ({ ...line, quantity: line.quantity.trim(), reason: line.reason.trim() })) }, actor);
    if (saved) { setRevising(false); setNotice(`Version ${saved.revision} sent for approval.`); toast(`Final quantities v${saved.revision} sent for approval`); }
  };
  const approve = () => {
    if (!actor || !pending) return;
    const result = preview.approveReport(sheets, pending.id, actor, invoiceInputFor(pending, sheets, summary.declaration, tariff));
    if (!result) return;
    setNotice(result.invoice ? `Version ${result.report.revision} approved. Variation invoice ${result.invoice.number} has been drafted.` : `Version ${result.report.revision} approved. Complete the invoice details to draft the variation invoice.`);
    toast(`Final quantities v${result.report.revision} approved`);
  };
  const sendBack = () => {
    if (!actor || !pending || !returnComment.trim()) return;
    const result = preview.returnReport(pending.id, actor, returnComment);
    if (result) { setReturnComment(""); setDraft(initialDraft(sheets, rows, result)); setNotice(`Version ${result.revision} returned to ${result.preparedBy?.name ?? "the preparer"}.`); }
  };
  const statusChip = pending ? <span className="stage-chip amber">Awaiting approval · v{pending.revision}</span>
    : approved && !editing ? <span className="stage-chip green">Approved · v{approved.revision}</span>
    : <span className="stage-chip">{returned ? `Returned · v${returned.revision}` : "Draft"}</span>;

  return <>
    <ErrorMessage error={preview.error ? new Error(preview.error) : null} />
    {notice && <div className="measurement-notice" role="status">{notice}</div>}
    <section className="voyage-card readings-report" aria-labelledby="readings-heading">
      <div className="voyage-card-head">
        <div>
          <h2 id="readings-heading">Readings report {statusChip}</h2>
          <div className="readings-summary">
            <span className="stage-chip">{rows.length} cargo {rows.length === 1 ? "line" : "lines"} · {columns.length} {columns.length === 1 ? "agency" : "agencies"}</span>
            <span className="stage-chip">{summary.received} of {summary.expected} readings in</span>
            {agreeing > 0 && <span className="stage-chip green">{agreeing} {agreeing === 1 ? "line agrees" : "lines agree"}</span>}
            {differing > 0 && <span className="stage-chip amber">{differing} {differing === 1 ? "line differs" : "lines differ"}</span>}
          </div>
        </div>
        <button type="button" className={`btn btn-secondary readings-toggle${differencesOnly ? " on" : ""}`} aria-pressed={differencesOnly} onClick={() => setDifferencesOnly(value => !value)}>Differences only</button>
      </div>
      {editing && returned && <div className="measurement-notice warning readings-callout" role="status"><strong>Returned by {returned.returnedBy?.name}:</strong> “{returned.returnComment}” Change what is needed and submit again.</div>}
      {editing && staleApproval && <div className="measurement-notice warning readings-callout" role="status">The readings changed after the last approved version. Review the figures and submit a new version.</div>}
      {editing && readiness.length > 0 && <div className="measurement-notice warning readings-callout"><strong>Before you can submit</strong><ul>{readiness.map(issue => <li key={issue}>{issue}</li>)}</ul><Link className="link-btn" to={voyagePath(summary.callId, "agencies")}>Go to agency readings</Link></div>}
      {editing && staleDraft && <div className="measurement-notice warning readings-callout" role="alert">New readings arrived while you were working. <button type="button" className="link-btn" onClick={() => { setDraft(initialDraft(sheets, rows, returned)); setNotice("Latest readings loaded. Check each differing line again."); }}>Load the latest readings</button></div>}
      <ReadingsTable rows={rows} columns={columns} plans={sheets} draft={draft} editable={editing && !staleDraft} finals={finals} onChange={updateLine} differencesOnly={differencesOnly} />
      <p className="readings-legend"><span className="var-badge above">+6</span> above the paid declaration · <span className="var-badge below">−2</span> below it · NIL (0) = counted none · N/A = not applicable, with a reason. Readings are never averaged or added together.</p>
    </section>

    <div className="voyage-columns">
      <section className="voyage-card voyage-card-pad readings-note" aria-labelledby="review-note-heading">
        <h2 id="review-note-heading">Review note</h2>
        {editing ? <><label className="hide-sr" htmlFor="review-note">Review note</label><textarea id="review-note" rows={3} value={draft.reason} disabled={staleDraft} onChange={event => setDraft(current => ({ ...current, reason: event.target.value }))} placeholder="How were the final quantities confirmed? For example, joint meeting with the terminal and surveyor." /></>
          : <p>{shown?.reason ?? "No version has been prepared yet."}</p>}
      </section>

      <section className="voyage-card voyage-card-pad readings-approval" aria-labelledby="approval-heading">
        <h2 id="approval-heading">Approval{(pending ?? approved) ? ` · version ${(pending ?? approved)!.revision}` : ""}</h2>
        {pending && <Timeline report={pending} />}
        {!pending && approved && !editing && <Timeline report={approved} invoiceNumber={invoice?.number} />}
        {editing && <>
          <p className="readings-help">{issues.length ? `${draft.lines.length - issues.filter(issue => !issue.startsWith("Add a review")).length} of ${draft.lines.length} lines decided. ` : "Every line is decided. "}A second NPA reviewer approves the final quantities.</p>
          {issues.length > 0 && !readiness.length && <ul className="readings-todo">{issues.slice(0, 4).map(issue => <li key={issue}>{issue}</li>)}{issues.length > 4 && <li>…and {issues.length - 4} more</li>}</ul>}
          <form onSubmit={submit} className="readings-actions">
            {revising && <button type="button" className="btn btn-secondary" onClick={() => setRevising(false)}>Cancel revision</button>}
            <button type="submit" className="btn btn-primary" disabled={!actor || staleDraft || readiness.length > 0 || issues.length > 0}>Submit for approval</button>
          </form>
        </>}
        {pending && (canApprove && actor && pending.preparedBy?.id !== actor.id ? <div className="readings-actions readings-review">
          <label className="measurement-field"><span>Comment if returning</span><textarea rows={2} value={returnComment} onChange={event => setReturnComment(event.target.value)} placeholder="What should the preparer change?" /></label>
          <div className="readings-actions"><button type="button" className="btn btn-secondary" disabled={!returnComment.trim()} onClick={sendBack}>Return with comment</button><button type="button" className="btn btn-primary" onClick={approve}><Icon name="check" size={16} /> Approve final quantities</button></div>
        </div> : <p className="readings-help">{pending.preparedBy?.id === actor?.id ? "A second reviewer with approval rights must approve the version you prepared." : "Waiting for an NPA reviewer with approval rights."}</p>)}
        {!pending && approved && !editing && <div className="readings-actions">
          {canEdit && <button type="button" className="btn btn-secondary" onClick={() => { setDraft(initialDraft(sheets, rows, approved)); setRevising(true); setNotice(null); }}>Start a revised version</button>}
          <button type="button" className="btn btn-secondary" onClick={() => window.print()}><Icon name="fileText" size={16} /> Print</button>
          <Link className="btn btn-primary" to={voyagePath(summary.callId, "variation-invoice")}>Open variation invoice <Icon name="chevronRight" size={16} /></Link>
        </div>}
        {!editing && !pending && !approved && <p className="readings-help">An NPA user with voyage access prepares the final quantities; a second reviewer approves them.</p>}
        <PreviewStorageNotice />
      </section>
    </div>

    {preview.record.reports.length > 0 && <details className="voyage-card voyage-card-pad readings-history voyage-no-print">
      <summary>Version history ({preview.record.reports.length})</summary>
      <ol>{[...preview.record.reports].reverse().map(report => <li key={report.id}>
        <strong>Version {report.revision}</strong> <span className={`stage-chip ${reportStatus(report) === "approved" ? "green" : reportStatus(report) === "returned" ? "amber" : ""}`}>{reportStatus(report) === "approved" ? "Approved" : reportStatus(report) === "returned" ? "Returned" : "Submitted"}</span>
        <small>{[report.preparedBy && `Prepared by ${report.preparedBy.name}`, report.approvedBy && `approved by ${report.approvedBy.name} ${report.approvedAt ? dateLabel(report.approvedAt) : ""}`, report.returnedBy && `returned by ${report.returnedBy.name}: “${report.returnComment}”`].filter(Boolean).join(" · ")}</small>
        <ul>{report.lines.map(line => <li key={`${line.planId}:${line.lineId}`}>{line.description}: {readingQuantity(line.quantity)} {UNIT_LABELS[line.unit].toLowerCase()} — {line.reason}</li>)}</ul>
      </li>)}</ol>
    </details>}
  </>;
}

export function VoyageReadings() {
  const { callId = "" } = useParams<{ callId: string }>();
  const voyage = useVoyage(callId);
  const { org } = useAuth();
  return <VoyageFrame voyage={voyage} step="readings" actions={voyage.plans.length > 0 && <a className="btn btn-secondary" href={measurementApi.readingsDocumentUrl(callId)}><Icon name="download" size={16} /> Readings PDF</a>}>
    <ReadingsWorkspace key={`${org?.id ?? ""}:${callId}`} voyage={voyage} />
  </VoyageFrame>;
}
