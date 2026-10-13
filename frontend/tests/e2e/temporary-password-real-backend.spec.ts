import { randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

// Generated credentials must never be retained in browser traces/screenshots.
test.use({ trace: "off", screenshot: "off" });

test("an Admin creates a user who must replace the temporary password before role access", async ({
  page, context, browser, baseURL,
}, testInfo) => {
  const databaseName = process.env.VC_DATABASE_URL
    ? new URL(process.env.VC_DATABASE_URL).pathname.split("/").filter(Boolean).at(-1) ?? ""
    : "";
  const isolated = Boolean(baseURL && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)
    && /(?:^|[_-])(?:e2e|test)(?:$|[_-])/i.test(databaseName));
  test.skip(!isolated, "Credential creation is exercised only against the isolated Django test database.");
  test.setTimeout(60_000);
  const adminPassword = process.env.E2E_PASSWORD;
  if (!adminPassword?.trim() || !baseURL) throw new Error("Isolated temporary-password E2E requires E2E_PASSWORD and baseURL.");
  const suffix = `${testInfo.project.name}-${randomUUID()}`;
  const email = `temporary-${suffix}@e2e.vesselcalls.test`;
  const name = `Temporary Viewer ${testInfo.project.name} ${suffix.slice(-8)}`;
  const replacement = `${randomBytes(24).toString("base64url")}1aA!`;
  let createdUserId: string | null = null;
  const recipient = await browser.newContext({ baseURL });

  try {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill("admin@e2e.vesselcalls.test");
    await page.getByLabel("Password", { exact: true }).fill(adminPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/dashboard$/);
    await page.goto("/app/users");
    await page.getByRole("button", { name: "Add user", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Add user", exact: true });
    await expect(drawer.getByRole("radio", { name: /Temporary password/ })).toBeChecked();
    await drawer.getByRole("textbox", { name: "Full name", exact: true }).fill(name);
    await drawer.getByRole("textbox", { name: "Email", exact: true }).fill(email);
    await drawer.getByLabel("Role", { exact: true }).selectOption("Viewer");
    const creationResponse = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/users/temporary-password");
    await drawer.getByRole("button", { name: "Create user", exact: true }).click();
    const created = await creationResponse;
    expect(created.status()).toBe(201);
    expect(created.headers()["cache-control"]).toContain("no-store");
    const result = await created.json();
    createdUserId = result.user.id;
    let temporaryPassword: string = result.temporaryPassword;
    expect(typeof temporaryPassword === "string" && temporaryPassword.length >= 20).toBe(true);
    expect(result.user.passwordChangeRequired).toBe(true);
    expect(result.user.emailVerified).toBe(false);
    expect(result.user.adminProvisioned).toBe(true);
    expect(result.user.role).toBe("Viewer");
    const credentials = page.getByRole("dialog", { name: "User ready to sign in", exact: true });
    await expect(credentials.getByLabel("Temporary password", { exact: true })).toHaveAttribute("type", "password");
    await expect(credentials.getByText("No email is sent.", { exact: false })).toBeVisible();
    await credentials.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByLabel("Temporary password", { exact: true })).toHaveCount(0);

    const memberList = await (await context.request.get("/api/users")).json();
    expect(JSON.stringify(memberList).includes(temporaryPassword)).toBe(false);
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(stored.includes(temporaryPassword)).toBe(false);

    const recipientPage = await recipient.newPage();
    await recipientPage.goto("/login");
    await recipientPage.getByLabel("Email", { exact: true }).fill(email);
    await recipientPage.getByLabel("Password", { exact: true }).fill(temporaryPassword);
    const limitedResponse = recipientPage.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/auth/login");
    await recipientPage.getByRole("button", { name: "Sign in", exact: true }).click();
    const limited = await limitedResponse;
    expect(limited.status()).toBe(202);
    expect(limited.headers()["cache-control"]).toContain("no-store");
    let challenge = await limited.json();
    expect(challenge.passwordChangeRequired).toBe(true);
    expect(Object.keys(challenge).sort()).toEqual(["passwordChangeExpiresAt", "passwordChangeRequired", "passwordChangeToken"]);
    await expect(recipientPage).toHaveURL(/\/change-temporary-password$/);
    await expect(recipientPage.getByRole("heading", { name: "Choose your own password", exact: true })).toBeVisible();
    expect((await recipient.cookies()).some((cookie) => /vessel.*session/.test(cookie.name))).toBe(false);
    expect([401, 403]).toContain((await recipient.request.get("/api/auth/me")).status());
    expect([401, 403]).toContain((await recipient.request.get("/api/vessel-calls")).status());
    const limitedStorage = await recipientPage.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(limitedStorage.includes(challenge.passwordChangeToken) || limitedStorage.includes(temporaryPassword)).toBe(false);

    // Recovery for a lost/expired credential is limited to this pending user.
    await page.getByLabel("Search users", { exact: true }).fill(email);
    if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 767) {
      await page.getByRole("button", { name: /^User / }).filter({ hasText: email }).click();
    } else {
      await page.getByRole("row").filter({ hasText: email }).getByRole("button", { name: `Edit ${name}`, exact: true }).click();
    }
    const editor = page.getByRole("dialog", { name: "Edit user", exact: true });
    const regenerateResponse = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/users/${createdUserId}/temporary-password`);
    await editor.getByRole("button", { name: "Generate new temporary password", exact: true }).click();
    const regenerated = await regenerateResponse;
    expect(regenerated.status()).toBe(201);
    expect(regenerated.headers()["cache-control"]).toContain("no-store");
    const renewed = await regenerated.json();
    expect(typeof renewed.temporaryPassword === "string" && renewed.temporaryPassword !== temporaryPassword).toBe(true);
    temporaryPassword = renewed.temporaryPassword;
    await page.getByRole("dialog", { name: "User ready to sign in", exact: true }).getByRole("button", { name: "Done", exact: true }).click();
    const previousCsrf = await (await recipient.request.get("/api/auth/csrf")).json();
    expect((await recipient.request.post("/api/auth/complete-temporary-password", {
      headers: { "X-CSRFToken": previousCsrf.csrfToken, Referer: new URL("/login", baseURL).href },
      data: { token: challenge.passwordChangeToken, password: replacement },
    })).status()).toBe(400);
    await recipientPage.goto("/login");
    await recipientPage.getByLabel("Email", { exact: true }).fill(email);
    await recipientPage.getByLabel("Password", { exact: true }).fill(temporaryPassword);
    const renewedLogin = recipientPage.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/auth/login");
    await recipientPage.getByRole("button", { name: "Sign in", exact: true }).click();
    expect((await renewedLogin).status()).toBe(202);
    challenge = await (await renewedLogin).json();
    await expect(recipientPage.getByRole("heading", { name: "Choose your own password", exact: true })).toBeVisible();

    await recipientPage.getByLabel("New password", { exact: true }).fill(replacement);
    await recipientPage.getByLabel("Confirm new password", { exact: true }).fill(replacement);
    const completeResponse = recipientPage.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/auth/complete-temporary-password");
    await recipientPage.getByRole("button", { name: "Change password and continue", exact: true }).click();
    const complete = await completeResponse;
    expect(complete.status()).toBe(200);
    const completed = await complete.json();
    expect(completed.user.role).toBe("Viewer");
    expect(completed.user.passwordChangeRequired).toBe(false);
    expect(completed.user.emailVerified).toBe(false);
    expect(completed.permissions).toContain("calls.view");
    expect(completed.permissions).not.toContain("users.manage");
    await expect(recipientPage).toHaveURL(/\/app\/dashboard$/);
    await recipientPage.reload();
    await expect(recipientPage.getByRole("banner").getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    expect((await recipient.cookies()).some((cookie) => /vessel.*session/.test(cookie.name) && cookie.httpOnly)).toBe(true);
    expect((await recipient.request.get("/api/users")).status()).toBe(403);
    const recipientCsrf = await (await recipient.request.get("/api/auth/csrf")).json();
    const recipientHeaders = { "X-CSRFToken": recipientCsrf.csrfToken, Referer: new URL("/login", baseURL).href };
    expect((await recipient.request.post("/api/auth/complete-temporary-password", {
      headers: recipientHeaders, data: { token: challenge.passwordChangeToken, password: replacement },
    })).status()).toBe(400);
    expect((await recipient.request.post("/api/users/temporary-password", {
      headers: recipientHeaders, data: { name: "Not permitted", email: `denied-${suffix}@e2e.vesselcalls.test`, role: "Admin" },
    })).status()).toBe(403);

    const oldCredentialContext = await browser.newContext({ baseURL });
    try {
      const csrf = await (await oldCredentialContext.request.get("/api/auth/csrf")).json();
      expect((await oldCredentialContext.request.post("/api/auth/login", {
        headers: { "X-CSRFToken": csrf.csrfToken, Referer: new URL("/login", baseURL).href },
        data: { email, password: temporaryPassword },
      })).status()).toBe(401);
    } finally { await oldCredentialContext.close(); }
  } finally {
    await recipient.close();
    if (createdUserId) {
      const csrf = await (await context.request.get("/api/auth/csrf")).json();
      expect((await context.request.delete(`/api/users/${createdUserId}`, {
        headers: { "X-CSRFToken": csrf.csrfToken, Referer: new URL("/app/users", baseURL).href },
      })).status()).toBe(200);
    }
  }
});
