import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { VesselCall } from "../types";
import { measurementFixture, reconciliationFixture } from "./fixtures.test-support";
import { VoyageLog } from "./VoyageLog";
import { groupVesselCalls } from "./voyages";

const call: VesselCall = { id: "call-1", vesselName: "MV Atlas", reference: "VOY-001", flag: "NG", type: "Bulk", nrt: 12000, eta: "2026-10-01T09:00:00Z", sailingEta: "", berth: "Berth 3", berthDate: null, status: "completed", notes: "", version: 1, registered: "2026-09-29" };

describe("vessel voyage log", () => {
  it("groups matching vessel details without combining separate voyages or flags", () => {
    const next = { ...call, id: "call-2", reference: "VOY-002", eta: "2026-10-04T09:00:00Z" };
    const otherFlag = { ...call, id: "call-3", flag: "GH" };
    const groups = groupVesselCalls([call, next, otherFlag]);
    expect(groups).toHaveLength(2);
    expect(groups.find(group => group.flag === "NG")?.calls.map(item => item.id)).toEqual(["call-2", "call-1"]);
    expect(call.reference).toBe("VOY-001");
  });

  it("keeps each voyage baseline and final result tied to its call ID", () => {
    const first = measurementFixture();
    first.callId = call.id; first.callReference = call.reference;
    const nextCall = { ...call, id: "call-2", reference: "VOY-002" };
    const second = structuredClone(first);
    second.id = "plan-2"; second.title = "Second voyage declaration";
    second.callId = nextCall.id; second.callReference = nextCall.reference;
    second.lines[0].manifestQuantity = "500";
    const final = reconciliationFixture(); final.status = "final";
    final.lines[0] = { ...final.lines[0], quantity: "505", manifestQuantity: "500", variance: "5" };
    second.reconciliations = [final];
    render(<VoyageLog calls={[call, nextCall]} plans={[first, second]} canManage />);
    expect(screen.getByRole("region", { name: "Voyages for MV Atlas · NG" })).toBeInTheDocument();
    const firstTable = within(screen.getByRole("table", { name: /VOY-001 declaration/ }));
    expect(firstTable.getByText("19,500")).toBeInTheDocument();
    expect(firstTable.queryByText("505")).not.toBeInTheDocument();
    const secondTable = within(screen.getByRole("table", { name: /VOY-002 declaration/ }));
    expect(secondTable.getByText("500")).toBeInTheDocument();
    expect(secondTable.getByText("505")).toBeInTheDocument();
    expect(secondTable.getByText("+5 Tonnes")).toBeInTheDocument();
  });

  it("keeps unmatched voyage records visible rather than attaching them to a same-name vessel", () => {
    const plan = measurementFixture(); plan.callId = "not-loaded"; plan.callReference = "VOY-UNKNOWN";
    render(<VoyageLog calls={[call]} plans={[plan]} canManage />);
    expect(screen.getByRole("heading", { name: "Other recorded voyages" })).toBeInTheDocument();
    expect(screen.getByText("MV Atlas · VOY-UNKNOWN")).toBeInTheDocument();
    const known = within(screen.getByRole("region", { name: "Voyages for MV Atlas · NG" }));
    expect(known.getByText("Owner declaration not started for this voyage.")).toBeInTheDocument();
    expect(known.queryByText("19,500")).not.toBeInTheDocument();
    expect(known.getByRole("link", { name: /Start declaration/ })).toHaveAttribute("href", "/app/measurements/new?callId=call-1");
  });

  it("preserves historical export items and the original unknown baseline of a final snapshot", () => {
    const plan = measurementFixture(); plan.lines[0].direction = "export";
    const final = reconciliationFixture(); final.status = "final";
    final.lines[0].manifestQuantity = null; plan.reconciliations = [final];
    render(<VoyageLog calls={[]} plans={[plan]} canManage={false} />);
    expect(screen.getByText("Historical export · Tonnes")).toBeInTheDocument();
    expect(screen.getByText("Not provided")).toBeInTheDocument();
    expect(screen.getByText("Declaration unknown")).toBeInTheDocument();
    expect(screen.queryByText("19,500")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Start declaration/ })).not.toBeInTheDocument();
  });

  it("waits for an independent reading even when every agency return is optional", () => {
    const plan = measurementFixture(); plan.submissions = [];
    plan.participants = plan.participants.map(party => ({ ...party, requiredSubmission: false }));
    render(<VoyageLog calls={[]} plans={[plan]} canManage />);
    expect(screen.getByText("Awaiting independent readings")).toBeInTheDocument();
    expect(screen.queryByText("Ready for NPA reconciliation")).not.toBeInTheDocument();
  });
});
