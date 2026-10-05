import { describe, expect, it, vi } from "vitest";
import { createGuestAgencyApi, createGuestSubmissionAttempt } from "./guestApi";
import { guestContext, guestInput, guestReceipt } from "./guest.test-support";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const csrf = () => json({ csrfToken: "csrf-value" });

describe("separate guest agency transport", () => {
  it("exchanges the token only in a CSRF-protected body, with same-origin credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(csrf()).mockResolvedValueOnce(json({ contextId: "context-1" }));
    await expect(createGuestAgencyApi(fetcher).exchange("opaque-secret")).resolves.toBe("context-1");
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(["/api/agency-portal/csrf", "/api/agency-portal/exchange"]);
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer", headers: { "Content-Type": "application/json", "X-CSRFToken": "csrf-value" }, body: JSON.stringify({ token: "opaque-secret" }) });
  });
  it("scopes context requests and rejects a mismatched context", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ context: guestContext() })); const api = createGuestAgencyApi(fetcher);
    await expect(api.context("context-1")).resolves.toEqual(guestContext());
    expect(fetcher.mock.calls[0][0]).toBe("/api/agency-portal/context?contextId=context-1");
    await expect(api.context("another-context")).rejects.toMatchObject({ status: 403 });
  });
  it("sends a stable attempt and scope fingerprint without a selectable participant", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(csrf()).mockResolvedValueOnce(json({ context: guestReceipt() }));
    await expect(createGuestAgencyApi(fetcher).submit(guestContext(), "request-1", guestInput())).resolves.toEqual(guestReceipt());
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string)).toEqual({ ...guestInput(), contextId: "context-1", requestId: "request-1", inputFingerprint: "scope-fingerprint" });
  });
  it("recovers a committed receipt after a lost POST response without submitting twice", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(csrf()).mockRejectedValueOnce(new TypeError("lost")).mockResolvedValueOnce(json({ context: guestReceipt() }));
    await expect(createGuestAgencyApi(fetcher).submit(guestContext(), "request-1", guestInput())).resolves.toEqual(guestReceipt());
    expect(fetcher.mock.calls[2][0]).toBe("/api/agency-portal/context?contextId=context-1");
    expect(fetcher.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
  });
  it("preserves uncertainty without a receipt and never refreshes a forbidden session", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(csrf()).mockRejectedValueOnce(new TypeError("lost")).mockResolvedValueOnce(json({ context: guestContext() }));
    await expect(createGuestAgencyApi(fetcher).submit(guestContext(), "request-1", guestInput())).rejects.toMatchObject({ status: 0 });
    fetcher.mockReset().mockResolvedValueOnce(csrf()).mockResolvedValueOnce(json({ detail: "Wrong agency session" }, 403));
    await expect(createGuestAgencyApi(fetcher).submit(guestContext(), "request-1", guestInput())).rejects.toMatchObject({ status: 403, message: "Wrong agency session" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("reuses requestId for identical retries and replaces it for changed data or scope", () => {
    const attempt = createGuestSubmissionAttempt(); const input = guestInput(); const original = attempt(guestContext(), input);
    expect(attempt(guestContext(), structuredClone(input))).toBe(original);
    expect(attempt(guestContext(), { ...input, notes: "Correction" })).not.toBe(original);
    const next = attempt(guestContext(), input); expect(attempt({ ...guestContext(), inputFingerprint: "new-scope" }, input)).not.toBe(next);
  });
  it("downloads a scoped PDF and rejects a non-PDF response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("%PDF-report", { headers: { "Content-Type": "application/pdf" } })).mockResolvedValueOnce(json({}));
    const api = createGuestAgencyApi(fetcher); expect((await api.receipt("context-1")).type).toBe("application/pdf");
    expect(fetcher.mock.calls[0][0]).toBe("/api/agency-portal/receipt?contextId=context-1");
    await expect(api.receipt("context-1")).rejects.toMatchObject({ status: 502 });
  });
  it("reports an unavailable backend and rejects missing CSRF or incomplete forms", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 404)); const api = createGuestAgencyApi(fetcher);
    await expect(api.context()).rejects.toMatchObject({ status: 404, message: "Agency reading links are not available on this environment yet." });
    fetcher.mockResolvedValueOnce(json({})); await expect(api.exchange("token")).rejects.toMatchObject({ status: 403 });
    fetcher.mockResolvedValueOnce(json({ context: {} })); await expect(api.context()).rejects.toMatchObject({ status: 502 });
  });
});
