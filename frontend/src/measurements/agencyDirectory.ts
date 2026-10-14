import { useCallback, useEffect, useState } from "react";

export type AgencyProfile = {
  id: string;
  name: string;
  role: string;
  representative: string;
  active: boolean;
};
type AgencyInput = Omit<AgencyProfile, "id"> & { id?: string };
type DirectoryState = { key: string | null; agencies: AgencyProfile[]; error: string | null };
const CHANGE_EVENT = "vessel-caller:agency-directory-changed";
const MAX_AGENCIES = 500;
const unavailable = "Agency setup is unavailable until your organization is loaded.";

export function agencyDirectoryStorageKey(orgId?: string): string | null {
  return orgId?.trim() ? `vessel-caller:agency-directory:v1:${encodeURIComponent(orgId)}` : null;
}

function clean(value: string): string { return value.trim().replace(/\s+/g, " "); }
function identity(agency: Pick<AgencyProfile, "name" | "role">): string {
  return JSON.stringify([clean(agency.name).toLocaleLowerCase(), clean(agency.role).toLocaleLowerCase()]);
}
function isProfile(value: unknown): value is AgencyProfile {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && item.id.length > 0 && item.id.length <= 100
    && typeof item.name === "string" && clean(item.name).length > 0 && item.name.length <= 255
    && typeof item.role === "string" && clean(item.role).length > 0 && item.role.length <= 100
    && typeof item.representative === "string" && item.representative.length <= 255
    && typeof item.active === "boolean";
}
function readDirectory(orgId?: string): DirectoryState {
  const key = agencyDirectoryStorageKey(orgId);
  if (!key) return { key, agencies: [], error: unavailable };
  let raw: string | null;
  try { raw = window.localStorage.getItem(key); }
  catch { return { key, agencies: [], error: "This browser could not read the agency directory. Check its storage settings." }; }
  if (raw === null) return { key, agencies: [], error: null };
  try {
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== "object") throw new Error();
    const data = stored as Record<string, unknown>;
    if (data.version !== 1 || data.organizationId !== orgId || !Array.isArray(data.agencies)
      || data.agencies.length > MAX_AGENCIES || !data.agencies.every(isProfile)) throw new Error();
    const agencies = data.agencies.map(({ id, name, role, representative, active }) => ({ id, name, role, representative, active }));
    if (new Set(agencies.map(item => item.id)).size !== agencies.length
      || new Set(agencies.map(identity)).size !== agencies.length) throw new Error();
    return { key, agencies, error: null };
  } catch {
    return { key, agencies: [], error: "The saved agency directory is invalid. It has been preserved; changes cannot be saved until it is repaired." };
  }
}

export function useAgencyDirectory(orgId?: string): {
  agencies: AgencyProfile[];
  saveAgency: (input: AgencyInput) => AgencyProfile | null;
  archiveAgency: (id: string) => void;
  error: string | null;
} {
  const key = agencyDirectoryStorageKey(orgId);
  const [state, setState] = useState(() => readDirectory(orgId));
  // Never expose a previous organization's rows while the subscription changes.
  const current = state.key === key ? state : readDirectory(orgId);
  useEffect(() => {
    const refresh = () => setState(readDirectory(orgId));
    const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) refresh(); };
    const onChange = (event: Event) => { if ((event as CustomEvent<string>).detail === key) refresh(); };
    refresh();
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => { window.removeEventListener("storage", onStorage); window.removeEventListener(CHANGE_EVENT, onChange); };
  }, [orgId, key]);

  const mutate = useCallback((change: (agencies: AgencyProfile[]) => AgencyProfile[]) => {
    const latest = readDirectory(orgId);
    if (!latest.key || latest.error) { setState(latest); return null; }
    let agencies: AgencyProfile[];
    try { agencies = change(latest.agencies); }
    catch (error) { setState({ ...latest, error: error instanceof Error ? error.message : "Unable to update the agency directory." }); return null; }
    try { window.localStorage.setItem(latest.key, JSON.stringify({ version: 1, organizationId: orgId, agencies })); }
    catch { setState({ ...latest, error: "This browser could not save the agency directory. Your changes have not been saved." }); return null; }
    setState({ key: latest.key, agencies, error: null });
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: latest.key }));
    return agencies;
  }, [orgId]);

  const saveAgency = useCallback((input: AgencyInput) => {
    let saved: AgencyProfile | null = null;
    const result = mutate(agencies => {
    const candidate = { id: input.id ?? crypto.randomUUID(), name: clean(input.name), role: clean(input.role), representative: clean(input.representative), active: input.active };
    if (!isProfile(candidate)) throw new Error("Enter an agency name and role within the field limits.");
    if (input.id !== undefined && !agencies.some(item => item.id === input.id)) throw new Error("This agency no longer exists. Refresh the directory before editing.");
    if (agencies.some(item => item.id !== candidate.id && identity(item) === identity(candidate))) throw new Error("An agency with this name and role already exists. Edit or reactivate its existing entry.");
    if (!input.id && agencies.length >= MAX_AGENCIES) throw new Error("This browser directory can store up to 500 agencies.");
    saved = candidate;
    return input.id ? agencies.map(item => item.id === input.id ? candidate : item) : [...agencies, candidate];
    });
    return result ? saved : null;
  }, [mutate]);
  const archiveAgency = useCallback((id: string) => mutate(agencies => {
    if (!agencies.some(item => item.id === id)) throw new Error("This agency no longer exists. Refresh the directory before editing.");
    return agencies.map(item => item.id === id ? { ...item, active: false } : item);
  }), [mutate]);
  return { agencies: current.agencies, saveAgency, archiveAgency, error: current.error };
}
