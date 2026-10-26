// The agency's own form, opened from a secure link on a phone or computer:
// one large field per cargo line, then a receipt with the agency's PDF and the
// other agencies' completed readings beside its own.
import { useRef, useState, type FormEvent } from "react";
import { Icon } from "../components/Icon";
import { ProductBrand } from "../components/ProductBrand";
import { cargoScopeLabel, dateLabel, localDateTime } from "./helpers";
import { quantityDifference, readingQuantity } from "./comparison";
import { cargoContext, cargoHeading } from "./readingsModel";
import type { SubmissionLine } from "./types";
import type { GuestCargoLine, GuestPeerReport, GuestReadingContext, GuestReadingInput, GuestSubmittedReport } from "./guestTypes";
import "../styles/guest-agency-reading.css";

export interface GuestAgencyReadingProps {
  context: GuestReadingContext;
  onSubmit: (input: GuestReadingInput) => Promise<GuestReadingContext>;
  onDownloadReport: (reportId: string) => Promise<void>;
}
// Full context for screen readers and tests; the visible heading stays short.
function cargoLabel(line: GuestCargoLine, lines: GuestCargoLine[]): string {
  const scope = cargoScopeLabel(line);
  const label = [line.description, scope].filter(Boolean).join(" · ");
  return lines.filter(item => item.description === line.description && cargoScopeLabel(item) === scope).length > 1
    ? `${label} · item ${lines.findIndex(item => item.id === line.id) + 1}` : label;
}
function unitWord(line: GuestCargoLine): string {
  if (line.unit === "tonnes") return "tonnes";
  if (line.unit === "m3") return "m³";
  return line.category === "Container" ? "containers" : line.category === "Vehicle" ? "vehicles" : "items";
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
    <header className="guest-bar"><ProductBrand className="guest-reading-brand" /><span className="guest-secure"><Icon name="check" size={13} strokeWidth={3} />Secure link</span></header>
    <h1>{ownReport ? "Your agency report" : "Record your agency’s reading"}</h1>
    <section className="guest-reading-card guest-identity" aria-labelledby="guest-agency-heading">
      <h2 id="guest-agency-heading">{context.agency.name}</h2>
      <p className="guest-role">{context.agency.role}</p>
      <dl className="guest-voyage-summary">
        <div><dt>Vessel</dt><dd>{context.voyage.vesselName}</dd></div>
        <div><dt>Voyage</dt><dd>{context.voyage.callReference}</dd></div>
        <div><dt>Location</dt><dd>{context.voyage.location || "Not provided"}</dd></div>
        <div><dt>Measurement</dt><dd>{dateLabel(context.voyage.scheduledAt)}</dd></div>
      </dl>
      {!ownReport && <p className="guest-reading-intro">Enter your agency’s own count. Your agency is fixed to this form; no account sign-in is needed. Other agencies’ readings appear after you submit.</p>}
    </section>
    {ownReport ? <>
      <div className="guest-reading-success" role="status"><Icon name="check" size={22} strokeWidth={2.6} /><div><strong>Reading submitted</strong><p>{dateLabel(ownReport.submittedAt)} · Reference {ownReport.id}</p></div></div>
      <OwnReport report={ownReport} lines={current.lines} onDownload={onDownloadReport} />
      <section className="guest-reading-card" aria-labelledby="guest-peer-heading">
        <h2 id="guest-peer-heading">Other agencies’ completed readings</h2>
        <p className="guest-reading-help">{peers.length ? `${peers.length} other ${peers.length === 1 ? "agency has" : "agencies have"} submitted. Figures that differ from yours are underlined.` : "No other agency has submitted yet. Their readings appear here once they do."}</p>
        {peers.length > 0 && <PeerTable lines={current.lines} own={ownReport} peers={peers} />}
        <p className="guest-reading-help">These are submitted readings, not NPA’s final figures. NPA reconciles them against the owner’s declaration.</p>
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
  const [openNotes, setOpenNotes] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const update = (id: string, patch: Partial<SubmissionLine>) => setLines(current => current.map(line => line.lineId === id ? { ...line, ...patch } : line));
  const entered = lines.filter(line => line.status === "not-applicable" ? line.note.trim() : line.quantity !== null && line.quantity !== "").length;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pendingRef.current || !context.lines.length) return;
    if (!event.currentTarget.reportValidity()) return;
    if (!representative.trim() || !sourceReference.trim() || lines.some(line => line.status === "not-applicable" && !line.note.trim())) { setError("Enter a representative, a source document reference, and a reason for each line that does not apply."); return; }
    pendingRef.current = true; setPending(true); setError(null);
    try { await onSubmit({ representative: representative.trim(), observedAt: new Date(observedAt).toISOString(), sourceReference: sourceReference.trim(), notes: notes.trim(), lines: lines.map(line => ({ ...line, note: line.note.trim() })) }); }
    catch (failure) { setError(errorMessage(failure, "Your reading could not be submitted. Please try again.")); }
    finally { pendingRef.current = false; setPending(false); }
  };
  return <form className="guest-reading-form" onSubmit={event => void submit(event)}><fieldset disabled={pending}>
    <section className="guest-reading-card" aria-labelledby="guest-cargo-heading">
      <div className="guest-progress-head"><h2 id="guest-cargo-heading">Your agency’s count</h2><span>{entered} of {context.lines.length} entered</span></div>
      <div className="guest-progress" role="progressbar" aria-label="Lines entered" aria-valuemin={0} aria-valuemax={context.lines.length} aria-valuenow={entered}><span style={{ width: `${context.lines.length ? Math.round(entered / context.lines.length * 100) : 0}%` }} /></div>
      <p className="guest-reading-help">Enter 0 if you counted none. Leave a line blank only if you did not count it — every line needs a figure or a reason before you submit.</p>
      {context.lines.map((cargo, index) => {
        const entry = lines[index], label = cargoLabel(cargo, context.lines), notApplicable = entry.status === "not-applicable";
        const isNil = entry.quantity !== null && entry.quantity !== "" && readingQuantity(entry.quantity) === "NIL (0)";
        const noteOpen = openNotes.includes(cargo.id) || entry.note.trim() !== "" && !notApplicable;
        return <div className="guest-cargo-entry" key={cargo.id} role="group" aria-labelledby={`guest-line-${cargo.id}`}>
          <div className="guest-cargo-head"><h3 id={`guest-line-${cargo.id}`}>{cargoHeading(cargo)}</h3><button type="button" className="guest-link" onClick={() => update(cargo.id, notApplicable ? { status: "reported", quantity: null, note: "" } : { status: "not-applicable", quantity: null })}>{notApplicable ? "Enter a figure" : "Not applicable?"}</button></div>
          <p className="guest-cargo-scope">{cargoContext(cargo)}</p>
          {notApplicable ? <label className="guest-reading-field">Why doesn’t this line apply?<input aria-label={`N/A reason · ${label}`} required maxLength={5000} value={entry.note} onChange={event => update(cargo.id, { note: event.target.value })} /></label> : <>
            <div className="guest-quantity"><input aria-label={`Measured quantity · ${label}`} required type="number" inputMode={cargo.unit === "count" ? "numeric" : "decimal"} min="0" step={cargo.unit === "count" ? "1" : "0.001"} value={entry.quantity ?? ""} onChange={event => update(cargo.id, { quantity: event.target.value === "" ? null : event.target.value })} /><span>{unitWord(cargo)}</span></div>
            {(entry.quantity === null || entry.quantity === "" || isNil) && <small className={`guest-quantity-state${isNil ? " nil" : ""}`}>{isNil ? "NIL · counted none" : "Not entered yet"}</small>}
            {noteOpen ? <label className="guest-reading-field guest-note">Note (optional)<input aria-label={`Reading note · ${label}`} maxLength={5000} value={entry.note} onChange={event => update(cargo.id, { note: event.target.value })} /></label>
              : <button type="button" className="guest-link guest-add-note" onClick={() => setOpenNotes(current => [...current, cargo.id])}>Add a note</button>}
          </>}
        </div>;
      })}
      {!context.lines.length && <p className="guest-reading-empty">No cargo lines are available. Ask the voyage coordinator to check this form.</p>}
    </section>
    <section className="guest-reading-card" aria-labelledby="guest-recorder-heading">
      <h2 id="guest-recorder-heading">Who counted</h2>
      <div className="guest-reading-fields">
        <label className="guest-reading-field">Representative<input required maxLength={255} autoComplete="name" value={representative} onChange={event => setRepresentative(event.target.value)} /></label>
        <label className="guest-reading-field">Observed at<input aria-label="Observed at" required type="datetime-local" value={observedAt} onChange={event => setObservedAt(event.target.value)} /><small>Your local date and time.</small></label>
        <label className="guest-reading-field full">Source document reference<input required maxLength={255} value={sourceReference} onChange={event => setSourceReference(event.target.value)} /><small>For example your tally sheet or survey report number.</small></label>
        <label className="guest-reading-field full">Additional notes (optional)<textarea maxLength={10000} value={notes} onChange={event => setNotes(event.target.value)} /></label>
      </div>
    </section>
    </fieldset>
    {error && <div className="guest-reading-error" role="alert">{error}</div>}
    <div className="guest-reading-submit"><button type="submit" className="btn btn-primary" disabled={pending || !context.lines.length}>{pending ? "Submitting…" : "Submit reading"}</button><p>You can download your PDF receipt straight after submitting.</p></div>
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
  const byId = new Map(report.lines.map(reading => [reading.lineId, reading]));
  return <section className="guest-reading-card" aria-labelledby="guest-report-heading">
    <button type="button" className="btn btn-primary guest-report-download" disabled={pending} onClick={() => void download()}><Icon name="download" size={18} />{pending ? "Preparing PDF…" : "Download your PDF"}</button>
    {error && <div className="guest-reading-error" role="alert">{error}</div>}
    <h2 id="guest-report-heading">Your figures</h2>
    <dl className="guest-figures">{lines.map(line => {
      const reading = byId.get(line.id);
      return <div key={line.id}><dt>{cargoHeading(line)}<small>{cargoContext(line)}</small></dt><dd>{reading?.status === "not-applicable" ? "N/A" : readingQuantity(reading?.quantity)}{reading && "note" in reading && reading.note ? <small>{reading.note}</small> : null}</dd></div>;
    })}</dl>
    <dl className="guest-report-meta"><div><dt>Representative</dt><dd>{report.representative}</dd></div><div><dt>Observed</dt><dd>{dateLabel(report.observedAt)}</dd></div><div><dt>Source document</dt><dd>{report.sourceReference}</dd></div></dl>
    {report.notes && <p className="guest-report-note">{report.notes}</p>}
  </section>;
}

function PeerTable({ lines, own, peers }: { lines: GuestCargoLine[]; own: GuestSubmittedReport; peers: GuestPeerReport[] }) {
  const ownById = new Map(own.lines.map(reading => [reading.lineId, reading]));
  return <div className="guest-report-scroll" role="region" aria-label="Your readings beside other agencies" tabIndex={0}><table className="guest-report-table">
    <caption className="hide-sr">Your count compared with other agencies’ completed readings</caption>
    <thead><tr><th scope="col">Line</th><th scope="col">You</th>{peers.map(peer => <th scope="col" key={peer.id}>{peer.agencyName}<small>{peer.agencyRole}</small></th>)}</tr></thead>
    <tbody>{lines.map(line => {
      const mine = ownById.get(line.id);
      return <tr key={line.id}><th scope="row">{cargoHeading(line)}</th><td>{mine?.status === "not-applicable" ? "N/A" : readingQuantity(mine?.quantity)}</td>{peers.map(peer => {
        const reading = peer.lines.find(item => item.lineId === line.id);
        if (!reading) return <td key={peer.id}>—</td>;
        if (reading.status === "not-applicable") return <td key={peer.id}>N/A</td>;
        const differs = mine?.status === "reported" && quantityDifference(reading.quantity, mine.quantity) !== "0";
        return <td key={peer.id}>{differs ? <><span className="guest-differs">{readingQuantity(reading.quantity)}</span><span className="hide-sr"> (differs from yours)</span></> : readingQuantity(reading.quantity)}</td>;
      })}</tr>;
    })}</tbody>
  </table></div>;
}
