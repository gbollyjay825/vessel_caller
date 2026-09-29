export type QuantityUnit = "tonnes" | "count" | "m3";
export interface Actor { id: string; name: string }
export interface ParticipantInput { name: string; role: string; representative: string; requiredSubmission: boolean; requiredApproval: boolean }
export interface Participant extends ParticipantInput { id: string }
export interface CargoLineInput { description: string; category: string; direction: string; containerSize: string; loadStatus: string; unit: QuantityUnit; basis: string; manifestQuantity: string | null; baselineReference: string }
export interface CargoLine extends CargoLineInput { id: string }
export interface Evidence { id: string; fileName: string; contentType: string; size: number; checksum: string; createdAt: string }
export interface SubmissionLine { lineId: string; status: "reported" | "not-applicable"; quantity: string | null; note: string }
export interface SubmissionInput { participantId: string; observedAt: string; sourceReference: string; notes: string; reason: string; lines: SubmissionLine[]; evidenceIds: string[] }
export interface Submission extends SubmissionInput { id: string; revision: number; recordedBy: Actor; recordedAt: string }
export interface ReconciliationInput { reason: string; lines: { lineId: string; quantity: string; reason: string }[]; evidenceIds: string[] }
export interface ApprovalInput { participantId: string; decision: "agreed" | "disputed"; representative: string; reference: string; evidenceIds: string[] }
export interface Approval extends ApprovalInput { id: string; recordedBy: Actor; recordedAt: string }
export interface Reconciliation extends ReconciliationInput { id: string; revision: number; status: "draft" | "final" | "superseded"; createdBy: Actor; createdAt: string; finalizedBy: Actor | null; finalizedAt: string | null; submissionIds: string[]; approvals: Approval[]; lines: { lineId: string; quantity: string; manifestQuantity: string | null; variance: string | null; reason: string }[]; stale?: boolean }
export type BillingPolicy = "manifest-disparity" | "quantity-adjustment";
export interface AssessmentLineInput { lineId: string; rate: string; tolerance: string; toleranceMode: "threshold" | "deductible"; previouslyBilledQuantity: string | null; openingBilledAmount: string }
export interface AssessmentInput { reconciliationId: string; payer: string; currency: "USD"; policy: BillingPolicy; tariffReference: string; reason: string; openingChargesReference: string; lines: AssessmentLineInput[] }
export interface AssessmentLine extends AssessmentLineInput { category?: string; direction?: string; containerSize?: string; loadStatus?: string; basis?: string; description: string; unit: QuantityUnit; baselineQuantity: string; finalQuantity: string; variance: string; chargeableQuantity: string; entitlement: string; priorInvoicedAmount: string; amount: string }
export interface Assessment extends Omit<AssessmentInput, "lines"> { id: string; superseded?: boolean; status: "ready" | "no-charge" | "held" | "issued" | "superseded"; total: string; lines: AssessmentLine[]; invoiceId: string | null; createdAt: string }
export interface PlanInput { callId: string; title: string; scheduledAt: string; endsAt: string | null; location: string; method: string; stage: string; scope: string; leadSurveyor: string; notes: string; participants: ParticipantInput[]; lines: CargoLineInput[] }
export interface MeasurementPlan extends Omit<PlanInput, "participants" | "lines"> { id: string; vesselName: string; callReference: string; version: number; status: "scheduled" | "in-progress" | "reconciled" | "cancelled"; createdBy: Actor; participants: Participant[]; lines: CargoLine[]; submissions: Submission[]; reconciliations: Reconciliation[]; assessments: Assessment[]; evidence: Evidence[] }
export interface PlanMutation { plan: MeasurementPlan; rev: number }
