import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { measurementFixture } from "../measurements/fixtures.test-support";
import { voyageInputFingerprint, type CloseoutRecord, type PreviewInvoice, type PreviewReport } from "../measurements/closeoutPreview";
import type { MeasurementPlan } from "../measurements/types";
import { summarizeVoyages } from "../measurements/voyageStatus";
import type { VesselCall } from "../types";
import { ActivityDashboard, myWork, voyageNeed } from "./ActivityDashboard";

const mocked = vi.hoisted(() => ({
  list: vi.fn(), agencyLinks: vi.fn(), users: vi.fn(), permissions: new Set<string>(),
  calls: [] as VesselCall[], records: [] as CloseoutRecord[], previewError: null as string | null,
  agencies: [] as { id: string; active: boolean }[], directoryLoading: false, tariff: null as object | null,
}));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ org: { id: "org-1" }, user: { id: "me", name: "Ada Okafor", role: "Operations" }, can: (permission: string) => mocked.permissions.has(permission) }) }));
vi.mock("../app/store", () => ({ useStore: () => ({ calls: mocked.calls }) }));
vi.mock("../lib/api", async importOriginal => ({ ...await importOriginal<typeof import("../lib/api")>(), api: { users: mocked.users } }));
vi.mock("../measurements/api", () => ({ measurementApi: { list: mocked.list, agencyLinks: mocked.agencyLinks } }));
vi.mock("../measurements/agencyDirectory", () => ({ useAgencyDirectory: () => ({ agencies: mocked.agencies, loading: mocked.directoryLoading }) }));
vi.mock("../measurements/tariffs", () => ({ useVariationTariff: () => ({ tariff: mocked.tariff, error: null, save: vi.fn() }) }));
vi.mock("../measurements/closeoutPreview", async importOriginal => ({
  ...await importOriginal<typeof import("../measurements/closeoutPreview")>(),
  useCloseoutPreviews: () => ({ records: mocked.records, error: mocked.previewError }),
}));

const ALL = ["measurements.view", "measurements.manage", "measurements.approve", "measurements.bill", "users.view", "registerCall"];
const call: VesselCall = { id: "call-1", reference: "VOY-001", vesselName: "MV Atlas", flag: "NG", type: "Bulk", nrt: 12000, eta: "2026-10-01T09:00:00Z", sailingEta: "", berth: "Berth 3", berthDate: null, status: "in-progress", notes: "", version: 1, registered: "2026-09-29" };
function completePlan(callId = "call-1"): MeasurementPlan {
  const plan = measurementFixture();
  Object.assign(plan, { callId, id: `plan-${callId}`, callReference: `REF-${callId}` });
  plan.submissions.push({ ...plan.submissions[0], id: `${callId}-terminal`, participantId: "party-2", recordedBy: null, sourceReference: "TERM-001", recordedAt: "2026-09-30T10:00:00Z" });
  return plan;
}
const actor = { id: "ops", name: "Ops Officer" };
function closeout(plan: MeasurementPlan, report: Partial<PreviewReport>, invoice?: Partial<PreviewInvoice>): CloseoutRecord {
  const saved: PreviewReport = { id: `report-${plan.callId}`, callId: plan.callId, revision: 1, sourceFingerprint: voyageInputFingerprint([plan]), reason: "Joint review", sourcePlans: [plan],
    lines: [{ planId: plan.id, lineId: "line-1", description: "Wheat", unit: "tonnes", declaredQuantity: "19500.000", quantity: "19508.000", reason: "Joint review" }], ...report };
  const invoices: PreviewInvoice[] = invoice ? [{ id: `invoice-${plan.callId}`, callId: plan.callId, number: `DRAFT-VAR-${plan.callId}`, reportId: saved.id, status: "draft", currency: "USD", total: "80.00", payer: "Owner", originalInvoiceReference: "DEC-1", paymentStatus: "paid", originalPaidAmount: "", previousVariationReference: "", tariffReference: "", lines: [], createdAt: "2026-10-02T11:00:00Z", createdBy: { id: "finance", name: "Finance Officer" }, ...invoice }] : [];
  return { callId: plan.callId, reports: [saved], invoices, events: invoice ? [{ id: `event-${plan.callId}`, callId: plan.callId, at: "2026-10-02T11:00:00Z", actor: { id: "finance", name: "Finance Officer" }, action: "invoice-drafted", reference: `DRAFT-VAR-${plan.callId}` }] : [] };
}
const approved = { status: "approved" as const, preparedBy: actor, approvedAt: "2026-10-02T10:00:00Z", approvedBy: { id: "admin", name: "NPA Reviewer" } };
const access = { manage: true, approve: true, bill: true };

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ActivityDashboard /></QueryClientProvider>);
}
const nextCard = () => screen.getByRole("region", { name: /: MV|Nothing needs you|Start with a voyage/ });
const tile = (label: string) => within(screen.getByRole("group", { name: "Voyages at each step" })).getByRole("button", { name: new RegExp(label) });
const queue = () => screen.getByRole("region", { name: /My work|all voyages/ });

describe("action-focused dashboard", () => {
  beforeEach(() => {
    mocked.calls = [call]; mocked.records = []; mocked.previewError = null; mocked.permissions = new Set(ALL);
    mocked.agencies = [{ id: "agency-1", active: true }]; mocked.directoryLoading = false; mocked.tariff = { currency: "USD" };
    mocked.list.mockResolvedValue({ plans: [measurementFixture()] });
    mocked.agencyLinks.mockResolvedValue({ links: [] });
    mocked.users.mockResolvedValue({ count: 4, results: [] });
  });

  it("orders work by urgency and keeps each role to the steps it can act on", () => {
    const review = completePlan("review"), approval = completePlan("approval"), ready = completePlan("ready"), invoice = completePlan("invoice");
    const collecting = { ...measurementFixture(), id: "collecting-plan", callId: "collecting" };
    const voyages = summarizeVoyages([{ ...call, id: "declaration" }], [review, approval, ready, invoice, collecting], [
      closeout(review, approved, { status: "overpayment-review" }), closeout(approval, { status: "submitted", preparedBy: actor }), closeout(invoice, approved),
    ]);
    expect(myWork(voyages, access).map(voyage => voyage.callId)).toEqual(["review", "approval", "ready", "invoice", "collecting", "declaration"]);
    expect(myWork(voyages, { manage: true, approve: false, bill: false }).map(voyage => voyage.stage)).toEqual(["ready", "collecting", "declaration"]);
    expect(myWork(voyages, { manage: false, approve: true, bill: false }).map(voyage => voyage.stage)).toEqual(["approval"]);
    expect(myWork(voyages, { manage: false, approve: false, bill: true }).map(voyage => voyage.stage)).toEqual(["review", "invoice"]);
    expect(myWork(voyages, { manage: false, approve: false, bill: false })).toHaveLength(6);
  });

  it("says what each step needs in one sentence with the action that does it", () => {
    const [collecting] = summarizeVoyages([call], [measurementFixture()], []);
    expect(voyageNeed(collecting)).toEqual({ need: "Waiting for Terminal One · 1 of 2 in", action: "Chase readings" });
    expect(voyageNeed(collecting, "2026-10-05T09:00:00Z").need).toMatch(/· a link expires /);
    const [ready] = summarizeVoyages([call], [completePlan()], []);
    expect(voyageNeed(ready)).toEqual({ need: "All readings in · 1 line differs from the paid declaration", action: "Reconcile" });
    const plan = completePlan();
    const [returned] = summarizeVoyages([call], [plan], [closeout(plan, { status: "returned", preparedBy: actor, returnedBy: { id: "admin", name: "NPA Reviewer" }, returnComment: "Check the terminal figure" })]);
    expect(voyageNeed(returned)).toEqual({ need: "Returned by NPA Reviewer: “Check the terminal figure”", action: "Revise" });
    const [drafted] = summarizeVoyages([call], [plan], [closeout(plan, approved, { total: "1320.00" })]);
    expect(voyageNeed(drafted).action).toBe("Review invoice");
    expect(voyageNeed(drafted).need).toMatch(/^DRAFT-VAR-call-1 drafted · USD 1,320\.00 for additional load$/);
    const missing = measurementFixture(); missing.lines[0].manifestQuantity = null;
    expect(voyageNeed(summarizeVoyages([call], [missing], [])[0])).toEqual({ need: "Declared quantity missing for Wheat", action: "Review declaration" });
    expect(voyageNeed(summarizeVoyages([call], [], [])[0])).toMatchObject({ action: "Record declaration" });
  });

  it("leads with the next action, names the missing agency and links straight to agency collection", async () => {
    renderDashboard();
    expect(await screen.findByRole("heading", { name: "Chase readings: MV Atlas" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/, Ada$/);
    expect(within(nextCard()).getByText("Next action")).toBeInTheDocument();
    expect(within(nextCard()).getByText("VOY-001")).toBeInTheDocument();
    expect(within(nextCard()).getByText("Waiting for Terminal One · 1 of 2 in")).toBeInTheDocument();
    expect(within(nextCard()).getByRole("link", { name: "Chase readings" })).toHaveAttribute("href", "/app/measurements/voyages/call-1/agencies");
    expect(within(queue()).getByRole("link", { name: "Chase readings · MV Atlas VOY-001" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /New voyage/ })).toHaveAttribute("href", "/app/measurements/new");
  });

  it("warns when an outstanding agency link is about to expire", async () => {
    mocked.agencyLinks.mockResolvedValue({ links: [{ id: "link-1", participantId: "party-2", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), revokedAt: null, submittedAt: null }] });
    renderDashboard();
    expect(await within(await screen.findByRole("region", { name: /Chase readings/ })).findByText(/a link expires/)).toBeInTheDocument();
    expect(mocked.agencyLinks).toHaveBeenCalledWith("plan-1");
  });

  it("counts voyages at each step and filters the list from a tile", async () => {
    const ready = completePlan("call-2"); ready.vesselName = "MV Horizon";
    mocked.list.mockResolvedValue({ plans: [measurementFixture(), ready] });
    mocked.permissions = new Set(["measurements.view", "measurements.bill"]);
    renderDashboard();
    await screen.findByRole("group", { name: "Voyages at each step" });
    expect(tile("Agency readings outstanding")).toHaveTextContent(/^1/);
    expect(tile("Ready to reconcile")).toHaveTextContent(/^1/);
    expect(tile("Awaiting approval")).toHaveTextContent(/^0/);
    expect(within(queue()).getByText("Nothing is waiting for you.")).toBeInTheDocument();
    fireEvent.click(tile("Ready to reconcile"));
    expect(tile("Ready to reconcile")).toHaveAttribute("aria-pressed", "true");
    expect(within(queue()).getByRole("heading", { name: /Ready to reconcile · all voyages/ })).toBeInTheDocument();
    expect(within(queue()).getByRole("link", { name: "Reconcile · MV Horizon REF-call-2" })).toHaveAttribute("href", "/app/measurements/voyages/call-2/readings");
    expect(within(queue()).queryByText("MV Atlas")).not.toBeInTheDocument();
    fireEvent.click(tile("Awaiting approval"));
    expect(within(queue()).getByText("No voyages at this step.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show my work" }));
    expect(within(queue()).getByRole("heading", { name: /My work/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /New voyage/ })).not.toBeInTheDocument();
  });

  it("puts a submitted version in front of the approver but not the preparer", async () => {
    const plan = completePlan(); mocked.list.mockResolvedValue({ plans: [plan] });
    mocked.records = [closeout(plan, { status: "submitted", preparedBy: actor, preparedAt: "2026-10-02T09:00:00Z" })];
    mocked.permissions = new Set(["measurements.view", "measurements.approve"]);
    const view = renderDashboard();
    expect(await screen.findByRole("heading", { name: "Review and approve: MV Atlas" })).toBeInTheDocument();
    expect(within(nextCard()).getByText(/^Version 1 prepared by Ops Officer · /)).toBeInTheDocument();
    expect(within(nextCard()).getByRole("link", { name: "Review and approve" })).toHaveAttribute("href", "/app/measurements/voyages/call-1/readings");
    view.unmount();
    mocked.permissions = new Set(["measurements.view", "measurements.manage"]);
    renderDashboard();
    expect(await screen.findByRole("heading", { name: "Nothing needs you right now" })).toBeInTheDocument();
    expect(tile("Awaiting approval")).toHaveTextContent(/^1/);
  });

  it("guides an empty organisation to its first voyage", async () => {
    mocked.calls = []; mocked.list.mockResolvedValue({ plans: [] }); renderDashboard();
    expect(await screen.findByRole("heading", { name: "Start with a voyage’s paid declaration" })).toBeInTheDocument();
    expect(within(nextCard()).getByText("Get started")).toBeInTheDocument();
    expect(within(nextCard()).getByRole("link", { name: "New voyage" })).toHaveAttribute("href", "/app/measurements/new");
  });

  it("shows the setup checklist until every item is done", async () => {
    mocked.agencies = []; mocked.tariff = null;
    const view = renderDashboard();
    const setup = await screen.findByRole("region", { name: "Workspace setup" });
    expect(await within(setup).findByText("3 of 5 done")).toBeInTheDocument();
    expect(within(setup).getByRole("link", { name: "Add the agencies that report readings" })).toHaveAttribute("href", "/app/settings/agencies");
    expect(within(setup).getByRole("link", { name: "Set the variation tariff rates" })).toHaveAttribute("href", "/app/settings/tariffs");
    expect(within(setup).getByText("Invite your team")).not.toHaveAttribute("href");
    expect(within(setup).getByRole("progressbar", { name: "Workspace setup progress" })).toHaveAttribute("aria-valuenow", "3");
    view.unmount();
    mocked.agencies = [{ id: "agency-1", active: true }]; mocked.tariff = { currency: "USD" };
    renderDashboard();
    await screen.findByRole("heading", { name: "Chase readings: MV Atlas" });
    expect(await screen.findByRole("heading", { name: "Recent activity" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Workspace setup" })).not.toBeInTheDocument();
  });

  it("lists recent submissions and closeout events newest first, linked to the right step", async () => {
    const plan = completePlan(); mocked.list.mockResolvedValue({ plans: [plan] });
    mocked.records = [closeout(plan, approved, {})];
    renderDashboard();
    const activity = await screen.findByRole("region", { name: "Recent activity" });
    const entries = within(activity).getAllByRole("listitem");
    expect(entries.map(entry => within(entry).getByRole("link").textContent)).toEqual(["Variation invoice drafted", "Terminal One submitted a reading", "Harbour Agent submitted a reading"]);
    expect(within(entries[0]).getByRole("link")).toHaveAttribute("href", "/app/measurements/voyages/call-1/variation-invoice");
    expect(within(entries[1]).getByRole("link")).toHaveAttribute("href", "/app/measurements/voyages/call-1/readings");
    expect(entries[1]).toHaveTextContent("MV Atlas · VOY-001 · via secure link");
    expect(entries[2]).toHaveTextContent("entered by Ada Operations");
  });

  it("does not claim zero work when the source failed to load", async () => {
    mocked.list.mockRejectedValue(new Error("Voyage activity unavailable")); renderDashboard();
    expect(await screen.findByRole("alert")).toHaveTextContent("Voyage activity unavailable");
    expect(screen.queryByRole("group", { name: "Voyages at each step" })).not.toBeInTheDocument();
    expect(screen.queryByText("You’re up to date")).not.toBeInTheDocument();
  });
});
