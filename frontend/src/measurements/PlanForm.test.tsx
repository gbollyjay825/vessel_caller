import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { VesselCall } from "../types";
import type { PlanInput } from "./types";
import { PlanForm } from "./PlanForm";

const vessel: VesselCall = { id: "call-1", vesselName: "MV Atlas", reference: "CALL-001", type: "Cargo", flag: "NG", nrt: 12345, eta: "2026-10-07T12:00:00Z", sailingEta: "", berth: "Berth 3", berthDate: null, status: "pending", notes: "", version: 1, registered: "2026-10-01" };
function setup(callId = vessel.id) {
  const onSave = vi.fn<(input: PlanInput) => Promise<void>>().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  render(<PlanForm calls={[vessel, { ...vessel, id: "call-2", vesselName: "MV Horizon", reference: "CALL-002", berth: "Berth 8" }, { ...vessel, id: "cancelled", vesselName: "Cancelled vessel", status: "cancelled" }]} callId={callId} onSave={onSave} onCancel={onCancel} />);
  return { onSave, onCancel, user: userEvent.setup() };
}
async function fillPeople(user: ReturnType<typeof userEvent.setup>) {
  for (const [label, value] of [["Lead surveyor", "Grace Surveyor"], ["Party name 1", "Harbour Agency"], ["Representative 1", "Ada Agent"]]) await user.type(screen.getByLabelText(label), value);
}
const includeRow = (number: number) => screen.getByRole("checkbox", { name: new RegExp(`^Include cargo line ${number} ·`) });
const choose = (name: string) => screen.getByRole("radio", { name });

describe("Vessel-first measurement planning", () => {
  it("sets up the owner baseline before agencies and scheduling without collecting agency readings", () => {
    setup();
    expect(screen.getAllByRole("heading", { level: 2 }).map(heading => heading.textContent)).toEqual([
      "Choose the vessel", "Vessel owner's baseline declaration", "Participating agencies", "Arrange independent measurements",
    ]);
    const baseline = within(screen.getByRole("region", { name: "Vessel owner's baseline declaration" }));
    expect(baseline.getByLabelText("Manifest quantity 1")).toBeInTheDocument();
    expect(baseline.getByText(/baseline declaration supplied by the vessel owner/)).toHaveTextContent("Agency readings are entered separately after setup.");
    expect(baseline.getByText("Owner declaration: blank = unknown. 0 = declared NIL.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Participating agencies" })).getByLabelText("Party name 1")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Arrange independent measurements" })).getByLabelText(/Scheduled start/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Reported quantity/)).not.toBeInTheDocument();
    const workflow = within(screen.getByRole("list", { name: "Measurement workflow" }));
    expect(workflow.getAllByRole("listitem").map(item => item.querySelector("strong")?.textContent)).toEqual([
      "Owner's baseline", "Independent agency readings", "NPA reconciliation",
    ]);
  });
  it("shows recorded vessel details and preserves edited schedule values when the vessel or cargo changes", async () => {
    const { user } = setup("");
    expect(screen.getByRole("button", { name: "Create measurement plan" })).toBeDisabled();
    expect(screen.queryByRole("option", { name: /Cancelled vessel/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Vessel call"), vessel.id);
    expect(screen.getByText("12,345")).toBeInTheDocument();
    expect(screen.getByText("NG")).toBeInTheDocument();
    expect(screen.getByLabelText("Terminal / berth")).toHaveValue("Berth 3");
    expect(screen.getByLabelText("Plan title")).toHaveValue("Bulk measurement · MV Atlas");
    const edits = [["Plan title", "Joint arrival survey"], ["Measurement method", "Certified weighbridge"], ["Terminal / berth", "Agreed terminal"], ["Operation stage", "Before discharge"]];
    for (const [label, value] of edits) { await user.clear(screen.getByLabelText(label)); await user.type(screen.getByLabelText(label), value); }
    await user.selectOptions(screen.getByLabelText("Vessel call"), "call-2");
    await user.click(choose("General cargo"));
    for (const [label, value] of edits) expect(screen.getByLabelText(label)).toHaveValue(value);
  });

  it("submits only included 45ft rows with explicit NIL and unknown kept distinct", async () => {
    const { user, onSave } = setup();
    await user.click(choose("Containers"));
    expect(screen.getAllByRole("checkbox", { name: /^Include cargo line/ })).toHaveLength(12);
    expect(screen.queryByLabelText("Manifest quantity 6")).not.toBeInTheDocument();
    for (const number of [1, 6, 12]) await user.click(includeRow(number));
    await user.type(screen.getByLabelText("Manifest quantity 6"), "0");
    expect(screen.getByText("NIL declared")).toBeInTheDocument();
    expect(screen.getByLabelText("Manifest / baseline reference 6")).toBeRequired();
    expect(screen.getByLabelText("Manifest / baseline reference 12")).not.toBeRequired();
    await user.type(screen.getByLabelText("Manifest / baseline reference 6"), "MANIFEST-NIL");
    await fillPeople(user);
    await user.click(screen.getByRole("button", { name: "Create measurement plan" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const common = { description: "45 ft empty containers", category: "Container", containerSize: "45", loadStatus: "empty", unit: "count", basis: "Physical container count" };
    expect(onSave.mock.calls[0][0].lines).toEqual([
      { ...common, direction: "import", manifestQuantity: "0", baselineReference: "MANIFEST-NIL" },
      { ...common, direction: "export", manifestQuantity: null, baselineReference: "" },
    ]);
    expect(onSave.mock.calls[0][0]).not.toHaveProperty("cargoType");
  });

  it("keeps container declaration entry compact and reveals metadata only on request", async () => {
    const { user } = setup();
    await user.click(choose("Containers"));
    expect(screen.getAllByRole("columnheader", { name: "Container size / load status" })).toHaveLength(2);
    expect(screen.getByLabelText("Manifest quantity 1")).toBeVisible();
    expect(screen.getByLabelText("Manifest / baseline reference 1")).toBeVisible();
    expect(screen.getByLabelText("Cargo description 1")).not.toBeVisible();
    expect(screen.queryByLabelText("Cargo description 2")).not.toBeInTheDocument();
    expect(screen.getAllByText("20 ft · Laden")).toHaveLength(2);
    await user.click(screen.getByText("Cargo details", { selector: "summary" }));
    expect(screen.getByLabelText("Cargo description 1")).toBeVisible();
    await user.clear(screen.getByLabelText("Cargo description 1"));
    await user.type(screen.getByLabelText("Cargo description 1"), "Container parcel A");
    await user.click(includeRow(1));
    expect(screen.queryByLabelText("Cargo description 1")).not.toBeInTheDocument();
    expect(screen.getByText("Container parcel A")).toBeInTheDocument();
    await user.click(includeRow(1));
    expect(screen.getByLabelText("Cargo description 1")).toHaveValue("Container parcel A");
  });

  it("records tanker products as Liquid descriptions and keeps mass and volume separate", async () => {
    const { user, onSave } = setup();
    await user.click(choose("Tanker"));
    expect(screen.getByLabelText("Measurement method")).toHaveValue("Product measurement");
    expect(screen.getByRole("option", { name: "Tanker / liquid cargo" })).toHaveValue("Liquid");
    expect(screen.getByPlaceholderText("Product, e.g. petroleum, chemicals or gas")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Cargo description 1"), "Petroleum · Automotive gas oil");
    await user.type(screen.getByLabelText("Manifest quantity 1"), "125.75");
    await user.type(screen.getByLabelText("Manifest / baseline reference 1"), "BOL-MASS");
    await user.click(screen.getByRole("button", { name: "Add import row" }));
    await user.type(screen.getByLabelText("Cargo description 2"), "Chemicals · Methanol");
    await user.selectOptions(screen.getByLabelText("Unit 2"), "m3");
    expect(screen.getByLabelText("Quantity basis 2")).toHaveValue("Volume in cubic metres");
    await user.type(screen.getByLabelText("Manifest quantity 2"), "80.125");
    await user.type(screen.getByLabelText("Manifest / baseline reference 2"), "BOL-VOLUME");
    await fillPeople(user);
    await user.click(screen.getByRole("button", { name: "Create measurement plan" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].lines).toEqual([
      expect.objectContaining({ category: "Liquid", description: "Petroleum · Automotive gas oil", unit: "tonnes", manifestQuantity: "125.75", basis: "Net metric tonnes" }),
      expect.objectContaining({ category: "Liquid", description: "Chemicals · Methanol", unit: "m3", manifestQuantity: "80.125", basis: "Volume in cubic metres" }),
    ]);
    expect(screen.getByText(/Count, tonnes and m³ are never added together/)).toBeInTheDocument();
  });

  it("keeps mixed categories and custom agency roles in the existing payload without a combined total", async () => {
    const { user, onSave } = setup();
    await user.click(choose("Mixed"));
    await user.type(screen.getByLabelText("Cargo description 1"), "Wheat");
    await user.type(screen.getByLabelText("Manifest quantity 1"), "400");
    await user.type(screen.getByLabelText("Manifest / baseline reference 1"), "BOL-WHEAT");
    await user.click(screen.getByRole("button", { name: "Add Vehicle" }));
    await user.type(screen.getByLabelText("Cargo description 2"), "Passenger cars");
    await user.type(screen.getByLabelText("Manifest quantity 2"), "5");
    await user.type(screen.getByLabelText("Manifest / baseline reference 2"), "BOL-CARS");
    await fillPeople(user);
    await user.click(screen.getByRole("button", { name: "Ops / Terminal" }));
    await user.type(screen.getByLabelText("Party name 2"), "Port Terminal");
    await user.type(screen.getByLabelText("Representative 2"), "Terminal Lead");
    await user.click(screen.getByRole("button", { name: "Add stakeholder" }));
    await user.selectOptions(screen.getByLabelText("Role 3"), "custom");
    await user.type(screen.getByLabelText("Custom role 3"), "Independent checker");
    await user.type(screen.getByLabelText("Party name 3"), "Cargo Review Agency");
    await user.type(screen.getByLabelText("Representative 3"), "Sam Reviewer");
    await user.click(screen.getByRole("button", { name: "Create measurement plan" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const plan = onSave.mock.calls[0][0];
    expect(plan.lines.map(line => [line.category, line.unit, line.manifestQuantity])).toEqual([["Bulk", "tonnes", "400"], ["Vehicle", "count", "5"]]);
    expect(plan.participants.map(party => party.role)).toEqual(["Agent", "Terminal operator", "Independent checker"]);
    expect(plan.participants[2]).toEqual({ name: "Cargo Review Agency", representative: "Sam Reviewer", role: "Independent checker", requiredSubmission: true, requiredApproval: true });
    expect(plan).not.toHaveProperty("totalQuantity");
  });

  it("preserves declarations when retaining rows as Mixed and replaces them only after explicit choice", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Cargo description 1"), "Entered wheat parcel");
    await user.type(screen.getByLabelText("Manifest quantity 1"), "0");
    await user.type(screen.getByLabelText("Manifest / baseline reference 1"), "DECLARED-NIL");
    await user.clear(screen.getByLabelText("Parcel / cargo scope"));
    await user.type(screen.getByLabelText("Parcel / cargo scope"), "Keep this scope");
    await user.click(choose("Tanker"));
    expect(within(screen.getByRole("alert")).getByText("Keep the cargo values you entered?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create measurement plan" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Keep current cargo type" }));
    expect(choose("Bulk")).toBeChecked();
    await user.click(choose("Tanker"));
    await user.click(screen.getByRole("button", { name: "Keep rows and use Mixed" }));
    expect(choose("Mixed")).toBeChecked();
    expect(screen.getByLabelText("Manifest quantity 1")).toHaveValue(0);
    expect(screen.getByLabelText("Manifest / baseline reference 1")).toHaveValue("DECLARED-NIL");
    await user.click(choose("Containers"));
    await user.click(screen.getByRole("button", { name: "Replace cargo rows" }));
    expect(screen.getByLabelText("Cargo description 1")).toHaveValue("20 ft laden containers");
    expect(screen.getByLabelText("Manifest quantity 1")).toHaveValue(null);
    expect(screen.getByLabelText("Parcel / cargo scope")).toHaveValue("Keep this scope");
  });

  it("expands the shared declaration reference into rows and preserves per-row overrides, including unknown quantities", async () => {
    const { user, onSave } = setup();
    await user.type(screen.getByLabelText(/Vessel declaration reference/), "MANIFEST-SHARED");
    await user.click(choose("Tanker"));
    await user.click(choose("Bulk"));
    expect(screen.getByLabelText(/Vessel declaration reference/)).toHaveValue("MANIFEST-SHARED");
    for (let number = 1; number <= 3; number += 1) {
      if (number > 1) await user.click(screen.getByRole("button", { name: "Add import row" }));
      await user.type(screen.getByLabelText(`Cargo description ${number}`), `Parcel ${number}`);
    }
    await user.type(screen.getByLabelText("Manifest quantity 1"), "0");
    await user.type(screen.getByLabelText("Manifest quantity 2"), "4");
    await user.type(screen.getByLabelText("Manifest / baseline reference 2"), "ROW-OVERRIDE");
    expect(screen.getByLabelText("Manifest / baseline reference 1")).not.toBeRequired();
    expect(screen.getByLabelText("Manifest / baseline reference 1")).toHaveAttribute("placeholder", "Using MANIFEST-SHARED");
    await fillPeople(user);
    await user.click(screen.getByRole("button", { name: "Create measurement plan" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const plan = onSave.mock.calls[0][0];
    expect(plan.lines.map(line => [line.manifestQuantity, line.baselineReference])).toEqual([
      ["0", "MANIFEST-SHARED"], ["4", "ROW-OVERRIDE"], [null, "MANIFEST-SHARED"],
    ]);
    expect(plan).not.toHaveProperty("declarationReference");
    expect(plan).not.toHaveProperty("sharedReference");
  });

  it("retains excluded row entries and prevents silent reinterpretation of known quantities", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Cargo description 1"), "A parcel");
    await user.type(screen.getByLabelText("Manifest quantity 1"), "7.5");
    expect(screen.getByLabelText("Unit 1")).toBeDisabled();
    expect(screen.getByLabelText("Category 1")).toBeDisabled();
    await user.click(includeRow(1));
    expect(screen.getByRole("button", { name: "Create measurement plan" })).toBeDisabled();
    await user.click(includeRow(1));
    expect(screen.getByLabelText("Manifest quantity 1")).toHaveValue(7.5);
    await user.clear(screen.getByLabelText("Manifest quantity 1"));
    expect(screen.getByLabelText("Unit 1")).toBeEnabled();
    await user.clear(screen.getByLabelText("Quantity basis 1"));
    await user.type(screen.getByLabelText("Quantity basis 1"), "Verified survey basis");
    await user.selectOptions(screen.getByLabelText("Unit 1"), "m3");
    expect(screen.getByLabelText("Quantity basis 1")).toHaveValue("Verified survey basis");
  });

  it("offers vehicle types in each direction and allows custom category rows and removal", async () => {
    const { user, onCancel } = setup();
    await user.click(choose("Vehicles"));
    expect(screen.getAllByRole("checkbox", { name: /^Include cargo line/ })).toHaveLength(12);
    expect(screen.getAllByText("Buses")).toHaveLength(2);
    expect(screen.getAllByText("Mafi Trailer / HDV")).toHaveLength(2);
    expect(screen.getAllByRole("checkbox", { name: /^Include cargo line/ }).slice(0, 4).map(checkbox => checkbox.getAttribute("aria-label"))).toEqual([
      "Include cargo line 1 · Cars · import", "Include cargo line 2 · Buses · import",
      "Include cargo line 3 · Trucks · import", "Include cargo line 4 · Mafi Trailer / HDV · import",
    ]);
    expect(screen.getAllByText("Motorcycles")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Add export row" }));
    expect(screen.getByLabelText("Category 13")).toHaveValue("Vehicle");
    expect(screen.getByLabelText("Unit 13")).toHaveValue("count");
    await user.selectOptions(screen.getByLabelText("Category 13"), "General cargo");
    expect(choose("Mixed")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Remove cargo line 13" }));
    expect(screen.queryByLabelText("Cargo description 13")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
