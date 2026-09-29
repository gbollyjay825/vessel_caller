import { ApiError, request } from "../lib/api";
import type { Invoice } from "../types";
import type { ApprovalInput, AssessmentInput, Evidence, MeasurementPlan, PlanInput, PlanMutation, ReconciliationInput, SubmissionInput } from "./types";

const root = "/api/measurement-plans";
const path = (id: string) => `${root}/${encodeURIComponent(id)}`;
const post = <T,>(url: string, body: unknown) => request<T>(url, { method: "POST", body: JSON.stringify(body) });
export const measurementApi = {
  list: (callId?: string) => request<{ plans: MeasurementPlan[] }>(`${root}${callId ? `?callId=${encodeURIComponent(callId)}` : ""}`),
  detail: (id: string) => request<{ plan: MeasurementPlan }>(path(id)),
  create: (body: PlanInput) => post<PlanMutation>(root, body),
  update: (id: string, body: Partial<PlanInput> & { version: number; status?: "cancelled"; reason?: string }) => request<PlanMutation>(path(id), { method: "PATCH", body: JSON.stringify(body) }),
  submit: (id: string, version: number, body: SubmissionInput) => post<PlanMutation>(`${path(id)}/submissions`, { ...body, version }),
  propose: (id: string, version: number, body: ReconciliationInput) => post<PlanMutation>(`${path(id)}/reconciliations`, { ...body, version }),
  acknowledge: (id: string, rid: string, version: number, body: ApprovalInput) => post<PlanMutation>(`${path(id)}/reconciliations/${encodeURIComponent(rid)}/approvals`, { ...body, version }),
  finalize: (id: string, rid: string, version: number) => post<PlanMutation>(`${path(id)}/reconciliations/${encodeURIComponent(rid)}/finalize`, { version }),
  assess: (id: string, version: number, body: AssessmentInput) => post<PlanMutation>(`${path(id)}/assessments`, { ...body, version }),
  issue: (id: string, aid: string, version: number) => post<PlanMutation & { invoice: Invoice }>(`${path(id)}/assessments/${encodeURIComponent(aid)}/issue`, { version }),
  documentUrl: (id: string, rid: string) => `${(import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "")}${path(id)}/reconciliations/${encodeURIComponent(rid)}/document`,
  evidence: (id: string, eid: string) => request<{ evidence: Evidence; downloadUrl: string }>(`${path(id)}/evidence/${encodeURIComponent(eid)}`),
  upload: async (id: string, file: File): Promise<Evidence> => {
    if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Choose a PDF, JPEG, PNG or WebP file.");
    if (file.size <= 0 || file.size > 15 * 1024 * 1024) throw new Error("Each evidence file must be between 1 byte and 15 MB.");
    const bytes = await file.arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const checksum = `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
    const metadata = { fileName: file.name, contentType: file.type, size: file.size, checksum };
    const prepared = await post<{ uploadUrl: string; headers?: Record<string, string>; objectKey: string }>(`${path(id)}/evidence/presign`, metadata);
    const response = await fetch(prepared.uploadUrl, { method: "PUT", headers: prepared.headers, body: file });
    if (!response.ok) throw new ApiError("Evidence upload failed. Please try again.", response.status);
    return (await post<{ evidence: Evidence }>(`${path(id)}/evidence`, { ...metadata, objectKey: prepared.objectKey })).evidence;
  },
};
