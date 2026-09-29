import { useState } from "react";
import { ActionForm, EvidencePicker, FormField } from "./shared";
import { latestReconciliation, latestReturns, localDateTime, quantity } from "./helpers";
import type { ApprovalInput, AssessmentInput, AssessmentLineInput, BillingPolicy, MeasurementPlan, Reconciliation, ReconciliationInput, SubmissionInput, SubmissionLine } from "./types";

interface FormProps<T> { plan: MeasurementPlan; onSave: (value: T) => Promise<unknown>; onCancel: () => void }
export function ReturnForm({ plan, onSave, onCancel }: FormProps<SubmissionInput>) {
  const returns = latestReturns(plan);
  const [participantId, setParticipantId] = useState(plan.participants.find(party => !returns.has(party.id))?.id ?? plan.participants[0]?.id ?? "");
  const [observedAt, setObservedAt] = useState(localDateTime());
  const [sourceReference, setSourceReference] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [lines, setLines] = useState<SubmissionLine[]>(plan.lines.map(line => ({ lineId: line.id, status: "reported", quantity: null, note: "" })));
  const previous = returns.get(participantId);
  const update = (index: number, patch: Partial<SubmissionLine>) => setLines(current => current.map((line, i) => i === index ? { ...line, ...patch } : line));
  return <ActionForm submit={previous ? "Save revised return" : "Record stakeholder return"} onCancel={onCancel} disabled={!evidenceIds.length || uploading} onSubmit={() => onSave({ participantId, observedAt: new Date(observedAt).toISOString(), sourceReference, reason, notes, evidenceIds, lines })}>
    <div className="measurement-notice">Record the party’s reported figures exactly as received. This entry records a received return; stakeholder agreement is captured separately.</div>
    <div className="measurement-form-grid"><FormField label="Reporting stakeholder"><select required value={participantId} onChange={event => setParticipantId(event.target.value)}>{plan.participants.map(party => <option key={party.id} value={party.id}>{party.name} · {party.role}</option>)}</select></FormField><FormField label="Observed at"><input required type="datetime-local" value={observedAt} onChange={event => setObservedAt(event.target.value)} /></FormField><FormField label="Source document reference"><input required value={sourceReference} onChange={event => setSourceReference(event.target.value)} /></FormField>{previous && <FormField label="Reason for revision" hint={`Revision ${previous.revision} remains in the history.`}><input required value={reason} onChange={event => setReason(event.target.value)} /></FormField>}</div>
    {lines.map((entry, index) => { const cargo = plan.lines[index]; return <div className="measurement-editor-row" key={entry.lineId}><h3>{cargo.description} <span className="muted">· {cargo.unit}</span></h3><p className="measurement-help">{cargo.direction} · {cargo.basis}</p><div className="measurement-form-grid"><FormField label={`Report status · ${cargo.description}`}><select value={entry.status} onChange={event => update(index, { status: event.target.value as SubmissionLine["status"], quantity: null })}><option value="reported">Reported quantity (including NIL)</option><option value="not-applicable">Not applicable</option></select></FormField><FormField label={`Reported quantity · ${cargo.description}`}><input required={entry.status === "reported"} disabled={entry.status === "not-applicable"} type="number" min="0" step={cargo.unit === "count" ? "1" : "0.001"} value={entry.quantity ?? ""} onChange={event => update(index, { quantity: event.target.value === "" ? null : event.target.value })} /></FormField><FormField label={`Line note · ${cargo.description}`}><input required={entry.status === "not-applicable"} value={entry.note} onChange={event => update(index, { note: event.target.value })} /></FormField></div></div>; })}
    <FormField label="Return notes (optional)"><textarea value={notes} onChange={event => setNotes(event.target.value)} /></FormField><EvidencePicker plan={plan} value={evidenceIds} onChange={setEvidenceIds} onBusyChange={setUploading} />{!evidenceIds.length && <p className="measurement-help">At least one source file is required.</p>}
  </ActionForm>;
}

export function ProposalForm({ plan, onSave, onCancel }: FormProps<ReconciliationInput>) {
  const previous = latestReconciliation(plan);
  const [reason, setReason] = useState("");
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [lines, setLines] = useState(plan.lines.map(line => ({ lineId: line.id, quantity: previous?.lines.find(entry => entry.lineId === line.id)?.quantity ?? "", reason: "" })));
  return <ActionForm submit={previous ? "Create revised proposal" : "Create reconciliation proposal"} disabled={uploading} onCancel={onCancel} onSubmit={() => onSave({ reason, evidenceIds, lines })}>
    <div className="measurement-notice">Enter an agreed proposal for every cargo line and explain the decision. A new proposal requires fresh acknowledgements for this exact version.</div>
    <FormField label={previous ? "Reason for new version" : "Reconciliation rationale"}><textarea required value={reason} onChange={event => setReason(event.target.value)} /></FormField>
    {lines.map((entry, index) => { const cargo = plan.lines[index]; return <div className="measurement-editor-row" key={entry.lineId}><h3>{cargo.description} · {cargo.unit}</h3><p className="measurement-help">Manifest: {quantity(cargo.manifestQuantity)} · {cargo.basis}</p><div className="measurement-form-grid"><FormField label={`Proposed quantity · ${cargo.description}`}><input required type="number" min="0" step={cargo.unit === "count" ? "1" : "0.001"} value={entry.quantity} onChange={event => setLines(current => current.map((line, i) => i === index ? { ...line, quantity: event.target.value } : line))} /></FormField><FormField label={`Decision rationale · ${cargo.description}`}><textarea required value={entry.reason} onChange={event => setLines(current => current.map((line, i) => i === index ? { ...line, reason: event.target.value } : line))} /></FormField></div></div>; })}
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
    {lines.map((entry, index) => { const cargo = plan.lines[index]; const final = reconciliation.lines.find(line => line.lineId === cargo.id); return <div className="measurement-editor-row" key={entry.lineId}><h3>{cargo.description} · {cargo.unit}</h3><p className="measurement-help">Final quantity: {quantity(final?.quantity)} · Manifest: {quantity(cargo.manifestQuantity)}</p><div className="measurement-form-grid">
      {policy === "quantity-adjustment" && <FormField label={`Previously billed quantity · ${cargo.description}`} hint="Use verified cargo quantities for this same scope."><input required type="number" min="0" step={cargo.unit === "count" ? "1" : "0.001"} disabled={Boolean(issued)} value={entry.previouslyBilledQuantity ?? ""} onChange={event => update(index, { previouslyBilledQuantity: event.target.value || null })} /></FormField>}
      <FormField label={`USD rate per ${cargo.unit} · ${cargo.description}`}><input required type="number" min="0" step="0.0001" disabled={Boolean(issued)} value={entry.rate} onChange={event => update(index, { rate: event.target.value })} /></FormField><FormField label={`Tolerance (${cargo.unit}) · ${cargo.description}`}><input required type="number" min="0" step={cargo.unit === "count" ? "1" : "0.001"} disabled={Boolean(issued)} value={entry.tolerance} onChange={event => update(index, { tolerance: event.target.value })} /></FormField>
      <FormField label={`Tolerance treatment · ${cargo.description}`}><select disabled={Boolean(issued)} value={entry.toleranceMode} onChange={event => update(index, { toleranceMode: event.target.value as AssessmentLineInput["toleranceMode"] })}><option value="threshold">Threshold: charge full excess when exceeded</option><option value="deductible">Deductible: charge excess above tolerance</option></select></FormField><FormField label={`Opening amount already charged (USD) · ${cargo.description}`} hint="External charges for this additional charge scope only. Enter 0 when verified none."><input required type="number" min="0" step="0.01" disabled={Boolean(issued)} value={entry.openingBilledAmount} onChange={event => update(index, { openingBilledAmount: event.target.value })} /></FormField></div></div>; })}
    <FormField label="Assessment rationale"><textarea required value={reason} onChange={event => setReason(event.target.value)} /></FormField><label className="measurement-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I have verified the tariff, baseline and opening billing position for this cargo scope.</label>
  </ActionForm>;
}
