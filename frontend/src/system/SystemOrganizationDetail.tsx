import { useDeferredValue, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { DataTable, Drawer, EmptyState, Field, StatusBadge, type Column } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { fmtDate, fmtDateTime } from "../lib/format";
import { Link, useParams } from "../lib/navigation";
import type { Invitation, PlatformOrganization, User } from "../types";
import { getPlatformEnvironment } from "./environment";
import {
  DefinitionList,
  OrganizationLifecycleBadge,
  SystemAuditTable,
  SystemError,
  SystemMutationError,
  SystemPagination,
} from "./SystemComponents";
import { useIdempotencyKey } from "./useIdempotencyKey";

type DetailTab = "overview" | "access" | "audit";
type LifecycleAction = "approve" | "suspend" | "reactivate";
const PAGE_SIZE = 20;

const LIFECYCLE_ACTION_LABEL: Record<LifecycleAction, string> = {
  approve: "Approve organization",
  suspend: "Suspend organization",
  reactivate: "Reactivate organization",
};

export function SystemOrganizationDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const { can, platformAccess } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DetailTab>("overview");
  const [lifecycleAction, setLifecycleAction] = useState<LifecycleAction | null>(null);
  const environment = getPlatformEnvironment(platformAccess?.environment);
  const mutationsEnabled = platformAccess?.mutationsEnabled === true && environment.kind !== "unknown";
  const emailDeliveryReady = platformAccess?.emailDeliveryReady === true;
  const lifecycleIdempotency = useIdempotencyKey();
  const detail = useQuery({
    queryKey: ["system-organization", id],
    queryFn: () => api.systemOrganization(id),
    enabled: Boolean(id),
  });
  const lifecycleMutation = useMutation({
    mutationFn: ({ action, reason }: { action: LifecycleAction; reason: string }) => {
      const organization = detail.data?.organization;
      if (!organization) throw new Error("Organization details are not available.");
      const payload = { action, reason, revision: organization.revision };
      const key = lifecycleIdempotency.keyFor(payload);
      if (action === "approve") {
        return api.approveSystemOrganization(id, reason, organization.revision, key);
      }
      if (action === "suspend") {
        return api.suspendSystemOrganization(id, reason, organization.revision, key);
      }
      return api.reactivateSystemOrganization(id, reason, organization.revision, key);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(["system-organization", id], { organization: result.organization });
      void queryClient.invalidateQueries({ queryKey: ["system-organizations"] });
      void queryClient.invalidateQueries({ queryKey: ["system-overview"] });
      void queryClient.invalidateQueries({ queryKey: ["system-organization-audit", id] });
      lifecycleIdempotency.reset();
      setLifecycleAction(null);
    },
  });

  if (detail.isPending) {
    return <div className="vc-center" role="status"><div className="vc-spinner" />Loading organization…</div>;
  }
  if (detail.isError || !detail.data) {
    return <div className="content-inner"><SystemError error={detail.error} fallback="Could not load this organization." onRetry={() => void detail.refetch()} /></div>;
  }

  const organization = detail.data.organization;
  const availableLifecycleAction: LifecycleAction = organization.status === "pending_approval"
    ? "approve"
    : organization.status === "active"
      ? "suspend"
      : "reactivate";
  const approvalPrerequisitesMet = organization.registered && organization.adminCount > 0;
  const lifecycleDisabled = !mutationsEnabled
    || (availableLifecycleAction === "approve" && !approvalPrerequisitesMet);
  const lifecycleDisabledReason = !mutationsEnabled
    ? "Platform changes are locked in this environment"
    : availableLifecycleAction === "approve" && !organization.registered
      ? "Registration and email verification must be complete before approval"
      : availableLifecycleAction === "approve" && organization.adminCount === 0
        ? "At least one verified active tenant Admin is required before approval"
        : undefined;
  const tabs: Array<[DetailTab, string]> = [
    ["overview", "Overview"],
    ...(can("platform.organization_users.view") ? [["access", "Access"] as [DetailTab, string]] : []),
    ...(can("platform.audit.view") ? [["audit", "Audit"] as [DetailTab, string]] : []),
  ];

  return (
    <div className="content-inner">
      <Link className="system-back-link" to="/system/organizations"><Icon name="chevronLeft" size={15} /> All organizations</Link>
      <div className="page-head system-detail-head">
        <div>
          <div className="flex items-center gap-3 system-title-line">
            <h1>{organization.name}</h1>
            <OrganizationLifecycleBadge status={organization.status} />
          </div>
          <p className="desc mono-ref">{organization.id}</p>
        </div>
        {can("platform.organizations.manage") && (
          <button
            className={availableLifecycleAction === "suspend" ? "btn btn-danger" : "btn btn-primary"}
            type="button"
            disabled={lifecycleDisabled}
            title={lifecycleDisabledReason}
            onClick={() => setLifecycleAction(availableLifecycleAction)}
          >
            {LIFECYCLE_ACTION_LABEL[availableLifecycleAction]}
          </button>
        )}
      </div>

      {organization.status === "pending_approval" && (
        <div className="system-lifecycle-banner warning" role="status">
          <Icon name="alert" size={18} />
          <div>
            <strong>Workspace approval is pending.</strong>
            <span>
              {!organization.registered
                ? "Registration and email verification must be completed before approval."
                : organization.adminCount === 0
                  ? "At least one verified active tenant Admin is required before approval."
                  : "Review the organization profile and tenant Admin access before approving."}
              {" "}Workspace access remains blocked until approval.
            </span>
          </div>
        </div>
      )}

      {organization.status === "suspended" && (
        <div className="system-lifecycle-banner" role="status">
          <Icon name="alert" size={18} />
          <div>
            <strong>Workspace access is suspended.</strong>
            <span>{organization.suspensionReason || "No suspension reason was recorded."}{organization.suspendedAt ? ` · ${fmtDateTime(organization.suspendedAt)}` : ""}</span>
          </div>
        </div>
      )}

      <div className="settings-tabs" role="tablist" aria-label="Organization sections">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "on" : ""} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === "overview" && (
        <OrganizationOverview
          organization={organization}
          canEdit={can("platform.organizations.manage")}
          mutationsEnabled={mutationsEnabled}
        />
      )}
      {tab === "access" && (
        <OrganizationAccess
          organization={organization}
          canManage={can("platform.organization_users.manage")}
          mutationsEnabled={mutationsEnabled}
          emailDeliveryReady={emailDeliveryReady}
        />
      )}
      {tab === "audit" && <OrganizationAudit organizationId={id} />}
      {lifecycleAction && (
        <LifecycleDialog
          organization={organization}
          action={lifecycleAction}
          enabled={mutationsEnabled}
          pending={lifecycleMutation.isPending}
          error={lifecycleMutation.error}
          onClose={() => { if (!lifecycleMutation.isPending) { lifecycleMutation.reset(); lifecycleIdempotency.reset(); setLifecycleAction(null); } }}
          onConfirm={(reason) => lifecycleMutation.mutate({ action: lifecycleAction, reason })}
        />
      )}
    </div>
  );
}

function OrganizationOverview({
  organization,
  canEdit,
  mutationsEnabled,
}: {
  organization: PlatformOrganization;
  canEdit: boolean;
  mutationsEnabled: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const idempotency = useIdempotencyKey();
  const [form, setForm] = useState(() => ({
    name: organization.name,
    rcNumber: organization.rcNumber,
    email: organization.email,
    phone: organization.phone,
    address: organization.address,
    primaryPort: organization.primaryPort,
    ports: organization.ports.join("\n"),
  }));
  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name.trim(),
        rcNumber: form.rcNumber.trim(),
        email: form.email.trim().toLowerCase(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        primaryPort: form.primaryPort.trim(),
        ports: Array.from(new Set(form.ports.split(/\n|,/).map((port) => port.trim()).filter(Boolean))),
        revision: organization.revision,
      };
      return api.updateSystemOrganization(organization.id, payload, idempotency.keyFor(payload));
    },
    onSuccess: (result) => {
      idempotency.reset();
      queryClient.setQueryData(["system-organization", organization.id], { organization: result.organization });
      void queryClient.invalidateQueries({ queryKey: ["system-organizations"] });
      setEditing(false);
    },
  });
  useEffect(() => {
    if (editing) return;
    setForm({
      name: organization.name,
      rcNumber: organization.rcNumber,
      email: organization.email,
      phone: organization.phone,
      address: organization.address,
      primaryPort: organization.primaryPort,
      ports: organization.ports.join("\n"),
    });
  }, [editing, organization]);

  const conflict = mutation.error instanceof ApiError && mutation.error.status === 409;
  if (editing) {
    return (
      <section className="card card-pad system-profile-card" aria-labelledby="organization-profile-title">
        <div className="card-head system-card-head-inline">
          <div className="card-title" id="organization-profile-title">Edit organization profile</div>
        </div>
        {mutation.isError && (
          conflict
            ? <div className="auth-error" role="alert">This organization changed after you opened it. Your edits are preserved; reload before trying again.</div>
            : <SystemMutationError error={mutation.error} fallback="Could not save the organization." />
        )}
        <Field label="Organization name" required><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
        <div className="field-row">
          <Field label="RC number"><input value={form.rcNumber} onChange={(event) => setForm({ ...form, rcNumber: event.target.value })} /></Field>
          <Field label="Phone"><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></Field>
        </div>
        <Field label="Contact email"><input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
        <Field label="Address"><textarea value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></Field>
        <Field label="Primary port" required><input value={form.primaryPort} onChange={(event) => setForm({ ...form, primaryPort: event.target.value })} /></Field>
        <Field label="Operating ports" hint="One port per line."><textarea value={form.ports} onChange={(event) => setForm({ ...form, ports: event.target.value })} /></Field>
        <div className="flex gap-3 system-form-actions">
          <button className="btn btn-secondary" type="button" disabled={mutation.isPending} onClick={() => { mutation.reset(); idempotency.reset(); setEditing(false); }}>Cancel</button>
          {conflict && <button className="btn btn-secondary" type="button" onClick={() => void queryClient.invalidateQueries({ queryKey: ["system-organization", organization.id] })}>Reload server version</button>}
          <button className="btn btn-primary" type="button" disabled={!mutationsEnabled || mutation.isPending || !form.name.trim() || !form.primaryPort.trim()} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Saving…" : "Save profile"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="system-detail-grid">
      <section className="card card-pad" aria-labelledby="organization-profile-title">
        <div className="card-head system-card-head-inline">
          <div className="card-title" id="organization-profile-title">Organization profile</div>
          {canEdit && (
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              disabled={!mutationsEnabled}
              title={!mutationsEnabled ? "Platform changes are locked in this environment" : undefined}
              onClick={() => setEditing(true)}
            >
              <Icon name="edit" size={15} /> Edit
            </button>
          )}
        </div>
        <DefinitionList items={[
          { label: "RC number", value: organization.rcNumber },
          { label: "Contact email", value: organization.email },
          { label: "Phone", value: organization.phone },
          { label: "Address", value: organization.address },
          { label: "Primary port", value: organization.primaryPort },
          { label: "Operating ports", value: organization.ports.join(", ") },
          { label: "Registered", value: organization.registered ? "Yes" : "Setup pending" },
          {
            label: "Approval",
            value: organization.status === "pending_approval"
              ? "Pending platform approval"
              : organization.approvedAt
                ? `Approved ${fmtDateTime(organization.approvedAt)}`
                : organization.status === "active"
                  ? "Active · approval predates tracking"
                  : "Approval predates tracking",
          },
          { label: "Approved by", value: organization.approvedBy?.name || "Not recorded" },
          { label: "Approval reason", value: organization.approvalReason || "Not recorded" },
        ]} />
      </section>
      <section className="card card-pad" aria-labelledby="organization-access-summary-title">
        <div className="card-title" id="organization-access-summary-title">Access summary</div>
        <DefinitionList items={[
          { label: "Active users", value: organization.activeUserCount },
          { label: "Verified active Admins", value: organization.adminCount },
          { label: "Pending invitations", value: organization.pendingInvitationCount },
          { label: "Created", value: fmtDate(organization.createdAt) },
          { label: "Last updated", value: fmtDateTime(organization.updatedAt) },
        ]} />
      </section>
    </div>
  );
}

function OrganizationAccess({
  organization,
  canManage,
  mutationsEnabled,
  emailDeliveryReady,
}: {
  organization: PlatformOrganization;
  canManage: boolean;
  mutationsEnabled: boolean;
  emailDeliveryReady: boolean;
}) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [recovery, setRecovery] = useState<{ action: "password" | "mfa"; user: User } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const recoveryIdempotency = useIdempotencyKey();
  const organizationActive = organization.status === "active";
  const accessMutationsEnabled = mutationsEnabled && organizationActive;
  const accessDisabledReason = !mutationsEnabled
    ? "Platform changes are locked in this environment"
    : organization.status === "pending_approval"
      ? "Approve the organization before managing tenant access"
      : "Reactivate the organization before managing tenant access";
  const users = useQuery({
    queryKey: ["system-organization-users", organization.id, { page, search: deferredSearch }],
    queryFn: () => api.systemOrganizationUsers(organization.id, { page, pageSize: PAGE_SIZE, search: deferredSearch }),
    placeholderData: (previous) => previous,
  });
  const invitations = useQuery({
    queryKey: ["system-organization-invitations", organization.id],
    queryFn: () => api.systemOrganizationInvitations(organization.id, { pageSize: 20 }),
  });
  const recoveryMutation = useMutation({
    mutationFn: async ({ action, user, reason }: { action: "password" | "mfa"; user: User; reason: string }) => {
      if (action === "password") {
        const result = await api.sendSystemAdminPasswordReset(
          organization.id,
          user.id,
          reason,
          recoveryIdempotency.keyFor({ action, userId: user.id, reason }),
        );
        return result.detail;
      }
      await api.resetSystemAdminMfa(
        organization.id,
        user.id,
        reason,
        recoveryIdempotency.keyFor({ action, userId: user.id, reason }),
      );
      return `MFA reset for ${user.name}.`;
    },
    onSuccess: (detail) => {
      recoveryIdempotency.reset();
      setNotice(detail);
      setRecovery(null);
      void queryClient.invalidateQueries({ queryKey: ["system-organization-users", organization.id] });
      void queryClient.invalidateQueries({ queryKey: ["system-organization-audit", organization.id] });
    },
  });
  const userColumns: Column<User>[] = [
    { key: "name", label: "User", sortable: true, render: (user) => <div><div className="cell-primary">{user.name}</div><div className="cell-sub">{user.email}</div></div> },
    { key: "role", label: "Tenant role", sortable: true, render: (user) => <span className="role-badge">{user.role}</span> },
    { key: "status", label: "Status", sortable: true, render: (user) => <StatusBadge status={user.status} /> },
    { key: "emailVerified", label: "Email", render: (user) => <span className="muted">{user.emailVerified ? "Verified" : "Not verified"}</span> },
    { key: "mfaEnabled", label: "MFA", render: (user) => <span className="muted">{user.mfaEnabled ? "Enabled" : user.mfaEnrollmentRequired ? "Required" : "Not enabled"}</span> },
    { key: "lastLogin", label: "Last sign-in", sortable: true, render: (user) => <span className="tnum muted">{user.lastLogin ? fmtDateTime(user.lastLogin) : "Never"}</span> },
    {
      key: "actions",
      label: "",
      num: true,
      render: (user) => user.role === "Admin" && user.status === "active" && canManage ? (
        <div className="cell-actions" onClick={(event) => event.stopPropagation()}>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            disabled={!accessMutationsEnabled || !emailDeliveryReady}
            title={!emailDeliveryReady
              ? "Email delivery is unavailable"
              : !accessMutationsEnabled
                ? accessDisabledReason
                : undefined}
            onClick={() => { recoveryMutation.reset(); setRecovery({ action: "password", user }); }}
          >
            Send password reset
          </button>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            disabled={!accessMutationsEnabled}
            title={!accessMutationsEnabled ? accessDisabledReason : undefined}
            onClick={() => { recoveryMutation.reset(); setRecovery({ action: "mfa", user }); }}
          >
            Reset MFA
          </button>
        </div>
      ) : <span className="muted">Read only</span>,
    },
  ];

  return (
    <div>
      {organization.adminCount === 0 && (
        <div className="system-lifecycle-banner warning" role="alert">
          <Icon name="alert" size={18} />
          <div>
            <strong>No verified active tenant Admin</strong>
            <span>
              {organization.status === "pending_approval"
                ? "The tenant Admin must complete email verification and account activation before this organization can be approved."
                : "Invite an Admin or have an existing Admin complete email verification so the organization can manage its own users and settings."}
            </span>
          </div>
        </div>
      )}
      {notice && <div className="user-access-note" role="status"><Icon name="check" size={16} />{notice}</div>}
      <div className="filter-bar">
        <label className="search-input">
          <span className="hide-sr">Search organization users</span>
          <Icon name="search" size={17} />
          <input type="search" value={search} placeholder="Search users…" onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
        </label>
        {canManage && (
          <button
            className="btn btn-primary filter-action"
            type="button"
            disabled={!accessMutationsEnabled || !emailDeliveryReady}
            title={!emailDeliveryReady
              ? "Email delivery is unavailable"
              : !accessMutationsEnabled
                ? accessDisabledReason
                : undefined}
            onClick={() => setInviteOpen(true)}
          >
            <Icon name="mail" size={16} /> Invite tenant Admin
          </button>
        )}
      </div>
      {users.isError && <SystemError error={users.error} fallback="Could not load organization users." onRetry={() => void users.refetch()} />}
      <div className="card management-table">
        <DataTable columns={userColumns} rows={users.data?.results ?? []} getKey={(user) => user.id} loading={users.isPending} emptyState={<EmptyState icon="users" title="No users found" body="Change the search or invite the organization's first Admin." />} />
      </div>
      <SystemPagination page={page} count={users.data?.count ?? 0} pageSize={PAGE_SIZE} onPage={setPage} />
      <InvitationSummary
        organizationId={organization.id}
        invitations={invitations.data?.results ?? []}
        loading={invitations.isPending}
        error={invitations.error}
        canManage={canManage}
        mutationsEnabled={mutationsEnabled}
        organizationActive={organizationActive}
        accessDisabledReason={accessDisabledReason}
        emailDeliveryReady={emailDeliveryReady}
        onChanged={() => {
          void queryClient.invalidateQueries({ queryKey: ["system-organization-invitations", organization.id] });
          void queryClient.invalidateQueries({ queryKey: ["system-organization", organization.id] });
          void queryClient.invalidateQueries({ queryKey: ["system-organization-audit", organization.id] });
        }}
      />
      {inviteOpen && <AdminInvitationDrawer enabled={accessMutationsEnabled && emailDeliveryReady} organization={organization} onClose={() => setInviteOpen(false)} onInvited={() => {
        void queryClient.invalidateQueries({ queryKey: ["system-organization-invitations", organization.id] });
        void queryClient.invalidateQueries({ queryKey: ["system-organization", organization.id] });
      }} />}
      {recovery && (
        <AdminRecoveryDialog
          recovery={recovery}
          enabled={accessMutationsEnabled && (recovery.action === "mfa" || emailDeliveryReady)}
          pending={recoveryMutation.isPending}
          error={recoveryMutation.error}
          onClose={() => { if (!recoveryMutation.isPending) { recoveryMutation.reset(); recoveryIdempotency.reset(); setRecovery(null); } }}
          onConfirm={(reason) => recoveryMutation.mutate({ ...recovery, reason })}
        />
      )}
    </div>
  );
}

function InvitationSummary({
  organizationId,
  invitations,
  loading,
  error,
  canManage,
  mutationsEnabled,
  organizationActive,
  accessDisabledReason,
  emailDeliveryReady,
  onChanged,
}: {
  organizationId: string;
  invitations: Invitation[];
  loading: boolean;
  error: unknown;
  canManage: boolean;
  mutationsEnabled: boolean;
  organizationActive: boolean;
  accessDisabledReason: string;
  emailDeliveryReady: boolean;
  onChanged: () => void;
}) {
  const [revoke, setRevoke] = useState<Invitation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const resendIdempotency = useIdempotencyKey();
  const revokeIdempotency = useIdempotencyKey();
  const resendMutation = useMutation({
    mutationFn: (invitation: Invitation) => api.resendSystemOrganizationInvitation(
      organizationId,
      invitation.id,
      resendIdempotency.keyFor({ action: "resend", invitationId: invitation.id }),
    ),
    onSuccess: (result) => {
      resendIdempotency.reset();
      setNotice(`A new 24-hour invitation was sent to ${result.invitation.email}.`);
      onChanged();
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (invitation: Invitation) => api.revokeSystemOrganizationInvitation(
      organizationId,
      invitation.id,
      revokeIdempotency.keyFor({ action: "revoke", invitationId: invitation.id }),
    ),
    onSuccess: (result) => {
      revokeIdempotency.reset();
      setNotice(`Invitation for ${result.invitation.email} was revoked.`);
      setRevoke(null);
      onChanged();
    },
  });
  return (
    <>
      <section className="card card-pad section-gap" aria-labelledby="pending-admin-invitations-title">
        <div className="card-title" id="pending-admin-invitations-title">Administrator invitations</div>
        {notice && <div className="user-access-note" role="status"><Icon name="check" size={16} />{notice}</div>}
        {(error || resendMutation.isError || revokeMutation.isError) && <SystemMutationError error={error || resendMutation.error || revokeMutation.error} fallback="Could not update invitations." />}
        {loading ? <div className="sk system-inline-skeleton" aria-label="Loading invitations" /> : invitations.length ? (
          <ul className="system-invitation-list">
            {invitations.map((invitation) => (
              <li key={invitation.id}>
                <div><strong>{invitation.name}</strong><span>{invitation.email}</span></div>
                <div className="system-invitation-actions">
                  <StatusBadge status={invitation.status} /><small>Expires {fmtDate(invitation.expiresAt)}</small>
                  {canManage && invitation.status === "pending" && (
                    <>
                      <button
                        className="btn btn-secondary btn-sm"
                        type="button"
                        disabled={!mutationsEnabled || !organizationActive || !emailDeliveryReady || resendMutation.isPending || revokeMutation.isPending}
                        title={!emailDeliveryReady
                          ? "Email delivery is unavailable"
                          : !mutationsEnabled || !organizationActive
                            ? accessDisabledReason
                            : undefined}
                        onClick={() => resendMutation.mutate(invitation)}
                      >
                        {resendMutation.isPending && resendMutation.variables?.id === invitation.id ? "Sending…" : "Resend"}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        type="button"
                        disabled={!mutationsEnabled || resendMutation.isPending || revokeMutation.isPending}
                        title={!mutationsEnabled ? "Platform changes are locked in this environment" : undefined}
                        onClick={() => { revokeMutation.reset(); setRevoke(invitation); }}
                      >
                        Revoke
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="muted system-form-copy">No Admin invitations have been issued.</p>}
      </section>
      {revoke && (
        <InvitationRevokeDialog
          invitation={revoke}
          enabled={mutationsEnabled}
          pending={revokeMutation.isPending}
          error={revokeMutation.error}
          onClose={() => { if (!revokeMutation.isPending) { revokeMutation.reset(); revokeIdempotency.reset(); setRevoke(null); } }}
          onConfirm={() => revokeMutation.mutate(revoke)}
        />
      )}
    </>
  );
}

function AdminInvitationDrawer({ enabled, organization, onClose, onInvited }: { enabled: boolean; organization: PlatformOrganization; onClose: () => void; onInvited: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const idempotency = useIdempotencyKey();
  const mutation = useMutation({
    mutationFn: () => {
      const payload = { name: name.trim(), email: email.trim().toLowerCase() };
      return api.inviteSystemOrganizationAdmin(organization.id, payload, idempotency.keyFor(payload));
    },
    onSuccess: () => { idempotency.reset(); onInvited(); onClose(); },
  });
  return (
    <Drawer
      title="Invite tenant Admin"
      sub={`Send a time-limited, single-use setup link for ${organization.name}.`}
      onClose={onClose}
      guard={() => mutation.isPending}
      footer={<><button className="btn btn-secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Cancel</button><button className="btn btn-primary" type="button" disabled={!enabled || mutation.isPending || !name.trim() || !email.trim()} title={!enabled ? "Platform changes are locked in this environment" : undefined} onClick={() => mutation.mutate()}>{mutation.isPending ? "Sending…" : "Send Admin invitation"}</button></>}
    >
      {mutation.isError && <SystemMutationError error={mutation.error} fallback="Could not send the Admin invitation." />}
      <p className="muted system-form-copy">The invitation role is fixed to Admin. The recipient chooses their own password; you cannot view or replace it.</p>
      <Field label="Full name" required><input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></Field>
      <Field label="Email" required><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></Field>
    </Drawer>
  );
}

function OrganizationAudit({ organizationId }: { organizationId: string }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const audit = useQuery({
    queryKey: ["system-organization-audit", organizationId, { page, search: deferredSearch }],
    queryFn: () => api.systemOrganizationAudit(organizationId, { page, pageSize: PAGE_SIZE, search: deferredSearch }),
    placeholderData: (previous) => previous,
  });
  return (
    <div>
      <div className="filter-bar">
        <label className="search-input"><span className="hide-sr">Search organization audit</span><Icon name="search" size={17} /><input type="search" value={search} placeholder="Search audit events…" onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></label>
      </div>
      {audit.isError && <SystemError error={audit.error} fallback="Could not load organization audit." onRetry={() => void audit.refetch()} />}
      <SystemAuditTable rows={audit.data?.results ?? []} loading={audit.isPending} />
      <SystemPagination page={page} count={audit.data?.count ?? 0} pageSize={PAGE_SIZE} onPage={setPage} />
    </div>
  );
}

function AdminRecoveryDialog({
  recovery,
  enabled,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  recovery: { action: "password" | "mfa"; user: User };
  enabled: boolean;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const password = recovery.action === "password";
  return (
    <>
      <div className="scrim" />
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="admin-recovery-title" aria-describedby="admin-recovery-description">
        <div className="modal-pad">
          <h3 id="admin-recovery-title">{password ? "Send password reset" : "Reset MFA"} for {recovery.user.name}?</h3>
          <p id="admin-recovery-description">{password ? "A short-lived password-reset link will be emailed. You cannot see or choose the password." : "The Admin's authenticator and active sessions will be revoked. They must enroll again."}</p>
          {Boolean(error) && <SystemMutationError error={error} fallback="Could not complete the recovery action." />}
          <Field label="Support reason" required hint="Recorded in both platform and tenant audit history.">
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} autoFocus />
          </Field>
          <div className="modal-foot">
            <button className="btn btn-secondary" type="button" disabled={pending} onClick={onClose}>Cancel</button>
            <button className={password ? "btn btn-primary" : "btn btn-danger"} type="button" disabled={!enabled || pending || reason.trim().length < 3} title={!enabled ? "Platform changes are locked in this environment" : undefined} onClick={() => onConfirm(reason.trim())}>
              {pending ? "Working…" : password ? "Send password reset" : "Reset MFA and sessions"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function InvitationRevokeDialog({
  invitation,
  enabled,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  invitation: Invitation;
  enabled: boolean;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <div className="scrim" />
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="revoke-invitation-title" aria-describedby="revoke-invitation-description">
        <div className="modal-pad">
          <h3 id="revoke-invitation-title">Revoke invitation for {invitation.email}?</h3>
          <p id="revoke-invitation-description">The existing single-use setup link will stop working immediately.</p>
          {Boolean(error) && <SystemMutationError error={error} fallback="Could not revoke the invitation." />}
          <div className="modal-foot">
            <button className="btn btn-secondary" type="button" disabled={pending} onClick={onClose}>Cancel</button>
            <button className="btn btn-danger" type="button" disabled={!enabled || pending} title={!enabled ? "Platform changes are locked in this environment" : undefined} onClick={onConfirm}>{pending ? "Revoking…" : "Revoke invitation"}</button>
          </div>
        </div>
      </div>
    </>
  );
}

function LifecycleDialog({
  organization,
  action,
  enabled,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  organization: PlatformOrganization;
  action: LifecycleAction;
  enabled: boolean;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const copy: Record<LifecycleAction, {
    verb: string;
    pending: string;
    description: string;
    reasonLabel: string;
    danger: boolean;
  }> = {
    approve: {
      verb: "Approve",
      pending: "Approving",
      description: "Workspace access will be enabled. Confirm the organization profile and tenant Admin access before approval.",
      reasonLabel: "Approval reason",
      danger: false,
    },
    suspend: {
      verb: "Suspend",
      pending: "Suspending",
      description: "All tenant sessions will be revoked and workspace access will stop. Records and audit history remain intact.",
      reasonLabel: "Suspension reason",
      danger: true,
    },
    reactivate: {
      verb: "Reactivate",
      pending: "Reactivating",
      description: "Workspace access will resume. Individual user statuses are not changed.",
      reasonLabel: "Reactivation reason",
      danger: false,
    },
  };
  const actionCopy = copy[action];
  return (
    <>
      <div className="scrim" />
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="lifecycle-dialog-title" aria-describedby="lifecycle-dialog-description">
        <div className="modal-pad">
          <h3 id="lifecycle-dialog-title">{actionCopy.verb} {organization.name}?</h3>
          <p id="lifecycle-dialog-description">{actionCopy.description}</p>
          {Boolean(error) && <SystemMutationError error={error} fallback={`Could not ${action} the organization.`} />}
          <Field label={actionCopy.reasonLabel} required hint="This reason is recorded in the immutable platform audit.">
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} autoFocus />
          </Field>
          <div className="modal-foot">
            <button className="btn btn-secondary" type="button" disabled={pending} onClick={onClose}>Cancel</button>
            <button className={actionCopy.danger ? "btn btn-danger" : "btn btn-primary"} type="button" disabled={!enabled || pending || reason.trim().length < 3} title={!enabled ? "Platform changes are locked in this environment" : undefined} onClick={() => onConfirm(reason.trim())}>
              {pending ? `${actionCopy.pending}…` : `${actionCopy.verb} organization`}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
