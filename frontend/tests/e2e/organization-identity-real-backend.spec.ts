import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

test.use({ trace: "off", video: "off", screenshot: "off" });

async function signIn(page: Page, email: string, password: string, url = "/login") {
  page.setDefaultTimeout(15_000);
  await page.goto(url);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function post(context: BrowserContext, path: string, data: object, baseURL: string) {
  const csrf = await (await context.request.get("/api/auth/csrf")).json();
  return context.request.post(path, {
    headers: { "X-CSRFToken": csrf.csrfToken, Referer: new URL("/login", baseURL).href }, data,
  });
}

test("the same email keeps its original access while a second organization gets independent credentials", async ({
  page, context, browser, baseURL,
}, testInfo) => {
  const databaseName = process.env.VC_DATABASE_URL ? new URL(process.env.VC_DATABASE_URL).pathname : "";
  const isolated = Boolean(baseURL && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)
    && /(?:^|[_/-])(?:e2e|test)(?:$|[_/-])/i.test(databaseName));
  test.skip(!isolated, "Scoped credential creation uses the named isolated Django test database only.");
  test.setTimeout(90_000);
  const password = process.env.E2E_PASSWORD;
  if (!password || !baseURL) throw new Error("Isolated identity journey needs E2E_PASSWORD and baseURL");
  const email = `shared-${testInfo.project.name}-${testInfo.retry}@e2e.vesselcalls.test`;
  const name = `Second organization Viewer ${randomUUID().slice(0, 8)}`;
  const originalOrg = "org-e2eoriginal01";
  const destinationOrg = "org-e2e000000001";
  const original = await browser.newContext({ baseURL });
  const recipient = await browser.newContext({ baseURL });
  const chooser = await browser.newContext({ baseURL });
  let createdUserId: string | null = null;
  try {
    const originalPage = await original.newPage();
    await signIn(originalPage, email, password, `/login?organizationId=${originalOrg}`);
    await expect(originalPage).toHaveURL(/\/app\/dashboard$/);
    const originalSession = await (await original.request.get("/api/auth/me")).json();
    expect(originalSession.org.id).toBe(originalOrg);

    await signIn(page, "admin@e2e.vesselcalls.test", password);
    await expect(page).toHaveURL(/\/app\/dashboard$/);
    await page.goto("/app/users");
    const invitation = await post(context, "/api/invitations", { name, email, role: "Admin" }, baseURL);
    expect(invitation.status()).toBe(201);
    const invitationId = (await invitation.json()).invitation.id;
    await page.getByRole("button", { name: "Add user", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Add user", exact: true });
    await drawer.getByRole("textbox", { name: "Full name", exact: true }).fill(name);
    await drawer.getByRole("textbox", { name: "Email", exact: true }).fill(email);
    await drawer.getByLabel("Role", { exact: true }).selectOption("Viewer");
    await drawer.getByRole("button", { name: "Create user", exact: true }).click();
    await drawer.getByRole("checkbox", { name: "Replace pending invitation", exact: true }).check();
    const creationResponse = page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/users/temporary-password");
    await drawer.getByRole("button", { name: "Create user", exact: true }).click();
    const creation = await creationResponse;
    expect(creation.status()).toBe(201);
    expect(creation.headers()["cache-control"]).toContain("no-store");
    const created = await creation.json();
    createdUserId = created.user.id;
    const temporary: string = created.temporaryPassword;
    const loginURL = new URL(created.signInUrl);
    expect(loginURL.searchParams.get("organizationId")).toBe(destinationOrg);
    const credentials = page.getByRole("dialog", { name: "User ready to sign in", exact: true });
    await expect(credentials.getByLabel("Sign-in page", { exact: true })).toHaveValue(created.signInUrl);
    await expect(credentials.getByText("E2E Harbour Services", { exact: true })).toBeVisible();
    const invitations = await (await context.request.get(`/api/invitations?search=${encodeURIComponent(email)}`)).json();
    expect(invitations.results.find((item: { id: string }) => item.id === invitationId)?.status).toBe("revoked");
    // The original browser session and role survive creation in the second organization.
    const preserved = await (await original.request.get("/api/auth/me")).json();
    expect(preserved.user.id).toBe(originalSession.user.id);
    expect(preserved.org.id).toBe(originalOrg);
    expect(preserved.user.role).toBe(originalSession.user.role);
    expect((await post(recipient, "/api/auth/login", { email, password: temporary, organizationId: originalOrg }, baseURL)).status()).toBe(401);
    expect((await post(recipient, "/api/auth/login", { email, password, organizationId: destinationOrg }, baseURL)).status()).toBe(401);

    const recipientPage = await recipient.newPage();
    await signIn(recipientPage, email, temporary, `${loginURL.pathname}${loginURL.search}`);
    await expect(recipientPage.getByRole("heading", { name: "Choose your own password", exact: true })).toBeVisible();
    expect([401, 403]).toContain((await recipient.request.get("/api/auth/me")).status());
    // Deliberately choose the same password on these two test-only accounts to
    // exercise the password-proven chooser without exposing unproven tenants.
    await recipientPage.getByLabel("New password", { exact: true }).fill(password);
    await recipientPage.getByLabel("Confirm new password", { exact: true }).fill(password);
    await recipientPage.getByRole("button", { name: "Change password and continue", exact: true }).click();
    await expect(recipientPage).toHaveURL(/\/app\/account\?setup=authenticator$/);
    // This journey isolates organization identity; authenticator enrollment is
    // exercised end to end by the dedicated temporary-password journey.
    await recipientPage.goto("/app");
    await expect(recipientPage).toHaveURL(/\/app\/dashboard$/);
    const destinationSession = await (await recipient.request.get("/api/auth/me")).json();
    expect(destinationSession.org.id).toBe(destinationOrg);
    expect(destinationSession.user.id).toBe(createdUserId);
    expect(destinationSession.user.id).not.toBe(originalSession.user.id);
    expect((await recipient.request.get("/api/users")).status()).toBe(403);
    const chooserPage = await chooser.newPage();
    await signIn(chooserPage, email, password);
    await expect(chooserPage.getByRole("heading", { name: "Choose your organization", exact: true })).toBeVisible();
    expect([401, 403]).toContain((await chooser.request.get("/api/auth/me")).status());
    await chooserPage.getByRole("combobox").selectOption(originalOrg);
    await chooserPage.getByRole("button", { name: "Continue to organization", exact: true }).click();
    await expect(chooserPage).toHaveURL(/\/app\/dashboard$/);
    expect((await (await chooser.request.get("/api/auth/me")).json()).org.id).toBe(originalOrg);
    const oldAgain = await post(original, "/api/auth/login", { email, password, organizationId: originalOrg }, baseURL);
    expect(oldAgain.status()).toBe(200);
  } finally {
    await Promise.allSettled([original.close(), recipient.close(), chooser.close()]);
    if (createdUserId) {
      const csrf = await (await context.request.get("/api/auth/csrf")).json();
      expect((await context.request.delete(`/api/users/${createdUserId}`, {
        headers: { "X-CSRFToken": csrf.csrfToken, Referer: new URL("/app/users", baseURL).href },
      })).status()).toBe(200);
    }
  }
});
