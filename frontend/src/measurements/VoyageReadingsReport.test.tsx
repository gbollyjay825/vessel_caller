import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VoyageReadingsReport } from "./VoyageReadingsReport";
import { measurementFixture, reconciliationFixture } from "./fixtures.test-support";
import { dateLabel } from "./helpers";
import { reportIdentity } from "./reportIdentity";
import type { CargoLine, MeasurementPlan } from "./types";

function line(id: string, description: string, patch: Partial<CargoLine> = {}): CargoLine {
  return { ...measurementFixture().lines[0], id, description, ...patch };
}
const report = (plans: MeasurementPlan[], callId = "call-1") => render(<VoyageReadingsReport callId={callId} plans={plans} />);
const row = (description: string) => within(screen.getByRole("row", { name: new RegExp(`^${description}`) }));
const cells = (description: string) => row(description).getAllByRole("cell");

describe("voyage readings report", () => {
  it("filters every row and agency to the explicit voyage, even when another voyage has the same vessel", () => {
    const other = measurementFixture(); other.id = "other-sheet"; other.callId = "other-call";
    other.title = "Private other voyage"; other.participants[0].name = "Other voyage agency";
    other.lines[0].description = "Other voyage cargo";
    report([other, measurementFixture()]);
    expect(screen.getByRole("table", { name: "Owner declaration and agency readings for this voyage" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Voyage readings table" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("columnheader", { name: /Owner declaration/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Harbour Agent/ })).toHaveTextContent("Agent");
    expect(screen.queryByText(/Other voyage|Private other voyage/)).not.toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /tally|difference|bill/i })).not.toBeInTheDocument();
  });

  it("shows an empty voyage without borrowing a sheet or agency from another voyage", () => {
    report([measurementFixture()], "missing-call");
    expect(screen.getByRole("status")).toHaveTextContent("No cargo sheets recorded for this voyage.");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("Harbour Agent")).not.toBeInTheDocument();
  });

  it("identifies repeated sheet headings by schedule, location and a stable distinct reference", () => {
    const first = measurementFixture(); first.id = "12345678a00000000000000000000000";
    const second = structuredClone(first); second.id = "12345678b00000000000000000000000";
    second.title = "  DISCHARGE   survey "; second.scope = " parcel a ";
    second.scheduledAt = "2026-09-30T14:30:00Z"; second.location = "Berth 4";
    const { rerender } = report([second, first]);
    const headings = () => screen.getAllByRole("rowgroup").slice(1).map(body => within(body).getAllByRole("rowheader")[0].textContent);
    const initial = headings();
    expect(initial[0]).toContain(`Scheduled ${dateLabel(first.scheduledAt)} · Berth 2 · Sheet 12345678a`);
    expect(initial[1]).toContain(`Scheduled ${dateLabel(second.scheduledAt)} · Berth 4 · Sheet 12345678b`);
    rerender(<VoyageReadingsReport callId="call-1" plans={[first, second]} />);
    expect(headings()).toEqual(initial);
  });

  it("omits sheet references for unique headings and excludes another voyage from duplicate matching", () => {
    const first = measurementFixture();
    const otherVoyage = { ...first, id: "other-voyage-sheet", callId: "another-call" };
    const otherScope = { ...first, id: "other-scope-sheet", scope: "Parcel B" };
    expect(reportIdentity(first, [first, otherVoyage, otherScope])).toBe(`Scheduled ${dateLabel(first.scheduledAt)} · Berth 2`);
    expect(reportIdentity({ ...first, scheduledAt: "", location: " " }, [first])).toBe("");
    report([first, otherVoyage]);
    expect(screen.getByText(`Scheduled ${dateLabel(first.scheduledAt)} · Berth 2`)).toBeInTheDocument();
    expect(screen.queryByText(/Sheet plan-1/)).not.toBeInTheDocument();
  });

  it("keeps sheet scopes separate and deduplicates agency columns by normalized name and role with stable ordering", () => {
    const first = measurementFixture(); first.title = "Hold A"; first.scope = "First parcel";
    first.lines[0].manifestQuantity = "10";
    first.submissions[0].lines[0].quantity = "11";
    const second = measurementFixture(); second.id = "plan-2"; second.title = "Hold B"; second.scope = "Second parcel";
    second.lines[0].manifestQuantity = "20";
    second.participants = [{ ...second.participants[0], id: "different-party-id", name: "  HARBOUR   agent ", role: " agent " }, { ...second.participants[0], id: "same-name-another-role", role: "Surveyor" }];
    second.submissions[0].participantId = "different-party-id"; second.submissions[0].lines[0].quantity = "22";
    const { rerender } = report([second, first]);
    const headingNames = screen.getAllByRole("columnheader").map(element => element.textContent);
    expect(headingNames).toEqual(["Cargo item", "Unit", "Owner declarationVessel owner baseline", "Harbour AgentAgent", "Harbour AgentSurveyor", "Terminal OneTerminal operator"]);
    const bodies = screen.getByRole("table").querySelectorAll("tbody");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveTextContent("Hold AFirst parcel");
    expect(bodies[1]).toHaveTextContent("Hold BSecond parcel");
    expect(within(bodies[0]).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["Tonnes", "10BL-001", "11", "—Not participating", "Awaiting"]);
    expect(within(bodies[1]).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["Tonnes", "20BL-001", "22", "Awaiting", "—Not participating"]);
    expect(screen.queryByText("30", { exact: true })).not.toBeInTheDocument();
    rerender(<VoyageReadingsReport callId="call-1" plans={[first, second]} />);
    expect(screen.getAllByRole("columnheader").map(element => element.textContent)).toEqual(headingNames);
    expect(first.participants[0].name).toBe("Harbour Agent");
    expect(second.participants[0].name).toBe("  HARBOUR   agent ");
  });

  it("uses the highest submitted revision regardless of array order and keeps the owner's declaration instead of a reconciliation snapshot", () => {
    const plan = measurementFixture();
    const original = plan.submissions[0];
    plan.submissions = [
      { ...original, id: "revision-3", revision: 3, lines: [{ ...original.lines[0], quantity: "19511.125" }] },
      { ...original, id: "revision-2", revision: 2, lines: [{ ...original.lines[0], quantity: "19509" }] },
      original,
    ];
    const final = reconciliationFixture(); final.status = "final"; final.lines[0].manifestQuantity = "19000"; final.lines[0].quantity = "19001";
    plan.reconciliations = [final]; plan.status = "reconciled";
    report([plan]);
    expect(cells("Wheat")[1]).toHaveTextContent("19,500");
    expect(cells("Wheat")[2]).toHaveTextContent("19,511.125");
    expect(screen.queryByText("19,508")).not.toBeInTheDocument();
    expect(screen.queryByText("19,509")).not.toBeInTheDocument();
    expect(screen.queryByText("19,000")).not.toBeInTheDocument();
    expect(screen.queryByText("19,001")).not.toBeInTheDocument();
    expect(screen.getByText("Reconciled", { exact: true })).toBeInTheDocument();
  });

  it("distinguishes owner and agency zero, unknown, N/A, missing submitted items and required or optional submissions", () => {
    const plan = measurementFixture();
    plan.lines = [line("zero", "Zero cargo", { manifestQuantity: "0.000" }), line("unknown", "Unknown cargo", { manifestQuantity: null }), line("missing", "Missing cargo")];
    plan.participants.push({ ...plan.participants[1], id: "optional", name: "Optional surveyor", requiredSubmission: false });
    plan.submissions[0].lines = [
      { lineId: "zero", status: "reported", quantity: "0", note: "Explicit NIL reading" },
      { lineId: "unknown", status: "not-applicable", quantity: null, note: "Outside this agency's measurement scope" },
    ];
    report([plan]);
    expect(cells("Zero cargo")[1]).toHaveTextContent("NIL (0)");
    expect(cells("Zero cargo")[2]).toHaveTextContent("NIL (0)Explicit NIL reading");
    expect(cells("Unknown cargo")[1]).toHaveTextContent("Unknown");
    expect(cells("Unknown cargo")[2]).toHaveTextContent("N/AOutside this agency's measurement scope");
    expect(cells("Missing cargo")[2]).toHaveTextContent("Not reported");
    expect(cells("Missing cargo")[3]).toHaveTextContent("Not submitted");
    expect(cells("Missing cargo")[4]).toHaveTextContent("Awaiting");
  });

  it("does not turn an absent reported quantity or missing N/A reason into zero", () => {
    const plan = measurementFixture();
    plan.lines.push(line("extra", "Extra cargo"));
    plan.submissions[0].lines = [{ lineId: "line-1", status: "reported", quantity: null, note: "Value omitted" }, { lineId: "extra", status: "not-applicable", quantity: null, note: "" }];
    report([plan]);
    expect(cells("Wheat")[2]).toHaveTextContent("UnknownValue omitted");
    expect(cells("Extra cargo")[2]).toHaveTextContent("N/ANo reason provided");
    expect(screen.queryByText("NIL (0)", { selector: "td span" })).not.toBeInTheDocument();
  });

  it("retains cancelled sheets with their recorded quantities and reports absent cancelled readings as not submitted", () => {
    const plan = measurementFixture(); plan.status = "cancelled";
    report([plan]);
    expect(screen.getByText("Cancelled", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Includes 1 cancelled sheet.")).toBeInTheDocument();
    expect(cells("Wheat")[2]).toHaveTextContent("19,508");
    expect(cells("Wheat")[3]).toHaveTextContent("Not submitted");
    expect(screen.queryByText("Awaiting", { selector: "td span" })).not.toBeInTheDocument();
  });

  it("shows container size and load, tanker products, vehicles, directions and distinct mass or volume units without totals", () => {
    const plan = measurementFixture(); plan.participants = []; plan.submissions = [];
    plan.lines = [
      line("container20", "20 foot loaded boxes", { category: "Container", containerSize: "20", loadStatus: "laden", unit: "count", basis: "Container count", manifestQuantity: "4" }),
      line("container40", "40 foot empty boxes", { category: "Container", containerSize: "40", loadStatus: "empty", unit: "count", basis: "Container count", manifestQuantity: "5" }),
      line("container45", "45 foot loaded boxes", { category: "Container", containerSize: "45", loadStatus: "laden", unit: "count", basis: "Container count", manifestQuantity: "2" }),
      line("tanker", "Petroleum", { category: "Liquid", unit: "m3", manifestQuantity: "120.5", basis: "Declared volume" }),
      line("vehicles", "Mafi Trailer / HDV", { category: "Vehicle", unit: "count", manifestQuantity: "3", basis: "Vehicle count" }),
      line("bulk", "Wheat", { category: "Bulk", direction: "export", unit: "tonnes", manifestQuantity: "10.25" }),
    ];
    report([plan]);
    expect(row("20 ft · Laden").getByRole("rowheader")).toHaveTextContent("20 foot loaded boxes");
    expect(cells("20 ft · Laden")[0]).toHaveTextContent("Count");
    expect(row("40 ft · Empty").getByRole("rowheader")).toBeInTheDocument();
    expect(row("45 ft · Laden").getByRole("rowheader")).toBeInTheDocument();
    expect(row("Petroleum").getByRole("rowheader")).toHaveTextContent("Tanker / liquid cargo");
    expect(cells("Petroleum")[0]).toHaveTextContent("Cubic metres (m³)");
    expect(cells("Mafi Trailer / HDV")[0]).toHaveTextContent("Count");
    expect(row("Wheat").getByRole("rowheader")).toHaveTextContent("Export / loading");
    expect(cells("Wheat")[0]).toHaveTextContent("Tonnes");
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    expect(screen.queryByText(/total/i)).not.toBeInTheDocument();
  });

  it("orders shuffled container categories like the declaration form without combining separate parcels or units", () => {
    const plan = measurementFixture(); plan.submissions = [];
    const container = (id: string, size: string, loadStatus: string, patch: Partial<CargoLine> = {}) => line(id, id, { category: "Container", containerSize: size, loadStatus, unit: "count", ...patch });
    plan.lines = [
      container("40 empty", "40", "empty"), container("20 empty", "20", "empty"),
      container("45 empty", "45", "empty"), container("20 laden parcel A", "20", "laden"),
      container("40 laden", "40", "laden"), container("45 laden", "45", "laden"),
      container("20 laden parcel B", "20", "laden", { unit: "tonnes", basis: "Separate mass scope" }),
    ];
    const originalOrder = plan.lines.map(item => item.id);
    report([plan]);
    const rows = screen.getAllByRole("row").filter(element => element.querySelector('th[scope="row"]'));
    expect(rows.map(element => within(element).getByRole("rowheader").textContent)).toEqual([
      expect.stringContaining("20 laden parcel A"), expect.stringContaining("20 laden parcel B"), expect.stringContaining("20 empty"),
      expect.stringContaining("40 laden"), expect.stringContaining("40 empty"), expect.stringContaining("45 laden"), expect.stringContaining("45 empty"),
    ]);
    expect(within(rows[1]).getAllByRole("cell")[0]).toHaveTextContent("Tonnes");
    expect(plan.lines.map(item => item.id)).toEqual(originalOrder);
  });

  it("preserves multiple representatives with the same agency name and role rather than overwriting one reading", () => {
    const plan = measurementFixture();
    plan.participants = [plan.participants[0], { ...plan.participants[0], id: "another-agent", representative: "Second representative" }];
    plan.submissions.push({ ...plan.submissions[0], id: "second-agent-reading", participantId: "another-agent", lines: [{ ...plan.submissions[0].lines[0], quantity: "19510" }] });
    report([plan]);
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
    expect(cells("Wheat")[2]).toHaveTextContent("Grace19,508Second representative19,510");
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });

  it("keeps an empty cargo sheet visible and ignores submissions from parties outside its participant list", () => {
    const plan = measurementFixture(); plan.lines = [];
    plan.submissions.push({ ...plan.submissions[0], id: "unrelated", participantId: "other-party" });
    report([plan]);
    expect(screen.getByText("No cargo items recorded on this sheet.")).toBeInTheDocument();
    expect(screen.getByText("Discharge survey")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });
});
