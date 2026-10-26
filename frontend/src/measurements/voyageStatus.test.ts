import { describe, expect, it } from "vitest";
import type { VesselCall } from "../types";
import { voyageInputFingerprint, type CloseoutRecord, type PreviewInvoice, type PreviewReport } from "./closeoutPreview";
import { measurementFixture } from "./fixtures.test-support";
import type { MeasurementPlan } from "./types";
import { daysSince, declarationTotals, nextStepPath, summarizeVoyage, summarizeVoyages, voyageSteps } from "./voyageStatus";
import { vesselPath, vesselSlug } from "./voyages";

const call: VesselCall = { id: "call-1", reference: "VOY-001", vesselName: "MV Atlas", flag: "NG", type: "Bulk", nrt: 12000, eta: "2026-10-01T09:00:00Z", sailingEta: "", berth: "Berth 3", berthDate: null, status: "in-progress", notes: "", version: 1, registered: "2026-09-29" };
function allIn(): MeasurementPlan {
  const plan = measurementFixture();
  plan.submissions.push({ ...plan.submissions[0], id: "terminal", participantId: "party-2", recordedBy: null, recordedAt: "2026-09-30T08:00:00Z" });
  return plan;
}
function record(plan: MeasurementPlan, report: Partial<PreviewReport>, invoice?: Partial<PreviewInvoice>): CloseoutRecord {
  const saved: PreviewReport = { id: "report-1", callId: plan.callId, revision: 2, sourceFingerprint: voyageInputFingerprint([plan]), reason: "Joint review", sourcePlans: [plan], lines: [], ...report };
  const invoices: PreviewInvoice[] = invoice ? [{ id: "invoice-1", callId: plan.callId, number: "DRAFT-VAR-1", reportId: saved.id, status: "draft", currency: "USD", total: "1320", payer: "Owner", originalInvoiceReference: "DEC-1", paymentStatus: "paid", originalPaidAmount: "", previousVariationReference: "", tariffReference: "", lines: [], createdAt: "2026-10-02T11:00:00Z", createdBy: { id: "finance", name: "Finance" }, ...invoice }] : [];
  return { callId: plan.callId, reports: [saved], invoices, events: [{ id: "event-1", callId: plan.callId, at: "2026-10-03T08:00:00Z", actor: { id: "admin", name: "Admin" }, action: "report-approved", reference: "v2" }] };
}
const approved = { status: "approved" as const, approvedAt: "2026-10-02T10:00:00Z", approvedBy: { id: "admin", name: "Admin" } };
const stage = (plans: MeasurementPlan[], closeout?: CloseoutRecord, voyageCall: VesselCall | undefined = call) => summarizeVoyage("call-1", voyageCall, plans, closeout).stage;

describe("voyage status", () => {
  it("derives each stage from the declaration, readings and closeout record", () => {
    expect(stage([])).toBe("declaration");
    const missing = measurementFixture(); missing.lines[0].manifestQuantity = null;
    expect(stage([missing])).toBe("declaration");
    expect(stage([measurementFixture()])).toBe("collecting");
    const plan = allIn();
    expect(stage([plan])).toBe("ready");
    expect(stage([plan], record(plan, { status: "submitted" }))).toBe("approval");
    expect(stage([plan], record(plan, { status: "returned", returnComment: "Recheck" }))).toBe("returned");
    expect(stage([plan], record(plan, approved))).toBe("invoice");
    expect(stage([plan], record(plan, approved, {}))).toBe("draft");
    expect(stage([plan], record(plan, approved, { status: "no-charge" }))).toBe("no-charge");
    expect(stage([plan], record(plan, approved, { status: "overpayment-review" }))).toBe("review");
    expect(stage([plan], record(plan, approved, { status: "held" }))).toBe("held");
    expect(stage([plan], record(plan, approved, {}), { ...call, status: "cancelled" })).toBe("cancelled");
  });

  it("drops back to reconciliation when the readings change after approval", () => {
    const plan = allIn();
    const closeout = record(plan, approved, {});
    plan.submissions.push({ ...plan.submissions[1], id: "terminal-2", revision: 2, lines: [{ lineId: "line-1", status: "reported", quantity: "19510", note: "" }] });
    const voyage = summarizeVoyage("call-1", call, [plan], closeout);
    expect(voyage).toMatchObject({ stage: "ready", report: undefined, invoice: undefined });
  });

  it("counts readings per agency once and names only required agencies still owed", () => {
    const plan = measurementFixture();
    plan.submissions.push({ ...plan.submissions[0], id: "revision", revision: 2 });
    const voyage = summarizeVoyage("call-1", call, [plan, { ...measurementFixture(), id: "void", status: "cancelled" }]);
    expect(voyage).toMatchObject({ received: 1, expected: 2, pendingAgencies: ["Terminal One"], lineCount: 1, differingLines: 1, lastActivityAt: "2026-09-29T10:00:00Z" });
    expect(voyage.allPlans).toHaveLength(2);
    plan.participants[1].requiredSubmission = false;
    expect(summarizeVoyage("call-1", call, [plan]).pendingAgencies).toEqual([]);
  });

  it("groups plans under their call and keeps unloaded calls as their own voyage", () => {
    const voyages = summarizeVoyages([call], [measurementFixture(), { ...measurementFixture(), id: "other", callId: "unloaded", callReference: "HIST-9" }], []);
    expect(voyages.map(voyage => [voyage.callId, voyage.reference, voyage.plans.length])).toEqual([["call-1", "VOY-001", 1], ["unloaded", "HIST-9", 1]]);
  });

  it("describes the four workspace steps", () => {
    const plan = allIn();
    const closeout = record(plan, approved, {});
    closeout.declaration = { payer: "Owner", agent: "", invoiceReference: "DEC-1", amountPaid: "", currency: "USD", paidOn: "", paymentStatus: "paid", updatedAt: "2026-10-01T00:00:00Z", updatedBy: { id: "admin", name: "Admin" } };
    expect(voyageSteps(summarizeVoyage("call-1", call, [plan], closeout))).toEqual({
      declaration: { state: "done", label: "Paid · 19,500 t" },
      agencies: { state: "done", label: "2 of 2 submitted" },
      readings: { state: "done", label: "Approved · v2" },
      "variation-invoice": { state: "current", label: "Draft · USD 1,320.00" },
    });
    expect(voyageSteps(summarizeVoyage("call-1", call, [measurementFixture()]))).toMatchObject({
      declaration: { state: "done", label: "Recorded · 19,500 t" }, agencies: { state: "current", label: "1 of 2 submitted" },
      readings: { state: "todo" }, "variation-invoice": { state: "todo", label: "Drafted on approval" },
    });
    expect(voyageSteps(summarizeVoyage("call-1", call, [plan])).readings).toEqual({ state: "current", label: "1 line differs" });
    expect(voyageSteps(summarizeVoyage("call-1", call, [])).declaration).toEqual({ state: "current", label: "Not started" });
  });

  it("sends each stage to the step that moves it on", () => {
    const plan = allIn();
    const path = (plans: MeasurementPlan[], closeout?: CloseoutRecord) => nextStepPath(summarizeVoyage("call 1", { ...call, id: "call 1" }, plans, closeout && { ...closeout, callId: "call 1" }));
    expect(path([])).toBe("/app/measurements/new?callId=call%201");
    const missing = measurementFixture(); missing.lines[0].manifestQuantity = null;
    expect(path([missing])).toBe("/app/measurements/voyages/call%201/declaration");
    expect(path([measurementFixture()])).toBe("/app/measurements/voyages/call%201/agencies");
    expect(path([plan])).toBe("/app/measurements/voyages/call%201/readings");
  });

  it("totals the declaration per unit without converting between units", () => {
    expect(declarationTotals([
      { category: "Container", unit: "count", manifestQuantity: "178" }, { category: "Container", unit: "count", manifestQuantity: "40" },
      { category: "Bulk", unit: "tonnes", manifestQuantity: "12450.5" }, { category: "Vehicle", unit: "count", manifestQuantity: "1" },
      { category: "Liquid", unit: "m3", manifestQuantity: "300" }, { category: "Bulk", unit: "tonnes", manifestQuantity: null },
    ])).toBe("218 containers · 12,450.5 t · 1 vehicle · 300 m³");
    expect(declarationTotals([])).toBe("");
  });

  it("counts whole days waited", () => {
    const now = Date.parse("2026-10-05T12:00:00Z");
    expect(daysSince("2026-10-05T01:00:00Z", now)).toBe(0);
    expect(daysSince("2026-10-02T12:00:00Z", now)).toBe(3);
    expect(daysSince("2026-10-06T12:00:00Z", now)).toBe(0);
    expect(daysSince(null, now)).toBeNull();
    expect(daysSince("not a date", now)).toBeNull();
  });
});

describe("vessel links", () => {
  it("builds a readable slug from name and flag", () => {
    expect(vesselSlug("MV Atlantic Pride", "Liberia")).toBe("mv-atlantic-pride--liberia");
    expect(vesselSlug("  M.V. Ikom  Express ", "")).toBe("m-v-ikom-express");
    expect(vesselSlug("MT Bonny Star")).toBe("mt-bonny-star");
    expect(vesselPath("MV Atlantic Pride", "Liberia")).toBe("/app/vessels/mv-atlantic-pride--liberia");
  });
});
