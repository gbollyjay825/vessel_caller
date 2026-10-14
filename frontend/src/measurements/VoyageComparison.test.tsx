import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComparisonGrid } from "./VoyageComparison";
import { measurementFixture, reconciliationFixture } from "./fixtures.test-support";

describe("voyage reconciliation sheet", () => {
  it("shows each agency separately and leaves reconciliation pending until recorded", () => {
    render(<ComparisonGrid plan={measurementFixture()} />);
    expect(screen.getByRole("columnheader", { name: /Owner declaration.*Owner-provided baseline/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Harbour Agent/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Terminal One/ })).toBeInTheDocument();
    expect(screen.getByText("+8 vs owner declaration")).toBeInTheDocument();
    expect(screen.getByText("Missing")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Awaiting comparison")).toBeInTheDocument();
    expect(screen.getByText("Bulk · Import / discharge")).toBeInTheDocument();
  });

  it("shows signed final difference and tally status per cargo row", () => {
    const plan = measurementFixture();
    const reconciliation = reconciliationFixture();
    reconciliation.status = "final";
    render(<ComparisonGrid plan={plan} reconciliation={reconciliation} />);
    expect(screen.getByRole("columnheader", { name: /Reconciled tally v1/ })).toBeInTheDocument();
    expect(screen.getByText("+8", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Above declaration")).toBeInTheDocument();
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
  });

  it("uses the saved declaration and exact agency revisions for historical sheets", () => {
    const plan = measurementFixture();
    const reconciliation = reconciliationFixture();
    plan.lines[0].manifestQuantity = "20000";
    plan.submissions.push({ ...plan.submissions[0], id: "new-reading", revision: 2, lines: [{ lineId: "line-1", quantity: "20000", status: "reported", note: "" }] });
    render(<ComparisonGrid plan={plan} reconciliation={reconciliation} snapshot />);
    expect(screen.getByText("19,500")).toBeInTheDocument();
    expect(screen.getAllByText("19,508")).toHaveLength(2);
    expect(screen.queryByText("20,000")).not.toBeInTheDocument();
    expect(screen.getByText("+8", { exact: true })).toBeInTheDocument();
  });

  it("does not replace an unknown historical declaration with a newer plan value", () => {
    const reconciliation = reconciliationFixture();
    reconciliation.lines[0].manifestQuantity = null;
    reconciliation.lines[0].variance = null;
    render(<ComparisonGrid plan={measurementFixture()} reconciliation={reconciliation} snapshot />);
    expect(screen.getByText("Not provided")).toBeInTheDocument();
    expect(screen.getByText("Owner declaration not provided")).toBeInTheDocument();
    expect(screen.queryByText("+8", { exact: true })).not.toBeInTheDocument();
  });

  it("keeps mixed cargo and NIL, not applicable and missing readings distinct", () => {
    const plan = measurementFixture();
    const wheat = plan.lines[0];
    plan.lines = [
      { ...wheat, id: "containers-45", description: "Containers", category: "Container", direction: "export", containerSize: "45", loadStatus: "empty", unit: "count", manifestQuantity: "0", basis: "Physical containers" },
      { ...wheat, id: "chemical", description: "Chemicals", category: "Liquid", direction: "import", unit: "m3", manifestQuantity: null, basis: "Cargo volume" },
    ];
    plan.submissions[0].lines = [
      { lineId: "containers-45", status: "reported", quantity: "0", note: "" },
      { lineId: "chemical", status: "not-applicable", quantity: null, note: "Outside agency scope" },
    ];
    render(<ComparisonGrid plan={plan} />);
    expect(screen.getByText("Containers · Export / loading")).toBeInTheDocument();
    expect(screen.getByText("Tanker / liquid cargo · Import / discharge")).toBeInTheDocument();
    expect(screen.getByText("export · 45 ft · empty · count")).toBeInTheDocument();
    expect(screen.getAllByText("NIL (0)")).toHaveLength(2);
    expect(screen.getByText("N/A")).toBeInTheDocument();
    expect(screen.getByText("Outside agency scope")).toBeInTheDocument();
    expect(screen.getAllByText("Missing")).toHaveLength(2);
    expect(within(screen.getByRole("table")).queryByText(/total/i)).not.toBeInTheDocument();
  });
});
