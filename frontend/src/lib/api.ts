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
  InvoiceWorkflowStatus,
  InvoiceWorkflowStatusUpdate,
  Organization,
  Paginated,
  Payment,
  PlatformAuditEvent,
  PlatformAccess,
  PlatformOrganization,
  PlatformOrganizationDetail,
  PlatformOrganizationSummary,
  PlatformOrganizationStatus,
  PlatformOverview,
  Profile,
  Role,
  RoleDefinition,
  Settings,
  User,
  UserStatus,
  VesselCall,
} from "../types";
import {
  advanceAuthSessionEpoch,
  currentAuthSessionEpoch,
  publishAuthSessionBoundary,
  publishAuthSessionTransitionSettled,
  publishAuthSessionTransitionStart,
  resetAuthSessionEpochForTests,
} from "./authSessionEpoch";

const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
let csrfToken: string | null = null;
let csrfRequest: Promise<string> | null = null;
let csrfRequestController: AbortController | null = null;
let authCookieMutationQueue: Promise<void> = Promise.resolve();
let activeAuthSessionTransitions = 0;
const AUTH_COOKIE_LOCK_NAME = "vessel-caller:auth-cookie-response";
const AUTH_COOKIE_REQUEST_TIMEOUT_MS = 15_000;

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

export function createIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function idempotencyHeaders(key: string): HeadersInit {
  return { "Idempotency-Key": key };
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${encodeURIComponent(name)}=`;
  const match = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : null;
}

function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function ensureCsrfToken(signal?: AbortSignal): Promise<string> {
  const cookieToken = readCookie("csrftoken");
  if (cookieToken) {
    csrfToken = cookieToken;
    return cookieToken;
  }
  if (csrfToken) return csrfToken;
  if (!csrfRequest) {
    csrfRequestController = new AbortController();
    const controller = csrfRequestController;
    const timeout = globalThis.setTimeout(() => {
      controller.abort(new DOMException("The CSRF bootstrap timed out", "TimeoutError"));
    }, AUTH_COOKIE_REQUEST_TIMEOUT_MS);
    csrfRequest = fetch(`${BASE}/api/auth/csrf`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: controller.signal,
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
        globalThis.clearTimeout(timeout);
        csrfRequest = null;
        csrfRequestController = null;
      });
  }
  return waitWithAbort(csrfRequest, signal);
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
  advancesAuthSessionEpoch?: boolean;
  broadcastsIdentityTransition?: boolean;
  onAuthSessionEpoch?: (epoch: number) => void;
  serializesAuthCookie?: boolean;
  suppressAuthExpired?: boolean;
}

async function performRequest<T>(path: string, options: RequestOptions): Promise<T> {
  const requestAuthSessionEpoch = currentAuthSessionEpoch();
  const {
    advancesAuthSessionEpoch = false,
    broadcastsIdentityTransition: _broadcastsIdentityTransition = false,
    onAuthSessionEpoch,
    serializesAuthCookie: _serializesAuthCookie = false,
    suppressAuthExpired = false,
    ...fetchOptions
  } = options;
  onAuthSessionEpoch?.(requestAuthSessionEpoch);
  const method = (fetchOptions.method ?? "GET").toUpperCase();
  const headers = new Headers(fetchOptions.headers);
  headers.set("Accept", "application/json");
  if (fetchOptions.body && !(fetchOptions.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!SAFE_METHODS.has(method)) {
    headers.set("X-CSRFToken", await ensureCsrfToken(fetchOptions.signal ?? undefined));
  }

  const response = await fetch(BASE + path, {
    ...fetchOptions,
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
    if (
      authenticationMissing
      && !suppressAuthExpired
      && activeAuthSessionTransitions === 0
      && requestAuthSessionEpoch === currentAuthSessionEpoch()
      && typeof window !== "undefined"
    ) {
      window.dispatchEvent(new CustomEvent("auth:expired"));
    }
    throw new ApiError(
      envelope.detail || envelope.error || `Request failed (${response.status})`,
      response.status,
      envelope.errors ?? {},
      envelope.requestId ?? response.headers.get("x-request-id"),
    );
  }
  if (
    advancesAuthSessionEpoch
  ) {
    // The response installed a rotated Django session cookie. Establish the
    // new boundary before callers can start or settle work against the old one.
    publishAuthSessionBoundary(true);
  }
  return body as T;
}

export function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const tracksAuthTransition = options.advancesAuthSessionEpoch === true;
  if (tracksAuthTransition) {
    // Suppress responses tied to the pre-rotation cookie from the moment the
    // logical transition begins. The browser may install Set-Cookie before the
    // response body promise settles.
    advanceAuthSessionEpoch();
    activeAuthSessionTransitions += 1;
  }
  const settleTransition = (operation: Promise<T>) => operation.finally(() => {
    if (tracksAuthTransition) activeAuthSessionTransitions -= 1;
  });

  if (!options.serializesAuthCookie) {
    return settleTransition(performRequest<T>(path, options));
  }

  // Start one deadline before entering either the tab-local queue or the
  // origin-wide Web Lock. A suspended lock owner can therefore never block a
  // later sign-in or sign-out indefinitely.
  const controller = new AbortController();
  const callerSignal = options.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = globalThis.setTimeout(() => {
    controller.abort(new DOMException("The secure session request timed out", "TimeoutError"));
  }, AUTH_COOKIE_REQUEST_TIMEOUT_MS);

  const performBoundedRequest = () => performRequest<T>(path, {
    ...options,
    signal: controller.signal,
  });

  const performWithOriginLock = () => {
    const lockManager = typeof navigator === "undefined"
      ? undefined
      : (navigator as unknown as {
        locks?: {
          request: <Result>(
            name: string,
            options: LockOptions,
            callback: () => Promise<Result>,
          ) => Promise<Result>;
        };
      }).locks;
    const performIdentityTransition = async () => {
      // Clear peer identity-bound UI before the request can install a different
      // origin-wide cookie. Peers wait for the matching settled event before
      // rehydrating, and their /me request then queues behind this Web Lock.
      const transitionId = options.broadcastsIdentityTransition
        ? publishAuthSessionTransitionStart()
        : null;
      try {
        return await performBoundedRequest();
      } finally {
        if (transitionId) publishAuthSessionTransitionSettled(transitionId);
      }
    };
    if (!lockManager?.request) return performIdentityTransition();
    // Web Locks coordinate the origin-wide HttpOnly cookie across tabs. The
    // Promise queue below preserves call order and is the fallback on browsers
    // without Web Locks support.
    return lockManager.request<T>(
      AUTH_COOKIE_LOCK_NAME,
      { mode: "exclusive", signal: controller.signal },
      performIdentityTransition,
    );
  };

  const operation = authCookieMutationQueue.then(
    performWithOriginLock,
    performWithOriginLock,
  );
  authCookieMutationQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return settleTransition(operation.finally(() => {
    globalThis.clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }));
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

export interface SystemAuditParams extends AuditListParams {
  organizationId?: string;
}

export interface SystemOrganizationListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: PlatformOrganizationStatus | "all";
  primaryPort?: string;
  registered?: boolean;
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
    request<{ detail: string; verificationRequired: true; approvalRequired: boolean }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
      suppressAuthExpired: true,
    }),
  verifyEmail: (token: string) =>
    request<{ detail: string; approvalPending: boolean }>("/api/auth/verify-email", {
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
      broadcastsIdentityTransition: true,
      method: "POST",
      serializesAuthCookie: true,
      body: JSON.stringify({ email, password }),
      suppressAuthExpired: true,
    }),
  verifyMfaChallenge: (challengeId: string, code: string) =>
    request<AuthSession>("/api/auth/mfa/verify", {
      broadcastsIdentityTransition: true,
      method: "POST",
      serializesAuthCookie: true,
      body: JSON.stringify({ challengeId, code }),
      suppressAuthExpired: true,
    }),
  me: (onAuthSessionEpoch?: (epoch: number) => void) => request<AuthSession>("/api/auth/me", {
    onAuthSessionEpoch,
    serializesAuthCookie: true,
    suppressAuthExpired: true,
  }),
  logout: () => request<void>("/api/auth/logout", {
    broadcastsIdentityTransition: true,
    method: "POST",
    serializesAuthCookie: true,
    suppressAuthExpired: true,
  }),
  forgotPassword: (email: string) =>
    request<{ detail: string }>("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
      suppressAuthExpired: true,
    }),
  resetPassword: (token: string, password: string) =>
    request<{ detail: string }>("/api/auth/reset-password", {
      advancesAuthSessionEpoch: true,
      broadcastsIdentityTransition: true,
      method: "POST",
      serializesAuthCookie: true,
      body: JSON.stringify({ token, password }),
      suppressAuthExpired: true,
    }),
  changePassword: (currentPassword: string, password: string) =>
    request<{ detail: string }>("/api/auth/change-password", {
      advancesAuthSessionEpoch: true,
      method: "POST",
      serializesAuthCookie: true,
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
  revokeSession: (id: string) => request<void>(`/api/auth/sessions/${encodeURIComponent(id)}`, {
    advancesAuthSessionEpoch: true,
    method: "DELETE",
    serializesAuthCookie: true,
  }),
  signOutEverywhere: () => request<void>("/api/auth/sessions/sign-out-everywhere", {
    advancesAuthSessionEpoch: true,
    method: "POST",
    serializesAuthCookie: true,
  }),

  setupMfa: (currentPassword: string) =>
    request<{ secret: string; provisioningUri: string }>("/api/auth/mfa/setup", {
      method: "POST",
      serializesAuthCookie: true,
      body: JSON.stringify({ currentPassword }),
    }),
  confirmMfa: (code: string) =>
    request<{ recoveryCodes: string[] }>("/api/auth/mfa/confirm", {
      method: "POST",
      serializesAuthCookie: true,
      body: JSON.stringify({ code }),
    }),
  regenerateRecoveryCodes: (code: string) =>
    request<{ recoveryCodes: string[] }>("/api/auth/mfa/recovery-codes", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
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
  roleDefinitions: () => request<{ roles: RoleDefinition[] }>("/api/roles"),
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

  systemOverview: () => request<PlatformOverview>("/api/system/overview"),
  systemStepUp: (code: string) => request<{ detail: string; platformAccess: PlatformAccess }>(
    "/api/system/step-up",
    { method: "POST", serializesAuthCookie: true, body: JSON.stringify({ code }) },
  ),
  systemOrganizations: (params: SystemOrganizationListParams = {}) =>
    request<Paginated<PlatformOrganizationSummary>>(`/api/system/organizations${buildQuery({
      page: params.page,
      pageSize: params.pageSize,
      search: params.search,
      status: params.status === "all" ? undefined : params.status,
      primaryPort: params.primaryPort,
      registered: params.registered == null ? undefined : String(params.registered),
    })}`),
  systemOrganization: (id: string) =>
    request<PlatformOrganizationDetail>(`/api/system/organizations/${encodeURIComponent(id)}`),
  createSystemOrganization: (data: {
    name: string;
    rcNumber?: string;
    email?: string;
    phone?: string;
    address?: string;
    primaryPort: string;
    ports?: string[];
    initialAdmin: { name: string; email: string };
  }, idempotencyKey: string) => request<{ organization: PlatformOrganization; rev: number; invitation?: Invitation }>(
    "/api/system/organizations",
    { method: "POST", headers: idempotencyHeaders(idempotencyKey), body: JSON.stringify(data) },
  ),
  updateSystemOrganization: (
    id: string,
    data: Partial<Pick<PlatformOrganization, "name" | "rcNumber" | "email" | "phone" | "address" | "primaryPort" | "ports">> & { revision: number },
    idempotencyKey: string,
  ) => request<{ organization: PlatformOrganization; rev: number }>(
    `/api/system/organizations/${encodeURIComponent(id)}`,
    { method: "PATCH", headers: idempotencyHeaders(idempotencyKey), body: JSON.stringify(data) },
  ),
  approveSystemOrganization: (id: string, reason: string, revision: number, idempotencyKey: string) =>
    request<{ organization: PlatformOrganization; rev: number }>(
      `/api/system/organizations/${encodeURIComponent(id)}/approve`,
      { method: "POST", headers: idempotencyHeaders(idempotencyKey), body: JSON.stringify({ reason, revision }) },
    ),
  suspendSystemOrganization: (id: string, reason: string, revision: number, idempotencyKey: string) =>
    request<{ organization: PlatformOrganization; rev: number }>(
      `/api/system/organizations/${encodeURIComponent(id)}/suspend`,
      { method: "POST", headers: idempotencyHeaders(idempotencyKey), body: JSON.stringify({ reason, revision }) },
    ),
  reactivateSystemOrganization: (id: string, reason: string, revision: number, idempotencyKey: string) =>
    request<{ organization: PlatformOrganization; rev: number }>(
      `/api/system/organizations/${encodeURIComponent(id)}/reactivate`,
      { method: "POST", headers: idempotencyHeaders(idempotencyKey), body: JSON.stringify({ reason, revision }) },
    ),
  systemOrganizationUsers: (id: string, params: UserListParams = {}) =>
    request<Paginated<User>>(`/api/system/organizations/${encodeURIComponent(id)}/users${buildQuery({
      page: params.page,
      pageSize: params.pageSize,
      search: params.search,
      status: params.status === "all" ? undefined : params.status,
      role: params.role === "all" ? undefined : params.role,
    })}`),
  systemOrganizationInvitations: (id: string, params: Pick<UserListParams, "page" | "pageSize"> = {}) =>
    request<Paginated<Invitation>>(`/api/system/organizations/${encodeURIComponent(id)}/invitations${buildQuery({
      page: params.page,
      pageSize: params.pageSize,
    })}`),
  inviteSystemOrganizationAdmin: (id: string, data: { name: string; email: string }, idempotencyKey: string) =>
    request<{ invitation: Invitation; rev: number }>(`/api/system/organizations/${encodeURIComponent(id)}/invitations`, {
      method: "POST",
      headers: idempotencyHeaders(idempotencyKey),
      body: JSON.stringify(data),
    }),
  resendSystemOrganizationInvitation: (organizationId: string, invitationId: string, idempotencyKey: string) =>
    request<{ invitation: Invitation; rev: number }>(
      `/api/system/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}/resend`,
      { method: "POST", headers: idempotencyHeaders(idempotencyKey) },
    ),
  revokeSystemOrganizationInvitation: (organizationId: string, invitationId: string, idempotencyKey: string) =>
    request<{ invitation: Invitation; rev: number }>(
      `/api/system/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: "DELETE", headers: idempotencyHeaders(idempotencyKey) },
    ),
  sendSystemAdminPasswordReset: (organizationId: string, userId: string, reason: string, idempotencyKey: string) =>
    request<{ detail: string; rev: number }>(
      `/api/system/organizations/${encodeURIComponent(organizationId)}/users/${encodeURIComponent(userId)}/send-password-reset`,
      { method: "POST", headers: idempotencyHeaders(idempotencyKey), body: JSON.stringify({ reason }) },
    ),
  resetSystemAdminMfa: (organizationId: string, userId: string, reason: string, idempotencyKey: string) =>
    request<{ user: User; rev: number }>(
      `/api/system/organizations/${encodeURIComponent(organizationId)}/users/${encodeURIComponent(userId)}/reset-mfa`,
      { method: "POST", headers: idempotencyHeaders(idempotencyKey), body: JSON.stringify({ reason }) },
    ),
  systemOrganizationAudit: (id: string, params: AuditListParams = {}) =>
    request<Paginated<PlatformAuditEvent>>(`/api/system/organizations/${encodeURIComponent(id)}/audit${buildQuery({
      page: params.page,
      pageSize: params.pageSize,
      action: params.action,
      actor: params.actor,
      search: params.search,
    })}`),
  systemAudit: (params: AuditListParams = {}) =>
    request<Paginated<PlatformAuditEvent>>(`/api/system/audit${buildQuery({
      page: params.page,
      pageSize: params.pageSize,
      action: params.action,
      actor: params.actor,
      search: params.search,
    })}`),
  systemAuditExportUrl: (params: SystemAuditParams = {}) => `${BASE}/api/system/audit/export${buildQuery({
    organizationId: params.organizationId,
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
  invoiceStatusSteps: () => request<{ steps: InvoiceWorkflowStatus[] }>("/api/invoice-status-steps"),
  createInvoiceStatusStep: (data: { label: string; code?: string; active?: boolean }) => request<{ step: InvoiceWorkflowStatus; rev: number }>("/api/invoice-status-steps", { method: "POST", body: JSON.stringify(data) }),
  updateInvoiceStatusStep: (id: string, data: InvoiceWorkflowStatusUpdate) => request<{ step: InvoiceWorkflowStatus; rev: number }>(`/api/invoice-status-steps/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(data) }),
  reorderInvoiceStatusSteps: (ids: string[]) => request<{ steps: InvoiceWorkflowStatus[]; rev: number }>("/api/invoice-status-steps/reorder", { method: "POST", body: JSON.stringify({ ids }) }),
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
  csrfRequestController?.abort();
  csrfToken = null;
  csrfRequest = null;
  csrfRequestController = null;
  authCookieMutationQueue = Promise.resolve();
  activeAuthSessionTransitions = 0;
  resetAuthSessionEpochForTests();
}
