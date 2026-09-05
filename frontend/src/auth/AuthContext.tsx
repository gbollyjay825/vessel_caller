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

import {
  ApiError,
  api,
  type LoginResult,
  type MfaChallenge,
  type RegisterPayload,
} from "../lib/api";
import { clearQueuedInspectionsForOwner } from "../lib/offlineQueue";
import {
  advanceAuthSessionEpoch,
  currentAuthSessionEpoch,
  publishAuthSessionBoundary,
  subscribeAuthSessionBoundary,
} from "../lib/authSessionEpoch";
import { clearAuthenticatedQueryCache } from "../lib/queryClient";
import type { AuthSession, Organization, User } from "../types";

type PlatformAccess = NonNullable<AuthSession["platformAccess"]>;

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
  | "evidence.manage"
  | "platform.organizations.view"
  | "platform.organizations.manage"
  | "platform.organization_users.view"
  | "platform.organization_users.manage"
  | "platform.audit.view"
  | "platform.audit.export";

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
  platformAccess: PlatformAccess | null;
  permissions: ReadonlySet<string>;
  authError: string | null;
  sessionExpired: boolean;
  homePath: "/app" | "/system" | "/system/account";
  login: (email: string, password: string) => Promise<LoginResult>;
  verifyMfa: (challengeId: string, code: string) => Promise<AuthSession>;
  register: (data: RegisterPayload) => Promise<{ detail: string; approvalRequired: boolean }>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  retrySession: () => Promise<void>;
  setOrg: (org: Organization) => void;
  can: (action: Action | Permission) => boolean;
}

const AuthContext = createContext<AuthValue | null>(null);
const EXTERNAL_AUTH_TRANSITION_WATCHDOG_MS = 17_000;

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
  const [platformAccess, setPlatformAccess] = useState<PlatformAccess | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const identityRef = useRef<string | null>(null);
  const authGenerationRef = useRef(0);
  const identityIntentRef = useRef(0);
  const localIdentityOperationRef = useRef(0);
  const logoutBarrierRef = useRef<Promise<void>>(Promise.resolve());
  const externalAuthTransitionsRef = useRef(new Map<string, number>());

  const beginAuthRequest = useCallback(() => {
    authGenerationRef.current += 1;
    return {
      generation: authGenerationRef.current,
      sessionEpoch: currentAuthSessionEpoch(),
      identityIntent: identityIntentRef.current,
    };
  }, []);

  const beginIdentityRequest = useCallback(() => {
    // Declare the identity change before a cookie-mutating request waits in
    // the shared API queue. An older hydration 401 must not invalidate the
    // login that is queued immediately behind it.
    identityIntentRef.current += 1;
    localIdentityOperationRef.current += 1;
    // Suppress auth-expired events from ordinary requests that started under
    // the previous identity while this transition is queued.
    advanceAuthSessionEpoch();
    return {
      ...beginAuthRequest(),
      localIdentityOperation: localIdentityOperationRef.current,
    };
  }, [beginAuthRequest]);

  const rebaseIdentityRequest = useCallback((request: {
    generation: number;
    sessionEpoch: number;
    identityIntent: number;
    localIdentityOperation: number;
  }) => {
    if (request.localIdentityOperation !== localIdentityOperationRef.current) return false;
    // A peer transition may have reconciled while this request waited for the
    // prior local logout response. Rebase only the newest local intent after
    // that cookie barrier, invalidating the peer result before this login runs.
    advanceAuthSessionEpoch();
    Object.assign(request, beginAuthRequest());
    return true;
  }, [beginAuthRequest]);

  const isCurrentAuthRequest = useCallback(
    (request: { generation: number; sessionEpoch: number; identityIntent: number }) => (
      authGenerationRef.current === request.generation
      && currentAuthSessionEpoch() === request.sessionEpoch
      && identityIntentRef.current === request.identityIntent
    ),
    [],
  );

  const isCurrentSessionEpoch = useCallback(
    (request: { sessionEpoch: number; identityIntent: number }) => (
      currentAuthSessionEpoch() === request.sessionEpoch
      && identityIntentRef.current === request.identityIntent
    ),
    [],
  );

  const clearSessionState = useCallback((expired = false) => {
    authGenerationRef.current += 1;
    identityIntentRef.current += 1;
    clearAuthenticatedQueryCache();
    identityRef.current = null;
    setUser(null);
    setOrgState(null);
    setPlatformAccess(null);
    setPermissions([]);
    setAuthError(null);
    setSessionExpired(expired);
    setStatus("anonymous");
  }, []);

  const clearSession = useCallback((expired = false, broadcast = true) => {
    if (broadcast) publishAuthSessionBoundary();
    else advanceAuthSessionEpoch();
    clearSessionState(expired);
  }, [clearSessionState]);

  const applySession = useCallback((session: AuthSession) => {
    if (identityRef.current && identityRef.current !== session.user.id) {
      clearAuthenticatedQueryCache();
    }
    identityRef.current = session.user.id;
    setUser(session.user);
    setOrgState(session.org);
    setPlatformAccess(session.platformAccess ?? null);
    setPermissions(Array.from(new Set([
      ...session.permissions,
      ...(session.platformAccess?.permissions ?? []),
    ])));
    setAuthError(null);
    setSessionExpired(false);
    setStatus("authenticated");
  }, []);

  const commitSession = useCallback((
    session: AuthSession,
    request: { generation: number; sessionEpoch: number; identityIntent: number },
  ) => {
    if (!isCurrentAuthRequest(request)) return false;
    // A committed identity response establishes a new epoch. Older successes
    // and authorization failures can no longer overwrite this session.
    advanceAuthSessionEpoch();
    applySession(session);
    return true;
  }, [applySession, isCurrentAuthRequest]);

  const commitIdentitySession = useCallback((session: AuthSession, generation: number) => {
    // Cookie-mutating API calls may have waited behind another serialized
    // cookie response that legitimately advanced the shared epoch. The local
    // generation still prevents a logout/newer identity action from reviving
    // this result.
    if (authGenerationRef.current !== generation) return false;
    applySession(session);
    return true;
  }, [applySession]);

  const settleIdentityAttemptWithoutSession = useCallback((generation: number) => {
    if (authGenerationRef.current !== generation || identityRef.current) return;
    // A login intent can deliberately make an older hydration response stale.
    // If that intent fails or pauses for MFA, leave the public auth screen in a
    // usable anonymous state instead of preserving its initial loading state.
    setStatus("anonymous");
  }, []);

  const refreshSession = useCallback(async () => {
    const request = beginAuthRequest();
    try {
      const session = await api.me((epoch) => { request.sessionEpoch = epoch; });
      commitSession(session, request);
    } catch (error) {
      if (isAnonymousSession(error)) {
        // A 401/anonymous 403 is authoritative for the epoch it queried even
        // if another same-epoch refresh started later and is still pending.
        if (isCurrentSessionEpoch(request)) clearSession(true);
        return;
      }
      if (!isCurrentAuthRequest(request)) return;
      throw error;
    }
  }, [beginAuthRequest, clearSession, commitSession, isCurrentAuthRequest, isCurrentSessionEpoch]);

  const retrySession = useCallback(async () => {
    const request = beginAuthRequest();
    setStatus("loading");
    setAuthError(null);
    try {
      const session = await api.me((epoch) => { request.sessionEpoch = epoch; });
      commitSession(session, request);
    } catch (error) {
      if (isAnonymousSession(error)) {
        if (isCurrentSessionEpoch(request)) clearSession(false);
        return;
      }
      if (!isCurrentAuthRequest(request)) return;
      setUser(null);
      setOrgState(null);
      setPlatformAccess(null);
      setPermissions([]);
      setStatus("unavailable");
      setAuthError("We could not reach the secure session service. Check your connection and try again.");
    }
  }, [beginAuthRequest, clearSession, commitSession, isCurrentAuthRequest, isCurrentSessionEpoch]);

  useEffect(() => {
    let cancelled = false;
    const request = beginAuthRequest();
    api.me((epoch) => { request.sessionEpoch = epoch; })
      .then((session) => {
        if (!cancelled) commitSession(session, request);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isAnonymousSession(error)) {
          if (isCurrentSessionEpoch(request)) clearSession(false);
          return;
        }
        if (!isCurrentAuthRequest(request)) return;
        setStatus("unavailable");
        setAuthError("We could not reach the secure session service. Check your connection and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [beginAuthRequest, clearSession, commitSession, isCurrentAuthRequest, isCurrentSessionEpoch]);

  useEffect(() => {
    const onExpired = () => clearSession(true);
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
  }, [clearSession]);

  const reconcileExternalSession = useCallback(async () => {
    const request = beginAuthRequest();
    try {
      const session = await api.me((epoch) => { request.sessionEpoch = epoch; });
      commitSession(session, request);
    } catch (error) {
      if (isAnonymousSession(error)) {
        if (isCurrentSessionEpoch(request)) clearSession(false, false);
        return;
      }
      if (!isCurrentAuthRequest(request)) return;
      setStatus("unavailable");
      setAuthError("We could not reach the secure session service. Check your connection and try again.");
    }
  }, [beginAuthRequest, clearSession, commitSession, isCurrentAuthRequest, isCurrentSessionEpoch]);

  useEffect(() => {
    const clearExternalTransitions = () => {
      externalAuthTransitionsRef.current.forEach((timer) => window.clearTimeout(timer));
      externalAuthTransitionsRef.current.clear();
    };
    const unsubscribe = subscribeAuthSessionBoundary((event) => {
      // Another tab (or a same-tab security mutation) changed the origin-wide
      // HttpOnly session. Remove identity-bound UI and queries before asking the
      // server which identity now owns the cookie.
      clearSessionState(false);
      setStatus("loading");
      if (event.phase === "start") {
        const existing = externalAuthTransitionsRef.current.get(event.transitionId);
        if (existing !== undefined) window.clearTimeout(existing);
        const watchdog = window.setTimeout(() => {
          externalAuthTransitionsRef.current.delete(event.transitionId);
          if (externalAuthTransitionsRef.current.size === 0) void reconcileExternalSession();
        }, EXTERNAL_AUTH_TRANSITION_WATCHDOG_MS);
        externalAuthTransitionsRef.current.set(event.transitionId, watchdog);
        return;
      }
      if (event.phase === "settled") {
        const timer = externalAuthTransitionsRef.current.get(event.transitionId);
        if (timer !== undefined) window.clearTimeout(timer);
        externalAuthTransitionsRef.current.delete(event.transitionId);
        if (externalAuthTransitionsRef.current.size > 0) return;
      } else {
        clearExternalTransitions();
      }
      void reconcileExternalSession();
    });
    return () => {
      unsubscribe();
      clearExternalTransitions();
    };
  }, [
    clearSessionState,
    reconcileExternalSession,
  ]);

  useEffect(() => {
    if (status !== "authenticated" || platformAccess) return undefined;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshSession().catch(() => {
          // Keep the current screen through transient connectivity failures.
        });
      }
    };
    const timer = window.setInterval(refreshWhenVisible, 4 * 60 * 1000);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [platformAccess, refreshSession, status]);

  useEffect(() => {
    const expiresAt = platformAccess?.assuranceExpiresAt;
    if (!expiresAt || platformAccess.stepUpRequired) return;
    const expires = Date.parse(expiresAt);
    let timer: number | undefined;
    const schedule = () => {
      const remaining = expires - Date.now();
      if (!Number.isFinite(expires) || remaining <= 0) {
        setPlatformAccess((current) => current ? { ...current, stepUpRequired: true } : current);
        return;
      }
      timer = window.setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    };
    schedule();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [platformAccess?.assuranceExpiresAt, platformAccess?.stepUpRequired]);

  const login = useCallback(async (email: string, password: string) => {
    const request = beginIdentityRequest();
    // A late Django logout response can expire whichever session cookie the
    // browser currently holds. Do not start a new login until that response
    // has settled, even though local state clears immediately.
    await logoutBarrierRef.current;
    if (!rebaseIdentityRequest(request)) {
      throw new DOMException("The sign-in attempt was superseded", "AbortError");
    }
    try {
      const result = await api.login(email, password);
      if (isMfaChallenge(result)) {
        settleIdentityAttemptWithoutSession(request.generation);
      } else {
        if (!commitIdentitySession(result, request.generation)) await reconcileExternalSession();
      }
      return result;
    } catch (error) {
      settleIdentityAttemptWithoutSession(request.generation);
      throw error;
    }
  }, [
    beginIdentityRequest,
    commitIdentitySession,
    rebaseIdentityRequest,
    reconcileExternalSession,
    settleIdentityAttemptWithoutSession,
  ]);

  const verifyMfa = useCallback(async (challengeId: string, code: string) => {
    const request = beginIdentityRequest();
    await logoutBarrierRef.current;
    if (!rebaseIdentityRequest(request)) {
      throw new DOMException("The MFA attempt was superseded", "AbortError");
    }
    try {
      const session = await api.verifyMfaChallenge(challengeId, code);
      if (!commitIdentitySession(session, request.generation)) await reconcileExternalSession();
      return session;
    } catch (error) {
      settleIdentityAttemptWithoutSession(request.generation);
      throw error;
    }
  }, [
    beginIdentityRequest,
    commitIdentitySession,
    rebaseIdentityRequest,
    reconcileExternalSession,
    settleIdentityAttemptWithoutSession,
  ]);

  const register = useCallback(async (data: RegisterPayload) => {
    const result = await api.register(data);
    return { detail: result.detail, approvalRequired: result.approvalRequired === true };
  }, []);

  const logout = useCallback(async () => {
    const organizationId = org?.id;
    const userId = user?.id;
    localIdentityOperationRef.current += 1;
    clearSession(false, false);
    const previousLogout = logoutBarrierRef.current;
    const remoteLogoutOperation = (async () => {
      await previousLogout;
      try {
        await api.logout();
      } catch {
        // Local session state must still clear if the network is unavailable.
      }
    })();
    // Only the remote cookie response is an identity barrier. Owner-explicit
    // offline cleanup may finish later without delaying the next sign-in.
    logoutBarrierRef.current = remoteLogoutOperation.catch(() => undefined);
    await logoutBarrierRef.current;
    if (organizationId && userId) {
      await clearQueuedInspectionsForOwner(organizationId, userId).catch(() => undefined);
    }
  }, [clearSession, org?.id, user?.id]);

  const setOrg = useCallback((next: Organization) => setOrgState(next), []);

  const permissionSet = useMemo(() => new Set(permissions), [permissions]);
  const homePath = platformAccess
    ? platformAccess.mfaEnrollmentRequired ? "/system/account" : "/system"
    : "/app";
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
    platformAccess,
    permissions: permissionSet,
    authError,
    sessionExpired,
    homePath,
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
    platformAccess,
    permissionSet,
    authError,
    sessionExpired,
    homePath,
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
