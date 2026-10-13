import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import {
  ConfirmModal,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  StatusBadge,
  type Column,
} from "../components/ui";
import { ApiError, api, type TemporaryPasswordUserResult } from "../lib/api";
import { fmtDate, fmtDateTime, userInitials } from "../lib/format";
import {
  ROLES,
  type AuditEvent,
  type Invitation,
  type Paginated,
  type Role,
  type RoleDefinition,
  type User,
  type UserStatus,
} from "../types";

import { OrganizationAccess } from "./OrganizationAccess";

type ManagementTab = "users" | "invitations" | "signup" | "audit";
type UserAction = "activate" | "suspend" | "remove";

const ROLE_HELP: Record<Role, string> = {
  Admin: "Manage users and settings, approve NPA reconciliation, and manage operational and financial records.",
  Operations: "Manage vessel calls, measurement plans, agency readings, and inspections.",
  Finance: "Manage invoices, bill extra load, and record payments.",
  Viewer: "View vessel calls, readings, reports, and invoices without making changes.",
};

const PERMISSION_LABELS: Record<string, string> = {
  "organization.view": "View organization profile",
  "organization.manage": "Manage organization profile",
  "users.view": "View users and role access",
  "users.manage": "Invite, edit, suspend, and remove users",
  "audit.view": "View audit history",
  "audit.export": "Export audit history",
  "calls.view": "View vessel calls",
  "calls.manage": "Create, edit, and cancel vessel calls",
  "measurements.view": "View measurements and readings",
  "measurements.manage": "Plan measurements and record agency readings",
  "measurements.approve": "Approve NPA reconciliation",
  "measurements.bill": "Bill additional load",
  "inspections.view": "View inspections",
  "inspections.manage": "Create, edit, and finalize inspections",
  "invoices.view": "View invoices",
  "invoices.manage": "Create and progress invoices",
  "invoices.pay": "Record and reverse payments",
  "settings.view": "View organization settings",
  "settings.manage": "Manage settings and invoice workflow",
  "analytics.view": "View analytics",
  "documents.view": "Open invoices and reports",
  "evidence.manage": "Upload and manage inspection evidence",
};

function RoleAccessMatrix() {
  const definitions = useQuery({
    queryKey: ["role-definitions"],
    queryFn: api.roleDefinitions,
    staleTime: 5 * 60_000,
  });

  if (definitions.isPending) {
    return <div className="card role-access-card" aria-busy="true">Loading role access…</div>;
  }
  if (definitions.isError || !definitions.data) {
    return <div className="auth-error role-access-card" role="alert">Could not load the role access matrix.</div>;
  }

  const byRole = new Map(definitions.data.roles.map((definition) => [definition.role, definition]));
  const capabilities = Object.keys(PERMISSION_LABELS);
  return (
    <section className="card role-access-card" aria-labelledby="role-access-title">
      <div className="role-access-heading">
        <div>
          <h2 id="role-access-title">Role access</h2>
          <p>Roles apply across this organization. Access is enforced by the API.</p>
        </div>
      </div>
      <div className="role-access-scroll">
        <table className="role-access-table">
          <thead>
            <tr>
              <th scope="col">Access</th>
              {ROLES.map((role) => <th scope="col" key={role}>{role}</th>)}
            </tr>
          </thead>
          <tbody>
            {capabilities.map((permission) => (
              <tr key={permission}>
                <th scope="row">{PERMISSION_LABELS[permission]}</th>
                {ROLES.map((role) => {
                  const definition: RoleDefinition | undefined = byRole.get(role);
                  const allowed = definition?.permissions.includes(permission) ?? false;
                  return <td key={role} aria-label={`${role} — ${PERMISSION_LABELS[permission]}: ${allowed ? "allowed" : "not allowed"}`}>{allowed ? "✓" : "—"}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const fieldError = error.errors?.email ?? error.errors?.name;
  return Array.isArray(fieldError) ? fieldError.join(" ") : fieldError || error.message;
}

function RoleBadge({ role }: { role: Role }) {
  return <span className={`role-badge role-${role.toLowerCase()}`}>{role}</span>;
}

function UserStatusBadge({ member }: { member: User }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!member.passwordChangeRequired || !member.temporaryPasswordExpiresAt) return;
    const remaining = Date.parse(member.temporaryPasswordExpiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(remaining + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [member.passwordChangeRequired, member.temporaryPasswordExpiresAt, now]);
  if (member.status === "active" && member.passwordChangeRequired) {
    const expired = Boolean(member.temporaryPasswordExpiresAt && Date.parse(member.temporaryPasswordExpiresAt) <= now);
    return <span className={`badge ${expired ? "expired" : "pending"}`}><span className="dot" />{expired ? "Temporary password expired" : "First sign-in pending"}</span>;
  }
  return <StatusBadge status={member.status} />;
}

function Pagination({
  page,
  count,
  pageSize,
  onPage,
}: {
  page: number;
  count: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(count / pageSize));
  return (
    <div className="pagination" aria-label="Pagination">
      <span>{count ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, count)} of ${count}` : "0 results"}</span>
      <div className="flex gap-3">
        <button className="btn btn-secondary btn-sm" type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span className="pagination-page">Page {page} of {pages}</span>
        <button className="btn btn-secondary btn-sm" type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

export function UserManagement() {
  const { can, org, user } = useAuth();
  const [tab, setTab] = useState<ManagementTab>("users");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [invitationCreated, setInvitationCreated] = useState(false);
  const [userCreated, setUserCreated] = useState(false);
  const activeTab = (tab === "audit" && !can("audit.view")) || (tab === "signup" && !can("users.manage")) ? "users" : tab;
  const tabs: Array<[ManagementTab, string]> = [
    ["users", "Users"],
    ["invitations", "Invitations"],
    ...(can("users.manage") ? [["signup", "Sign-up link"] as [ManagementTab, string]] : []),
    ...(can("audit.view") ? [["audit", "Activity"] as [ManagementTab, string]] : []),
  ];

  if (!can("users.view")) {
    return <div className="content-inner"><EmptyState icon="users" title="User management is unavailable" body="Your account does not have permission to view users." /></div>;
  }

  return (
    <div className="content-inner user-management-page">
      <div className="page-head">
        <div>
          <h1>User management</h1>
          <p className="desc">Add colleagues and manage their access to {org?.name || "your organization"}.</p>
        </div>
        {can("users.manage") && activeTab !== "audit" && (
          <button className="btn btn-primary" type="button" onClick={() => {
            setInvitationCreated(false);
            setUserCreated(false);
            setInviteOpen(true);
          }}>
            <Icon name="plus" size={17} /> Add user
          </button>
        )}
      </div>
      {userCreated && <div className="user-access-note user-management-feedback" role="status">
        <Icon name="check" size={17} /><div><strong>User created</strong><p>The user must replace their temporary password on first sign-in.</p></div>
      </div>}
      {invitationCreated && (
        <div className="user-access-note user-management-feedback" role="status">
          <Icon name="check" size={17} />
          <div><strong>Invitation created</strong><p>The recipient must accept their invitation before they can sign in.</p></div>
        </div>
      )}
      <div className="settings-tabs" role="tablist" aria-label="User management sections">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            id={`user-management-tab-${key}`}
            type="button"
            role="tab"
            aria-selected={activeTab === key}
            aria-controls="user-management-panel"
            tabIndex={activeTab === key ? 0 : -1}
            className={activeTab === key ? "on" : ""}
            onClick={() => setTab(key)}
            onKeyDown={(event) => {
              const index = tabs.findIndex(([value]) => value === key);
              const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
                : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
                  : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
              if (next === null) return;
              event.preventDefault();
              setTab(tabs[next][0]);
              event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#user-management-tab-${tabs[next][0]}`)?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {activeTab !== "audit" && (
        <div className="user-management-role-guide">
          <button className="link-btn" type="button" aria-expanded={showRoles} aria-controls="user-management-roles" onClick={() => setShowRoles((value) => !value)}>
            <Icon name={showRoles ? "chevronDown" : "chevronRight"} size={16} /> Compare role access
          </button>
          {showRoles && <div id="user-management-roles"><RoleAccessMatrix /></div>}
        </div>
      )}
      <section id="user-management-panel" role="tabpanel" aria-labelledby={`user-management-tab-${activeTab}`}>
        {activeTab === "users" && <UsersTab />}
        {activeTab === "invitations" && <InvitationsTab />}
        {activeTab === "signup" && <OrganizationAccess />}
        {activeTab === "audit" && <AuditTab />}
      </section>
      {can("users.manage") && inviteOpen && (
        <AddUserDrawer
          key={`${user?.id}:${org?.id}`}
          onUserCreated={() => { setTab("users"); setUserCreated(true); }}
          onClose={() => setInviteOpen(false)}
          onCreated={() => {
            setInviteOpen(false);
            setTab("invitations");
            setInvitationCreated(true);
          }}
          onReviewUsers={() => {
            setInviteOpen(false);
            setTab("users");
          }}
        />
      )}
    </div>
  );
}

function UsersTab() {
  const { user: currentUser, org, can } = useAuth();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [role, setRole] = useState<Role | "all">("all");
  const [status, setStatus] = useState<UserStatus | "all">("all");
  const [editor, setEditor] = useState<User | null>(null);
  const [confirm, setConfirm] = useState<{ action: UserAction; user: User } | null>(null);

  const params = { page, pageSize: 20, search: deferredQuery, role, status };
  const usersQuery = useQuery({
    queryKey: ["users", params],
    queryFn: () => api.users(params),
    placeholderData: (previous) => previous,
  });
  const mutation = useMutation({
    mutationFn: async ({ action, user }: { action: UserAction; user: User }) => {
      if (action === "remove") return api.removeUser(user.id);
      return api.updateUser(user.id, { status: action === "activate" ? "active" : "suspended" });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] }),
  });

  const rows = usersQuery.data?.results ?? [];
  const columns: Column<User>[] = [
    {
      key: "name",
      label: "User",
      sortable: true,
      render: (member) => (
        <div className="user-cell">
          <div className="avatar">{userInitials(member.name)}</div>
          <div>
            <div className="cell-primary">
              {member.name}
              {member.id === currentUser?.id && <span className="tag">You</span>}
            </div>
            <div className="cell-sub">{member.email}</div>
          </div>
        </div>
      ),
    },
    { key: "role", label: "Role", sortable: true, render: (member) => <RoleBadge role={member.role} /> },
    { key: "status", label: "Status", sortable: true, render: (member) => <UserStatusBadge member={member} /> },
    {
      key: "mfaEnabled",
      label: "MFA",
      sortable: true,
      sortVal: (member) => Number(member.mfaEnabled),
      render: (member) => <span className="muted">{member.mfaEnabled ? "Enabled" : member.mfaEnrollmentRequired ? "Required" : "Not enabled"}</span>,
    },
    {
      key: "lastLogin",
      label: "Last sign-in",
      sortable: true,
      render: (member) => <span className="tnum muted">{member.lastLogin ? fmtDateTime(member.lastLogin) : "Never"}</span>,
    },
    {
      key: "actions",
      label: "",
      num: true,
      render: (member) => (
        <div className="cell-actions" onClick={(event) => event.stopPropagation()}>
          <button
            className="icon-btn"
            type="button"
            onClick={() => setEditor(member)}
            aria-label={`${can("users.manage") ? "Edit" : "View"} ${member.name}`}
            title={can("users.manage") ? "Edit user" : "View user"}
          >
            <Icon name={can("users.manage") ? "edit" : "eye"} size={16} />
          </button>
          {member.status === "suspended" ? (
            <button
              className="icon-btn"
              type="button"
              disabled={!can("users.manage") || member.id === currentUser?.id}
              onClick={() => setConfirm({ action: "activate", user: member })}
              aria-label={`Reactivate ${member.name}`}
              title="Reactivate user"
            >
              <Icon name="check" size={16} />
            </button>
          ) : (
            <button
              className="icon-btn"
              type="button"
              disabled={!can("users.manage") || member.id === currentUser?.id || member.status === "removed"}
              onClick={() => setConfirm({ action: "suspend", user: member })}
              aria-label={`Suspend ${member.name}`}
              title="Suspend user"
            >
              <Icon name="x" size={16} />
            </button>
          )}
          <button
            className="icon-btn user-delete-button"
            type="button"
            disabled={!can("users.manage") || member.id === currentUser?.id || member.status === "removed"}
            onClick={() => setConfirm({ action: "remove", user: member })}
            aria-label={`Remove ${member.name}`}
            title="Remove user"
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      ),
    },
  ];

  const confirmCopy = confirm && {
    activate: {
      title: `Reactivate ${confirm.user.name}?`,
      body: "The user will be able to sign in again. Previously revoked sessions remain revoked.",
      label: "Reactivate user",
      danger: false,
    },
    suspend: {
      title: `Suspend ${confirm.user.name}?`,
      body: "Access and all active sessions will be revoked immediately. Audit and operational history are retained.",
      label: "Suspend user",
      danger: true,
    },
    remove: {
      title: `Remove ${confirm.user.name}?`,
      body: "The account will be soft-removed and cannot sign in. Audit and operational history are retained.",
      label: "Remove user",
      danger: true,
    },
  }[confirm.action];

  return (
    <>
      <div className="filter-bar">
        <div className="search-input">
          <Icon name="search" size={17} />
          <input
            type="search"
            placeholder="Search name or email…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            aria-label="Search users"
          />
        </div>
        <select
          value={role}
          onChange={(event) => {
            setRole(event.target.value as Role | "all");
            setPage(1);
          }}
          aria-label="Filter users by role"
        >
          <option value="all">All roles</option>
          {ROLES.map((option) => <option key={option}>{option}</option>)}
        </select>
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as UserStatus | "all");
            setPage(1);
          }}
          aria-label="Filter users by status"
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="removed">Removed</option>
        </select>
      </div>

      {(usersQuery.isError || mutation.isError) && (
        <div className="auth-error section-gap" role="alert">
          {errorMessage(usersQuery.error || mutation.error, "Could not update users.")}
        </div>
      )}
      <div className="card management-table">
        <DataTable
          columns={columns}
          rows={rows}
          getKey={(member) => member.id}
          loading={usersQuery.isPending}
          onRowClick={(member) => setEditor(member)}
          emptyState={<EmptyState icon="users" title="No users found" body="Try changing your search or filters." />}
        />
      </div>
      <Pagination page={page} count={usersQuery.data?.count ?? 0} pageSize={20} onPage={setPage} />

      {editor && <UserDrawer key={`${currentUser?.id}:${org?.id}:${editor.id}`} member={editor} onClose={() => setEditor(null)} />}
      {confirm && confirmCopy && (
        <ConfirmModal
          title={confirmCopy.title}
          body={confirmCopy.body}
          confirmLabel={confirmCopy.label}
          danger={confirmCopy.danger}
          onClose={() => setConfirm(null)}
          onConfirm={() => mutation.mutate(confirm)}
        />
      )}
    </>
  );
}

function UserDrawer({ member, onClose }: { member: User; onClose: () => void }) {
  const { user: currentUser, can } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState(member.name);
  const [role, setRole] = useState(member.role);
  const [notice, setNotice] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerationError, setRegenerationError] = useState<string | null>(null);
  const [credential, setCredential] = useState<TemporaryPasswordUserResult | null>(null);
  const regenerationInFlight = useRef(false);
  const mounted = useRef(true);
  const canManage = can("users.manage") && member.id !== currentUser?.id;
  const pendingTemporaryAccount = Boolean(member.adminProvisioned && member.passwordChangeRequired && member.status === "active");
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const close = () => { setCredential(null); onClose(); };
  const updateMutation = useMutation({
    mutationFn: () => api.updateUser(member.id, {
      ...(member.id === currentUser?.id ? {} : { name: name.trim(), role }),
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["users"] }); close(); },
  });
  const passwordResetMutation = useMutation({
    mutationFn: () => api.sendUserPasswordReset(member.id),
    onSuccess: (result) => setNotice(result.detail || "Password reset instructions were sent."),
  });
  const mfaResetMutation = useMutation({
    mutationFn: () => api.resetUserMfa(member.id),
    onSuccess: (result) => {
      setNotice(result.detail || "MFA was reset and the user’s sessions were revoked.");
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
  const error = updateMutation.error || passwordResetMutation.error || mfaResetMutation.error;
  const regenerate = async () => {
    if (!canManage || !pendingTemporaryAccount || regenerationInFlight.current || regenerating) return;
    regenerationInFlight.current = true;
    setRegenerating(true);
    setRegenerationError(null);
    try {
      // Direct request: never retain this credential in the mutation cache.
      const result = await api.regenerateTemporaryPassword(member.id);
      if (!mounted.current) return;
      setCredential(result);
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    } catch (caught) {
      if (mounted.current) setRegenerationError(errorMessage(caught, "Could not generate a new temporary password. Please try again."));
    } finally {
      regenerationInFlight.current = false;
      if (mounted.current) setRegenerating(false);
    }
  };
  return (
    <Drawer title={credential ? "User ready to sign in" : canManage ? "Edit user" : "User details"}
      sub={member.email} onClose={close} guard={() => regenerating || regenerationInFlight.current}
      footer={credential ? <button className="btn btn-primary" type="button" onClick={close}>Done</button> : <>
        <button className="btn btn-secondary" type="button" onClick={close} disabled={regenerating}>Cancel</button>
        {canManage && <button className="btn btn-primary" type="button" disabled={updateMutation.isPending || regenerating || !name.trim()} onClick={() => updateMutation.mutate()}>
          {updateMutation.isPending ? "Saving…" : "Save changes"}
        </button>}
      </>}>
      {credential ? <TemporaryUserCredentials result={credential} /> : <>
        {member.id === currentUser?.id && <div className="user-access-note"><Icon name="info" size={16} />Manage your own name and password from Account &amp; Security.</div>}
        {notice && <div className="user-access-note" role="status"><Icon name="check" size={16} />{notice}</div>}
        {(error || regenerationError) && <div className="auth-error" role="alert">{regenerationError || errorMessage(error, "Could not update this user.")}</div>}
        <Field label="Full name" required><input type="text" value={name} onChange={(event) => setName(event.target.value)} disabled={!canManage || regenerating} /></Field>
        <Field label="Email" hint="Email changes are completed by the user from their profile."><input type="email" value={member.email} disabled /></Field>
        <Field label="Role" hint={ROLE_HELP[role]}><select value={role} onChange={(event) => setRole(event.target.value as Role)} disabled={!canManage || regenerating}>{ROLES.map((option) => <option key={option}>{option}</option>)}</select></Field>
        <div className="user-account-summary"><span>Account status</span><UserStatusBadge member={member} />
          <small>{member.emailVerified ? "Email verified" : "Email not verified"} · MFA {member.mfaEnabled ? "enabled" : "not enabled"}</small>
        </div>
        {canManage && <div className="drawer-action-stack">
          {pendingTemporaryAccount ? <>
            <p className="user-management-tab-copy">If the password was lost or expired, generate a replacement for this pending account. The previous password and any open password-change session will stop working.</p>
            <button className="btn btn-secondary" type="button" disabled={regenerating || updateMutation.isPending} onClick={() => void regenerate()}><Icon name="settings" size={16} />{regenerating ? "Generating temporary password…" : "Generate new temporary password"}</button>
          </> : !member.passwordChangeRequired ? <button className="btn btn-secondary" type="button" disabled={passwordResetMutation.isPending} onClick={() => passwordResetMutation.mutate()}><Icon name="mail" size={16} /> Send password reset</button> : null}
          {member.mfaEnabled && <button className="btn btn-secondary" type="button" disabled={mfaResetMutation.isPending || regenerating} onClick={() => mfaResetMutation.mutate()}><Icon name="settings" size={16} /> Reset MFA and sessions</button>}
        </div>}
      </>}
    </Drawer>
  );
}

function TemporaryUserCredentials({ result }: { result: TemporaryPasswordUserResult }) {
  const formId = useId();
  const mounted = useRef(true);
  const [showPassword, setShowPassword] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const copy = async () => {
    const details = `NPA Vessel Caller\nName: ${result.user.name}\nEmail: ${result.user.email}\nRole: ${result.user.role}\nSign in: ${result.signInUrl}\nTemporary password: ${result.temporaryPassword}\nExpires: ${fmtDateTime(result.temporaryPasswordExpiresAt)}\nYou must choose your own password on first sign-in.`;
    try {
      await navigator.clipboard.writeText(details);
      if (mounted.current) setCopyNotice("Sign-in details copied. Share them directly with this user.");
    } catch {
      if (mounted.current) setCopyNotice("Could not copy automatically. Use Show password, then select and copy the sign-in fields.");
    }
  };
  return (<div className="temporary-user-result">
        <div className="user-access-note"><Icon name="check" size={17} /><div><strong>Share these sign-in details</strong><p>No email is sent. This password is shown only here and cannot be retrieved after you close this panel.</p></div></div>
        <dl className="temporary-user-summary"><div><dt>Name</dt><dd>{result.user.name}</dd></div><div><dt>Email</dt><dd>{result.user.email}</dd></div><div><dt>Role</dt><dd>{result.user.role}</dd></div></dl>
        <Field label="Sign-in page"><input type="url" readOnly autoFocus value={result.signInUrl} onFocus={(event) => event.currentTarget.select()} /></Field>
        <div className="field"><label htmlFor={`${formId}-temporary-password`}>Temporary password</label>
          <div className="temporary-password-control"><input id={`${formId}-temporary-password`} aria-describedby={`${formId}-credential-hint`} type={showPassword ? "text" : "password"} readOnly value={result.temporaryPassword} autoComplete="off" data-1p-ignore="true" onFocus={(event) => event.currentTarget.select()} />
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => setShowPassword((value) => !value)} aria-pressed={showPassword}>{showPassword ? "Hide" : "Show"} password</button>
          </div>
          <div className="hint" id={`${formId}-credential-hint`}>Expires {fmtDateTime(result.temporaryPasswordExpiresAt)}. The user must replace it on first sign-in.</div>
        </div>
        <button className="btn btn-primary" type="button" onClick={() => void copy()}><Icon name="clipboard" size={16} /> Copy sign-in details</button>
        {copyNotice && <p className="temporary-copy-notice" role="status">{copyNotice}</p>}
      </div>);
}

function AddUserDrawer({ onClose, onCreated, onUserCreated, onReviewUsers }: { onClose: () => void; onCreated: () => void; onUserCreated: () => void; onReviewUsers: () => void }) {
  const { org, can, user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const formId = useId();
  const submitInFlight = useRef(false);
  const mounted = useRef(true);
  const [method, setMethod] = useState<"temporary" | "email">("temporary");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("Operations");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // A one-time credential must never enter the React Query mutation cache.
  const [result, setResult] = useState<TemporaryPasswordUserResult | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const close = () => {
    setResult(null);
    onClose();
  };
  const findExistingMember = () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return undefined;
    if (currentUser?.email.toLowerCase() === normalizedEmail) return currentUser;
    return queryClient.getQueriesData<Paginated<User>>({ queryKey: ["users"] })
      .flatMap(([, data]) => data?.results ?? [])
      .find((member) => member.email.toLowerCase() === normalizedEmail);
  };
  const existingMember = findExistingMember();
  const mutation = useMutation({
    mutationFn: (payload: { name: string; email: string; role: Role }) => api.inviteUser(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invitations"] });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      if (mounted.current) onCreated();
    },
    onSettled: () => { submitInFlight.current = false; },
  });
  const pending = creating || mutation.isPending;
  return (
    <Drawer title={result ? "User ready to sign in" : "Add user"}
      sub={result ? `${result.user.name} · ${result.user.role}` : "Choose how your colleague will first sign in."}
      onClose={close} guard={() => pending || submitInFlight.current}
      footer={result ? <button className="btn btn-primary" type="button" onClick={close}>Done</button> : <>
        <button className="btn btn-secondary" type="button" disabled={pending} onClick={close}>Cancel</button>
        <button className="btn btn-primary" type="submit" form={formId} disabled={pending || !name.trim() || !email.trim() || Boolean(existingMember)}>
          {pending ? method === "temporary" ? "Creating user…" : "Creating invitation…" : method === "temporary" ? "Create user" : "Send invitation"}
        </button>
      </>}>
      {result ? <TemporaryUserCredentials result={result} /> : <form id={formId} className="user-invitation-form" aria-label="New user details" onSubmit={async (event) => {
        event.preventDefault();
        if (!can("users.manage") || pending || submitInFlight.current || !event.currentTarget.checkValidity() || !name.trim() || findExistingMember()) return;
        const payload = { name: name.trim(), email: email.trim().toLowerCase(), role };
        submitInFlight.current = true;
        setCreateError(null);
        if (method === "email") { mutation.mutate(payload); return; }
        setCreating(true);
        try {
          const created = await api.createTemporaryPasswordUser(payload);
          if (!mounted.current) return;
          setResult(created);
          void queryClient.invalidateQueries({ queryKey: ["users"] });
          onUserCreated();
        } catch (error) {
          if (mounted.current) setCreateError(errorMessage(error, "Could not create the user. Please try again."));
        } finally {
          submitInFlight.current = false;
          if (mounted.current) setCreating(false);
        }
      }}>
        <p className="user-invitation-scope">Access to <strong>{org?.name || "your organization"}</strong>. This role applies across the organization.</p>
        <fieldset className="user-first-signin"><legend>First sign-in</legend>
          <label><input type="radio" name={`${formId}-method`} checked={method === "temporary"} onChange={() => { setMethod("temporary"); setCreateError(null); mutation.reset(); }} disabled={pending} /><span><strong>Temporary password</strong><small>Create the user now and share their sign-in details yourself.</small></span></label>
          <label><input type="radio" name={`${formId}-method`} checked={method === "email"} onChange={() => { setMethod("email"); setCreateError(null); mutation.reset(); }} disabled={pending} /><span><strong>Email invitation</strong><small>Send a link so the user can choose their own password.</small></span></label>
        </fieldset>
        {(createError || mutation.isError) && <div className="auth-error" role="alert">{createError || errorMessage(mutation.error, "Could not create the invitation. Please try again.")}</div>}
        <Field label="Full name" required><input type="text" value={name} onChange={(event) => setName(event.target.value)} required disabled={pending} autoComplete="name" /></Field>
        <Field label="Email" required hint={method === "temporary" ? "Used to sign in. You will share the temporary password directly; no email is sent." : "The recipient chooses their own password after opening the secure link."} error={existingMember ? "This email already belongs to a user in your organization. Review their existing access." : undefined}>
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={pending} autoComplete="email" />
        </Field>
        {existingMember && <button className="link-btn" type="button" onClick={onReviewUsers}>Review existing users</button>}
        <Field label="Role" hint={ROLE_HELP[role]}><select value={role} onChange={(event) => setRole(event.target.value as Role)} disabled={pending}>{ROLES.map((option) => <option key={option}>{option}</option>)}</select></Field>
        {method === "temporary" && <p className="user-management-tab-copy">A strong password is generated for this new account. It expires in seven days and must be changed before workspace access.</p>}
      </form>}
    </Drawer>
  );
}

function InvitationsTab() {
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [revoke, setRevoke] = useState<Invitation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const params = { page, pageSize: 20 };
  const invitationsQuery = useQuery({
    queryKey: ["invitations", params],
    queryFn: () => api.invitations(params),
    placeholderData: (previous) => previous,
  });
  const resendMutation = useMutation({
    mutationFn: api.resendInvitation,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invitations"] });
      setNotice("Invitation renewed. The previous link is no longer valid.");
    },
  });
  const revokeMutation = useMutation({
    mutationFn: api.revokeInvitation,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invitations"] });
      setNotice("Invitation revoked. The recipient can no longer use that link.");
    },
  });
  const rows = invitationsQuery.data?.results ?? [];
  const columns: Column<Invitation>[] = [
    {
      key: "name",
      label: "Recipient",
      sortable: true,
      render: (invitation) => <div><div className="cell-primary">{invitation.name}</div><div className="cell-sub">{invitation.email}</div></div>,
    },
    { key: "role", label: "Role", sortable: true, render: (invitation) => <RoleBadge role={invitation.role} /> },
    { key: "status", label: "Status", sortable: true, render: (invitation) => <StatusBadge status={invitation.status === "pending" && Date.parse(invitation.expiresAt) <= Date.now() ? "expired" : invitation.status} /> },
    { key: "expiresAt", label: "Expires", sortable: true, render: (invitation) => <span className="tnum muted">{fmtDate(invitation.expiresAt)}</span> },
    {
      key: "actions",
      label: "",
      num: true,
      render: (invitation) => (
        <div className="cell-actions">
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            disabled={!can("users.manage") || resendMutation.isPending || invitation.status !== "pending"}
            onClick={() => { setNotice(null); resendMutation.mutate(invitation.id); }}
          >
            Resend
          </button>
          <button
            className="icon-btn user-delete-button"
            type="button"
            disabled={!can("users.manage") || invitation.status !== "pending"}
            onClick={() => setRevoke(invitation)}
            aria-label={`Revoke invitation for ${invitation.email}`}
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <>
      <p className="user-management-tab-copy">Track invitations before colleagues join. You can renew or revoke pending invitations.</p>
      {notice && <div className="user-access-note" role="status"><Icon name="check" size={16} />{notice}</div>}
      {(invitationsQuery.isError || resendMutation.isError || revokeMutation.isError) && (
        <div className="auth-error section-gap" role="alert">
          {errorMessage(invitationsQuery.error || resendMutation.error || revokeMutation.error, "Could not update invitations.")}
        </div>
      )}
      <div className="card management-table">
        <DataTable
          columns={columns}
          rows={rows}
          getKey={(invitation) => invitation.id}
          loading={invitationsQuery.isPending}
          emptyState={<EmptyState icon="mail" title="No invitations found" body="Invite a colleague to give them secure access." />}
        />
      </div>
      <Pagination page={page} count={invitationsQuery.data?.count ?? 0} pageSize={20} onPage={setPage} />
      {revoke && (
        <ConfirmModal
          title={`Revoke ${revoke.email}’s invitation?`}
          body="The existing invitation link will stop working immediately."
          confirmLabel="Revoke invitation"
          danger
          onClose={() => setRevoke(null)}
          onConfirm={() => { setNotice(null); revokeMutation.mutate(revoke.id); }}
        />
      )}
    </>
  );
}

function AuditTab() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [action, setAction] = useState("");
  const params = { page, pageSize: 20, search: deferredQuery, action };
  const auditQuery = useQuery({
    queryKey: ["audit", params],
    queryFn: () => api.audit(params),
    placeholderData: (previous) => previous,
  });
  const rows = auditQuery.data?.results ?? [];
  const actions = useMemo(
    () => Array.from(new Set(rows.map((event) => event.action))).sort(),
    [rows],
  );
  const columns: Column<AuditEvent>[] = [
    {
      key: "occurredAt",
      label: "Time",
      sortable: true,
      render: (event) => <span className="tnum muted">{fmtDateTime(event.occurredAt)}</span>,
    },
    {
      key: "actor",
      label: "Actor",
      render: (event) => <div><div className="cell-primary">{event.actor?.name || "System"}</div><div className="cell-sub">{event.actor?.email || "Automated event"}</div></div>,
    },
    {
      key: "action",
      label: "Action",
      sortable: true,
      render: (event) => <span className="mono-ref audit-action">{event.action}</span>,
    },
    {
      key: "targetLabel",
      label: "Target",
      render: (event) => <div><div>{event.targetLabel || "—"}</div><div className="cell-sub">{event.targetType || event.category || ""}</div></div>,
    },
    {
      key: "requestId",
      label: "Request ID",
      render: (event) => <span className="mono-ref muted">{event.requestId || "—"}</span>,
    },
  ];

  return (
    <>
      <div className="filter-bar">
        <div className="search-input">
          <Icon name="search" size={17} />
          <input
            type="search"
            placeholder="Search actor, target, or request…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            aria-label="Search audit events"
          />
        </div>
        <select
          value={action}
          onChange={(event) => {
            setAction(event.target.value);
            setPage(1);
          }}
          aria-label="Filter audit events by action"
        >
          <option value="">All actions</option>
          {actions.map((option) => <option key={option}>{option}</option>)}
        </select>
        {can("audit.export") && (
          <a className="btn btn-secondary filter-action" href={api.auditExportUrl({ search: deferredQuery, action })} download>
            <Icon name="download" size={16} /> Export CSV
          </a>
        )}
      </div>
      {auditQuery.isError && <div className="auth-error section-gap" role="alert">{errorMessage(auditQuery.error, "Could not load audit events.")}</div>}
      <div className="card management-table">
        <DataTable
          columns={columns}
          rows={rows}
          getKey={(event) => event.id}
          loading={auditQuery.isPending}
          emptyState={<EmptyState icon="fileText" title="No audit events found" body="Events will appear as users and operational records change." />}
        />
      </div>
      <Pagination page={page} count={auditQuery.data?.count ?? 0} pageSize={20} onPage={setPage} />
    </>
  );
}
