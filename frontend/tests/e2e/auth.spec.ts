import { expect, test, type Page } from "@playwright/test";

import type { AuthSession } from "../../src/types";

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


async function installCustomerEnrollmentSession(page: Page, role: "Admin" | "Finance") {
  const password = generatedMockPassword();
  const recoveryCodes = ["mock-recovery-one", "mock-recovery-two"];
  const session: AuthSession = {
    user: {
      id: "enrollment-user",
      name: `Enrollment ${role}`,
      email: "enrollment@example.test",
      role,
      status: "active",
      emailVerified: true,
      mfaEnabled: false,
      mfaRequired: true,
      mfaEnrollmentRequired: true,
      mfaGraceEndsAt: "2026-08-03T00:00:00Z",
    },
    org: {
      id: "enrollment-org",
      registered: true,
      name: "Mock Marine",
      rcNumber: "",
      email: "enrollment@example.test",
      phone: "",
      address: "",
      designatedPort: "Port of Calabar",
      primaryPort: "Port of Calabar",
      ports: ["Port of Calabar"],
      logo: null,
      rev: 1,
    },
    permissions: [],
    platformAccess: null,
  };
  let enrolled = false;
  const requests = { state: 0, setup: 0, confirm: 0, refreshedSession: 0, unexpected: [] as string[] };
  const currentSession = (): AuthSession => ({
    ...session,
    user: {
      ...session.user,
      mfaEnabled: enrolled,
      mfaEnrollmentRequired: !enrolled,
    },
    permissions: enrolled ? ["organization.view", "calls.view", "analytics.view"] : [],
  });

  // Every API request stays inside this fixture. The blocked state endpoint
  // reproduces the real permission boundary without touching any account.
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    switch (path) {
      case "/api/runtime-config":
        return json({ sentry: { dsn: "", environment: "test", release: "mocked" } });
      case "/api/auth/csrf":
        return json({ csrfToken: "e2e-csrf" });
      case "/api/auth/me":
        if (enrolled) requests.refreshedSession += 1;
        return json(currentSession());
      case "/api/profile":
        return json({ user: currentSession().user });
      case "/api/auth/mfa/setup":
        requests.setup += 1;
        expect(request.method()).toBe("POST");
        expect(request.headers()["x-csrftoken"]).toBe("e2e-csrf");
        expect(request.postDataJSON()).toEqual({ currentPassword: password });
        return json({
          secret: "mock-only-secret",
          provisioningUri: "otpauth://totp/Mock?secret=mock-only-secret&issuer=Mock",
        });
      case "/api/auth/mfa/confirm":
        requests.confirm += 1;
        expect(request.method()).toBe("POST");
        expect(request.postDataJSON()).toEqual({ code: "123456" });
        enrolled = true;
        return json({ recoveryCodes });
      case "/api/state":
        requests.state += 1;
        if (!enrolled) {
          return json({ detail: "You do not have permission to perform this action." }, 403);
        }
        return json({
          rev: 1,
          org: session.org,
          settings: {
            commissionRate: 0.2,
            exchangeRate: 1500,
            liquidDuesRates: { government: 1, private: 2, international: 3 },
            dryDuesRate: 1,
            portName: "Port of Calabar",
            terminals: [],
          },
          calls: [],
          inspections: [],
          invoices: [],
          invoiceStatusSteps: [],
        });
      case "/api/analytics":
        return json({ series: [], products: [], totals: {
          throughput: 0, liquidT: 0, dryT: 0, revenue: 0, liquidR: 0, dryR: 0,
          invoiced: 0, collected: 0, outstanding: 0, calls: 0,
        } });
      case "/api/poll":
        return json({ changed: false, rev: 1 });
      default:
        requests.unexpected.push(`${request.method()} ${path}`);
        return json({ detail: "Unexpected mocked API request" }, 501);
    }
  });

  return { password, recoveryCodes, requests };
}

for (const role of ["Admin", "Finance"] as const) {
  for (const entryPath of ["/app", "/capture", "/app/account"]) {
    test(`${role} with expired MFA grace can enroll from ${entryPath} without workspace data`, async ({ page }) => {
      const { requests } = await installCustomerEnrollmentSession(page, role);

      await page.goto(entryPath);

      await expect(page).toHaveURL(/\/app\/account$/);
      await expect(page.getByRole("heading", { name: "Set up MFA to open your workspace" })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Password & MFA" })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("region", { name: "Authenticator app" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Set up authenticator" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
      await expect(page.getByText("You do not have permission to perform this action.")).toHaveCount(0);
      expect(requests.state).toBe(0);
      expect(requests.unexpected).toEqual([]);
    });
  }

  test(`${role} retains MFA recovery codes after refreshing the enrolled session`, async ({ page }) => {
    const { password, recoveryCodes, requests } = await installCustomerEnrollmentSession(page, role);
    await page.goto("/app");
    await expect(page).toHaveURL(/\/app\/account$/);
    const authenticator = page.getByRole("region", { name: "Authenticator app" });

    await authenticator.getByLabel("Current password").fill(password);
    await authenticator.getByRole("button", { name: "Set up authenticator" }).click();
    await expect(authenticator.getByRole("link", { name: "Add to authenticator" })).toBeVisible();
    await authenticator.getByRole("textbox", { name: "Authenticator code", exact: true }).fill("123456");
    await authenticator.getByRole("button", { name: "Enable MFA" }).click();

    // The session refresh restores permissions. It must not redirect or remount
    // this page before the customer can save their one-time recovery codes.
    await expect.poll(() => requests.refreshedSession).toBeGreaterThan(0);
    await expect(authenticator.getByText("Two-factor authentication protects this account at sign-in.")).toBeVisible();
    await expect(page).toHaveURL(/\/app\/account$/);
    await expect(page.getByText("Save these recovery codes now")).toBeVisible();
    for (const code of recoveryCodes) await expect(page.getByText(code, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy codes" })).toBeVisible();
    expect(requests.setup).toBe(1);
    expect(requests.confirm).toBe(1);
    expect(requests.state).toBe(0);

    const analyticsResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/analytics"
    ));
    await page.getByRole("link", { name: "Open workspace", exact: true }).click();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole("heading", { name: "No vessel calls yet" })).toBeVisible();
    expect((await analyticsResponse).ok()).toBe(true);
    expect(requests.state).toBeGreaterThan(0);
    expect(requests.unexpected).toEqual([]);
  });
}
