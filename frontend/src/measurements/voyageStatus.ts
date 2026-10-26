// One place that decides where a voyage stands, so the dashboard, voyage list,
// vessel history and voyage stepper always agree.
import type { VesselCall } from "../types";
import { readingQuantity, quantityDifference } from "./comparison";
import { currentReport, pendingReport, reconciliationIssues, returnedReport, type ApprovedReport, type CloseoutRecord, type PaidDeclaration, type PreviewInvoice, type PreviewReport } from "./closeoutPreview";
import { latestReturns } from "./helpers";
import type { CargoLine, MeasurementPlan } from "./types";

export type VoyageStage = "declaration" | "collecting" | "ready" | "returned" | "approval" | "invoice" | "draft" | "no-charge" | "review" | "held" | "cancelled";
export type VoyageStep = "declaration" | "agencies" | "readings" | "variation-invoice";

export const STAGE_LABELS: Record<VoyageStage, string> = {
  declaration: "Declaration", collecting: "Agency readings", ready: "Ready to reconcile", returned: "Returned for changes",
  approval: "Awaiting approval", invoice: "Invoice details needed", draft: "Invoice drafted", "no-charge": "No additional charge",
  review: "Overpayment review", held: "Billing on hold", cancelled: "Cancelled",
};
// Chip tone: amber = additional load / money to act on, blue = below the paid declaration.
export const STAGE_TONES: Record<VoyageStage, "neutral" | "green" | "amber" | "blue" | "red"> = {
  declaration: "neutral", collecting: "neutral", ready: "green", returned: "amber", approval: "green", invoice: "amber",
  draft: "amber", "no-charge": "green", review: "blue", held: "amber", cancelled: "red",
};

export const voyagePath = (callId: string, step: VoyageStep) => `/app/measurements/voyages/${encodeURIComponent(callId)}/${step}`;

export interface VoyageSummary {
  callId: string;
  call?: VesselCall;
  vesselName: string;
  reference: string;
  arrival: string;
  plans: MeasurementPlan[];
  allPlans: MeasurementPlan[];
  stage: VoyageStage;
  received: number;
  expected: number;
  pendingAgencies: string[];
  missingDeclarations: string[];
  lineCount: number;
  differingLines: number;
  report?: ApprovedReport;
  pending?: PreviewReport;
  returned?: PreviewReport;
  invoice?: PreviewInvoice;
  declaration?: PaidDeclaration;
  lastActivityAt: string | null;
}

const validQuantity = (value: string | null) => value !== null && /^\d{1,15}(?:\.\d{1,6})?$/.test(value.trim());

/** True when a submitted reading for this line differs from the declared quantity. */
export function lineDiffers(plan: MeasurementPlan, line: CargoLine): boolean {
  return [...latestReturns(plan).values()].some(submission => {
    const reading = submission.lines.find(item => item.lineId === line.id);
    return reading?.status === "reported" && quantityDifference(reading.quantity, line.manifestQuantity) !== "0";
  });
}

function latest(values: (string | null | undefined)[]): string | null {
  return values.filter((value): value is string => Boolean(value)).sort((left, right) => (Date.parse(right) || 0) - (Date.parse(left) || 0))[0] ?? null;
}

export function summarizeVoyage(callId: string, call: VesselCall | undefined, allPlans: MeasurementPlan[], record?: CloseoutRecord): VoyageSummary {
  const cancelled = call?.status === "cancelled";
  const plans = allPlans.filter(plan => plan.status !== "cancelled");
  const report = currentReport(plans, record);
  const pending = pendingReport(plans, record);
  const returned = returnedReport(record);
  const invoice = report ? record?.invoices.filter(item => item.reportId === report.id).at(-1) : undefined;
  let received = 0, expected = 0;
  const pendingNames = new Set<string>();
  for (const plan of plans) {
    const readings = latestReturns(plan);
    for (const party of plan.participants) {
      expected++;
      const reading = readings.get(party.id);
      if (reading) received++;
      if (party.requiredSubmission && (!reading || plan.lines.some(line => {
        const row = reading.lines.find(item => item.lineId === line.id);
        return !row || (row.status === "reported" ? !validQuantity(row.quantity) : !row.note.trim());
      }))) pendingNames.add(party.name);
    }
  }
  const lines = plans.flatMap(plan => plan.lines.map(line => ({ plan, line })));
  const missingDeclarations = [...new Set(lines.filter(({ line }) => !validQuantity(line.manifestQuantity)).map(({ line }) => line.description))];
  const stage: VoyageStage = cancelled ? "cancelled"
    : !plans.length || missingDeclarations.length ? "declaration"
    : report ? (invoice?.status === "draft" ? "draft" : invoice?.status === "no-charge" ? "no-charge" : invoice?.status === "overpayment-review" ? "review" : invoice?.status === "held" ? "held" : "invoice")
    : pending ? "approval"
    : reconciliationIssues(plans).length ? "collecting"
    : returned ? "returned"
    : "ready";
  return {
    callId, call, vesselName: call?.vesselName ?? allPlans[0]?.vesselName ?? "Vessel", reference: call?.reference ?? allPlans[0]?.callReference ?? callId,
    arrival: call?.eta ?? "", plans, allPlans, stage, received, expected, pendingAgencies: [...pendingNames], missingDeclarations,
    lineCount: lines.length, differingLines: lines.filter(({ plan, line }) => lineDiffers(plan, line)).length,
    report, pending, returned, invoice: cancelled ? undefined : invoice, declaration: record?.declaration,
    lastActivityAt: latest([
      ...plans.flatMap(plan => plan.submissions.map(submission => submission.recordedAt)),
      ...(record?.events.map(event => event.at) ?? []),
      record?.declaration?.updatedAt,
      ...plans.map(plan => plan.scheduledAt),
      call?.registered,
    ]),
  };
}

export function summarizeVoyages(calls: VesselCall[], plans: MeasurementPlan[], records: CloseoutRecord[]): VoyageSummary[] {
  const byCall = new Map<string, { call?: VesselCall; plans: MeasurementPlan[] }>();
  for (const call of calls) byCall.set(call.id, { call, plans: [] });
  for (const plan of plans) {
    const entry = byCall.get(plan.callId) ?? { plans: [] };
    entry.plans.push(plan); byCall.set(plan.callId, entry);
  }
  const recordByCall = new Map(records.map(record => [record.callId, record]));
  return [...byCall].map(([callId, entry]) => summarizeVoyage(callId, entry.call, entry.plans, recordByCall.get(callId)));
}

const UNIT_WORDS: Record<string, [string, string]> = { container: ["container", "containers"], vehicle: ["vehicle", "vehicles"], item: ["item", "items"] };
/** "783 containers · 12,450.5 t" — declared totals per unit, never converted between units. */
export function declarationTotals(lines: Pick<CargoLine, "category" | "unit" | "manifestQuantity">[]): string {
  const totals = new Map<string, number>();
  for (const line of lines) {
    if (!validQuantity(line.manifestQuantity)) continue;
    const key = line.unit === "count" ? (line.category === "Container" ? "container" : line.category === "Vehicle" ? "vehicle" : "item") : line.unit;
    totals.set(key, (totals.get(key) ?? 0) + Number(line.manifestQuantity));
  }
  return [...totals].map(([key, total]) => {
    const rounded = Math.round(total * 1000) / 1000;
    // A declared zero is a total, not a reading: show "0", never "NIL (0)".
    const value = rounded === 0 ? "0" : readingQuantity(String(rounded));
    if (key === "tonnes") return `${value} t`;
    if (key === "m3") return `${value} m³`;
    const [one, many] = UNIT_WORDS[key];
    return `${value} ${total === 1 ? one : many}`;
  }).join(" · ");
}

export type StepState = "done" | "current" | "todo";
export interface StepStatus { state: StepState; label: string }

function money(currency: string, amount: string) {
  const [whole, fraction = "00"] = amount.split(".");
  return `${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(2, "0")}`;
}

export function voyageSteps(summary: VoyageSummary): Record<VoyageStep, StepStatus> {
  const { stage } = summary;
  const totals = declarationTotals(summary.plans.flatMap(plan => plan.lines));
  const paid = summary.declaration?.paymentStatus === "paid";
  const declaration: StepStatus = !summary.plans.length ? { state: "current", label: "Not started" }
    : summary.missingDeclarations.length ? { state: "current", label: "Quantities missing" }
    : { state: "done", label: `${paid ? "Paid" : "Recorded"}${totals ? ` · ${totals}` : ""}` };
  const agencies: StepStatus = !summary.plans.length ? { state: "todo", label: "Not started" }
    : stage === "collecting" ? { state: "current", label: `${summary.received} of ${summary.expected} submitted` }
    : stage === "declaration" ? { state: "todo", label: `${summary.received} of ${summary.expected} submitted` }
    : { state: "done", label: `${summary.received} of ${summary.expected} submitted` };
  const differing = summary.differingLines === 1 ? "1 line differs" : `${summary.differingLines} lines differ`;
  const readings: StepStatus = stage === "ready" ? { state: "current", label: summary.differingLines ? differing : "All lines agree" }
    : stage === "approval" ? { state: "current", label: "Awaiting approval" }
    : stage === "returned" ? { state: "current", label: "Returned for changes" }
    : summary.report && stage !== "cancelled" ? { state: "done", label: `Approved · v${summary.report.revision}` }
    : { state: "todo", label: "After readings arrive" };
  const invoice = summary.invoice;
  const variation: StepStatus = stage === "invoice" ? { state: "current", label: "Details needed" }
    : stage === "draft" && invoice ? { state: "current", label: `Draft · ${money(invoice.currency, invoice.total)}` }
    : stage === "no-charge" ? { state: "done", label: "No additional charge" }
    : stage === "review" ? { state: "current", label: "Overpayment review" }
    : stage === "held" ? { state: "current", label: "On hold" }
    : { state: "todo", label: "Drafted on approval" };
  return { declaration, agencies, readings, "variation-invoice": variation };
}

/** Where to go to act on a voyage at its current stage. */
export function nextStepPath(summary: VoyageSummary, canCreate = true): string {
  if (summary.stage === "declaration" && !summary.plans.length && canCreate) return `/app/measurements/new?callId=${encodeURIComponent(summary.callId)}`;
  if (summary.stage === "declaration") return voyagePath(summary.callId, "declaration");
  if (summary.stage === "collecting") return voyagePath(summary.callId, "agencies");
  if (["ready", "approval", "returned", "cancelled"].includes(summary.stage)) return voyagePath(summary.callId, "readings");
  return voyagePath(summary.callId, "variation-invoice");
}

/** Whole days since an ISO time, for "waiting 3 days". */
export function daysSince(value: string | null, now = Date.now()): number | null {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? Math.max(0, Math.floor((now - time) / 86_400_000)) : null;
}
