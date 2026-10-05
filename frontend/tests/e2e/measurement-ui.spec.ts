import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { measurementFixture } from "../../src/measurements/fixtures.test-support";
import { guestContext } from "../../src/measurements/guest.test-support";
import type { GuestReadingInput } from "../../src/measurements/guestTypes";
import type { Evidence, MeasurementPlan, PlanInput, ReconciliationInput, SubmissionInput } from "../../src/measurements/types";
import type { AppState, AuthSession, VesselCall } from "../../src/types";

test.skip(process.env.PLAYWRIGHT_REAL_BACKEND === "1", "These presentation checks use an isolated mocked API.");

async function installMeasurementApi(page: Page, initialPlan = measurementFixture(), options: { admin?: boolean; seedAgencies?: boolean } = {}) {
  let plan: MeasurementPlan = structuredClone(initialPlan);
  const requests = {
    plans: [] as PlanInput[],
    links: [] as { participantId: string; expiryDays: number }[],
    uploads: [] as string[],
    submissions: [] as (SubmissionInput & { version: number })[],
    reconciliations: [] as (ReconciliationInput & { version: number })[],
    unexpected: [] as string[],
  };
  const user: AuthSession["user"] = { id: "recorder-1", name: "Mariam Recorder", email: "recorder@example.test", role: options.admin ? "Admin" : "Operations", status: "active", emailVerified: true, mfaEnabled: true, mfaRequired: false };
  const org: NonNullable<AuthSession["org"]> = { id: "org-1", registered: true, name: "Mock Marine", rcNumber: "", email: "office@example.test", phone: "", address: "", designatedPort: "Port of Calabar", primaryPort: "Port of Calabar", ports: ["Port of Calabar"], logo: null, rev: 1 };
  const vessel: VesselCall = { id: "call-1", vesselName: "MV Atlas", reference: "CALL-001", type: "Cargo", flag: "NG", nrt: 12345, eta: "2026-10-07T12:00:00Z", sailingEta: "", berth: "Berth 3", berthDate: null, status: "pending", notes: "", version: 1, registered: "2026-10-01" };
  const calls: VesselCall[] = [vessel, { ...vessel, id: "call-2", vesselName: "MV Horizon", reference: "CALL-002", berth: "Berth 8" }, { ...vessel, id: "call-3", reference: "CALL-003", eta: "2026-10-10T12:00:00Z" }, { ...vessel, id: "cancelled", vesselName: "Cancelled voyage", status: "cancelled" }];
  const state: AppState = { rev: 1, org, calls, inspections: [], invoices: [], invoiceStatusSteps: [], settings: { commissionRate: 0.2, exchangeRate: 1500, liquidDuesRates: { government: 1, private: 2, international: 3 }, dryDuesRate: 1, portName: "Port of Calabar", terminals: [] } };
  const session: AuthSession = { user, org, permissions: ["organization.view", "calls.view", "measurements.view", "measurements.manage", "invoices.view", "evidence.manage", ...(options.admin ? ["settings.view", "settings.manage"] : [])], platformAccess: null };

  if (options.seedAgencies !== false) await page.addInitScript(() => {
    localStorage.setItem("vessel-caller:agency-directory:v1:org-1", JSON.stringify({ version: 1, organizationId: "org-1", agencies: [
      { id: "agency-agent", name: "Harbour Agency", role: "Agent", representative: "Ada Agent", active: true },
      { id: "agency-terminal", name: "Port Terminal", role: "Terminal operator", representative: "Terminal Lead", active: true },
    ] }));
  });

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
    if (path === `/api/measurement-plans/${plan.id}/evidence/presign` && request.method() === "POST") return json({ uploadUrl: `${url.origin}/api/mock-measurement-upload`, headers: { "Content-Type": "application/pdf" }, objectKey: "mock-evidence-object" });
    if (path === "/api/mock-measurement-upload" && request.method() === "PUT") {
      requests.uploads.push(request.headers()["content-type"]);
      return route.fulfill({ status: 200, body: "" });
    }
    if (path === `/api/measurement-plans/${plan.id}/evidence` && request.method() === "POST") {
      const evidence: Evidence = { ...request.postDataJSON() as Omit<Evidence, "id" | "createdAt">, id: "uploaded-evidence", createdAt: "2026-10-05T12:00:00Z" };
      plan = { ...plan, evidence: [...plan.evidence, evidence] };
      return json({ evidence }, 201);
    }
    if (path === `/api/measurement-plans/${plan.id}/agency-links` && request.method() === "GET") return json({ links: [] });
    const linkParticipant = plan.participants.find(party => path === `/api/measurement-plans/${plan.id}/participants/${party.id}/agency-links`);
    if (linkParticipant && request.method() === "POST") {
      requests.links.push({ participantId: linkParticipant.id, ...request.postDataJSON() as { expiryDays: number } });
      return json({ link: { id: `link-${linkParticipant.id}`, participantId: linkParticipant.id, expiresAt: "2099-10-12T12:00:00Z", revokedAt: null, submittedAt: null }, url: `https://example.test/agency-reading#token=synthetic-${linkParticipant.id}` }, 201);
    }
    if (path === `/api/measurement-plans/${plan.id}/submissions` && request.method() === "POST") {
      const input = request.postDataJSON() as SubmissionInput & { version: number };
      requests.submissions.push(structuredClone(input));
      if (input.version !== plan.version) return json({ detail: "This voyage changed. Reload the latest version." }, 409);
      const revision = 1 + Math.max(0, ...plan.submissions.filter(item => item.participantId === input.participantId).map(item => item.revision));
      plan = { ...plan, version: plan.version + 1, submissions: [...plan.submissions, { ...input, id: `new-return-${requests.submissions.length}`, revision, recordedBy: user, recordedAt: "2026-10-04T12:00:00Z" }] };
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

async function openDeclaration(page: Page) {
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Owner declaration", exact: true })).toBeVisible();
}

async function openAgencyReading(page: Page, name: string) {
  await page.getByRole("group", { name: `Agency ${name}`, exact: true }).getByRole("button", { name: "Enter reading", exact: true }).click();
  await expect(page.getByRole("dialog", { name: `${name} reading`, exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/measurements\/new(?:\?|$)/);
  await page.getByRole("button", { name: "Close reading", exact: true }).click();
  await expect(page.getByRole("dialog", { name: `${name} reading`, exact: true })).toHaveCount(0);
}

async function createPlan(page: Page, agencies = ["Harbour Agency"], action: "reading" | "link" = "reading") {
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agency readings", exact: true })).toBeVisible();
  await expect(page.getByText("Step 3 of 3", { exact: true })).toBeVisible();
  for (const name of agencies) await page.getByRole("checkbox", { name: `Select agency ${name}`, exact: true }).check();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Finish", exact: true })).toBeDisabled();
  if (action === "reading") await openAgencyReading(page, agencies[0]);
  else {
    const agency = page.getByRole("group", { name: `Agency ${agencies[0]}`, exact: true });
    await agency.getByRole("button", { name: "Get link", exact: true }).click();
    await expect(agency.getByLabel(`Link for ${agencies[0]}`, { exact: true })).toHaveValue("https://example.test/agency-reading#token=synthetic-created-party-0");
    await agency.getByRole("button", { name: "Get link", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/measurements\/new(?:\?|$)/);
  }
  await expect(page.getByRole("tablist", { name: "Measurement workspaces", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Propose reconciliation|Assess disparity|Issue invoice/ })).toHaveCount(0);
  for (const name of agencies) await expect(page.getByRole("checkbox", { name: `Select agency ${name}`, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/measurements$/);
  await expect(page.getByRole("heading", { name: "Voyage log", exact: true })).toBeVisible();
}

async function fitsViewport(page: Page) {
  const width = await page.locator("html").evaluate(element => element.scrollWidth);
  expect(width, "Cargo tables should scroll inside the viewport").toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

const includeCargo = (page: Page, item: number) => page.getByRole("checkbox", { name: new RegExp(`^Include cargo item ${item} ·`) });

test("same-page readings submit evidence and reuse one voyage with the latest version for the next agency", async ({ page }) => {
  const api = await installMeasurementApi(page);
  const pdf = Buffer.from("%PDF-1.4\n% Synthetic agency evidence\n%%EOF\n");
  const evidenceName = "synthetic-agency-tally.pdf";
  await page.goto("/app/measurements/new?callId=call-1");
  await openDeclaration(page);
  await page.getByLabel("Cargo description 1", { exact: true }).fill("Wheat");
  await page.getByLabel("Manifest quantity 1", { exact: true }).fill("100");
  await page.getByLabel("Vessel declaration reference", { exact: true }).fill("OWNER-BASELINE");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  for (const name of ["Harbour Agency", "Port Terminal"]) await page.getByRole("checkbox", { name: `Select agency ${name}`, exact: true }).check();
  await expect(page.getByRole("button", { name: "Finish", exact: true })).toBeDisabled();

  for (const [index, name] of ["Harbour Agency", "Port Terminal"].entries()) {
    const agency = page.getByRole("group", { name: `Agency ${name}`, exact: true });
    await expect(agency.getByText("Submitted", { exact: true })).toHaveCount(0);
    await agency.getByRole("button", { name: "Enter reading", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `${name} reading`, exact: true });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/app\/measurements\/new\?callId=call-1$/);
    await expect(dialog.getByRole("combobox", { name: "Reporting agency", exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel("Reported quantity · Wheat", { exact: true })).toHaveValue("");
    await expect(dialog.getByLabel("Source document reference", { exact: true })).toHaveValue("");
    await dialog.getByLabel("Source document reference", { exact: true }).fill(`AGENCY-READING-${index + 1}`);
    await dialog.getByLabel("Reported quantity · Wheat", { exact: true }).fill(index ? "108.25" : "107.125");
    await expect(dialog.getByRole("button", { name: "Submit reading", exact: true })).toBeDisabled();
    if (index === 0) {
      await dialog.locator('input[type="file"]').setInputFiles({ name: evidenceName, mimeType: "application/pdf", buffer: pdf });
      await expect(dialog.getByLabel(evidenceName, { exact: true })).toBeChecked();
    } else {
      await expect(dialog.getByLabel(evidenceName, { exact: true })).not.toBeChecked();
      await dialog.getByLabel(evidenceName, { exact: true }).check();
    }
    await dialog.getByRole("button", { name: "Submit reading", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(agency.getByText("Submitted", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/app\/measurements\/new\?callId=call-1$/);
    expect(api.requests.plans).toHaveLength(1);
    expect(api.requests.submissions[index]).toMatchObject({ participantId: `created-party-${index}`, version: index + 1, sourceReference: `AGENCY-READING-${index + 1}`, evidenceIds: ["uploaded-evidence"], lines: [{ lineId: "created-line-0", quantity: index ? "108.25" : "107.125", status: "reported", note: "" }] });
  }
  expect(api.plan().version).toBe(3);
  expect(api.plan().submissions.map(reading => reading.lines[0].quantity)).toEqual(["107.125", "108.25"]);
  expect(api.requests.uploads).toEqual(["application/pdf"]);
  expect(api.plan().evidence).toEqual([expect.objectContaining({ id: "uploaded-evidence", fileName: evidenceName, contentType: "application/pdf", size: pdf.byteLength, checksum: `sha256:${createHash("sha256").update(pdf).digest("hex")}` })]);
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/measurements$/);
  await expect(page.getByText("2 / 2 agency readings", { exact: true })).toBeVisible();
  expect(api.requests.unexpected).toEqual([]);
});

test("public agency link submits an independent reading and downloads only its own report without sign-in", async ({ page }) => {
  const context = guestContext();
  const submissions: (GuestReadingInput & { contextId: string; requestId: string; inputFingerprint: string })[] = [];
  const exchanges: unknown[] = [];
  const receiptContexts: (string | null)[] = [];
  const unexpected: string[] = [];
  const pdf = Buffer.from("%PDF-1.4\n% Isolated agency receipt fixture\n%%EOF\n");
  let hashAtExchange: string | undefined;
  let anonymousSessionRequests = 0;
  context.completedPeers = [{ id: "peer-report", participantId: "party-2", agencyName: "Port Terminal", agencyRole: "Terminal operator", status: "submitted", submittedAt: "2026-10-05T11:30:00Z", lines: [{ lineId: "line-1", status: "reported", quantity: "17.500" }] }];
  await page.route("**/api/**", async route => {
    const request = route.request(), address = new URL(request.url());
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (address.pathname === "/api/runtime-config") return json({ sentry: { dsn: "", environment: "test", release: "mocked" } });
    if (address.pathname === "/api/auth/me") { anonymousSessionRequests += 1; return json({ detail: "Authentication credentials were not provided." }, 401); }
    if (address.pathname === "/api/agency-portal/csrf" && request.method() === "GET") return json({ csrfToken: "guest-only-csrf" });
    if (address.pathname === "/api/agency-portal/exchange" && request.method() === "POST") {
      hashAtExchange = await page.evaluate<string>("location.hash");
      exchanges.push(request.postDataJSON());
      expect(request.headers()["x-csrftoken"]).toBe("guest-only-csrf");
      return json({ contextId: context.contextId });
    }
    if (address.pathname === "/api/agency-portal/context" && request.method() === "GET") {
      expect(address.searchParams.get("contextId")).toBe(context.contextId);
      return json({ context });
    }
    if (address.pathname === "/api/agency-portal/submission" && request.method() === "POST") {
      const input = request.postDataJSON() as typeof submissions[number];
      submissions.push(input);
      expect(request.headers()["x-csrftoken"]).toBe("guest-only-csrf");
      context.ownReport = { representative: input.representative, observedAt: input.observedAt, sourceReference: input.sourceReference, notes: input.notes, lines: input.lines, id: "report-1", participantId: context.agency.id, agencyName: context.agency.name, agencyRole: context.agency.role, submittedAt: "2026-10-05T12:00:00Z", status: "submitted" };
      return json({ context }, 201);
    }
    if (address.pathname === "/api/agency-portal/receipt" && request.method() === "GET") {
      receiptContexts.push(address.searchParams.get("contextId"));
      return route.fulfill({ contentType: "application/pdf", body: pdf });
    }
    unexpected.push(`${request.method()} ${address.pathname}`);
    return json({ detail: "Unexpected mocked API request" }, 501);
  });
  await page.goto("/agency-reading#token=synthetic-agency-link");
  await expect(page.getByRole("heading", { name: "Record your agency’s reading", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/agency-reading\?contextId=context-1$/);
  expect(hashAtExchange).toBe("");
  expect(exchanges).toEqual([{ token: "synthetic-agency-link" }]);
  expect(anonymousSessionRequests).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: "Harbour Agency", exact: true })).toBeVisible();
  await expect(page.getByText("MV Atlas", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: /agency/i })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Completed peer readings", exact: true })).toHaveCount(0);
  await expect(page.getByText("Port Terminal", { exact: true })).toHaveCount(0);
  await page.getByLabel("Source document reference", { exact: true }).fill("AGENCY-SOURCE-001");
  await page.getByLabel("Measured quantity · Wheat · import", { exact: true }).fill("0");
  await expect(page.getByText("NIL · explicit zero", { exact: true })).toBeVisible();
  await fitsViewport(page);
  await page.getByRole("button", { name: "Submit reading", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your agency report", exact: true })).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({ contextId: "context-1", inputFingerprint: "scope-fingerprint", requestId: expect.any(String), representative: "Ada", sourceReference: "AGENCY-SOURCE-001", lines: [{ lineId: "line-1", status: "reported", quantity: "0", note: "" }] });
  expect(submissions[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
  for (const key of ["participantId", "agencyId", "actor", "recordedBy", "token"]) expect(submissions[0]).not.toHaveProperty(key);
  await expect(page.getByRole("table", { name: "Your submitted measurements", exact: true })).toContainText("NIL (0)");
  await expect(page.getByRole("heading", { name: "Completed peer readings", exact: true })).toBeVisible();
  await page.getByText("Port Terminal", { exact: true }).click();
  await expect(page.getByRole("table", { name: "Port Terminal completed readings", exact: true })).toContainText("17.5");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download your PDF", exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("agency-report-report-1.pdf");
  expect(await readFile((await download.path())!)).toEqual(pdf);
  expect(receiptContexts).toEqual(["context-1"]);
  await expect(page.getByRole("button", { name: /Download.*PDF/i })).toHaveCount(1);
  await expect(page).toHaveURL(/\/agency-reading\?contextId=context-1$/);
  expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain("synthetic-agency-link");
  expect(unexpected).toEqual([]);
});

test("import declaration wizard requires an explicit voyage and keeps NIL distinct from unknown", async ({ page }) => {
  const api = await installMeasurementApi(page);
  await page.goto("/app/measurements/new");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Vessel & voyage"]);
  await expect(page.getByRole("option", { name: /Cancelled voyage/ })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Vessel", exact: true }).selectOption({ label: "MV Atlas · NG" });
  await expect(page.getByRole("combobox", { name: "Voyage", exact: true })).toHaveValue("");
  await page.getByRole("combobox", { name: "Voyage", exact: true }).selectOption("call-1");
  const vessel = page.getByRole("region", { name: "Vessel & voyage", exact: true });
  await expect(vessel.getByText("12,345", { exact: true })).toBeVisible();
  await openDeclaration(page);
  await page.getByRole("radio", { name: "Containers", exact: true }).check();
  await expect(page.getByRole("checkbox", { name: /^Include cargo item/ })).toHaveCount(6);
  await expect(page.getByText("Export / loading", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: /^Direction/ })).toHaveCount(0);
  await includeCargo(page, 1).uncheck();
  await includeCargo(page, 4).check();
  await includeCargo(page, 6).check();
  await page.getByLabel("Manifest quantity 6", { exact: true }).fill("0");
  await page.getByLabel("Manifest / baseline reference 6", { exact: true }).fill("MANIFEST-NIL");
  await expect(page.getByText("NIL declared", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Manifest quantity 4", { exact: true })).toHaveValue("");
  await page.getByLabel("Cargo details for item 6", { exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Category 6", exact: true })).toBeDisabled();
  await fitsViewport(page);
  await createPlan(page);
  expect(api.requests.plans[0].title).toBe("Containers discharge tally · MV Atlas · CALL-001");
  expect(api.requests.plans[0].leadSurveyor).toBe("To be assigned");
  expect(api.requests.plans).toHaveLength(1);
  expect(api.requests.plans[0].callId).toBe("call-1");
  expect(api.requests.plans[0].lines).toEqual([
    expect.objectContaining({ description: "40 ft empty containers", direction: "import", containerSize: "40", loadStatus: "empty", unit: "count", manifestQuantity: null }),
    expect.objectContaining({ description: "45 ft empty containers", direction: "import", containerSize: "45", loadStatus: "empty", unit: "count", manifestQuantity: "0", baselineReference: "MANIFEST-NIL" }),
  ]);
  expect(api.requests.plans[0]).not.toHaveProperty("cargoType");
  expect(api.requests.plans[0].participants[0]).not.toHaveProperty("id");
  expect(api.requests.unexpected).toEqual([]);
});

test("import tanker products retain separate mass and volume quantities", async ({ page }) => {
  const api = await installMeasurementApi(page);
  await page.goto("/app/measurements/new?callId=call-1");
  await openDeclaration(page);
  await page.getByRole("radio", { name: "Tanker", exact: true }).click();
  await expect(page.getByText(/petroleum, chemicals or gas/).first()).toBeVisible();
  await page.getByLabel("Cargo description 1", { exact: true }).fill("Petroleum · AGO");
  await page.getByLabel("Manifest quantity 1", { exact: true }).fill("125.75");
  await page.getByLabel("Manifest / baseline reference 1", { exact: true }).fill("BOL-MASS");
  await page.getByRole("button", { name: "Add cargo item", exact: true }).click();
  await page.getByLabel("Cargo description 2", { exact: true }).fill("Chemicals · Methanol");
  await page.getByRole("combobox", { name: "Unit 2", exact: true }).selectOption("m3");
  await page.getByLabel("Quantity basis for item 2", { exact: true }).click();
  await expect(page.getByLabel("Quantity basis 2", { exact: true })).toHaveValue("Volume in cubic metres");
  await page.getByLabel("Manifest quantity 2", { exact: true }).fill("80.125");
  await page.getByLabel("Manifest / baseline reference 2", { exact: true }).fill("BOL-VOLUME");
  await fitsViewport(page);
  await createPlan(page);
  expect(api.requests.plans[0].method).toBe("Product measurement");
  expect(api.requests.plans[0].lines).toEqual([
    expect.objectContaining({ description: "Petroleum · AGO", category: "Liquid", direction: "import", unit: "tonnes", manifestQuantity: "125.75" }),
    expect.objectContaining({ description: "Chemicals · Methanol", category: "Liquid", direction: "import", unit: "m3", manifestQuantity: "80.125" }),
  ]);
  expect(api.requests.plans[0]).not.toHaveProperty("totalQuantity");
  expect(api.requests.unexpected).toEqual([]);
});

test("mixed import cargo preserves declarations and snapshots reusable agencies", async ({ page }) => {
  const api = await installMeasurementApi(page);
  await page.goto("/app/measurements/new?callId=call-1");
  await openDeclaration(page);
  await page.getByLabel("Cargo description 1", { exact: true }).fill("Wheat");
  await page.getByLabel("Manifest quantity 1", { exact: true }).fill("400");
  await page.getByLabel("Manifest / baseline reference 1", { exact: true }).fill("BOL-WHEAT");
  await page.getByRole("radio", { name: "Tanker", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Keep the cargo values you entered?");
  await page.getByRole("button", { name: "Keep items and use Mixed", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Mixed", exact: true })).toBeChecked();
  await expect(page.getByLabel("Manifest quantity 1", { exact: true })).toHaveValue("400");
  await page.getByRole("button", { name: "Add Vehicle", exact: true }).click();
  await page.getByLabel("Cargo description 2", { exact: true }).fill("Passenger cars");
  await page.getByLabel("Manifest quantity 2", { exact: true }).fill("5");
  await page.getByLabel("Manifest / baseline reference 2", { exact: true }).fill("BOL-CARS");
  await fitsViewport(page);
  await createPlan(page, ["Harbour Agency", "Port Terminal"], "link");
  expect(api.requests.plans).toHaveLength(1);
  expect(api.requests.links).toEqual([{ participantId: "created-party-0", expiryDays: 7 }]);
  expect(api.requests.plans[0].lines.map(line => [line.category, line.direction, line.unit, line.manifestQuantity])).toEqual([["Bulk", "import", "tonnes", "400"], ["Vehicle", "import", "count", "5"]]);
  expect(api.requests.plans[0].participants).toEqual([
    { name: "Harbour Agency", role: "Agent", representative: "Ada Agent", requiredSubmission: true, requiredApproval: true },
    { name: "Port Terminal", role: "Terminal operator", representative: "Terminal Lead", requiredSubmission: true, requiredApproval: true },
  ]);
  expect(api.requests.plans[0]).not.toHaveProperty("totalQuantity");
  expect(api.requests.unexpected).toEqual([]);
});

test("admin creates agencies inline without losing the declaration and protects voyage boundaries", async ({ page }) => {
  const api = await installMeasurementApi(page, measurementFixture(), { admin: true, seedAgencies: false });
  await page.goto("/app/settings/agencies");
  await expect(page.getByText(/saved on this browser/)).toBeVisible();
  await page.getByLabel("Agency name", { exact: true }).fill("Reusable Marine Agency");
  await page.getByLabel("Default representative", { exact: true }).fill("Regular Agent");
  await page.getByRole("button", { name: "Save agency", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reusable Marine Agency", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Reusable Marine Agency", exact: true })).toBeVisible();
  await page.goto("/app/measurements/new?callId=call-1");
  await openDeclaration(page);
  await page.getByLabel("Cargo description 1", { exact: true }).fill("Wheat");
  await page.getByLabel("Manifest quantity 1", { exact: true }).fill("400");
  await page.getByLabel("Vessel declaration reference", { exact: true }).fill("OWNER-VOYAGE-001");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select agency Reusable Marine Agency", exact: true }).check();
  await expect(page.getByLabel("Representative for Reusable Marine Agency", { exact: true })).toHaveValue("Regular Agent");
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.getByRole("combobox", { name: "Voyage", exact: true }).selectOption("call-3");
  await expect(page.getByRole("alert")).toContainText("This declaration belongs to the current voyage.");
  await page.getByRole("button", { name: "Clear declaration and change voyage", exact: true }).click();
  await openDeclaration(page);
  await expect(page.getByLabel("Manifest quantity 1", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Vessel declaration reference", { exact: true })).toHaveValue("");
  await page.getByLabel("Cargo description 1", { exact: true }).fill("New voyage wheat");
  await page.getByLabel("Manifest quantity 1", { exact: true }).fill("500");
  await page.getByLabel("Vessel declaration reference", { exact: true }).fill("OWNER-VOYAGE-003");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Select agency Reusable Marine Agency", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Create agency", exact: true }).click();
  await page.getByLabel("Agency name", { exact: true }).fill("Voyage Survey Agency");
  await page.getByRole("combobox", { name: "Agency role", exact: true }).selectOption("Surveyor");
  await page.getByRole("button", { name: "Save agency", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Select agency Voyage Survey Agency", exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "Finish", exact: true })).toBeDisabled();
  await page.getByRole("group", { name: "Agency Voyage Survey Agency", exact: true }).getByRole("button", { name: "Enter reading", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agency readings", exact: true })).toBeVisible();
  expect(api.requests.plans).toHaveLength(0);
  await page.getByLabel("Representative for Voyage Survey Agency", { exact: true }).fill("Voyage Surveyor");
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.getByLabel("Manifest quantity 1", { exact: true })).toHaveValue("500");
  await expect(page.getByLabel("Vessel declaration reference", { exact: true })).toHaveValue("OWNER-VOYAGE-003");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await fitsViewport(page);
  await openAgencyReading(page, "Voyage Survey Agency");
  await openAgencyReading(page, "Reusable Marine Agency");
  expect(api.requests.plans).toHaveLength(1);
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/measurements$/);
  await expect(page.getByRole("heading", { name: "Voyage log", exact: true })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Measurement workspaces", exact: true })).toHaveCount(0);
  expect(api.requests.plans[0]).toMatchObject({ callId: "call-3", lines: [expect.objectContaining({ manifestQuantity: "500", baselineReference: "OWNER-VOYAGE-003", direction: "import" })], participants: [expect.objectContaining({ name: "Reusable Marine Agency", representative: "Regular Agent" }), expect.objectContaining({ name: "Voyage Survey Agency", representative: "Voyage Surveyor" })] });
  await page.goto("/app/settings/agencies");
  await expect(page.getByRole("heading", { name: "Voyage Survey Agency", exact: true })).toBeVisible();
  expect(api.requests.unexpected).toEqual([]);
});

test("agency drafts stay isolated and NPA review preserves the agency readings", async ({ page }) => {
  const api = await installMeasurementApi(page);
  await page.goto("/app/measurements/plan-1?workspace=reconciliation");
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
  await expect(page.getByRole("heading", { name: "Record agency measurement", exact: true })).toHaveCount(0);
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
