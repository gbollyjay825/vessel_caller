// Shared UI kit (ported from the prototype's ui.jsx) — typed for TS.
import {
  Fragment, useCallback, useEffect, useRef, useState,
  type CSSProperties, type ReactNode,
} from "react";

import { fmtNGN, fmtUSD } from "../lib/format";
import { Icon } from "./Icon";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending", "in-progress": "In progress", completed: "Completed",
  paid: "Paid", unpaid: "Unpaid", overdue: "Overdue", draft: "Draft",
  active: "Active", inactive: "Inactive",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={"badge " + status}><span className="dot" />{STATUS_LABEL[status] || status}</span>;
}

export function CargoTag({ type }: { type: string }) {
  const liquid = type === "Liquid";
  return (
    <span className={"tag " + (liquid ? "liquid" : "dry")}>
      <Icon name={liquid ? "droplet" : "package"} size={13} strokeWidth={2} />{type}
    </span>
  );
}

export function Money({ usd, ngn, dp = 2, block }: { usd: number; ngn?: number | null; dp?: number; block?: boolean }) {
  return (
    <span className="money tnum" style={block ? { display: "block" } : undefined}>
      <span className="usd">{fmtUSD(usd, dp)}</span>
      {ngn != null && <span className="ngn">{fmtNGN(ngn)}</span>}
    </span>
  );
}

export function PdfButton({ kind, record, disabled }: { kind: "invoice" | "report"; record: Record<string, string>; disabled?: boolean }) {
  const [loading, setLoading] = useState(false);
  const label = kind === "invoice" ? "Invoice" : "Report";
  const icon = kind === "invoice" ? "receipt" : "fileText";
  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled || loading) return;
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      const params = new URLSearchParams({ doc: kind, ...record }).toString();
      window.open("/pdf.html?" + params, "_blank", "noopener");
    }, 300);
  };
  return (
    <button className="pdf-btn" onClick={open} disabled={disabled}
      title={disabled ? "Not yet generated" : `Open ${label.toLowerCase()} PDF in a new tab`} aria-label={`${label} PDF`}>
      <Icon name={loading ? "spinner" : icon} size={14} strokeWidth={2} className={loading ? "spin" : ""} />{label}
    </button>
  );
}

export interface Delta { dir?: "up" | "down"; text: string; }
export function StatCard({ label, value, cur, ngn, sub, delta }:
  { label: string; value: ReactNode; cur?: string; ngn?: string; sub?: string; delta?: Delta }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-num tnum">{cur && <span className="cur">{cur}</span>}{value}</div>
      {ngn && <div className="stat-ngn tnum">{ngn}</div>}
      {(sub || delta) && (
        <div className="stat-sub">
          {delta && (
            <span className={"delta " + (delta.dir || "up")}>
              <Icon name="arrowRight" size={13} strokeWidth={2.2}
                style={{ transform: delta.dir === "down" ? "rotate(45deg)" : "rotate(-45deg)" }} />{delta.text}
            </span>
          )}
          {sub && <span>{sub}</span>}
        </div>
      )}
    </div>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  num?: boolean;
  sortable?: boolean;
  sortVal?: (r: T) => string | number | null | undefined;
  render: (r: T) => ReactNode;
}
export function DataTable<T>({ columns, rows, getKey, onRowClick, loading, skeletonRows = 5, emptyState, flashId }:
  {
    columns: Column<T>[]; rows: T[]; getKey: (r: T) => string;
    onRowClick?: (r: T) => void; loading?: boolean; skeletonRows?: number;
    emptyState?: ReactNode; flashId?: string | null;
  }) {
  const [sort, setSort] = useState<{ key: string | null; dir: "asc" | "desc" }>({ key: null, dir: "asc" });
  const toggleSort = (col: Column<T>) => {
    if (!col.sortable) return;
    setSort((s) => (s.key === col.key ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" } : { key: col.key, dir: "asc" }));
  };

  let display = rows;
  if (sort.key) {
    const col = columns.find((c) => c.key === sort.key)!;
    display = [...rows].sort((a, b) => {
      const va = col.sortVal ? col.sortVal(a) : (a as any)[sort.key!];
      const vb = col.sortVal ? col.sortVal(b) : (b as any)[sort.key!];
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }

  if (loading) {
    return (
      <div className="table-wrap">
        <table className="dt">
          <thead><tr>{columns.map((c) => <th key={c.key} className={c.num ? "num" : ""}>{c.label}</th>)}</tr></thead>
          <tbody>
            {Array.from({ length: skeletonRows }).map((_, i) => (
              <tr key={i}>{columns.map((c) => (
                <td key={c.key} className={c.num ? "num" : ""}>
                  <div className="sk" style={{ width: c.num ? "60%" : i % 2 ? "70%" : "85%", marginLeft: c.num ? "auto" : 0 }} />
                </td>
              ))}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (!rows.length && emptyState) return <>{emptyState}</>;

  return (
    <div className="table-wrap scroll-host">
      <table className="dt">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={(c.num ? "num " : "") + (c.sortable ? "sortable" : "")}
                onClick={() => toggleSort(c)}
                aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                <span className="th-in" style={c.num ? { justifyContent: "flex-end", width: "100%" } : undefined}>
                  {c.label}
                  {c.sortable && sort.key === c.key && (
                    <Icon name="chevronDown" size={13} strokeWidth={2.2}
                      style={{ transform: sort.dir === "asc" ? "rotate(180deg)" : "none" }} />
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {display.map((row) => {
            const k = getKey(row);
            return (
              <tr key={k} className={(onRowClick ? "clickable " : "") + (flashId === k ? "flash" : "")}
                onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {columns.map((c) => <td key={c.key} className={c.num ? "num" : ""}>{c.render(row)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: string; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="ic"><Icon name={icon} size={28} strokeWidth={1.6} /></div>
      <h3>{title}</h3><p>{body}</p>{action}
    </div>
  );
}

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="stepper">
      {steps.map((label, i) => {
        const state = i < current ? "done" : i === current ? "current" : "";
        return (
          <Fragment key={i}>
            <div className={"step " + state}>
              <div className="step-bullet">{i < current ? <Icon name="check" size={15} strokeWidth={2.4} /> : i + 1}</div>
              <div className="step-label">{label}</div>
            </div>
            {i < steps.length - 1 && <div className={"step-line " + (i < current ? "done" : "")} />}
          </Fragment>
        );
      })}
    </div>
  );
}

export function Drawer({ title, sub, onClose, children, footer, wide, guard }:
  { title: string; sub?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; guard?: () => boolean }) {
  const ref = useRef<HTMLElement>(null);
  const attemptClose = useCallback(() => { if (guard && guard()) return; onClose(); }, [guard, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") attemptClose(); };
    document.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [attemptClose]);
  return (
    <>
      <div className="scrim" onClick={attemptClose} />
      <aside className={"drawer " + (wide ? "wide" : "")} ref={ref} role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer-head">
          <div><h2>{title}</h2>{sub && <div className="sub">{sub}</div>}</div>
          <button className="icon-btn" onClick={attemptClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="drawer-body scroll-host">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>
  );
}

export function ConfirmModal({ title, body, confirmLabel = "Confirm", danger, onConfirm, onClose }:
  { title: string; body: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="modal-pad">
          <h3>{title}</h3><p>{body}</p>
          <div className="modal-foot">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className={"btn " + (danger ? "btn-danger" : "btn-primary")}
              onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
          </div>
        </div>
      </div>
    </>
  );
}

export function Field({ label, required, hint, error, ok, checking, children }:
  { label?: string; required?: boolean; hint?: ReactNode; error?: ReactNode; ok?: ReactNode; checking?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      {label && <label>{label}{required && <span className="req">*</span>}</label>}
      {children}
      {checking && <div className="field-checking"><Icon name="spinner" size={13} className="spin" strokeWidth={2} /> {checking}</div>}
      {!checking && error && <div className="field-err"><Icon name="alert" size={13} strokeWidth={2} /> {error}</div>}
      {!checking && !error && ok && <div className="field-ok"><Icon name="check" size={13} strokeWidth={2.2} /> {ok}</div>}
      {!checking && !error && !ok && hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function LiveCalc({ label, value, unit, foot, flashKey }:
  { label: string; value: ReactNode; unit?: string; foot?: ReactNode; flashKey?: unknown }) {
  const numRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = numRef.current;
    if (!el) return;
    el.classList.remove("lc-flash");
    void el.offsetWidth;
    el.classList.add("lc-flash");
  }, [flashKey]);
  return (
    <div className="live-calc">
      <div className="lc-label"><Icon name="gauge" size={14} strokeWidth={2} /> {label}</div>
      <div className="lc-num tnum" ref={numRef}>{value}{unit && <span className="lc-unit">{unit}</span>}</div>
      {foot && <div className="lc-foot">{foot}</div>}
    </div>
  );
}

export function ToastHost() {
  return null; // toasts are rendered by the app shell's own ToastHost
}
