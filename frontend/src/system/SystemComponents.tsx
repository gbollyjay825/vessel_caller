import type { ReactNode } from "react";

import { DataTable, EmptyState, StatusBadge, type Column } from "../components/ui";
import { ApiError } from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { Link } from "../lib/navigation";
import type { PlatformAuditEvent } from "../types";

export function SystemError({
  error,
  fallback,
  onRetry,
}: {
  error: unknown;
  fallback: string;
  onRetry?: () => void;
}) {
  const message = error instanceof Error ? error.message : fallback;
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <div className="auth-error system-error" role="alert">
      <div><strong>{message || fallback}</strong>{requestId && <small>Request ID: {requestId}</small>}</div>
      {onRetry && <button className="btn btn-secondary btn-sm" type="button" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function isSystemStepUpError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 403) return false;
  const code = error.errors.code;
  return code === "system_mfa_step_up_required"
    || (Array.isArray(code) && code.includes("system_mfa_step_up_required"));
}

export function SystemMutationError({ error, fallback }: { error: unknown; fallback: string }) {
  if (isSystemStepUpError(error)) {
    return (
      <div className="auth-error system-error" role="alert">
        <div>
          <strong>Recent multi-factor verification is required.</strong>
          <small>Verify your System Administrator session, then retry this action.</small>
        </div>
        <Link className="btn btn-secondary btn-sm" to="/system/account">Verify now</Link>
      </div>
    );
  }
  return <SystemError error={error} fallback={fallback} />;
}

export function SystemPagination({
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
    <nav className="pagination" aria-label="Results pages">
      <span aria-live="polite">
        {count ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, count)} of ${count}` : "0 results"}
      </span>
      <div className="flex gap-3">
        <button className="btn btn-secondary btn-sm" type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <span className="pagination-page">Page {page} of {pages}</span>
        <button className="btn btn-secondary btn-sm" type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </nav>
  );
}

export function DefinitionList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="system-definition-list">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

const AUDIT_COLUMNS: Column<PlatformAuditEvent>[] = [
  {
    key: "occurredAt",
    label: "Time",
    sortable: true,
    render: (event) => <span className="tnum muted">{fmtDateTime(event.occurredAt)}</span>,
  },
  {
    key: "organizationName",
    label: "Organization",
    sortable: true,
    render: (event) => <span>{event.organizationName || "Platform"}</span>,
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
    key: "reason",
    label: "Reason",
    render: (event) => <span className="system-audit-reason">{event.reason || "—"}</span>,
  },
  {
    key: "requestId",
    label: "Request ID",
    render: (event) => <span className="mono-ref muted">{event.requestId || "—"}</span>,
  },
];

export function SystemAuditTable({ rows, loading }: { rows: PlatformAuditEvent[]; loading?: boolean }) {
  return (
    <div className="card management-table">
      <DataTable
        columns={AUDIT_COLUMNS}
        rows={rows}
        getKey={(event) => event.id}
        loading={loading}
        emptyState={<EmptyState icon="fileText" title="No audit events found" body="Platform administration activity will appear here." />}
      />
    </div>
  );
}

export function OrganizationLifecycleBadge({ status }: { status: string }) {
  return <StatusBadge status={status} />;
}
