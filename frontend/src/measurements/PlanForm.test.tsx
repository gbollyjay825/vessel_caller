import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { VesselCall } from "../types";
import type { PlanInput } from "./types";
import type { AgencyProfile } from "./agencyDirectory";
import { PlanForm } from "./PlanForm";

const vessel: VesselCall = { id: "call-1", vesselName: "MV Atlas", reference: "CALL-001", type: "Cargo", flag: "NG", nrt: 12345, eta: "2026-10-07T12:00:00Z", sailingEta: "", berth: "Berth 3", berthDate: null, status: "pending", notes: "", version: 1, registered: "2026-10-01" };
const calls: VesselCall[] = [vessel, { ...vessel, id: "call-2", vesselName: " MV ATLAS ", reference: "CALL-002", berth: "Berth 8" }, { ...vessel, id: "call-3", vesselName: "MV Horizon", reference: "CALL-003" }, { ...vessel, id: "cancelled", vesselName: "Cancelled vessel", status: "cancelled" }];
const agency: AgencyProfile = { id: "agency-1", name: "Harbour Agency", role: "Agent", representative: "Ada Agent", active: true };
const catalog: AgencyProfile[] = [agency, { id: "agency-2", name: "Port Terminal", role: "Terminal operator", representative: "Grace Terminal", active: true }, { ...agency, id: "archived", name: "Archived agency", active: false }];
function setup({ callId = vessel.id, agencyCatalog = catalog, canManageAgencies = true }: { callId?: string; agencyCatalog?: AgencyProfile[]; canManageAgencies?: boolean } = {}) {
  const onSave = vi.fn<(input: PlanInput) => Promise<void>>().mockResolvedValue(undefined), onCancel = vi.fn();
  const props = { calls, callId, agencyCatalog, canManageAgencies, onSave, onCancel };
  const view = render(<PlanForm {...props} />);
  return { ...view, props, onSave, onCancel, user: userEvent.setup() };
}
type User = ReturnType<typeof userEvent.setup>;
const next = (user: User) => user.click(screen.getByRole("button", { name: "Continue" }));
const previous = (user: User) => user.click(screen.getByRole("button", { name: "Previous" }));
const includeItem = (number: number) => screen.getByRole("checkbox", { name: new RegExp(`^Include cargo item ${number} ·`) });
const choose = (name: string) => screen.getByRole("radio", { name });
async function finish(user: User) {
  await next(user);
  await user.click(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" }));
  await next(user);
  await user.type(screen.getByLabelText("Lead surveyor"), "Grace Surveyor");
  await user.click(screen.getByRole("button", { name: "Create voyage sheet" }));
}

describe("voyage declaration wizard", () => {
  it("groups reusable vessels but submits a distinct voyage, showing one step at a time", async () => {
    const { user } = setup({ callId: "" });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Vessel & voyage");
    expect(screen.queryByLabelText("Manifest quantity 1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(within(screen.getByRole("combobox", { name: "Vessel" })).getAllByRole("option")).toHaveLength(3);
    expect(screen.queryByRole("option", { name: /Cancelled vessel/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Vessel" }), screen.getByRole("option", { name: "MV Atlas · NG" }));
    expect(screen.getByRole("combobox", { name: "Voyage" })).toHaveValue("");
    expect(screen.getByRole("option", { name: /CALL-002.*Berth 8/ })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Voyage" }), "call-2");
    expect(screen.getByText("12,345")).toBeInTheDocument();
    await next(user);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Owner declaration");
    expect(screen.getByText(/What is arriving on this voyage/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Reported quantity/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Direction/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Export/)).not.toBeInTheDocument();
  });

  it("validates the current step and preserves owner values through Previous without creating agency readings", async () => {
    const { user, onSave } = setup();
    await next(user); await next(user);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Owner declaration");
    await user.type(screen.getByLabelText("Cargo description 1"), "Wheat");
    await user.type(screen.getByLabelText("Manifest quantity 1"), "0");
    await next(user);
    expect(screen.getByLabelText("Manifest / baseline reference 1")).toBeInvalid();
    await user.type(screen.getByLabelText("Vessel declaration reference"), "OWN-001");
    await next(user);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Select agencies");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await previous(user);
    expect(screen.getByLabelText("Manifest quantity 1")).toHaveValue(0);
    expect(screen.getByLabelText("Vessel declaration reference")).toHaveValue("OWN-001");
    await finish(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).toMatchObject({ callId: vessel.id, stage: "Discharge", lines: [{ manifestQuantity: "0", baselineReference: "OWN-001", direction: "import" }] });
    expect(onSave.mock.calls[0][0]).not.toHaveProperty("readings");
  });

  it("offers six container categories and keeps 45ft NIL and unknown distinct", async () => {
    const { user, onSave } = setup();
    await next(user); await user.click(choose("Containers"));
    expect(screen.getAllByRole("checkbox", { name: /^Include cargo item/ })).toHaveLength(6);
    expect(screen.getByLabelText("Manifest quantity 1")).toBeVisible();
    expect(screen.getByLabelText("Cargo description 1")).not.toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Container size / load status" })).toBeInTheDocument();
    for (const item of [1, 5, 6]) await user.click(includeItem(item));
    await user.type(screen.getByLabelText("Manifest quantity 6"), "0");
    await user.type(screen.getByLabelText("Manifest / baseline reference 6"), "MANIFEST-NIL");
    expect(screen.getByLabelText("Manifest / baseline reference 5")).not.toBeRequired();
    await finish(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].lines).toEqual([
      expect.objectContaining({ containerSize: "45", loadStatus: "laden", manifestQuantity: null, baselineReference: "", unit: "count", direction: "import" }),
      expect.objectContaining({ containerSize: "45", loadStatus: "empty", manifestQuantity: "0", baselineReference: "MANIFEST-NIL", unit: "count", direction: "import" }),
    ]);
  });

  it("retains excluded container entries and prevents reinterpreting known quantities", async () => {
    const { user } = setup();
    await next(user); await user.click(choose("Containers"));
    await user.click(screen.getByLabelText("Cargo details for item 1"));
    await user.clear(screen.getByLabelText("Cargo description 1"));
    await user.type(screen.getByLabelText("Cargo description 1"), "Container parcel A");
    await user.type(screen.getByLabelText("Manifest quantity 1"), "7");
    expect(screen.getByLabelText("Category 1")).toBeDisabled();
    expect(screen.getByLabelText("Unit 1")).toBeDisabled();
    await user.click(includeItem(1));
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.queryByLabelText("Manifest quantity 1")).not.toBeInTheDocument();
    await user.click(includeItem(1));
    expect(screen.getByLabelText("Manifest quantity 1")).toHaveValue(7);
    expect(screen.getByLabelText("Cargo description 1")).toHaveValue("Container parcel A");
  });

  it("records tanker products in separate mass and volume items with reference fallback and overrides", async () => {
    const { user, onSave } = setup();
    await next(user); await user.type(screen.getByLabelText("Vessel declaration reference"), "MANIFEST-SHARED");
    await user.click(choose("Tanker"));
    expect(screen.getByRole("option", { name: "Tanker / liquid cargo" })).toHaveValue("Liquid");
    await user.type(screen.getByLabelText("Cargo description 1"), "Petroleum · AGO");
    await user.type(screen.getByLabelText("Manifest quantity 1"), "125.75");
    await user.click(screen.getByRole("button", { name: "Add cargo item" }));
    await user.type(screen.getByLabelText("Cargo description 2"), "Chemicals · Methanol");
    await user.selectOptions(screen.getByLabelText("Unit 2"), "m3");
    await user.type(screen.getByLabelText("Manifest quantity 2"), "80.125");
    await user.type(screen.getByLabelText("Manifest / baseline reference 2"), "BOL-VOLUME");
    await user.click(screen.getByRole("button", { name: "Add cargo item" }));
    await user.type(screen.getByLabelText("Cargo description 3"), "Gas");
    await finish(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const plan = onSave.mock.calls[0][0];
    expect(plan.lines.map(line => [line.category, line.unit, line.manifestQuantity, line.baselineReference])).toEqual([
      ["Liquid", "tonnes", "125.75", "MANIFEST-SHARED"], ["Liquid", "m3", "80.125", "BOL-VOLUME"], ["Liquid", "tonnes", null, "MANIFEST-SHARED"],
    ]);
    expect(plan.method).toBe("Product measurement");
    expect(plan).not.toHaveProperty("totalQuantity");
    expect(plan).not.toHaveProperty("declarationReference");
  });

  it("keeps mixed quantities separate and copies selected agency snapshots with voyage-only representative overrides", async () => {
    const { user, onSave, rerender, props } = setup();
    await next(user); await user.click(choose("Mixed"));
    await user.type(screen.getByLabelText("Cargo description 1"), "Wheat");
    await user.type(screen.getByLabelText("Manifest quantity 1"), "400");
    await user.type(screen.getByLabelText("Vessel declaration reference"), "OWNER-4");
    await user.click(screen.getByRole("button", { name: "Add Vehicle" }));
    await user.type(screen.getByLabelText("Cargo description 2"), "Cars");
    await user.type(screen.getByLabelText("Manifest quantity 2"), "5");
    await next(user);
    expect(screen.queryByRole("checkbox", { name: /Archived agency/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" }));
    await user.clear(screen.getByLabelText("Representative for Harbour Agency"));
    await user.type(screen.getByLabelText("Representative for Harbour Agency"), "Voyage delegate");
    rerender(<PlanForm {...props} agencyCatalog={[{ ...agency, name: "Renamed directory agency", representative: "New directory representative", active: false }, catalog[1]]} />);
    expect(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" })).toBeChecked();
    expect(screen.getByText(/This agency is no longer active/)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select agency Port Terminal" }));
    await next(user); await user.type(screen.getByLabelText("Lead surveyor"), "Grace");
    await user.click(screen.getByRole("button", { name: "Create voyage sheet" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const plan = onSave.mock.calls[0][0];
    expect(plan.lines.map(line => [line.category, line.unit, line.manifestQuantity])).toEqual([["Bulk", "tonnes", "400"], ["Vehicle", "count", "5"]]);
    expect(plan.participants).toEqual([
      { name: "Harbour Agency", role: "Agent", representative: "Voyage delegate", requiredSubmission: true, requiredApproval: true },
      { name: "Port Terminal", role: "Terminal operator", representative: "Grace Terminal", requiredSubmission: true, requiredApproval: true },
    ]);
    expect(agency.representative).toBe("Ada Agent");
  });

  it("requires explicit clearance when changing voyages and retains selected agencies", async () => {
    const { user, onSave } = setup();
    await next(user); await user.type(screen.getByLabelText("Cargo description 1"), "Old voyage wheat");
    await user.type(screen.getByLabelText("Manifest quantity 1"), "19");
    await user.type(screen.getByLabelText("Vessel declaration reference"), "OLD-REF");
    await next(user); await user.click(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" }));
    await next(user);
    await user.clear(screen.getByLabelText(/Scheduled start/));
    await user.type(screen.getByLabelText(/Scheduled start/), "2026-12-10T10:00");
    await user.type(screen.getByLabelText("Lead surveyor"), "Old voyage lead");
    await user.click(screen.getByText("Additional planning details", { selector: "summary" }));
    await user.type(screen.getByLabelText("Scheduled end (optional)"), "2026-12-10T12:00");
    await user.type(screen.getByLabelText("Planning notes (optional)"), "Old voyage notes");
    await previous(user); await previous(user); await previous(user);
    await user.selectOptions(screen.getByLabelText("Voyage"), "call-2");
    expect(screen.getByLabelText("Voyage")).toHaveValue("call-1");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Keep current voyage" }));
    await next(user);
    expect(screen.getByLabelText("Manifest quantity 1")).toHaveValue(19);
    await previous(user); await user.selectOptions(screen.getByLabelText("Voyage"), "call-2");
    await user.click(screen.getByRole("button", { name: "Clear declaration and change voyage" }));
    await next(user);
    expect(screen.getByLabelText("Cargo description 1")).toHaveValue("");
    expect(screen.getByLabelText("Manifest quantity 1")).toHaveValue(null);
    expect(screen.getByLabelText("Vessel declaration reference")).toHaveValue("");
    await user.type(screen.getByLabelText("Cargo description 1"), "New voyage rice");
    await next(user);
    expect(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" })).toBeChecked();
    await next(user);
    expect(screen.getByLabelText("Terminal / berth")).toHaveValue("Berth 8");
    expect(screen.getByLabelText(/Scheduled start/)).not.toHaveValue("2026-12-10T10:00");
    expect(screen.getByLabelText("Scheduled end (optional)")).toHaveValue("");
    expect(screen.getByLabelText("Planning notes (optional)")).toHaveValue("");
    expect(screen.getByLabelText("Lead surveyor")).toHaveValue("");
    await user.type(screen.getByLabelText("Lead surveyor"), "Survey Lead");
    await user.click(screen.getByRole("button", { name: "Create voyage sheet" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).toMatchObject({ callId: "call-2", lines: [{ description: "New voyage rice", manifestQuantity: null, baselineReference: "" }] });
  });

  it("confirms and resets arrangement-only edits before changing an unknown container declaration to another voyage", async () => {
    const { user } = setup();
    await next(user); await user.click(choose("Containers"));
    expect(screen.getByLabelText("Manifest quantity 1")).toHaveValue(null);
    await next(user); await user.click(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" })); await next(user);
    await user.clear(screen.getByLabelText(/Scheduled start/));
    await user.type(screen.getByLabelText(/Scheduled start/), "2026-12-15T09:00");
    await user.type(screen.getByLabelText("Lead surveyor"), "Previous voyage lead");
    await user.clear(screen.getByLabelText("Measurement method"));
    await user.type(screen.getByLabelText("Measurement method"), "Previous voyage method");
    await user.click(screen.getByText("Additional planning details", { selector: "summary" }));
    await user.type(screen.getByLabelText("Scheduled end (optional)"), "2026-12-15T11:00");
    await user.type(screen.getByLabelText("Planning notes (optional)"), "Previous voyage arrangements");
    await previous(user); await previous(user); await previous(user);
    await user.selectOptions(screen.getByLabelText("Voyage"), "call-2");
    expect(screen.getByLabelText("Voyage")).toHaveValue("call-1");
    expect(screen.getByRole("alert")).toHaveTextContent("Measurement arrangements are reset");
    await user.click(screen.getByRole("button", { name: "Keep current voyage" }));
    await next(user); await next(user); await next(user);
    expect(screen.getByLabelText("Lead surveyor")).toHaveValue("Previous voyage lead");
    await previous(user); await previous(user); await previous(user);
    await user.selectOptions(screen.getByLabelText("Voyage"), "call-2");
    await user.click(screen.getByRole("button", { name: "Clear declaration and change voyage" }));
    await next(user); await next(user); await next(user);
    expect(screen.getByLabelText(/Scheduled start/)).not.toHaveValue("2026-12-15T09:00");
    expect(screen.getByLabelText("Scheduled end (optional)")).toHaveValue("");
    expect(screen.getByLabelText("Planning notes (optional)")).toHaveValue("");
    expect(screen.getByLabelText("Lead surveyor")).toHaveValue("");
    expect(screen.getByLabelText("Measurement method")).toHaveValue("Physical container tally");
    expect(screen.getByLabelText("Terminal / berth")).toHaveValue("Berth 8");
    expect(screen.getByLabelText("Plan title")).toHaveValue("Containers discharge tally ·  MV ATLAS  · CALL-002");
  });

  it("protects cargo edits during template changes and preserves the shared reference", async () => {
    const { user } = setup();
    await next(user); await user.type(screen.getByLabelText("Cargo description 1"), "Wheat");
    await user.type(screen.getByLabelText("Vessel declaration reference"), "SHARED");
    await user.click(choose("Tanker"));
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Keep current cargo type" }));
    expect(choose("Bulk")).toBeChecked();
    await user.click(choose("Tanker"));
    await user.click(screen.getByRole("button", { name: "Keep items and use Mixed" }));
    expect(screen.getByLabelText("Cargo description 1")).toHaveValue("Wheat");
    await user.click(choose("Containers"));
    await user.click(screen.getByRole("button", { name: "Replace cargo items" }));
    expect(screen.getByLabelText("Cargo description 1")).toHaveValue("20 ft laden containers");
    expect(screen.getByLabelText("Vessel declaration reference")).toHaveValue("SHARED");
  });

  it("offers the six printed vehicle categories and allows import-only custom items", async () => {
    const { user, onCancel } = setup();
    await next(user); await user.click(choose("Vehicles"));
    expect(screen.getAllByRole("checkbox", { name: /^Include cargo item/ }).map(input => input.getAttribute("aria-label"))).toEqual([
      "Include cargo item 1 · Cars", "Include cargo item 2 · Buses", "Include cargo item 3 · Trucks", "Include cargo item 4 · Mafi Trailer / HDV", "Include cargo item 5 · Motorcycles", "Include cargo item 6 · Other vehicles",
    ]);
    await user.click(screen.getByRole("button", { name: "Add cargo item" }));
    expect(screen.getByLabelText("Category 7")).toHaveValue("Vehicle");
    await user.selectOptions(screen.getByLabelText("Category 7"), "General cargo");
    expect(choose("Mixed")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Remove cargo item 7" }));
    expect(screen.queryByLabelText("Cargo description 7")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows an empty directory prompt and preserves the form while opening agency management", async () => {
    const { user, rerender, props } = setup({ agencyCatalog: [] });
    await next(user); await user.type(screen.getByLabelText("Cargo description 1"), "Wheat"); await next(user);
    expect(screen.getByText("No agencies in the directory yet")).toBeInTheDocument();
    expect(screen.getByText(/Entries are not shared with other browsers or devices/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByRole("link", { name: /Manage agencies/ })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: /Manage agencies/ })).toHaveAttribute("href", "/app/settings/agencies");
    rerender(<PlanForm {...props} canManageAgencies={false} />);
    expect(screen.queryByRole("link", { name: /Manage agencies/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Ask an administrator/)).toHaveTextContent("Agencies saved on another device will not appear here.");
    rerender(<PlanForm {...props} agencyCatalog={catalog} />);
    await user.click(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" }));
    await previous(user);
    expect(screen.getByLabelText("Cargo description 1")).toHaveValue("Wheat");
  });

  it("preserves explicit planning values and exposes save errors without discarding drafts", async () => {
    const { user, onSave } = setup();
    onSave.mockRejectedValueOnce(new Error("The voyage changed; review and try again."));
    await next(user); await user.type(screen.getByLabelText("Cargo description 1"), "Wheat");
    await next(user); await user.click(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" })); await next(user);
    await user.type(screen.getByLabelText("Lead surveyor"), "Lead");
    await user.clear(screen.getByLabelText("Measurement method")); await user.type(screen.getByLabelText("Measurement method"), "Certified weighbridge");
    await user.click(screen.getByText("Additional planning details", { selector: "summary" }));
    await user.clear(screen.getByLabelText("Plan title")); await user.type(screen.getByLabelText("Plan title"), "Agreed voyage survey");
    await user.clear(screen.getByLabelText("Parcel / cargo scope")); await user.type(screen.getByLabelText("Parcel / cargo scope"), "Parcel A");
    await user.type(screen.getByLabelText("Planning notes (optional)"), "Use certified instrument");
    await previous(user); await previous(user); await user.click(choose("Mixed")); await next(user); await next(user);
    expect(screen.getByLabelText("Measurement method")).toHaveValue("Certified weighbridge");
    expect(screen.getByLabelText("Plan title")).toHaveValue("Agreed voyage survey");
    await user.click(screen.getByRole("button", { name: "Create voyage sheet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The voyage changed; review and try again.");
    await user.click(screen.getByRole("button", { name: "Create voyage sheet" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1][0]).toMatchObject({ title: "Agreed voyage survey", method: "Certified weighbridge", scope: "Parcel A", notes: "Use certified instrument" });
  });
});
