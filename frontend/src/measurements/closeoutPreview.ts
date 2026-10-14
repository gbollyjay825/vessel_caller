import { useCallback, useEffect, useState } from "react";
import { latestReturns } from "./helpers";
import type { Actor, MeasurementPlan, QuantityUnit } from "./types";

export interface PreviewReportLine { planId: string; lineId: string; description: string; unit: QuantityUnit; declaredQuantity: string | null; quantity: string; reason: string }
export interface PreviewReport { id: string; callId: string; revision: number; sourceFingerprint: string; approvedAt: string; approvedBy: Actor; reason: string; lines: PreviewReportLine[]; sourcePlans: MeasurementPlan[] }
export interface PreviewInvoiceLineInput { planId: string; lineId: string; rate: string; previousVariationAmount: string }
export type PreviewInvoiceStatus = "draft" | "no-charge" | "overpayment-review" | "held";
export interface PreviewInvoiceInput { payer: string; currency: "USD" | "NGN"; tariffReference: string; originalInvoiceReference: string; paymentStatus: "paid" | "unconfirmed"; originalPaidAmount: string; previousVariationReference: string; lines: PreviewInvoiceLineInput[] }
export interface PreviewInvoiceLine extends PreviewInvoiceLineInput { description: string; unit: QuantityUnit; declaredQuantity: string; finalQuantity: string; variance: string; amount: string; entitlement: string; status: "charge" | "no-charge" | "overpayment-review" | "held" }
export interface PreviewInvoice extends Omit<PreviewInvoiceInput, "lines"> { id: string; callId: string; number: string; reportId: string; createdAt: string; createdBy: Actor; status: PreviewInvoiceStatus; lines: PreviewInvoiceLine[]; total: string }
export interface PreviewEvent { id: string; callId: string; at: string; actor: Actor; action: "report-approved" | "invoice-drafted" | "no-charge-recorded" | "overpayment-flagged" | "billing-held"; reference: string }
export interface CloseoutRecord { callId: string; reports: PreviewReport[]; invoices: PreviewInvoice[]; events: PreviewEvent[] }
type ApprovalInput = { reason: string; lines: { planId: string; lineId: string; quantity: string; reason: string }[] };
type PreviewState = { key: string | null; records: CloseoutRecord[]; error: string | null };
const CHANGE_EVENT = "vessel-caller:closeout-preview-changed";
export const closeoutStorageKey = (orgId?: string) => orgId?.trim() ? `vessel-caller:closeout-preview:v1:${encodeURIComponent(orgId)}` : null;
const activePlans = (plans: MeasurementPlan[]) => plans.filter(plan => plan.status !== "cancelled").sort((a, b) => a.id.localeCompare(b.id));

/** Exact source identity: changing any declaration, latest reading or server decision invalidates a preview approval. */
export function voyageInputFingerprint(plans: MeasurementPlan[]): string {
  return JSON.stringify(activePlans(plans).map(plan => ({ id: plan.id, callId: plan.callId, version: plan.version, title: plan.title, scope: plan.scope, lines: plan.lines, participants: plan.participants, returns: [...latestReturns(plan).values()].sort((a, b) => a.participantId.localeCompare(b.participantId)), reconciliations: plan.reconciliations })));
}
export function currentReport(plans: MeasurementPlan[], record?: CloseoutRecord): PreviewReport | undefined {
  const report = record?.reports.at(-1);
  return report && report.sourceFingerprint === voyageInputFingerprint(plans) && activePlans(plans).every(plan => plan.callId === report.callId) ? report : undefined;
}

function decimal(value: string | null | undefined, precision: number, maxWhole = 15): bigint | null {
  if (value == null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  if (whole.length > maxWhole || fraction.length > precision) return null;
  return BigInt(whole) * 10n ** BigInt(precision) + BigInt(fraction.padEnd(precision, "0"));
}
function fixed(value: bigint, precision: number): string {
  const sign = value < 0 ? "-" : "";
  const absolute = value < 0 ? -value : value;
  const scale = 10n ** BigInt(precision);
  return `${sign}${absolute / scale}.${(absolute % scale).toString().padStart(precision, "0")}`;
}
const quantityText = (value: bigint) => fixed(value, 6).replace(/\.?0+$/, "");
export function reconciliationIssues(plans: MeasurementPlan[]): string[] {
  const sheets = activePlans(plans);
  if (!sheets.length) return ["Add an owner declaration and agency readings before reconciliation."];
  const issues: string[] = [];
  for (const plan of sheets) {
    if (!plan.lines.length) issues.push(`${plan.title}: no cargo items recorded.`);
    for (const line of plan.lines) if (decimal(line.manifestQuantity, 6) === null) issues.push(`${line.description}: owner declaration is missing or invalid.`);
    const readings = latestReturns(plan);
    for (const party of plan.participants.filter(item => item.requiredSubmission)) {
      const reading = readings.get(party.id);
      if (!reading) { issues.push(`${party.name}: reading not submitted for ${plan.title}.`); continue; }
      for (const line of plan.lines) {
        const row = reading.lines.find(item => item.lineId === line.id);
        if (!row || (row.status === "reported" ? decimal(row.quantity, 6) === null : !row.note.trim())) issues.push(`${party.name}: complete ${line.description} or explain why it is not applicable.`);
      }
    }
  }
  return issues;
}

/** Integer decimal arithmetic avoids binary rounding of quantities, rates and invoice cents. */
export function calculateVariation(report: PreviewReport, inputs: PreviewInvoiceLineInput[]): { lines: PreviewInvoiceLine[]; total: string; status: PreviewInvoiceStatus; issues: string[] } {
  const issues: string[] = [];
  let total = 0n;
  const keys = inputs.map(row => `${row.planId}:${row.lineId}`);
  if (new Set(keys).size !== keys.length || inputs.length !== report.lines.length) issues.push("Enter one rate and previous variation amount for every cargo item.");
  const lines = report.lines.flatMap(row => {
    const input = inputs.find(item => item.planId === row.planId && item.lineId === row.lineId);
    const baseline = decimal(row.declaredQuantity, 6), final = decimal(row.quantity, 6);
    const rate = decimal(input?.rate, 4), previous = decimal(input?.previousVariationAmount, 2);
    if (!input || baseline === null || final === null || rate === null || previous === null) { issues.push(`${row.description}: enter valid declaration, final quantity, rate and previous variation amount.`); return []; }
    const variance = final - baseline;
    const entitlement = variance > 0n ? (variance * rate + 50_000_000n) / 100_000_000n : 0n;
    const amount = entitlement > previous ? entitlement - previous : 0n;
    const status = variance < 0n ? "overpayment-review" : previous > entitlement ? "held" : amount > 0n ? "charge" : "no-charge";
    total += amount;
    return [{ ...input, description: row.description, unit: row.unit, declaredQuantity: row.declaredQuantity!, finalQuantity: row.quantity, variance: quantityText(variance), entitlement: fixed(entitlement, 2), amount: fixed(amount, 2), status } satisfies PreviewInvoiceLine];
  });
  const status: PreviewInvoiceStatus = issues.length || lines.some(line => line.status === "held") ? "held" : lines.some(line => line.status === "overpayment-review") ? "overpayment-review" : total > 0n ? "draft" : "no-charge";
  // An amount requiring review is never presented as an invoice payable.
  return { lines, total: status === "held" || status === "overpayment-review" ? "0.00" : fixed(total, 2), status, issues };
}

function validSourcePlan(plan: MeasurementPlan, callId: string): boolean {
  return plan.callId === callId && typeof plan.id === "string" && typeof plan.title === "string" && typeof plan.scope === "string" && typeof plan.vesselName === "string" && typeof plan.callReference === "string" && Number.isInteger(plan.version)
    && Array.isArray(plan.lines) && plan.lines.every(line => typeof line.id === "string" && typeof line.description === "string" && typeof line.category === "string" && typeof line.direction === "string" && typeof line.basis === "string" && typeof line.containerSize === "string" && typeof line.loadStatus === "string" && typeof line.baselineReference === "string" && ["count", "tonnes", "m3"].includes(line.unit) && decimal(line.manifestQuantity, 6) !== null)
    && Array.isArray(plan.participants) && plan.participants.every(party => typeof party.id === "string" && typeof party.name === "string" && typeof party.role === "string" && typeof party.representative === "string" && typeof party.requiredSubmission === "boolean" && typeof party.requiredApproval === "boolean")
    && Array.isArray(plan.submissions) && plan.submissions.every(submission => typeof submission.id === "string" && typeof submission.participantId === "string" && Number.isInteger(submission.revision) && Array.isArray(submission.lines) && submission.lines.every(line => typeof line.lineId === "string" && typeof line.note === "string" && ["reported", "not-applicable"].includes(line.status) && (line.quantity === null || decimal(line.quantity, 6) !== null)))
    && Array.isArray(plan.reconciliations);
}
function validInvoiceLine(line: PreviewInvoiceLine): boolean {
  return typeof line.planId === "string" && typeof line.lineId === "string" && typeof line.description === "string" && ["count", "tonnes", "m3"].includes(line.unit)
    && decimal(line.declaredQuantity, 6) !== null && decimal(line.finalQuantity, 6) !== null && typeof line.variance === "string" && decimal(line.variance.replace(/^-/, ""), 6) !== null
    && decimal(line.rate, 4) !== null && decimal(line.previousVariationAmount, 2) !== null && decimal(line.amount, 2, 32) !== null && decimal(line.entitlement, 2, 32) !== null
    && ["charge", "no-charge", "overpayment-review", "held"].includes(line.status);
}
function validRecord(value: unknown): value is CloseoutRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as CloseoutRecord;
  return typeof record.callId === "string" && Boolean(record.callId) && Array.isArray(record.reports) && Array.isArray(record.invoices) && Array.isArray(record.events)
    && record.reports.every(report => report.callId === record.callId && typeof report.id === "string" && typeof report.sourceFingerprint === "string" && typeof report.approvedAt === "string" && Number.isInteger(report.revision) && typeof report.reason === "string" && typeof report.approvedBy?.name === "string" && typeof report.approvedBy?.id === "string" && Array.isArray(report.lines) && report.lines.every(line => typeof line.planId === "string" && typeof line.lineId === "string" && typeof line.description === "string" && typeof line.reason === "string" && ["count", "tonnes", "m3"].includes(line.unit) && decimal(line.quantity, 6) !== null && decimal(line.declaredQuantity, 6) !== null) && Array.isArray(report.sourcePlans) && report.sourcePlans.every(plan => validSourcePlan(plan, record.callId)))
    && record.invoices.every(invoice => invoice.callId === record.callId && typeof invoice.id === "string" && typeof invoice.number === "string" && record.reports.some(report => report.id === invoice.reportId) && ["USD", "NGN"].includes(invoice.currency) && ["draft", "no-charge", "held", "overpayment-review"].includes(invoice.status) && decimal(invoice.total, 2, 32) !== null && typeof invoice.createdAt === "string" && typeof invoice.createdBy?.name === "string" && typeof invoice.createdBy?.id === "string" && typeof invoice.payer === "string" && typeof invoice.originalInvoiceReference === "string" && typeof invoice.tariffReference === "string" && typeof invoice.previousVariationReference === "string" && ["paid", "unconfirmed"].includes(invoice.paymentStatus) && (invoice.originalPaidAmount === "" || decimal(invoice.originalPaidAmount, 2) !== null) && Array.isArray(invoice.lines) && invoice.lines.every(validInvoiceLine))
    && record.events.every(event => event.callId === record.callId && typeof event.id === "string" && typeof event.at === "string" && typeof event.actor?.name === "string" && typeof event.actor?.id === "string" && typeof event.reference === "string" && ["report-approved", "invoice-drafted", "no-charge-recorded", "overpayment-flagged", "billing-held"].includes(event.action));
}
function readPreviews(orgId?: string): PreviewState {
  const key = closeoutStorageKey(orgId);
  if (!key) return { key, records: [], error: "Load your organisation before saving a preview." };
  let raw: string | null;
  try { raw = window.localStorage.getItem(key); }
  catch { return { key, records: [], error: "This browser could not read saved previews." }; }
  if (!raw) return { key, records: [], error: null };
  try {
    const data = JSON.parse(raw);
    if (data.version !== 1 || data.organizationId !== orgId || !Array.isArray(data.records) || !data.records.every(validRecord) || new Set(data.records.map((record: CloseoutRecord) => record.callId)).size !== data.records.length) throw new Error();
    return { key, records: data.records, error: null };
  } catch { return { key, records: [], error: "Saved previews could not be read. They have been preserved; changes cannot be saved until the storage issue is resolved." }; }
}

export function useCloseoutPreviews(orgId?: string) {
  const key = closeoutStorageKey(orgId);
  const [state, setState] = useState(() => readPreviews(orgId));
  const current = state.key === key ? state : readPreviews(orgId);
  useEffect(() => {
    const refresh = () => setState(readPreviews(orgId));
    const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) refresh(); };
    const onChange = (event: Event) => { if ((event as CustomEvent<string>).detail === key) refresh(); };
    refresh();
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => { window.removeEventListener("storage", onStorage); window.removeEventListener(CHANGE_EVENT, onChange); };
  }, [key, orgId]);
  return { records: current.records, error: current.error };
}

export function useCloseoutPreview(orgId: string | undefined, callId: string) {
  const previews = useCloseoutPreviews(orgId);
  const [saveError, setSaveError] = useState<{ scope: string; message: string } | null>(null);
  const scope = `${orgId}:${callId}`;
  const record = previews.records.find(item => item.callId === callId) ?? { callId, reports: [], invoices: [], events: [] };
  const mutate = useCallback(<T,>(change: (record: CloseoutRecord) => T): T | null => {
    const state = readPreviews(orgId);
    if (!state.key || state.error || !callId) { setSaveError({ scope, message: state.error ?? "Choose a voyage before saving." }); return null; }
    try {
      const updated = state.records.find(item => item.callId === callId) ?? { callId, reports: [], invoices: [], events: [] };
      const result = change(updated);
      const records = [...state.records.filter(item => item.callId !== callId), updated];
      window.localStorage.setItem(state.key, JSON.stringify({ version: 1, organizationId: orgId, records }));
      setSaveError(null);
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: state.key }));
      return result;
    } catch (error) { setSaveError({ scope, message: error instanceof Error ? error.message : "Preview could not be saved in this browser." }); return null; }
  }, [orgId, callId, scope]);
  const approveReport = (plans: MeasurementPlan[], input: ApprovalInput, actor: Actor) => mutate(saved => {
    const sheets = activePlans(plans);
    const issues = reconciliationIssues(sheets);
    if (sheets.some(plan => plan.callId !== callId)) issues.push("The report contains another voyage.");
    if (issues.length) throw new Error(issues[0]);
    if (!input.reason.trim()) throw new Error("Enter a report reason before approval.");
    const sourceLines = sheets.flatMap(plan => plan.lines.map(line => ({ plan, line })));
    if (input.lines.length !== sourceLines.length || new Set(input.lines.map(line => `${line.planId}:${line.lineId}`)).size !== sourceLines.length) throw new Error("Provide a final reading for every cargo item.");
    const lines = sourceLines.map(({ plan, line }) => {
      const entry = input.lines.find(item => item.planId === plan.id && item.lineId === line.id);
      const value = decimal(entry?.quantity, 3);
      if (!entry || value === null || (line.unit === "count" && value % 1000n !== 0n)) throw new Error(`Enter a valid final quantity for ${line.description}.`);
      if (!entry.reason.trim()) throw new Error(`Enter the decision reason for ${line.description}.`);
      return { ...entry, reason: entry.reason.trim(), description: line.description, unit: line.unit, declaredQuantity: line.manifestQuantity };
    });
    const sourceFingerprint = voyageInputFingerprint(sheets);
    const previous = saved.reports.at(-1);
    if (previous && previous.sourceFingerprint === sourceFingerprint && previous.reason === input.reason.trim() && JSON.stringify(previous.lines) === JSON.stringify(lines)) return previous;
    const report: PreviewReport = { id: crypto.randomUUID(), callId, revision: (previous?.revision ?? 0) + 1, sourceFingerprint, approvedAt: new Date().toISOString(), approvedBy: actor, reason: input.reason.trim(), lines, sourcePlans: JSON.parse(JSON.stringify(sheets)) };
    saved.reports.push(report);
    saved.events.push({ id: crypto.randomUUID(), callId, at: report.approvedAt, actor, action: "report-approved", reference: `Reconciliation v${report.revision}` });
    return report;
  });
  const createInvoice = (plans: MeasurementPlan[], reportId: string, input: PreviewInvoiceInput, actor: Actor) => mutate(saved => {
    const report = currentReport(plans, saved);
    if (!report || report.id !== reportId) throw new Error("Approve a current reconciliation report before creating an invoice preview.");
    if (!input.payer.trim() || !input.originalInvoiceReference.trim() || !input.tariffReference.trim()) throw new Error("Enter the payer, original invoice reference and rate reference.");
    if (input.originalPaidAmount !== "" && decimal(input.originalPaidAmount, 2) === null) throw new Error("Enter a valid original paid amount, or leave it blank if not recorded.");
    if (!["USD", "NGN"].includes(input.currency)) throw new Error("Choose a supported preview currency.");
    const calculation = calculateVariation(report, input.lines);
    if (calculation.issues.length) throw new Error(calculation.issues[0]);
    if (calculation.status === "draft" && input.paymentStatus !== "paid") throw new Error("Record the owner's declaration as paid before creating the variation invoice preview.");
    if (input.lines.some(line => (decimal(line.previousVariationAmount, 2) ?? 0n) > 0n) && !input.previousVariationReference.trim()) throw new Error("Enter a reference for previous variation charges.");
    // A stable input identity also prevents duplicate draft generation after repeated clicks.
    const latest = saved.invoices.at(-1);
    const sameInput = latest && latest.reportId === reportId && latest.payer === input.payer.trim() && latest.currency === input.currency && latest.tariffReference === input.tariffReference && latest.originalInvoiceReference === input.originalInvoiceReference && latest.paymentStatus === input.paymentStatus && latest.originalPaidAmount === input.originalPaidAmount && latest.previousVariationReference === input.previousVariationReference && JSON.stringify(latest.lines) === JSON.stringify(calculation.lines);
    if (sameInput) return latest;
    const invoice: PreviewInvoice = { ...input, payer: input.payer.trim(), lines: calculation.lines, total: calculation.total, status: calculation.status, reportId, callId, id: crypto.randomUUID(), number: `PREVIEW-VAR-${callId.slice(-8).toUpperCase()}-${String(saved.invoices.length + 1).padStart(3, "0")}`, createdAt: new Date().toISOString(), createdBy: actor };
    saved.invoices.push(invoice);
    const action: PreviewEvent["action"] = invoice.status === "draft" ? "invoice-drafted" : invoice.status === "no-charge" ? "no-charge-recorded" : invoice.status === "overpayment-review" ? "overpayment-flagged" : "billing-held";
    saved.events.push({ id: crypto.randomUUID(), callId, at: invoice.createdAt, actor, action, reference: invoice.number });
    return invoice;
  });
  return { record, error: previews.error ?? (saveError?.scope === scope ? saveError.message : null), approveReport, createInvoice };
}
