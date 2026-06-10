/* global React, Icon, fmtUSD, fmtNGN */
const { useState, useEffect, useRef, useCallback } = React;

// ---------------------------------------------------------
// StatusBadge — pill, tinted bg + saturated text, dot + label
// ---------------------------------------------------------
const STATUS_LABEL = {
  pending: 'Pending', 'in-progress': 'In progress', completed: 'Completed',
  paid: 'Paid', unpaid: 'Unpaid', overdue: 'Overdue', draft: 'Draft',
};
function StatusBadge({ status }) {
  return (
    <span className={'badge ' + status}>
      <span className="dot" />
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function CargoTag({ type }) {
  const liquid = type === 'Liquid';
  return (
    <span className={'tag ' + (liquid ? 'liquid' : 'dry')}>
      <Icon name={liquid ? 'droplet' : 'package'} size={13} strokeWidth={2} />
      {type}
    </span>
  );
}

// ---------------------------------------------------------
// Money — tabular, right-aligned, USD primary + ₦ secondary
// ---------------------------------------------------------
function Money({ usd, ngn, dp = 2, block }) {
  return (
    <span className="money tnum" style={block ? { display: 'block' } : {}}>
      <span className="usd">{fmtUSD(usd, dp)}</span>
      {ngn != null && <span className="ngn">{fmtNGN(ngn)}</span>}
    </span>
  );
}

// ---------------------------------------------------------
// PdfButton — opens mock PDF in a new tab, brief loading spinner
// ---------------------------------------------------------
function PdfButton({ kind, record, disabled }) {
  const [loading, setLoading] = useState(false);
  const label = kind === 'invoice' ? 'Invoice' : 'Report';
  const icon = kind === 'invoice' ? 'receipt' : 'fileText';
  const open = (e) => {
    e.stopPropagation();
    if (disabled || loading) return;
    setLoading(true);
    // simulate the link resolving (GET /api/pdf/:filename)
    setTimeout(() => {
      setLoading(false);
      const params = new URLSearchParams({ doc: kind, ...record }).toString();
      window.open('calabar/pdf.html?' + params, '_blank', 'noopener');
    }, 480);
  };
  return (
    <button
      className="pdf-btn"
      onClick={open}
      disabled={disabled}
      title={disabled ? 'Not yet generated' : `Open ${label.toLowerCase()} PDF in a new tab`}
      aria-label={`${label} PDF`}
    >
      <Icon name={loading ? 'spinner' : icon} size={14} strokeWidth={2}
        className={loading ? 'spin' : ''} />
      {label}
    </button>
  );
}

// ---------------------------------------------------------
// StatCard
// ---------------------------------------------------------
function StatCard({ label, value, cur, ngn, sub, delta }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-num tnum">
        {cur && <span className="cur">{cur}</span>}{value}
      </div>
      {ngn && <div className="stat-ngn tnum">{ngn}</div>}
      {(sub || delta) && (
        <div className="stat-sub">
          {delta && (
            <span className={'delta ' + (delta.dir || 'up')}>
              <Icon name="arrowRight" size={13} strokeWidth={2.2}
                style={{ transform: delta.dir === 'down' ? 'rotate(45deg)' : 'rotate(-45deg)' }} />
              {delta.text}
            </span>
          )}
          {sub && <span>{sub}</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------
// DataTable — sortable, hairline rows, hover, skeleton, empty
// columns: [{ key, label, num, sortable, sortVal, render }]
// ---------------------------------------------------------
function DataTable({ columns, rows, getKey, onRowClick, loading, skeletonRows = 5, emptyState, flashId }) {
  const [sort, setSort] = useState({ key: null, dir: 'asc' });

  const toggleSort = (col) => {
    if (!col.sortable) return;
    setSort((s) => s.key === col.key
      ? { key: col.key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key: col.key, dir: 'asc' });
  };

  let display = rows;
  if (sort.key) {
    const col = columns.find((c) => c.key === sort.key);
    display = [...rows].sort((a, b) => {
      const va = col.sortVal ? col.sortVal(a) : a[sort.key];
      const vb = col.sortVal ? col.sortVal(b) : b[sort.key];
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }

  if (loading) {
    return (
      <div className="table-wrap">
        <table className="dt">
          <thead><tr>{columns.map((c) => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr></thead>
          <tbody>
            {Array.from({ length: skeletonRows }).map((_, i) => (
              <tr key={i}>{columns.map((c) => (
                <td key={c.key} className={c.num ? 'num' : ''}>
                  <div className="sk" style={{ width: c.num ? '60%' : (i % 2 ? '70%' : '85%'), marginLeft: c.num ? 'auto' : 0 }} />
                </td>
              ))}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (!rows.length && emptyState) return emptyState;

  return (
    <div className="table-wrap scroll-host">
      <table className="dt">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={(c.num ? 'num ' : '') + (c.sortable ? 'sortable' : '')}
                onClick={() => toggleSort(c)}
                aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <span className="th-in" style={c.num ? { justifyContent: 'flex-end', width: '100%' } : {}}>
                  {c.label}
                  {c.sortable && sort.key === c.key && (
                    <Icon name="chevronDown" size={13} strokeWidth={2.2}
                      style={{ transform: sort.dir === 'asc' ? 'rotate(180deg)' : 'none' }} />
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
              <tr key={k}
                className={(onRowClick ? 'clickable ' : '') + (flashId === k ? 'flash' : '')}
                onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={c.num ? 'num' : ''}>{c.render(row)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------
// EmptyState
// ---------------------------------------------------------
function EmptyState({ icon, title, body, action }) {
  return (
    <div className="empty">
      <div className="ic"><Icon name={icon} size={28} strokeWidth={1.6} /></div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

// ---------------------------------------------------------
// Stepper
// ---------------------------------------------------------
function Stepper({ steps, current }) {
  return (
    <div className="stepper">
      {steps.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : '';
        return (
          <React.Fragment key={i}>
            <div className={'step ' + state}>
              <div className="step-bullet">{i < current ? <Icon name="check" size={15} strokeWidth={2.4} /> : i + 1}</div>
              <div className="step-label">{label}</div>
            </div>
            {i < steps.length - 1 && <div className={'step-line ' + (i < current ? 'done' : '')} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------
// Drawer (slide-over) — esc + backdrop close, focus trap-ish
// ---------------------------------------------------------
function Drawer({ title, sub, onClose, children, footer, wide, guard }) {
  const ref = useRef(null);
  const attemptClose = useCallback(() => {
    if (guard && guard()) return;
    onClose();
  }, [guard, onClose]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') attemptClose(); };
    document.addEventListener('keydown', onKey);
    const el = ref.current?.querySelector('input, select, textarea, button');
    el?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [attemptClose]);

  return (
    <>
      <div className="scrim" onClick={attemptClose} />
      <aside className={'drawer ' + (wide ? 'wide' : '')} ref={ref} role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer-head">
          <div>
            <h2>{title}</h2>
            {sub && <div className="sub">{sub}</div>}
          </div>
          <button className="icon-btn" onClick={attemptClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="drawer-body scroll-host">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>
  );
}

// ---------------------------------------------------------
// Modal (confirm dialogs)
// ---------------------------------------------------------
function ConfirmModal({ title, body, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="modal-pad">
          <h3>{title}</h3>
          <p>{body}</p>
          <div className="modal-foot">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className={'btn ' + (danger ? 'btn-danger' : 'btn-primary')}
              onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------
// Toast host (driven by store)
// ---------------------------------------------------------
function ToastHost({ toasts, dismiss }) {
  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} dismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}
function Toast({ toast, dismiss }) {
  useEffect(() => {
    const id = setTimeout(dismiss, 4000);
    return () => clearTimeout(id);
  }, []);
  const icon = toast.type === 'error' ? 'alert' : toast.type === 'info' ? 'info' : 'check';
  return (
    <div className={'toast ' + (toast.type || 'success')} role="status">
      <span className="tic"><Icon name={icon} size={18} strokeWidth={2.2} /></span>
      <span className="tx">{toast.message}</span>
      <button className="tclose" onClick={dismiss} aria-label="Dismiss"><Icon name="x" size={15} /></button>
    </div>
  );
}

// ---------------------------------------------------------
// Field — label + control + error/hint
// ---------------------------------------------------------
function Field({ label, required, hint, error, ok, checking, children }) {
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

// ---------------------------------------------------------
// LiveCalc — read-only computed figure with accent tint
// ---------------------------------------------------------
function LiveCalc({ label, value, unit, foot, flashKey }) {
  const numRef = useRef(null);
  useEffect(() => {
    const el = numRef.current;
    if (!el) return;
    el.classList.remove('lc-flash');
    void el.offsetWidth;
    el.classList.add('lc-flash');
  }, [flashKey]);
  return (
    <div className="live-calc">
      <div className="lc-label"><Icon name="gauge" size={14} strokeWidth={2} /> {label}</div>
      <div className="lc-num tnum" ref={numRef}>{value}{unit && <span className="lc-unit">{unit}</span>}</div>
      {foot && <div className="lc-foot">{foot}</div>}
    </div>
  );
}

Object.assign(window, {
  StatusBadge, CargoTag, Money, PdfButton, StatCard, DataTable,
  EmptyState, Stepper, Drawer, ConfirmModal, ToastHost, Field, LiveCalc,
});
