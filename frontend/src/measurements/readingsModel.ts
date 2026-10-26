// Builds the side-by-side readings report: one row per cargo line, one column
// per agency, every reading compared with the paid declaration.
import { quantityDifference } from "./comparison";
import { latestReturns } from "./helpers";
import { UNIT_LABELS } from "./cargoTemplates";
import type { CargoLine, MeasurementPlan, Participant, Submission } from "./types";

export const AUTO_REASON = "All agency readings match the declaration.";

export interface AgencyColumn { key: string; name: string; role: string }
// Same order as the paper reconciliation sheet.
const ROLE_ORDER = ["agent", "terminal operator", "master", "surveyor", "tally clerk"];
const clean = (value: string) => value.trim().replace(/\s+/g, " ");
const normalized = (value: string) => clean(value).normalize("NFKC").toLowerCase();
export const agencyKey = (party: Pick<Participant, "name" | "role">) => JSON.stringify([normalized(party.name), normalized(party.role)]);

export function agencyColumns(plans: MeasurementPlan[]): AgencyColumn[] {
  const columns = new Map<string, AgencyColumn>();
  for (const plan of plans) for (const party of plan.participants) {
    const key = agencyKey(party);
    if (!columns.has(key)) columns.set(key, { key, name: clean(party.name), role: clean(party.role) });
  }
  const rank = (role: string) => { const index = ROLE_ORDER.indexOf(normalized(role)); return index === -1 ? ROLE_ORDER.length : index; };
  return [...columns.values()].sort((left, right) => rank(left.role) - rank(right.role) || left.name.localeCompare(right.name));
}

export type CellState = "value" | "na" | "awaiting" | "not-submitted" | "not-reported";
export interface ReadingCell { party: Participant; state: CellState; quantity: string | null; note: string; submission?: Submission; difference: string | null }
export interface ReadingOption { quantity: string; parties: string[] }
export interface ReadingRow {
  key: string;
  plan: MeasurementPlan;
  line: CargoLine;
  cells: Map<string, ReadingCell[]>;
  options: ReadingOption[];
  agree: boolean;
  differs: boolean;
  spread: { min: string; max: string; range: string } | null;
}

export const rowKey = (planId: string, lineId: string) => JSON.stringify([planId, lineId]);

/** "20 ft · Laden" for containers, otherwise the declared description. */
export function cargoHeading(line: Pick<CargoLine, "category" | "containerSize" | "loadStatus" | "description">): string {
  if (line.category !== "Container" || !line.containerSize) return line.description;
  const load = line.loadStatus ? line.loadStatus[0].toUpperCase() + line.loadStatus.slice(1) : "";
  return [`${line.containerSize} ft`, load].filter(Boolean).join(" · ");
}
export function cargoContext(line: Pick<CargoLine, "category" | "unit">): string {
  const category = line.category === "Liquid" ? "Tanker / liquid" : line.category === "Container" ? "Containers" : line.category === "Bulk" ? "Dry bulk" : line.category;
  return `${category} · ${UNIT_LABELS[line.unit].toLowerCase()}`;
}

const compare = (left: string, right: string) => {
  const difference = quantityDifference(left, right);
  return difference === null || difference === "0" ? 0 : difference.startsWith("-") ? -1 : 1;
};

export function readingRows(plans: MeasurementPlan[], columns: AgencyColumn[]): ReadingRow[] {
  return plans.flatMap(plan => {
    const returns = latestReturns(plan);
    const cancelled = plan.status === "cancelled";
    return plan.lines.map(line => {
      const cells = new Map<string, ReadingCell[]>();
      const options: ReadingOption[] = [];
      let complete = true;
      for (const column of columns) {
        const parties = plan.participants.filter(party => agencyKey(party) === column.key);
        cells.set(column.key, parties.map(party => {
          const submission = returns.get(party.id);
          const entry = submission?.lines.find(item => item.lineId === line.id);
          if (!submission || !entry) {
            if (party.requiredSubmission) complete = false;
            return { party, state: !submission ? (party.requiredSubmission && !cancelled ? "awaiting" : "not-submitted") : "not-reported", quantity: null, note: "", submission, difference: null };
          }
          if (entry.status === "not-applicable") return { party, state: "na", quantity: null, note: entry.note, submission, difference: null };
          const quantity = entry.quantity;
          if (quantity != null) {
            const option = options.find(item => compare(item.quantity, quantity) === 0);
            if (option) option.parties.push(party.name); else options.push({ quantity, parties: [party.name] });
          }
          return { party, state: "value", quantity, note: entry.note, submission, difference: quantityDifference(quantity, line.manifestQuantity) };
        }));
      }
      const reported = [...cells.values()].flat().filter(cell => cell.state === "value" && cell.quantity != null);
      const differs = reported.some(cell => cell.difference !== null && cell.difference !== "0");
      const sorted = [...options].sort((left, right) => compare(left.quantity, right.quantity));
      const spread = sorted.length ? { min: sorted[0].quantity, max: sorted.at(-1)!.quantity, range: quantityDifference(sorted.at(-1)!.quantity, sorted[0].quantity)?.replace(/^\+/, "") ?? "0" } : null;
      return {
        key: rowKey(plan.id, line.id), plan, line, cells, differs, spread,
        options: options.sort((left, right) => right.parties.length - left.parties.length || compare(right.quantity, left.quantity)),
        agree: complete && reported.length > 0 && !differs && line.manifestQuantity !== null,
      };
    });
  });
}
