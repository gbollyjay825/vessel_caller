import { expect, test, type Page } from "@playwright/test";

const configuredPassword = process.env.E2E_PASSWORD;
if (!configuredPassword || !configuredPassword.trim()) {
  throw new Error("Real-backend Playwright tests require E2E_PASSWORD from the environment.");
}
const password = configuredPassword;
const sessionCookieName = process.env.PLAYWRIGHT_BASE_URL?.startsWith("https://")
  ? "__Host-vessel_session"
  : "vessel_test_session";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  const submit = page.getByRole("button", { name: "Sign in" });
  await expect(submit).toBeEnabled();
  // A successful session swaps PublicAuthRoute for the workspace immediately.
  // Invoke the native activation atomically so Playwright does not retry a
  // click against the intentionally unmounted login button on mobile.
  await submit.evaluate((button) => (button as { click: () => void }).click());
  await expect(page).toHaveURL(/\/app\/dashboard$/);
  await expect(page.getByText("Loading your workspace…")).toBeHidden();
}

async function signOut(page: Page) {
  // The next sign-in reloads /login, so prove Django finished invalidating the
  // server session before that navigation can cancel the in-page logout task.
  const logoutResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/auth/logout"
  ));
  await page.getByRole("button", { name: "User menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).filter({ visible: true }).last().click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await logoutResponse).ok()).toBe(true);
}

async function navigateInWorkspace(page: Page, label: string) {
  const hamburger = page.getByRole("button", { name: "Open menu" });
  const navigation = page.getByRole("navigation", { name: "Primary" });
  const link = navigation.getByRole("link", { name: label });
  if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 767) {
    await expect(hamburger).toBeVisible();
    await hamburger.click();
    await expect(navigation).toHaveClass(/(?:^|\s)open(?:\s|$)/);
    await expect(link).toBeInViewport();
    await link.dispatchEvent("click");
    return;
  }
  await link.click();
}

test("real Django sessions enforce server RBAC without browser tokens", async ({ page, context }) => {
  await signIn(page, "operations@e2e.vesselcalls.test");

  await expect(page.getByRole("link", { name: "User Management" })).toHaveCount(0);
  await page.goto("/app/users");
  await expect(page).toHaveURL(/\/app\/dashboard$/);
  expect(await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }))).toEqual({ local: {}, session: {} });
  expect((await context.cookies()).some((cookie) => (
    cookie.name === sessionCookieName && cookie.httpOnly
  ))).toBe(true);

  await signOut(page);
  await signIn(page, "admin@e2e.vesselcalls.test");
  await navigateInWorkspace(page, "User Management");
  await expect(page).toHaveURL(/\/app\/users$/);
  await expect(
    page.getByText("operations@e2e.vesselcalls.test").filter({ visible: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Add user" })).toBeVisible();
});

test("operations creates and finalizes a call; finance records and reverses payment", async ({ page }, testInfo) => {
  const suffix = `${testInfo.project.name.slice(0, 3).toUpperCase()}-${Date.now().toString().slice(-7)}`;
  const vesselName = `MV E2E ${suffix}`;
  const rotation = `ROT-2026-${suffix}`;

  await signIn(page, "operations@e2e.vesselcalls.test");
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Vessel Calls", exact: true })).toHaveCount(0);
  await navigateInWorkspace(page, "Voyages");
  await page.getByRole("link", { name: "Vessel setup", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/vessel-calls$/);
  await page.getByRole("button", { name: "Register Vessel Call" }).click();
  await page.getByLabel("Vessel name").fill(vesselName);
  await page.getByLabel("Rotation number").fill(rotation);
  await page.getByLabel("Net tonnage").fill("10000");
  const registeredResponse = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/vessel-calls"
  ));
  await page.getByRole("button", { name: "Register Call" }).click();
  const registered = await registeredResponse;
  expect(registered.status(), await registered.text()).toBe(201);
  const callId: string = (await registered.json()).call.id;
  await expect(page.getByText(`${rotation} registered`)).toBeVisible();

  await page.getByText(vesselName, { exact: true }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Mark berthed" }).click();
  await expect(page.getByText(`${rotation} marked in progress`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Inspection", exact: true })).toHaveCount(0);
  // The inspection workflow remains authorized while its unrelated entry
  // points are hidden from the voyage measurement navigation.
  await page.goto(`/app/inspections/new?callId=${encodeURIComponent(callId)}`);

  await page.getByRole("button", { name: /Liquid cargo/ }).click();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByLabel("Reconciled Surveyor's Tonnage (MT)").fill("500");
  await page.getByLabel("Jetty type").selectOption("International");
  await page.getByRole("button", { name: /Review/ }).click();
  await page.getByRole("button", { name: "Submit Inspection" }).click();
  await expect(page.getByRole("heading", { name: "Inspection submitted" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Invoice PDF" })).toBeEnabled();

  await page.goto("/app");
  await signOut(page);
  await signIn(page, "finance@e2e.vesselcalls.test");
  // The visible Invoices navigation now belongs to voyage variations. This
  // regression still exercises the persisted legacy invoice and payments.
  await page.goto("/app/invoices");
  await expect(page).toHaveURL(/\/app\/invoices$/);
  await page.getByText(vesselName, { exact: true }).filter({ visible: true }).first().click();
  await page.getByLabel("Payment reference").fill(`PAY-${suffix}`);
  await page.getByRole("button", { name: /Record payment/ }).click();
  await expect(page.getByText(/Payment recorded for INV-/)).toBeVisible();

  await page.getByText(vesselName, { exact: true }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Reverse payment" }).click();
  await page.getByLabel("Reversal reason").fill("E2E reversal verification");
  await page.getByRole("button", { name: "Confirm reversal" }).click();
  await expect(page.getByText(/Payment reversed for INV-/)).toBeVisible();
});
