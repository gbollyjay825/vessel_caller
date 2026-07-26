import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useAuth, type Action } from "../auth/AuthContext";
import { ApiError, api, type InspectionMutationResult } from "../lib/api";
import { calcCommission, calcDues, rateForInspection } from "../lib/calc";
import {
  createIdempotencyKey,
  listQueuedInspectionsForOwner,
  markQueuedInspectionAttempt,
  queueInspection,
  removeQueuedInspection,
} from "../lib/offlineQueue";
import type {
  AppState,
  Inspection,
  Invoice,
  Organization,
  Role,
  Settings,
  VesselCall,
} from "../types";

export interface Financials {
  dues: number;
  rate: number;
  commissionUsd: number;
  commissionNgn: number;
  inspection: Inspection;
}

export interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "info";
}

interface InspectionSubmission {
  invoice: Invoice | null;
  queued: boolean;
  inspectionId: string | null;
}

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
  pendingSync: number;
  syncing: boolean;
  syncIssue: boolean;
  retrySync: () => Promise<void>;
  inspectionsForCall: (callId: string) => Inspection[];
  invoiceForCall: (callId: string) => Invoice | undefined;
  financialsForCall: (call: VesselCall | undefined) => Financials | null;
  addCall: (data: Partial<VesselCall>) => Promise<VesselCall>;
  addInspection: (
    data: Record<string, unknown>,
    options?: { evidenceFiles?: File[]; inspectionId?: string },
  ) => Promise<InspectionSubmission>;
  updateCall: (id: string, patch: Partial<VesselCall>) => Promise<VesselCall>;
  updateCallStatus: (
    id: string,
    status: "pending" | "in-progress" | "completed",
    details?: { berth?: string; berthDate?: string | null },
  ) => Promise<VesselCall>;
  cancelCall: (id: string, reason: string) => Promise<VesselCall>;
  recordPayment: (
    invoiceId: string,
    data: { paidOn: string; method: string; reference: string; amount?: number },
  ) => Promise<void>;
  reversePayment: (paymentId: string, reason: string) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  updateOrganization: (patch: Partial<Organization>) => Promise<void>;
}

const StoreContext = createContext<Store | null>(null);

async function persistInspection(
  data: Record<string, unknown>,
  options: { idempotencyKey?: string; evidenceFiles?: File[]; inspectionId?: string },
): Promise<InspectionMutationResult> {
  if (!options.inspectionId) return api.createInspection(data, options);

  const shouldFinalize = data.status === "completed";
  const patch = { ...data };
  delete patch.status;
  const updated = await api.updateInspection(
    options.inspectionId,
    patch,
    options.evidenceFiles,
  );
  if (shouldFinalize) {
    return api.finalizeInspection(updated.inspection.id, updated.inspection.version);
  }
  return {
    inspection: updated.inspection,
    invoice: null,
    call: null,
    rev: updated.rev,
  };
}

export function StoreProvider({ initial, children }: { initial: AppState; children: ReactNode }) {
  const { can, user, org: authOrg, setOrg } = useAuth();
  const [state, setState] = useState<AppState>(initial);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pendingSync, setPendingSync] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncIssue, setSyncIssue] = useState(false);
  const revRef = useRef(initial.rev);
  const flushingRef = useRef(false);
  const organizationId = (authOrg || state.org).id;
  const userId = user?.id ?? "";
  revRef.current = state.rev;

  const apply = useCallback((next: AppState) => {
    setState(next);
    if (next.org) setOrg(next.org);
  }, [setOrg]);

  useEffect(() => {
    const id = window.setInterval(async () => {
      try {
        const response = await api.poll(revRef.current);
        if ("changed" in response && response.changed === false) return;
        apply(response as AppState);
      } catch {
        // A transient polling failure is retried on the next interval.
      }
    }, 5_000);
    return () => window.clearInterval(id);
  }, [apply]);

  const toast = useCallback((message: string, type: Toast["type"] = "success") => {
    const id = `t${Date.now()}${Math.random().toString(36).slice(2)}`;
    setToasts((current) => [...current, { id, message, type }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 4_200);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const inspectionsForCall = useCallback(
    (callId: string) => state.inspections
      .filter((inspection) => inspection.callId === callId)
      .sort((a, b) => +new Date(b.date) - +new Date(a.date)),
    [state.inspections],
  );

  const invoiceForCall = useCallback(
    (callId: string) => state.invoices.find((invoice) => invoice.callId === callId),
    [state.invoices],
  );

  const financialsForCall = useCallback((call: VesselCall | undefined): Financials | null => {
    if (!call) return null;
    const inspection = state.inspections.find(
      (item) => item.callId === call.id && item.status === "completed",
    );
    if (!inspection) return null;
    const rate = rateForInspection(inspection, state.settings);
    if (!rate) return null;
    const dues = calcDues(call.nrt, rate);
    const commission = calcCommission(dues, state.settings);
    return {
      dues,
      rate,
      commissionUsd: commission.usd,
      commissionNgn: commission.ngn,
      inspection,
    };
  }, [state.inspections, state.settings]);

  const mergeInspection = useCallback((result: Awaited<ReturnType<typeof api.createInspection>>) => {
    const inspection = result.inspection as Inspection;
    const resultCall = result.call;
    setState((current) => ({
      ...current,
      rev: Math.max(current.rev, result.rev),
      inspections: [inspection, ...current.inspections.filter((item) => item.id !== inspection.id)],
      calls: resultCall
        ? current.calls.map((call) => (call.id === resultCall.id ? resultCall : call))
        : current.calls,
      invoices: result.invoice
        ? [result.invoice, ...current.invoices.filter((invoice) => invoice.id !== result.invoice?.id)]
        : current.invoices,
    }));
  }, []);

  const refreshPendingSync = useCallback(async () => {
    if (!organizationId || !userId) {
      setPendingSync(0);
      setSyncIssue(false);
      return;
    }
    try {
      const items = await listQueuedInspectionsForOwner(organizationId, userId);
      setPendingSync(items.length);
      setSyncIssue(items.some((item) => Boolean(item.lastError)));
    } catch {
      setPendingSync(0);
      setSyncIssue(true);
    }
  }, [organizationId, userId]);

  const flushQueue = useCallback(async (force = false) => {
    if (
      !organizationId
      || !userId
      || flushingRef.current
      || (typeof navigator !== "undefined" && !navigator.onLine)
    ) return;
    flushingRef.current = true;
    setSyncing(true);
    try {
      const items = await listQueuedInspectionsForOwner(organizationId, userId);
      for (const item of items) {
        if (!force && item.lastError?.startsWith("blocked:")) continue;
        try {
          const result = await persistInspection(item.data, {
            idempotencyKey: item.id,
            evidenceFiles: item.evidenceFiles,
            inspectionId: item.operation === "update" ? item.inspectionId : undefined,
          });
          mergeInspection(result);
          await removeQueuedInspection(item.id, organizationId, userId);
        } catch (error) {
          const blocked = error instanceof ApiError && error.status >= 400 && error.status < 500;
          const detail = error instanceof Error ? error.message : "Upload failed";
          await markQueuedInspectionAttempt(
            item.id,
            `${blocked ? "blocked:" : "retryable:"}${detail}`,
            organizationId,
            userId,
          );
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            toast("A queued inspection was rejected. Review the capture and retry it.", "error");
          }
          break;
        }
      }
    } finally {
      await refreshPendingSync();
      setSyncing(false);
      flushingRef.current = false;
    }
  }, [mergeInspection, organizationId, refreshPendingSync, toast, userId]);

  useEffect(() => {
    void refreshPendingSync().then(() => flushQueue());
    const onOnline = () => void flushQueue(false);
    const retryTimer = window.setInterval(() => void flushQueue(false), 30_000);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(retryTimer);
      window.removeEventListener("online", onOnline);
    };
  }, [flushQueue, refreshPendingSync]);

  const retrySync = useCallback(() => flushQueue(true), [flushQueue]);

  const addCall = useCallback(async (data: Partial<VesselCall>) => {
    const { call, rev } = await api.createCall(data);
    setState((current) => ({
      ...current,
      calls: [call, ...current.calls],
      rev: Math.max(current.rev, rev),
    }));
    return call;
  }, []);

  const mergeCall = useCallback((call: VesselCall, rev: number) => {
    setState((current) => ({
      ...current,
      rev: Math.max(current.rev, rev),
      calls: current.calls.map((item) => (item.id === call.id ? call : item)),
    }));
    return call;
  }, []);

  const updateCall = useCallback(async (id: string, patch: Partial<VesselCall>) => {
    const current = state.calls.find((call) => call.id === id);
    const { call, rev } = await api.updateCall(id, { ...patch, version: current?.version });
    return mergeCall(call, rev);
  }, [mergeCall, state.calls]);

  const updateCallStatus = useCallback(async (
    id: string,
    status: "pending" | "in-progress" | "completed",
    details: { berth?: string; berthDate?: string | null } = {},
  ) => {
    const current = state.calls.find((call) => call.id === id);
    const { call, rev } = await api.updateCallStatus(id, {
      status,
      ...details,
      version: current?.version,
    });
    return mergeCall(call, rev);
  }, [mergeCall, state.calls]);

  const cancelCall = useCallback(async (id: string, reason: string) => {
    const current = state.calls.find((call) => call.id === id);
    const { call, rev } = await api.cancelCall(id, reason, current?.version);
    return mergeCall(call, rev);
  }, [mergeCall, state.calls]);

  const addInspection = useCallback(async (
    data: Record<string, unknown>,
    options: { evidenceFiles?: File[]; inspectionId?: string } = {},
  ): Promise<InspectionSubmission> => {
    const idempotencyKey = createIdempotencyKey();
    try {
      if (typeof navigator !== "undefined" && !navigator.onLine) throw new TypeError("Offline");
      const result = await persistInspection(data, {
        idempotencyKey,
        evidenceFiles: options.evidenceFiles,
        inspectionId: options.inspectionId,
      });
      mergeInspection(result);
      return {
        invoice: result.invoice,
        queued: false,
        inspectionId: result.inspection.id,
      };
    } catch (error) {
      const networkFailure = error instanceof TypeError
        || (typeof navigator !== "undefined" && !navigator.onLine);
      if (!networkFailure) throw error;
      if (!organizationId || !userId) {
        throw new Error("Sign in again before saving work offline", { cause: error });
      }
      await queueInspection({
        id: idempotencyKey,
        organizationId,
        userId,
        data,
        evidenceFiles: options.evidenceFiles ?? [],
        createdAt: new Date().toISOString(),
        attempts: 0,
        operation: options.inspectionId ? "update" : "create",
        inspectionId: options.inspectionId,
        finalize: data.status === "completed",
      });
      await refreshPendingSync();
      return { invoice: null, queued: true, inspectionId: null };
    }
  }, [mergeInspection, organizationId, refreshPendingSync, userId]);

  const mergeInvoice = useCallback((invoice: Invoice, rev: number) => {
    setState((current) => ({
      ...current,
      rev: Math.max(current.rev, rev),
      invoices: current.invoices.map((item) => (item.id === invoice.id ? invoice : item)),
    }));
  }, []);

  const recordPayment = useCallback(async (
    invoiceId: string,
    data: { paidOn: string; method: string; reference: string; amount?: number },
  ) => {
    const { invoice, rev } = await api.recordPayment(invoiceId, data);
    mergeInvoice(invoice, rev);
  }, [mergeInvoice]);

  const reversePayment = useCallback(async (paymentId: string, reason: string) => {
    const { invoice, rev } = await api.reversePayment(paymentId, reason);
    mergeInvoice(invoice, rev);
  }, [mergeInvoice]);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const { settings, rev } = await api.updateSettings(patch);
    setState((current) => ({
      ...current,
      settings,
      rev: Math.max(current.rev, rev),
    }));
  }, []);

  const updateOrganization = useCallback(async (patch: Partial<Organization>) => {
    const { org, rev } = await api.updateOrganization(patch);
    setState((current) => ({
      ...current,
      org,
      rev: Math.max(current.rev, rev),
    }));
    setOrg(org);
  }, [setOrg]);

  const value = useMemo<Store>(() => ({
    rev: state.rev,
    org: state.org,
    settings: state.settings,
    calls: state.calls,
    inspections: state.inspections,
    invoices: state.invoices,
    portLabel: (authOrg || state.org)?.primaryPort || "Port of Calabar",
    can,
    role: user?.role ?? null,
    toasts,
    toast,
    dismissToast,
    pendingSync,
    syncing,
    syncIssue,
    retrySync,
    inspectionsForCall,
    invoiceForCall,
    financialsForCall,
    addCall,
    updateCall,
    updateCallStatus,
    cancelCall,
    addInspection,
    recordPayment,
    reversePayment,
    updateSettings,
    updateOrganization,
  }), [
    state,
    authOrg,
    can,
    user,
    toasts,
    toast,
    dismissToast,
    pendingSync,
    syncing,
    syncIssue,
    retrySync,
    inspectionsForCall,
    invoiceForCall,
    financialsForCall,
    addCall,
    updateCall,
    updateCallStatus,
    cancelCall,
    addInspection,
    recordPayment,
    reversePayment,
    updateSettings,
    updateOrganization,
  ]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const context = useContext(StoreContext);
  if (!context) throw new Error("useStore must be used within StoreProvider");
  return context;
}
