import type { CargoLineInput, QuantityUnit } from "./types";

export const CARGO_TYPES = ["Containers", "Bulk", "Tanker", "General cargo", "Vehicles", "Mixed"] as const;
export type CargoTemplateType = typeof CARGO_TYPES[number];
export const CARGO_CATEGORIES = ["Container", "Bulk", "Liquid", "General cargo", "Vehicle"] as const;
export const AGENCY_ROLES = [
  { value: "Agent", label: "Agent" },
  { value: "Terminal operator", label: "Ops / Terminal" },
  { value: "Master", label: "Master" },
  { value: "Surveyor", label: "Surveyor" },
  { value: "Tally clerk", label: "Tally clerk" },
];
export const UNIT_LABELS: Record<QuantityUnit, string> = { count: "Count", tonnes: "Tonnes", m3: "Cubic metres (m³)" };

export function categoryFor(type: CargoTemplateType): CargoLineInput["category"] {
  return type === "Containers" ? "Container" : type === "Tanker" ? "Liquid" : type === "Vehicles" ? "Vehicle" : type === "Mixed" ? "Bulk" : type;
}
export function unitsFor(category: string): QuantityUnit[] {
  if (category === "Container" || category === "Vehicle") return ["count"];
  if (category === "Liquid" || category === "Bulk") return ["tonnes", "m3"];
  return ["tonnes", "count", "m3"];
}
export function basisFor(category: string, unit: QuantityUnit): string {
  if (unit === "m3") return "Volume in cubic metres";
  if (unit === "tonnes") return "Net metric tonnes";
  return category === "Container" ? "Physical container count" : category === "Vehicle" ? "Physical vehicle count" : "Physical item count";
}
export function cargoLine(category = "Bulk", direction = "import"): CargoLineInput {
  const unit = unitsFor(category)[0];
  return { description: "", category, direction, unit, basis: basisFor(category, unit), containerSize: "", loadStatus: "", manifestQuantity: null, baselineReference: "" };
}
export function templateLines(type: CargoTemplateType): CargoLineInput[] {
  if (type === "Containers") return ["import", "export"].flatMap(direction =>
    ["20", "40", "45"].flatMap(containerSize => ["laden", "empty"].map(loadStatus => ({
      ...cargoLine("Container", direction), containerSize, loadStatus,
      description: `${containerSize} ft ${loadStatus} containers`,
    }))),
  );
  if (type === "Vehicles") return ["import", "export"].flatMap(direction =>
    ["Cars", "Buses", "Trucks", "Mafi Trailer / HDV", "Motorcycles", "Other vehicles"].map(description => ({ ...cargoLine("Vehicle", direction), description })),
  );
  return [cargoLine(categoryFor(type))];
}
export function defaultMethod(type: CargoTemplateType): string {
  if (type === "Containers") return "Physical container tally";
  if (type === "Tanker") return "Product measurement";
  if (type === "Vehicles") return "Vehicle tally";
  if (type === "Bulk") return "Draft survey";
  if (type === "Mixed") return "Cargo survey and tally";
  return "Physical cargo tally";
}
