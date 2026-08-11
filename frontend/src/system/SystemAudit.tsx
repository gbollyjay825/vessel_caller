import { useDeferredValue, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import { Link, useNavigate } from "../lib/navigation";
import { SystemAuditTable, SystemError, SystemPagination } from "./SystemComponents";

const PAGE_SIZE = 20;

function hasFreshPlatformAssurance(platformAccess: ReturnType<typeof useAuth>["platformAccess"]): boolean {
  if (!platformAccess || platformAccess.stepUpRequired || !platformAccess.assuranceExpiresAt) return false;
  const expiresAt = Date.parse(platformAccess.assuranceExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export function SystemAudit() {
  const { can, platformAccess } = useAuth();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [action, setAction] = useState("");
  const deferredSearch = useDeferredValue(search);
  const audit = useQuery({
    queryKey: ["system-audit", { page, search: deferredSearch, action }],
    queryFn: () => api.systemAudit({ page, pageSize: PAGE_SIZE, search: deferredSearch, action }),
    placeholderData: (previous) => previous,
  });
  const actions = Array.from(new Set((audit.data?.results ?? []).map((event) => event.action))).sort();

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <h1 className="hide-sr">Platform audit</h1>
          <p className="desc">Immutable organization lifecycle, onboarding, and access administration events.</p>
        </div>
        {can("platform.audit.export") && (
          !hasFreshPlatformAssurance(platformAccess) ? (
            <Link className="btn btn-secondary" to="/system/account">
              <Icon name="alert" size={16} /> Verify to export CSV
            </Link>
          ) : (
            <a
              className="btn btn-secondary"
              href={api.systemAuditExportUrl({ search: deferredSearch, action })}
              download
              onClick={(event) => {
                if (hasFreshPlatformAssurance(platformAccess)) return;
                event.preventDefault();
                navigate("/system/account");
              }}
            >
              <Icon name="download" size={16} /> Download CSV
            </a>
          )
        )}
      </div>
      <div className="filter-bar" aria-label="Platform audit filters">
        <label className="search-input">
          <span className="hide-sr">Search platform audit</span>
          <Icon name="search" size={17} />
          <input type="search" value={search} placeholder="Search organization, actor, target, or request…" onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
        </label>
        <label>
          <span className="hide-sr">Audit action</span>
          <select value={action} onChange={(event) => { setAction(event.target.value); setPage(1); }}>
            <option value="">All actions</option>
            {actions.map((option) => <option key={option}>{option}</option>)}
          </select>
        </label>
      </div>
      {audit.isError && <SystemError error={audit.error} fallback="Could not load platform audit." onRetry={() => void audit.refetch()} />}
      <SystemAuditTable rows={audit.data?.results ?? []} loading={audit.isPending} />
      <SystemPagination page={page} count={audit.data?.count ?? 0} pageSize={PAGE_SIZE} onPage={setPage} />
    </div>
  );
}
