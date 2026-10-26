import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { VesselCall } from "../types";
import type { PlanInput } from "./types";
import type { AgencyProfile } from "./agencyDirectory";
import type { PaidDeclarationInput } from "./closeoutPreview";
import { PlanForm } from "./PlanForm";

const vessel: VesselCall = { id: "call-1", vesselName: "MV Atlas", reference: "CALL-001", type: "Container", flag: "NG", nrt: 12345, eta: "2026-10-07T12:00:00Z", sailingEta: "", berth: "Berth 3", berthDate: null, status: "pending", notes: "", version: 1, registered: "2026-10-01" };
const calls: VesselCall[] = [
  vessel,
  { ...vessel, id: "call-2", vesselName: " MV ATLAS ", reference: "CALL-002", berth: "Berth 8" },
  { ...vessel, id: "call-3", vesselName: "MT Horizon", reference: "CALL-003", type: "Tanker" },
  { ...vessel, id: "cancelled", vesselName: "Cancelled vessel", status: "cancelled" },
];
const agency: AgencyProfile = { id: "agency-1", name: "Harbour Agency", role: "Agent", representative: "Ada Agent", active: true };
const catalog: AgencyProfile[] = [agency, { id: "agency-2", name: "Port Terminal", role: "Terminal operator", representative: "Grace Terminal", active: true }, { ...agency, id: "archived", name: "Archived agency", active: false }];

type Props = Partial<Parameters<typeof PlanForm>[0]>;
function setup(overrides: Props = {}) {
  const onSave = vi.fn<(input: PlanInput, paid: PaidDeclarationInput) => Promise<void>>().mockResolvedValue(undefined), onCancel = vi.fn();
  const props = { calls, callId: vessel.id, agencyCatalog: catalog, canManageAgencies: true, onSave, onCancel, ...overrides };
  const view = render(<PlanForm {...props} />);
  return { ...view, props, onSave, onCancel, user: userEvent.setup() };
}
type User = ReturnType<typeof userEvent.setup>;
const heading = () => screen.getByRole("heading", { level: 2 });
const kind = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const toAgencies = (user: User) => user.click(screen.getByRole("button", { name: "Continue to agencies" }));
const create = (user: User) => user.click(screen.getByRole("button", { name: "Create voyage and invite agencies" }));
async function declareContainers(user: User) {
  await user.type(screen.getByLabelText("Manifest / bill of lading reference"), "MAN-1");
  await user.type(screen.getByLabelText("40 ft laden declared"), "12");
}

describe("new voyage form", () => {
  it("picks a vessel and a distinct voyage before the declaration, hiding cancelled calls", async () => {
    const { user } = setup({ callId: undefined });
    expect(heading()).toHaveTextContent("Which voyage is this?");
    expect(within(screen.getByRole("list", { name: "Voyage setup steps" })).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(within(screen.getByRole("combobox", { name: "Vessel" })).getAllByRole("option")).toHaveLength(3);
    expect(screen.queryByRole("option", { name: /Cancelled vessel/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Vessel" }), screen.getByRole("option", { name: "MV Atlas · NG" }));
    expect(screen.getByRole("combobox", { name: "Voyage" })).toHaveValue("");
    await user.selectOptions(screen.getByRole("combobox", { name: "Voyage" }), "call-2");
    expect(screen.getByText("12,345")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(heading()).toHaveTextContent("What the vessel owner declared and paid for");
  });

  it("offers vessel registration only with permission", async () => {
    const { rerender, props } = setup({ callId: undefined });
    expect(screen.queryByRole("link", { name: "Register a new vessel voyage" })).not.toBeInTheDocument();
    rerender(<PlanForm {...props} canRegisterVessel />);
    expect(screen.getByRole("link", { name: "Register a new vessel voyage" })).toHaveAttribute("href", "/app/vessel-calls?register");
    rerender(<PlanForm {...props} calls={[]} canRegisterVessel />);
    expect(screen.getByText(/No active voyages yet/)).toBeInTheDocument();
  });

  it("starts at the declaration for a fixed voyage and preselects the cargo type from the vessel", () => {
    setup({ callId: "call-3" });
    expect(within(screen.getByRole("list", { name: "Voyage setup steps" })).getAllByRole("listitem")).toHaveLength(2);
    expect(heading()).toHaveTextContent("What the vessel owner declared");
    expect(kind("Tanker / liquid")).toHaveAttribute("aria-pressed", "true");
    expect(kind("Containers")).toHaveAttribute("aria-pressed", "false");
  });

  it("records containers by size and laden/empty, keeping NIL distinct from not declared", async () => {
    const { user, onSave } = setup();
    expect(kind("Containers")).toHaveAttribute("aria-pressed", "true");
    await user.type(screen.getByLabelText("Manifest / bill of lading reference"), "MAN-1");
    await user.type(screen.getByLabelText("20 ft laden declared"), "100");
    await user.type(screen.getByLabelText("20 ft empty declared"), "0");
    await user.type(screen.getByLabelText("40 ft laden declared"), "30");
    expect(screen.getByText("Declared: 130 containers")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Another container size in feet"), "53");
    await user.click(screen.getByRole("button", { name: "Add size" }));
    await user.type(screen.getByLabelText("53 ft laden declared"), "2");
    await toAgencies(user);
    await user.click(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" }));
    await create(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const plan = onSave.mock.calls[0][0];
    expect(plan.lines.map(line => [line.containerSize, line.loadStatus, line.manifestQuantity, line.unit, line.baselineReference])).toEqual([
      ["20", "laden", "100", "count", "MAN-1"], ["20", "empty", "0", "count", "MAN-1"], ["40", "laden", "30", "count", "MAN-1"], ["53", "laden", "2", "count", "MAN-1"],
    ]);
    expect(plan).toMatchObject({ callId: "call-1", stage: "Discharge", method: "Physical container tally", title: "Containers discharge tally · MV Atlas · CALL-001", location: "Berth 3", leadSurveyor: "To be assigned" });
  });

  it("lists problems instead of continuing until the declaration is complete", async () => {
    const { user } = setup();
    await toAgencies(user);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter at least one declared quantity.");
    await user.type(screen.getByLabelText("40 ft laden declared"), "1.5");
    expect(screen.getByRole("alert")).toHaveTextContent("40 ft laden containers: enter a whole number.");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the manifest or bill of lading reference.");
    await user.clear(screen.getByLabelText("40 ft laden declared"));
    await user.click(kind("Containers"));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose at least one cargo type.");
    expect(heading()).toHaveTextContent("What the vessel owner declared");
  });

  it("records tanker products from the product list or a custom name, in tonnes or m³", async () => {
    const { user, onSave } = setup({ callId: "call-3" });
    await user.type(screen.getByLabelText("Manifest / bill of lading reference"), "BOL-9");
    await user.selectOptions(screen.getByLabelText("product 1"), "AGO — Automotive Gas Oil");
    await user.type(screen.getByLabelText("Declared quantity product 1"), "125.75");
    await user.click(screen.getByRole("button", { name: "Add product" }));
    await user.selectOptions(screen.getByLabelText("product 2"), "Other product…");
    await user.type(screen.getByLabelText("Other product 2"), "Methanol");
    await user.selectOptions(screen.getByLabelText("Unit product 2"), "m3");
    await user.type(screen.getByLabelText("Declared quantity product 2"), "80.125");
    expect(screen.getByText("Declared: 125.75 t · 80.125 m³")).toBeInTheDocument();
    await toAgencies(user);
    await user.click(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" }));
    await create(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const plan = onSave.mock.calls[0][0];
    expect(plan.lines.map(line => [line.category, line.description, line.unit, line.manifestQuantity])).toEqual([
      ["Liquid", "AGO — Automotive Gas Oil", "tonnes", "125.75"], ["Liquid", "Methanol", "m3", "80.125"],
    ]);
    expect(plan.method).toBe("Product measurement");
  });

  it("asks for a product name when a quantity has none", async () => {
    const { user } = setup({ callId: "call-3" });
    await user.type(screen.getByLabelText("Declared quantity product 1"), "10");
    await toAgencies(user);
    expect(screen.getByRole("alert")).toHaveTextContent("Name the product declared as 10.");
  });

  it("keeps mixed cargo lines separate and titles the voyage as mixed", async () => {
    const { user, onSave } = setup();
    await user.click(kind("Dry bulk"));
    await user.click(kind("Vehicles"));
    expect(screen.getByText("Mixed cargo · 3 types on this voyage")).toBeInTheDocument();
    await declareContainers(user);
    await user.type(screen.getByLabelText("commodity 1"), "Wheat");
    await user.type(screen.getByLabelText("Declared quantity commodity 1"), "400");
    await user.type(screen.getByLabelText("Cars"), "5");
    expect(screen.getByText("Declared: 12 containers · 400 t · 5 vehicles")).toBeInTheDocument();
    await toAgencies(user);
    await user.click(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" }));
    await create(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const plan = onSave.mock.calls[0][0];
    expect(plan.lines.map(line => [line.category, line.unit, line.manifestQuantity])).toEqual([["Container", "count", "12"], ["Bulk", "tonnes", "400"], ["Vehicle", "count", "5"]]);
    expect(plan.title).toMatch(/^Mixed cargo discharge tally/);
    expect(plan.method).toBe("Cargo survey and tally");
  });

  it("captures the paid declaration and validates the amount", async () => {
    const { user, onSave } = setup();
    await declareContainers(user);
    await user.type(screen.getByLabelText("Payer (vessel owner)"), "Atlas Shipping");
    await user.type(screen.getByLabelText("Declaration invoice number"), "DEC-77");
    await user.type(screen.getByLabelText(/^Amount paid/), "12.345");
    expect(screen.getByText("Enter a number with up to two decimals.")).toBeInTheDocument();
    await toAgencies(user);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the amount paid as a number.");
    await user.clear(screen.getByLabelText(/^Amount paid/));
    await user.type(screen.getByLabelText(/^Amount paid/), "1,250.50");
    await user.click(screen.getByRole("radio", { name: "Confirmed paid" }));
    await toAgencies(user);
    await user.click(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" }));
    await user.click(screen.getByText(/^Declaration · 1 cargo line/, { selector: "summary" }));
    expect(screen.getByText("Paid declaration: DEC-77 · payment confirmed")).toBeInTheDocument();
    await create(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][1]).toMatchObject({ payer: "Atlas Shipping", invoiceReference: "DEC-77", amountPaid: "1250.50", currency: "USD", paymentStatus: "paid" });
  });

  it("preselects agencies from the vessel's last voyage and lets the representative change for this voyage only", async () => {
    const { user, onSave } = setup({ suggestedAgencyIds: ["agency-2", "archived"] });
    await declareContainers(user);
    await toAgencies(user);
    expect(screen.getByText(/pre-selected/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Archived agency/ })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select agency Port Terminal" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" }));
    await user.clear(screen.getByLabelText("Representative for Harbour Agency"));
    await user.type(screen.getByLabelText("Representative for Harbour Agency"), "Voyage delegate");
    await create(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].participants).toEqual([
      { agencyId: "agency-2", name: "Port Terminal", role: "Terminal operator", representative: "Grace Terminal", requiredSubmission: true, requiredApproval: true },
      { agencyId: "agency-1", name: "Harbour Agency", role: "Agent", representative: "Voyage delegate", requiredSubmission: true, requiredApproval: true },
    ]);
    expect(agency.representative).toBe("Ada Agent");
  });

  it("does not reapply suggestions after the user has changed the selection", async () => {
    const { user } = setup({ suggestedAgencyIds: ["agency-1"] });
    await declareContainers(user);
    await toAgencies(user);
    await user.click(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("40 ft laden declared")).toHaveValue("12");
    await toAgencies(user);
    expect(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Create voyage and invite agencies" })).toBeDisabled();
  });

  it("clears the declaration when the voyage changes", async () => {
    const onVoyageChange = vi.fn();
    const { user } = setup({ callId: undefined, onVoyageChange });
    await user.selectOptions(screen.getByRole("combobox", { name: "Vessel" }), screen.getByRole("option", { name: "MV Atlas · NG" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Voyage" }), "call-1");
    expect(onVoyageChange).toHaveBeenLastCalledWith("call-1");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await declareContainers(user);
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Voyage" }), "call-2");
    expect(screen.getByRole("status")).toHaveTextContent("the declaration was cleared");
    expect(onVoyageChange).toHaveBeenLastCalledWith("call-2");
    await user.click(screen.getByText("Measurement details (optional)", { selector: "summary" }));
    expect(screen.getByLabelText("Terminal / berth")).toHaveValue("Berth 8");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("40 ft laden declared")).toHaveValue("");
    expect(screen.getByLabelText("Manifest / bill of lading reference")).toHaveValue("");
  });

  it("warns when the voyage already has a declaration", () => {
    setup({ existingSheets: 1 });
    expect(screen.getByText(/already has a declaration/)).toBeInTheDocument();
  });

  it("creates an agency inline, keeping the draft after a failure", async () => {
    const created: AgencyProfile = { id: "new-agency", name: "Independent Checker", role: "Cargo checker", representative: "", active: true };
    const onCreateAgency = vi.fn().mockRejectedValueOnce(new Error("Could not save agency")).mockResolvedValue(created);
    const { user, onSave } = setup({ agencyCatalog: [], onCreateAgency });
    await declareContainers(user);
    await toAgencies(user);
    expect(screen.getByText(/No agencies yet. Create one here/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New agency" }));
    await user.type(screen.getByLabelText("Agency name"), "Independent Checker");
    await user.selectOptions(screen.getByLabelText("Agency role"), "custom");
    expect(screen.getByRole("button", { name: "Save agency" })).toBeDisabled();
    await user.type(screen.getByLabelText("Other agency role"), "Cargo checker");
    await user.click(screen.getByRole("button", { name: "Save agency" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save agency");
    expect(screen.getByLabelText("Agency name")).toHaveValue("Independent Checker");
    await user.click(screen.getByRole("button", { name: "Save agency" }));
    expect(await screen.findByRole("checkbox", { name: "Select agency Independent Checker" })).toBeChecked();
    expect(onCreateAgency).toHaveBeenLastCalledWith({ name: "Independent Checker", role: "Cargo checker", representative: "" });
    await create(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].participants).toEqual([expect.objectContaining({ agencyId: "new-agency", name: "Independent Checker" })]);
  });

  it("limits inline agency creation to managers with a create callback", async () => {
    const { user, rerender, props } = setup({ canManageAgencies: false, onCreateAgency: vi.fn() });
    await declareContainers(user);
    await toAgencies(user);
    expect(screen.queryByRole("button", { name: "New agency" })).not.toBeInTheDocument();
    rerender(<PlanForm {...props} canManageAgencies onCreateAgency={undefined} />);
    expect(screen.queryByRole("button", { name: "New agency" })).not.toBeInTheDocument();
    rerender(<PlanForm {...props} canManageAgencies agencyCatalog={[]} />);
    expect(screen.getByText(/Create one here or in Agencies/)).toBeInTheDocument();
    rerender(<PlanForm {...props} canManageAgencies={false} agencyCatalog={[]} />);
    expect(screen.getByText(/Ask an administrator/)).toBeInTheDocument();
  });

  it("shows save errors and lets the user retry or cancel", async () => {
    const { user, onSave, onCancel } = setup();
    onSave.mockRejectedValueOnce(new Error("The voyage changed; review and try again."));
    await declareContainers(user);
    await toAgencies(user);
    await user.click(screen.getByRole("checkbox", { name: "Select agency Harbour Agency" }));
    await create(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("The voyage changed; review and try again.");
    await create(user);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
