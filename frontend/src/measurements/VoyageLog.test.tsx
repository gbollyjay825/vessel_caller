import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { VesselCall } from "../types";
import { measurementFixture, reconciliationFixture } from "./fixtures.test-support";
import { VoyageLog } from "./VoyageLog";
import { groupVesselCalls } from "./voyages";

const call: VesselCall = { id: "call-1", vesselName: "MV Atlas", reference: "VOY-001", flag: "NG", type: "Bulk", nrt: 12000, eta: "2026-10-01T09:00:00Z", sailingEta: "", berth: "Berth 3", berthDate: null, status: "completed", notes: "", version: 1, registered: "2026-09-29" };
const row = (name = "MV Atlas · VOY-001") => within(screen.getByRole("row", { name }));

describe("compact voyage log", () => {
  it("keeps the vessel display grouping separate from voyage identity", () => {
    const next = { ...call, id: "call-2", reference: "VOY-002", eta: "2026-10-04T09:00:00Z" };
    const groups = groupVesselCalls([call, next, { ...call, id: "call-3", flag: "GH" }]);
    expect(groups).toHaveLength(2);
    expect(groups.find(group => group.flag === "NG")?.calls.map(item => item.id)).toEqual(["call-2", "call-1"]);
  });

  it("shows one concise row per voyage and keeps detailed quantities in the readings report", () => {
    const first = measurementFixture();
    const next = { ...call, id: "call-2", reference: "VOY-002" };
    render(<VoyageLog calls={[call, next]} plans={[first]} canManage />);
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getAllByRole("columnheader").map(cell => cell.textContent)).toEqual(["Vessel", "Voyage", "Owner declaration", "Agency readings", "Actions"]);
    expect(row().getByText("Recorded", { exact: true })).toBeInTheDocument();
    expect(row().getByText("1 of 2 received")).toBeInTheDocument();
    expect(row().getByRole("link", { name: "Readings" })).toHaveAttribute("href", "/app/measurements/voyages/call-1/readings");
    expect(row().getByRole("link", { name: "Record readings" })).toHaveAttribute("href", "/app/measurements/plan-1");
    const nextRow = row("MV Atlas · VOY-002");
    expect(nextRow.getByText("Not started")).toBeInTheDocument();
    expect(nextRow.getByText("—", { exact: true })).toBeInTheDocument();
    expect(nextRow.getByText("Awaiting declaration")).toBeInTheDocument();
    expect(nextRow.getByRole("link", { name: "Start declaration" })).toHaveAttribute("href", "/app/measurements/new?callId=call-2");
    for (const text of ["19,500", "19,508", first.title, "Final NPA tally", "Difference", "Ready for NPA reconciliation"]) expect(screen.queryByText(text)).not.toBeInTheDocument();
  });

  it("combines multiple sheets only into their voyage's progress and directs users to choose a sheet in Readings", () => {
    const first = measurementFixture();
    const second = { ...structuredClone(first), id: "plan-2", title: "Other cargo sheet" };
    render(<VoyageLog calls={[call]} plans={[first, second]} canManage />);
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(row().getByText("2 of 4 received")).toBeInTheDocument();
    expect(row().getAllByRole("link")).toHaveLength(1);
    expect(row().getByRole("link", { name: "Readings" })).toBeInTheDocument();
    expect(row().queryByRole("link", { name: "Record readings" })).not.toBeInTheDocument();
  });

  it("groups unloaded plans by call ID without attaching them to a same-name loaded vessel", () => {
    const first = { ...measurementFixture(), callId: "missing /1?", callReference: "HIST-001" };
    render(<VoyageLog calls={[call]} plans={[first, { ...first, id: "sheet-2" }]} canManage={false} />);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(row().getByText("Not started")).toBeInTheDocument();
    const historical = row("MV Atlas · HIST-001");
    expect(historical.getByText("2 of 4 received")).toBeInTheDocument();
    expect(historical.getByRole("link", { name: "Readings" })).toHaveAttribute("href", "/app/measurements/voyages/missing%20%2F1%3F/readings");
    expect(historical.getAllByRole("link")).toHaveLength(1);
  });

  it("counts actual participants once even with revisions or unrelated submissions", () => {
    const plan = measurementFixture();
    plan.submissions.push({ ...plan.submissions[0], id: "revision", revision: 2 }, { ...plan.submissions[0], id: "foreign", participantId: "not-on-this-sheet" });
    render(<VoyageLog calls={[call]} plans={[plan]} canManage />);
    expect(row().getByText("1 of 2 received")).toBeInTheDocument();
  });

  it("marks complete only when every agency has submitted, including optional agencies", () => {
    const plan = measurementFixture();
    plan.participants[1].requiredSubmission = false;
    plan.reconciliations = [{ ...reconciliationFixture(), status: "final" }];
    const { rerender } = render(<VoyageLog calls={[call]} plans={[plan]} canManage status="awaiting" />);
    expect(row().getByText("1 of 2 received")).toBeInTheDocument();
    expect(row().queryByText("Complete", { exact: true })).not.toBeInTheDocument();
    expect(row().queryByRole("link", { name: "Record readings" })).not.toBeInTheDocument();
    plan.submissions.push({ ...plan.submissions[0], id: "terminal-return", participantId: "party-2" });
    rerender(<VoyageLog calls={[call]} plans={[plan]} canManage status="complete" />);
    expect(row().getByText("2 of 2 received")).toBeInTheDocument();
    expect(row().getByText("Complete", { exact: true })).toBeInTheDocument();
  });

  it("does not call an empty participant list complete", () => {
    const plan = measurementFixture(); plan.participants = []; plan.submissions = [];
    render(<VoyageLog calls={[call]} plans={[plan]} canManage />);
    expect(row().getByText("No readings yet")).toBeInTheDocument();
    expect(row().queryByText("0 of 0 received")).not.toBeInTheDocument();
    expect(row().queryByText("Complete", { exact: true })).not.toBeInTheDocument();
  });

  it("retains historical counts for a truly cancelled voyage without mutation actions", () => {
    const plan = measurementFixture(); plan.status = "cancelled";
    render(<VoyageLog calls={[{ ...call, status: "cancelled" }]} plans={[plan]} canManage status="cancelled" />);
    expect(row().getByText("1 of 2 received")).toBeInTheDocument();
    expect(row().getByText("Cancelled", { exact: true })).toBeInTheDocument();
    expect(row().getAllByRole("link")).toHaveLength(1);
    expect(row().getByRole("link", { name: "Readings" })).toBeInTheDocument();
    expect(row().getByText("Recorded", { exact: true })).toBeInTheDocument();
  });

  it("keeps an active voyage pending after its only declaration is cancelled and allows replacement", () => {
    const plan = measurementFixture(); plan.status = "cancelled";
    const activeCall = { ...call, status: "pending" as const };
    const { rerender } = render(<VoyageLog calls={[activeCall]} plans={[plan]} canManage status="awaiting" />);
    expect(row().getByText("Not started")).toBeInTheDocument();
    expect(row().getByText("Awaiting declaration")).toBeInTheDocument();
    expect(row().queryByText("1 of 2 received")).not.toBeInTheDocument();
    expect(row().queryByText("Cancelled", { exact: true })).not.toBeInTheDocument();
    expect(row().getByRole("link", { name: "Readings" })).toHaveAttribute("href", "/app/measurements/voyages/call-1/readings");
    expect(row().getByRole("link", { name: "Start declaration" })).toHaveAttribute("href", "/app/measurements/new?callId=call-1");
    rerender(<VoyageLog calls={[activeCall]} plans={[plan]} canManage status="cancelled" />);
    expect(screen.queryByRole("row", { name: "MV Atlas · VOY-001" })).not.toBeInTheDocument();
    expect(plan.submissions).toHaveLength(1);
  });

  it("does not infer voyage cancellation from unloaded cancelled declarations", () => {
    const plan = measurementFixture(); plan.status = "cancelled";
    render(<VoyageLog calls={[]} plans={[plan]} canManage={false} status="awaiting" />);
    const historical = row("MV Atlas · CALL-001");
    expect(historical.getByText("Not started")).toBeInTheDocument();
    expect(historical.getByText("Awaiting declaration")).toBeInTheDocument();
    expect(historical.queryByText("Cancelled", { exact: true })).not.toBeInTheDocument();
    expect(historical.getByRole("link", { name: "Readings" })).toBeInTheDocument();
  });

  it("ignores voided historical sheets when measuring an active voyage's progress", () => {
    const active = measurementFixture();
    active.submissions.push({ ...active.submissions[0], id: "terminal", participantId: "party-2" });
    const cancelled = { ...structuredClone(active), id: "voided", status: "cancelled" as const, submissions: [] };
    cancelled.lines[0].manifestQuantity = null;
    render(<VoyageLog calls={[call]} plans={[active, cancelled]} canManage status="complete" />);
    expect(row().getByText("2 of 2 received")).toBeInTheDocument();
    expect(row().getByText("Complete", { exact: true })).toBeInTheDocument();
    expect(row().getByText("Recorded", { exact: true })).toBeInTheDocument();
    expect(row().getByRole("link", { name: "Record readings" })).toHaveAttribute("href", "/app/measurements/plan-1");
  });

  it("distinguishes absent, partial and complete owner quantities while treating NIL as recorded", () => {
    const plan = measurementFixture(); plan.lines[0].manifestQuantity = null;
    const { rerender } = render(<VoyageLog calls={[call]} plans={[plan]} canManage />);
    expect(row().getByText("Not provided", { exact: true })).toBeInTheDocument();
    plan.lines.push({ ...plan.lines[0], id: "other", description: "Second parcel", manifestQuantity: "0" });
    rerender(<VoyageLog calls={[call]} plans={[plan]} canManage />);
    expect(row().getByText("Partial", { exact: true })).toBeInTheDocument();
    plan.lines[0].manifestQuantity = "0.000";
    rerender(<VoyageLog calls={[call]} plans={[plan]} canManage />);
    expect(row().getByText("Recorded", { exact: true })).toBeInTheDocument();
  });

  it("keeps readings available for undeclared cancelled voyages and viewers", () => {
    render(<VoyageLog calls={[{ ...call, status: "cancelled" }]} plans={[]} canManage={false} />);
    expect(row().getByText("Not started")).toBeInTheDocument();
    expect(row().getByRole("link", { name: "Readings" })).toBeInTheDocument();
    expect(row().queryByRole("link", { name: "Start declaration" })).not.toBeInTheDocument();
  });

  it("preserves vessel, search and reading-status filters without filtering on NPA results", async () => {
    const plan = measurementFixture();
    const second = { ...call, id: "call-2", vesselName: "MV Horizon", reference: "VOY-002" };
    const { rerender } = render(<VoyageLog calls={[call, second]} plans={[plan]} canManage status="active" />);
    await userEvent.selectOptions(screen.getByLabelText("Filter voyage log by vessel"), JSON.stringify(["mv atlas", "ng"]));
    expect(screen.getByRole("row", { name: "MV Atlas · VOY-001" })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: "MV Horizon · VOY-002" })).not.toBeInTheDocument();
    rerender(<VoyageLog calls={[call, second]} plans={[plan]} canManage search="unmatched-search" />);
    expect(screen.getByRole("heading", { name: "No voyages found" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Filter voyage log by vessel"), "");
    rerender(<VoyageLog calls={[call, second]} plans={[plan]} canManage search="voy-002" />);
    expect(screen.getByRole("row", { name: "MV Horizon · VOY-002" })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: "MV Atlas · VOY-001" })).not.toBeInTheDocument();
  });
});
