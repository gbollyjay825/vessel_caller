import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { measurementFixture, reconciliationFixture } from "../measurements/fixtures.test-support";
import type { CloseoutRecord, PreviewInvoice, PreviewReport } from "../measurements/closeoutPreview";
import { voyageInputFingerprint } from "../measurements/closeoutPreview";
import type { MeasurementPlan } from "../measurements/types";
import type { VesselCall } from "../types";
import { ActivityDashboard, activityVoyages, voyageGuidance } from "./ActivityDashboard";

const mocked = vi.hoisted(() => ({ list: vi.fn(), can: vi.fn(), calls: [] as VesselCall[], records: [] as CloseoutRecord[], previewError: null as string | null }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ org: { id: "org-1" }, can: mocked.can }) }));
vi.mock("../app/store", () => ({ useStore: () => ({ calls: mocked.calls }) }));
vi.mock("../measurements/api", () => ({ measurementApi: { list: mocked.list } }));
vi.mock("../measurements/closeoutPreview", async importOriginal => ({
  ...await importOriginal<typeof import("../measurements/closeoutPreview")>(),
  useCloseoutPreviews: () => ({ records: mocked.records, error: mocked.previewError }),
}));

const call: VesselCall = { id: "call-1", reference: "VOY-001", vesselName: "MV Atlas", flag: "NG", type: "Bulk", nrt: 12000, eta: "2026-10-01T09:00:00Z", sailingEta: "", berth: "Berth 3", berthDate: null, status: "in-progress", notes: "", version: 1, registered: "2026-09-29" };
function completePlan(callId = "call-1"): MeasurementPlan {
  const plan = measurementFixture();
  plan.callId = callId;
  plan.id = `plan-${callId}`;
  plan.callReference = `REF-${callId}`;
  plan.submissions.push({ ...plan.submissions[0], id: `${callId}-terminal`, participantId: "party-2", recordedBy: { id: "terminal-user", name: "Terminal Surveyor" }, sourceReference: "TERM-001", lines: [{ lineId: "line-1", status: "reported", quantity: "19508", note: "" }] });
  return plan;
}
function previewRecord(plan: MeasurementPlan, currency: "USD" | "NGN" = "USD", total = "80.00", status: PreviewInvoice["status"] = "draft"): CloseoutRecord {
  const report: PreviewReport = { id: `report-${plan.callId}`, callId: plan.callId, revision: 1,
    sourceFingerprint: voyageInputFingerprint([plan]), approvedAt: "2026-10-02T10:00:00Z", approvedBy: { id: "reviewer", name: "NPA Reviewer" }, reason: "Joint readings verified", sourcePlans: [plan],
    lines: [{ planId: plan.id, lineId: "line-1", description: "Wheat", unit: "tonnes", declaredQuantity: "19500", quantity: "19508", reason: "Joint readings verified" }],
  };
  const invoice: PreviewInvoice = { id: `invoice-${plan.callId}`, callId: plan.callId, number: `PREVIEW-${plan.callId}`, reportId: report.id,
    status, currency, total, payer: "Owner Agent", originalInvoiceReference: "ORIGINAL-PAID", paymentStatus: "paid", originalPaidAmount: "195000.00", previousVariationReference: "", tariffReference: "TARIFF-2026", lines: [],
    createdAt: "2026-10-02T11:00:00Z", createdBy: { id: "finance", name: "Finance Officer" },
  };
  return { callId: plan.callId, reports: [report], invoices: [invoice], events: [{ id: `event-${plan.callId}`, callId: plan.callId, at: invoice.createdAt, actor: invoice.createdBy, action: status === "overpayment-review" ? "overpayment-flagged" : "invoice-drafted", reference: invoice.number }] };
}
function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ActivityDashboard /></QueryClientProvider>);
  return client;
}

function workflowCount(name: string) {
  const step = within(screen.getByRole("list", { name: "Voyages at each step" })).getByRole("listitem", { name });
  return within(step).getByText(/^\d+$/, { selector: "strong" });
}
const hero = () => screen.getByRole("region", { name: /Reconcile the readings|Collect the remaining agency readings|Review the lower final quantity|Resolve the billing hold|Prepare the voyage invoice|Review the owner declaration|Start the owner declaration|Nothing needs attention|Start with the owner|No voyages match/ });
const access = { manage: true, approve: true, bill: true };

describe("guided voyage dashboard", () => {
  beforeEach(() => {
    mocked.calls = [call]; mocked.records = []; mocked.previewError = null;
    mocked.can.mockReturnValue(true); mocked.list.mockResolvedValue({ plans: [measurementFixture()] });
  });

  it("counts latest participant returns once and does not call invalid submitted readings ready", () => {
    const partial = measurementFixture(); partial.submissions.push({ ...partial.submissions[0], id: "new-agent-reading", revision: 2 });
    const cancelled = { ...completePlan(), id: "cancelled-sheet", status: "cancelled" as const };
    const ready = completePlan("call-2");
    const rows = activityVoyages([call], [partial, cancelled, ready], []);
    expect(rows.find(row => row.callId === "call-1")).toMatchObject({ stage: "collecting", expected: 2, received: 1, pendingAgencies: ["Terminal One"] });
    expect(rows.find(row => row.callId === "call-2")).toMatchObject({ stage: "ready", received: 2 });
    ready.submissions[1].lines[0].quantity = "";
    expect(activityVoyages([], [ready], [])[0]).toMatchObject({ stage: "collecting", received: 2, pendingAgencies: ["Terminal One"] });
  });

  it("prioritizes holds, NPA review, invoice preparation, readings and declaration before prepared drafts", () => {
    const review = completePlan("review"), hold = completePlan("hold"), ready = completePlan("ready"), approved = completePlan("approved"), draft = completePlan("draft");
    const collecting = { ...measurementFixture(), id: "collecting-plan", callId: "collecting" };
    const approvedRecord = previewRecord(approved); approvedRecord.invoices = [];
    const rows = activityVoyages([{ ...call, id: "declaration" }], [review, hold, ready, approved, collecting, draft], [previewRecord(review, "USD", "0.00", "overpayment-review"), previewRecord(hold, "USD", "0.00", "held"), approvedRecord, previewRecord(draft)]);
    expect(rows.map(row => row.stage)).toEqual(["review", "held", "ready", "approved", "collecting", "declaration", "draft"]);
    expect(voyageGuidance(rows[0], access)).toMatchObject({ action: "Review overpayment", href: "/app/measurements/voyages/review/variation-invoice" });
    expect(voyageGuidance(rows[3], access).action).toBe("Prepare invoice");
  });

  it("names the missing agency and goes straight to agency input rather than a read-only report", async () => {
    renderDashboard(); await screen.findByRole("heading", { name: "Collect the remaining agency readings" });
    expect(within(hero()).getByText("MV Atlas")).toBeInTheDocument();
    expect(within(hero()).getByText("VOY-001")).toBeInTheDocument();
    expect(within(hero()).getByText("Readings are still needed from Terminal One.")).toBeInTheDocument();
    expect(within(hero()).getByRole("link", { name: "Collect agency readings" })).toHaveAttribute("href", "/app/measurements/plan-1");
    expect(workflowCount("Agency readings")).toHaveTextContent("1");
    expect(screen.getByText("1 of 2 agency readings received")).toBeInTheDocument();
  });

  it("starts the declaration on the existing voyage", async () => {
    mocked.list.mockResolvedValue({ plans: [] }); renderDashboard();
    await screen.findByRole("heading", { name: "Start the owner declaration" });
    expect(within(hero()).getByRole("link", { name: "Start declaration" })).toHaveAttribute("href", "/app/measurements/new?callId=call-1");
    expect(workflowCount("Declaration")).toHaveTextContent("1");
  });

  it("flags a missing owner baseline despite submitted agencies without promising a missing editor", async () => {
    const plan = completePlan(); plan.lines[0].manifestQuantity = null; mocked.list.mockResolvedValue({ plans: [plan] });
    renderDashboard(); await screen.findByRole("heading", { name: "Review the owner declaration" });
    expect(within(hero()).getByText("The owner’s declared quantity is missing or invalid for Wheat.")).toBeInTheDocument();
    expect(within(hero()).getByRole("link", { name: "Review owner declaration" })).toHaveAttribute("href", "/app/measurements/voyages/call-1/readings");
    expect(workflowCount("Declaration")).toHaveTextContent("1");
    expect(workflowCount("NPA review")).toHaveTextContent("0");
  });

  it("takes prepared drafts out of the attention queue and keeps currencies separate", async () => {
    const usd = completePlan(), ngn = completePlan("call-2"); ngn.vesselName = "MV Horizon";
    mocked.list.mockResolvedValue({ plans: [usd, ngn] }); mocked.records = [previewRecord(usd), previewRecord(ngn, "NGN", "12500.00")];
    renderDashboard(); await screen.findByRole("heading", { name: "Nothing needs attention in this view" });
    expect(within(hero()).getByRole("link", { name: "View prepared previews" })).toHaveAttribute("href", "/app/variation-invoices");
    expect(within(screen.getByRole("region", { name: /Voyages needing attention/ })).queryByRole("listitem")).not.toBeInTheDocument();
    const disclosure = screen.getByText("Prepared previews", { selector: "summary > span" }).closest("details")!;
    expect(disclosure).not.toHaveAttribute("open"); fireEvent.click(disclosure.querySelector("summary")!);
    expect(disclosure).toHaveTextContent(/NGN\s*12,500\.00/); expect(disclosure).toHaveTextContent(/USD\s*80\.00/);
    expect(disclosure).not.toHaveTextContent("12,580"); expect(workflowCount("Invoice")).toHaveTextContent("0");
  });

  it("guides NPA review ahead of an already prepared invoice", async () => {
    const prepared = completePlan(), ready = completePlan("call-2"); ready.vesselName = "MV Horizon";
    mocked.list.mockResolvedValue({ plans: [prepared, ready] }); mocked.records = [previewRecord(prepared)];
    renderDashboard(); await screen.findByRole("heading", { name: "Reconcile the readings" });
    expect(within(hero()).getByText("MV Horizon")).toBeInTheDocument();
    expect(within(hero()).getByRole("link", { name: "Reconcile readings" })).toHaveAttribute("href", "/app/measurements/voyages/call-2/reconciliation");
  });

  it("preserves every cent when aggregating invoice previews beyond floating-point precision", async () => {
    const first = completePlan(), second = completePlan("call-2");
    mocked.list.mockResolvedValue({ plans: [first, second] });
    mocked.records = [previewRecord(first, "USD", "12345678901234567890123456789012.34"), previewRecord(second, "USD", "0.07")];
    renderDashboard(); await screen.findByRole("heading", { name: "Nothing needs attention in this view" });
    const disclosure = screen.getByText("Prepared previews", { selector: "summary > span" }).closest("details")!;
    fireEvent.click(disclosure.querySelector("summary")!);
    expect(within(disclosure).getByText(/USD\s*12,345,678,901,234,567,890,123,456,789,012\.41/, { selector: "strong" })).toBeInTheDocument();
  });

  it("excludes stale drafts and guides a fresh reconciliation while retaining dated activity", async () => {
    const original = completePlan(); mocked.records = [previewRecord(original)];
    mocked.list.mockResolvedValue({ plans: [{ ...original, version: original.version + 1 }] });
    renderDashboard(); await screen.findByRole("heading", { name: "Reconcile the readings" });
    expect(workflowCount("NPA review")).toHaveTextContent("1");
    expect(screen.queryByText("Prepared previews", { selector: "summary > span" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Variation invoice drafted" })).toBeInTheDocument();
  });

  it("filters guidance, step counts, work items and history together", async () => {
    const ready = completePlan("call-2"); ready.vesselName = "MV Horizon"; ready.participants[0].name = "Horizon Survey Agency";
    mocked.list.mockResolvedValue({ plans: [measurementFixture(), ready] }); renderDashboard();
    await screen.findByRole("heading", { name: "Reconcile the readings" });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by step" }), { target: { value: "collecting" } });
    expect(workflowCount("Agency readings")).toHaveTextContent("1"); expect(workflowCount("NPA review")).toHaveTextContent("0");
    expect(screen.getByRole("heading", { name: "Collect the remaining agency readings" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Horizon Survey Agency submitted a reading" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search voyages or agencies" }), { target: { value: "No vessel" } });
    expect(screen.getByRole("heading", { name: "No voyages match this view" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("heading", { name: "Reconcile the readings" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search voyages or agencies" }), { target: { value: "Horizon Survey" } });
    expect(screen.getByText("1 voyage")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Horizon Survey Agency submitted a reading" })).toBeInTheDocument();
  });

  it("keeps suggested actions aligned with permissions", async () => {
    mocked.list.mockResolvedValue({ plans: [completePlan()] }); mocked.can.mockReturnValue(false);
    renderDashboard(); await screen.findByRole("heading", { name: "Reconcile the readings" });
    expect(within(hero()).getByRole("link", { name: "View reconciliation" })).toBeInTheDocument();
    expect(within(hero()).getByText("An authorised NPA reviewer will approve the final quantities.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Measure voyage" })).not.toBeInTheDocument();
    const collecting = activityVoyages([call], [measurementFixture()], [])[0];
    expect(voyageGuidance(collecting, { manage: false, approve: false, bill: false })).toMatchObject({ action: "View readings", href: "/app/measurements/voyages/call-1/readings" });
  });

  it("shows three recent actions and makes remaining dated history expandable", async () => {
    const plan = completePlan();
    plan.submissions.push({ ...plan.submissions[0], id: "revision-two", revision: 2, recordedAt: "2026-10-03T10:00:00Z" });
    plan.reconciliations.push({ ...reconciliationFixture(), status: "final", finalizedAt: "2026-09-28T12:00:00Z", finalizedBy: { id: "admin", name: "Recorded Reviewer" }, submissionIds: plan.submissions.map(reading => reading.id) });
    mocked.list.mockResolvedValue({ plans: [plan] }); renderDashboard(); await screen.findByRole("heading", { name: "Reconcile the readings" });
    const activity = screen.getByRole("region", { name: "Recent activity" });
    const more = within(activity).getByText("Show 1 more recorded action").closest("details")!;
    expect(more).not.toHaveAttribute("open");
    expect(within(activity).getByRole("link", { name: "Harbour Agent submitted a reading · revision 2" })).toBeInTheDocument();
    fireEvent.click(more.querySelector("summary")!);
    expect(within(activity).getByRole("link", { name: "Reconciliation finalized · revision 1" })).toBeInTheDocument();
  });

  it("starts cleanly for an empty organisation", async () => {
    mocked.calls = []; mocked.list.mockResolvedValue({ plans: [] }); renderDashboard();
    await screen.findByRole("heading", { name: "Start with the owner’s declaration" });
    expect(within(hero()).getByRole("link", { name: "Measure voyage" })).toHaveAttribute("href", "/app/measurements/new");
  });

  it("does not claim zero work when the source failed to load", async () => {
    mocked.list.mockRejectedValue(new Error("Voyage activity unavailable")); renderDashboard();
    expect(await screen.findByRole("alert")).toHaveTextContent("Voyage activity unavailable");
    expect(screen.queryByRole("list", { name: "Voyages at each step" })).not.toBeInTheDocument();
    expect(screen.queryByText("You’re up to date")).not.toBeInTheDocument();
  });
});
