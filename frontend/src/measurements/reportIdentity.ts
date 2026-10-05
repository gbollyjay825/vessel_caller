import { dateLabel } from "./helpers";
import type { MeasurementPlan } from "./types";

type SheetIdentity = Pick<MeasurementPlan, "id" | "callId" | "title" | "scope" | "scheduledAt" | "location">;
const normalized = (value: string) => value.trim().replace(/\s+/g, " ").normalize("NFKC").toLowerCase();

export function reportIdentity(plan: SheetIdentity, sheets: SheetIdentity[]): string {
  const repeated = sheets.filter(other => other.id !== plan.id && other.callId === plan.callId
    && normalized(other.title) === normalized(plan.title) && normalized(other.scope) === normalized(plan.scope));
  let reference = "";
  if (repeated.length) {
    let length = Math.min(8, plan.id.length);
    while (length < plan.id.length && repeated.some(other => other.id.startsWith(plan.id.slice(0, length)))) length += 1;
    reference = `Sheet ${plan.id.slice(0, length)}`;
  }
  return [plan.scheduledAt ? `Scheduled ${dateLabel(plan.scheduledAt)}` : "", plan.location.trim(), reference].filter(Boolean).join(" · ");
}
