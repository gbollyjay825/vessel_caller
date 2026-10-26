import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeoutStorageKey, useCloseoutPreview, type CloseoutRecord } from "../measurements/closeoutPreview";
import { measurementFixture } from "../measurements/fixtures.test-support";
import { tariffStorageKey } from "../measurements/tariffs";
import type { MeasurementPlan } from "../measurements/types";
import type { VesselCall } from "../types";
import { VoyageReadings } from "./VoyageReadings";

const preparer = { id: "preparer", name: "NPA Preparer" };
const reviewer = { id: "reviewer", name: "NPA Reviewer" };
const mocked = vi.hoisted(() => ({ list: vi.fn(), can: vi.fn(), toast: vi.fn(), calls: [] as VesselCall[], user: { id: "preparer", name: "NPA Preparer" } }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ org: { id: "org-1" }, user: mocked.user, can: mocked.can }) }));
vi.mock("../app/store", () => ({ useStore: () => ({ calls: mocked.calls, toast: mocked.toast }) }));
vi.mock("../lib/navigation", async importOriginal => ({ ...await importOriginal<typeof import("../lib/navigation")>(), useParams: () => ({ callId: "call-1" }) }));
vi.mock("../measurements/api", () => ({ measurementApi: { list: mocked.list, readingsDocumentUrl: (id: string) => `/api/voyages/${id}/readings/document` } }));
const call: VesselCall = { id: "call-1", reference: "VOY-001", vesselName: "MV Atlas", flag: "NG", type: "Bulk", nrt: 12000, eta: "2026-10-01T09:00:00Z", sailingEta: "", berth: "Berth 3", berthDate: null, status: "in-progress", notes: "", version: 1, registered: "2026-09-29" };

/** Both agencies in; the agent reads 19,508 t and the terminal 19,507 t against a 19,500 t declaration. */
function readyPlan(terminal = "19507.000"): MeasurementPlan {
  const plan = measurementFixture();
  plan.submissions.push({ ...plan.submissions[0], id: "sub-2", participantId: "party-2", lines: [{ lineId: "line-1", status: "reported", quantity: terminal, note: "" }] });
  return plan;
}
function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><VoyageReadings /></QueryClientProvider>);
  return client;
}
/** A version the preparer already sent for approval. */
function submitAsPreparer(plan: MeasurementPlan) {
  const { result, unmount } = renderHook(() => useCloseoutPreview("org-1", "call-1"));
  act(() => { result.current.submitReport([plan], { reason: "Joint review", lines: [{ planId: "plan-1", lineId: "line-1", quantity: "19508", reason: "Agent survey" }] }, preparer); });
  unmount();
}
const stored = () => JSON.parse(localStorage.getItem(closeoutStorageKey("org-1")!)!).records[0] as CloseoutRecord;

describe("voyage readings report", () => {
  beforeEach(() => {
    localStorage.clear();
    mocked.calls = [call];
    mocked.user = preparer;
    mocked.toast.mockClear();
    mocked.can.mockImplementation((permission: string) => permission !== "measurements.approve");
    mocked.list.mockResolvedValue({ plans: [readyPlan()] });
  });

  it("puts the paid declaration beside every agency for the selected voyage only", async () => {
    const other = readyPlan(); other.id = "other-plan"; other.callId = "call-2"; other.lines[0].description = "Other voyage oil";
    mocked.list.mockResolvedValue({ plans: [readyPlan(), other] });
    renderScreen();
    const table = await screen.findByRole("table");
    expect(mocked.list).toHaveBeenCalledWith("call-1");
    for (const name of [/Paid declaration/, /Harbour Agent/, /Terminal One/, /NPA final agreed/, /vs declaration/]) expect(within(table).getByRole("columnheader", { name })).toBeInTheDocument();
    expect(within(table).getByText("Wheat")).toBeInTheDocument();
    expect(within(table).getByText(", 8 above the declaration")).toBeInTheDocument();
    expect(screen.queryByText("Other voyage oil")).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: /Readings report/ })).getByText("1 line differs")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Readings PDF/ })).toHaveAttribute("href", "/api/voyages/call-1/readings/document");
  });

  it("accepts a line automatically when every agency agrees with the declaration, with no spread", async () => {
    mocked.list.mockResolvedValue({ plans: [(() => { const plan = readyPlan("19500"); plan.submissions[0].lines[0].quantity = "19500"; return plan; })()] });
    renderScreen();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("All agree · accepted")).toBeInTheDocument();
    expect(within(table).getByText("None")).toBeInTheDocument();
    expect(within(table).getByText("Matches")).toBeInTheDocument();
    expect(within(table).queryByText("NIL (0)")).not.toBeInTheDocument();
  });

  it("submits a decided version for a second reviewer and never offers the preparer approval", async () => {
    mocked.can.mockReturnValue(true);
    renderScreen();
    const submit = await screen.findByRole("button", { name: "Submit for approval" });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "19,508 · Harbour Agent" }));
    expect(screen.getByRole("spinbutton", { name: /NPA final quantity · Wheat/ })).toHaveValue(19508);
    expect(screen.getByText("Additional load · tonnes")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /Reason · Wheat/ }), { target: { value: "Agent survey confirmed" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Review note" }), { target: { value: "Joint meeting with the terminal" } });
    fireEvent.click(submit);
    expect(await screen.findByText("Version 1 sent for approval.")).toBeInTheDocument();
    expect(screen.getByText("A second reviewer with approval rights must approve the version you prepared.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve final quantities/ })).not.toBeInTheDocument();
    expect(stored().reports[0]).toMatchObject({ status: "submitted", preparedBy: preparer, lines: [{ quantity: "19508", reason: "Agent survey confirmed", declaredQuantity: "19500.000" }] });
  });

  it("flags a quantity below the declaration for overpayment review", async () => {
    renderScreen();
    fireEvent.change(await screen.findByRole("spinbutton", { name: /NPA final quantity · Wheat/ }), { target: { value: "19490" } });
    expect(screen.getByText("−10 below")).toBeInTheDocument();
    expect(screen.getByText("Overpayment review")).toBeInTheDocument();
  });

  it("lets a second reviewer approve and drafts the invoice when the paid declaration and tariff are complete", async () => {
    const plan = readyPlan();
    submitAsPreparer(plan);
    const record = stored();
    record.declaration = { payer: "Atlas Owner", agent: "", invoiceReference: "DECL-001", amountPaid: "", currency: "USD", paidOn: "", paymentStatus: "paid", updatedAt: "2026-10-12T09:00:00Z", updatedBy: preparer };
    localStorage.setItem(closeoutStorageKey("org-1")!, JSON.stringify({ version: 1, organizationId: "org-1", records: [record] }));
    localStorage.setItem(tariffStorageKey("org-1")!, JSON.stringify({ version: 1, organizationId: "org-1", tariff: { currency: "USD", reference: "Tariff 2026", rates: { "bulk:tonnes": "10" }, updatedAt: "2026-10-01T00:00:00Z", updatedBy: reviewer } }));
    mocked.user = reviewer;
    mocked.can.mockReturnValue(true);
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: /Approve final quantities/ }));
    expect(await screen.findByText("Version 1 approved. Variation invoice DRAFT-VAR-CALL-1-001 has been drafted.")).toBeInTheDocument();
    expect(screen.getByText("Variation invoice DRAFT-VAR-CALL-1-001 drafted")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open variation invoice/ })).toHaveAttribute("href", "/app/measurements/voyages/call-1/variation-invoice");
    expect(stored().invoices[0]).toMatchObject({ status: "draft", total: "80.00", payer: "Atlas Owner" });
  });

  it("approves without an invoice when details are missing, and says what to do next", async () => {
    submitAsPreparer(readyPlan());
    mocked.user = reviewer;
    mocked.can.mockReturnValue(true);
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: /Approve final quantities/ }));
    expect(await screen.findByText("Version 1 approved. Complete the invoice details to draft the variation invoice.")).toBeInTheDocument();
    expect(stored().invoices).toHaveLength(0);
    expect(stored().reports[0]).toMatchObject({ status: "approved", approvedBy: reviewer });
  });

  it("returns a version only with a comment, which the preparer then sees", async () => {
    submitAsPreparer(readyPlan());
    mocked.user = reviewer;
    mocked.can.mockReturnValue(true);
    renderScreen();
    const send = await screen.findByRole("button", { name: "Return with comment" });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Comment if returning" }), { target: { value: "Use the terminal figure" } });
    fireEvent.click(send);
    expect(await screen.findByText("Version 1 returned to NPA Preparer.")).toBeInTheDocument();
    expect(stored().reports[0]).toMatchObject({ status: "returned", returnComment: "Use the terminal figure", returnedBy: reviewer });
    expect(screen.getByText("“Use the terminal figure” Change what is needed and submit again.")).toBeInTheDocument();
  });

  it("waits for missing agency readings before a version can be submitted", async () => {
    mocked.list.mockResolvedValue({ plans: [measurementFixture()] });
    renderScreen();
    expect(await screen.findByText("Before you can submit")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("Awaiting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit for approval" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Go to agency readings" })).toHaveAttribute("href", "/app/measurements/voyages/call-1/agencies");
  });

  it("refreshes the table when a later agency reading arrives", async () => {
    mocked.can.mockReturnValue(false);
    mocked.list.mockResolvedValue({ plans: [measurementFixture()] });
    const client = renderScreen();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Awaiting")).toBeInTheDocument();
    act(() => client.setQueryData(["measurement-plans", "org-1", "call-1"], { plans: [readyPlan()] }));
    expect(await within(table).findByText("19,507")).toBeInTheDocument();
    expect(within(table).queryByText("Awaiting")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for approval" })).not.toBeInTheDocument();
  });

  it("lets a manager record a declaration on an empty voyage and keeps viewers read-only", async () => {
    mocked.list.mockResolvedValue({ plans: [] });
    renderScreen();
    expect(await screen.findByRole("link", { name: "Record declaration" })).toHaveAttribute("href", "/app/measurements/new?callId=call-1");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows an API failure instead of loading forever", async () => {
    mocked.list.mockRejectedValue(new Error("Readings unavailable"));
    renderScreen();
    expect(await screen.findByText("Readings unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
