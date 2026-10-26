import { useCallback, useEffect, useState } from "react";
import type { Actor, CargoLine, QuantityUnit } from "./types";

// Rates for additional load above a paid declaration, per cargo classification.
export interface TariffRateDefinition { key: string; group: string; label: string; unit: QuantityUnit; per: string }
export const TARIFF_RATES: TariffRateDefinition[] = [
  { key: "container:20:laden", group: "Containers", label: "20 ft laden", unit: "count", per: "Per container" },
  { key: "container:20:empty", group: "Containers", label: "20 ft empty", unit: "count", per: "Per container" },
  { key: "container:40:laden", group: "Containers", label: "40 ft laden", unit: "count", per: "Per container" },
  { key: "container:40:empty", group: "Containers", label: "40 ft empty", unit: "count", per: "Per container" },
  { key: "container:45:laden", group: "Containers", label: "45 ft laden", unit: "count", per: "Per container" },
  { key: "container:45:empty", group: "Containers", label: "45 ft empty", unit: "count", per: "Per container" },
  { key: "liquid:tonnes", group: "Tanker / liquid", label: "By weight", unit: "tonnes", per: "Per tonne" },
  { key: "liquid:m3", group: "Tanker / liquid", label: "By volume", unit: "m3", per: "Per m³" },
  { key: "bulk:tonnes", group: "Dry bulk", label: "By weight", unit: "tonnes", per: "Per tonne" },
  { key: "bulk:m3", group: "Dry bulk", label: "By volume", unit: "m3", per: "Per m³" },
  { key: "general:tonnes", group: "General cargo", label: "By weight", unit: "tonnes", per: "Per tonne" },
  { key: "general:count", group: "General cargo", label: "By item", unit: "count", per: "Per item" },
  { key: "general:m3", group: "General cargo", label: "By volume", unit: "m3", per: "Per m³" },
  { key: "vehicle:count", group: "Vehicles", label: "Vehicles", unit: "count", per: "Per vehicle" },
];

export function tariffKeyFor(line: Pick<CargoLine, "category" | "containerSize" | "loadStatus" | "unit">): string | null {
  if (line.category === "Container") return line.containerSize && line.loadStatus ? `container:${line.containerSize}:${line.loadStatus}` : null;
  if (line.category === "Liquid") return `liquid:${line.unit}`;
  if (line.category === "Bulk") return `bulk:${line.unit}`;
  if (line.category === "General cargo") return `general:${line.unit}`;
  if (line.category === "Vehicle") return "vehicle:count";
  return null;
}

/** "per container", "per tonne": how an invoice rate reads beside its line. */
export function perUnitLabel(unit: QuantityUnit, description = ""): string {
  if (unit === "tonnes") return "per tonne";
  if (unit === "m3") return "per m³";
  if (/container/i.test(description)) return "per container";
  if (/vehicle/i.test(description)) return "per vehicle";
  return "per item";
}

export interface VariationTariffInput { currency: "USD" | "NGN"; reference: string; rates: Record<string, string> }
export interface VariationTariff extends VariationTariffInput { updatedAt: string; updatedBy: Actor }

const CHANGE_EVENT = "vessel-caller:variation-tariff-changed";
export const tariffStorageKey = (orgId?: string) => orgId?.trim() ? `vessel-caller:variation-tariff:v1:${encodeURIComponent(orgId)}` : null;
export const validRate = (value: string) => /^\d{1,11}(?:\.\d{1,4})?$/.test(value.trim());

function validTariff(value: unknown): value is VariationTariff {
  if (!value || typeof value !== "object") return false;
  const tariff = value as VariationTariff;
  return ["USD", "NGN"].includes(tariff.currency) && typeof tariff.reference === "string" && typeof tariff.updatedAt === "string"
    && typeof tariff.updatedBy?.id === "string" && typeof tariff.updatedBy?.name === "string"
    && Boolean(tariff.rates) && typeof tariff.rates === "object" && Object.values(tariff.rates).every(rate => typeof rate === "string" && (rate === "" || validRate(rate)));
}

function readTariff(orgId?: string): { key: string | null; tariff: VariationTariff | null; error: string | null } {
  const key = tariffStorageKey(orgId);
  if (!key) return { key, tariff: null, error: null };
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { key, tariff: null, error: null };
    const data = JSON.parse(raw);
    if (data.version !== 1 || data.organizationId !== orgId || !validTariff(data.tariff)) throw new Error();
    return { key, tariff: data.tariff, error: null };
  } catch { return { key, tariff: null, error: "The saved tariff could not be read. It has been preserved; enter rates again to replace it." }; }
}

export function useVariationTariff(orgId?: string) {
  const [state, setState] = useState(() => readTariff(orgId));
  const key = tariffStorageKey(orgId);
  const current = state.key === key ? state : readTariff(orgId);
  useEffect(() => {
    const refresh = () => setState(readTariff(orgId));
    const onChange = (event: Event) => { if ((event as CustomEvent<string>).detail === key) refresh(); };
    const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) refresh(); };
    refresh();
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener(CHANGE_EVENT, onChange); window.removeEventListener("storage", onStorage); };
  }, [key, orgId]);
  const save = useCallback((input: VariationTariffInput, actor: Actor): VariationTariff => {
    if (!key) throw new Error("Load your organisation before saving the tariff.");
    if (!input.reference.trim()) throw new Error("Enter the tariff reference, such as its title and version.");
    const invalid = TARIFF_RATES.find(rate => (input.rates[rate.key] ?? "").trim() !== "" && !validRate(input.rates[rate.key]));
    if (invalid) throw new Error(`Enter the ${invalid.group.toLowerCase()} ${invalid.label.toLowerCase()} rate as a number with up to four decimal places.`);
    const rates = Object.fromEntries(TARIFF_RATES.map(rate => [rate.key, (input.rates[rate.key] ?? "").trim()]));
    const tariff: VariationTariff = { currency: input.currency, reference: input.reference.trim(), rates, updatedAt: new Date().toISOString(), updatedBy: actor };
    window.localStorage.setItem(key, JSON.stringify({ version: 1, organizationId: orgId, tariff }));
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: key }));
    setState({ key, tariff, error: null });
    return tariff;
  }, [key, orgId]);
  return { tariff: current.tariff, error: current.error, save };
}
