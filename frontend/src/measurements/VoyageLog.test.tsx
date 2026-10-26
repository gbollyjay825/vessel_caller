import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { VesselCall } from "../types";
import { voyageInputFingerprint, type CloseoutRecord, type PreviewInvoice, type PreviewReport } from "./closeoutPreview";
import { measurementFixture } from "./fixtures.test-support";
import type { MeasurementPlan } from "./types";
import { VoyageLog } from "./VoyageLog";
import { groupVesselCalls } from "./voyages";

const call: VesselCall = { id: "call-1", vesselName: "MV Atlas", reference: "VOY-001", flag: "NG", type: "Bulk", nrt: 12000, eta: "2026-10-01T09:00:00Z", sailingEta: "", berth: "Berth 3", berthDate: null, status: "completed", notes: "", version: 1, registered: "2026-09-29" };
const row = (name = "MV Atlas · VOY-001") => within(screen.getByRole("row", { name }));
const action = (name: string) => row().getByRole("link", { name: new RegExp(`^${name} · `) });
function allIn(plan = measurementFixture()): MeasurementPlan {
  plan.submissions.push({ ...plan.submissions[0], id: "terminal", participantId: "party-2" });
  return plan;
}
function record(plan: MeasurementPlan, report: Partial<PreviewReport>, invoice?: Partial<PreviewInvoice>): CloseoutRecord {
  const saved: PreviewReport = { id: "report-1", callId: plan.callId, revision: 1, sourceFingerprint: voyageInputFingerprint([plan]), reason: "Joint review", sourcePlans: [plan],
    lines: [{ planId: plan.id, lineId: "line-1", description: "Wheat", unit: "tonnes", declaredQuantity: "19500.000", quantity: "19508.000", reason: "Joint review" }], ...report };
  const invoices: PreviewInvoice[] = invoice ? [{ id: "invoice-1", callId: plan.callId, number: "DRAFT-VAR-1", reportId: saved.id, status: "draft", currency: "USD", total: "80.00", payer: "Owner", originalInvoiceReference: "DEC-1", paymentStatus: "paid", originalPaidAmount: "", previousVariationReference: "", tariffReference: "", lines: [], createdAt: "2026-10-02T11:00:00Z", createdBy: { id: "finance", name: "Finance" }, ...invoice }] : [];
  return { callId: plan.callId, reports: [saved], invoices, events: [] };
}

describe("voyage list", () => {
  it("keeps the vessel display grouping separate from voyage identity", () => {
    const next = { ...call, id: "call-2", reference: "VOY-002", eta: "2026-10-04T09:00:00Z" };
    const groups = groupVesselCalls([call, next, { ...call, id: "call-3", flag: "GH" }]);
    expect(groups).toHaveLength(2);
    expect(groups.find(group => group.flag === "NG")?.calls.map(item => item.id)).toEqual(["call-2", "call-1"]);
  });

  it("shows one row per voyage with its declaration, readings, step and a single next action", () => {
    const next = { ...call, id: "call-2", reference: "VOY-002", eta: "2026-10-04T09:00:00Z" };
    render(<VoyageLog calls={[call, next]} plans={[measurementFixture()]} canManage />);
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(screen.getAllByRole("row").map(item => item.getAttribute("aria-label")).slice(1)).toEqual(["MV Atlas · VOY-002", "MV Atlas · VOY-001"]);
    expect(screen.getAllByRole("columnheader").map(cell => cell.textContent)).toEqual(["Vessel", "Voyage", "Declared", "Agency readings", "Step", "Next action"]);
    expect(screen.getByText("2 voyages")).toBeInTheDocument();
    expect(row().getByRole("link", { name: "MV Atlas" })).toHaveAttribute("href", "/app/vessels/mv-atlas--ng");
    expect(row().getByText("19,500 t")).toBeInTheDocument();
    expect(row().getByText("1 of 2")).toBeInTheDocument();
    expect(row().getByText("Agency readings", { selector: ".stage-chip" })).toBeInTheDocument();
    expect(row().getAllByRole("link")).toHaveLength(2);
    expect(action("Agency readings")).toHaveAttribute("href", "/app/measurements/voyages/call-1/agencies");
    const undeclared = row("MV Atlas · VOY-002");
    expect(undeclared.getByText("Not recorded")).toBeInTheDocument();
    expect(undeclared.getByText("—")).toBeInTheDocument();
    expect(undeclared.getByText("Declaration", { selector: ".stage-chip" })).toBeInTheDocument();
    expect(undeclared.getByRole("link", { name: "Record declaration · MV Atlas VOY-002" })).toHaveAttribute("href", "/app/measurements/new?callId=call-2");
    for (const text of ["19,508", "Difference", "Final NPA tally"]) expect(screen.queryByText(text)).not.toBeInTheDocument();
  });

  it("combines several cargo sheets into one voyage's progress", () => {
    const first = measurementFixture();
    const second = { ...structuredClone(first), id: "plan-2", title: "Other cargo sheet" };
    render(<VoyageLog calls={[call]} plans={[first, second]} canManage />);
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(row().getByText("2 of 4")).toBeInTheDocument();
    expect(row().getByText("39,000 t")).toBeInTheDocument();
  });

  it("groups unloaded plans by call ID without attaching them to a same-name loaded vessel", () => {
    const first = { ...measurementFixture(), callId: "missing /1?", callReference: "HIST-001" };
    render(<VoyageLog calls={[call]} plans={[first, { ...first, id: "sheet-2" }]} canManage={false} />);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(row().getByText("Not recorded")).toBeInTheDocument();
    expect(row().getByRole("link", { name: /^Open · / })).toHaveAttribute("href", "/app/measurements/voyages/call-1/declaration");
    const historical = row("MV Atlas · HIST-001");
    expect(historical.getByText("2 of 4")).toBeInTheDocument();
    expect(historical.getByRole("link", { name: "Agency readings · MV Atlas HIST-001" })).toHaveAttribute("href", "/app/measurements/voyages/missing%20%2F1%3F/agencies");
  });

  it("counts each agency once even with revisions or unrelated submissions", () => {
    const plan = measurementFixture();
    plan.submissions.push({ ...plan.submissions[0], id: "revision", revision: 2 }, { ...plan.submissions[0], id: "foreign", participantId: "not-on-this-sheet" });
    render(<VoyageLog calls={[call]} plans={[plan]} canManage />);
    expect(row().getByText("1 of 2")).toBeInTheDocument();
  });

  it("is ready to reconcile once every required reading is in, even with an optional agency outstanding", () => {
    const plan = measurementFixture();
    plan.participants[1].requiredSubmission = false;
    const { rerender } = render(<VoyageLog calls={[call]} plans={[plan]} canManage />);
    expect(row().getByText("1 of 2")).toBeInTheDocument();
    expect(row().getByText("Ready to reconcile")).toBeInTheDocument();
    expect(action("Reconcile")).toHaveAttribute("href", "/app/measurements/voyages/call-1/readings");
    rerender(<VoyageLog calls={[call]} plans={[allIn()]} canManage />);
    expect(row().getByText("2 of 2")).toBeInTheDocument();
    expect(action("Reconcile")).toBeInTheDocument();
  });

  it("keeps collecting for an incomplete reading and sends a missing quantity back to the declaration", () => {
    const plan = measurementFixture();
    plan.submissions.push({ ...plan.submissions[0], id: "terminal", participantId: "party-2", lines: [] });
    const { rerender } = render(<VoyageLog calls={[call]} plans={[plan]} canManage />);
    expect(row().getByText("2 of 2")).toBeInTheDocument();
    expect(action("Agency readings")).toBeInTheDocument();
    plan.submissions[1].lines = structuredClone(plan.submissions[0].lines);
    plan.lines[0].manifestQuantity = null;
    rerender(<VoyageLog calls={[call]} plans={[plan]} canManage />);
    expect(row().getByText("Quantities missing")).toBeInTheDocument();
    expect(row().getByText("Declaration", { selector: ".stage-chip" })).toBeInTheDocument();
    expect(action("Review declaration")).toHaveAttribute("href", "/app/measurements/voyages/call-1/declaration");
  });

  it("follows the voyage through approval and invoicing, and marks a paid declaration", () => {
    const plan = allIn();
    const submitted = record(plan, { status: "submitted", preparedBy: { id: "ops", name: "Ops" } });
    const { rerender } = render(<VoyageLog calls={[call]} plans={[plan]} canManage closeoutRecords={[submitted]} />);
    expect(row().getByText("Awaiting approval")).toBeInTheDocument();
    expect(action("Review approval")).toHaveAttribute("href", "/app/measurements/voyages/call-1/readings");
    const drafted = record(plan, { status: "approved", approvedAt: "2026-10-02T10:00:00Z", approvedBy: { id: "admin", name: "Admin" } }, {});
    drafted.declaration = { payer: "Owner", agent: "", invoiceReference: "DEC-1", amountPaid: "", currency: "USD", paidOn: "", paymentStatus: "paid", updatedAt: "2026-10-01T10:00:00Z", updatedBy: { id: "admin", name: "Admin" } };
    rerender(<VoyageLog calls={[call]} plans={[plan]} canManage closeoutRecords={[drafted]} />);
    expect(row().getByText("Invoice drafted")).toBeInTheDocument();
    expect(row().getByText("Paid")).toBeInTheDocument();
    expect(action("Invoice")).toHaveAttribute("href", "/app/measurements/voyages/call-1/variation-invoice");
  });

  it("keeps an active voyage at the declaration step after its only sheet is cancelled", () => {
    const plan = measurementFixture(); plan.status = "cancelled";
    const activeCall = { ...call, status: "pending" as const };
    const { rerender } = render(<VoyageLog calls={[activeCall]} plans={[plan]} canManage status="declaration" />);
    expect(row().getByText("Not recorded")).toBeInTheDocument();
    expect(row().getByText("—")).toBeInTheDocument();
    expect(row().queryByText("Cancelled")).not.toBeInTheDocument();
    expect(action("Record declaration")).toHaveAttribute("href", "/app/measurements/new?callId=call-1");
    rerender(<VoyageLog calls={[activeCall]} plans={[plan]} canManage status="cancelled" />);
    expect(screen.queryByRole("row", { name: "MV Atlas · VOY-001" })).not.toBeInTheDocument();
    expect(plan.submissions).toHaveLength(1);
  });

  it("shows a cancelled voyage without a mutating action", () => {
    render(<VoyageLog calls={[{ ...call, status: "cancelled" }]} plans={[measurementFixture()]} canManage status="cancelled" />);
    expect(row().getByText("Cancelled")).toBeInTheDocument();
    expect(row().getByText("1 of 2")).toBeInTheDocument();
    expect(action("Open")).toBeInTheDocument();
  });

  it("filters by step, open voyages, vessel and search across agencies", async () => {
    const ready = allIn({ ...measurementFixture(), id: "plan-2", callId: "call-2" });
    ready.participants[1] = { ...ready.participants[1], name: "Horizon Terminal" };
    const horizon = { ...call, id: "call-2", vesselName: "MV Horizon", flag: "GH", reference: "VOY-002" };
    const closed = { ...call, id: "call-3", reference: "VOY-003", status: "cancelled" as const };
    const view = (status: string, search = "") => <VoyageLog calls={[call, horizon, closed]} plans={[measurementFixture(), ready]} canManage status={status} search={search} />;
    const shown = () => screen.queryAllByRole("row").map(item => item.getAttribute("aria-label")).filter(Boolean).sort();
    const { rerender } = render(view("all"));
    expect(shown()).toEqual(["MV Atlas · VOY-001", "MV Atlas · VOY-003", "MV Horizon · VOY-002"]);
    rerender(view("open"));
    expect(shown()).toEqual(["MV Atlas · VOY-001", "MV Horizon · VOY-002"]);
    rerender(view("collecting"));
    expect(shown()).toEqual(["MV Atlas · VOY-001"]);
    rerender(view("reconcile"));
    expect(shown()).toEqual(["MV Horizon · VOY-002"]);
    rerender(view("cancelled"));
    expect(shown()).toEqual(["MV Atlas · VOY-003"]);
    rerender(view("all", "horizon terminal"));
    expect(shown()).toEqual(["MV Horizon · VOY-002"]);
    rerender(view("all", "unmatched-search"));
    expect(screen.getByRole("heading", { name: "No voyages found" })).toBeInTheDocument();
    rerender(view("all"));
    await userEvent.selectOptions(screen.getByLabelText("Filter voyages by vessel"), "mv-atlas--ng");
    expect(shown()).toEqual(["MV Atlas · VOY-001", "MV Atlas · VOY-003"]);
    expect(screen.getByText("2 voyages")).toBeInTheDocument();
  });
});
