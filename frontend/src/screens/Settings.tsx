// Settings — organization profile, team link, charge rates, and port profile.
import { useEffect, useRef, useState } from "react";
import { Link } from "../lib/navigation";

import { useStore } from "../app/store";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { Field } from "../components/ui";
import { fmtNum } from "../lib/format";
import { api } from "../lib/api";
import { type Organization, type Settings as SettingsType } from "../types";

// ---------------------------------------------------------
// Constants + org normalisation (ported from calabar/data.jsx)
// ---------------------------------------------------------
const NPA_PORTS = [
  "Port of Calabar",
  "Apapa Port, Lagos",
  "Tin Can Island Port, Lagos",
  "Onne Port, Rivers",
  "Port Harcourt Port",
  "Warri Port, Delta",
];

function uniquePorts(ports: unknown): string[] {
  const out: string[] = [];
  (Array.isArray(ports) ? ports : []).forEach((p) => {
    const port = String(p || "").trim();
    if (port && out.indexOf(port) === -1) out.push(port);
  });
  return out;
}

function normalizeOrg(org: Partial<Organization> | null | undefined): Organization {
  const base: any = { ...(org || {}) };
  let ports = uniquePorts(base.ports);
  const currentPrimary = base.designatedPort || base.primaryPort || NPA_PORTS[0];
  if (!ports.length) ports = uniquePorts([currentPrimary]);
  const designatedPort = ports.indexOf(currentPrimary) !== -1 ? currentPrimary : ports[0];
  // designatedPort and primaryPort are kept in step so the sidebar/port label
  // (which reads primaryPort) follows the picker's "Primary" selection.
  return { ...base, ports, designatedPort, primaryPort: designatedPort };
}

// ---------------------------------------------------------
// Settings form shape
// ---------------------------------------------------------
interface SettingsForm {
  commissionRate: number;
  exchangeRate: number;
  liquidDuesRates: { government: number; private: number; international: number };
  dryDuesRate: number;
  portName: string;
  terminals: string[];
}

type SettingsFormUpdate =
  | { field: "commissionRate"; value: number }
  | { field: "exchangeRate"; value: number }
  | { field: "liquidDuesRate"; rate: "government" | "private" | "international"; value: number }
  | { field: "dryDuesRate"; value: number }
  | { field: "portName"; value: string }
  | { field: "terminals"; value: string[] };

function applySettingsFormUpdate(form: SettingsForm, update: SettingsFormUpdate): SettingsForm {
  switch (update.field) {
    case "commissionRate":
      return { ...form, commissionRate: update.value };
    case "exchangeRate":
      return { ...form, exchangeRate: update.value };
    case "liquidDuesRate":
      switch (update.rate) {
        case "government":
          return {
            ...form,
            liquidDuesRates: { ...form.liquidDuesRates, government: update.value },
          };
        case "private":
          return {
            ...form,
            liquidDuesRates: { ...form.liquidDuesRates, private: update.value },
          };
        case "international":
          return {
            ...form,
            liquidDuesRates: { ...form.liquidDuesRates, international: update.value },
          };
        default:
          throw new Error("Unsupported liquid dues rate");
      }
    case "dryDuesRate":
      return { ...form, dryDuesRate: update.value };
    case "portName":
      return { ...form, portName: update.value };
    case "terminals":
      return { ...form, terminals: update.value };
  }
}

function toSettingsForm(s: SettingsType): SettingsForm {
  const rates = s.liquidDuesRates || { government: 0, private: 0, international: 0 };
  return {
    commissionRate: s.commissionRate,
    exchangeRate: s.exchangeRate,
    liquidDuesRates: {
      government: rates.government ?? 0,
      private: rates.private ?? 0,
      international: rates.international ?? 0,
    },
    dryDuesRate: s.dryDuesRate,
    portName: s.portName,
    terminals: Array.isArray(s.terminals) ? [...s.terminals] : [],
  };
}

// =========================================================
// Logo upload — reads the file, downscales on a canvas and
// returns a compact data-URL (stored in the org record).
// =========================================================
function readLogoFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type || file.type.indexOf("image/") !== 0) return reject(new Error("Please choose an image file"));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not decode the image"));
      img.onload = () => {
        const MAX = 256;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Could not process the image"));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

function LogoUploader({ logo, onChange, toast }:
  { logo: string | null; onChange: (logo: string | null) => void; toast: (m: string, t?: "success" | "error" | "info") => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const result = await api.uploadOrganizationLogo(file);
      onChange(result.downloadUrl);
      toast("Logo uploaded", "success");
    } catch (err: any) {
      if (toast) toast(err.message, "error");
    }
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <div style={{ width: 56, height: 56, borderRadius: 12, border: "1px solid var(--hairline)", background: logo ? "#fff" : "var(--accent)", display: "grid", placeItems: "center", overflow: "hidden", flexShrink: 0 }}>
        {logo
          ? <img src={logo} alt="Organization logo" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          : <Icon name="anchor" size={24} strokeWidth={2} style={{ color: "#fff" }} />}
      </div>
      <div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => inputRef.current && inputRef.current.click()}>
            <Icon name="download" size={15} strokeWidth={2} style={{ transform: "rotate(180deg)" }} /> Upload logo
          </button>
          {logo && (
            <button type="button" className="btn btn-ghost btn-sm" style={{ color: "var(--danger)" }} onClick={async () => { try { await api.removeOrganizationLogo(); onChange(null); toast("Logo removed", "info"); } catch (err: any) { toast(err.message || "Could not remove logo", "error"); } }}>Remove</button>
          )}
        </div>
        <div className="hint" style={{ marginTop: 6 }}>PNG / JPG / WebP, 2 MB max — stored privately and shown on documents.</div>
      </div>
      <input ref={inputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={pick} />
    </div>
  );
}

// =========================================================
// Operating-ports picker (multi-select + primary)
// =========================================================
function PortPicker({ ports, primary, onChange, disabled }:
  { ports: string[]; primary: string; onChange: (ports: string[], primary: string) => void; disabled?: boolean }) {
  const normalized = normalizeOrg({ ports, designatedPort: primary } as Partial<Organization>);
  const selected = normalized.ports;
  const primaryPort = normalized.designatedPort;
  const togglePort = (port: string) => {
    const isSelected = selected.indexOf(port) !== -1;
    if (isSelected && selected.length === 1) return;
    const nextPorts = isSelected ? selected.filter((p) => p !== port) : [...selected, port];
    const nextPrimary = nextPorts.indexOf(primaryPort) !== -1 ? primaryPort : nextPorts[0];
    onChange(nextPorts, nextPrimary);
  };
  return (
    <>
      <div className="port-picker" aria-label="Operating ports">
        {NPA_PORTS.map((port) => {
          const checked = selected.indexOf(port) !== -1;
          const locked = checked && selected.length === 1;
          return (
            <label key={port} className={"port-option " + (checked ? "on" : "")}>
              <input type="checkbox" checked={checked} disabled={disabled || locked} onChange={() => togglePort(port)} />
              <span>{port}</span>
              {primaryPort === port && <span className="tag">Primary</span>}
            </label>
          );
        })}
      </div>
      <Field label="Primary port" hint="Used as the default on dashboards, documents and mobile capture.">
        <select value={primaryPort} disabled={disabled} onChange={(e) => onChange(selected, e.target.value)}>
          {selected.map((p) => <option key={p}>{p}</option>)}
        </select>
      </Field>
    </>
  );
}

// =========================================================
// Settings → Organization (profile, operating ports, logo)
// =========================================================
function OrganizationSection({ form, set, canEdit, toast }:
  { form: Organization; set: (key: string, val: unknown) => void; canEdit: boolean; toast: (m: string, t?: "success" | "error" | "info") => void }) {
  const normalized = normalizeOrg(form);
  return (
    <div className="card card-pad" style={{ maxWidth: 640 }}>
      <div className="card-title">Organization</div>
      <p className="muted" style={{ fontSize: 13, margin: "6px 0 20px" }}>
        The registered agency profile. Operating ports and logo appear across the app and on invoices &amp; inspection reports.
      </p>
      <fieldset disabled={!canEdit} style={{ border: "none", padding: 0, margin: 0 }}>
        <Field label="Organization name" required>
          <input type="text" value={form.name || ""} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <div className="field-row">
          <Field label="RC number"><input type="text" value={form.rcNumber || ""} onChange={(e) => set("rcNumber", e.target.value)} /></Field>
          <Field label="Phone"><input type="text" value={form.phone || ""} onChange={(e) => set("phone", e.target.value)} /></Field>
        </div>
        <Field label="Contact email"><input type="email" value={form.email || ""} onChange={(e) => set("email", e.target.value)} /></Field>
        <Field label="Address"><input type="text" value={form.address || ""} onChange={(e) => set("address", e.target.value)} /></Field>
        <Field label="Operating ports" hint="Select every NPA port this organization can work from.">
          <PortPicker ports={normalized.ports} primary={normalized.designatedPort} disabled={!canEdit}
            onChange={(ports, primary) => { set("ports", ports); set("designatedPort", primary); }} />
        </Field>
      </fieldset>
      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Logo</div>
        {canEdit
          ? <LogoUploader logo={form.logo} onChange={(l) => set("logo", l)} toast={toast} />
          : <div className="muted" style={{ fontSize: 13 }}>Only Admins can change the logo.</div>}
      </div>
    </div>
  );
}

// =========================================================
// Settings → Team & roles (members go through the API's
// dedicated add/update/remove endpoints — applied immediately)
// =========================================================
function TeamSection({ canEdit }: { canEdit: boolean }) {
  if (!canEdit) {
    return (
      <div className="card card-pad" style={{ maxWidth: 640 }}>
        <div className="card-title">Team &amp; roles</div>
        <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>
          User account details are restricted to organization Admins.
        </p>
      </div>
    );
  }
  return (
    <div className="card card-pad" style={{ maxWidth: 640 }}>
      <div className="card-title">Team &amp; roles</div>
      <p className="muted" style={{ fontSize: 13, margin: "6px 0 18px" }}>
        Invite colleagues, manage roles and account status, review security enrollment, and inspect the audit trail.
      </p>
      <Link className="btn btn-primary" to="/app/users">
        <Icon name="users" size={17} /> Open User Management
      </Link>
    </div>
  );
}

// =========================================================
// Settings (main export)
// =========================================================
export function Settings() {
  const store = useStore();
  const { user, can } = useAuth();

  const [tab, setTab] = useState<"organization" | "team" | "charges" | "port">("organization");
  const [form, setForm] = useState<SettingsForm>(() => toSettingsForm(store.settings));
  const [dirty, setDirty] = useState(false);
  const [orgForm, setOrgForm] = useState<Organization>(() => normalizeOrg(store.org));
  const [orgDirty, setOrgDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const canEdit = can("manageSettings");
  const teamCanEdit = canEdit && can("manageTeam");

  // Keep clean forms in step with data saved elsewhere (another tab, the
  // backend poll) so a stale snapshot can't silently revert newer values.
  useEffect(() => {
    if (!dirty) setForm(toSettingsForm(store.settings));
  }, [store.settings, dirty]);
  useEffect(() => {
    if (!orgDirty) setOrgForm(normalizeOrg(store.org));
  }, [store.org, orgDirty]);

  const updateForm = (update: SettingsFormUpdate) => {
    setForm((current) => applySettingsFormUpdate(current, update));
    setDirty(true);
  };

  const setOrgField = (key: string, val: unknown) => {
    setOrgForm((o) => ({ ...o, [key]: val } as Organization));
    setOrgDirty(true);
  };

  const anyDirty = dirty || orgDirty;

  const save = async () => {
    setSaving(true);
    try {
      if (dirty) {
        await store.updateSettings(form as Partial<SettingsType>);
        setDirty(false);
      }
      if (orgDirty) {
        const n = normalizeOrg(orgForm);
        // Members are managed through their own endpoints — only push the
        // profile fields here.
        const patch: Partial<Organization> = {
          name: n.name, rcNumber: n.rcNumber, email: n.email, phone: n.phone,
          address: n.address, ports: n.ports, designatedPort: n.designatedPort,
          primaryPort: n.designatedPort,
        };
        await store.updateOrganization(patch);
        setOrgForm(n);
        setOrgDirty(false);
      }
      store.toast("Settings saved", "success");
    } catch (e: any) {
      store.toast(e.message || "Could not save settings", "error");
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setForm(toSettingsForm(store.settings));
    setDirty(false);
    setOrgForm(normalizeOrg(store.org));
    setOrgDirty(false);
  };

  const TABS: [typeof tab, string][] = [
    ["organization", "Organization"],
    ["team", "Team & roles"],
    ["charges", "Charge configuration"],
    ["port", "Port profile"],
  ];

  return (
    <div className="content-inner">
      <div className="page-head"><div><h1 className="hide-sr">Settings</h1><p className="desc">Organization details, charge rates, and port profile.</p></div></div>

      <div className="settings-tabs" role="tablist">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {!canEdit && (
        <div className="muted" style={{ fontSize: 13, margin: "-8px 0 16px", display: "flex", alignItems: "center", gap: 6 }}>
          <Icon name="info" size={14} strokeWidth={2} /> You are signed in as {user ? `${user.name} (${user.role})` : "a guest"} — settings are read-only. Only Admins can make changes.
        </div>
      )}

      {/* ---------- Organization ---------- */}
      {tab === "organization" && (
        <OrganizationSection form={orgForm} set={setOrgField} canEdit={canEdit} toast={store.toast} />
      )}

      {/* ---------- Team & roles ---------- */}
      {tab === "team" && (
        <TeamSection canEdit={teamCanEdit} />
      )}

      {/* ---------- Charge configuration ---------- */}
      {tab === "charges" && (
        <fieldset disabled={!canEdit} style={{ border: "none", padding: 0, margin: 0 }}>
          <div className="card card-pad" style={{ maxWidth: 640 }}>
            <div className="card-title">Charge configuration</div>
            <p className="muted" style={{ fontSize: 13, margin: "6px 0 24px" }}>Changes affect future calculations only. Existing invoices keep the rate they were issued under.</p>
            <div className="field-row">
              <Field label="Commission rate (%)" hint="Agency commission on harbour dues.">
                <input type="number" step="0.1" value={form.commissionRate} onChange={(e) => updateForm({ field: "commissionRate", value: Number(e.target.value) })} />
              </Field>
              <Field label="USD → ₦ exchange rate" hint="Used for the naira commission figure.">
                <input type="number" step="1" value={form.exchangeRate} onChange={(e) => updateForm({ field: "exchangeRate", value: Number(e.target.value) })} />
              </Field>
            </div>
            <div className="card-title" style={{ fontSize: 14, margin: "8px 0 4px" }}>Liquid cargo — harbour dues by jetty</div>
            <p className="muted" style={{ fontSize: 13, margin: "0 0 14px" }}>USD per net-tonnage ton. The rate is selected by the jetty recorded during inspection.</p>
            <div className="field-row">
              <Field label="Government jetty"><input type="number" step="0.01" value={form.liquidDuesRates.government} onChange={(e) => updateForm({ field: "liquidDuesRate", rate: "government", value: Number(e.target.value) })} /></Field>
              <Field label="Private jetty"><input type="number" step="0.01" value={form.liquidDuesRates.private} onChange={(e) => updateForm({ field: "liquidDuesRate", rate: "private", value: Number(e.target.value) })} /></Field>
            </div>
            <Field label="International jetty"><input type="number" step="0.01" value={form.liquidDuesRates.international} onChange={(e) => updateForm({ field: "liquidDuesRate", rate: "international", value: Number(e.target.value) })} /></Field>

            <div className="card-title" style={{ fontSize: 14, margin: "20px 0 4px" }}>Dry / bulk cargo — harbour dues</div>
            <Field label="Dry cargo rate (USD per NT ton)" hint="Flat rate applied to all dry / bulk cargo.">
              <input type="number" step="0.01" value={form.dryDuesRate} onChange={(e) => updateForm({ field: "dryDuesRate", value: Number(e.target.value) })} />
            </Field>

            <div className="live-calc" style={{ marginTop: 8 }}>
              <div className="lc-label"><Icon name="gauge" size={14} strokeWidth={2} /> Worked example · 50,000 NT vessel</div>
              <div style={{ marginTop: 10, fontSize: 14 }}>
                <div className="fin-row"><div className="fl">Liquid · Government jetty</div><div className="fv tnum">${fmtNum(50000 * form.liquidDuesRates.government, 2)}</div></div>
                <div className="fin-row"><div className="fl">Liquid · Private jetty</div><div className="fv tnum">${fmtNum(50000 * form.liquidDuesRates.private, 2)}</div></div>
                <div className="fin-row"><div className="fl">Liquid · International jetty</div><div className="fv tnum">${fmtNum(50000 * form.liquidDuesRates.international, 2)}</div></div>
                <div className="fin-row"><div className="fl">Dry / bulk</div><div className="fv tnum">${fmtNum(50000 * form.dryDuesRate, 2)}</div></div>
              </div>
            </div>
          </div>
        </fieldset>
      )}

      {/* ---------- Port profile ---------- */}
      {tab === "port" && (
        <div className="card card-pad" style={{ maxWidth: 640 }}>
          <div className="card-title" style={{ marginBottom: 20 }}>Port profile</div>
          <p className="muted" style={{ fontSize: 13, margin: "-8px 0 18px" }}>
            Operating ports are set on the <button className="link-btn" onClick={() => setTab("organization")}>Organization</button> tab — currently <strong>{store.portLabel}</strong>.
          </p>
          <fieldset disabled={!canEdit} style={{ border: "none", padding: 0, margin: 0 }}>
            <Field label="Default terminals" hint="One per line. Offered when registering a vessel call.">
              <textarea style={{ minHeight: 120 }} value={form.terminals.join("\n")} onChange={(e) => updateForm({ field: "terminals", value: e.target.value.split("\n") })} />
            </Field>
          </fieldset>
        </div>
      )}

      <div className="save-bar">
        <span className="unsaved">{anyDirty ? <><Icon name="alert" size={14} strokeWidth={2} /> You have unsaved changes</> : <span className="muted">All changes saved</span>}</span>
        <div className="flex gap-3">
          <button className="btn btn-secondary" disabled={!anyDirty || saving} onClick={discard}>Discard</button>
          <button className="btn btn-primary" disabled={!anyDirty || saving || !canEdit} onClick={save}>{saving ? <><Icon name="spinner" size={16} className="spin" strokeWidth={2} /> Saving…</> : "Save changes"}</button>
        </div>
      </div>
    </div>
  );
}
