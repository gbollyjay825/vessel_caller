import { useQuery } from "@tanstack/react-query";

import { DataTable, EmptyState, StatCard, type Column } from "../components/ui";
import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import { fmtDate } from "../lib/format";
import { Link } from "../lib/navigation";
import type { PlatformOrganizationSummary } from "../types";
import { OrganizationLifecycleBadge, SystemError } from "./SystemComponents";

const RECENT_COLUMNS: Column<PlatformOrganizationSummary>[] = [
  {
    key: "name",
    label: "Organization",
    sortable: true,
    render: (organization) => <div><div className="cell-primary">{organization.name}</div><div className="cell-sub mono-ref">{organization.id}</div></div>,
  },
  {
    key: "status",
    label: "Status",
    sortable: true,
    render: (organization) => <OrganizationLifecycleBadge status={organization.status} />,
  },
  {
    key: "adminCount",
    label: "Admins",
    num: true,
    sortable: true,
    render: (organization) => <span className="tnum">{organization.adminCount}</span>,
  },
  {
    key: "createdAt",
    label: "Created",
    sortable: true,
    render: (organization) => <span className="tnum muted">{fmtDate(organization.createdAt)}</span>,
  },
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

export function SystemOverview() {
  const overview = useQuery({ queryKey: ["system-overview"], queryFn: api.systemOverview });

  if (overview.isError) {
    return (
      <div className="content-inner">
        <SystemError error={overview.error} fallback="Could not load the platform overview." onRetry={() => void overview.refetch()} />
      </div>
    );
  }

  const data = overview.data;
  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <h1 className="hide-sr">Platform overview</h1>
          <p className="desc">Organization lifecycle and access across Vessel Caller. Tenant operational records remain isolated.</p>
        </div>
        <Link className="btn btn-primary" to="/system/organizations">
          <Icon name="building" size={17} /> Manage organizations
        </Link>
      </div>

      <section className="kpi-strip system-kpis" aria-label="Platform totals" aria-busy={overview.isPending}>
        <StatCard label="Organizations" value={data?.organizationCount ?? "—"} sub="Customer organizations" />
        <StatCard label="Active" value={data?.activeOrganizationCount ?? "—"} sub="Can access workspaces" />
        <StatCard label="Suspended" value={data?.suspendedOrganizationCount ?? "—"} sub="Access blocked" />
        <StatCard label="Active users" value={data?.activeUserCount ?? "—"} sub={`${data?.pendingInvitationCount ?? 0} pending invitations`} />
      </section>

      <section className="card section-gap" aria-labelledby="recent-organizations-title">
        <div className="card-head">
          <div className="card-title" id="recent-organizations-title">Recently created organizations</div>
          <Link className="link-btn" to="/system/organizations">View all <Icon name="chevronRight" size={14} /></Link>
        </div>
        <DataTable
          columns={RECENT_COLUMNS}
          rows={data?.recentOrganizations ?? []}
          getKey={(organization) => organization.id}
          loading={overview.isPending}
          emptyState={<EmptyState icon="building" title="No organizations yet" body="Create an organization and securely invite its first Admin." />}
        />
      </section>
    </div>
  );
}
