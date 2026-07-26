import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  ApiError,
  api,
  type LoginResult,
  type MfaChallenge,
  type RegisterPayload,
} from "../lib/api";
import { clearQueuedInspectionsForOwner } from "../lib/offlineQueue";
import type { AuthSession, Organization, User } from "../types";

type Status = "loading" | "authenticated" | "anonymous" | "unavailable";

export type Permission =
  | "organization.view"
  | "organization.manage"
  | "users.view"
  | "users.manage"
  | "audit.view"
  | "audit.export"
  | "calls.view"
  | "calls.manage"
  | "inspections.view"
  | "inspections.manage"
  | "invoices.view"
  | "invoices.manage"
  | "invoices.pay"
  | "settings.view"
  | "settings.manage"
  | "analytics.view"
  | "documents.view"
  | "evidence.manage";

export type Action =
  | "registerCall"
  | "cancelCall"
  | "addInspection"
  | "recordPayment"
  | "manageSettings"
  | "manageTeam"
  | "viewUsers"
  | "viewAudit"
  | "viewAnalytics"
  | "viewDocuments"
  | "manageEvidence";

const ACTION_PERMISSION: Record<Action, Permission> = {
  registerCall: "calls.manage",
  cancelCall: "calls.manage",
  addInspection: "inspections.manage",
  recordPayment: "invoices.pay",
  manageSettings: "settings.manage",
  manageTeam: "users.manage",
  viewUsers: "users.view",
  viewAudit: "audit.view",
  viewAnalytics: "analytics.view",
  viewDocuments: "documents.view",
  manageEvidence: "evidence.manage",
};

interface AuthValue {
  status: Status;
  user: User | null;
  org: Organization | null;
  permissions: ReadonlySet<string>;
  authError: string | null;
  sessionExpired: boolean;
  login: (email: string, password: string) => Promise<MfaChallenge | null>;
  verifyMfa: (challengeId: string, code: string) => Promise<void>;
  register: (data: RegisterPayload) => Promise<{ detail: string }>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  retrySession: () => Promise<void>;
  setOrg: (org: Organization) => void;
  can: (action: Action | Permission) => boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

function isMfaChallenge(result: LoginResult): result is MfaChallenge {
  return "mfaRequired" in result && result.mfaRequired === true;
}

function isAnonymousSession(error: unknown): boolean {
  return error instanceof ApiError && (
    error.status === 401
    || (error.status === 403 && error.message === "Authentication credentials were not provided.")
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [org, setOrgState] = useState<Organization | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  const clearSession = useCallback((expired = false) => {
    setUser(null);
    setOrgState(null);
    setPermissions([]);
    setAuthError(null);
    setSessionExpired(expired);
    setStatus("anonymous");
  }, []);

  const applySession = useCallback((session: AuthSession) => {
    setUser(session.user);
    setOrgState(session.org);
    setPermissions(session.permissions);
    setAuthError(null);
    setSessionExpired(false);
    setStatus("authenticated");
  }, []);

  const refreshSession = useCallback(async () => {
    const session = await api.me();
    applySession(session);
  }, [applySession]);

  const retrySession = useCallback(async () => {
    setStatus("loading");
    setAuthError(null);
    try {
      applySession(await api.me());
    } catch (error) {
      if (isAnonymousSession(error)) {
        clearSession(false);
        return;
      }
      setUser(null);
      setOrgState(null);
      setPermissions([]);
      setStatus("unavailable");
      setAuthError("We could not reach the secure session service. Check your connection and try again.");
    }
  }, [applySession, clearSession]);

  useEffect(() => {
    let cancelled = false;
    api.me()
      .then((session) => {
        if (!cancelled) applySession(session);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isAnonymousSession(error)) {
          clearSession(false);
          return;
        }
        setStatus("unavailable");
        setAuthError("We could not reach the secure session service. Check your connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [applySession, clearSession]);

  useEffect(() => {
    const onExpired = () => clearSession(true);
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
  }, [clearSession]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    if (isMfaChallenge(result)) return result;
    applySession(result);
    return null;
  }, [applySession]);

  const verifyMfa = useCallback(async (challengeId: string, code: string) => {
    applySession(await api.verifyMfaChallenge(challengeId, code));
  }, [applySession]);

  const register = useCallback(async (data: RegisterPayload) => {
    const result = await api.register(data);
    return { detail: result.detail };
  }, []);

  const logout = useCallback(async () => {
    const organizationId = org?.id;
    const userId = user?.id;
    try {
      await api.logout();
    } catch {
      // Local session state must still clear if the network is unavailable.
    }
    try {
      if (organizationId && userId) {
        await clearQueuedInspectionsForOwner(organizationId, userId);
      }
    } finally {
      clearSession(false);
    }
  }, [clearSession, org?.id, user?.id]);

  const setOrg = useCallback((next: Organization) => setOrgState(next), []);

  const permissionSet = useMemo(() => new Set(permissions), [permissions]);
  const can = useCallback((action: Action | Permission) => {
    const permission = action in ACTION_PERMISSION
      ? ACTION_PERMISSION[action as Action]
      : action as Permission;
    return permissionSet.has(permission);
  }, [permissionSet]);

  const value = useMemo<AuthValue>(() => ({
    status,
    user,
    org,
    permissions: permissionSet,
    authError,
    sessionExpired,
    login,
    verifyMfa,
    register,
    logout,
    refreshSession,
    retrySession,
    setOrg,
    can,
  }), [
    status,
    user,
    org,
    permissionSet,
    authError,
    sessionExpired,
    login,
    verifyMfa,
    register,
    logout,
    refreshSession,
    retrySession,
    setOrg,
    can,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
