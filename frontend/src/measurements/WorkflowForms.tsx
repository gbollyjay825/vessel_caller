import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { quantityDifference, readingQuantity } from "./comparison";
import { ActionForm, EvidencePicker, FormField } from "./shared";
import { cargoInputLabel, cargoScopeLabel, latestReconciliation, latestReturns, localDateTime, quantity } from "./helpers";
import type { ApprovalInput, AssessmentInput, AssessmentLineInput, BillingPolicy, MeasurementPlan, Reconciliation, ReconciliationInput, SubmissionInput, SubmissionLine } from "./types";

interface FormProps<T> { plan: MeasurementPlan; onSave: (value: T) => Promise<unknown>; onCancel: () => void }
type ReturnDraft = Omit<SubmissionInput, "participantId">;

function returnDraft(plan: MeasurementPlan, participantId: string): ReturnDraft {
  const previous = latestReturns(plan).get(participantId);
  return {
    observedAt: localDateTime(previous?.observedAt),
    sourceReference: previous?.sourceReference ?? "",
    reason: "",
    notes: previous?.notes ?? "",
    evidenceIds: [...(previous?.evidenceIds ?? [])],
    lines: plan.lines.map(line => {
      const entry = previous?.lines.find(item => item.lineId === line.id);
      return entry ? { ...entry } : { lineId: line.id, status: "reported", quantity: null, note: "" };
    }),
  };
}

function readingLabel(value: string | null | undefined): string {
  if (value == null || value === "") return "Unknown";
  return readingQuantity(value);
}

function readingDifference(value: string | null | undefined, declaration: string | null, notApplicable = false): string {
  if (notApplicable) return "Not comparable";
  if (value == null || value === "") return "Awaiting reading";
  if (declaration == null) return "Owner declaration not provided";
  return quantityDifference(value, declaration) ?? "Awaiting reading";
}

export function ReturnForm({ plan, onSave, onCancel }: FormProps<SubmissionInput>) {
  const { user } = useAuth();
  const returns = latestReturns(plan);
  const [participantId, setParticipantId] = useState(plan.participants.find(party => !returns.has(party.id))?.id ?? plan.participants[0]?.id ?? "");
  // Each agency owns its draft, including evidence and source metadata. Editing
  // a received return always copies its lines rather than mutating history.
  const [drafts, setDrafts] = useState<Record<string, ReturnDraft>>(() => Object.fromEntries(
    plan.participants.map(party => [party.id, returnDraft(plan, party.id)]),
  ));
  const [uploading, setUploading] = useState(false);
  const draft = drafts[participantId] ?? returnDraft(plan, participantId);
  const previous = returns.get(participantId);
  const selectedAgency = plan.participants.find(party => party.id === participantId);
  const updateDraft = (patch: Partial<ReturnDraft>) => setDrafts(current => ({
    ...current,
    [participantId]: { ...(current[participantId] ?? returnDraft(plan, participantId)), ...patch },
  }));
  const updateLine = (lineId: string, patch: Partial<SubmissionLine>) => setDrafts(current => {
    const agencyDraft = current[participantId] ?? returnDraft(plan, participantId);
    return { ...current, [participantId]: { ...agencyDraft, lines: agencyDraft.lines.map(line => line.lineId === lineId ? { ...line, ...patch } : line) } };
  });

  return <ActionForm submit={previous ? "Save revised return" : "Record stakeholder return"} onCancel={onCancel} disabled={!participantId || !draft.evidenceIds.length || uploading} onSubmit={() => onSave({ ...draft, participantId, observedAt: new Date(draft.observedAt).toISOString() })}>
    <div className="measurement-section-head"><div><h3>Agency measurement entry</h3><p>Record the selected agency’s independent measurement. The owner’s declaration is shown separately for comparison; NPA reconciliation follows the agency readings.</p></div></div>
    <div className="measurement-form-grid">
      <FormField label="Reporting agency"><select required disabled={uploading} value={participantId} onChange={event => setParticipantId(event.target.value)}>{plan.participants.map(party => <option key={party.id} value={party.id}>{party.name} · {party.role}</option>)}</select></FormField>
      <dl className="measurement-entry-identity">
        <div><dt>Selected agency</dt><dd>{selectedAgency?.name ?? "Choose an agency"}<small>{selectedAgency?.role}</small></dd></div>
        <div><dt>Entered by</dt><dd>{user?.name ?? "Signed-in user"}<small>{user?.role}</small></dd></div>
      </dl>
    </div>
    <p className="measurement-help">Your staff identity is retained as the recorder. Selecting an agency identifies the source of this return.</p>
    <div className="measurement-notice" role="status">{previous ? `Revising ${selectedAgency?.name} return v${previous.revision}. Previous figures and evidence are loaded; the original stays in history.` : `New return for ${selectedAgency?.name ?? "the selected agency"}. No readings have been copied from another agency.`} Unsaved entries stay with each agency while this form is open.</div>
    <div className="measurement-form-grid">
      <FormField label="Observed at"><input required type="datetime-local" value={draft.observedAt} onChange={event => updateDraft({ observedAt: event.target.value })} /></FormField>
      <FormField label="Source document reference"><input required value={draft.sourceReference} onChange={event => updateDraft({ sourceReference: event.target.value })} /></FormField>
      {previous && <FormField label="Reason for revision" hint={`Revision ${previous.revision} remains in the history.`}><input required value={draft.reason} onChange={event => updateDraft({ reason: event.target.value })} /></FormField>}
    </div>
    <p className="measurement-help">Enter 0 for an explicit NIL reading. Blank means unknown and cannot be submitted as reported. Use N/A only with a reason.</p>
    <div className="measurement-table-wrap" role="region" aria-label="Agency measurement entry sheet" tabIndex={0}>
      <table className="measurement-table measurement-entry-sheet">
        <caption className="hide-sr">{selectedAgency?.name ?? "Agency"} independent measurements against the owner declaration</caption>
        <thead><tr><th scope="col">Cargo scope / type</th><th scope="col">Owner declaration<small>Owner-provided baseline</small></th><th scope="col">Agency’s measured quantity</th><th scope="col">Status</th><th scope="col">Difference vs owner declaration</th><th scope="col">Note</th></tr></thead>
        <tbody>{draft.lines.map(entry => {
          const cargo = plan.lines.find(line => line.id === entry.lineId)!;
          const label = cargoInputLabel(cargo, plan.lines);
          const notApplicable = entry.status === "not-applicable";
          const unknown = entry.quantity == null || entry.quantity === "";
          return <tr key={entry.lineId}>
            <th scope="row"><h3>{label} <span className="muted">· {cargo.unit}</span></h3><small>{cargo.category === "Liquid" ? "Tanker / liquid cargo" : cargo.category} · {cargoScopeLabel(cargo)} · {cargo.basis}</small></th>
            <td data-label="Owner declaration"><strong>{readingQuantity(cargo.manifestQuantity)}</strong><small>{cargo.unit} · {cargo.baselineReference || "No reference"}</small></td>
            <td data-label="Agency’s measured quantity"><div className="measurement-cell-field"><FormField label={`Reported quantity · ${label}`}><input required={!notApplicable} disabled={notApplicable} type="number" min="0" step={cargo.unit === "count" ? "1" : "0.001"} value={entry.quantity ?? ""} onChange={event => updateLine(entry.lineId, { quantity: event.target.value === "" ? null : event.target.value })} /></FormField></div><small className="measurement-reading-state">{notApplicable ? "N/A · no quantity" : unknown ? "Unknown · enter a reading" : readingQuantity(entry.quantity) === "NIL (0)" ? "NIL · explicit zero" : cargo.unit}</small></td>
            <td data-label="Status"><div className="measurement-cell-field"><FormField label={`Report status · ${label}`}><select value={entry.status} onChange={event => updateLine(entry.lineId, { status: event.target.value as SubmissionLine["status"], quantity: null })}><option value="reported">Reported</option><option value="not-applicable">N/A</option></select></FormField></div></td>
            <td data-label="Difference vs owner declaration"><span className={notApplicable || unknown || cargo.manifestQuantity == null ? "measurement-missing" : "measurement-difference"}>{readingDifference(entry.quantity, cargo.manifestQuantity, notApplicable)}</span>{!notApplicable && !unknown && cargo.manifestQuantity != null && <small>{cargo.unit}</small>}</td>
            <td data-label="Note"><div className="measurement-cell-field"><FormField label={`Line note · ${label}`}><input required={notApplicable} placeholder={notApplicable ? "Why is this not applicable?" : "Optional note"} value={entry.note} onChange={event => updateLine(entry.lineId, { note: event.target.value })} /></FormField></div></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <FormField label="Return notes (optional)"><textarea value={draft.notes} onChange={event => updateDraft({ notes: event.target.value })} /></FormField>
    <EvidencePicker plan={plan} value={draft.evidenceIds} onChange={evidenceIds => updateDraft({ evidenceIds })} onBusyChange={setUploading} />
    {!draft.evidenceIds.length && <p className="measurement-help">At least one source file is required.</p>}
  </ActionForm>;
}

export function ProposalForm({ plan, onSave, onCancel }: FormProps<ReconciliationInput>) {
  const previous = latestReconciliation(plan);
  const returns = latestReturns(plan);
  const [reason, setReason] = useState("");
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [lines, setLines] = useState(plan.lines.map(line => ({ lineId: line.id, quantity: previous?.lines.find(entry => entry.lineId === line.id)?.quantity ?? "", reason: "" })));
  return <ActionForm submit={previous ? "Create revised proposal" : "Create reconciliation proposal"} disabled={uploading} onCancel={onCancel} onSubmit={() => onSave({ reason, evidenceIds, lines })}>
    <div className="measurement-section-head"><div><h3>NPA reconciliation review</h3><p>After the required agency readings are received, compare them with the owner’s declaration and record the proposed reconciled quantity and rationale.</p></div></div>
    <div className="measurement-notice">This proposal does not change any agency return. Agreement and independent final approval are recorded separately. A new proposal requires fresh acknowledgements for this exact version.</div>
    <FormField label={previous ? "Reason for new version" : "Reconciliation rationale"}><textarea required value={reason} onChange={event => setReason(event.target.value)} /></FormField>
    {lines.map((entry, index) => {
      const cargo = plan.lines[index]; const label = cargoInputLabel(cargo, plan.lines);
      return <div className="measurement-editor-row" key={entry.lineId}>
        <h3>{label} · {cargo.unit}</h3><p className="measurement-help">{cargo.category === "Liquid" ? "Tanker / liquid cargo" : cargo.category} · {cargoScopeLabel(cargo)} · {cargo.basis} · Owner declaration: {readingQuantity(cargo.manifestQuantity)} {cargo.unit}</p>
        <div className="measurement-table-wrap" role="region" aria-label={`Agency readings · ${label}`} tabIndex={0}>
          <table className="measurement-table measurement-proposal-readings"><caption className="hide-sr">Latest agency readings for {label}</caption>
            <thead><tr><th scope="col">Agency / role</th><th scope="col">Agency’s measured quantity</th><th scope="col">Difference vs owner declaration</th><th scope="col">Source / note</th></tr></thead>
            <tbody>{plan.participants.map(party => {
              const submission = returns.get(party.id);
              const reading = submission?.lines.find(line => line.lineId === cargo.id);
              return <tr key={party.id}>
                <th scope="row">{party.name}<small>{party.role}</small></th>
                <td>{!submission ? "Awaiting return" : !reading ? "Not reported" : reading.status === "not-applicable" ? "N/A" : readingLabel(reading.quantity)}<small>{reading?.status === "reported" && reading.quantity != null ? cargo.unit : ""}</small></td>
                <td>{readingDifference(reading?.quantity, cargo.manifestQuantity, reading?.status === "not-applicable")}</td>
                <td>{submission ? <>v{submission.revision} · {submission.sourceReference}<small>{reading?.note || "No line note"}</small></> : "No source received"}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        <div className="measurement-form-grid"><FormField label={`Proposed quantity · ${label}`}><input required type="number" min="0" step={cargo.unit === "count" ? "1" : "0.001"} value={entry.quantity} onChange={event => setLines(current => current.map((line, i) => i === index ? { ...line, quantity: event.target.value } : line))} /></FormField><FormField label={`Decision rationale · ${label}`}><textarea required value={entry.reason} onChange={event => setLines(current => current.map((line, i) => i === index ? { ...line, reason: event.target.value } : line))} /></FormField></div>
      </div>;
    })}
    <EvidencePicker plan={plan} value={evidenceIds} onChange={setEvidenceIds} onBusyChange={setUploading} />
  </ActionForm>;
}

export function ApprovalForm({ plan, reconciliation, onSave, onCancel }: FormProps<ApprovalInput> & { reconciliation: Reconciliation }) {
  const [participantId, setParticipantId] = useState(plan.participants.find(party => !reconciliation.approvals.some(approval => approval.participantId === party.id))?.id ?? plan.participants[0]?.id ?? "");
  const [decision, setDecision] = useState<ApprovalInput["decision"]>("agreed");
  const [representative, setRepresentative] = useState(plan.participants.find(p => p.id === participantId)?.representative ?? "");
  const [reference, setReference] = useState("");
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  return <ActionForm submit="Record paper acknowledgement" onCancel={onCancel} disabled={!evidenceIds.length || uploading} onSubmit={() => onSave({ participantId, decision, representative, reference, evidenceIds })}>
    <div className="measurement-notice">You are recording a paper acknowledgement for reconciliation v{reconciliation.revision}. The signed document and named representative will be retained with your staff record.</div>
    <div className="measurement-form-grid"><FormField label="Acknowledging stakeholder"><select required value={participantId} onChange={event => { setParticipantId(event.target.value); setRepresentative(plan.participants.find(p => p.id === event.target.value)?.representative ?? ""); }}>{plan.participants.map(party => <option value={party.id} key={party.id}>{party.name} · {party.role}</option>)}</select></FormField><FormField label="Decision"><select value={decision} onChange={event => setDecision(event.target.value as ApprovalInput["decision"])}><option value="agreed">Agreed</option><option value="disputed">Disputed</option></select></FormField><FormField label="Signing representative"><input required value={representative} onChange={event => setRepresentative(event.target.value)} /></FormField><FormField label="Signed document reference / date"><input required value={reference} onChange={event => setReference(event.target.value)} /></FormField></div><EvidencePicker plan={plan} value={evidenceIds} onChange={setEvidenceIds} onBusyChange={setUploading} />
  </ActionForm>;
}

export function AssessmentForm({ plan, reconciliation, onSave, onCancel }: FormProps<AssessmentInput> & { reconciliation: Reconciliation }) {
  const issued = [...plan.assessments].reverse().find(assessment => assessment.status === "issued");
  const [policy, setPolicy] = useState<BillingPolicy | "">(issued?.policy ?? "");
  const [payer, setPayer] = useState(issued?.payer ?? "");
  const [tariffReference, setTariffReference] = useState(issued?.tariffReference ?? "");
  const [openingChargesReference, setOpeningChargesReference] = useState(issued?.openingChargesReference ?? "");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [lines, setLines] = useState<AssessmentLineInput[]>(plan.lines.map(line => {
    const prior = issued?.lines.find(entry => entry.lineId === line.id);
    return { lineId: line.id, rate: prior?.rate ?? "", tolerance: prior?.tolerance ?? "", toleranceMode: prior?.toleranceMode ?? "threshold", previouslyBilledQuantity: prior?.previouslyBilledQuantity ?? (issued?.policy === "quantity-adjustment" ? prior?.baselineQuantity ?? null : null), openingBilledAmount: prior?.openingBilledAmount ?? "" };
  }));
  const update = (index: number, patch: Partial<AssessmentLineInput>) => setLines(current => current.map((line, i) => i === index ? { ...line, ...patch } : line));
  const missingManifest = policy === "manifest-disparity" && plan.lines.some(line => line.manifestQuantity === null);
  return <ActionForm submit="Calculate and save assessment" onCancel={onCancel} disabled={!policy || !confirmed || missingManifest} onSubmit={() => onSave({ reconciliationId: reconciliation.id, policy: policy as BillingPolicy, payer, currency: "USD", tariffReference, reason, openingChargesReference, lines })}>
    <div className="measurement-notice">Finance must verify the tariff, comparison baseline and prior charges for this scope. The server calculates a saved assessment before any invoice is issued. Charges use USD.</div>
    {issued && <div className="measurement-notice">An earlier invoice uses this plan’s billing configuration. The same policy, rates, tolerances and opening position are retained for amendments.</div>}
    <div className="measurement-form-grid"><FormField label="Billing policy"><select required value={policy} disabled={Boolean(issued)} onChange={event => setPolicy(event.target.value as BillingPolicy)}><option value="">Choose the approved billing policy</option><option value="manifest-disparity">Excess over manifest quantity</option><option value="quantity-adjustment">Adjustment above previously billed quantity</option></select></FormField><FormField label="Payer"><input required disabled={Boolean(issued)} value={payer} onChange={event => setPayer(event.target.value)} /></FormField><FormField label="Approved tariff / rate reference"><input required value={tariffReference} disabled={Boolean(issued)} onChange={event => setTariffReference(event.target.value)} /></FormField><FormField label="Verified opening charges reference" hint="Enter the prior charge documents, or explicitly enter ‘No prior cargo charges’."><input required value={openingChargesReference} disabled={Boolean(issued)} onChange={event => setOpeningChargesReference(event.target.value)} /></FormField></div>
    {missingManifest && <div role="alert" className="measurement-notice error">A manifest quantity is missing. This policy cannot be assessed until the baseline is established.</div>}
    {lines.map((entry, index) => { const cargo = plan.lines[index]; const label = cargoInputLabel(cargo, plan.lines); const final = reconciliation.lines.find(line => line.lineId === cargo.id); return <div className="measurement-editor-row" key={entry.lineId}><h3>{label} · {cargo.unit}</h3><p className="measurement-help">{cargoScopeLabel(cargo)} · Final quantity: {quantity(final?.quantity)} · Manifest: {quantity(cargo.manifestQuantity)} · {cargo.basis}</p><div className="measurement-form-grid">
      {policy === "quantity-adjustment" && <FormField label={`Previously billed quantity · ${label}`} hint="Use verified cargo quantities for this same scope."><input required type="number" min="0" step={cargo.unit === "count" ? "1" : "0.001"} disabled={Boolean(issued)} value={entry.previouslyBilledQuantity ?? ""} onChange={event => update(index, { previouslyBilledQuantity: event.target.value || null })} /></FormField>}
      <FormField label={`USD rate per ${cargo.unit} · ${label}`}><input required type="number" min="0" step="0.0001" disabled={Boolean(issued)} value={entry.rate} onChange={event => update(index, { rate: event.target.value })} /></FormField><FormField label={`Tolerance (${cargo.unit}) · ${label}`}><input required type="number" min="0" step={cargo.unit === "count" ? "1" : "0.001"} disabled={Boolean(issued)} value={entry.tolerance} onChange={event => update(index, { tolerance: event.target.value })} /></FormField>
      <FormField label={`Tolerance treatment · ${label}`}><select disabled={Boolean(issued)} value={entry.toleranceMode} onChange={event => update(index, { toleranceMode: event.target.value as AssessmentLineInput["toleranceMode"] })}><option value="threshold">Threshold: charge full excess when exceeded</option><option value="deductible">Deductible: charge excess above tolerance</option></select></FormField><FormField label={`Opening amount already charged (USD) · ${label}`} hint="External charges for this additional charge scope only. Enter 0 when verified none."><input required type="number" min="0" step="0.01" disabled={Boolean(issued)} value={entry.openingBilledAmount} onChange={event => update(index, { openingBilledAmount: event.target.value })} /></FormField></div></div>; })}
    <FormField label="Assessment rationale"><textarea required value={reason} onChange={event => setReason(event.target.value)} /></FormField><label className="measurement-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I have verified the tariff, baseline and opening billing position for this cargo scope.</label>
  </ActionForm>;
}
