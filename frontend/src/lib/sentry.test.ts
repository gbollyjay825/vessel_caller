import type { Event } from "@sentry/react";
import { describe, expect, it, vi } from "vitest";

import {
  initializeFrontendMonitoring,
  redactSentryBreadcrumb,
  redactSentryEvent,
} from "./sentry";

type InitOptions = Parameters<typeof import("@sentry/react").init>[0];

describe("frontend monitoring", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("stays disabled when runtime config has no DSN", async () => {
    const initialize = vi.fn<(options: InitOptions) => void>();
    const fetchRuntimeConfig = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ sentry: { dsn: "", environment: "staging", release: "v1.2.3" } }),
    );

    await expect(
      initializeFrontendMonitoring({ fetch: fetchRuntimeConfig, initialize }),
    ).resolves.toBe(false);
    expect(initialize).not.toHaveBeenCalled();
    expect(fetchRuntimeConfig).toHaveBeenCalledWith(
      "/api/runtime-config",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });

  it.each([
    ["non-JSON response", new Response("<html>not JSON</html>", { status: 200, headers: { "Content-Type": "text/html" } })],
    ["missing sentry object", jsonResponse({})],
    ["non-string fields", jsonResponse({ sentry: { dsn: 42, environment: "staging", release: "v1.2.3" } })],
    ["insecure DSN", jsonResponse({ sentry: { dsn: "http://public@example.test/1", environment: "staging", release: "v1.2.3" } })],
    ["missing release", jsonResponse({ sentry: { dsn: "https://public@example.test/1", environment: "staging", release: "" } })],
    ["failed response", jsonResponse({ sentry: { dsn: "https://public@example.test/1", environment: "staging", release: "v1.2.3" } }, 503)],
  ])("stays disabled for %s", async (_label, response) => {
    const initialize = vi.fn<(options: InitOptions) => void>();
    const fetchRuntimeConfig = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(
      initializeFrontendMonitoring({ fetch: fetchRuntimeConfig, initialize }),
    ).resolves.toBe(false);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("stays disabled when runtime config cannot be fetched", async () => {
    const initialize = vi.fn<(options: InitOptions) => void>();
    const fetchRuntimeConfig = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));

    await expect(
      initializeFrontendMonitoring({ fetch: fetchRuntimeConfig, initialize, timeoutMs: 10 }),
    ).resolves.toBe(false);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("aborts a stalled runtime-config request after the bounded timeout", async () => {
    const initialize = vi.fn<(options: InitOptions) => void>();
    const fetchRuntimeConfig = vi.fn<typeof fetch>().mockImplementation((_input, init) => (
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })
    ));

    await expect(
      initializeFrontendMonitoring({ fetch: fetchRuntimeConfig, initialize, timeoutMs: 1 }),
    ).resolves.toBe(false);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("configures runtime metadata and privacy-safe collection without network delivery", async () => {
    const initialize = vi.fn<(options: InitOptions) => void>();
    const fetchRuntimeConfig = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        sentry: {
          dsn: " https://public@example.ingest.sentry.io/1 ",
          environment: " staging ",
          release: " v1.2.3 ",
        },
      }),
    );

    await expect(
      initializeFrontendMonitoring({ fetch: fetchRuntimeConfig, initialize }),
    ).resolves.toBe(true);

    expect(initialize).toHaveBeenCalledOnce();
    const options = initialize.mock.calls[0][0];
    expect(options).toMatchObject({
      dsn: "https://public@example.ingest.sentry.io/1",
      environment: "staging",
      release: "v1.2.3",
      sendDefaultPii: false,
      tracesSampleRate: 0,
      profilesSampleRate: 0,
      profileSessionSampleRate: 0,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: { request: false, response: false },
        httpBodies: [],
        urlQueryParams: false,
        stackFrameVariables: false,
        frameContextLines: 0,
      },
    });
    expect(options.integrations).toEqual(expect.any(Function));
    expect(fetchRuntimeConfig).toHaveBeenCalledOnce();
  });

  it("redacts user identity, request secrets, and sensitive breadcrumb values", () => {
    const event: Event = {
      message: "Failure for captain@example.com with Bearer abc123",
      user: { id: "user-1", email: "captain@example.com" },
      request: {
        url: "https://vesselcalls.com/reset-password?token=secret-token",
        headers: { authorization: "Bearer abc123" },
        cookies: { sessionid: "session-secret" },
        data: { password: "plain-password", safe: "retained" },
      },
      extra: {
        mfaCode: "123456",
        nested: { safe: "visible", email: "captain@example.com" },
      },
    };

    const redacted = redactSentryEvent(event);
    expect(redacted.user).toBeUndefined();
    expect(redacted.message).toBe("Failure for [REDACTED_EMAIL] with Bearer [REDACTED]");
    expect(redacted.request).toEqual({
      url: "https://vesselcalls.com/reset-password",
      headers: "[REDACTED]",
      cookies: "[REDACTED]",
      data: { password: "[REDACTED]", safe: "retained" },
    });
    expect(redacted.extra).toEqual({
      mfaCode: "[REDACTED]",
      nested: { safe: "visible", email: "[REDACTED]" },
    });

    expect(
      redactSentryBreadcrumb({
        category: "fetch",
        message: "Request for captain@example.com",
        data: {
          url: "https://vesselcalls.com/api/users?email=captain@example.com",
          recoveryToken: "single-use-secret",
        },
      }),
    ).toEqual({
      category: "fetch",
      message: "Request for [REDACTED_EMAIL]",
      data: {
        url: "https://vesselcalls.com/api/users",
        recoveryToken: "[REDACTED]",
      },
    });
  });
});
