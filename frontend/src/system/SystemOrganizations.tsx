import { useDeferredValue, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { DataTable, Drawer, EmptyState, Field, type Column } from "../components/ui";
import { api } from "../lib/api";
import { fmtDate } from "../lib/format";
import { Link, useNavigate, useSearchParams } from "../lib/navigation";
import type { PlatformOrganizationStatus, PlatformOrganizationSummary } from "../types";
import { OrganizationLifecycleBadge, SystemError, SystemMutationError, SystemPagination } from "./SystemComponents";
import { useIdempotencyKey } from "./useIdempotencyKey";

const PAGE_SIZE = 20;
const PORTS = [
  "Port of Calabar",
  "Apapa Port, Lagos",
  "Tin Can Island Port, Lagos",
  "Onne Port, Rivers",
  "Port Harcourt Port",
  "Warri Port, Delta",
];

function positivePage(value: string | null): number {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export function SystemOrganizations() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Search can contain email, registration, or organization identifiers, so it
  // intentionally stays out of browser history and shareable URLs.
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [createOpen, setCreateOpen] = useState(false);
  const page = positivePage(searchParams.get("page"));
  const status = (searchParams.get("status") ?? "all") as PlatformOrganizationStatus | "all";
  const primaryPort = searchParams.get("primaryPort") ?? "";

  const updateSearchParams = (changes: Record<string, string | number | null>) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(changes).forEach(([key, value]) => {
      if (value == null || value === "" || value === "all" || value === 1) next.delete(key);
      else next.set(key, String(value));
    });
    setSearchParams(next, { replace: true });
  };

  const organizations = useQuery({
    queryKey: ["system-organizations", { page, search: deferredSearch, status, primaryPort }],
    queryFn: () => api.systemOrganizations({ page, pageSize: PAGE_SIZE, search: deferredSearch, status, primaryPort }),
    placeholderData: (previous) => previous,
  });

  const columns: Column<PlatformOrganizationSummary>[] = [
    {
      key: "name",
      label: "Organization",
      sortable: true,
      render: (organization) => <div><div className="cell-primary">{organization.name}</div><div className="cell-sub mono-ref">{organization.id}</div></div>,
    },
    { key: "status", label: "Status", sortable: true, render: (organization) => <OrganizationLifecycleBadge status={organization.status} /> },
    { key: "primaryPort", label: "Primary port", sortable: true, render: (organization) => <span className="muted">{organization.primaryPort || "—"}</span> },
    {
      key: "users",
      label: "Access",
      sortable: true,
      sortVal: (organization) => organization.activeUserCount,
      render: (organization) => <div><div>{organization.activeUserCount} active users</div><div className="cell-sub">{organization.adminCount} Admin{organization.adminCount === 1 ? "" : "s"}</div></div>,
    },
    {
      key: "onboarding",
      label: "Onboarding",
      render: (organization) => <div><div>{organization.registered ? "Registered" : "Setup pending"}</div><div className="cell-sub">{organization.pendingInvitationCount} pending invitation{organization.pendingInvitationCount === 1 ? "" : "s"}</div></div>,
    },
    { key: "createdAt", label: "Created", sortable: true, render: (organization) => <span className="tnum muted">{fmtDate(organization.createdAt)}</span> },
    {
      key: "open",
      label: "",
      num: true,
      render: (organization) => (
        <Link className="btn btn-secondary btn-sm" to={`/system/organizations/${encodeURIComponent(organization.id)}`}>
          Open <Icon name="chevronRight" size={14} />
        </Link>
      ),
    },
  ];

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <h1 className="hide-sr">Organizations</h1>
          <p className="desc">Manage customer onboarding, profile, lifecycle, and administrator access without entering tenant workspaces.</p>
        </div>
        {can("platform.organizations.manage") && (
          <button className="btn btn-primary" type="button" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" size={17} /> Create organization
          </button>
        )}
      </div>

      <div className="filter-bar system-filters" aria-label="Organization filters">
        <label className="search-input">
          <span className="hide-sr">Search organizations</span>
          <Icon name="search" size={17} />
          <input
            type="search"
            placeholder="Search name, email, RC number, or ID…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              updateSearchParams({ page: 1 });
            }}
          />
        </label>
        <label>
          <span className="hide-sr">Lifecycle status</span>
          <select value={status} onChange={(event) => updateSearchParams({ status: event.target.value, page: 1 })}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
        </label>
        <label>
          <span className="hide-sr">Primary port</span>
          <select value={primaryPort} onChange={(event) => updateSearchParams({ primaryPort: event.target.value, page: 1 })}>
            <option value="">All primary ports</option>
            {PORTS.map((port) => <option key={port}>{port}</option>)}
          </select>
        </label>
      </div>

      {organizations.isError && (
        <SystemError error={organizations.error} fallback="Could not load organizations." onRetry={() => void organizations.refetch()} />
      )}
      <div className="card management-table">
        <DataTable
          columns={columns}
          rows={organizations.data?.results ?? []}
          getKey={(organization) => organization.id}
          loading={organizations.isPending}
          onRowClick={(organization) => navigate(`/system/organizations/${encodeURIComponent(organization.id)}`)}
          emptyState={(
            <EmptyState
              icon="building"
              title={deferredSearch || status !== "all" || primaryPort ? "No organizations match" : "No organizations yet"}
              body={deferredSearch || status !== "all" || primaryPort ? "Change or clear the filters and try again." : "Create an organization and invite its first Admin."}
            />
          )}
        />
      </div>
      <SystemPagination page={page} count={organizations.data?.count ?? 0} pageSize={PAGE_SIZE} onPage={(next) => updateSearchParams({ page: next })} />
      {createOpen && <CreateOrganizationDrawer onClose={() => setCreateOpen(false)} />}
    </div>
  );
}

function CreateOrganizationDrawer({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [rcNumber, setRcNumber] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [primaryPort, setPrimaryPort] = useState(PORTS[0]);
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const idempotency = useIdempotencyKey();
  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        rcNumber: rcNumber.trim(),
        email: contactEmail.trim().toLowerCase(),
        primaryPort,
        ports: [primaryPort],
        initialAdmin: { name: adminName.trim(), email: adminEmail.trim().toLowerCase() },
      };
      return api.createSystemOrganization(payload, idempotency.keyFor(payload));
    },
    onSuccess: (result) => {
      idempotency.reset();
      void queryClient.invalidateQueries({ queryKey: ["system-organizations"] });
      void queryClient.invalidateQueries({ queryKey: ["system-overview"] });
      onClose();
      navigate(`/system/organizations/${encodeURIComponent(result.organization.id)}`);
    },
  });
  const ready = name.trim() && adminName.trim() && adminEmail.trim();

  return (
    <Drawer
      title="Create organization"
      sub="Create the tenant and send its first Admin a single-use setup invitation."
      onClose={onClose}
      guard={() => mutation.isPending}
      footer={(
        <>
          <button className="btn btn-secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" type="button" disabled={mutation.isPending || !ready} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Creating…" : "Create and invite Admin"}
          </button>
        </>
      )}
    >
      {mutation.isError && <SystemMutationError error={mutation.error} fallback="Could not create the organization." />}
      <Field label="Organization name" required><input value={name} onChange={(event) => setName(event.target.value)} autoComplete="organization" /></Field>
      <Field label="RC number"><input value={rcNumber} onChange={(event) => setRcNumber(event.target.value)} /></Field>
      <Field label="Organization contact email"><input type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} /></Field>
      <Field label="Primary port" required>
        <select value={primaryPort} onChange={(event) => setPrimaryPort(event.target.value)}>{PORTS.map((port) => <option key={port}>{port}</option>)}</select>
      </Field>
      <hr className="system-divider" />
      <h3>First tenant Admin</h3>
      <p className="muted system-form-copy">The Admin chooses their own password from a time-limited invitation. System Administrators never set tenant passwords.</p>
      <Field label="Admin name" required><input value={adminName} onChange={(event) => setAdminName(event.target.value)} autoComplete="name" /></Field>
      <Field label="Admin email" required><input type="email" value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} autoComplete="email" /></Field>
    </Drawer>
  );
}
