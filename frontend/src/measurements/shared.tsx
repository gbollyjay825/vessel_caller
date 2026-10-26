import { useId, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../lib/api";
import { Icon } from "../components/Icon";
import { measurementApi } from "./api";
import type { Evidence, MeasurementPlan } from "./types";

export function MeasurementBadge({ status }: { status: string }) {
  return <span className={`measurement-badge ${status}`}>{status.replaceAll("-", " ")}</span>;
}
export function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="card measurement-section"><div className="measurement-section-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>{children}</section>;
}
export function FormField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="measurement-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : "Something went wrong. Please try again.";
  const details = error instanceof ApiError ? Object.entries(error.errors).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(" ") : value}`) : [];
  return <div className="measurement-notice error" role="alert"><strong>{message}</strong>{error instanceof ApiError && error.status === 409 && <p>This record changed. Close this action, review the latest version and reopen it before saving.</p>}{details.length > 0 && <ul>{details.map(detail => <li key={detail}>{detail}</li>)}</ul>}</div>;
}
export function ActionForm({ submit, onSubmit, children, onCancel, disabled = false }: { submit: string; onSubmit: () => Promise<unknown>; children: ReactNode; onCancel?: () => void; disabled?: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const handle = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || disabled) return;
    setPending(true); setError(null);
    try { await onSubmit(); } catch (failure) { setError(failure); } finally { setPending(false); }
  };
  return <form className="measurement-form" onSubmit={event => void handle(event)}><fieldset disabled={pending}>{children}</fieldset><ErrorMessage error={error} /><div className="measurement-actions">{onCancel && <button className="btn btn-secondary" type="button" disabled={pending} onClick={onCancel}>Cancel</button>}<button className="btn btn-primary" type="submit" disabled={pending || disabled}>{pending ? "Saving…" : submit}</button></div></form>;
}

export function EvidencePicker({ plan, value, onChange, onBusyChange, optional = false }: { plan: MeasurementPlan; value: string[]; onChange: (ids: string[]) => void; onBusyChange: (busy: boolean) => void; optional?: boolean }) {
  const [added, setAdded] = useState<Evidence[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inputId = useId();
  const evidence = [...new Map([...plan.evidence, ...added].map(item => [item.id, item])).values()];
  const upload = async (files: File[]) => {
    setUploading(true); onBusyChange(true); setError(null);
    const selected = [...value];
    try {
      for (const file of files) {
        const item = await measurementApi.upload(plan.id, file);
        setAdded(current => [...current, item]); selected.push(item.id); onChange([...new Set(selected)]);
      }
    } catch (failure) { setError(failure); } finally { setUploading(false); onBusyChange(false); }
  };
  return <div className="measurement-evidence-picker"><div className="measurement-section-head"><div><h3>Supporting evidence{optional ? " (optional)" : ""}</h3><p>Select received documents, or upload a signed sheet or photo. PDF, JPEG, PNG or WebP, up to 15 MB each.</p></div></div>
    {evidence.length > 0 && <div className="measurement-evidence-options">{evidence.map(item => <label key={item.id} className="measurement-check"><input type="checkbox" disabled={uploading} checked={value.includes(item.id)} onChange={event => onChange(event.target.checked ? [...value, item.id] : value.filter(id => id !== item.id))} /><Icon name="fileText" size={16} /><span>{item.fileName}</span></label>)}</div>}
    <label className="measurement-upload" htmlFor={inputId}><Icon name={uploading ? "spinner" : "plus"} size={18} />{uploading ? "Uploading evidence…" : "Upload evidence"}</label><input id={inputId} className="measurement-file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" multiple disabled={uploading} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void upload(files); }} />
    <ErrorMessage error={error} />
  </div>;
}

export function EvidenceLink({ planId, evidence }: { planId: string; evidence: Evidence }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const load = async () => { setPending(true); setError(null); try { setUrl((await measurementApi.evidence(planId, evidence.id)).downloadUrl); } catch (failure) { setError(failure); } finally { setPending(false); } };
  return <div className="measurement-evidence-link"><Icon name="fileText" size={18} /><span>{evidence.fileName}<small>{Math.max(1, Math.round(evidence.size / 1024))} KB</small></span>{url ? <a className="link-btn" href={url} target="_blank" rel="noopener noreferrer">Open file <Icon name="external" size={14} /></a> : <button className="link-btn" onClick={() => void load()} disabled={pending}>{pending ? "Preparing…" : "View file"}</button>}<ErrorMessage error={error} /></div>;
}
