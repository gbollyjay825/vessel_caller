import type { CargoLine, SubmissionLine } from "./types";

// Public presentation data is intentionally separate from MeasurementPlan and
// staff submissions. Token/session transport belongs to the page adapter.
export type GuestCargoLine = Omit<CargoLine, "manifestQuantity" | "baselineReference">;
export interface GuestReadingInput {
  representative: string;
  observedAt: string;
  sourceReference: string;
  notes: string;
  lines: SubmissionLine[];
}
export interface GuestSubmittedReport extends GuestReadingInput {
  id: string;
  participantId: string;
  agencyName: string;
  agencyRole: string;
  submittedAt: string;
  status: "submitted";
}
export interface GuestPeerReport {
  id: string;
  participantId: string;
  agencyName: string;
  agencyRole: string;
  submittedAt: string;
  status: "submitted";
  lines: Pick<SubmissionLine, "lineId" | "status" | "quantity">[];
}
export interface GuestReadingContext {
  contextId: string;
  agency: { id: string; name: string; role: string; representative: string };
  voyage: { vesselName: string; callReference: string; title: string; location: string; scheduledAt: string };
  lines: GuestCargoLine[];
  ownReport: GuestSubmittedReport | null;
  completedPeers: GuestPeerReport[];
}
export interface GuestPortalContext extends GuestReadingContext { inputFingerprint: string; uiPreview?: boolean }
