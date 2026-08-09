import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, request, resetApiSecurityStateForTests } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("session API client", () => {
  beforeEach(() => {
    resetApiSecurityStateForTests();
    document.cookie = "csrftoken=; Max-Age=0; path=/";
  });

  it("uses same-origin credentials and bootstraps CSRF before unsafe requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "secure-csrf" }))
      .mockResolvedValueOnce(jsonResponse({ detail: "ok" }));

    await request("/api/example", { method: "POST", body: JSON.stringify({ value: 1 }) });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/csrf");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "include" });
    const requestOptions = fetchMock.mock.calls[1][1] as RequestInit;
    expect(requestOptions.credentials).toBe("include");
    expect(new Headers(requestOptions.headers).get("X-CSRFToken")).toBe("secure-csrf");
    expect(new Headers(requestOptions.headers).get("Authorization")).toBeNull();
  });

  it("does not bootstrap CSRF for safe reads", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ ok: true }));

    await request("/api/example");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(options.headers).has("X-CSRFToken")).toBe(false);
  });

  it("surfaces the standard Django error envelope", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      detail: "Validation failed",
      errors: { email: ["Already in use"] },
      requestId: "req-42",
    }, 400));

    await expect(request("/api/example")).rejects.toMatchObject({
      message: "Validation failed",
      status: 400,
      errors: { email: ["Already in use"] },
      requestId: "req-42",
    });
  });

  it("returns an MFA challenge without storing a bearer token", async () => {
    document.cookie = "csrftoken=csrf-cookie; path=/";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      mfaRequired: true,
      challengeId: "challenge-1",
    }, 202));

    await expect(api.login("admin@example.com", "correct horse battery staple")).resolves.toEqual({
      mfaRequired: true,
      challengeId: "challenge-1",
    });
  });

  it("coalesces concurrent CSRF bootstraps", async () => {
    let csrfCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/api/auth/csrf") {
        csrfCalls += 1;
        await Promise.resolve();
        return jsonResponse({ csrfToken: "shared-token" });
      }
      return jsonResponse({ ok: true });
    });

    await Promise.all([
      request("/api/first", { method: "POST", body: "{}" }),
      request("/api/second", { method: "PATCH", body: "{}" }),
    ]);

    expect(csrfCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls.slice(1)) {
      expect(new Headers(call[1]?.headers).get("X-CSRFToken")).toBe("shared-token");
    }
  });

  it("announces an expired authenticated session on a 401 response", async () => {
    const expired = vi.fn();
    window.addEventListener("auth:expired", expired);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ detail: "Session expired" }, 401));

    await expect(request("/api/state")).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledOnce();

    window.removeEventListener("auth:expired", expired);
  });

  it("recognizes DRF's anonymous 403 without treating other forbidden responses as expiry", async () => {
    const expired = vi.fn();
    window.addEventListener("auth:expired", expired);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        detail: "Authentication credentials were not provided.",
      }, 403))
      .mockResolvedValueOnce(jsonResponse({
        detail: "CSRF validation failed",
      }, 403));

    await expect(request("/api/state")).rejects.toMatchObject({ status: 403 });
    expect(expired).toHaveBeenCalledOnce();
    await expect(request("/api/state")).rejects.toMatchObject({ status: 403 });
    expect(expired).toHaveBeenCalledOnce();

    window.removeEventListener("auth:expired", expired);
  });

  it("does not announce expiry for an expected anonymous login failure", async () => {
    document.cookie = "csrftoken=csrf-cookie; path=/";
    const expired = vi.fn();
    window.addEventListener("auth:expired", expired);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ detail: "Invalid credentials" }, 401));

    await expect(api.login("ada@example.com", "wrong password")).rejects.toMatchObject({ status: 401 });
    expect(expired).not.toHaveBeenCalled();

    window.removeEventListener("auth:expired", expired);
  });

  it("uploads inspection evidence through a private signed URL and finalizes metadata", async () => {
    document.cookie = "csrftoken=csrf-cookie; path=/";
    const uploadUrl = "https://private-storage.example/upload";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/inspections") {
        return jsonResponse({
          inspection: { id: "inspection-1", version: 1 },
          rev: 2,
        }, 201);
      }
      if (url === "/api/evidence/presign") {
        return jsonResponse({
          uploadUrl,
          method: "PUT",
          headers: { "x-storage-token": "signed" },
          objectKey: "org/inspection/photo.jpg",
          expiresAt: "2026-07-26T10:15:00Z",
        });
      }
      if (url === uploadUrl) return new Response(null, { status: 200 });
      if (url === "/api/evidence") return jsonResponse({ id: "evidence-1" }, 201);
      if (url === "/api/inspections/inspection-1/finalize") {
        return jsonResponse({
          inspection: { id: "inspection-1", version: 2, status: "completed" },
          invoice: { id: "invoice-1" },
          call: { id: "call-1", version: 2, status: "completed" },
          rev: 3,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const file = new File(["evidence"], "photo.jpg", { type: "image/jpeg" });

    await api.createInspection(
      { callId: "call-1", status: "completed" },
      { idempotencyKey: "idem-1", evidenceFiles: [file] },
    );

    const createOptions = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(createOptions.headers).get("Idempotency-Key")).toBe("idem-1");
    const uploadOptions = fetchMock.mock.calls[2][1] as RequestInit;
    expect(uploadOptions).toMatchObject({ method: "PUT", body: file });
    expect(new Headers(uploadOptions.headers).get("x-storage-token")).toBe("signed");
    const finalizeBody = JSON.parse(String(fetchMock.mock.calls[3][1]?.body));
    expect(finalizeBody).toMatchObject({
      inspectionId: "inspection-1",
      objectKey: "org/inspection/photo.jpg",
      fileName: "photo.jpg",
    });
  });

  it("encodes user filters and performs invitation and security actions with CSRF", async () => {
    document.cookie = "csrftoken=csrf-cookie; path=/";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      results: [],
      count: 0,
      page: 2,
      pageSize: 20,
    }));

    await api.users({ page: 2, pageSize: 20, search: "Ada & Co", role: "Admin", status: "active" });
    await api.inviteUser({ name: "Grace", email: "grace@example.com", role: "Finance" });
    await api.resetUserMfa("user/2");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/users?page=2&pageSize=20&search=Ada+%26+Co&status=active&role=Admin",
    );
    expect(fetchMock.mock.calls[1][0]).toBe("/api/invitations");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[2][0]).toBe("/api/users/user%2F2/reset-mfa");
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("X-CSRFToken")).toBe("csrf-cookie");
  });

  it("builds authenticated document and audit export URLs without query-string data payloads", () => {
    expect(api.invoicePdfUrl("invoice/1")).toBe("/api/invoices/invoice%2F1/document");
    expect(api.inspectionPdfUrl("inspection 1")).toBe("/api/inspections/inspection%201/document");
    expect(api.vesselCallPdfUrl("call?1")).toBe("/api/vessel-calls/call%3F1/document");
    expect(api.auditExportUrl({ search: "role change", action: "user.updated" })).toBe(
      "/api/audit/export?action=user.updated&search=role+change",
    );
  });

  it("uses append-only payment and explicit reversal endpoints", async () => {
    document.cookie = "csrftoken=csrf-cookie; path=/";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({
      payment: { id: "payment-1" },
      invoice: { id: "invoice-1" },
      rev: 5,
    }));

    await api.recordPayment("invoice/1", {
      paidOn: "2026-07-27",
      method: "Bank transfer",
      reference: "NPA-TRF-88214",
    });
    await api.reversePayment("payment/1", "Duplicate bank entry");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/invoices/invoice%2F1/payments");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      paidOn: "2026-07-27",
      method: "Bank transfer",
      reference: "NPA-TRF-88214",
    });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/payments/payment%2F1/reverse");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      reason: "Duplicate bank entry",
    });
  });

  it("patches invoice status email notification policy with role recipients", async () => {
    document.cookie = "csrftoken=csrf-cookie; path=/";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      step: {
        id: "approved",
        code: "approved",
        label: "Approved",
        notifyOnEntry: true,
        notificationRoles: ["Admin", "Finance"],
      },
      rev: 12,
    }));

    await api.updateInvoiceStatusStep("approved/status", {
      notifyOnEntry: true,
      notificationRoles: ["Admin", "Finance"],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/invoice-status-steps/approved%2Fstatus");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      notifyOnEntry: true,
      notificationRoles: ["Admin", "Finance"],
    });
  });

  it("uses optimistic versions for vessel updates and soft cancellation", async () => {
    document.cookie = "csrftoken=csrf-cookie; path=/";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({
      call: { id: "call-1", version: 4 },
      rev: 8,
    }));

    await api.updateCall("call-1", { vesselName: "MV Updated", version: 3 });
    await api.updateCallStatus("call-1", { status: "in-progress", berth: "Calabar", version: 4 });
    await api.cancelCall("call-1", "Charterer cancelled arrival", 5);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/vessel-calls/call-1",
      "/api/vessel-calls/call-1/status",
      "/api/vessel-calls/call-1/cancel",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({
      reason: "Charterer cancelled arrival",
      version: 5,
    });
  });

  it("updates and finalizes an existing inspection draft explicitly", async () => {
    document.cookie = "csrftoken=csrf-cookie; path=/";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        inspection: { id: "inspection-1", status: "draft", version: 2 },
        rev: 6,
      }))
      .mockResolvedValueOnce(jsonResponse({
        inspection: { id: "inspection-1", status: "completed", version: 3 },
        invoice: { id: "invoice-1" },
        call: { id: "call-1", status: "completed", version: 3 },
        rev: 7,
      }));

    const updated = await api.updateInspection("inspection-1", {
      reconciledTonnage: 500,
      version: 1,
    });
    await api.finalizeInspection("inspection-1", updated.inspection.version);

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PATCH" });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/inspections/inspection-1/finalize");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ version: 2 });
  });

  it("maps the complete identity and domain client to the versioned Django API", async () => {
    document.cookie = "csrftoken=csrf-cookie; path=/";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({
      inspection: { id: "inspection-1", version: 1 },
      rev: 1,
      results: [],
    }));

    await api.csrf();
    await api.register({ name: "Ada", email: "ada@example.com", password: "long-password", orgName: "Harbour" });
    await api.verifyEmail("verify-token");
    await api.resendVerification("ada@example.com");
    await api.verifyMfaChallenge("challenge/1", "123456");
    await api.me();
    await api.logout();
    await api.forgotPassword("ada@example.com");
    await api.resetPassword("reset-token", "new-long-password");
    await api.changePassword("old-password", "new-password");
    await api.profile();
    await api.updateProfile({ name: "Ada Updated", email: "new@example.com" });
    await api.sessions();
    await api.revokeSession("session/1");
    await api.signOutEverywhere();
    await api.setupMfa("current-password");
    await api.confirmMfa("654321");
    await api.regenerateRecoveryCodes();
    await api.disableMfa("password");
    await api.users({ role: "all", status: "all" });
    await api.updateUser("user/1", { role: "Finance" });
    await api.removeUser("user/1");
    await api.sendUserPasswordReset("user/1");
    await api.invitations({ page: 1, role: "all", search: "" });
    await api.resendInvitation("invite/1");
    await api.revokeInvitation("invite/1");
    await api.acceptInvitation({ token: "invite-token", name: "Invitee", password: "long-password" });
    await api.audit({ page: 1, pageSize: 50, action: "user.updated", actor: "admin", search: "role" });
    await api.state();
    await api.state(9);
    await api.poll(10);
    await api.updateOrganization({ name: "Updated Harbour" });
    await api.createCall({ vesselName: "MV Test" });
    await api.createInspection({ callId: "call-1", status: "draft" });
    await api.inspection("inspection/1");
    await api.updateInspection("inspection/1", { reconciledTonnage: 42 });
    await api.updateSettings({ commissionRate: 6 });
    await api.analytics();

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual(expect.arrayContaining([
      "/api/auth/register",
      "/api/auth/mfa/verify",
      "/api/auth/sessions/session%2F1",
      "/api/users/user%2F1/send-password-reset",
      "/api/invitations/invite%2F1/resend",
      "/api/audit?page=1&pageSize=50&action=user.updated&actor=admin&search=role",
      "/api/state",
      "/api/state?rev=9",
      "/api/analytics?months=12",
    ]));
    expect(urls.filter((url) => url === "/api/inspections")).toHaveLength(1);
  });

  it("handles empty, text, and fallback error responses without false session expiry", async () => {
    const expired = vi.fn();
    window.addEventListener("auth:expired", expired);
    const textResponse = new Response("plain response", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
    const emptyResponse = new Response(null, { status: 204 });
    const failure = new Response("gateway failure", {
      status: 502,
      headers: { "Content-Type": "text/plain", "x-request-id": "req-gateway" },
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(textResponse)
      .mockResolvedValueOnce(emptyResponse)
      .mockResolvedValueOnce(failure);

    await expect(request("/api/text")).resolves.toBe("plain response");
    await expect(request("/api/empty")).resolves.toBeNull();
    await expect(request("/api/failure")).rejects.toMatchObject({
      message: "Request failed (502)",
      requestId: "req-gateway",
      errors: {},
    });
    expect(expired).not.toHaveBeenCalled();
    window.removeEventListener("auth:expired", expired);
  });

  it("rejects a failed CSRF bootstrap and a failed private-object upload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({}, 503));
    await expect(request("/api/write", { method: "POST", body: "{}" })).rejects.toMatchObject({
      message: "Could not establish a secure session",
      status: 503,
    });

    resetApiSecurityStateForTests();
    document.cookie = "csrftoken=csrf-cookie; path=/";
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(jsonResponse({
        inspection: { id: "inspection-1", version: 1 },
        rev: 1,
      }))
      .mockResolvedValueOnce(jsonResponse({
        uploadUrl: "https://private-storage.example/fail",
        method: "PUT",
        objectKey: "object-1",
        expiresAt: "2026-07-26T11:00:00Z",
      }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    const evidence = new File(["data"], "photo.png", { type: "image/png" });
    await expect(api.updateInspection("inspection-1", {}, [evidence])).rejects.toMatchObject({
      message: "Could not upload an evidence photo",
      status: 500,
    });
  });
});
