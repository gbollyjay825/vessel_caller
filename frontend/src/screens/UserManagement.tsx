import { useMemo, useState } from "react";

import { useStore } from "../app/store";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import {
  ConfirmModal, DataTable, Drawer, EmptyState, Field, StatCard, StatusBadge,
  type Column,
} from "../components/ui";
import { fmtDate, userInitials } from "../lib/format";
import { ROLES, type Member, type Role } from "../types";

const ROLE_HELP: Record<Role, string> = {
  Admin: "Full access, including settings and user management.",
  Operations: "Can register vessel calls and submit inspections.",
  Finance: "Can record and track invoice payments.",
  Viewer: "Read-only access to operational and financial records.",
};

type StatusFilter = "all" | "active" | "inactive";
type ConfirmAction = {
  kind: "activate" | "deactivate" | "delete";
  member: Member;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function RoleBadge({ role }: { role: Role }) {
  return <span className={"role-badge role-" + role.toLowerCase()}>{role}</span>;
}

export function UserManagement() {
  const store = useStore();
  const { user, can } = useAuth();
  const members = store.org.members;
  const allowed = can("manageTeam");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | Role>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [editor, setEditor] = useState<Member | null | "new">(null);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const activeMembers = members.filter((member) => member.active);
  const activeAdmins = activeMembers.filter((member) => member.role === "Admin");
  const inactiveCount = members.length - activeMembers.length;

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return members
      .filter((member) => {
        if (roleFilter !== "all" && member.role !== roleFilter) return false;
        if (statusFilter === "active" && !member.active) return false;
        if (statusFilter === "inactive" && member.active) return false;
        return !normalizedQuery
          || member.name.toLowerCase().includes(normalizedQuery)
          || member.email.toLowerCase().includes(normalizedQuery);
      })
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  }, [members, query, roleFilter, statusFilter]);

  const isProtected = (member: Member) =>
    member.id === user?.id || (member.active && member.role === "Admin" && activeAdmins.length === 1);

  const runConfirmedAction = async (action: ConfirmAction) => {
    setBusyId(action.member.id);
    try {
      if (action.kind === "delete") {
        await store.removeMember(action.member.id);
        store.toast(`${action.member.name} was deleted`, "success");
      } else {
        const active = action.kind === "activate";
        await store.updateMember(action.member.id, { active });
        store.toast(`${action.member.name} is now ${active ? "active" : "inactive"}`, "success");
      }
    } catch (error: unknown) {
      store.toast(errorMessage(error, "Could not update the user"), "error");
    } finally {
      setBusyId(null);
    }
  };

  if (!allowed) {
    return (
      <div className="content-inner">
        <div className="page-head">
          <div>
            <h1 className="hide-sr">User Management</h1>
            <p className="desc">Manage dashboard access, roles, and account status.</p>
          </div>
        </div>
        <div className="card">
          <EmptyState
            icon="users"
            title="Admin access required"
            body="Only organization Admins can view or change user accounts."
          />
        </div>
      </div>
    );
  }

  const columns: Column<Member>[] = [
    {
      key: "name", label: "User", sortable: true,
      render: (member) => (
        <div className="user-cell">
          <div className="avatar">{userInitials(member.name)}</div>
          <div>
            <div className="cell-primary">
              {member.name}
              {member.id === user?.id && <span className="tag">You</span>}
            </div>
            <div className="cell-sub">{member.email}</div>
          </div>
        </div>
      ),
    },
    {
      key: "role", label: "Role", sortable: true,
      render: (member) => <RoleBadge role={member.role} />,
    },
    {
      key: "active", label: "Status", sortable: true,
      sortVal: (member) => Number(member.active),
      render: (member) => <StatusBadge status={member.active ? "active" : "inactive"} />,
    },
    {
      key: "createdAt", label: "Joined", sortable: true,
      render: (member) => <span className="tnum muted">{fmtDate(member.createdAt)}</span>,
    },
    {
      key: "actions", label: "", num: true,
      render: (member) => (
        <UserActions
          member={member}
          protectedAccount={isProtected(member)}
          busy={busyId === member.id}
          onEdit={() => setEditor(member)}
          onConfirm={(kind) => setConfirm({ kind, member })}
        />
      ),
    },
  ];

  const confirmCopy = confirm && {
    activate: {
      title: `Activate ${confirm.member.name}?`,
      body: "This user will immediately be able to sign in again with their current password.",
      label: "Activate user",
      danger: false,
    },
    deactivate: {
      title: `Deactivate ${confirm.member.name}?`,
      body: "Their existing dashboard access will stop immediately. Their account and history will be retained.",
      label: "Deactivate user",
      danger: true,
    },
    delete: {
      title: `Delete ${confirm.member.name}?`,
      body: "This permanently removes the user account. Operational records already created by them will be retained.",
      label: "Delete user",
      danger: true,
    },
  }[confirm.kind];

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <h1 className="hide-sr">User Management</h1>
          <p className="desc">Control who can access {store.org.name}, what they can do, and whether their account is active.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditor("new")}>
          <Icon name="plus" size={17} strokeWidth={2.2} /> Add user
        </button>
      </div>

      <div className="kpi-strip user-kpis">
        <StatCard label="Total users" value={members.length} sub="All dashboard accounts" />
        <StatCard label="Active" value={activeMembers.length} sub="Can currently sign in" />
        <StatCard label="Active admins" value={activeAdmins.length} sub="Full-access accounts" />
        <StatCard label="Inactive" value={inactiveCount} sub="Access suspended" />
      </div>

      <div className="filter-bar section-gap">
        <div className="search-input">
          <Icon name="search" size={17} />
          <input
            type="text"
            placeholder="Search name or email…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search users"
          />
        </div>
        <select
          className="user-role-filter"
          value={roleFilter}
          onChange={(event) => setRoleFilter(event.target.value as "all" | Role)}
          aria-label="Filter users by role"
        >
          <option value="all">All roles</option>
          {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
        </select>
        <div className="seg" aria-label="Filter users by account status">
          {(["all", "active", "inactive"] as StatusFilter[]).map((status) => (
            <button
              key={status}
              type="button"
              className={statusFilter === status ? "on" : ""}
              aria-pressed={statusFilter === status}
              onClick={() => setStatusFilter(status)}
            >
              {status[0].toUpperCase() + status.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <DataTable
          columns={columns}
          rows={filtered}
          getKey={(member) => member.id}
          onRowClick={(member) => setEditor(member)}
          emptyState={(
            <EmptyState
              icon="search"
              title="No matching users"
              body="Try a different name, email, role, or status filter."
            />
          )}
        />
      </div>

      <div className="m-cards user-mobile-cards">
        {filtered.map((member) => (
          <div className="m-card" key={member.id}>
            <div className="mc-top">
              <div className="user-cell">
                <div className="avatar">{userInitials(member.name)}</div>
                <div>
                  <div className="cell-primary">{member.name}{member.id === user?.id && <span className="tag">You</span>}</div>
                  <div className="cell-sub">{member.email}</div>
                </div>
              </div>
              <StatusBadge status={member.active ? "active" : "inactive"} />
            </div>
            <div className="user-mobile-meta">
              <RoleBadge role={member.role} />
              <span>Joined {fmtDate(member.createdAt)}</span>
            </div>
            <UserActions
              member={member}
              protectedAccount={isProtected(member)}
              busy={busyId === member.id}
              onEdit={() => setEditor(member)}
              onConfirm={(kind) => setConfirm({ kind, member })}
              mobile
            />
          </div>
        ))}
      </div>

      {editor && (
        <MemberDrawer
          key={editor === "new" ? "new" : editor.id}
          member={editor === "new" ? null : editor}
          currentUserId={user?.id || ""}
          activeAdminCount={activeAdmins.length}
          onClose={() => setEditor(null)}
        />
      )}

      {confirm && confirmCopy && (
        <ConfirmModal
          title={confirmCopy.title}
          body={confirmCopy.body}
          confirmLabel={confirmCopy.label}
          danger={confirmCopy.danger}
          onClose={() => setConfirm(null)}
          onConfirm={() => void runConfirmedAction(confirm)}
        />
      )}
    </div>
  );
}

function UserActions({
  member, protectedAccount, busy, onEdit, onConfirm, mobile,
}: {
  member: Member;
  protectedAccount: boolean;
  busy: boolean;
  onEdit: () => void;
  onConfirm: (kind: ConfirmAction["kind"]) => void;
  mobile?: boolean;
}) {
  const protectionReason = "Your own account and the last active Admin are protected";
  return (
    <div className={mobile ? "mc-actions" : "cell-actions"} onClick={(event) => event.stopPropagation()}>
      <button className={mobile ? "btn btn-secondary btn-sm" : "icon-btn"} onClick={onEdit} aria-label={`Edit ${member.name}`} title="Edit user">
        <Icon name="edit" size={16} />
        {mobile && "Edit"}
      </button>
      <button
        className={mobile ? "btn btn-secondary btn-sm" : "icon-btn"}
        disabled={protectedAccount || busy}
        onClick={() => onConfirm(member.active ? "deactivate" : "activate")}
        aria-label={`${member.active ? "Deactivate" : "Activate"} ${member.name}`}
        title={protectedAccount ? protectionReason : `${member.active ? "Deactivate" : "Activate"} user`}
      >
        <Icon name={member.active ? "x" : "check"} size={16} />
        {mobile && (member.active ? "Deactivate" : "Activate")}
      </button>
      <button
        className={mobile ? "btn btn-ghost btn-sm user-delete-button" : "icon-btn user-delete-button"}
        disabled={protectedAccount || busy}
        onClick={() => onConfirm("delete")}
        aria-label={`Delete ${member.name}`}
        title={protectedAccount ? protectionReason : "Delete user"}
      >
        <Icon name={busy ? "spinner" : "trash"} size={16} className={busy ? "spin" : ""} />
        {mobile && "Delete"}
      </button>
    </div>
  );
}

interface MemberForm {
  name: string;
  email: string;
  role: Role;
  password: string;
}

function MemberDrawer({
  member, currentUserId, activeAdminCount, onClose,
}: {
  member: Member | null;
  currentUserId: string;
  activeAdminCount: number;
  onClose: () => void;
}) {
  const store = useStore();
  const creating = member === null;
  const isSelf = member?.id === currentUserId;
  const lastActiveAdmin = !!member && member.active && member.role === "Admin" && activeAdminCount === 1;
  const securityLocked = isSelf || lastActiveAdmin;
  const [form, setForm] = useState<MemberForm>({
    name: member?.name || "",
    email: member?.email || "",
    role: member?.role || "Operations",
    password: "",
  });
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof MemberForm, string>>>({});
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof MemberForm>(key: K, value: MemberForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setDirty(true);
  };

  const save = async () => {
    const nextErrors: Partial<Record<keyof MemberForm, string>> = {};
    if (!form.name.trim()) nextErrors.name = "Name is required";
    if (creating && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) {
      nextErrors.email = "Enter a valid email address";
    }
    if ((creating || form.password) && form.password.length < 8) {
      nextErrors.password = "Use at least 8 characters";
    }
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      return;
    }

    setSaving(true);
    try {
      if (creating) {
        await store.addMember({
          name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          password: form.password,
          role: form.role,
        });
        store.toast(`${form.name.trim()} can now sign in`, "success");
      } else {
        const patch: { name?: string; role?: Role; password?: string } = {};
        if (!isSelf) patch.name = form.name.trim();
        if (!securityLocked) patch.role = form.role;
        if (form.password) patch.password = form.password;
        await store.updateMember(member.id, patch);
        store.toast(form.password ? "User updated and password reset" : "User updated", "success");
      }
      setDirty(false);
      onClose();
    } catch (error: unknown) {
      store.toast(errorMessage(error, "Could not save the user"), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      title={creating ? "Add user" : "Edit user"}
      sub={creating ? "Create a dashboard account with a temporary password." : member.email}
      onClose={onClose}
      guard={() => dirty && !window.confirm("Discard your unsaved user changes?")}
      footer={(
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving && <Icon name="spinner" size={16} className="spin" />}
            {saving ? "Saving…" : creating ? "Add user" : "Save changes"}
          </button>
        </>
      )}
    >
      {(isSelf || lastActiveAdmin) && (
        <div className="user-access-note">
          <Icon name="info" size={16} />
          <span>
            {isSelf
              ? "Your own name, role, and account status are protected here. You can still reset your password."
              : "This is the last active Admin. Add another Admin before changing this account's role or status."}
          </span>
        </div>
      )}

      <Field label="Full name" required error={errors.name}>
        <input
          type="text"
          value={form.name}
          disabled={isSelf}
          onChange={(event) => set("name", event.target.value)}
          autoComplete="name"
          aria-label="Full name"
        />
      </Field>

      <Field
        label="Email"
        required
        error={errors.email}
        hint={!creating ? "Email addresses cannot be changed after an account is created." : undefined}
      >
        <input
          type="email"
          value={form.email}
          disabled={!creating}
          onChange={(event) => set("email", event.target.value)}
          autoComplete="email"
          aria-label="Email"
        />
      </Field>

      <Field label="Role" hint={ROLE_HELP[form.role]}>
        <select
          value={form.role}
          disabled={securityLocked}
          onChange={(event) => set("role", event.target.value as Role)}
          aria-label="Role"
        >
          {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
        </select>
      </Field>

      <Field
        label={creating ? "Temporary password" : "Reset password"}
        required={creating}
        error={errors.password}
        hint={creating
          ? "Share this securely. The user can sign in immediately."
          : "Leave blank to keep the current password. Enter a new value to reset it immediately."}
      >
        <input
          type="password"
          value={form.password}
          placeholder={creating ? "At least 8 characters" : "New password (optional)"}
          onChange={(event) => set("password", event.target.value)}
          autoComplete="new-password"
          aria-label={creating ? "Temporary password" : "Reset password"}
        />
      </Field>

      {!creating && (
        <div className="user-account-summary">
          <span>Account status</span>
          <StatusBadge status={member.active ? "active" : "inactive"} />
          <small>Use the action in the user list to change account access.</small>
        </div>
      )}
    </Drawer>
  );
}
