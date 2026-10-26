import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { measurementFixture } from "../../src/measurements/fixtures.test-support";
import { guestContext } from "../../src/measurements/guest.test-support";
import type { GuestReadingInput } from "../../src/measurements/guestTypes";
import type { Evidence, MeasurementPlan, PlanInput, ReconciliationInput, SubmissionInput } from "../../src/measurements/types";
import type { AgencyProfile } from "../../src/measurements/types";
import type { AppState, AuthSession, VesselCall } from "../../src/types";

test.skip(process.env.PLAYWRIGHT_REAL_BACKEND === "1", "These presentation checks use an isolated mocked API.");

type MockUser = AuthSession["user"];
const recorder: MockUser = { id: "recorder-1", name: "Mariam Recorder", email: "recorder@example.test", role: "Operations", status: "active", emailVerified: true, mfaEnabled: true, mfaRequired: false };
const approver: MockUser = { id: "approver-1", name: "Ada Approver", email: "approver@example.test", role: "Admin", status: "active", emailVerified: true, mfaEnabled: true, mfaRequired: false };

async function installMeasurementApi(page: Page, initialPlan = measurementFixture(), options: { admin?: boolean; seedAgencies?: boolean; additionalPlans?: MeasurementPlan[] } = {}) {
  let plan: MeasurementPlan = structuredClone(initialPlan);
  const additionalPlans = options.additionalPlans ?? [];
  const requests = {
    plans: [] as PlanInput[],
    links: [] as { participantId: string; expiryDays: number }[],
    uploads: [] as string[],
    submissions: [] as (SubmissionInput & { version: number })[],
    reconciliations: [] as (ReconciliationInput & { version: number })[],
    unexpected: [] as string[],
  };
  const org: NonNullable<AuthSession["org"]> = { id: "org-1", registered: true, name: "Mock Marine", rcNumber: "", email: "office@example.test", phone: "", address: "", designatedPort: "Port of Calabar", primaryPort: "Port of Calabar", ports: ["Port of Calabar"], logo: null, rev: 1 };
  const vessel: VesselCall = { id: "call-1", vesselName: "MV Atlas", reference: "CALL-001", type: "Container", flag: "NG", nrt: 12345, eta: "2026-10-07T12:00:00Z", sailingEta: "", berth: "Berth 3", berthDate: null, status: "pending", notes: "", version: 1, registered: "2026-10-01" };
  const calls: VesselCall[] = [vessel, { ...vessel, id: "call-2", vesselName: "MV Horizon", reference: "CALL-002", type: "Tanker", berth: "Berth 8" }, { ...vessel, id: "call-3", reference: "CALL-003", eta: "2026-10-10T12:00:00Z" }, { ...vessel, id: "cancelled", vesselName: "Cancelled voyage", status: "cancelled" }];
  const state: AppState = { rev: 1, org, calls, inspections: [], invoices: [], invoiceStatusSteps: [], settings: { commissionRate: 0.2, exchangeRate: 1500, liquidDuesRates: { government: 1, private: 2, international: 3 }, dryDuesRate: 1, portName: "Port of Calabar", terminals: [] } };
  const basePermissions = ["organization.view", "calls.view", "measurements.view", "measurements.manage", "invoices.view", "evidence.manage"];
  const sessionFor = (user: MockUser): AuthSession => ({
    user, org, platformAccess: null,
    permissions: [...basePermissions, ...(user.role === "Admin" ? ["settings.view", "settings.manage", "measurements.approve"] : [])],
  });
  let session = sessionFor(options.admin ? { ...recorder, role: "Admin" } : recorder);

  let agencies: AgencyProfile[] = options.seedAgencies === false ? [] : [
    { id: "agency-agent", name: "Harbour Agency", role: "Agent", representative: "Ada Agent", active: true, version: 1 },
    { id: "agency-terminal", name: "Port Terminal", role: "Terminal operator", representative: "Terminal Lead", active: true, version: 1 },
  ];
  const planPath = (suffix = "") => new RegExp(`^/api/measurement-plans/[^/]+${suffix}$`);

  // Block unrecognized API requests so these browser checks cannot modify a
  // real tenant even when run against an externally provided frontend server.
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/agencies" && request.method() === "GET") return json({ agencies });
    if (path === "/api/agencies" && request.method() === "POST") {
      const input = request.postDataJSON() as Omit<AgencyProfile, "id">;
      const agency = { ...input, id: `agency-${agencies.length + 1}`, version: 1 };
      agencies.push(agency);
      return json({ agency }, 201);
    }
    if (path.startsWith("/api/agencies/") && request.method() === "PATCH") {
      const input = request.postDataJSON() as AgencyProfile;
      const id = path.split("/").at(-1)!;
      const previous = agencies.find(item => item.id === id);
      if (!previous || previous.version !== input.version) return json({ detail: "Agency changed" }, 409);
      const agency = { ...input, id, version: (input.version ?? 1) + 1 };
      agencies = agencies.map(item => item.id === id ? agency : item);
      return json({ agency });
    }
    if (path === "/api/runtime-config") return json({ sentry: { dsn: "", environment: "test", release: "mocked" } });
    if (path === "/api/auth/me") return json(session);
    if (path === "/api/auth/csrf") return json({ csrfToken: "mock-csrf" });
    if (path === "/api/state") return json(url.searchParams.has("rev") ? { changed: false, rev: 1 } : state);
    if (path === "/api/measurement-plans" && request.method() === "GET") return json({ plans: [plan, ...additionalPlans] });
    if (path === "/api/measurement-plans" && request.method() === "POST") {
      const input = request.postDataJSON() as PlanInput;
      requests.plans.push(structuredClone(input));
      const call = calls.find(item => item.id === input.callId)!;
      plan = { ...plan, ...input, id: "created-plan", status: "scheduled", version: 1, vesselName: call.vesselName, callReference: call.reference, lines: input.lines.map((line, index) => ({ ...line, id: `created-line-${index}` })), participants: input.participants.map((party, index) => ({ ...party, id: `created-party-${index}` })), submissions: [], reconciliations: [], assessments: [], evidence: [] };
      return json({ plan, rev: 2 }, 201);
    }
    if (planPath().test(path) && request.method() === "GET") {
      const found = [plan, ...additionalPlans].find(item => path === `/api/measurement-plans/${item.id}`);
      return found ? json({ plan: found }) : json({ detail: "Not found" }, 404);
    }
    if (planPath("/agency-links").test(path) && request.method() === "GET") return json({ links: [] });
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
      plan = { ...plan, version: plan.version + 1, submissions: [...plan.submissions, { ...input, id: `new-return-${requests.submissions.length}`, revision, recordedBy: session.user, recordedAt: "2026-10-04T12:00:00Z" }] };
      return json({ plan, rev: 2 }, 201);
    }
    if (path === `/api/measurement-plans/${plan.id}/reconciliations` && request.method() === "POST") {
      const input = request.postDataJSON() as ReconciliationInput & { version: number };
      requests.reconciliations.push(structuredClone(input));
      plan = { ...plan, version: plan.version + 1, reconciliations: [{ ...input, id: "new-reconciliation", revision: 1, status: "draft", createdBy: session.user, createdAt: "2026-10-04T12:00:00Z", finalizedBy: null, finalizedAt: null, approvals: [], submissionIds: plan.submissions.map(item => item.id), lines: input.lines.map(line => ({ ...line, manifestQuantity: plan.lines.find(item => item.id === line.lineId)!.manifestQuantity, variance: null })) }] };
      return json({ plan, rev: 3 }, 201);
    }
    requests.unexpected.push(`${request.method()} ${path}`);
    return json({ detail: "Unexpected mocked API request" }, 501);
  });
  return {
    requests,
    plan: () => plan,
    // The preview approval store lives in this browser, so switching the
    // signed-in user and reloading keeps the submitted versions.
    signInAs: async (user: MockUser) => { session = sessionFor(user); await page.reload(); },
  };
}

async function fitsViewport(page: Page) {
  const device = page.viewportSize()!.width;
  // Mobile WebKit widens its layout viewport to fit oversized content, so
  // measure against the device width rather than the document's own width.
  const { width, culprits } = await page.locator("html").evaluate((html, limit) => {
    // The e2e tsconfig has no DOM types, so describe the few members used here.
    type Box = { tagName: string; className: unknown; parentElement: Box | null; getBoundingClientRect(): { right: number } };
    const root = html as unknown as Box & { scrollWidth: number; querySelectorAll(selector: string): ArrayLike<Box> };
    const style = (element: Box) => (globalThis as unknown as { getComputedStyle(element: Box): { overflowX: string; position: string } }).getComputedStyle(element);
    const name = (element: Box) => `${element.tagName.toLowerCase()}${typeof element.className === "string" && element.className ? `.${element.className.trim().split(/\s+/).join(".")}` : ""}`;
    const clipped = (element: Box) => {
      for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) if (style(parent).overflowX !== "visible") return true;
      return false;
    };
    // Absolutely positioned content escapes an unpositioned scroll wrapper.
    const escapes = (element: Box) => !clipped(element) || ["absolute", "fixed"].includes(style(element).position);
    // Report the outermost offending elements, not every descendant.
    const culprits = Array.from(root.querySelectorAll("body *")).filter(element => element.getBoundingClientRect().right > limit && escapes(element) && !(element.parentElement && element.parentElement.getBoundingClientRect().right > limit && escapes(element.parentElement))).slice(0, 5).map(element => `${name(element.parentElement!)} > ${name(element)}`);
    return { width: root.scrollWidth, culprits };
  }, device + 1);
  expect(width, `Cargo tables should scroll inside the viewport; overflowing: ${culprits.join(" | ")}`).toBeLessThanOrEqual(device + 1);
}

const continueButton = (page: Page) => page.getByRole("button", { name: "Continue", exact: true });
const toAgencies = (page: Page) => page.getByRole("button", { name: "Continue to agencies", exact: true });
const createVoyage = (page: Page) => page.getByRole("button", { name: "Create voyage and invite agencies", exact: true });
const kind = (page: Page, label: RegExp) => page.getByRole("button", { name: label });
const stepper = (page: Page) => page.getByRole("navigation", { name: "Voyage steps", exact: true });

test("new voyage records containers by size and load with the paid declaration, then tracks each agency’s link and reading", async ({ page }) => {
  const api = await installMeasurementApi(page);
  const pdf = Buffer.from("%PDF-1.4\n% Synthetic agency evidence\n%%EOF\n");
  const evidenceName = "synthetic-agency-tally.pdf";
  await page.goto("/app/measurements/new");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("New voyage");
  await expect(page.getByRole("navigation", { name: "Breadcrumb", exact: true })).toContainText("New voyage");
  await expect(page.getByRole("list", { name: "Voyage setup steps", exact: true }).locator('[aria-current="step"]')).toContainText("Vessel & voyage");
  await expect(continueButton(page)).toBeDisabled();
  await expect(page.getByRole("option", { name: /Cancelled voyage/ })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Vessel", exact: true }).selectOption({ label: "MV Atlas · NG" });
  await expect(page.getByRole("combobox", { name: "Voyage", exact: true })).toHaveValue("");
  await page.getByRole("combobox", { name: "Voyage", exact: true }).selectOption("call-1");
  await expect(page.getByText("12,345", { exact: true })).toBeVisible();
  await continueButton(page).click();

  await expect(page.getByRole("heading", { name: "What the vessel owner declared and paid for", exact: true })).toBeVisible();
  await expect(kind(page, /^Containers/)).toHaveAttribute("aria-pressed", "true");
  await toAgencies(page).click();
  await expect(page.getByRole("alert")).toContainText("Enter at least one declared quantity.");
  await page.getByLabel("40 ft laden declared", { exact: true }).fill("12");
  await page.getByLabel("45 ft empty declared", { exact: true }).fill("0");
  await expect(page.getByText("Declared: 12 containers", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Enter the manifest or bill of lading reference.");
  await page.getByLabel("Manifest / bill of lading reference", { exact: true }).fill("MAN-ATLAS-001");
  await page.getByLabel("Payer (vessel owner)", { exact: true }).fill("Atlas Shipping Lines");
  await page.getByLabel("Declaration invoice number", { exact: true }).fill("NPA-DEC-001");
  await page.getByLabel("Amount paid", { exact: true }).fill("1,250.50");
  await page.getByRole("radio", { name: "Confirmed paid", exact: true }).check();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await fitsViewport(page);
  await toAgencies(page).click();

  await expect(page.getByRole("heading", { name: "Which agencies will report readings?", exact: true })).toBeVisible();
  await expect(createVoyage(page)).toBeDisabled();
  await page.getByRole("checkbox", { name: "Select agency Harbour Agency", exact: true }).check();
  await expect(page.getByLabel("Representative for Harbour Agency", { exact: true })).toHaveValue("Ada Agent");
  await expect(page.getByText("Declaration · 2 cargo lines · 12 containers", { exact: true })).toBeVisible();
  await createVoyage(page).click();

  await expect(page).toHaveURL(/\/app\/measurements\/voyages\/call-1\/agencies$/);
  expect(api.requests.plans).toHaveLength(1);
  expect(api.requests.plans[0]).toMatchObject({ callId: "call-1", title: "Containers discharge tally · MV Atlas · CALL-001", method: "Physical container tally", leadSurveyor: "To be assigned" });
  expect(api.requests.plans[0].lines).toEqual([
    expect.objectContaining({ description: "40 ft laden containers", category: "Container", direction: "import", containerSize: "40", loadStatus: "laden", unit: "count", manifestQuantity: "12", baselineReference: "MAN-ATLAS-001" }),
    expect.objectContaining({ description: "45 ft empty containers", category: "Container", direction: "import", containerSize: "45", loadStatus: "empty", unit: "count", manifestQuantity: "0", baselineReference: "MAN-ATLAS-001" }),
  ]);
  expect(api.requests.plans[0].participants).toEqual([{ agencyId: "agency-agent", name: "Harbour Agency", role: "Agent", representative: "Ada Agent", requiredSubmission: true, requiredApproval: true }]);
  expect(api.requests.plans[0]).not.toHaveProperty("totalQuantity");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("MV Atlas");
  await expect(page.getByRole("navigation", { name: "Breadcrumb", exact: true })).toContainText("CALL-001");
  await expect(stepper(page).getByRole("link")).toHaveCount(4);
  await expect(stepper(page).locator('[aria-current="step"]')).toContainText("Agency readings");
  await expect(stepper(page).getByRole("link", { name: /^Declaration/ })).toContainText("Paid · 12 containers");
  await expect(page.getByRole("heading", { name: "Agency readings · 0 of 1 submitted", exact: true })).toBeVisible();
  const row = page.getByRole("row", { name: /^Harbour Agency/ });
  await expect(row.getByText("Not invited", { exact: true })).toBeVisible();

  await row.getByRole("button", { name: "Send link for Harbour Agency", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Send a secure link", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Share the secure link", exact: true })).toBeVisible();
  expect(api.requests.links).toEqual([{ participantId: "created-party-0", expiryDays: 7 }]);
  await expect(page.getByLabel("Link for Harbour Agency", { exact: true })).toHaveValue("https://example.test/agency-reading#token=synthetic-created-party-0");
  await page.getByRole("textbox", { name: /^Agency email/ }).fill("ops@harbour.example");
  await expect(page.getByRole("link", { name: "Email the link", exact: true })).toHaveAttribute("href", /^mailto:ops%40harbour\.example\?subject=.*synthetic-created-party-0/);
  await expect(row.getByText(/^Link sent · expires/)).toBeVisible();
  await page.getByRole("button", { name: "Close link panel", exact: true }).click();

  await row.getByRole("button", { name: "Enter reading for Harbour Agency", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Enter reading · Harbour Agency", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Reporting agency", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Supporting evidence (optional)", exact: true })).toBeVisible();
  await page.getByLabel("Source document reference", { exact: true }).fill("AGENCY-READING-1");
  await page.getByLabel("Reported quantity · 40 ft laden containers · import · 40 ft · laden", { exact: true }).fill("13");
  await page.getByLabel("Reported quantity · 45 ft empty containers · import · 45 ft · empty", { exact: true }).fill("0");
  await page.locator('input[type="file"]').setInputFiles({ name: evidenceName, mimeType: "application/pdf", buffer: pdf });
  await expect(page.getByLabel(evidenceName, { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Submit reading", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Agency readings · 1 of 1 submitted", exact: true })).toBeVisible();
  await expect(row.getByText("Submitted", { exact: true })).toBeVisible();
  expect(api.requests.submissions).toHaveLength(1);
  expect(api.requests.submissions[0]).toMatchObject({ participantId: "created-party-0", version: 1, sourceReference: "AGENCY-READING-1", evidenceIds: ["uploaded-evidence"], lines: [{ lineId: "created-line-0", quantity: "13", status: "reported", note: "" }, { lineId: "created-line-1", quantity: "0", status: "reported", note: "" }] });
  expect(api.requests.uploads).toEqual(["application/pdf"]);
  expect(api.plan().evidence).toEqual([expect.objectContaining({ id: "uploaded-evidence", fileName: evidenceName, contentType: "application/pdf", size: pdf.byteLength, checksum: `sha256:${createHash("sha256").update(pdf).digest("hex")}` })]);
  await row.getByRole("button", { name: "View Harbour Agency reading", exact: true }).click();
  await expect(page.getByRole("table", { name: "Submitted reading", exact: true })).toContainText("13");

  await page.getByRole("link", { name: "Open readings report", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/measurements\/voyages\/call-1\/readings$/);
  const report = page.getByRole("table", { name: "Paid declaration, each agency’s reading and NPA’s final agreed quantity for every cargo line", exact: true });
  await expect(report.getByRole("columnheader", { name: /^Harbour Agency/ })).toBeVisible();
  const laden = report.getByRole("row", { name: /^40 ft · Laden/ });
  await expect(laden.getByText("13", { exact: true })).toBeVisible();
  await expect(laden.getByText("+1", { exact: true })).toBeVisible();
  const empty = report.getByRole("row", { name: /^45 ft · Empty/ });
  await expect(empty.getByText("NIL (0)", { exact: true }).first()).toBeVisible();
  await expect(empty.getByText("All agree · accepted", { exact: true })).toBeVisible();
  expect(api.requests.unexpected).toEqual([]);
});

test("one voyage can mix containers, tanker products and vehicles while each keeps its own unit", async ({ page }) => {
  const api = await installMeasurementApi(page);
  await page.goto("/app/measurements/new?callId=call-2");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("MV Horizon");
  await expect(stepper(page).locator('[aria-current="step"]')).toContainText("Declaration");
  await expect(page.getByRole("list", { name: "Voyage setup steps", exact: true }).getByRole("listitem")).toHaveCount(2);
  await expect(page.getByText("This voyage already has a declaration.", { exact: false })).toHaveCount(0);
  // A tanker voyage starts with tanker products; containers are added alongside.
  await expect(kind(page, /^Tanker \/ liquid/)).toHaveAttribute("aria-pressed", "true");
  await expect(kind(page, /^Containers/)).toHaveAttribute("aria-pressed", "false");
  await kind(page, /^Containers/).click();
  await page.getByLabel("20 ft laden declared", { exact: true }).fill("5");
  await expect(page.getByText("Mixed cargo · 2 types on this voyage", { exact: true })).toBeVisible();
  await page.getByLabel("product 1", { exact: true }).selectOption("AGO — Automotive Gas Oil");
  await page.getByLabel("Declared quantity product 1", { exact: true }).fill("125.75");
  await page.getByRole("button", { name: "Add product", exact: true }).click();
  await page.getByLabel("product 2", { exact: true }).selectOption({ label: "Other product…" });
  await page.getByLabel("Other product 2", { exact: true }).fill("Methanol");
  await page.getByLabel("Unit product 2", { exact: true }).selectOption("m3");
  await page.getByLabel("Declared quantity product 2", { exact: true }).fill("80.125");
  await kind(page, /^Vehicles/).click();
  await page.getByLabel("Cars", { exact: true }).fill("3");
  await expect(page.getByText("Mixed cargo · 3 types on this voyage", { exact: true })).toBeVisible();
  await page.getByLabel("Manifest / bill of lading reference", { exact: true }).fill("BOL-MIXED");
  await expect(page.getByText("Declared: 5 containers · 125.75 t · 80.125 m³ · 3 vehicles", { exact: true })).toBeVisible();
  await fitsViewport(page);
  await toAgencies(page).click();
  for (const name of ["Harbour Agency", "Port Terminal"]) await page.getByRole("checkbox", { name: `Select agency ${name}`, exact: true }).check();
  await createVoyage(page).click();

  await expect(page).toHaveURL(/\/app\/measurements\/voyages\/call-2\/agencies$/);
  expect(api.requests.plans[0]).toMatchObject({ callId: "call-2", title: "Mixed cargo discharge tally · MV Horizon · CALL-002", method: "Cargo survey and tally" });
  expect(api.requests.plans[0].lines.map(line => [line.category, line.description, line.direction, line.unit, line.manifestQuantity])).toEqual([
    ["Container", "20 ft laden containers", "import", "count", "5"],
    ["Liquid", "AGO — Automotive Gas Oil", "import", "tonnes", "125.75"],
    ["Liquid", "Methanol", "import", "m3", "80.125"],
    ["Vehicle", "Cars", "import", "count", "3"],
  ]);
  expect(api.requests.plans[0].participants.map(party => party.agencyId)).toEqual(["agency-agent", "agency-terminal"]);
  expect(api.requests.plans[0]).not.toHaveProperty("totalQuantity");
  expect(api.requests.unexpected).toEqual([]);
});

test("changing voyage clears its declaration, the vessel’s last agencies are suggested and an admin can add one inline", async ({ page }) => {
  const previousVoyage = measurementFixture();
  previousVoyage.participants[1] = { ...previousVoyage.participants[1], agencyId: "agency-terminal", name: "Port Terminal" };
  const api = await installMeasurementApi(page, previousVoyage, { admin: true });
  await page.goto("/app/settings/agencies");
  await expect(page.getByText(/shared with its authorized users/)).toBeVisible();
  await page.getByLabel("Agency name", { exact: true }).fill("Reusable Marine Agency");
  await page.getByLabel("Default representative", { exact: true }).fill("Regular Agent");
  await page.getByRole("button", { name: "Save agency", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reusable Marine Agency", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Reusable Marine Agency", exact: true })).toBeVisible();

  await page.goto("/app/measurements/new");
  await page.getByRole("combobox", { name: "Vessel", exact: true }).selectOption({ label: "MV Atlas · NG" });
  await page.getByRole("combobox", { name: "Voyage", exact: true }).selectOption("call-1");
  await continueButton(page).click();
  await page.getByLabel("40 ft laden declared", { exact: true }).fill("7");
  await page.getByLabel("Manifest / bill of lading reference", { exact: true }).fill("OWNER-VOYAGE-001");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("combobox", { name: "Voyage", exact: true }).selectOption("call-3");
  await expect(page.getByRole("status").filter({ hasText: "You changed voyage, so the declaration was cleared." })).toBeVisible();
  await continueButton(page).click();
  await expect(page.getByLabel("40 ft laden declared", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Manifest / bill of lading reference", { exact: true })).toHaveValue("");
  await page.getByLabel("40 ft laden declared", { exact: true }).fill("9");
  await page.getByLabel("Manifest / bill of lading reference", { exact: true }).fill("OWNER-VOYAGE-003");
  await toAgencies(page).click();

  await expect(page.getByText(/Agencies from this vessel’s last voyage are pre-selected\./)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select agency Port Terminal", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Select agency Harbour Agency", exact: true })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Select agency Reusable Marine Agency", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "New agency", exact: true }).click();
  await page.getByLabel("Agency name", { exact: true }).fill("Voyage Survey Agency");
  await page.getByRole("combobox", { name: "Agency role", exact: true }).selectOption("Surveyor");
  await page.getByLabel("Default representative (optional)", { exact: true }).fill("Voyage Surveyor");
  await page.getByRole("button", { name: "Save agency", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Select agency Voyage Survey Agency", exact: true })).toBeChecked();
  await expect(page.getByLabel("Representative for Voyage Survey Agency", { exact: true })).toHaveValue("Voyage Surveyor");
  expect(api.requests.plans).toHaveLength(0);

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByLabel("40 ft laden declared", { exact: true })).toHaveValue("9");
  await toAgencies(page).click();
  await expect(page.getByRole("checkbox", { name: "Select agency Port Terminal", exact: true })).toBeChecked();
  await fitsViewport(page);
  await createVoyage(page).click();
  await expect(page).toHaveURL(/\/app\/measurements\/voyages\/call-3\/agencies$/);
  expect(api.requests.plans).toHaveLength(1);
  expect(api.requests.plans[0]).toMatchObject({
    callId: "call-3",
    lines: [expect.objectContaining({ description: "40 ft laden containers", manifestQuantity: "9", baselineReference: "OWNER-VOYAGE-003", direction: "import" })],
    participants: [expect.objectContaining({ agencyId: "agency-terminal", name: "Port Terminal" }), expect.objectContaining({ name: "Voyage Survey Agency", role: "Surveyor", representative: "Voyage Surveyor" })],
  });
  await page.goto("/app/settings/agencies");
  await expect(page.getByRole("heading", { name: "Voyage Survey Agency", exact: true })).toBeVisible();
  expect(api.requests.unexpected).toEqual([]);
});

test("voyages list one row per voyage and the readings report keeps sheets, NIL and missing readings distinct", async ({ page }) => {
  const first = measurementFixture();
  first.title = "Import declaration A";
  first.lines[0].manifestQuantity = "100";
  first.lines.push({ ...first.lines[0], id: "tank-line", description: "Unused cargo tank", category: "Liquid", unit: "m3", basis: "Volume in cubic metres", manifestQuantity: "0", baselineReference: "OWNER-NIL-TANK" });
  first.submissions[0].lines = [{ lineId: "line-1", quantity: "0", status: "reported", note: "" }, { lineId: "tank-line", quantity: null, status: "not-applicable", note: "No liquid cargo carried" }];
  const second: MeasurementPlan = { ...structuredClone(first), id: "second-sheet", title: "Import declaration B", scope: "Rice parcel", lines: [{ ...first.lines[0], id: "rice-line", description: "Rice", manifestQuantity: null, baselineReference: "" }], submissions: [] };
  const other: MeasurementPlan = { ...structuredClone(first), id: "other-voyage-sheet", callId: "call-2", callReference: "CALL-002", vesselName: "MV Horizon", title: "Other voyage declaration", lines: [{ ...first.lines[0], id: "other-line", description: "Other voyage cargo", manifestQuantity: "98765" }], submissions: [] };
  const api = await installMeasurementApi(page, first, { additionalPlans: [second, other] });

  await page.goto("/app/measurements");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Voyages");
  const voyages = page.getByRole("table", { name: "Voyages, their declaration, agency readings and current step", exact: true });
  await expect(voyages.getByRole("columnheader")).toHaveCount(6);
  await expect(page.getByText("4 voyages", { exact: true })).toBeVisible();
  const atlas = voyages.getByRole("row", { name: "MV Atlas · CALL-001", exact: true });
  await expect(atlas).toHaveCount(1);
  await expect(atlas.getByText("1 of 4", { exact: true })).toBeVisible();
  await expect(atlas.getByText("Declaration", { exact: true })).toBeVisible();
  await expect(atlas.getByRole("link", { name: "Review declaration · MV Atlas CALL-001", exact: true })).toBeVisible();
  const horizon = voyages.getByRole("row", { name: "MV Horizon · CALL-002", exact: true });
  await expect(horizon.getByText("0 of 2", { exact: true })).toBeVisible();
  await expect(horizon.getByText("Agency readings", { exact: true }).first()).toBeVisible();
  await expect(horizon.getByRole("link", { name: "Agency readings · MV Horizon CALL-002", exact: true })).toHaveAttribute("href", "/app/measurements/voyages/call-2/agencies");
  await expect(voyages.getByRole("row", { name: "Cancelled voyage · CALL-001", exact: true }).getByText("Cancelled", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Voyage step", exact: true }).selectOption("collecting");
  await expect(page.getByText("1 voyage", { exact: true })).toBeVisible();
  await expect(voyages.getByRole("row", { name: "MV Atlas · CALL-001", exact: true })).toHaveCount(0);
  await fitsViewport(page);

  // Old measurement links open the voyage's agency step.
  await page.goto("/app/measurements/plan-1");
  await expect(page).toHaveURL(/\/app\/measurements\/voyages\/call-1\/agencies$/);
  await stepper(page).getByRole("link", { name: /^Readings report/ }).click();
  await expect(page).toHaveURL(/\/app\/measurements\/voyages\/call-1\/readings$/);
  const report = page.getByRole("table", { name: "Paid declaration, each agency’s reading and NPA’s final agreed quantity for every cargo line", exact: true });
  await expect(report.getByRole("columnheader", { name: "Paid declaration", exact: true })).toBeVisible();
  await expect(report.getByRole("columnheader", { name: /^Harbour Agent/ })).toBeVisible();
  await expect(report.getByRole("columnheader", { name: /^Terminal One/ })).toBeVisible();
  await expect(report.getByRole("rowheader", { name: `${first.title} ${first.scope}`, exact: true })).toBeVisible();
  await expect(report.getByRole("rowheader", { name: `${second.title} ${second.scope}`, exact: true })).toBeVisible();
  const wheat = report.getByRole("row", { name: /^Wheat\s/ });
  await expect(wheat.getByText("100", { exact: true })).toBeVisible();
  await expect(wheat.getByText("NIL (0)", { exact: true })).toBeVisible();
  await expect(wheat.getByText("Awaiting", { exact: true })).toBeVisible();
  const rice = report.getByRole("row", { name: /^Rice\s/ });
  await expect(rice.getByText("Not provided", { exact: true })).toBeVisible();
  await expect(rice.getByText("Awaiting", { exact: true })).toHaveCount(2);
  const tank = report.getByRole("row", { name: /^Unused cargo tank/ });
  await expect(tank.getByText("NIL (0)", { exact: true })).toBeVisible();
  await expect(tank.getByText("N/A", { exact: true })).toBeVisible();
  await expect(tank.getByText("No liquid cargo carried", { exact: true })).toBeVisible();
  await expect(page.getByText("Before you can submit", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit for approval", exact: true })).toBeDisabled();
  await expect(page.getByText("Other voyage cargo", { exact: true })).toHaveCount(0);
  await expect(page.getByText("98765", { exact: true })).toHaveCount(0);
  const scroll = page.getByRole("region", { name: "Readings compared with the paid declaration", exact: true });
  await expect(scroll).toHaveCSS("overflow-x", "auto");
  await fitsViewport(page);
  if (page.viewportSize()!.width < 600) {
    const size = await scroll.evaluate(element => ({ content: element.scrollWidth, viewport: element.clientWidth }));
    expect(size.content).toBeGreaterThan(size.viewport);
  }
  expect(api.requests.unexpected).toEqual([]);
});

test("final quantities need a second reviewer, who can return them with a comment before approving", async ({ page }) => {
  const sheet = measurementFixture();
  sheet.lines.push({ ...sheet.lines[0], id: "line-2", description: "Maize", manifestQuantity: "50.000", baselineReference: "BL-002" });
  sheet.submissions[0].lines.push({ lineId: "line-2", status: "reported", quantity: "50.000", note: "" });
  sheet.submissions.push({ ...sheet.submissions[0], id: "sub-2", participantId: "party-2", sourceReference: "TERMINAL-001", evidenceIds: [], recordedBy: null, lines: [{ lineId: "line-1", status: "reported", quantity: "19509.000", note: "" }, { lineId: "line-2", status: "reported", quantity: "50.000", note: "" }] });
  const api = await installMeasurementApi(page, sheet);
  const finalWheat = page.getByLabel("NPA final quantity · Wheat · Discharge survey", { exact: true });
  const reviewNote = page.getByRole("textbox", { name: "Review note", exact: true });
  const submit = page.getByRole("button", { name: "Submit for approval", exact: true });

  // The former reconciliation page now opens the readings report.
  await page.goto("/app/measurements/voyages/call-1/reconciliation");
  await expect(page).toHaveURL(/\/app\/measurements\/voyages\/call-1\/readings$/);
  await expect(stepper(page).locator('[aria-current="step"]')).toContainText("1 line differs");
  await expect(page.getByText("2 cargo lines · 2 agencies", { exact: true })).toBeVisible();
  await expect(page.getByText("2 of 2 readings in", { exact: true })).toBeVisible();
  const report = page.getByRole("table", { name: "Paid declaration, each agency’s reading and NPA’s final agreed quantity for every cargo line", exact: true });
  await expect(report.getByRole("columnheader", { name: /^Terminal One.*Via secure link/ })).toBeVisible();
  const maize = report.getByRole("row", { name: /^Maize/ });
  await expect(maize.getByText("All agree · accepted", { exact: true })).toBeVisible();
  const wheat = report.getByRole("row", { name: /^Wheat/ });
  await expect(wheat.getByText("+8", { exact: true })).toBeVisible();
  await expect(wheat.getByText("+9", { exact: true })).toBeVisible();
  await expect(page.getByText("1 of 2 lines decided.", { exact: false })).toBeVisible();
  await expect(submit).toBeDisabled();
  await page.getByRole("button", { name: "Differences only", exact: true }).click();
  await expect(maize).toHaveCount(0);
  await page.getByRole("button", { name: "Differences only", exact: true }).click();
  await expect(maize).toHaveCount(1);
  await fitsViewport(page);

  await wheat.getByRole("button", { name: "19,509 · Terminal One", exact: true }).click();
  await expect(finalWheat).toHaveValue("19509");
  await page.getByLabel("Reason · Wheat · Discharge survey", { exact: true }).fill("Terminal recount confirmed");
  await reviewNote.fill("Joint review of agency evidence");
  await submit.click();
  await expect(page.getByText("Version 1 sent for approval.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Readings report\s*Awaiting approval · v1$/ })).toBeVisible();
  await expect(wheat.getByText("+9 above", { exact: true })).toBeVisible();
  await expect(page.getByText("A second reviewer with approval rights must approve the version you prepared.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve final quantities/ })).toHaveCount(0);

  await api.signInAs(approver);
  const returnButton = page.getByRole("button", { name: "Return with comment", exact: true });
  await expect(returnButton).toBeDisabled();
  await page.getByRole("textbox", { name: "Comment if returning", exact: true }).fill("Attach the terminal recount sheet");
  await returnButton.click();
  await expect(page.getByText("Version 1 returned to Mariam Recorder.", { exact: true })).toBeVisible();

  await api.signInAs(recorder);
  await expect(page.getByRole("status").filter({ hasText: /^Returned by Ada Approver: “Attach the terminal recount sheet”/ })).toBeVisible();
  await expect(finalWheat).toHaveValue("19509");
  await expect(reviewNote).toHaveValue("Joint review of agency evidence");
  await reviewNote.fill("Joint review of agency evidence and the terminal recount sheet");
  await submit.click();
  await expect(page.getByText("Version 2 sent for approval.", { exact: true })).toBeVisible();

  await api.signInAs(approver);
  await page.getByRole("button", { name: /Approve final quantities/ }).click();
  await expect(page.getByText("Version 2 approved. Complete the invoice details to draft the variation invoice.", { exact: true })).toBeVisible();
  await expect(page.getByText("Approved by Ada Approver · version 2 locked", { exact: true })).toBeVisible();
  await expect(page.getByText("Version history (2)", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Open variation invoice", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/measurements\/voyages\/call-1\/variation-invoice$/);
  await expect(stepper(page).locator('[aria-current="step"]')).toContainText("Variation invoice");
  expect(api.requests.submissions).toEqual([]);
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
  await expect(page.getByRole("heading", { name: "Other agencies’ completed readings", exact: true })).toHaveCount(0);
  await expect(page.getByText("Port Terminal", { exact: true })).toHaveCount(0);
  await expect(page.getByText("0 of 1 entered", { exact: true })).toBeVisible();
  // The visible label also carries a hint, so match the field by its label text.
  await page.getByLabel("Source document reference").fill("AGENCY-SOURCE-001");
  await page.getByLabel("Measured quantity · Wheat · import", { exact: true }).fill("0");
  await expect(page.getByText("NIL · counted none", { exact: true })).toBeVisible();
  await expect(page.getByText("1 of 1 entered", { exact: true })).toBeVisible();
  await fitsViewport(page);
  await page.getByRole("button", { name: "Submit reading", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your agency report", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Reading submitted" })).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({ contextId: "context-1", inputFingerprint: "scope-fingerprint", requestId: expect.any(String), representative: "Ada", sourceReference: "AGENCY-SOURCE-001", lines: [{ lineId: "line-1", status: "reported", quantity: "0", note: "" }] });
  expect(submissions[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
  for (const key of ["participantId", "agencyId", "actor", "recordedBy", "token"]) expect(submissions[0]).not.toHaveProperty(key);
  await expect(page.getByRole("region", { name: "Your figures", exact: true })).toContainText("NIL (0)");
  await expect(page.getByRole("heading", { name: "Other agencies’ completed readings", exact: true })).toBeVisible();
  const peers = page.getByRole("table", { name: "Your count compared with other agencies’ completed readings", exact: true });
  await expect(peers.getByRole("columnheader", { name: /^Port Terminal/ })).toBeVisible();
  await expect(peers).toContainText("17.5");
  await expect(peers).toContainText("(differs from yours)");
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

test("the retained server workspace keeps agency drafts isolated and preserves agency readings in NPA review", async ({ page }) => {
  const api = await installMeasurementApi(page);
  await page.goto("/app/measurements/plan-1?workspace=reconciliation");
  await page.getByRole("tab", { name: /Agency readings/ }).click();
  await page.getByRole("button", { name: "Record return", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Reporting agency", exact: true })).toHaveValue("party-2");
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
