// Typed API client. Talks to the FastAPI backend; attaches the JWT bearer
// token; on a 401 it clears the session and signals the app to log out.
import type {
  Analytics, AppState, Invoice, Member, Organization, Role, Session, Settings, VesselCall,
} from "../types";

const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");
const TOKEN_KEY = "vessel-caller:token";

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable */ }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(BASE + path, { ...options, headers });
  let body: any = null;
  try { body = await res.json(); } catch { /* empty / non-JSON */ }

  if (res.status === 401) {
    setToken(null);
    window.dispatchEvent(new CustomEvent("auth:expired"));
  }
  if (!res.ok) {
    throw new ApiError((body && (body.detail || body.error)) || `Request failed (${res.status})`, res.status);
  }
  return body as T;
}

// ---- auth ----
export interface RegisterPayload {
  name: string; email: string; password: string; orgName: string;
  rcNumber?: string; phone?: string; address?: string; designatedPort?: string; ports?: string[];
}
export const api = {
  register: (data: RegisterPayload) =>
    request<{ token: string; user: Session["user"]; org: Organization }>(
      "/api/auth/register", { method: "POST", body: JSON.stringify(data) }),

  login: (email: string, password: string) =>
    request<{ token: string; user: Session["user"] }>(
      "/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),

  me: () => request<{ user: Session["user"]; org: Organization }>("/api/auth/me"),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),

  // ---- state ----
  state: (rev?: number) =>
    request<AppState>(`/api/state${rev != null ? `?rev=${rev}` : ""}`),
  poll: (rev: number) =>
    request<AppState | { changed: false; rev: number }>(`/api/state?rev=${rev}`),

  // ---- organization / team ----
  updateOrganization: (patch: Partial<Organization>) =>
    request<{ org: Organization; rev: number }>("/api/organization", { method: "PUT", body: JSON.stringify(patch) }),
  addMember: (m: { name: string; email: string; password: string; role: Role }) =>
    request<{ member: Member; rev: number }>("/api/organization/members", { method: "POST", body: JSON.stringify(m) }),
  updateMember: (id: string, patch: Partial<{ name: string; role: Role; active: boolean; password: string }>) =>
    request<{ member: Member; rev: number }>(`/api/organization/members/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  removeMember: (id: string) =>
    request<{ ok: boolean; rev: number }>(`/api/organization/members/${id}`, { method: "DELETE" }),

  // ---- operations ----
  createCall: (data: Partial<VesselCall>) =>
    request<{ call: VesselCall; rev: number }>("/api/vessel-calls", { method: "POST", body: JSON.stringify(data) }),
  deleteCall: (id: string) =>
    request<{ ok: boolean; rev: number }>(`/api/vessel-calls/${id}`, { method: "DELETE" }),
  createInspection: (data: Record<string, unknown>) =>
    request<{ inspection: any; invoice: Invoice | null; call: VesselCall; rev: number }>(
      "/api/inspections", { method: "POST", body: JSON.stringify(data) }),
  updateInvoice: (id: string, patch: Record<string, unknown>) =>
    request<{ invoice: Invoice; rev: number }>(`/api/invoices/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  updateSettings: (patch: Partial<Settings>) =>
    request<{ settings: Settings; rev: number }>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),

  analytics: (months = 12) => request<Analytics>(`/api/analytics?months=${months}`),
};
