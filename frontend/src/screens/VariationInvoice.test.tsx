import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calculateVariation, closeoutStorageKey, voyageInputFingerprint, type CloseoutRecord, type PaidDeclaration, type PreviewInvoice, type PreviewReport } from "../measurements/closeoutPreview";
import { measurementFixture } from "../measurements/fixtures.test-support";
import { tariffStorageKey } from "../measurements/tariffs";
import type { MeasurementPlan } from "../measurements/types";
import type { VesselCall } from "../types";
import { VariationInvoice, VariationInvoices } from "./VariationInvoice";

const reviewer = { id: "reviewer", name: "NPA Reviewer" };
const mocked = vi.hoisted(() => ({ list: vi.fn(), can: vi.fn(), toast: vi.fn(), calls: [] as VesselCall[], search: "" }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ org: { id: "org-1" }, user: { id: "finance", name: "NPA Finance" }, can: mocked.can }) }));
vi.mock("../app/store", () => ({ useStore: () => ({ calls: mocked.calls, toast: mocked.toast }) }));
vi.mock("../lib/navigation", async importOriginal => ({ ...await importOriginal<typeof import("../lib/navigation")>(), useParams: () => ({ callId: "call-1" }), useLocation: () => ({ pathname: "/app/measurements/voyages/call-1/variation-invoice", search: mocked.search, state: null }) }));
vi.mock("../measurements/api", () => ({ measurementApi: { list: mocked.list } }));
const call: VesselCall = { id: "call-1", reference: "CALL-001", vesselName: "MV Atlas", flag: "NG", type: "Bulk", nrt: 12000, eta: "2026-10-01T09:00:00Z", sailingEta: "", berth: "Berth 3", berthDate: null, status: "in-progress", notes: "", version: 1, registered: "2026-09-29" };
const declaration: PaidDeclaration = { payer: "Atlas Owner", agent: "", invoiceReference: "DECL-001", amountPaid: "1000", currency: "USD", paidOn: "", paymentStatus: "paid", updatedAt: "2026-10-01T00:00:00Z", updatedBy: reviewer };

/** Wheat declared at 100 t; NPA's approved final quantity is `final`. */
function fixture(final = "110", status: PreviewReport["status"] = "approved") {
  const plan = measurementFixture();
  plan.lines[0].manifestQuantity = "100";
  plan.submissions[0].lines[0].quantity = final;
  plan.submissions.push({ ...plan.submissions[0], id: "sub-2", participantId: "party-2" });
  const report: PreviewReport = {
    id: "report-1", callId: plan.callId, revision: 1, status, preparedAt: "2026-10-12T08:00:00Z", preparedBy: { id: "ops", name: "NPA Operations" },
    ...(status === "approved" ? { approvedAt: "2026-10-12T09:00:00Z", approvedBy: reviewer } : {}),
    reason: "Joint readings reviewed", sourcePlans: [plan], sourceFingerprint: voyageInputFingerprint([plan]),
    lines: [{ planId: plan.id, lineId: plan.lines[0].id, description: "Wheat", unit: "tonnes", declaredQuantity: "100", quantity: final, reason: "Joint tally confirmed" }],
  };
  return { plan, report };
}
function saveRecord(record: CloseoutRecord) {
  localStorage.setItem(closeoutStorageKey("org-1")!, JSON.stringify({ version: 1, organizationId: "org-1", records: [record] }));
}
function saveTariff(rate = "10") {
  localStorage.setItem(tariffStorageKey("org-1")!, JSON.stringify({ version: 1, organizationId: "org-1", tariff: { currency: "USD", reference: "Tariff 2026", rates: { "bulk:tonnes": rate }, updatedAt: "2026-10-01T00:00:00Z", updatedBy: reviewer } }));
}
const stored = () => JSON.parse(localStorage.getItem(closeoutStorageKey("org-1")!)!).records[0] as CloseoutRecord;
function seedReport(final = "110", extra: Partial<CloseoutRecord> = {}) {
  const { plan, report } = fixture(final);
  saveRecord({ callId: plan.callId, reports: [report], invoices: [], events: [], ...extra });
  mocked.list.mockResolvedValue({ plans: [plan] });
  return { plan, report };
}
function invoiceFixture(report: PreviewReport, id: string, rate = "10"): PreviewInvoice {
  const input = { payer: "Atlas Owner", currency: "USD" as const, tariffReference: "REF", originalInvoiceReference: "DECL", paymentStatus: "paid" as const, originalPaidAmount: "1000", previousVariationReference: "", lines: report.lines.map(line => ({ planId: line.planId, lineId: line.lineId, rate, previousVariationAmount: "0" })) };
  return { ...input, ...calculateVariation(report, input.lines), id, callId: report.callId, number: `PREVIEW-${id}`, reportId: report.id, createdAt: "2026-10-12T10:00:00Z", createdBy: reviewer };
}
function renderPage(component = <VariationInvoice />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{component}</QueryClientProvider>);
  return client;
}
async function fillDeclaration() {
  fireEvent.change(await screen.findByRole("textbox", { name: "Payer" }), { target: { value: "Atlas Owner" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Declaration invoice number" }), { target: { value: "PAID-DECL-001" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Payment" }), { target: { value: "paid" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Tariff reference" }), { target: { value: "RATE-APPROVED-001" } });
}
const summary = () => screen.getByRole("region", { name: "Outcome" });

describe("variation invoice", () => {
  beforeEach(() => {
    localStorage.clear();
    mocked.calls = [call];
    mocked.search = "";
    mocked.toast.mockClear();
    mocked.can.mockReturnValue(true);
    mocked.list.mockResolvedValue({ plans: [fixture().plan] });
  });

  it("waits for approved final quantities before offering invoice entry", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Approve the final quantities first" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open readings report/ })).toHaveAttribute("href", "/app/measurements/voyages/call-1/readings");
    expect(screen.queryByRole("textbox", { name: /Rate for Wheat/ })).not.toBeInTheDocument();
  });

  it("explains that a submitted version is with a second reviewer", async () => {
    const { plan, report } = fixture("110", "submitted");
    saveRecord({ callId: "call-1", reports: [report], invoices: [], events: [] });
    mocked.list.mockResolvedValue({ plans: [plan] });
    renderPage();
    expect(await screen.findByRole("heading", { name: "Waiting for the final quantities to be approved" })).toBeInTheDocument();
    expect(screen.getByText(/Version 1 is with a second reviewer/)).toBeInTheDocument();
  });

  it("prefills the paid declaration and tariff rate, and charges only the additional load", async () => {
    seedReport("110", { declaration });
    saveTariff("10");
    renderPage();
    expect(await screen.findByRole("textbox", { name: "Payer" })).toHaveValue("Atlas Owner");
    expect(screen.getByRole("textbox", { name: "Tariff reference" })).toHaveValue("Tariff 2026");
    expect(screen.getByRole("textbox", { name: /Rate for Wheat/ })).toHaveValue("10");
    expect(screen.getByText("per tonne")).toBeInTheDocument();
    expect(within(summary()).getByText("Draft invoice")).toBeInTheDocument();
    expect(within(summary()).getAllByText("USD 100.00")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Draft variation invoice" }));
    const document = await screen.findByRole("article", { name: "Variation invoice DRAFT-VAR-CALL-1-001" });
    expect(within(document).getByText("+10")).toBeInTheDocument();
    expect(within(document).getByText("DECL-001")).toBeInTheDocument();
    expect(within(document).getByText(/payment confirmed/)).toBeInTheDocument();
    expect(within(document).getByText(/^Approved by NPA Reviewer · /)).toBeInTheDocument();
    expect(stored().invoices[0]).toMatchObject({ total: "100.00", status: "draft", originalPaidAmount: "1000" });
    expect(stored().invoices[0].lines[0]).toMatchObject({ variance: "10", amount: "100.00", rate: "10" });
    expect(mocked.toast).toHaveBeenCalledWith("Variation invoice DRAFT-VAR-CALL-1-001 drafted");
  });

  it("lists what is missing and keeps drafting disabled until the details are complete", async () => {
    seedReport();
    renderPage();
    const missing = await screen.findByText("To draft the invoice automatically, complete:");
    const list = within(missing.closest("[role=status]") as HTMLElement);
    for (const item of ["Payer from the paid declaration", "Declaration invoice number", "Confirmation that the declaration is paid", "Variation tariff", "Rate for Wheat"]) expect(list.getByText(item)).toBeInTheDocument();
    expect(list.getByRole("link", { name: "variation tariff" })).toHaveAttribute("href", "/app/settings/tariffs");
    expect(within(summary()).getByText("Rates needed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record outcome" })).toBeDisabled();
    await fillDeclaration();
    fireEvent.change(screen.getByRole("textbox", { name: /Rate for Wheat/ }), { target: { value: "12.5" } });
    expect(screen.queryByText("To draft the invoice automatically, complete:")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Draft variation invoice" }));
    await screen.findByRole("article", { name: /Variation invoice DRAFT-VAR/ });
    expect(stored().invoices[0]).toMatchObject({ total: "125.00", payer: "Atlas Owner" });
    expect(stored().declaration).toMatchObject({ payer: "Atlas Owner", invoiceReference: "PAID-DECL-001", paymentStatus: "paid" });
  });

  it("refers a lower final quantity for overpayment review without netting or crediting it", async () => {
    seedReport("90", { declaration });
    renderPage();
    expect(await screen.findByText("−10")).toBeInTheDocument();
    expect(screen.getAllByText("Overpayment review").length).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox", { name: /Rate for Wheat/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Tariff reference" }), { target: { value: "Tariff 2026" } });
    expect(within(summary()).getByText("On hold · overpayment review")).toBeInTheDocument();
    expect(within(summary()).getByText(/holds the whole invoice/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Record outcome" }));
    const document = await screen.findByRole("article", { name: /Variation invoice/ });
    expect(within(document).getByText(/On hold until the overpayment review for Wheat is resolved/)).toBeInTheDocument();
    expect(within(document).getByText("not deducted")).toBeInTheDocument();
    expect(stored().invoices[0]).toMatchObject({ total: "0.00", status: "overpayment-review" });
    expect(stored().invoices[0].lines[0].variance).toBe("-10");
  });

  it("records no additional charge when the final quantity matches the paid declaration", async () => {
    seedReport("100", { declaration });
    renderPage();
    expect(await screen.findByText("Not charged")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Tariff reference" }), { target: { value: "Tariff 2026" } });
    expect(within(summary()).getByText("No additional charge")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Record outcome" }));
    await screen.findByRole("article", { name: /Variation invoice/ });
    expect(stored().invoices[0]).toMatchObject({ total: "0.00", status: "no-charge" });
  });

  it("deducts earlier variation charges only with a reference for them", async () => {
    seedReport("110", { declaration });
    saveTariff("10");
    renderPage();
    fireEvent.change(await screen.findByRole("textbox", { name: "Already charged for Wheat (USD)" }), { target: { value: "20" } });
    expect(screen.getByRole("button", { name: "Draft variation invoice" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Earlier invoice reference" }), { target: { value: "VAR-000" } });
    fireEvent.click(screen.getByRole("button", { name: "Draft variation invoice" }));
    await screen.findByRole("article", { name: /Variation invoice/ });
    expect(stored().invoices[0]).toMatchObject({ total: "80.00", previousVariationReference: "VAR-000" });
  });

  it("shows the current draft, prints it and saves edits as a new draft version", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const { report } = seedReport();
    saveRecord({ ...stored(), invoices: [invoiceFixture(report, "first")] });
    renderPage();
    const document = await screen.findByRole("article", { name: "Variation invoice PREVIEW-first" });
    expect(within(document).getAllByText("USD 100.00").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Print \/ save PDF/ }));
    expect(print).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /Edit details/ }));
    fireEvent.change(screen.getByRole("textbox", { name: /Rate for Wheat/ }), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Draft variation invoice" }));
    await waitFor(() => expect(stored().invoices).toHaveLength(2));
    expect(stored().invoices[1].total).toBe("200.00");
    expect(await screen.findByText("Draft history (2)")).toBeInTheDocument();
    print.mockRestore();
  });

  it("keeps entry read-only for a user without billing access", async () => {
    seedReport();
    mocked.can.mockReturnValue(false);
    renderPage();
    expect(await screen.findByRole("textbox", { name: "Payer" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: /Rate for Wheat/ })).toBeDisabled();
    expect(screen.getByText("Read-only. A Finance user completes and drafts the invoice.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Draft variation invoice|Record outcome/ })).not.toBeInTheDocument();
  });

  it("blocks new drafts for a cancelled voyage", async () => {
    seedReport();
    mocked.calls = [{ ...call, status: "cancelled" }];
    renderPage();
    expect(await screen.findByText(/This voyage is cancelled/)).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Payer" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Draft variation invoice|Record outcome/ })).not.toBeInTheDocument();
  });

  it("stops drafting when a reading changes after approval but keeps earlier drafts viewable", async () => {
    const { plan, report } = seedReport();
    saveRecord({ ...stored(), invoices: [invoiceFixture(report, "first")] });
    const client = renderPage();
    await screen.findByRole("article", { name: "Variation invoice PREVIEW-first" });
    const changed: MeasurementPlan = { ...plan, version: plan.version + 1 };
    act(() => client.setQueryData(["measurement-plans", "org-1", "call-1"], { plans: [changed] }));
    expect(await screen.findByRole("heading", { name: "Approve the final quantities first" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View PREVIEW-first" }));
    expect(screen.getByText(/Viewing earlier draft PREVIEW-first/)).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Variation invoice PREVIEW-first" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit details/ })).not.toBeInTheDocument();
  });

  it("opens the exact older draft selected by its link, read-only", async () => {
    const { plan, report } = fixture();
    saveRecord({ callId: plan.callId, reports: [report], invoices: [invoiceFixture(report, "older", "10"), invoiceFixture(report, "newer", "20")], events: [] });
    mocked.list.mockResolvedValue({ plans: [plan] });
    mocked.search = "?previewId=older";
    renderPage();
    const document = await screen.findByRole("article", { name: "Variation invoice PREVIEW-older" });
    expect(screen.queryByRole("article", { name: "Variation invoice PREVIEW-newer" })).not.toBeInTheDocument();
    expect(within(document).getAllByText("USD 100.00").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Edit details/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to the current invoice" }));
    expect(await screen.findByRole("article", { name: "Variation invoice PREVIEW-newer" })).toBeInTheDocument();
  });

  it("does not advertise invoice entry after the readings request fails", async () => {
    seedReport();
    mocked.list.mockRejectedValue(new Error("Readings unavailable"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Readings unavailable");
    expect(screen.queryByRole("textbox", { name: /Rate for Wheat/ })).not.toBeInTheDocument();
  });

  it("lists invoices by outcome with drafted totals and search", async () => {
    const { plan, report } = fixture();
    saveRecord({ callId: plan.callId, reports: [report], invoices: [invoiceFixture(report, "one")], events: [] });
    mocked.list.mockResolvedValue({ plans: [plan] });
    renderPage(<VariationInvoices />);
    expect(screen.getByRole("heading", { name: "Invoices", level: 1 })).toBeInTheDocument();
    expect(await screen.findByText("PREVIEW-one")).toBeInTheDocument();
    expect(screen.getByText("Drafted, not yet issued: USD 100.00")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open invoice for MV Atlas CALL-001" })).toHaveAttribute("href", "/app/measurements/voyages/call-1/variation-invoice");
    fireEvent.click(screen.getByRole("button", { name: /Overpayment review/ }));
    expect(screen.getByRole("heading", { name: "No invoices match" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all outcomes" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search invoices" }), { target: { value: "atlas owner" } });
    expect(screen.getByText("PREVIEW-one")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search invoices" }), { target: { value: "nothing" } });
    expect(screen.queryByText("PREVIEW-one")).not.toBeInTheDocument();
  });
});
