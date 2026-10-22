import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calculateVariation, closeoutStorageKey, voyageInputFingerprint, type CloseoutRecord, type PreviewInvoice, type PreviewReport } from "../measurements/closeoutPreview";
import { measurementFixture } from "../measurements/fixtures.test-support";
import type { MeasurementPlan } from "../measurements/types";
import { VariationInvoice, VariationInvoices } from "./VariationInvoice";

const mocked = vi.hoisted(() => ({ list: vi.fn(), can: vi.fn(), navigate: vi.fn(), calls: [] as { id: string; status: string }[], search: "" }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ org: { id: "org-1" }, user: { id: "reviewer", name: "NPA Reviewer" }, can: mocked.can }) }));
vi.mock("../app/store", () => ({ useStore: () => ({ calls: mocked.calls }) }));
vi.mock("../lib/navigation", async importOriginal => ({ ...await importOriginal<typeof import("../lib/navigation")>(), useParams: () => ({ callId: "call-1" }), useLocation: () => ({ pathname: "/app/measurements/voyages/call-1/variation-invoice", search: mocked.search, state: null }), useNavigate: () => (to: string) => { mocked.search = to.includes("?") ? `?${to.split("?")[1]}` : ""; mocked.navigate(to); } }));
vi.mock("../measurements/api", () => ({ measurementApi: { list: mocked.list } }));

function fixture(final = "110") {
  const plan = measurementFixture();
  plan.lines[0].manifestQuantity = "100";
  plan.submissions[0].lines[0].quantity = final;
  plan.submissions.push({ ...plan.submissions[0], id: "sub-2", participantId: "party-2" });
  const report: PreviewReport = {
    id: "report-1", callId: plan.callId, revision: 1, approvedAt: "2026-10-12T09:00:00Z", approvedBy: { id: "reviewer", name: "NPA Reviewer" },
    reason: "Joint readings reviewed", sourcePlans: [plan], sourceFingerprint: voyageInputFingerprint([plan]),
    lines: [{ planId: plan.id, lineId: plan.lines[0].id, description: "Wheat", unit: "tonnes", declaredQuantity: "100", quantity: final, reason: "Joint tally confirmed" }],
  };
  return { plan, report };
}

function saveRecord(record: CloseoutRecord) {
  localStorage.setItem(closeoutStorageKey("org-1")!, JSON.stringify({ version: 1, organizationId: "org-1", records: [record] }));
}
function stored() { return JSON.parse(localStorage.getItem(closeoutStorageKey("org-1")!)!).records[0] as CloseoutRecord; }
function seedReport(final = "110") {
  const { plan, report } = fixture(final);
  saveRecord({ callId: plan.callId, reports: [report], invoices: [], events: [] });
  mocked.list.mockResolvedValue({ plans: [plan] });
  return { plan, report };
}
function invoiceFixture(report: PreviewReport, id: string, rate = "10"): PreviewInvoice {
  const input = { payer: "Atlas Owner", currency: "USD" as const, tariffReference: "REF", originalInvoiceReference: "DECL", paymentStatus: "paid" as const, originalPaidAmount: "1000", previousVariationReference: "", lines: report.lines.map(line => ({ planId: line.planId, lineId: line.lineId, rate, previousVariationAmount: "0" })) };
  return { ...input, ...calculateVariation(report, input.lines), id, callId: report.callId, number: `PREVIEW-${id}`, reportId: report.id, createdAt: "2026-10-12T10:00:00Z", createdBy: { id: "reviewer", name: "Reviewer" } };
}
function renderPage(component = <VariationInvoice />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{component}</QueryClientProvider>);
  return client;
}
async function fillInvoice(rate = "10", prior = "0") {
  fireEvent.change(await screen.findByRole("textbox", { name: "Vessel owner / payer" }), { target: { value: "Atlas Owner" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Original invoice reference" }), { target: { value: "PAID-DECL-001" } });
  fireEvent.change(screen.getByRole("combobox", { name: /Declaration payment status/ }), { target: { value: "paid" } });
  fireEvent.change(screen.getByRole("textbox", { name: /Original paid amount \(optional\)/ }), { target: { value: "1000" } });
  fireEvent.change(screen.getByRole("textbox", { name: /Rate \/ tariff reference/ }), { target: { value: "RATE-APPROVED-001" } });
  fireEvent.change(screen.getByRole("textbox", { name: /Rate for Wheat/ }), { target: { value: rate } });
  fireEvent.change(screen.getByRole("textbox", { name: "Previous variation charge for Wheat" }), { target: { value: prior } });
}

describe("voyage invoice UI", () => {
  beforeEach(() => {
    localStorage.clear();
    mocked.calls = [];
    mocked.search = "";
    mocked.navigate.mockClear();
    mocked.can.mockReturnValue(true);
    mocked.list.mockResolvedValue({ plans: [fixture().plan] });
  });

  it("blocks new drafts for a cancelled voyage while preserving its source quantities", async () => {
    seedReport();
    mocked.calls = [{ id: "call-1", status: "cancelled" }];
    renderPage();
    expect(await screen.findByText(/This voyage is cancelled/)).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Vessel owner / payer" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Generate draft preview" })).not.toBeInTheDocument();
  });

  it("requires a current approved reconciliation before exposing invoice entry", async () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Voyage invoice", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/Variation is NPA’s final quantity minus the owner’s paid declaration/)).toBeInTheDocument();
    expect(await screen.findByText("Review NPA’s final quantities first")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open reconciliation report/ })).toHaveAttribute("href", "/app/measurements/voyages/call-1/reconciliation");
    expect(screen.queryByRole("textbox", { name: /Rate for Wheat/ })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Voyage workflow" })).toBeInTheDocument();
  });

  it("charges only the additional quantity and preserves original payment as separate context", async () => {
    seedReport();
    renderPage();
    expect(await screen.findByRole("cell", { name: "+10" })).toBeInTheDocument();
    await fillInvoice();
    fireEvent.click(screen.getByRole("button", { name: "Generate draft preview" }));
    const document = await screen.findByRole("article", { name: "Saved voyage invoice preview" });
    expect(within(document).getByRole("heading", { name: "Additional invoice", level: 2 })).toBeInTheDocument();
    expect(within(document).getByRole("link", { name: "View reconciliation report" })).toHaveAttribute("href", "/app/measurements/voyages/call-1/reconciliation");
    expect(within(document).getByRole("cell", { name: "+10" })).toBeInTheDocument();
    expect(within(document).getByText(/PAID-DECL-001/)).toBeInTheDocument();
    expect(within(document).getByText(/Paid — recorded in this preview/)).toBeInTheDocument();
    expect(within(document).getByText(/UI preview — not an issued invoice/)).toBeInTheDocument();
    expect(stored().invoices[0]).toMatchObject({ total: "100.00", status: "draft", originalPaidAmount: "1000" });
    expect(stored().invoices[0].lines[0]).toMatchObject({ variance: "10", amount: "100.00", previousVariationAmount: "0" });
    expect(screen.queryByRole("textbox", { name: /Rate for Wheat/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit draft details" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft preview" }));
    expect(stored().invoices).toHaveLength(1);
  });

  it("prints the saved snapshot while keeping unsaved rate edits out of the invoice", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    seedReport(); renderPage(); await fillInvoice();
    fireEvent.click(screen.getByRole("button", { name: "Generate draft preview" }));
    const document = await screen.findByRole("article", { name: "Saved voyage invoice preview" });
    fireEvent.click(screen.getByRole("button", { name: "Edit draft details" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Rate for Wheat/ }), { target: { value: "20" } });
    expect(document.querySelector(".variation-document-total strong")).toHaveTextContent("USD 100.00");
    fireEvent.click(within(document).getByRole("button", { name: "Print / save PDF" }));
    expect(print).toHaveBeenCalledOnce();
    expect(stored().invoices).toHaveLength(1);
    print.mockRestore();
  });

  it("requires recorded original payment for a positive charge and a reference for prior variations", async () => {
    seedReport(); renderPage(); await fillInvoice("10", "20");
    expect(screen.getByRole("button", { name: "Generate draft preview" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: /Previous variation reference/ }), { target: { value: "VAR-000" } });
    fireEvent.change(screen.getByRole("combobox", { name: /Declaration payment status/ }), { target: { value: "unconfirmed" } });
    expect(screen.getByRole("button", { name: "Generate draft preview" })).toBeDisabled();
    expect(screen.getByText(/Record the declaration as paid before preparing/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: /Declaration payment status/ }), { target: { value: "paid" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate draft preview" }));
    await screen.findByRole("article", { name: "Saved voyage invoice preview" });
    expect(stored().invoices[0]).toMatchObject({ total: "80.00", previousVariationReference: "VAR-000" });
  });

  it("flags a lower final quantity for review without creating a credit or netting it into an invoice", async () => {
    seedReport("90"); renderPage(); await fillInvoice();
    fireEvent.click(screen.getByRole("button", { name: "Flag overpayment for review" }));
    const document = await screen.findByRole("article", { name: "Saved voyage invoice preview" });
    expect(within(document).getByRole("heading", { name: "Review overpayment", level: 2 })).toBeInTheDocument();
    expect(within(document).getAllByText("Overpayment for review")).toHaveLength(2);
    expect(within(document).getByText(/No payment, credit note or refund has been created/)).toBeInTheDocument();
    expect(stored().invoices[0]).toMatchObject({ total: "0.00", status: "overpayment-review" });
    expect(stored().invoices[0].lines[0].variance).toBe("-10");
    expect(within(document).getByRole("cell", { name: "−10" })).toBeInTheDocument();
  });

  it("records no additional charge and holds excessive previous variation charges", async () => {
    seedReport("100"); renderPage(); await fillInvoice();
    fireEvent.click(screen.getByRole("button", { name: "Save no-charge outcome" }));
    await screen.findByRole("article", { name: "Saved voyage invoice preview" });
    expect(stored().invoices[0]).toMatchObject({ total: "0.00", status: "no-charge" });
    expect(screen.getByRole("heading", { name: "No additional invoice", level: 2 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit draft details" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Previous variation charge for Wheat" }), { target: { value: "20" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Previous variation reference/ }), { target: { value: "VAR-HOLD" } });
    fireEvent.click(screen.getByRole("button", { name: "Save billing hold" }));
    await waitFor(() => expect(stored().invoices).toHaveLength(2));
    expect(stored().invoices[1]).toMatchObject({ total: "0.00", status: "held" });
  });

  it("blocks further drafting when a source reading changes and retains the historical saved document", async () => {
    const { plan } = seedReport(); const client = renderPage(); await fillInvoice();
    fireEvent.click(screen.getByRole("button", { name: "Generate draft preview" }));
    await screen.findByRole("article", { name: "Saved voyage invoice preview" });
    const changed: MeasurementPlan = { ...plan, version: plan.version + 1 };
    act(() => client.setQueryData(["measurement-plans", "org-1", "call-1"], { plans: [changed] }));
    expect(await screen.findByText(/The readings have changed since/)).toBeInTheDocument();
    expect(screen.getByText(/Historical preview only/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save draft preview" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Saved voyage invoice preview" }).querySelector(".variation-document-total strong")).toHaveTextContent("USD 100.00");
  });

  it("keeps entry read-only for a user without billing access", async () => {
    seedReport(); mocked.can.mockReturnValue(false); renderPage();
    expect(await screen.findByRole("textbox", { name: "Vessel owner / payer" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: /Rate for Wheat/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Generate draft preview" })).not.toBeInTheDocument();
  });

  it("does not advertise invoice entry after the readings request fails", async () => {
    seedReport(); mocked.list.mockRejectedValue(new Error("Readings unavailable")); renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Readings unavailable");
    expect(screen.queryByRole("textbox", { name: /Rate for Wheat/ })).not.toBeInTheDocument();
  });

  it("retains all saved invoice versions and marks stale reconciliation in the overview", async () => {
    const { plan, report } = fixture();
    const input = { payer: "Atlas Owner", currency: "USD" as const, tariffReference: "REF", originalInvoiceReference: "DECL", paymentStatus: "paid" as const, originalPaidAmount: "1000", previousVariationReference: "", lines: [{ planId: plan.id, lineId: "line-1", rate: "10", previousVariationAmount: "0" }] };
    const invoice: PreviewInvoice = { ...input, ...calculateVariation(report, input.lines), id: "invoice-1", callId: plan.callId, number: "PREVIEW-VAR-001", reportId: report.id, createdAt: "2026-10-12T10:00:00Z", createdBy: { id: "reviewer", name: "Reviewer" } };
    saveRecord({ callId: plan.callId, reports: [report], invoices: [invoice, { ...invoice, id: "invoice-2", number: "PREVIEW-VAR-002" }], events: [] });
    mocked.list.mockResolvedValue({ plans: [{ ...plan, version: plan.version + 1 }] });
    renderPage(<VariationInvoices />);
    expect(screen.getByRole("heading", { name: "Invoices", level: 1 })).toBeInTheDocument();
    expect(await screen.findByText("PREVIEW-VAR-001")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open invoice preview PREVIEW-VAR-001" })).toHaveAttribute("href", "/app/measurements/voyages/call-1/variation-invoice?previewId=invoice-1");
    expect(screen.getByText("PREVIEW-VAR-002")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText(/Reconciliation needs review/)).toHaveLength(2));
    fireEvent.change(screen.getByRole("searchbox", { name: "Find an invoice" }), { target: { value: "002" } });
    expect(screen.queryByText("PREVIEW-VAR-001")).not.toBeInTheDocument();
  });

  it("opens the exact older invoice selected by its link without substituting the latest draft", async () => {
    const { plan, report } = fixture();
    saveRecord({ callId: plan.callId, reports: [report], invoices: [invoiceFixture(report, "older", "10"), invoiceFixture(report, "newer", "20")], events: [] });
    mocked.list.mockResolvedValue({ plans: [plan] });
    mocked.search = "?previewId=older";
    renderPage();
    const document = await screen.findByRole("article", { name: "Saved voyage invoice preview" });
    expect(within(document).getByText("PREVIEW-older")).toBeInTheDocument();
    expect(within(document).queryByText("PREVIEW-newer")).not.toBeInTheDocument();
    expect(document.querySelector(".variation-document-total strong")).toHaveTextContent("USD 100.00");
    expect(screen.getByText(/a newer draft version exists/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit draft details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /Rate for Wheat/ })).not.toBeInTheDocument();
  });

  it("opens an older invoice with its original reconciliation snapshot when a newer report exists", async () => {
    const old = fixture("110"), current = fixture("120");
    current.report.id = "report-2"; current.report.revision = 2;
    saveRecord({ callId: old.plan.callId, reports: [old.report, current.report], invoices: [invoiceFixture(old.report, "older"), invoiceFixture(current.report, "newer")], events: [] });
    mocked.list.mockResolvedValue({ plans: [current.plan] }); mocked.search = "?previewId=older";
    renderPage();
    const document = await screen.findByRole("article", { name: "Saved voyage invoice preview" });
    expect(within(document).getByRole("cell", { name: "110" })).toBeInTheDocument();
    expect(within(document).queryByRole("cell", { name: "120" })).not.toBeInTheDocument();
    expect(within(document).getByText("Reconciliation revision 1")).toBeInTheDocument();
    expect(screen.getByText(/its reconciliation is no longer current/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit draft details" })).not.toBeInTheDocument();
  });

  it("keeps the targeted current invoice editable", async () => {
    const { plan, report } = fixture();
    saveRecord({ callId: plan.callId, reports: [report], invoices: [invoiceFixture(report, "older"), invoiceFixture(report, "newer", "20")], events: [] });
    mocked.list.mockResolvedValue({ plans: [plan] }); mocked.search = "?previewId=newer";
    renderPage();
    const document = await screen.findByRole("article", { name: "Saved voyage invoice preview" });
    expect(within(document).getByText("PREVIEW-newer")).toBeInTheDocument();
    expect(document.querySelector(".variation-document-total strong")).toHaveTextContent("USD 200.00");
    expect(screen.getByRole("button", { name: "Edit draft details" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit draft details" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Rate for Wheat/ }), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft preview" }));
    await waitFor(() => expect(screen.getByRole("article", { name: "Saved voyage invoice preview" }).querySelector(".variation-document-total strong")).toHaveTextContent("USD 300.00"));
    expect(mocked.navigate).toHaveBeenCalledWith(`/app/measurements/voyages/call-1/variation-invoice?previewId=${stored().invoices.at(-1)!.id}`);
  });

  it.each(["missing", ""])("reports an unknown preview id '%s' instead of opening the latest invoice", async previewId => {
    const { plan, report } = fixture();
    saveRecord({ callId: plan.callId, reports: [report], invoices: [invoiceFixture(report, "newer")], events: [] });
    mocked.list.mockResolvedValue({ plans: [plan] }); mocked.search = `?previewId=${previewId}`;
    renderPage();
    expect(await screen.findByRole("heading", { name: "Saved invoice preview not found" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Saved voyage invoice preview" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to current voyage invoice" })).toHaveAttribute("href", "/app/measurements/voyages/call-1/variation-invoice");
  });
});
