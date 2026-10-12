import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeoutStorageKey } from "../measurements/closeoutPreview";
import { measurementFixture, reconciliationFixture } from "../measurements/fixtures.test-support";
import type { MeasurementPlan } from "../measurements/types";
import { validFinalQuantity, VoyageReconciliation } from "./VoyageReconciliation";

const mocked = vi.hoisted(() => ({ list: vi.fn(), can: vi.fn(), calls: [] as { id: string; status: string }[] }));
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ org: { id: "org-1" }, user: { id: "reviewer-1", name: "NPA Reviewer", role: "Admin" }, can: mocked.can }) }));
vi.mock("../app/store", () => ({ useStore: () => ({ calls: mocked.calls }) }));
vi.mock("../lib/navigation", async importOriginal => ({ ...await importOriginal<typeof import("../lib/navigation")>(), useParams: () => ({ callId: "call-1" }) }));
vi.mock("../measurements/api", () => ({ measurementApi: { list: mocked.list } }));

function completePlan(): MeasurementPlan {
  const plan = measurementFixture();
  plan.submissions.push({ ...plan.submissions[0], id: "terminal-reading", participantId: "party-2", lines: [{ lineId: "line-1", status: "reported", quantity: "19508.000", note: "" }] });
  return plan;
}
function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><VoyageReconciliation /></QueryClientProvider>);
  return client;
}
async function completeReview(quantity = "19508") {
  const input = await screen.findByRole("spinbutton", { name: /NPA final quantity/ });
  fireEvent.change(input, { target: { value: quantity } });
  fireEvent.change(screen.getByRole("textbox", { name: /Final quantity reason/ }), { target: { value: "Confirmed by joint survey" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Review note" }), { target: { value: "Required agency readings reviewed against the declaration" } });
}

describe("voyage reconciliation report preview", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocked.calls = [];
    mocked.list.mockReset();
    mocked.can.mockReset();
    mocked.can.mockReturnValue(true);
    mocked.list.mockResolvedValue({ plans: [completePlan()] });
  });

  it("keeps a cancelled voyage read-only even if its sheets are still active", async () => {
    mocked.calls = [{ id: "call-1", status: "cancelled" }];
    renderScreen();
    expect(await screen.findByText(/This voyage is cancelled/)).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: /NPA final quantity/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve report preview/ })).not.toBeInTheDocument();
  });

  it("compares owner and agency columns without inventing a final quantity or including cancelled and foreign sheets", async () => {
    const cancelled = completePlan(); cancelled.id = "cancelled"; cancelled.title = "Cancelled cargo"; cancelled.status = "cancelled";
    const foreign = completePlan(); foreign.callId = "call-2"; foreign.id = "foreign"; foreign.lines[0].description = "Other voyage cargo";
    mocked.list.mockResolvedValue({ plans: [completePlan(), cancelled, foreign] });
    renderScreen();
    const table = await screen.findByRole("table");
    expect(mocked.list).toHaveBeenCalledWith("call-1");
    expect(within(table).getByRole("columnheader", { name: "Owner declaration" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: /Harbour Agent/ })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: /Terminal One/ })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /NPA final quantity/ })).toHaveValue(null);
    expect(screen.queryByText("Other voyage cargo")).not.toBeInTheDocument();
    expect(screen.queryByText("Cancelled cargo")).not.toBeInTheDocument();
    expect(screen.getByText("1 cancelled sheet is excluded from this report.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve report preview/ })).toBeDisabled();
  });

  it("can select an independent reading, requires reasons, and saves only a browser-local immutable preview", async () => {
    renderScreen();
    const useReading = await screen.findByRole("button", { name: "Use Harbour Agent reading for Wheat" });
    fireEvent.click(useReading);
    expect(screen.getByRole("spinbutton", { name: /NPA final quantity/ })).toHaveValue(19508);
    expect(screen.getByText("+8")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve report preview/ })).toBeDisabled();
    await completeReview();
    fireEvent.click(screen.getByRole("button", { name: /Approve report preview/ }));
    expect(await screen.findByText("Approved reconciliation report")).toBeInTheDocument();
    expect(screen.getByText("Approved preview · v1")).toBeInTheDocument();
    expect(screen.getByAltText("Nigerian Ports Authority")).toHaveAttribute("src", "/branding/npa-logo.png");
    expect(screen.getByText("UI preview · MV Atlas · CALL-001")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Continue to invoice/ })).toHaveAttribute("href", "/app/measurements/voyages/call-1/variation-invoice");
    const saved = JSON.parse(window.localStorage.getItem(closeoutStorageKey("org-1")!)!);
    expect(saved.records[0].reports[0].lines[0]).toMatchObject({ declaredQuantity: "19500.000", quantity: "19508", reason: "Confirmed by joint survey" });
    expect(saved.records[0].reports[0].sourcePlans[0].submissions[0].lines[0].quantity).toBe("19508.000");
    expect(mocked.list).toHaveBeenCalledTimes(1);
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "Print / save PDF" }));
    expect(print).toHaveBeenCalledOnce();
  });

  it("blocks approval until every required agency reports all quantities or explained N/A", async () => {
    const plan = completePlan();
    plan.submissions[1].lines[0] = { lineId: "line-1", status: "not-applicable", quantity: null, note: "" };
    mocked.list.mockResolvedValue({ plans: [plan] });
    const client = renderScreen();
    await completeReview();
    expect(screen.getByText(/Terminal One: complete Wheat or explain/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve report preview/ })).toBeDisabled();
    const revised = structuredClone(plan);
    revised.submissions[1].lines[0].note = "Terminal did not weigh bulk cargo";
    act(() => client.setQueryData(["measurement-plans", "org-1", "call-1"], { plans: [revised] }));
    fireEvent.click(await screen.findByRole("button", { name: "Refresh report inputs" }));
    await completeReview();
    expect(screen.getByRole("button", { name: /Approve report preview/ })).toBeEnabled();
  });

  it("keeps zero distinct from missing owner declaration and flags a lower final quantity for overpayment review", async () => {
    const plan = completePlan();
    plan.lines[0].manifestQuantity = null;
    mocked.list.mockResolvedValue({ plans: [plan] });
    const client = renderScreen();
    await completeReview("0");
    expect(screen.getByText(/owner declaration is missing or invalid/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve report preview/ })).toBeDisabled();
    const revised = structuredClone(plan);
    revised.lines[0].manifestQuantity = "19500.000";
    act(() => client.setQueryData(["measurement-plans", "org-1", "call-1"], { plans: [revised] }));
    fireEvent.click(await screen.findByRole("button", { name: "Refresh report inputs" }));
    await completeReview("0");
    expect(screen.getByText("NIL (0)")).toBeInTheDocument();
    expect(screen.getByText("Overpayment review")).toBeInTheDocument();
    expect(screen.getByText("-19500")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve report preview/ })).toBeEnabled();
  });

  it("invalidates an approval after inputs change and retains the old report in history", async () => {
    const client = renderScreen();
    await completeReview();
    fireEvent.click(screen.getByRole("button", { name: /Approve report preview/ }));
    await screen.findByText("Approved reconciliation report");
    const revised = completePlan();
    revised.version += 1;
    revised.submissions[0] = { ...revised.submissions[0], id: "revised-reading", revision: 2, lines: [{ lineId: "line-1", status: "reported", quantity: "19509.000", note: "Revised survey" }] };
    act(() => client.setQueryData(["measurement-plans", "org-1", "call-1"], { plans: [revised] }));
    expect(await screen.findByText("Readings have changed since report v1.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve report preview/ })).toBeDisabled();
    expect(screen.getByText("Report history")).toBeInTheDocument();
    expect(screen.getByText("Report v1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh report inputs" }));
    await completeReview("19509");
    fireEvent.click(screen.getByRole("button", { name: /Approve report preview/ }));
    expect(await screen.findByText("Approved preview · v2")).toBeInTheDocument();
    const saved = JSON.parse(window.localStorage.getItem(closeoutStorageKey("org-1")!)!);
    expect(saved.records[0].reports).toHaveLength(2);
    expect(saved.records[0].reports[0].lines[0].quantity).toBe("19508");
    expect(saved.records[0].reports[1].lines[0].quantity).toBe("19509");
  });

  it("offers a read-only view without edit or approval permissions", async () => {
    mocked.can.mockReturnValue(false);
    renderScreen();
    await screen.findByRole("table");
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve report preview/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Use Harbour Agent/ })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Review note" })).toBeDisabled();
  });

  it("loads final source quantities as explicit starting values without treating them as a local preview approval", async () => {
    const plan = completePlan();
    plan.reconciliations = [{ ...reconciliationFixture(), status: "final", finalizedBy: { id: "other-reviewer", name: "Earlier reviewer" }, finalizedAt: "2026-09-29T12:00:00Z" }];
    mocked.list.mockResolvedValue({ plans: [plan] });
    renderScreen();
    expect(await screen.findByRole("spinbutton", { name: /NPA final quantity/ })).toHaveValue(19508);
    expect(screen.queryByText("Approved reconciliation report")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Final quantity reason/ })).toHaveValue("Joint draft survey confirmed");
  });

  it("shows a failure instead of presenting an empty reconciliation", async () => {
    mocked.list.mockRejectedValue(new Error("Readings unavailable"));
    renderScreen();
    expect(await screen.findByText("Readings unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No active cargo readings to reconcile")).not.toBeInTheDocument();
  });

  it.each([
    ["0", "count", true], ["2.000", "count", true], ["2.5", "count", false],
    ["19508.125", "tonnes", true], ["1.0001", "m3", false], ["-1", "tonnes", false],
    ["", "count", false], ["1e6", "tonnes", false], ["1000000000000000", "tonnes", false],
  ] as const)("validates final quantity %s in %s", (value, unit, valid) => {
    expect(validFinalQuantity(value, unit)).toBe(valid);
  });
});
