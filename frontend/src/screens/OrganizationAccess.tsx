import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { Drawer, EmptyState, Field } from "../components/ui";
import { ApiError } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { organizationJoinApi, type JoinRequestStatus, type OrganizationJoinRequest, type OrganizationSignupLink } from "../lib/organizationJoin";
import { ROLES, type Role } from "../types";

const ROLE_HELP: Record<Role, string> = {
  Admin: "Full organization access, including user management, settings and NPA reconciliation approval.",
  Operations: "Manage vessel calls, owner declarations and agency readings.",
  Finance: "Manage invoices, additional load billing and payments.",
  Viewer: "View records and reports without making changes.",
};
const REQUEST_LABELS: Record<JoinRequestStatus, string> = {
  unverified: "Email not verified", pending: "Awaiting approval", approved: "Approved", rejected: "Rejected", expired: "Expired",
};
function errorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback;
}
function linkIsActive(link: OrganizationSignupLink) {
  return link.status === "active" && new Date(link.expiresAt).getTime() > Date.now();
}

export function OrganizationAccess() {
  const { can, org, user } = useAuth();
  if (!can("users.manage")) return <EmptyState icon="users" title="Admin access required" body="An Admin can create sign-up links and approve requests to join this organization." />;
  return <div className="organization-access">
    <SignupLinkPanel key={`${user?.id || ""}:${org?.id || ""}`} organizationId={org?.id || ""} />
    <JoinRequestsPanel organizationId={org?.id || ""} />
  </div>;
}

function SignupLinkPanel({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["organization-signup-links", organizationId];
  const links = useQuery({ queryKey, queryFn: organizationJoinApi.links });
  const activeLink = links.data?.results.find(linkIsActive);
  const [days, setDays] = useState(7);
  const [intent, setIntent] = useState<"replace" | "revoke" | null>(null);
  const [generated, setGenerated] = useState<{ url: string; id: string; expiresAt: string } | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [pending, setPending] = useState(false);
  const [operationError, setOperationError] = useState<unknown>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  const perform = async (action: "create" | "revoke") => {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = generation.current;
    setPending(true);
    setOperationError(null);
    try {
      // The bearer URL belongs only in this component's short-lived state,
      // never in React Query's mutation cache or browser persistence.
      const result = action === "create" ? await organizationJoinApi.createLink(days) : null;
      if (action === "revoke" && activeLink) await organizationJoinApi.revokeLink(activeLink.id);
      if (current !== generation.current) return;
      setIntent(null);
      setCopyState("idle");
      setGenerated(result ? { url: result.signupUrl, id: result.link.id, expiresAt: result.link.expiresAt } : null);
      void queryClient.invalidateQueries({ queryKey });
    } catch (error) {
      if (current === generation.current) setOperationError(error);
    } finally {
      if (current === generation.current) { inFlight.current = false; setPending(false); }
    }
  };
  const copy = async () => {
    if (!generated) return;
    try { await navigator.clipboard.writeText(generated.url); setCopyState("copied"); }
    catch { setCopyState("failed"); }
  };
  const visibleGenerated = generated && activeLink?.id === generated.id ? generated : null;
  return <section className="card organization-access-card" aria-labelledby="organization-signup-title">
    <div className="organization-access-heading"><div><h2 id="organization-signup-title">Share a sign-up link</h2><p>People can request to join your organization. You approve each verified request and choose their role.</p></div><span className="organization-access-policy">Admin approval required</span></div>
    {links.isPending ? <p role="status">Loading sign-up link…</p> : links.isError ? <div className="auth-error" role="alert">Could not load the sign-up link. <button type="button" className="link-btn" onClick={() => void links.refetch()}>Try again</button></div> : <>
      {activeLink ? <div className="organization-active-link"><Icon name="external" size={18} /><div><strong>Sign-up link active</strong><p>Expires {fmtDateTime(activeLink.expiresAt)}</p></div></div> : <p className="organization-access-empty">No active sign-up link. Create one to share with colleagues.</p>}
      <div className="organization-generated-link"><label htmlFor="organization-signup-url">Shareable sign-up link</label><div className="organization-copy-row"><input id="organization-signup-url" type="text" readOnly value={visibleGenerated?.url || ""} placeholder={activeLink ? "Create a replacement link to get a copy" : "Your generated link will appear here"} onFocus={(event) => event.target.select()} aria-describedby="organization-signup-link-help" /><button className="btn btn-primary" type="button" disabled={!visibleGenerated || pending} onClick={() => void copy()}><Icon name="clipboard" size={15} />{copyState === "copied" ? "Copied" : "Copy link"}</button></div><p id="organization-signup-link-help">{visibleGenerated ? "Copy and save this link before leaving this page. It cannot be retrieved later." : activeLink ? "The previous link cannot be retrieved. Create a replacement to copy and share; the previous link will stop working." : "Create a link below, then copy it from this field and send it to your colleagues."}</p>{visibleGenerated && copyState === "copied" && <span role="status">Link copied.</span>}{visibleGenerated && copyState === "failed" && <span role="alert">Could not copy the link. Select the link above and copy it manually.</span>}</div>
      <div className="organization-link-controls"><label>Link valid for<select value={days} disabled={pending} onChange={(event) => setDays(Number(event.target.value))}>{[1, 7, 14, 30].map((value) => <option key={value} value={value}>{value} {value === 1 ? "day" : "days"}</option>)}</select></label><button type="button" className={`btn ${visibleGenerated ? "btn-secondary" : "btn-primary"}`} disabled={pending} onClick={() => activeLink ? setIntent("replace") : void perform("create")}>{pending && intent !== "revoke" ? "Creating…" : activeLink ? "Create replacement link" : "Create sign-up link"}</button>{activeLink && <button className="link-btn danger" type="button" disabled={pending} onClick={() => setIntent("revoke")}>Revoke link</button>}</div>
      {intent && <div className="organization-link-confirm" role="alertdialog" aria-label={intent === "replace" ? "Replace sign-up link?" : "Revoke sign-up link?"}><strong>{intent === "replace" ? "Replace the active sign-up link?" : "Revoke the active sign-up link?"}</strong><p>The old link will stop accepting new requests. Verified requests remain available for review. People who have not verified their email will need the new link.</p><div className="organization-access-actions"><button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => setIntent(null)}>Cancel</button><button type="button" className={`btn btn-sm ${intent === "revoke" ? "btn-danger" : "btn-primary"}`} disabled={pending} onClick={() => void perform(intent === "revoke" ? "revoke" : "create")}>{pending ? "Saving…" : intent === "revoke" ? "Confirm revoke" : "Replace link"}</button></div></div>}
    </>}
    {operationError != null && <div className="auth-error" role="alert">{errorMessage(operationError, "Could not update the sign-up link. Please try again.")}</div>}
  </section>;
}

function JoinRequestsPanel({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"pending" | "all">("pending");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<OrganizationJoinRequest | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const requests = useQuery({
    queryKey: ["organization-join-requests", organizationId, status, page],
    queryFn: () => organizationJoinApi.requests({ status, page }),
  });
  const count = requests.data?.count ?? 0;
  const pages = Math.max(1, Math.ceil(count / 20));
  const reviewed = (action: "approved" | "rejected", name: string) => {
    setSelected(null);
    setFeedback(action === "approved" ? `${name} has been approved and can sign in with their assigned role.` : `${name}’s request has been rejected. Workspace access was not granted.`);
    void queryClient.invalidateQueries({ queryKey: ["organization-join-requests", organizationId] });
    if (action === "approved") void queryClient.invalidateQueries({ queryKey: ["users"] });
  };
  return <section className="card organization-access-card" aria-labelledby="organization-requests-title">
    <div className="organization-access-heading"><div><h2 id="organization-requests-title">Requests to join</h2><p>Review verified colleagues before giving them workspace access.</p></div><label className="organization-request-filter"><span className="sr-only">Request status</span><select aria-label="Request status" value={status} onChange={(event) => { setStatus(event.target.value as "pending" | "all"); setPage(1); }}><option value="pending">Awaiting approval</option><option value="all">All requests</option></select></label></div>
    {feedback && <div className="organization-access-feedback" role="status">{feedback}</div>}
    {requests.isPending ? <p role="status">Loading requests…</p> : requests.isError ? <div className="auth-error" role="alert">Could not load join requests. <button className="link-btn" type="button" onClick={() => void requests.refetch()}>Try again</button></div> : !requests.data?.results.length ? <EmptyState icon="users" title={status === "pending" ? "No requests awaiting approval" : "No sign-up requests"} body="Requests appear here after people use your sign-up link and verify their email." /> : <>
      <ul className="organization-request-list">{requests.data.results.map((item) => <li key={item.id}><div className="organization-request-person"><strong>{item.name}</strong><span>{item.email}</span><small>Requested {fmtDateTime(item.createdAt)}</small></div><div className="organization-request-state"><span className={`organization-request-badge ${item.status}`}>{REQUEST_LABELS[item.status]}</span>{item.role && <small>{item.role}</small>}</div><div className="organization-request-action">{item.status === "pending" && item.emailVerifiedAt ? <button className="btn btn-secondary btn-sm" type="button" aria-label={`Review ${item.name}`} onClick={() => setSelected(item)}>Review request <Icon name="arrowRight" size={15} /></button> : null}</div></li>)}</ul>
      <div className="pagination"><span>{count} {count === 1 ? "request" : "requests"}</span><div className="organization-access-actions"><button className="btn btn-secondary btn-sm" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><span>Page {page} of {pages}</span><button className="btn btn-secondary btn-sm" type="button" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Next</button></div></div>
    </>}
    {selected && <RequestReview key={selected.id} request={selected} onClose={() => setSelected(null)} onReviewed={(action) => reviewed(action, selected.name)} />}
  </section>;
}

function RequestReview({ request, onClose, onReviewed }: { request: OrganizationJoinRequest; onClose: () => void; onReviewed: (action: "approved" | "rejected") => void }) {
  const [role, setRole] = useState<Role>("Operations");
  const [adminConfirmed, setAdminConfirmed] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const inFlight = useRef(false);
  const formId = useId();
  const mutation = useMutation({
    mutationFn: async (action: "approved" | "rejected") => action === "approved" ? organizationJoinApi.approve(request.id, role) : organizationJoinApi.reject(request.id),
    onSuccess: (_, action) => onReviewed(action),
  });
  const perform = async (action: "approved" | "rejected") => {
    if (inFlight.current || (action === "approved" && role === "Admin" && !adminConfirmed)) return;
    inFlight.current = true;
    try { await mutation.mutateAsync(action); } catch { /* Preserve the review form and show the error. */ }
    finally { inFlight.current = false; }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (event.currentTarget.reportValidity()) void perform("approved"); };
  return <Drawer title="Review join request" sub={request.email} onClose={onClose} guard={() => inFlight.current} footer={<div className="organization-review-footer"><button className="btn btn-secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Cancel</button>{!rejecting && <button className="btn btn-primary" type="submit" form={formId} disabled={mutation.isPending || (role === "Admin" && !adminConfirmed)}>{mutation.isPending ? "Approving…" : "Approve access"}</button>}</div>}>
    <form id={formId} onSubmit={submit} aria-busy={mutation.isPending}>
      <div className="organization-review-person"><strong>{request.name}</strong><span>Email verified {request.emailVerifiedAt ? fmtDateTime(request.emailVerifiedAt) : "—"}</span></div>
      {mutation.isError && <div className="auth-error" role="alert">{errorMessage(mutation.error, "Could not review this request. Please try again.")}</div>}
      {!rejecting ? <><Field label="Role" required hint={ROLE_HELP[role]}><select value={role} disabled={mutation.isPending} onChange={(event) => { setRole(event.target.value as Role); setAdminConfirmed(false); }}>{ROLES.map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>{role === "Admin" && <label className="organization-admin-confirm"><input type="checkbox" checked={adminConfirmed} disabled={mutation.isPending} onChange={(event) => setAdminConfirmed(event.target.checked)} /><span>I confirm this person should have full Admin access, including managing other users.</span></label>}<p className="organization-access-hint">Approval gives this person access to your organization with the selected role.</p><button className="link-btn danger" type="button" disabled={mutation.isPending} onClick={() => setRejecting(true)}>Reject request</button></> : <div className="organization-reject-confirm"><h3>Reject this request?</h3><p>{request.name} will not receive access to your organization.</p><div className="organization-access-actions"><button className="btn btn-secondary" type="button" disabled={mutation.isPending} onClick={() => setRejecting(false)}>Go back</button><button className="btn btn-danger" type="button" disabled={mutation.isPending} onClick={() => void perform("rejected")}>{mutation.isPending ? "Rejecting…" : "Confirm rejection"}</button></div></div>}
    </form>
  </Drawer>;
}
