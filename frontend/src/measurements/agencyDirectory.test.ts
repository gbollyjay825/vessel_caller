import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTestAgencyStorage } from "./agencyDirectory.test-support";
import { agencyDirectoryStorageKey, useAgencyDirectory, type AgencyProfile } from "./agencyDirectory";

const entry = { name: "Port Agency", role: "Agent", representative: "Ada", active: true };
const key = (org = "org-1") => agencyDirectoryStorageKey(org)!;
function stored(agencies: AgencyProfile[], organizationId = "org-1") {
  return JSON.stringify({ version: 1, organizationId, agencies });
}
beforeEach(installTestAgencyStorage);
afterEach(() => vi.unstubAllGlobals());

describe("organization-scoped browser agency directory", () => {
  it("normalizes a profile, persists it and rehydrates without seeded agencies", () => {
    const first = renderHook(() => useAgencyDirectory("org-1"));
    expect(first.result.current.agencies).toEqual([]);
    let saved: AgencyProfile | null = null;
    act(() => { saved = first.result.current.saveAgency({ ...entry, name: "  Port   Agency  " }); });
    expect(first.result.current.error).toBeNull();
    const agency = first.result.current.agencies[0];
    expect(saved).toEqual(agency);
    expect(agency).toMatchObject(entry);
    expect(agency.id).toBeTruthy();
    first.unmount();
    const next = renderHook(() => useAgencyDirectory("org-1"));
    expect(next.result.current.agencies).toEqual([agency]);
    expect(JSON.parse(window.localStorage.getItem(key())!)).toEqual({ version: 1, organizationId: "org-1", agencies: [agency] });
  });

  it("never shows or writes another organization when scope changes or is unknown", () => {
    const directory = renderHook(({ orgId }: { orgId?: string }) => useAgencyDirectory(orgId), { initialProps: { orgId: "org-1" } as { orgId?: string } });
    act(() => directory.result.current.saveAgency(entry));
    directory.rerender({ orgId: "org-2" });
    expect(directory.result.current.agencies).toEqual([]);
    act(() => directory.result.current.saveAgency({ ...entry, name: "Second organization" }));
    directory.rerender({ orgId: undefined });
    expect(directory.result.current.agencies).toEqual([]);
    expect(directory.result.current.error).toMatch(/organization is loaded/);
    act(() => directory.result.current.saveAgency(entry));
    expect(window.localStorage.length).toBe(2);
    directory.rerender({ orgId: "org-1" });
    expect(directory.result.current.agencies.map(item => item.name)).toEqual(["Port Agency"]);
    expect(agencyDirectoryStorageKey(" ")).toBeNull();
  });

  it.each([
    "not json",
    JSON.stringify({ version: 2, organizationId: "org-1", agencies: [] }),
    JSON.stringify({ version: 1, organizationId: "org-2", agencies: [] }),
    stored([{ ...entry, id: "bad", active: "yes" } as unknown as AgencyProfile]),
    stored([{ ...entry, id: "a" }, { ...entry, id: "b" }]),
    stored([{ ...entry, id: "a" }, { ...entry, name: "Other", id: "a" }]),
  ])("preserves invalid saved data instead of silently replacing it (%#)", raw => {
    window.localStorage.setItem(key(), raw);
    const { result } = renderHook(() => useAgencyDirectory("org-1"));
    expect(result.current.agencies).toEqual([]);
    expect(result.current.error).toMatch(/invalid/);
    act(() => result.current.saveAgency(entry));
    expect(window.localStorage.getItem(key())).toBe(raw);
  });

  it("rejects duplicate normalized name and role, including archived entries, but permits distinct roles", () => {
    const { result } = renderHook(() => useAgencyDirectory("org-1"));
    act(() => result.current.saveAgency(entry));
    const original = result.current.agencies[0];
    act(() => result.current.archiveAgency(original.id));
    act(() => result.current.saveAgency({ ...entry, name: " port   agency ", role: "agent" }));
    expect(result.current.error).toMatch(/already exists/);
    expect(result.current.agencies).toEqual([{ ...original, active: false }]);
    act(() => result.current.saveAgency({ ...original, active: true, representative: "Bola" }));
    expect(result.current.error).toBeNull();
    expect(result.current.agencies).toEqual([{ ...original, representative: "Bola", active: true }]);
    act(() => result.current.saveAgency({ ...entry, role: "Surveyor" }));
    expect(result.current.agencies).toHaveLength(2);
  });

  it("rejects invalid profiles and stale identifiers without changing saved entries", () => {
    const { result } = renderHook(() => useAgencyDirectory("org-1"));
    act(() => result.current.saveAgency({ ...entry, name: " " }));
    expect(result.current.error).toMatch(/name and role/);
    act(() => result.current.saveAgency({ ...entry, id: "missing" }));
    expect(result.current.error).toMatch(/no longer exists/);
    act(() => result.current.archiveAgency("missing"));
    expect(result.current.error).toMatch(/no longer exists/);
    expect(window.localStorage.getItem(key())).toBeNull();
  });

  it("surfaces read and write failures without pretending an unsaved change succeeded", () => {
    const { result } = renderHook(() => useAgencyDirectory("org-1"));
    act(() => result.current.saveAgency(entry));
    const before = window.localStorage.getItem(key());
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new DOMException("Quota", "QuotaExceededError"); });
    let saved: AgencyProfile | null = null;
    act(() => { saved = result.current.saveAgency({ ...entry, name: "Unsaved agency" }); });
    expect(saved).toBeNull();
    expect(result.current.error).toMatch(/have not been saved/);
    expect(result.current.agencies.map(item => item.name)).toEqual([entry.name]);
    expect(window.localStorage.getItem(key())).toBe(before);
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    const blocked = renderHook(() => useAgencyDirectory("blocked-org"));
    expect(blocked.result.current.agencies).toEqual([]);
    expect(blocked.result.current.error).toMatch(/could not read/);
  });

  it("refreshes same-tab consumers and scoped cross-tab storage changes", () => {
    const first = renderHook(() => useAgencyDirectory("org-1"));
    const same = renderHook(() => useAgencyDirectory("org-1"));
    const other = renderHook(() => useAgencyDirectory("org-2"));
    act(() => first.result.current.saveAgency(entry));
    expect(same.result.current.agencies).toEqual(first.result.current.agencies);
    expect(other.result.current.agencies).toEqual([]);
    const remote = { ...entry, id: "remote", name: "Remote saved agency" };
    act(() => { window.localStorage.setItem(key(), stored([remote])); window.dispatchEvent(new StorageEvent("storage", { key: key() })); });
    expect(first.result.current.agencies).toEqual([remote]);
    expect(same.result.current.agencies).toEqual([remote]);
    expect(other.result.current.agencies).toEqual([]);
    act(() => { window.localStorage.clear(); window.dispatchEvent(new StorageEvent("storage", { key: null })); });
    expect(first.result.current.agencies).toEqual([]);
  });

  it("re-reads storage before saving so a new remote entry is retained", () => {
    const { result } = renderHook(() => useAgencyDirectory("org-1"));
    const remote = { ...entry, id: "remote", name: "Another tab" };
    window.localStorage.setItem(key(), stored([remote]));
    act(() => result.current.saveAgency(entry));
    expect(result.current.agencies.map(item => item.name)).toEqual(["Another tab", "Port Agency"]);
  });
});
