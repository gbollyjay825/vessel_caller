import { useState } from "react";
import { useBreadcrumbs } from "../app/breadcrumbs";
import { useAuth } from "../auth/AuthContext";
import { AGENCY_ROLES } from "./cargoTemplates";
import { useAgencyDirectory, type AgencyProfile } from "./agencyDirectory";
import "../styles/agency-directory.css";

type Draft = Omit<AgencyProfile, "id"> & { id?: string };
const emptyDraft = (): Draft => ({ name: "", role: "Agent", representative: "", active: true });

export function AgencyDirectory() {
  const { org, can } = useAuth();
  useBreadcrumbs([{ label: "Agencies" }]);
  return <AgencyDirectoryContent key={org?.id ?? "no-organization"} orgId={org?.id} canEdit={can("manageSettings")} />;
}

function AgencyDirectoryContent({ orgId, canEdit }: { orgId?: string; canEdit: boolean }) {
  const { agencies, saveAgency, archiveAgency, error, loading, saving } = useAgencyDirectory(orgId);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [customRole, setCustomRole] = useState(false);
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("active");
  const editable = canEdit && Boolean(orgId);
  const rows = agencies.filter(item => filter === "all" || item.active === (filter === "active"));
  function edit(agency: AgencyProfile) {
    if (!editable) return;
    setDraft({ ...agency }); setCustomRole(!AGENCY_ROLES.some(role => role.value === agency.role)); setNotice("");
  }
  return <div className="content-inner agency-directory">
    <div className="page-head"><div><h1>Agencies</h1><p className="desc">The agencies that report readings — agents, terminal operators, masters, surveyors and tally clerks — with their default representatives.</p></div></div>
    <p className="agency-preview-note">Agencies are saved for your organization and shared with its authorized users.</p>
    <p className="agency-help">Selecting an agency copies its details into each voyage sheet. Later directory changes do not alter historical records or readings.</p>
    {error && <div role="alert" className="agency-message error">{error}</div>}
    {notice && <p role="status" className="agency-message">{notice}</p>}
    {!canEdit && <p className="agency-message">Only staff with settings management permission can change agency setup.</p>}
    <div className="agency-directory-layout">
      <section className="agency-directory-list" aria-labelledby="agency-list-heading">
        <div className="agency-list-heading"><h2 id="agency-list-heading">Agency directory</h2><label>Show agencies<select value={filter} onChange={event => setFilter(event.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All agencies</option></select></label></div>
        {loading ? <p role="status">Loading agencies…</p> : rows.length ? <ul className="agency-cards">{rows.map(agency => <li key={agency.id}>
          <div><h3>{agency.name}</h3><p>{AGENCY_ROLES.find(role => role.value === agency.role)?.label ?? agency.role}</p><p>Default representative: {agency.representative || "Not set"}</p><span className={`agency-status${agency.active ? " active" : ""}`}>{agency.active ? "Active" : "Inactive"}</span></div>
          {editable && <div className="agency-card-actions"><button type="button" className="btn btn-secondary" aria-label={`Edit ${agency.name}`} onClick={() => edit(agency)}>Edit</button>{agency.active ? <button type="button" className="link-btn" aria-label={`Archive ${agency.name}`} onClick={() => { setNotice(""); void archiveAgency(agency.id); }}>Archive</button> : <button type="button" className="link-btn" aria-label={`Reactivate ${agency.name}`} onClick={() => { setNotice(""); void saveAgency({ ...agency, active: true }); }}>Reactivate</button>}</div>}
        </li>)}</ul> : <p className="agency-empty">{agencies.length ? `No ${filter === "all" ? "saved" : filter} agencies.` : "No agencies set up yet."}</p>}
      </section>
      {editable && <section className="agency-directory-editor" aria-labelledby="agency-editor-heading"><h2 id="agency-editor-heading">{draft.id ? "Edit agency" : "Add agency"}</h2>
        <form onSubmit={event => { event.preventDefault(); if (!editable || saving) return; setNotice(""); void saveAgency(draft).then(saved => { if (saved) { setNotice(`${saved.name} saved.`); setDraft(emptyDraft()); setCustomRole(false); } }); }}>
          <label>Agency name<input required maxLength={255} value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /></label>
          <label>Agency role<select value={customRole ? "custom" : draft.role} onChange={event => { setCustomRole(event.target.value === "custom"); setDraft(current => ({ ...current, role: event.target.value === "custom" ? "" : event.target.value })); }}>{AGENCY_ROLES.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}<option value="custom">Custom role</option></select></label>
          {customRole && <label>Custom role<input required maxLength={100} value={draft.role} onChange={event => setDraft(current => ({ ...current, role: event.target.value }))} /></label>}
          <label>Default representative<input maxLength={255} value={draft.representative} onChange={event => setDraft(current => ({ ...current, representative: event.target.value }))} /></label>
          <label className="agency-active-choice"><input type="checkbox" checked={draft.active} onChange={event => setDraft(current => ({ ...current, active: event.target.checked }))} />Active agency</label>
          <p className="agency-help">Active agencies are available for new voyage sheets. Archiving preserves historical records.</p>
          <div className="agency-form-actions"><button className="btn btn-primary" type="submit" disabled={saving || loading}>{saving ? "Saving…" : "Save agency"}</button>{draft.id && <button type="button" className="btn btn-secondary" onClick={() => { setDraft(emptyDraft()); setCustomRole(false); setNotice(""); }}>Cancel editing</button>}</div>
        </form>
      </section>}
    </div>
  </div>;
}
