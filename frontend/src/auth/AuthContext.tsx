// Auth state: token + current user + org, with real login/register/logout.
// Boots by validating any stored token via /api/auth/me; auto-logs-out on 401.
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from "react";

import { api, getToken, setToken, type RegisterPayload } from "../lib/api";
import type { Organization, Role, User } from "../types";

type Status = "loading" | "authenticated" | "anonymous";

interface AuthValue {
  status: Status;
  user: User | null;
  org: Organization | null;
  login: (email: string, password: string) => Promise<void>;
  register: (data: RegisterPayload) => Promise<void>;
  logout: () => void;
  setOrg: (org: Organization) => void;
  can: (action: Action) => boolean;
}

// Client-side mirror of the server's role rules (the server is authoritative).
export type Action =
  | "registerCall" | "cancelCall" | "addInspection"
  | "recordPayment" | "manageSettings" | "manageTeam";
const PERMS: Record<Action, Role[]> = {
  registerCall: ["Admin", "Operations"],
  cancelCall: ["Admin", "Operations"],
  addInspection: ["Admin", "Operations"],
  recordPayment: ["Admin", "Finance"],
  manageSettings: ["Admin"],
  manageTeam: ["Admin"],
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(() => (getToken() ? "loading" : "anonymous"));
  const [user, setUser] = useState<User | null>(null);
  const [org, setOrgState] = useState<Organization | null>(null);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setOrgState(null);
    setStatus("anonymous");
  }, []);

  // Validate a stored token on first load.
  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    api.me()
      .then(({ user, org }) => {
        if (cancelled) return;
        setUser(user); setOrgState(org); setStatus("authenticated");
      })
      .catch(() => { if (!cancelled) logout(); });
    return () => { cancelled = true; };
  }, [logout]);

  // Any 401 anywhere ends the session.
  useEffect(() => {
    const onExpired = () => logout();
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
  }, [logout]);

  const login = useCallback(async (email: string, password: string) => {
    const { token } = await api.login(email, password);
    setToken(token);
    const me = await api.me();
    setUser(me.user); setOrgState(me.org); setStatus("authenticated");
  }, []);

  const register = useCallback(async (data: RegisterPayload) => {
    const { token, user, org } = await api.register(data);
    setToken(token);
    setUser(user); setOrgState(org); setStatus("authenticated");
  }, []);

  const setOrg = useCallback((next: Organization) => setOrgState(next), []);

  const can = useCallback(
    (action: Action) => !!user && PERMS[action].includes(user.role),
    [user],
  );

  const value = useMemo<AuthValue>(
    () => ({ status, user, org, login, register, logout, setOrg, can }),
    [status, user, org, login, register, logout, setOrg, can],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
