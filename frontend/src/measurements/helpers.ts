import type { CargoLine, MeasurementPlan, Reconciliation, Submission } from "./types";

export function latestReturns(plan: MeasurementPlan): Map<string, Submission> {
  const returns = new Map<string, Submission>();
  for (const submission of plan.submissions) {
    if ((returns.get(submission.participantId)?.revision ?? 0) < submission.revision) returns.set(submission.participantId, submission);
  }
  return returns;
}
export function latestReconciliation(plan: MeasurementPlan, status?: Reconciliation["status"]): Reconciliation | undefined {
  return plan.reconciliations.filter(r => !status || r.status === status).reduce<Reconciliation | undefined>((latest, item) => !latest || item.revision > latest.revision ? item : latest, undefined);
}
export function reconciliationStale(plan: MeasurementPlan, recon: Reconciliation): boolean {
  const latest = [...latestReturns(plan).values()].map(s => s.id).sort();
  return Boolean(recon.stale) || latest.join(",") !== [...recon.submissionIds].sort().join(",");
}
export function finalizationIssues(plan: MeasurementPlan, recon: Reconciliation, userId?: string): string[] {
  const issues: string[] = [];
  if (reconciliationStale(plan, recon)) issues.push("Returns changed after this proposal. Create a refreshed proposal before approval.");
  if (recon.createdBy.id === userId) issues.push("An independent Admin must finalize this proposal. You prepared this version.");
  const decisions = new Map(recon.approvals.map(a => [a.participantId, a.decision]));
  for (const party of plan.participants) {
    if (decisions.get(party.id) === "disputed") issues.push(`${party.name} has disputed this version.`);
    else if (party.requiredApproval && decisions.get(party.id) !== "agreed") issues.push(`${party.name} agreement is still required.`);
  }
  return issues;
}
export const quantity = (value: string | null | undefined) => value == null ? "Not provided" : Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 });
export const localDateTime = (value?: string | null) => {
  const date = value ? new Date(value) : new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
export const dateLabel = (value?: string | null) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Not set";


type CargoContext = Pick<CargoLine, "description"> & Partial<Pick<CargoLine, "direction" | "containerSize" | "loadStatus" | "basis">>;
export function cargoScopeLabel(line: CargoContext): string {
  return [line.direction, line.containerSize && `${line.containerSize} ft`, line.loadStatus].filter(Boolean).join(" · ");
}
export function cargoInputLabel(line: CargoLine, lines: CargoLine[]): string {
  const sameDescription = lines.filter(item => item.description === line.description);
  if (!line.containerSize && !line.loadStatus && sameDescription.length === 1) return line.description;
  const scope = cargoScopeLabel(line);
  const repeatedScope = sameDescription.filter(item => cargoScopeLabel(item) === scope).length > 1;
  const label = [line.description, scope].filter(Boolean).join(" · ");
  return repeatedScope ? `${label} · item ${lines.findIndex(item => item.id === line.id) + 1}` : label;
}
export function cargoLabelForId(lines: CargoLine[], lineId: string): string {
  const line = lines.find(item => item.id === lineId);
  return line ? cargoInputLabel(line, lines) : "Cargo item";
}
