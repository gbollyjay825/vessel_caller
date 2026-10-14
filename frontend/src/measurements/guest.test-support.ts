import type { GuestPortalContext, GuestReadingInput } from "./guestTypes";
export const guestInput = (): GuestReadingInput => ({ representative: "Ada", observedAt: "2026-10-05T10:00:00Z", sourceReference: "SOURCE-1", notes: "", lines: [{ lineId: "line-1", quantity: "0", status: "reported", note: "" }] });
export const guestContext = (): GuestPortalContext => ({
  contextId: "context-1", inputFingerprint: "scope-fingerprint", agency: { id: "party-1", name: "Harbour Agency", role: "Agent", representative: "Ada" },
  voyage: { vesselName: "MV Atlas", callReference: "CALL-001", title: "Voyage measurement", location: "Berth 3", scheduledAt: "2026-10-05T10:00:00Z" },
  lines: [{ id: "line-1", description: "Wheat", category: "Bulk", direction: "import", containerSize: "", loadStatus: "", unit: "tonnes", basis: "Net mass" }], ownReport: null, completedPeers: [],
});
export const guestReceipt = (input = guestInput()): GuestPortalContext => ({ ...guestContext(), ownReport: { ...input, id: "report-1", participantId: "party-1", agencyName: "Harbour Agency", agencyRole: "Agent", submittedAt: "2026-10-05T11:00:00Z", status: "submitted" } });
