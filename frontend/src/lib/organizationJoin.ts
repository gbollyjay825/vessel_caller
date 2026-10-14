import type { Paginated, Role, User } from "../types";
import { request } from "./api";

export interface OrganizationSignupLink {
  id: string;
  organizationId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
  createdBy: { id: string; name: string };
}

export type JoinRequestStatus = "unverified" | "pending" | "approved" | "rejected" | "expired";
export interface OrganizationJoinRequest {
  id: string;
  name: string;
  email: string;
  status: JoinRequestStatus;
  createdAt: string;
  emailVerifiedAt: string | null;
  reviewedAt: string | null;
  role?: Role | null;
}

export const organizationJoinApi = {
  links: () => request<Paginated<OrganizationSignupLink>>("/api/organization-signup-links?pageSize=20"),
  createLink: (expiresInDays: number) => request<{ link: OrganizationSignupLink; signupUrl: string; rev: number }>(
    "/api/organization-signup-links", { method: "POST", body: JSON.stringify({ expiresInDays }) },
  ),
  revokeLink: (id: string) => request<void>(`/api/organization-signup-links/${encodeURIComponent(id)}`, { method: "DELETE" }),
  requests: ({ page = 1, status = "pending" }: { page?: number; status?: JoinRequestStatus | "all" } = {}) => {
    const query = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (status !== "all") query.set("status", status);
    return request<Paginated<OrganizationJoinRequest>>(`/api/organization-join-requests?${query}`);
  },
  approve: (id: string, role: Role) => request<{ request: OrganizationJoinRequest; user: User; rev: number }>(
    `/api/organization-join-requests/${encodeURIComponent(id)}/approve`,
    { method: "POST", body: JSON.stringify({ role }) },
  ),
  reject: (id: string) => request<{ request: OrganizationJoinRequest; rev: number }>(
    `/api/organization-join-requests/${encodeURIComponent(id)}/reject`, { method: "POST" },
  ),
  inspect: (token: string) => request<{ organization: { name: string }; expiresAt: string }>(
    "/api/organization-join/resolve", { method: "POST", body: JSON.stringify({ token }), suppressAuthExpired: true },
  ),
  submit: (data: { token: string; name: string; email: string }) => request<{ detail: string }>(
    "/api/organization-join", { method: "POST", body: JSON.stringify(data), suppressAuthExpired: true },
  ),
  verify: (token: string, password: string) => request<{ detail: string }>(
    "/api/organization-join/verify", { method: "POST", body: JSON.stringify({ token, password }), suppressAuthExpired: true },
  ),
};
