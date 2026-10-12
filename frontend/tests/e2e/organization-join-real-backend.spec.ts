import { expect, test } from "@playwright/test";

test("a fresh anonymous session opens a real organization sign-up link after the session check fails", async ({
  page,
  context,
  request,
  baseURL,
}) => {
  const password = process.env.E2E_PASSWORD;
  if (!password?.trim() || !baseURL) {
    throw new Error("Real-backend organization join requires E2E_PASSWORD and baseURL.");
  }

  // The API request fixture has its own cookie jar. Creating the link must
  // never give the browser the administrator's authenticated session.
  expect(await context.cookies()).toEqual([]);
  const csrf = await (await request.get("/api/auth/csrf")).json();
  const login = await request.post("/api/auth/login", {
    headers: { "X-CSRFToken": csrf.csrfToken, Referer: new URL("/login", baseURL).href },
    data: { email: "admin@e2e.vesselcalls.test", password },
  });
  expect(login.status()).toBe(200);
  const administrator = await login.json();
  const authenticatedCsrf = await (await request.get("/api/auth/csrf")).json();
  const headers = {
    "X-CSRFToken": authenticatedCsrf.csrfToken,
    Referer: new URL("/app/users", baseURL).href,
  };
  const created = await request.post("/api/organization-signup-links", {
    headers,
    data: { expiresInDays: 1 },
  });
  expect(created.status()).toBe(201);
  const { link, signupUrl } = await created.json();

  try {
    expect(await context.cookies()).toEqual([]);
    await page.addInitScript(() => {
      Reflect.set(window, "__organizationJoinAnonymousBoundary", false);
      const channel = new BroadcastChannel("vessel-caller:auth-boundary");
      channel.addEventListener("message", (event) => {
        const message = event.data as { type?: string; phase?: string };
        if (message?.type === "auth-boundary-v1" && message.phase === "boundary") {
          Reflect.set(window, "__organizationJoinAnonymousBoundary", true);
        }
      });
      window.addEventListener("pagehide", () => channel.close(), { once: true });
    });

    let markLookupStarted = () => {};
    const lookupStarted = new Promise<void>((resolve) => { markLookupStarted = resolve; });
    const anonymousResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/auth/me"
    ));

    // Schedule real Django responses so the public lookup is still in flight
    // when /me rejects the absent session and clears authenticated queries.
    // No API response or authentication result is mocked.
    await page.route("**/api/auth/me", async (route) => {
      await lookupStarted;
      await route.continue();
    });
    await page.route("**/api/organization-join/resolve", async (route) => {
      markLookupStarted();
      const resolved = await route.fetch();
      await page.waitForFunction(() => Reflect.get(window, "__organizationJoinAnonymousBoundary") === true);
      await route.fulfill({ response: resolved });
    });

    const url = new URL(signupUrl);
    await page.goto(`${url.pathname}${url.hash}`);
    const rejectedSession = await anonymousResponse;
    expect([401, 403]).toContain(rejectedSession.status());
    expect((await rejectedSession.json()).detail).toBe("Authentication credentials were not provided.");
    await expect(page.getByRole("heading", { name: `Join ${administrator.org.name}`, exact: true })).toBeVisible();
    await expect(page.getByLabel("Full name", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Request to join", exact: true })).toBeEnabled();
    await expect(page.getByRole("heading", { name: "Opening sign-up link" })).toBeHidden();
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);

    // Loading the public form does not grant any workspace or user access.
    expect((await context.cookies()).some((cookie) => /vessel.*session/.test(cookie.name))).toBe(false);
    const privateUsers = await context.request.get("/api/users");
    expect([401, 403]).toContain(privateUsers.status());
    expect((await privateUsers.json()).detail).toBe("Authentication credentials were not provided.");
  } finally {
    expect((await request.delete(`/api/organization-signup-links/${link.id}`, { headers })).status()).toBe(204);
  }
});
