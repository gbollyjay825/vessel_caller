import type { VesselCall } from "../types";

export interface VesselVoyages {
  key: string;
  name: string;
  flag: string;
  type: string;
  calls: VesselCall[];
}

// Vessels have no record of their own yet: a vessel is its name and flag.
const slugPart = (value: string) => value.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
export const vesselSlug = (name: string, flag = "") => [slugPart(name), slugPart(flag ?? "")].filter(Boolean).join("--");
export const vesselPath = (name: string, flag = "") => `/app/vessels/${encodeURIComponent(vesselSlug(name, flag))}`;

// The existing API identifies voyages by call.id. This grouping is a display
// index, not a new vessel identity or a substitute for that voyage key.
export function groupVesselCalls(calls: VesselCall[]): VesselVoyages[] {
  const groups = new Map<string, VesselVoyages>();
  for (const call of calls) {
    const key = JSON.stringify([call.vesselName.trim().toLocaleLowerCase(), call.flag?.trim().toLocaleLowerCase() ?? ""]);
    const group = groups.get(key) ?? { key, name: call.vesselName, flag: call.flag || "", type: call.type, calls: [] };
    group.calls.push(call);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    calls: [...group.calls].sort((a, b) => (Date.parse(b.eta || b.registered) || 0) - (Date.parse(a.eta || a.registered) || 0) || b.reference.localeCompare(a.reference)),
  })).sort((a, b) => a.name.localeCompare(b.name) || a.flag.localeCompare(b.flag));
}
