import type {
  Analytics,
  AppState,
  AuditEvent,
  AuthSession,
  CallStatus,
  DeviceSession,
  Inspection,
  Invitation,
  Invoice,
  InvoiceAttachment,
  Organization,
  Paginated,
  Payment,
  Profile,
  Role,
  Settings,
  User,
  UserStatus,
  VesselCall,
} from "../types";

const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
let csrfToken: string | null = null;
let csrfRequest: Promise<string> | null = null;

interface ErrorEnvelope {
  detail?: string;
  error?: string;
  errors?: Record<string, string[] | string>;
  requestId?: string;
}

export class ApiError extends Error {
  status: number;
  errors: Record<string, string[] | string>;
  requestId: string | null;

  constructor(
    message: string,
    status: number,
    errors: Record<string, string[] | string> = {},
    requestId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.errors = errors;
    this.requestId = requestId;
  }
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${encodeURIComponent(name)}=`;
  const match = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : null;
}

async function ensureCsrfToken(): Promise<string> {
  const cookieToken = readCookie("csrftoken");
  if (cookieToken) {
    csrfToken = cookieToken;
    return cookieToken;
  }
  if (csrfToken) return csrfToken;
  if (!csrfRequest) {
    csrfRequest = fetch(`${BASE}/api/auth/csrf`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as { csrfToken?: string };
        if (!response.ok || !body.csrfToken) {
          throw new ApiError("Could not establish a secure session", response.status || 500);
        }
        csrfToken = body.csrfToken;
        return body.csrfToken;
      })
      .finally(() => {
        csrfRequest = null;
      });
  }
  return csrfRequest;
}

function buildQuery(values: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  });
  const query = params.toString();
  return query ? `?${query}` : "";
}

interface RequestOptions extends RequestInit {
  suppressAuthExpired?: boolean;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!SAFE_METHODS.has(method)) {
    headers.set("X-CSRFToken", await ensureCsrfToken());
  }

  const response = await fetch(BASE + path, {
    ...options,
    method,
    headers,
    credentials: "include",
  });

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = response.status === 204
    ? null
    : isJson
      ? await response.json().catch(() => null)
      : await response.text().catch(() => null);

  if (!response.ok) {
    const envelope = (body && typeof body === "object" ? body : {}) as ErrorEnvelope;
    const authenticationMissing = response.status === 401
      || (
        response.status === 403
        && envelope.detail === "Authentication credentials were not provided."
      );
    if (authenticationMissing && !options.suppressAuthExpired && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("auth:expired"));
    }
    throw new ApiError(
      envelope.detail || envelope.error || `Request failed (${response.status})`,
      response.status,
      envelope.errors ?? {},
      envelope.requestId ?? response.headers.get("x-request-id"),
    );
  }
  return body as T;
}

export interface RegisterPayload {
  name: string;
  email: string;
  password: string;
  orgName: string;
  rcNumber?: string;
  phone?: string;
  address?: string;
  designatedPort?: string;
  ports?: string[];
}

export interface MfaChallenge {
  mfaRequired: true;
  challengeId: string;
}

export type LoginResult = AuthSession | MfaChallenge;

export interface UserListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: UserStatus | "all";
  role?: Role | "all";
}

export interface AuditListParams {
  page?: number;
  pageSize?: number;
  action?: string;
  actor?: string;
  search?: string;
}

export interface InspectionMutationResult {
  inspection: Inspection;
  invoice: Invoice | null;
  call: VesselCall | null;
  rev: number;
}

function fileBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read evidence file"));
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(file);
  });
}

async function uploadEvidenceFile(inspectionId: string, file: File): Promise<void> {
  const checksumBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", await fileBytes(file)),
  );
  const checksum = `sha256:${Array.from(checksumBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
  const prepared = await request<{
    uploadUrl: string;
    method: "PUT";
    headers?: Record<string, string>;
    objectKey: string;
    expiresAt: string;
  }>("/api/evidence/presign", {
    method: "POST",
    body: JSON.stringify({
      inspectionId,
      fileName: file.name,
      contentType: file.type,
      size: file.size,
      checksum,
    }),
  });
  const response = await fetch(prepared.uploadUrl, {
    method: "PUT",
    body: file,
    headers: prepared.headers,
  });
  if (!response.ok) throw new ApiError("Could not upload an evidence photo", response.status);
  await request("/api/evidence", {
    method: "POST",
    body: JSON.stringify({
      inspectionId,
      objectKey: prepared.objectKey,
      fileName: file.name,
      contentType: file.type,
      size: file.size,
      checksum,
    }),
  });
}

async function uploadInvoiceAttachment(invoiceId: string, file: File): Promise<void> {
  const allowed = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
  if (!allowed.includes(file.type) || file.size > 15 * 1024 * 1024) {
    throw new ApiError("Choose a PDF, PNG, JPEG, or WebP file no larger than 15 MB.", 400);
  }
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", await fileBytes(file)));
  const checksum = `sha256:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const prepared = await request<{ uploadUrl: string; method: "PUT"; headers?: Record<string, string>; objectKey: string }>("/api/invoice-attachments/presign", {
    method: "POST", body: JSON.stringify({ invoiceId, fileName: file.name, contentType: file.type, size: file.size, checksum }),
  });
  const response = await fetch(prepared.uploadUrl, { method: prepared.method, headers: prepared.headers, body: file });
  if (!response.ok) throw new ApiError("Could not upload the invoice file", response.status || 500);
  await request("/api/invoice-attachments", {
    method: "POST", body: JSON.stringify({ invoiceId, objectKey: prepared.objectKey, fileName: file.name, contentType: file.type, size: file.size, checksum }),
  });
}

export const api = {
  csrf: () => ensureCsrfToken(),

  register: (data: RegisterPayload) =>
    request<{ detail: string; verificationRequired: true }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
      suppressAuthExpired: true,
    }),
  verifyEmail: (token: string) =>
    request<{ detail: string }>("/api/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token }),
      suppressAuthExpired: true,
    }),
  resendVerification: (email: string) =>
    request<{ detail: string }>("/api/auth/resend-verification", {
      method: "POST",
      body: JSON.stringify({ email }),
      suppressAuthExpired: true,
    }),
  login: (email: string, password: string) =>
    request<LoginResult>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
      suppressAuthExpired: true,
    }),
  verifyMfaChallenge: (challengeId: string, code: string) =>
    request<AuthSession>("/api/auth/mfa/verify", {
      method: "POST",
      body: JSON.stringify({ challengeId, code }),
      suppressAuthExpired: true,
    }),
  me: () => request<AuthSession>("/api/auth/me", { suppressAuthExpired: true }),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  forgotPassword: (email: string) =>
    request<{ detail: string }>("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
      suppressAuthExpired: true,
    }),
  resetPassword: (token: string, password: string) =>
    request<{ detail: string }>("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password }),
      suppressAuthExpired: true,
    }),
  changePassword: (currentPassword: string, password: string) =>
    request<{ detail: string }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, password }),
    }),

  profile: () => request<{ user: Profile }>("/api/profile"),
  updateProfile: (
    patch: Pick<Profile, "name" | "email"> & { currentPassword?: string },
  ) =>
    request<{ user: Profile; verificationRequired: boolean }>("/api/profile", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  sessions: () => request<{ results: DeviceSession[] }>("/api/auth/sessions"),
  revokeSession: (id: string) => request<void>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  signOutEverywhere: () => request<void>("/api/auth/sessions/sign-out-everywhere", { method: "POST" }),

  setupMfa: (currentPassword: string) =>
    request<{ secret: string; provisioningUri: string }>("/api/auth/mfa/setup", {
      method: "POST",
      body: JSON.stringify({ currentPassword }),
    }),
  confirmMfa: (code: string) =>
    request<{ recoveryCodes: string[] }>("/api/auth/mfa/confirm", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  regenerateRecoveryCodes: () =>
    request<{ recoveryCodes: string[] }>("/api/auth/mfa/recovery-codes", { method: "POST" }),
  disableMfa: (password: string) =>
    request<void>("/api/auth/mfa", { method: "DELETE", body: JSON.stringify({ password }) }),

  users: (params: UserListParams = {}) =>
    request<Paginated<User>>(`/api/users${buildQuery({
      page: params.page,
      pageSize: params.pageSize,
      search: params.search,
      status: params.status === "all" ? undefined : params.status,
      role: params.role === "all" ? undefined : params.role,
    })}`),
  updateUser: (id: string, patch: Partial<Pick<User, "name" | "role" | "status">>) =>
    request<{ user: User; rev: number }>(`/api/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  removeUser: (id: string) => request<void>(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" }),
  sendUserPasswordReset: (id: string) =>
    request<{ detail: string }>(`/api/users/${encodeURIComponent(id)}/send-password-reset`, { method: "POST" }),
  resetUserMfa: (id: string) =>
    request<{ detail: string }>(`/api/users/${encodeURIComponent(id)}/reset-mfa`, { method: "POST" }),

  invitations: (params: Pick<UserListParams, "page" | "pageSize" | "search" | "role"> = {}) =>
    request<Paginated<Invitation>>(`/api/invitations${buildQuery({
      page: params.page,
      pageSize: params.pageSize,
      search: params.search,
      role: params.role === "all" ? undefined : params.role,
    })}`),
  inviteUser: (data: { name: string; email: string; role: Role }) =>
    request<Invitation>("/api/invitations", { method: "POST", body: JSON.stringify(data) }),
  resendInvitation: (id: string) =>
    request<Invitation>(`/api/invitations/${encodeURIComponent(id)}/resend`, { method: "POST" }),
  revokeInvitation: (id: string) =>
    request<void>(`/api/invitations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  acceptInvitation: (data: { token: string; name: string; password: string }) =>
    request<{ detail: string }>("/api/invitations/accept", {
      method: "POST",
      body: JSON.stringify(data),
      suppressAuthExpired: true,
    }),

  audit: (params: AuditListParams = {}) =>
    request<Paginated<AuditEvent>>(`/api/audit${buildQuery({
      page: params.page,
      pageSize: params.pageSize,
      action: params.action,
      actor: params.actor,
      search: params.search,
    })}`),
  auditExportUrl: (params: AuditListParams = {}) => `${BASE}/api/audit/export${buildQuery({
    page: params.page,
    pageSize: params.pageSize,
    action: params.action,
    actor: params.actor,
    search: params.search,
  })}`,

  state: (rev?: number) => request<AppState>(`/api/state${buildQuery({ rev })}`),
  poll: (rev: number) => request<AppState | { changed: false; rev: number }>(`/api/state${buildQuery({ rev })}`),
  updateOrganization: (patch: Partial<Organization>) =>
    request<{ org: Organization; rev: number }>("/api/organization", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  uploadOrganizationLogo: async (file: File) => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) throw new ApiError("Choose a PNG, JPEG, or WebP image no larger than 2 MB.", 400);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await fileBytes(file)));
    const checksum = `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    const prepared = await request<{ uploadUrl: string; method: "PUT"; headers: Record<string, string>; objectKey: string }>("/api/organization/logo", { method: "POST", body: JSON.stringify({ fileName: file.name, contentType: file.type, size: file.size, checksum }) });
    let objectKey = prepared.objectKey;
    try {
      const uploaded = await fetch(prepared.uploadUrl, { method: prepared.method, headers: prepared.headers, body: file });
      if (!uploaded.ok) throw new ApiError("Direct private upload was rejected", uploaded.status || 500);
    } catch {
      // A private Space may deliberately have no browser CORS policy.  Logos
      // are capped at 2 MB, so use the authenticated same-origin fallback
      // instead of exposing the bucket or failing the organization setting.
      const form = new FormData();
      form.append("file", file, file.name);
      const fallback = await request<{ objectKey: string }>("/api/organization/logo/content", {
        method: "POST",
        body: form,
      });
      objectKey = fallback.objectKey;
    }
    return request<{ downloadUrl: string }>("/api/organization/logo", { method: "PUT", body: JSON.stringify({ fileName: file.name, contentType: file.type, size: file.size, checksum, objectKey }) });
  },
  removeOrganizationLogo: () => request<void>("/api/organization/logo", { method: "DELETE" }),
  invoiceStatusSteps: () => request<{ steps: import("../types").InvoiceWorkflowStatus[] }>("/api/invoice-status-steps"),
  createInvoiceStatusStep: (data: { label: string; code?: string; active?: boolean }) => request<{ step: import("../types").InvoiceWorkflowStatus; rev: number }>("/api/invoice-status-steps", { method: "POST", body: JSON.stringify(data) }),
  updateInvoiceStatusStep: (id: string, data: { label?: string; active?: boolean }) => request<{ step: import("../types").InvoiceWorkflowStatus; rev: number }>(`/api/invoice-status-steps/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(data) }),
  reorderInvoiceStatusSteps: (ids: string[]) => request<{ steps: import("../types").InvoiceWorkflowStatus[]; rev: number }>("/api/invoice-status-steps/reorder", { method: "POST", body: JSON.stringify({ ids }) }),
  transitionInvoice: (id: string, data: { statusId: string; note?: string }) => request<{ invoice: Invoice; rev: number }>(`/api/invoices/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify(data) }),
  invoiceAttachments: (id: string) => request<{ results: InvoiceAttachment[] }>(`/api/invoices/${encodeURIComponent(id)}/attachments`),
  uploadInvoiceAttachment,
  invoiceAttachment: (id: string) => request<{ attachment: InvoiceAttachment; downloadUrl: string }>(`/api/invoice-attachments/${encodeURIComponent(id)}`),
  removeInvoiceAttachment: (id: string) => request<{ rev: number }>(`/api/invoice-attachments/${encodeURIComponent(id)}`, { method: "DELETE" }),

  createCall: (data: Partial<VesselCall>) =>
    request<{ call: VesselCall; rev: number }>("/api/vessel-calls", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateCall: (id: string, patch: Partial<VesselCall> & { version?: number }) =>
    request<{ call: VesselCall; rev: number }>(`/api/vessel-calls/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  updateCallStatus: (
    id: string,
    data: { status: Exclude<CallStatus, "cancelled">; berth?: string; berthDate?: string | null; version?: number },
  ) =>
    request<{ call: VesselCall; rev: number }>(`/api/vessel-calls/${encodeURIComponent(id)}/status`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  cancelCall: (id: string, reason: string, version?: number) =>
    request<{ call: VesselCall; rev: number }>(`/api/vessel-calls/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason, version }),
    }),
  createInspection: async (
    data: Record<string, unknown>,
    options: { idempotencyKey?: string; evidenceFiles?: File[] } = {},
  ): Promise<InspectionMutationResult> => {
    const shouldFinalize = data.status === "completed";
    const payload = { ...data };
    delete payload.status;
    const created = await request<{ inspection: Inspection; rev: number }>(
      "/api/inspections",
      {
        method: "POST",
        headers: options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : undefined,
        body: JSON.stringify(payload),
      },
    );
    if (options.evidenceFiles?.length) {
      await Promise.all(options.evidenceFiles.map((file) => uploadEvidenceFile(created.inspection.id, file)));
    }
    if (shouldFinalize) {
      return request<InspectionMutationResult>(
        `/api/inspections/${encodeURIComponent(created.inspection.id)}/finalize`,
        {
          method: "POST",
          body: JSON.stringify({ version: created.inspection.version }),
        },
      );
    }
    return {
      inspection: created.inspection,
      invoice: null,
      call: null,
      rev: created.rev,
    };
  },
  inspection: (id: string) =>
    request<{ inspection: Inspection }>(`/api/inspections/${encodeURIComponent(id)}`),
  updateInspection: async (
    id: string,
    patch: Record<string, unknown>,
    evidenceFiles: File[] = [],
  ): Promise<{ inspection: Inspection; rev: number }> => {
    const result = await request<{ inspection: Inspection; rev: number }>(
      `/api/inspections/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    );
    if (evidenceFiles.length) {
      await Promise.all(evidenceFiles.map((file) => uploadEvidenceFile(result.inspection.id, file)));
    }
    return result;
  },
  finalizeInspection: (id: string, version?: number) =>
    request<InspectionMutationResult>(`/api/inspections/${encodeURIComponent(id)}/finalize`, {
      method: "POST",
      body: JSON.stringify({ version }),
    }),
  recordPayment: (
    invoiceId: string,
    data: { paidOn: string; method: string; reference: string; amount?: number },
  ) =>
    request<{ payment: Payment; invoice: Invoice; rev: number }>(
      `/api/invoices/${encodeURIComponent(invoiceId)}/payments`,
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    ),
  reversePayment: (paymentId: string, reason: string) =>
    request<{ payment: Payment; invoice: Invoice; rev: number }>(
      `/api/payments/${encodeURIComponent(paymentId)}/reverse`,
      {
        method: "POST",
        body: JSON.stringify({ reason }),
      },
    ),
  updateSettings: (patch: Partial<Settings>) =>
    request<{ settings: Settings; rev: number }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  analytics: (months = 12) => request<Analytics>(`/api/analytics${buildQuery({ months })}`),

  invoicePdfUrl: (id: string) => `${BASE}/api/invoices/${encodeURIComponent(id)}/document`,
  inspectionPdfUrl: (id: string) => `${BASE}/api/inspections/${encodeURIComponent(id)}/document`,
  vesselCallPdfUrl: (id: string) => `${BASE}/api/vessel-calls/${encodeURIComponent(id)}/document`,
};

export function resetApiSecurityStateForTests(): void {
  csrfToken = null;
  csrfRequest = null;
}
