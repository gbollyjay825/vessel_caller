import { useRef, useState, type FormEvent } from "react";
import { Icon } from "../components/Icon";
import { cargoScopeLabel, dateLabel, localDateTime } from "./helpers";
import { readingQuantity } from "./comparison";
import { UNIT_LABELS } from "./cargoTemplates";
import type { SubmissionLine } from "./types";
import type { GuestCargoLine, GuestPeerReport, GuestReadingContext, GuestReadingInput, GuestSubmittedReport } from "./guestTypes";
import "../styles/guest-agency-reading.css";

export interface GuestAgencyReadingProps {
  context: GuestReadingContext;
  onSubmit: (input: GuestReadingInput) => Promise<GuestReadingContext>;
  onDownloadReport: (reportId: string) => Promise<void>;
}
function cargoLabel(line: GuestCargoLine, lines: GuestCargoLine[]): string {
  const scope = cargoScopeLabel(line);
  const label = [line.description, scope].filter(Boolean).join(" · ");
  return lines.filter(item => item.description === line.description && cargoScopeLabel(item) === scope).length > 1
    ? `${label} · item ${lines.findIndex(item => item.id === line.id) + 1}` : label;
}
const errorMessage = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;

export function GuestAgencyReading(props: GuestAgencyReadingProps) {
  return <GuestReadingWorkspace key={JSON.stringify([props.context.contextId, props.context.agency.id, props.context.lines])} {...props} />;
}

function GuestReadingWorkspace({ context, onSubmit, onDownloadReport }: GuestAgencyReadingProps) {
  const [completed, setCompleted] = useState<GuestReadingContext | null>(null);
  const current = context.ownReport ? context : completed ?? context;
  const ownReport = current.ownReport?.status === "submitted" && current.ownReport.participantId === context.agency.id ? current.ownReport : null;
  const peers = ownReport ? current.completedPeers.filter(report => report.status === "submitted" && report.participantId !== context.agency.id) : [];
  return <main className="guest-reading-page"><div className="guest-reading-shell">
    <div className="guest-reading-brand"><Icon name="anchor" size={19} />Vessel Caller</div>
    <h1>{ownReport ? "Your agency report" : "Record your agency’s reading"}</h1>
    <p className="guest-reading-intro">{ownReport ? "Your submitted measurement is recorded below. Download your report and view completed readings from other agencies on this voyage." : "Enter your agency’s independent measurements for this voyage. Your agency is fixed to this form; no account sign-in is needed."}</p>
    <section className="guest-reading-card" aria-labelledby="guest-agency-heading">
      <div className="guest-agency-identity"><div><h2 id="guest-agency-heading">{context.agency.name}</h2><p>{context.agency.role}</p></div><span className="guest-agency-chip">{ownReport ? "Reading submitted" : "Agency-specific form"}</span></div>
      <dl className="guest-voyage-summary"><div><dt>Vessel</dt><dd>{context.voyage.vesselName}</dd></div><div><dt>Voyage</dt><dd>{context.voyage.callReference}</dd></div><div><dt>Location</dt><dd>{context.voyage.location || "Not provided"}</dd></div><div><dt>Measurement</dt><dd>{context.voyage.title}</dd></div><div><dt>Scheduled</dt><dd>{dateLabel(context.voyage.scheduledAt)}</dd></div></dl>
    </section>
    {ownReport ? <>
      <div className="guest-reading-success" role="status"><Icon name="check" size={22} /><div><strong>Reading submitted</strong><p>Your agency’s figures have been saved. This receipt shows the submitted record.</p></div></div>
      <OwnReport report={ownReport} lines={current.lines} onDownload={onDownloadReport} />
      <section className="guest-reading-card" aria-labelledby="guest-peer-heading"><h2 id="guest-peer-heading">Completed peer readings</h2><p className="guest-reading-help">Submitted measurements from other agencies on this voyage. These readings are shown separately in each cargo item’s unit.</p>
        {peers.length ? <div className="guest-peer-reports">{peers.map(report => <details className="guest-peer-report" key={report.id}><summary><span><strong>{report.agencyName}</strong><small>{report.agencyRole}</small></span><small>Submitted {dateLabel(report.submittedAt)}</small></summary><div><ReportTable lines={current.lines} readings={report.lines} caption={`${report.agencyName} completed readings`} /></div></details>)}</div> : <p className="guest-reading-empty">No other agency readings have been completed yet.</p>}
      </section>
    </> : <GuestReadingForm context={context} onSubmit={async input => {
      const result = await onSubmit(input);
      if (result.contextId !== context.contextId || result.agency.id !== context.agency.id || result.ownReport?.participantId !== context.agency.id || result.ownReport.status !== "submitted") throw new Error("The submitted report could not be confirmed for this agency. Your entries are still shown below.");
      setCompleted(result);
    }} />}
  </div></main>;
}

function GuestReadingForm({ context, onSubmit }: { context: GuestReadingContext; onSubmit: (input: GuestReadingInput) => Promise<void> }) {
  const [representative, setRepresentative] = useState(context.agency.representative);
  const [observedAt, setObservedAt] = useState(() => localDateTime());
  const [sourceReference, setSourceReference] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<SubmissionLine[]>(() => context.lines.map(line => ({ lineId: line.id, status: "reported", quantity: null, note: "" })));
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const update = (id: string, patch: Partial<SubmissionLine>) => setLines(current => current.map(line => line.lineId === id ? { ...line, ...patch } : line));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pendingRef.current || !context.lines.length) return;
    if (!event.currentTarget.reportValidity()) return;
    if (!representative.trim() || !sourceReference.trim() || lines.some(line => line.status === "not-applicable" && !line.note.trim())) { setError("Enter a representative, a source reference, and a reason for each N/A item."); return; }
    pendingRef.current = true; setPending(true); setError(null);
    try { await onSubmit({ representative: representative.trim(), observedAt: new Date(observedAt).toISOString(), sourceReference: sourceReference.trim(), notes: notes.trim(), lines: lines.map(line => ({ ...line, note: line.note.trim() })) }); }
    catch (failure) { setError(errorMessage(failure, "Your reading could not be submitted. Please try again.")); }
    finally { pendingRef.current = false; setPending(false); }
  };
  return <form className="guest-reading-form" onSubmit={event => void submit(event)}><fieldset disabled={pending}>
    <section className="guest-reading-card" aria-labelledby="guest-recorder-heading"><h2 id="guest-recorder-heading">Measurement details</h2><p className="guest-reading-help">Enter the representative and source reference for your agency’s measurements.</p><div className="guest-reading-fields">
      <label className="guest-reading-field">Representative<input required maxLength={255} autoComplete="name" value={representative} onChange={event => setRepresentative(event.target.value)} /></label>
      <label className="guest-reading-field">Observed at<input aria-label="Observed at" required type="datetime-local" value={observedAt} onChange={event => setObservedAt(event.target.value)} /><small>Your local date and time.</small></label>
      <label className="guest-reading-field full">Source document reference<input required maxLength={255} value={sourceReference} onChange={event => setSourceReference(event.target.value)} /></label>
    </div></section>
    <section className="guest-reading-card" aria-labelledby="guest-cargo-heading"><h2 id="guest-cargo-heading">Your agency’s measurements</h2><p className="guest-reading-help">Enter 0 for an explicit NIL reading. A blank reading is unknown and cannot be submitted. Choose N/A only when an item does not apply, and explain why.</p>
      {context.lines.map((cargo, index) => {
        const entry = lines[index], label = cargoLabel(cargo, context.lines), notApplicable = entry.status === "not-applicable";
        const isNil = entry.quantity !== null && readingQuantity(entry.quantity) === "NIL (0)";
        return <div className="guest-cargo-entry" key={cargo.id}><h3>{cargo.description}</h3><p className="guest-cargo-scope">{[cargo.category === "Liquid" ? "Tanker / liquid cargo" : cargo.category, cargoScopeLabel(cargo), UNIT_LABELS[cargo.unit], cargo.basis].filter(Boolean).join(" · ")}</p><div className="guest-cargo-controls">
          <label className="guest-reading-field">Measured quantity · {label}<input aria-label={`Measured quantity · ${label}`} required={!notApplicable} disabled={notApplicable} type="number" min="0" step={cargo.unit === "count" ? "1" : "0.001"} value={entry.quantity ?? ""} onChange={event => update(cargo.id, { quantity: event.target.value === "" ? null : event.target.value })} /><small className={`guest-quantity-state${isNil ? " nil" : ""}`}>{notApplicable ? "N/A · no quantity" : entry.quantity === null ? "Unknown · enter a reading" : isNil ? "NIL · explicit zero" : UNIT_LABELS[cargo.unit]}</small></label>
          <label className="guest-reading-field">Reading status · {label}<select value={entry.status} onChange={event => update(cargo.id, { status: event.target.value as SubmissionLine["status"], quantity: null })}><option value="reported">Reported</option><option value="not-applicable">N/A</option></select></label>
          <label className="guest-reading-field">{notApplicable ? "N/A reason" : "Reading note"} · {label}<input required={notApplicable} maxLength={5000} value={entry.note} placeholder={notApplicable ? "Why does this item not apply?" : "Optional"} onChange={event => update(cargo.id, { note: event.target.value })} /></label>
        </div></div>;
      })}
      {!context.lines.length && <p className="guest-reading-empty">No cargo items are available. Ask the voyage coordinator to check this form.</p>}
    </section>
    <section className="guest-reading-card"><label className="guest-reading-field">Additional notes (optional)<textarea maxLength={10000} value={notes} onChange={event => setNotes(event.target.value)} /></label></section>
    </fieldset>{error && <div className="guest-reading-error" role="alert">{error}</div>}<div className="guest-reading-submit"><p>You can download your report after submitting.</p><button type="submit" className="btn btn-primary" disabled={pending || !context.lines.length}>{pending ? "Submitting…" : "Submit reading"}</button></div>
  </form>;
}

function OwnReport({ report, lines, onDownload }: { report: GuestSubmittedReport; lines: GuestCargoLine[]; onDownload: (id: string) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    if (pending) return;
    setPending(true); setError(null);
    try { await onDownload(report.id); }
    catch (failure) { setError(errorMessage(failure, "Your PDF could not be downloaded. Please try again.")); }
    finally { setPending(false); }
  };
  return <section className="guest-reading-card" aria-labelledby="guest-report-heading"><h2 id="guest-report-heading">Submitted reading</h2><dl className="guest-report-meta"><div><dt>Report reference</dt><dd>{report.id}</dd></div><div><dt>Submitted</dt><dd>{dateLabel(report.submittedAt)}</dd></div><div><dt>Representative</dt><dd>{report.representative}</dd></div><div><dt>Observed</dt><dd>{dateLabel(report.observedAt)}</dd></div><div><dt>Source document reference</dt><dd>{report.sourceReference}</dd></div></dl>
    <ReportTable lines={lines} readings={report.lines} caption="Your submitted measurements" showNotes />
    {report.notes && <p className="guest-report-note">{report.notes}</p>}
    <button type="button" className="btn btn-primary guest-report-download" disabled={pending} onClick={() => void download()}><Icon name="download" size={17} />{pending ? "Preparing PDF…" : "Download your PDF"}</button>{error && <div className="guest-reading-error" role="alert">{error}</div>}
  </section>;
}

function ReportTable({ lines, readings, caption, showNotes = false }: { lines: GuestCargoLine[]; readings: GuestPeerReport["lines"]; caption: string; showNotes?: boolean }) {
  const byId = new Map(readings.map(reading => [reading.lineId, reading]));
  return <div className="guest-report-scroll"><table className="guest-report-table"><caption className="hide-sr">{caption}</caption><thead><tr><th scope="col">Cargo item</th><th scope="col">Measured quantity</th>{showNotes && <th scope="col">Note / N/A reason</th>}</tr></thead><tbody>{lines.map(line => {
    const reading = byId.get(line.id);
    return <tr key={line.id}><th scope="row">{line.description}<small>{cargoScopeLabel(line)} · {UNIT_LABELS[line.unit]}</small></th><td>{reading?.status === "not-applicable" ? "N/A" : readingQuantity(reading?.quantity)}{reading?.status === "reported" && reading.quantity !== null && <small>{UNIT_LABELS[line.unit]}</small>}</td>{showNotes && <td>{reading && "note" in reading && typeof reading.note === "string" ? reading.note || "—" : "—"}</td>}</tr>;
  })}</tbody></table></div>;
}
