import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, request } from "../lib/api";
export { agencyDirectoryStorageKey } from "./localAgencyDirectory";

import type { AgencyProfile } from "./types";
export type { AgencyProfile } from "./types";
type AgencyInput = Omit<AgencyProfile, "id"> & { id?: string };
type State = { orgId?: string; agencies: AgencyProfile[]; loading: boolean; error: string | null };
const EVENT = "vessel-caller:server-agencies-changed";
const errorText = (error: unknown) => {
  if (error instanceof ApiError && Object.keys(error.errors).length) return Object.values(error.errors).flat().join(" ");
  return error instanceof Error ? error.message : "Agency setup could not be saved.";
};

export function useAgencyDirectory(orgId?: string) {
  const [state, setState] = useState<State>({ orgId, agencies: [], loading: Boolean(orgId), error: null });
  const [saving, setSaving] = useState(false);
  const activeOrg = useRef(orgId);
  activeOrg.current = orgId;
  const sequence = useRef(0);
  const busy = useRef(false);
  const agencies = state.orgId === orgId ? state.agencies : [];
  const reload = useCallback(async () => {
    const ticket = ++sequence.current;
    if (!orgId) return;
    try {
      const result = await request<{ agencies: AgencyProfile[] }>("/api/agencies");
      if (ticket === sequence.current && activeOrg.current === orgId) setState({ orgId, agencies: result.agencies, loading: false, error: null });
    } catch (error) {
      if (ticket === sequence.current && activeOrg.current === orgId) setState(current => ({ orgId, agencies: current.orgId === orgId ? current.agencies : [], loading: false, error: errorText(error) }));
    }
  }, [orgId]);
  useEffect(() => {
    void reload();
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === orgId) void reload(); };
    window.addEventListener(EVENT, changed);
    return () => { sequence.current++; window.removeEventListener(EVENT, changed); };
  }, [orgId, reload]);

  const saveAgency = useCallback(async (input: AgencyInput): Promise<AgencyProfile | null> => {
    if (!orgId || busy.current || activeOrg.current !== orgId) return null;
    busy.current = true; setSaving(true);
    try {
      if (input.id && !input.version) throw new Error("Reload this agency before editing it.");
      const result = await request<{ agency: AgencyProfile }>(input.id ? `/api/agencies/${encodeURIComponent(input.id)}` : "/api/agencies", {
        method: input.id ? "PATCH" : "POST", body: JSON.stringify(input),
      });
      if (activeOrg.current !== orgId) return null;
      setState(current => ({ orgId, agencies: [...(current.orgId === orgId ? current.agencies : []).filter(item => item.id !== result.agency.id), result.agency], loading: false, error: null }));
      window.dispatchEvent(new CustomEvent(EVENT, { detail: orgId }));
      return result.agency;
    } catch (error) {
      if (activeOrg.current === orgId) setState(current => ({ ...current, error: errorText(error) }));
      return null;
    } finally { busy.current = false; setSaving(false); }
  }, [orgId]);
  const archiveAgency = useCallback(async (id: string) => {
    const agency = agencies.find(item => item.id === id);
    if (agency) await saveAgency({ ...agency, active: false });
  }, [agencies, saveAgency]);
  return { agencies, saveAgency, archiveAgency, loading: state.orgId !== orgId || state.loading, saving,
    error: orgId ? (state.orgId === orgId ? state.error : null) : "Agency setup is unavailable until your organization is loaded.", reload };
}
