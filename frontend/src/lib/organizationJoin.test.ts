import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetApiSecurityStateForTests } from "./api";
import { organizationJoinApi } from "./organizationJoin";

function response(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

describe("organization joining API contract", () => {
  beforeEach(() => { resetApiSecurityStateForTests(); document.cookie = "csrftoken=join-csrf; path=/"; });
  it("resolves the link token in a POST body rather than a URL", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ organization: { name: "NPA" } }));
    await organizationJoinApi.inspect("secret-fragment-token");
    expect(fetch.mock.calls[0][0]).toBe("/api/organization-join/resolve");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", credentials: "include", body: JSON.stringify({ token: "secret-fragment-token" }) });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("X-CSRFToken")).toBe("join-csrf");
  });
  it("uses tenant-scoped link endpoints and explicit role approval payloads", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => response({ results: [] }));
    await organizationJoinApi.links();
    await organizationJoinApi.createLink(7);
    await organizationJoinApi.revokeLink("link/a");
    await organizationJoinApi.requests({ page: 2, status: "pending" });
    await organizationJoinApi.requests({ status: "all" });
    await organizationJoinApi.approve("request/a", "Operations");
    await organizationJoinApi.reject("request/a");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/organization-signup-links?pageSize=20", "/api/organization-signup-links", "/api/organization-signup-links/link%2Fa", "/api/organization-join-requests?page=2&pageSize=20&status=pending", "/api/organization-join-requests?page=1&pageSize=20", "/api/organization-join-requests/request%2Fa/approve", "/api/organization-join-requests/request%2Fa/reject",
    ]);
    expect(fetch.mock.calls[1][1]?.body).toBe(JSON.stringify({ expiresInDays: 7 }));
    expect(fetch.mock.calls[2][1]?.method).toBe("DELETE");
    expect(fetch.mock.calls[5][1]?.body).toBe(JSON.stringify({ role: "Operations" }));
  });
  it("submits no initial password and binds final password to the email verification token", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => response({ detail: "ok" }));
    await organizationJoinApi.submit({ token: "shared-token", name: "Ada", email: "ada@example.test" });
    await organizationJoinApi.verify("email-token", "recipient-secure-password");
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({ token: "shared-token", name: "Ada", email: "ada@example.test" });
    expect(JSON.parse(fetch.mock.calls[1][1]?.body as string)).toEqual({ token: "email-token", password: "recipient-secure-password" });
  });
  it("does not log out an existing browser session when an anonymous token is rejected", async () => {
    const expired = vi.fn();
    window.addEventListener("auth:expired", expired);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ detail: "Authentication credentials were not provided." }), { status: 403, headers: { "Content-Type": "application/json" } }));
    await expect(organizationJoinApi.inspect("invalid")).rejects.toMatchObject({ status: 403 });
    await expect(organizationJoinApi.submit({ token: "invalid", name: "Ada", email: "ada@example.test" })).rejects.toMatchObject({ status: 403 });
    await expect(organizationJoinApi.verify("invalid", "recipient-secure-password")).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(expired).not.toHaveBeenCalled();
    window.removeEventListener("auth:expired", expired);
  });
});
