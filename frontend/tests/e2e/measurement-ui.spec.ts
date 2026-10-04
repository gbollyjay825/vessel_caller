import { expect, test, type Page } from "@playwright/test";

import { measurementFixture } from "../../src/measurements/fixtures.test-support";
import type { MeasurementPlan, PlanInput, ReconciliationInput, SubmissionInput } from "../../src/measurements/types";
import type { AppState, AuthSession, VesselCall } from "../../src/types";

test.skip(process.env.PLAYWRIGHT_REAL_BACKEND === "1", "These presentation checks use an isolated mocked API.");

async function installMeasurementApi(page: Page, initialPlan = measurementFixture()) {
  let plan: MeasurementPlan = structuredClone(initialPlan);
  const requests = {
    plans: [] as PlanInput[],
    submissions: [] as (SubmissionInput & { version: number })[],
    reconciliations: [] as (ReconciliationInput & { version: number })[],
    unexpected: [] as string[],
  };
  const user: AuthSession["user"] = { id: "recorder-1", name: "Mariam Recorder", email: "recorder@example.test", role: "Operations", status: "active", emailVerified: true, mfaEnabled: true, mfaRequired: false };
  const org: NonNullable<AuthSession["org"]> = { id: "org-1", registered: true, name: "Mock Marine", rcNumber: "", email: "office@example.test", phone: "", address: "", designatedPort: "Port of Calabar", primaryPort: "Port of Calabar", ports: ["Port of Calabar"], logo: null, rev: 1 };
  const vessel: VesselCall = { id: "call-1", vesselName: "MV Atlas", reference: "CALL-001", type: "Cargo", flag: "NG", nrt: 12345, eta: "2026-10-07T12:00:00Z", sailingEta: "", berth: "Berth 3", berthDate: null, status: "pending", notes: "", version: 1, registered: "2026-10-01" };
  const calls: VesselCall[] = [vessel, { ...vessel, id: "call-2", vesselName: "MV Horizon", reference: "CALL-002", berth: "Berth 8" }, { ...vessel, id: "cancelled", vesselName: "Cancelled voyage", status: "cancelled" }];
  const state: AppState = { rev: 1, org, calls, inspections: [], invoices: [], invoiceStatusSteps: [], settings: { commissionRate: 0.2, exchangeRate: 1500, liquidDuesRates: { government: 1, private: 2, international: 3 }, dryDuesRate: 1, portName: "Port of Calabar", terminals: [] } };
  const session: AuthSession = { user, org, permissions: ["organization.view", "calls.view", "measurements.view", "measurements.manage", "invoices.view", "evidence.manage"], platformAccess: null };

  // Block unrecognized API requests so these browser checks cannot modify a
  // real tenant even when run against an externally provided frontend server.
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/runtime-config") return json({ sentry: { dsn: "", environment: "test", release: "mocked" } });
    if (path === "/api/auth/me") return json(session);
    if (path === "/api/auth/csrf") return json({ csrfToken: "mock-csrf" });
    if (path === "/api/state") return json(url.searchParams.has("rev") ? { changed: false, rev: 1 } : state);
    if (path === "/api/measurement-plans" && request.method() === "GET") return json({ plans: [plan] });
    if (path === "/api/measurement-plans" && request.method() === "POST") {
      const input = request.postDataJSON() as PlanInput;
      requests.plans.push(structuredClone(input));
      const call = calls.find(item => item.id === input.callId)!;
      plan = { ...plan, ...input, id: "created-plan", status: "scheduled", version: 1, vesselName: call.vesselName, callReference: call.reference, lines: input.lines.map((line, index) => ({ ...line, id: `created-line-${index}` })), participants: input.participants.map((party, index) => ({ ...party, id: `created-party-${index}` })), submissions: [], reconciliations: [], assessments: [], evidence: [] };
      return json({ plan, rev: 2 }, 201);
    }
    if (path === `/api/measurement-plans/${plan.id}` && request.method() === "GET") return json({ plan });
    if (path === `/api/measurement-plans/${plan.id}/submissions` && request.method() === "POST") {
      const input = request.postDataJSON() as SubmissionInput & { version: number };
      requests.submissions.push(structuredClone(input));
      const revision = 1 + Math.max(0, ...plan.submissions.filter(item => item.participantId === input.participantId).map(item => item.revision));
      plan = { ...plan, version: plan.version + 1, submissions: [...plan.submissions, { ...input, id: "new-return", revision, recordedBy: user, recordedAt: "2026-10-04T12:00:00Z" }] };
      return json({ plan, rev: 2 }, 201);
    }
    if (path === `/api/measurement-plans/${plan.id}/reconciliations` && request.method() === "POST") {
      const input = request.postDataJSON() as ReconciliationInput & { version: number };
      requests.reconciliations.push(structuredClone(input));
      plan = { ...plan, version: plan.version + 1, reconciliations: [{ ...input, id: "new-reconciliation", revision: 1, status: "draft", createdBy: user, createdAt: "2026-10-04T12:00:00Z", finalizedBy: null, finalizedAt: null, approvals: [], submissionIds: plan.submissions.map(item => item.id), lines: input.lines.map(line => ({ ...line, manifestQuantity: plan.lines.find(item => item.id === line.lineId)!.manifestQuantity, variance: null })) }] };
      return json({ plan, rev: 3 }, 201);
    }
    requests.unexpected.push(`${request.method()} ${path}`);
    return json({ detail: "Unexpected mocked API request" }, 501);
  });
  return { requests, plan: () => plan };
}

async function fillPlanningPeople(page: Page) {
  await page.getByLabel("Lead surveyor", { exact: true }).fill("Grace Surveyor");
  await page.getByLabel("Party name 1", { exact: true }).fill("Harbour Agency");
  await page.getByLabel("Representative 1", { exact: true }).fill("Ada Agent");
}

async function createPlan(page: Page, title: string) {
  await page.getByLabel("Plan title", { exact: true }).fill(title);
  await fillPlanningPeople(page);
  await page.getByRole("button", { name: "Create measurement plan", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/measurements\/created-plan$/);
}

async function fitsViewport(page: Page) {
  const width = await page.locator("html").evaluate(element => element.scrollWidth);
  expect(width, "Cargo tables should scroll inside the viewport").toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

const includeCargo = (page: Page, line: number) => page.getByRole("checkbox", { name: new RegExp(`^Include cargo line ${line} ·`) });

test("vessel-first container sheet submits only selected directions and keeps NIL distinct from unknown", async ({ page }) => {
  const api = await installMeasurementApi(page);
  await page.goto("/app/measurements/new");
  await expect(page.getByRole("button", { name: "Create measurement plan", exact: true })).toBeDisabled();
  await expect(page.getByRole("option", { name: /Cancelled voyage/ })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Vessel call", exact: true }).selectOption("call-1");
  const vessel = page.getByRole("region", { name: "Choose the vessel", exact: true });
  await expect(vessel.getByText("12,345", { exact: true })).toBeVisible();
  await expect(vessel.getByText("NG", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Containers", exact: true }).check();
  await expect(page.getByRole("checkbox", { name: /^Include cargo line/ })).toHaveCount(12);
  await includeCargo(page, 1).uncheck();
  await includeCargo(page, 6).check();
  await includeCargo(page, 12).check();
  await page.getByLabel("Manifest quantity 6", { exact: true }).fill("0");
  await page.getByLabel("Manifest / baseline reference 6", { exact: true }).fill("MANIFEST-NIL");
  await expect(page.getByText("NIL declared", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Manifest quantity 12", { exact: true })).toHaveValue("");
  await page.getByLabel("Cargo details for line 6", { exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Category 6", exact: true })).toBeDisabled();
  await fitsViewport(page);
  await createPlan(page, "Selected container scopes");
  expect(api.requests.plans).toHaveLength(1);
  expect(api.requests.plans[0].lines).toEqual([
    { description: "45 ft empty containers", category: "Container", direction: "import", containerSize: "45", loadStatus: "empty", unit: "count", basis: "Physical container count", manifestQuantity: "0", baselineReference: "MANIFEST-NIL" },
    { description: "45 ft empty containers", category: "Container", direction: "export", containerSize: "45", loadStatus: "empty", unit: "count", basis: "Physical container count", manifestQuantity: null, baselineReference: "" },
  ]);
  expect(api.requests.plans[0]).not.toHaveProperty("cargoType");
  expect(api.requests.unexpected).toEqual([]);
});

test("tanker products retain separate mass and volume quantities", async ({ page }) => {
  const api = await installMeasurementApi(page);
  await page.goto("/app/measurements/new?callId=call-1");
  await page.getByRole("radio", { name: "Tanker", exact: true }).click();
  await expect(page.getByLabel("Measurement method", { exact: true })).toHaveValue("Product measurement");
  await expect(page.getByText(/petroleum, chemicals or gas/).first()).toBeVisible();
  await page.getByLabel("Cargo description 1", { exact: true }).fill("Petroleum · AGO");
  await page.getByLabel("Manifest quantity 1", { exact: true }).fill("125.75");
  await page.getByLabel("Manifest / baseline reference 1", { exact: true }).fill("BOL-MASS");
  await page.getByRole("button", { name: "Add import row", exact: true }).click();
  await page.getByLabel("Cargo description 2", { exact: true }).fill("Chemicals · Methanol");
  await page.getByRole("combobox", { name: "Unit 2", exact: true }).selectOption("m3");
  await expect(page.getByLabel("Quantity basis 2", { exact: true })).toHaveValue("Volume in cubic metres");
  await page.getByLabel("Manifest quantity 2", { exact: true }).fill("80.125");
  await page.getByLabel("Manifest / baseline reference 2", { exact: true }).fill("BOL-VOLUME");
  await expect(page.getByText(/Count, tonnes and m³ are never added together/)).toBeVisible();
  await fitsViewport(page);
  await createPlan(page, "Tanker products");
  expect(api.requests.plans[0].lines).toEqual([
    expect.objectContaining({ description: "Petroleum · AGO", category: "Liquid", unit: "tonnes", manifestQuantity: "125.75" }),
    expect.objectContaining({ description: "Chemicals · Methanol", category: "Liquid", unit: "m3", manifestQuantity: "80.125" }),
  ]);
  expect(api.requests.plans[0]).not.toHaveProperty("totalQuantity");
  expect(api.requests.unexpected).toEqual([]);
});

test("mixed cargo preserves edited declarations and accepts agency role presets", async ({ page }) => {
  const api = await installMeasurementApi(page);
  await page.goto("/app/measurements/new?callId=call-1");
  await page.getByLabel("Cargo description 1", { exact: true }).fill("Wheat");
  await page.getByLabel("Manifest quantity 1", { exact: true }).fill("400");
  await page.getByLabel("Manifest / baseline reference 1", { exact: true }).fill("BOL-WHEAT");
  await page.getByRole("radio", { name: "Tanker", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Keep the cargo values you entered?");
  await page.getByRole("button", { name: "Keep rows and use Mixed", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Mixed", exact: true })).toBeChecked();
  await expect(page.getByLabel("Manifest quantity 1", { exact: true })).toHaveValue("400");
  await page.getByRole("button", { name: "Add Vehicle", exact: true }).click();
  await page.getByLabel("Cargo description 2", { exact: true }).fill("Passenger cars");
  await page.getByLabel("Manifest quantity 2", { exact: true }).fill("5");
  await page.getByLabel("Manifest / baseline reference 2", { exact: true }).fill("BOL-CARS");
  await page.getByRole("button", { name: "Ops / Terminal", exact: true }).click();
  await page.getByLabel("Party name 2", { exact: true }).fill("Port Terminal");
  await page.getByLabel("Representative 2", { exact: true }).fill("Terminal Lead");
  await expect(page.getByRole("combobox", { name: "Role 2", exact: true })).toHaveValue("Terminal operator");
  await fitsViewport(page);
  await createPlan(page, "Mixed cargo without a combined total");
  expect(api.requests.plans[0].lines.map(line => [line.category, line.unit, line.manifestQuantity])).toEqual([["Bulk", "tonnes", "400"], ["Vehicle", "count", "5"]]);
  expect(api.requests.plans[0].participants.map(party => party.role)).toEqual(["Agent", "Terminal operator"]);
  expect(api.requests.plans[0]).not.toHaveProperty("totalQuantity");
  expect(api.requests.unexpected).toEqual([]);
});

test("agency drafts stay isolated and NPA review preserves the agency readings", async ({ page }) => {
  const api = await installMeasurementApi(page);
  await page.goto("/app/measurements/plan-1");
  await page.getByRole("tab", { name: /Agency readings/ }).click();
  await page.getByRole("button", { name: "Record return", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Reporting agency", exact: true })).toHaveValue("party-2");
  await expect(page.getByText("Mariam Recorder", { exact: true }).last()).toBeVisible();
  const sheet = page.getByRole("region", { name: "Agency measurement entry sheet", exact: true });
  await expect(sheet.getByText("Unknown · enter a reading", { exact: true })).toBeVisible();
  await page.getByLabel("Source document reference", { exact: true }).fill("TERMINAL-002");
  await page.getByLabel("Reported quantity · Wheat", { exact: true }).fill("0");
  await page.getByLabel("Line note · Wheat", { exact: true }).fill("Terminal draft");
  await page.getByLabel("signed-survey.pdf", { exact: true }).check();
  await expect(sheet.getByText("NIL · explicit zero", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Reporting agency", exact: true }).selectOption("party-1");
  await expect(page.getByLabel("Source document reference", { exact: true })).toHaveValue("AGENT-001");
  await expect(page.getByLabel("Reported quantity · Wheat", { exact: true })).toHaveValue("19508.000");
  await page.getByLabel("Reported quantity · Wheat", { exact: true }).fill("19507");
  await page.getByLabel("Reason for revision").fill("Unsaved agency revision");
  await page.getByLabel("signed-survey.pdf", { exact: true }).uncheck();
  await page.getByRole("combobox", { name: "Reporting agency", exact: true }).selectOption("party-2");
  await expect(page.getByLabel("Source document reference", { exact: true })).toHaveValue("TERMINAL-002");
  await expect(page.getByLabel("Reported quantity · Wheat", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("Line note · Wheat", { exact: true })).toHaveValue("Terminal draft");
  await expect(page.getByLabel("signed-survey.pdf", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Reason for revision")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Report status · Wheat", exact: true }).selectOption("not-applicable");
  await expect(page.getByLabel("Reported quantity · Wheat", { exact: true })).toBeDisabled();
  await expect(sheet.getByText("Not comparable", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Report status · Wheat", exact: true }).selectOption("reported");
  await page.getByLabel("Reported quantity · Wheat", { exact: true }).fill("19509");
  await fitsViewport(page);
  await page.getByRole("button", { name: "Record stakeholder return", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Record received return", exact: true })).toHaveCount(0);
  expect(api.requests.submissions).toHaveLength(1);
  expect(api.requests.submissions[0]).toMatchObject({ participantId: "party-2", version: 4, reason: "", sourceReference: "TERMINAL-002", lines: [{ lineId: "line-1", quantity: "19509", status: "reported", note: "Terminal draft" }], evidenceIds: ["file-1"] });
  expect(api.requests.submissions[0]).not.toHaveProperty("recordedBy");
  expect(api.plan().submissions[0].lines[0].quantity).toBe("19508.000");

  await page.getByRole("tab", { name: "Reconciliation", exact: true }).click();
  await page.getByRole("button", { name: "Propose reconciliation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "NPA reconciliation review", exact: true })).toBeVisible();
  const readings = page.getByRole("region", { name: "Agency readings · Wheat", exact: true });
  await expect(readings.getByRole("cell", { name: "19,508 tonnes", exact: true })).toBeVisible();
  await expect(readings.getByRole("cell", { name: "19,509 tonnes", exact: true })).toBeVisible();
  await expect(readings.getByText("+8", { exact: true })).toBeVisible();
  await expect(readings.getByText("+9", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Proposed quantity · Wheat", { exact: true })).toHaveValue("");
  await page.getByLabel("Reconciliation rationale", { exact: true }).fill("Joint review of agency evidence");
  await page.getByLabel("Proposed quantity · Wheat", { exact: true }).fill("19509");
  await page.getByLabel("Decision rationale · Wheat", { exact: true }).fill("Terminal count confirmed");
  await page.getByRole("button", { name: "Create reconciliation proposal", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reconciliation proposal v1", exact: true })).toBeVisible();
  const comparison = page.getByRole("region", { name: "Stakeholder quantities comparison", exact: true });
  await expect(comparison.getByRole("columnheader", { name: /Proposed tally v1/ })).toBeVisible();
  await expect(comparison.getByText("Above declaration", { exact: true })).toBeVisible();
  expect(api.requests.reconciliations[0]).toMatchObject({ version: 5, lines: [{ lineId: "line-1", quantity: "19509", reason: "Terminal count confirmed" }] });
  expect(api.plan().submissions.map(item => item.lines[0].quantity)).toEqual(["19508.000", "19509"]);
  expect(api.requests.unexpected).toEqual([]);
});
