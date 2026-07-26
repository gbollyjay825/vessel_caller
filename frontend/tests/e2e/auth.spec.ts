import { expect, test } from "@playwright/test";

function generatedMockPassword(): string {
  return `${crypto.randomUUID()}-Aa1!`;
}

async function installAnonymousSession(page: import("@playwright/test").Page) {
  await page.route("**/api/runtime-config", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ sentry: { dsn: "", environment: "test", release: "mocked" } }),
  }));
  await page.route("**/api/auth/me", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ detail: "Authentication required", errors: {}, requestId: "e2e-me" }),
  }));
  await page.route("**/api/auth/csrf", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "Set-Cookie": "csrftoken=e2e-csrf; Path=/; SameSite=Lax" },
    body: JSON.stringify({ csrfToken: "e2e-csrf" }),
  }));
}

test("login completes an MFA challenge", async ({ page }) => {
  await installAnonymousSession(page);
  await page.route("**/api/auth/login", async (route) => {
    const request = route.request();
    expect(request.headers()["x-csrftoken"]).toBe("e2e-csrf");
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ mfaRequired: true, challengeId: "challenge-e2e" }),
    });
  });

  await page.goto("/login");
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Password").fill(generatedMockPassword());
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Two-factor verification" })).toBeVisible();
  await expect(page.getByLabel("Verification code")).toBeFocused();
});

test("registration waits for verified email", async ({ page }) => {
  await installAnonymousSession(page);
  await page.route("**/api/auth/register", (route) => route.fulfill({
    status: 202,
    contentType: "application/json",
    body: JSON.stringify({ detail: "Check your inbox.", verificationRequired: true }),
  }));

  await page.goto("/register");
  await page.getByLabel("Your name").fill("Ada Admin");
  await page.getByLabel("Organization name").fill("Ada Marine");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill(generatedMockPassword());
  await page.getByRole("button", { name: "Create organization" }).click();

  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  await expect(page.getByText("Check your inbox.")).toBeVisible();
});
