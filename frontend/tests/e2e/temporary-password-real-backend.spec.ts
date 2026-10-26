import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { expect, test, type Request } from "@playwright/test";

// Generated credentials must never be retained in browser traces/screenshots.
test.use({ trace: "off", video: "off", screenshot: "off" });

function authenticatorCode(provisioningUri: string): string {
  const uri = new URL(provisioningUri);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const secret = uri.searchParams.get("secret") ?? "";
  const bits = [...secret.replace(/=+$/, "").toUpperCase()].map((character) => {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("The isolated MFA fixture returned an invalid setup key.");
    return value.toString(2).padStart(5, "0");
  }).join("");
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, index) =>
    Number.parseInt(bits.slice(index * 8, (index + 1) * 8), 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fff_ffff) % 1_000_000).toString().padStart(6, "0");
}

test("an Admin replaces an invitation and a new user chooses a password then completes guided authenticator setup", async ({
  page, context, browser, baseURL,
}, testInfo) => {
  const databaseName = process.env.VC_DATABASE_URL
    ? new URL(process.env.VC_DATABASE_URL).pathname.split("/").filter(Boolean).at(-1) ?? ""
    : "";
  const isolated = Boolean(baseURL && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)
    && /(?:^|[_-])(?:e2e|test)(?:$|[_-])/i.test(databaseName));
  test.skip(!isolated, "Credential creation is exercised only against the isolated Django test database.");
  test.setTimeout(90_000);
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
    const adminCsrf = await (await context.request.get("/api/auth/csrf")).json();
    const invited = await context.request.post("/api/invitations", {
      headers: { "X-CSRFToken": adminCsrf.csrfToken, Referer: new URL("/app/users", baseURL).href },
      data: { name, email, role: "Operations" },
    });
    expect(invited.status()).toBe(201);
    const invitationId: string = (await invited.json()).invitation.id;
    await page.getByRole("button", { name: "Add user", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Add user", exact: true });
    await expect(drawer.getByRole("radio", { name: /Temporary password/ })).toBeChecked();
    await expect(drawer.getByLabel("Temporary password", { exact: true })).toHaveValue("");
    await expect(drawer.getByLabel("Temporary password", { exact: true })).toHaveAttribute("readonly", "");
    await drawer.getByRole("textbox", { name: "Full name", exact: true }).fill(name);
    await drawer.getByRole("textbox", { name: "Email", exact: true }).fill(email);
    await drawer.getByLabel("Role", { exact: true }).selectOption("Viewer");
    const conflictResponse = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/users/temporary-password");
    await drawer.getByRole("button", { name: "Create user", exact: true }).click();
    const conflict = await conflictResponse;
    expect(conflict.status()).toBe(409);
    expect((await conflict.json()).errors.code).toBe("pending_invitation");
    await expect(drawer.getByRole("checkbox", { name: "Replace pending invitation", exact: true })).not.toBeChecked();
    await expect(drawer.getByRole("button", { name: "Create user", exact: true })).toBeDisabled();
    await drawer.getByRole("checkbox", { name: "Replace pending invitation", exact: true }).check();
    const creationResponse = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/users/temporary-password");
    await drawer.getByRole("button", { name: "Create user", exact: true }).click();
    const created = await creationResponse;
    expect(created.status()).toBe(201);
    expect(created.request().postDataJSON().replacePendingInvitation).toBe(true);
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
    await expect(credentials.getByLabel("Temporary password", { exact: true })).toHaveAttribute("type", "text");
    expect(await credentials.getByLabel("Temporary password", { exact: true }).inputValue() === temporaryPassword).toBe(true);
    await expect(credentials.getByRole("button", { name: "Copy password", exact: true })).toBeVisible();
    const invitations = await (await context.request.get(`/api/invitations?search=${encodeURIComponent(email)}`)).json();
    expect(invitations.results.find((item: { id: string }) => item.id === invitationId)?.status).toBe("revoked");
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
    await expect(recipientPage).toHaveURL(/\/app\/account\?setup=authenticator$/);
    await expect(recipientPage.getByRole("heading", { name: "Set up your authenticator", exact: true })).toBeVisible();
    await expect(recipientPage.getByRole("banner").getByRole("navigation", { name: "Breadcrumb" }).getByText("Dashboard", { exact: true })).toHaveCount(0);
    await recipientPage.reload();
    await expect(recipientPage).toHaveURL(/\/app\/account\?setup=authenticator$/);

    // The setup is rendered on-device from Django's provisioning URI. Never
    // send the authenticator seed to a remote image or QR-generation service.
    const offOriginSetupRequests = new Set<string>();
    const observeSetupRequest = (request: Request) => {
      const url = new URL(request.url());
      if (["http:", "https:"].includes(url.protocol) && url.origin !== new URL(baseURL).origin) {
        offOriginSetupRequests.add(url.origin);
      }
    };
    recipientPage.on("request", observeSetupRequest);
    const authenticator = recipientPage.getByRole("region", { name: "Set up your authenticator", exact: true });
    await authenticator.getByLabel(/^Current password/).fill(replacement);
    const setupResponse = recipientPage.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/auth/mfa/setup");
    await authenticator.getByRole("button", { name: "Set up authenticator", exact: true }).click();
    const setup = await setupResponse;
    expect(setup.status()).toBe(200);
    const enrollment: { secret: string; provisioningUri: string } = await setup.json();
    const uri = new URL(enrollment.provisioningUri);
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.hostname).toBe("totp");
    expect(uri.searchParams.get("secret") === enrollment.secret).toBe(true);
    expect(decodeURIComponent(uri.pathname).includes(email)).toBe(true);
    await expect(authenticator.getByRole("link", { name: "Add to authenticator", exact: true }))
      .toHaveAttribute("href", enrollment.provisioningUri);
    const qr = authenticator.getByRole("img", { name: "Scan to add NPA Vessel Caller to your authenticator", exact: true });
    await expect(qr).toBeVisible();
    expect(await qr.evaluate((element) => element.tagName.toLowerCase())).toBe("svg");
    expect(await qr.locator("path").count()).toBeGreaterThan(0);
    expect(await qr.locator("image, use, [href], [xlink\\:href]").count()).toBe(0);
    const qrBounds = await qr.boundingBox();
    expect(Boolean(qrBounds && qrBounds.width >= 180 && qrBounds.height >= 180)).toBe(true);
    expect([...offOriginSetupRequests]).toEqual([]);
    recipientPage.off("request", observeSetupRequest);

    await authenticator.getByRole("textbox", { name: "Authenticator code", exact: true })
      .fill(authenticatorCode(enrollment.provisioningUri));
    const confirmMfaResponse = recipientPage.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/auth/mfa/confirm");
    await authenticator.getByRole("button", { name: "Enable MFA", exact: true }).click();
    const confirmedMfa = await confirmMfaResponse;
    expect(confirmedMfa.status()).toBe(200);
    const recovery: { recoveryCodes: string[] } = await confirmedMfa.json();
    expect(recovery.recoveryCodes.length).toBe(10);
    await expect(recipientPage.getByRole("heading", { name: "Save your recovery codes", exact: true })).toBeVisible();
    for (const code of recovery.recoveryCodes) {
      await expect(recipientPage.getByText(code, { exact: true })).toBeVisible();
    }
    await expect(recipientPage).toHaveURL(/\/app\/account\?setup=authenticator$/);
    const continueToWorkspace = recipientPage.getByRole("button", { name: "Continue to workspace", exact: true });
    await expect(continueToWorkspace).toBeDisabled();
    await recipientPage.getByRole("checkbox", { name: "I have saved my recovery codes", exact: true }).check();
    await expect(continueToWorkspace).toBeEnabled();
    const enrolledSession = await (await recipient.request.get("/api/auth/me")).json();
    expect(enrolledSession.user.mfaEnabled).toBe(true);
    const enrolledStorage = await recipientPage.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(enrolledStorage.includes(enrollment.secret)
      || enrolledStorage.includes(enrollment.provisioningUri)
      || recovery.recoveryCodes.some((code) => enrolledStorage.includes(code))).toBe(false);
    await continueToWorkspace.click();
    await expect(recipientPage).toHaveURL(/\/app\/dashboard$/);
    await expect(recipientPage.getByText(recovery.recoveryCodes[0], { exact: true })).toHaveCount(0);
    await recipientPage.reload();
    await expect(recipientPage.getByRole("banner").getByRole("navigation", { name: "Breadcrumb" }).getByText("Dashboard", { exact: true })).toBeVisible();
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
  } catch (error) {
    console.error("Authenticator journey failed before cleanup:", error instanceof Error ? error.message : "Unknown test failure");
    throw error;
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
