// Authenticated data layer: loads the org's state from the API, polls for
// changes, and exposes typed mutations. Screens consume `useStore()`.
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";

import { useAuth, type Action } from "../auth/AuthContext";
import { api } from "../lib/api";
import { calcCommission, calcDues, rateForInspection } from "../lib/calc";
import type {
  AppState, Inspection, Invoice, Organization, Role, Settings, VesselCall,
} from "../types";

export interface Financials {
  dues: number; rate: number; commissionUsd: number; commissionNgn: number; inspection: Inspection;
}
export interface Toast { id: string; message: string; type: "success" | "error" | "info"; }

interface Store {
  rev: number;
  org: Organization;
  settings: Settings;
  calls: VesselCall[];
  inspections: Inspection[];
  invoices: Invoice[];
  portLabel: string;
  can: (action: Action) => boolean;
  role: Role | null;
  toasts: Toast[];
  toast: (message: string, type?: Toast["type"]) => void;
  dismissToast: (id: string) => void;
  // derived
  inspectionsForCall: (callId: string) => Inspection[];
  invoiceForCall: (callId: string) => Invoice | undefined;
  financialsForCall: (call: VesselCall | undefined) => Financials | null;
  // mutations
  addCall: (data: Partial<VesselCall>) => Promise<VesselCall>;
  deleteCall: (id: string) => Promise<void>;
  addInspection: (data: Record<string, unknown>) => Promise<{ invoice: Invoice | null }>;
  updateInvoice: (id: string, patch: Record<string, unknown>) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  updateOrganization: (patch: Partial<Organization>) => Promise<void>;
  addMember: (m: { name: string; email: string; password: string; role: Role }) => Promise<void>;
  updateMember: (id: string, patch: Record<string, unknown>) => Promise<void>;
  removeMember: (id: string) => Promise<void>;
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ initial, children }: { initial: AppState; children: ReactNode }) {
  const { can, user, org: authOrg, setOrg } = useAuth();
  const [state, setState] = useState<AppState>(initial);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const revRef = useRef(initial.rev);
  revRef.current = state.rev;

  const apply = useCallback((next: AppState) => {
    setState(next);
    if (next.org) setOrg(next.org);
  }, [setOrg]);

  // Poll for cross-client changes every 5s.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await api.poll(revRef.current);
        if (res && (res as any).changed !== false) apply(res as AppState);
      } catch { /* transient — next tick retries */ }
    }, 5000);
    return () => clearInterval(id);
  }, [apply]);

  const toast = useCallback((message: string, type: Toast["type"] = "success") => {
    const id = "t" + Date.now() + Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  const dismissToast = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const inspectionsForCall = useCallback(
    (callId: string) => state.inspections.filter((i) => i.callId === callId)
      .sort((a, b) => +new Date(b.date) - +new Date(a.date)),
    [state.inspections],
  );
  const invoiceForCall = useCallback(
    (callId: string) => state.invoices.find((v) => v.callId === callId),
    [state.invoices],
  );
  const financialsForCall = useCallback((call: VesselCall | undefined): Financials | null => {
    if (!call) return null;
    const insp = state.inspections.find((i) => i.callId === call.id && i.status === "completed");
    if (!insp) return null;
    const rate = rateForInspection(insp, state.settings);
    if (!rate) return null;
    const dues = calcDues(call.nrt, rate);
    const c = calcCommission(dues, state.settings);
    return { dues, rate, commissionUsd: c.usd, commissionNgn: c.ngn, inspection: insp };
  }, [state.inspections, state.settings]);

  const bumpFrom = (rev: number) => setState((s) => ({ ...s, rev: Math.max(s.rev, rev) }));

  const addCall = useCallback(async (data: Partial<VesselCall>) => {
    const { call, rev } = await api.createCall(data);
    setState((s) => ({ ...s, calls: [call, ...s.calls], rev: Math.max(s.rev, rev) }));
    return call;
  }, []);
  const deleteCall = useCallback(async (id: string) => {
    const { rev } = await api.deleteCall(id);
    setState((s) => ({
      ...s, rev: Math.max(s.rev, rev),
      calls: s.calls.filter((c) => c.id !== id),
      inspections: s.inspections.filter((i) => i.callId !== id),
      invoices: s.invoices.filter((v) => v.callId !== id),
    }));
  }, []);
  const addInspection = useCallback(async (data: Record<string, unknown>) => {
    const res = await api.createInspection(data);
    setState((s) => ({
      ...s, rev: Math.max(s.rev, res.rev),
      inspections: [res.inspection as Inspection, ...s.inspections],
      calls: res.call ? s.calls.map((c) => (c.id === res.call.id ? res.call : c)) : s.calls,
      invoices: res.invoice ? [res.invoice, ...s.invoices] : s.invoices,
    }));
    return { invoice: res.invoice };
  }, []);
  const updateInvoice = useCallback(async (id: string, patch: Record<string, unknown>) => {
    const { invoice, rev } = await api.updateInvoice(id, patch);
    setState((s) => ({ ...s, rev: Math.max(s.rev, rev), invoices: s.invoices.map((v) => (v.id === id ? invoice : v)) }));
  }, []);
  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const { settings, rev } = await api.updateSettings(patch);
    setState((s) => ({ ...s, settings, rev: Math.max(s.rev, rev) }));
  }, []);
  const updateOrganization = useCallback(async (patch: Partial<Organization>) => {
    const { org, rev } = await api.updateOrganization(patch);
    setState((s) => ({ ...s, org, rev: Math.max(s.rev, rev) }));
    setOrg(org);
  }, [setOrg]);
  const addMember = useCallback(async (m: { name: string; email: string; password: string; role: Role }) => {
    const { rev } = await api.addMember(m);
    bumpFrom(rev);
    const fresh = await api.state();
    apply(fresh);
  }, [apply]);
  const updateMember = useCallback(async (id: string, patch: Record<string, unknown>) => {
    const { rev } = await api.updateMember(id, patch as any);
    bumpFrom(rev);
    apply(await api.state());
  }, [apply]);
  const removeMember = useCallback(async (id: string) => {
    const { rev } = await api.removeMember(id);
    bumpFrom(rev);
    apply(await api.state());
  }, [apply]);

  const value = useMemo<Store>(() => ({
    rev: state.rev, org: state.org, settings: state.settings, calls: state.calls,
    inspections: state.inspections, invoices: state.invoices,
    portLabel: (authOrg || state.org)?.primaryPort || "Port of Calabar",
    can, role: user?.role ?? null, toasts, toast, dismissToast,
    inspectionsForCall, invoiceForCall, financialsForCall,
    addCall, deleteCall, addInspection, updateInvoice, updateSettings, updateOrganization,
    addMember, updateMember, removeMember,
  }), [state, authOrg, can, user, toasts, toast, dismissToast, inspectionsForCall, invoiceForCall,
       financialsForCall, addCall, deleteCall, addInspection, updateInvoice, updateSettings,
       updateOrganization, addMember, updateMember, removeMember]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
