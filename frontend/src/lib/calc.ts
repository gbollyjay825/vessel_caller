// Client-side dues/commission preview — mirrors the backend maths so the UI
// can show figures before submitting. The server is authoritative at issue time.
import type { Inspection, Jetty, Settings } from "../types";

export function rateForInspection(
  insp: Pick<Inspection, "cargoType" | "jetty"> | null,
  settings: Settings,
): number | null {
  if (!insp) return null;
  if (insp.cargoType === "Dry") return settings.dryDuesRate;
  const j: Jetty = insp.jetty || ({} as Jetty);
  if (j.type === "International") return settings.liquidDuesRates.international;
  if (j.type === "Local" && j.category === "Government") return settings.liquidDuesRates.government;
  if (j.type === "Local" && j.category === "Private") return settings.liquidDuesRates.private;
  return null;
}

export function calcDues(netTonnage: number, rate: number | null): number {
  if (!rate || rate <= 0) return 0;
  return Math.round((Number(netTonnage) || 0) * rate * 100) / 100;
}

export function calcCommission(dues: number, settings: Settings): { usd: number; ngn: number } {
  const usd = Math.round(dues * (settings.commissionRate / 100) * 100) / 100;
  const ngn = Math.round(usd * settings.exchangeRate);
  return { usd, ngn };
}

export function calcPreview(netTonnage: number, rate: number | null, settings: Settings) {
  const dues = calcDues(netTonnage, rate);
  const c = calcCommission(dues, settings);
  return { dues, rate, commissionUsd: c.usd, commissionNgn: c.ngn };
}
