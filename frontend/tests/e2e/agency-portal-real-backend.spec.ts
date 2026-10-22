import { expect, test } from "@playwright/test";

test("agency setup and passwordless reading persist through the real Django backend", async ({ page, browser }, testInfo) => {
  const password = process.env.E2E_PASSWORD;
  if (!password) throw new Error("E2E_PASSWORD is required");
  const label = `Agency ${testInfo.project.name} ${Date.now()}`;
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("admin@e2e.vesselcalls.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/dashboard$/);
  await page.goto("/app/settings/agencies");
  await page.getByLabel("Agency name", { exact: true }).fill(label);
  await page.getByLabel("Default representative", { exact: true }).fill("Independent Surveyor");
  await page.getByRole("button", { name: "Save agency", exact: true }).click();
  await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
  const csrf = (await (await page.request.get("/api/auth/csrf")).json()).csrfToken;
  const headers = { "X-CSRFToken": csrf, Referer: page.url() };
  const agencies = (await (await page.request.get("/api/agencies")).json()).agencies;
  const agency = agencies.find((item: { name: string }) => item.name === label);
  const callResponse = await page.request.post("/api/vessel-calls", { headers, data: { vesselName: "MV Persistent Cargo", reference: label, type: "Bulk", nrt: "1000" } });
  expect(callResponse.status()).toBe(201);
  const call = (await callResponse.json()).call;
  const planResponse = await page.request.post("/api/measurement-plans", { headers, data: {
    callId: call.id, title: label, scheduledAt: new Date().toISOString(), method: "Survey", stage: "Discharge", scope: "Wheat", leadSurveyor: "Coordinator",
    participants: [{ agencyId: agency.id, name: agency.name, role: agency.role, representative: agency.representative, requiredSubmission: true, requiredApproval: false }],
    lines: [{ description: "Wheat", category: "Bulk", direction: "import", unit: "tonnes", basis: "Metric tonnes", manifestQuantity: "19500", baselineReference: "Owner declaration" }],
  } });
  expect(planResponse.status(), await planResponse.text()).toBe(201);
  const plan = (await planResponse.json()).plan;
  const linkResponse = await page.request.post(`/api/measurement-plans/${plan.id}/participants/${plan.participants[0].id}/agency-links`, { headers, data: { expiryDays: 7 } });
  expect(linkResponse.status()).toBe(201);
  const link = (await linkResponse.json()).url as string;
  const guestContext = await browser.newContext();
  try {
    const guest = await guestContext.newPage();
    await guest.goto(new URL(new URL(link).pathname + new URL(link).hash, page.url()).toString());
    await expect(guest.getByRole("heading", { name: "Record your agency’s reading" })).toBeVisible();
    await guest.getByLabel("Source document reference", { exact: true }).fill("Independent reading");
    await guest.getByRole("spinbutton").fill("19508");
    await guest.getByRole("button", { name: "Submit reading", exact: true }).click();
    await expect(guest.getByRole("heading", { name: "Your agency report", exact: true })).toBeVisible();
    await guest.reload();
    await expect(guest.getByRole("heading", { name: "Your agency report", exact: true })).toBeVisible();
    const downloadEvent = guest.waitForEvent("download");
    await guest.getByRole("button", { name: "Download your PDF", exact: true }).click();
    expect((await downloadEvent).suggestedFilename()).toMatch(/\.pdf$/);
    const persisted = (await (await page.request.get(`/api/measurement-plans/${plan.id}`)).json()).plan;
    expect(persisted.submissions).toHaveLength(1);
    expect(persisted.submissions[0].source).toBe("agency-link");
    expect(persisted.submissions[0].lines[0].quantity).toBe("19508.000");
  } finally { await guestContext.close(); }
});
