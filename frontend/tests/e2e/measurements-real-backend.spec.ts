import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const password = process.env.E2E_PASSWORD;
if (!password?.trim()) throw new Error("Measurement browser tests require E2E_PASSWORD.");

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password!);
  const submit = page.getByRole("button", { name: "Sign in", exact: true });
  await expect(submit).toBeEnabled();
  await submit.evaluate((button) => (button as { click: () => void }).click());
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText("Loading your workspace…")).toBeHidden();
}

async function signOut(page: Page) {
  const response = page.waitForResponse((item) => item.request().method() === "POST"
    && new URL(item.url()).pathname === "/api/auth/logout");
  await page.getByRole("button", { name: "User menu" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).filter({ visible: true }).last().click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await response).ok()).toBe(true);
}

function syntheticPdf(): Buffer {
  const text = "BT /F1 12 Tf 30 150 Td (SYNTHETIC TEST: cargo tally and paper acknowledgement) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(body);
}

async function assertMeasurementWorkspace(page: Page, name: string | RegExp) {
  const tabs = page.getByRole("tablist", { name: "Measurement workspaces", exact: true });
  await expect(tabs.getByRole("tab")).toHaveCount(5);
  const selected = tabs.getByRole("tab", { name, exact: true, selected: true });
  await expect(selected).toHaveAttribute("aria-controls", "measurement-panel");
  await expect(page.getByRole("tabpanel", { name, exact: true })).toBeVisible();
  const width = await page.locator("html").evaluate(element => (element as { scrollWidth: number }).scrollWidth);
  expect(width, "Measurement views should scroll their data tables inside the viewport").toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

async function assertPdfDownload(page: Page, label: string, filename: RegExp) {
  const link = page.getByRole("link", { name: label, exact: true });
  await expect(link).toBeVisible();
  const response = await page.request.get((await link.getAttribute("href"))!);
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("application/pdf");
  expect(response.headers()["content-disposition"]).toContain("attachment");
  expect((await response.body()).subarray(0, 4).toString()).toBe("%PDF");
  const downloaded = page.waitForEvent("download");
  await link.click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(filename);
  const file = await download.path();
  expect(file).toBeTruthy();
  expect((await readFile(file!)).subarray(0, 4).toString()).toBe("%PDF");
}

test("stakeholder returns reconcile independently and Finance issues one persisted disparity invoice", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const vesselName = `MV Measurement ${suffix}`;
  const title = `Discharge tally ${suffix}`;
  const cargo = "20 foot laden containers";
  const cargoLabel = `${cargo} · import · 20 ft · laden`;
  const evidenceName = `synthetic-paper-tally-${suffix}.pdf`;

  await signIn(page, "admin@e2e.vesselcalls.test");
  await page.goto("/app/settings/agencies");
  for (const [name, role, representative] of [["Test Ship Agent", "Agent", "Agent Representative"], ["Test Terminal", "Terminal operator", "Terminal Representative"]]) {
    await page.getByLabel("Agency name", { exact: true }).fill(name);
    await page.getByRole("combobox", { name: "Agency role", exact: true }).selectOption(role);
    await page.getByLabel("Default representative", { exact: true }).fill(representative);
    await page.getByRole("button", { name: "Save agency", exact: true }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await signOut(page);
  await signIn(page, "operations@e2e.vesselcalls.test");
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const createdCall = await page.request.post("/api/vessel-calls", {
    headers: { "X-CSRFToken": csrf.csrfToken, Referer: page.url() },
    data: { vesselName, reference: `ROT-MEASURE-${suffix}`, type: "Container", nrt: "10000" },
  });
  expect(createdCall.status(), await createdCall.text()).toBe(201);
  const callId: string = (await createdCall.json()).call.id;
  await page.goto(`/app/measurements/new?callId=${encodeURIComponent(callId)}`);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("radio", { name: "Containers", exact: true }).check();
  await page.getByLabel("Cargo details for item 1", { exact: true }).click();
  await page.getByLabel("Cargo description 1", { exact: true }).fill(cargo);
  await page.getByLabel("Quantity basis 1", { exact: true }).fill("Physical container count");
  await page.getByLabel("Manifest quantity 1").fill("100");
  await page.getByLabel("Manifest / baseline reference 1", { exact: true }).fill("SYNTHETIC-MANIFEST-100");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select agency Test Ship Agent", exact: true }).check();
  await page.getByRole("checkbox", { name: "Select agency Test Terminal", exact: true }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Scheduled start").fill(new Date(Date.now() + 3_600_000).toISOString().slice(0, 16));
  await page.getByLabel("Terminal / berth", { exact: true }).fill("Synthetic terminal");
  await page.getByLabel("Lead surveyor", { exact: true }).fill("Test Surveyor");
  await page.getByLabel("Measurement method", { exact: true }).fill("Physical tally");
  await page.getByText("Additional planning details", { exact: true }).click();
  await page.getByLabel("Plan title", { exact: true }).fill(title);
  await page.getByLabel("Operation stage", { exact: true }).fill("Completed discharge tally");
  await page.getByLabel("Parcel / cargo scope", { exact: true }).fill("Synthetic container parcel");
  await page.getByRole("button", { name: "Create voyage sheet", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  const planPath = new URL(page.url()).pathname;
  const planId = planPath.split("/").at(-1)!;

  await assertMeasurementWorkspace(page, "Vessel baseline");
  const returnsTab = page.getByRole("tab", { name: /Agency readings/ });
  await returnsTab.focus();
  await returnsTab.press("Enter");
  await expect(returnsTab).toBeFocused();
  await assertMeasurementWorkspace(page, /Agency readings/);
  for (const [index, party] of ["Test Ship Agent", "Test Terminal"].entries()) {
    await page.getByRole("button", { name: "Record return", exact: true }).click();
    await page.getByRole("combobox", { name: "Reporting agency", exact: true }).selectOption({ label: `${party} · ${index ? "Terminal operator" : "Agent"}` });
    await page.getByLabel("Source document reference", { exact: true }).fill(`SYNTHETIC-RETURN-${index + 1}`);
    await page.getByLabel(`Reported quantity · ${cargoLabel}`, { exact: true }).fill(index ? "110" : "108");
    if (!index) {
      await page.locator('input[type="file"]').setInputFiles({ name: evidenceName, mimeType: "application/pdf", buffer: syntheticPdf() });
      await expect(page.getByLabel(evidenceName, { exact: true })).toBeChecked();
    } else {
      await page.getByLabel(evidenceName, { exact: true }).check();
    }
    await page.getByRole("button", { name: "Record stakeholder return", exact: true }).click();
    await expect(page.getByText("Stakeholder return recorded", { exact: true }).last()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Record agency measurement", exact: true })).toHaveCount(0);
  }

  await page.getByRole("tab", { name: "Reconciliation", exact: true }).click();
  await assertMeasurementWorkspace(page, "Reconciliation");
  await page.getByRole("button", { name: "Propose reconciliation", exact: true }).click();
  await page.getByLabel("Reconciliation rationale", { exact: true }).fill("Physical recount resolves the two container difference.");
  await page.getByLabel(`Proposed quantity · ${cargoLabel}`, { exact: true }).fill("110");
  await page.getByLabel(`Decision rationale · ${cargoLabel}`, { exact: true }).fill("Terminal recount accepted against the recorded tally evidence.");
  await page.getByRole("button", { name: "Create reconciliation proposal", exact: true }).click();
  await expect(page.getByText("Reconciliation proposal saved", { exact: true })).toBeVisible();
  for (const [index, party] of ["Test Ship Agent", "Test Terminal"].entries()) {
    await page.getByRole("button", { name: "Record acknowledgement", exact: true }).click();
    await page.getByRole("combobox", { name: "Acknowledging stakeholder", exact: true }).selectOption({ label: `${party} · ${index ? "Terminal operator" : "Agent"}` });
    await page.getByLabel("Signed document reference / date", { exact: true }).fill(`SYNTHETIC-SIGNED-AGREEMENT-${index + 1}`);
    await page.getByLabel(evidenceName, { exact: true }).check();
    await page.getByRole("button", { name: "Record paper acknowledgement", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Record stakeholder acknowledgement", exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: /Review & finalize/ })).toHaveCount(0);
  await signOut(page);

  await signIn(page, "admin@e2e.vesselcalls.test");
  await page.goto(planPath);
  await page.getByRole("tab", { name: "Reconciliation", exact: true }).click();
  await assertMeasurementWorkspace(page, "Reconciliation");
  await page.getByRole("button", { name: "Review & finalize v1", exact: true }).click();
  await page.getByRole("button", { name: "Finalize version 1", exact: true }).click();
  await expect(page.getByText("Final reconciliation recorded", { exact: true })).toBeVisible();
  await assertPdfDownload(page, "Final sheet v1", /reconciliation-.*\.pdf$/);
  await signOut(page);

  await signIn(page, "finance@e2e.vesselcalls.test");
  await page.goto(planPath);
  await expect(page.getByRole("button", { name: "Edit schedule", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Disparity billing", exact: true }).click();
  await assertMeasurementWorkspace(page, "Disparity billing");
  await page.getByRole("button", { name: "Assess disparity", exact: true }).click();
  await page.getByRole("combobox", { name: "Billing policy", exact: true }).selectOption("manifest-disparity");
  await page.getByLabel("Payer", { exact: true }).fill("Synthetic Cargo Receiver");
  await page.getByLabel("Approved tariff / rate reference", { exact: true }).fill("SYNTHETIC-TARIFF-2.50-PER-CONTAINER");
  await page.getByLabel("Verified opening charges reference").fill("No prior cargo charges");
  await page.getByLabel(`USD rate per count · ${cargoLabel}`, { exact: true }).fill("2.50");
  await page.getByLabel(`Tolerance (count) · ${cargoLabel}`, { exact: true }).fill("0");
  await page.getByLabel(`Opening amount already charged (USD) · ${cargoLabel}`).fill("0");
  await page.getByLabel("Assessment rationale", { exact: true }).fill("Ten additional containers at the verified USD 2.50 rate.");
  await page.getByRole("checkbox", { name: /I have verified the tariff/ }).check();
  await page.getByRole("button", { name: "Calculate and save assessment", exact: true }).click();
  await expect(page.getByText("Disparity assessment saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review & issue invoice", exact: true }).click();
  const issuedResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/issue"));
  await page.getByRole("button", { name: "Issue invoice", exact: true }).click();
  const response = await issuedResponse;
  expect(response.ok(), await response.text()).toBe(true);
  const issued = await response.json();
  const invoiceId: string = issued.invoice.id;
  expect(issued.invoice).toMatchObject({ purpose: "disparity", dues: 25, inspectionId: null, payer: "Synthetic Cargo Receiver" });
  expect(issued.invoice.workflowStatus.code).toBe("pending-director-finance-review");
  await expect(page.getByRole("link", { name: "View invoice", exact: true })).toBeVisible();
  await assertPdfDownload(page, "Invoice PDF", /INV-.*\.pdf$/);

  await page.reload();
  await page.getByRole("tab", { name: "Disparity billing", exact: true }).click();
  await assertMeasurementWorkspace(page, "Disparity billing");
  await expect(page.getByRole("button", { name: "Review & issue invoice", exact: true })).toHaveCount(0);
  const persisted = await (await page.request.get(`/api/measurement-plans/${planId}`)).json();
  expect(persisted.plan.reconciliations[0]).toMatchObject({ status: "final", finalizedBy: { name: "E2E Admin" } });
  expect(persisted.plan.assessments[0]).toMatchObject({ status: "issued", invoiceId, total: "25.00" });
  await page.getByRole("link", { name: "View invoice", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/app/invoices\\?focus=${invoiceId}$`));
  const drawer = page.getByRole("dialog", { name: issued.invoice.invoiceNo });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Measurement disparity", { exact: true })).toBeVisible();
  await expect(drawer.getByText("import · Container · 20 ft · laden", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Physical container count", { exact: true })).toBeVisible();
  await expect(drawer.getByText("100.000 / 110.000", { exact: true })).toBeVisible();
  await expect(drawer.getByText("$25.00", { exact: true }).first()).toBeVisible();
  const state = await (await page.request.get("/api/state")).json();
  expect(state.invoices.filter((invoice: { assessmentId: string }) => invoice.assessmentId === issued.invoice.assessmentId)).toHaveLength(1);
  expect(state.calls.find((call: { id: string }) => call.id === callId).status).toBe("pending");
  await page.goto(planPath);
  await page.getByRole("tab", { name: "Documents & history", exact: true }).click();
  await assertMeasurementWorkspace(page, "Documents & history");
  await page.getByRole("button", { name: "View file", exact: true }).click();
  const evidenceLink = page.getByRole("link", { name: "Open file", exact: true });
  await expect(evidenceLink).toBeVisible();
  const evidenceUrl = new URL((await evidenceLink.getAttribute("href"))!);
  if (process.env.PLAYWRIGHT_BASE_URL?.startsWith("http://")) {
    expect(evidenceUrl.origin).toBe(new URL(page.url()).origin);
  } else {
    expect(evidenceUrl.protocol).toBe("https:");
  }
  const evidenceResponse = await page.request.get(evidenceUrl.toString());
  expect(evidenceResponse.ok()).toBe(true);
  expect((await evidenceResponse.body()).subarray(0, 4).toString()).toBe("%PDF");
});
