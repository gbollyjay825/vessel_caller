/* global React, Icon, StatusBadge, CargoTag, Money, PdfButton, StatCard, DataTable, EmptyState, Drawer, ConfirmModal, Field, VESSEL_TYPES, fmtUSD, fmtNGN, fmtNum, fmtTons, fmtDate, fmtDateTime, calcDues, calcCommission */
const { useState: useStateOps, useEffect: useEffectOps, useMemo, useRef: useRefOps } = React;

// =========================================================
// Dashboard
// =========================================================
function Dashboard({ store }) {
  const { calls } = store;
  const monthLabel = 'June 2026';
  const [chartsShown, setChartsShown] = useStateOps(false);
  useEffectOps(() => { const id = setTimeout(() => setChartsShown(true), 40); return () => clearTimeout(id); }, []);
  const pms = PRODUCTS.find((p) => p.key === 'PMS');
  const pmsPct = (pms.tonnage / AN_TOTALS.throughput * 100).toFixed(0);
  const pmsMonthly = AN_SERIES.map((d) => Math.round(d.liquidT * pms.share));

  const kpis = useMemo(() => {
    const active = calls.filter((c) => c.status === 'pending' || c.status === 'in-progress').length;
    const insThisMonth = store.inspections.filter((i) => i.date && i.date.startsWith('2026-06')).length;
    let duesCollected = 0, commUsd = 0, commNgn = 0;
    store.invoices.forEach((iv) => {
      const f = store.financialsForCall(store.calls.find((c) => c.id === iv.callId));
      if (!f) return;
      if (iv.status === 'paid') duesCollected += f.dues;
      commUsd += f.commissionUsd; commNgn += f.commissionNgn;
    });
    return { active, insThisMonth, duesCollected, commUsd, commNgn };
  }, [calls, store.invoices, store.inspections, store.settings]);

  const recent = useMemo(
    () => [...calls].sort((a, b) => new Date(b.registered) - new Date(a.registered)).slice(0, 6),
    [calls]
  );

  const columns = [
    { key: 'vesselName', label: 'Vessel Name', sortable: true,
      render: (r) => (<div><div className="cell-primary">{r.vesselName}</div><div className="cell-sub">{r.flag}</div></div>) },
    { key: 'reference', label: 'Call Reference', render: (r) => <span className="mono-ref">{r.reference}</span> },
    { key: 'type', label: 'Type', sortable: true, render: (r) => <span className="muted">{r.type}</span> },
    { key: 'status', label: 'Status', sortable: true, sortVal: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    { key: 'berthDate', label: 'Berth Date', sortable: true, sortVal: (r) => r.berthDate || '', render: (r) => <span className="tnum muted">{r.berthDate ? fmtDate(r.berthDate) : '—'}</span> },
    { key: 'dues', label: 'Dues', num: true, sortable: true, sortVal: (r) => store.financialsForCall(r)?.dues || 0,
      render: (r) => { const f = store.financialsForCall(r); return f ? <span className="money tnum"><span className="usd">{fmtUSD(f.dues)}</span></span> : <span className="muted">—</span>; } },
    { key: 'actions', label: '', num: true, render: (r) => <RowActions store={store} call={r} /> },
  ];

  return (
    <div className={'content-inner' + (chartsShown ? ' charts-in' : '')}>
      <div className="page-head">
        <div>
          <h1 className="hide-sr">Dashboard</h1>
          <p className="desc">What's happening at the Port of Calabar right now.</p>
        </div>
        <button className="btn btn-primary" onClick={() => store.navigate('vessel-calls', { register: true })}>
          <Icon name="plus" size={17} strokeWidth={2.2} /> Register Vessel Call
        </button>
      </div>

      {calls.length === 0 ? (
        <EmptyState icon="ship" title="No vessel calls yet"
          body="Register the first incoming vessel to get started."
          action={<button className="btn btn-primary" onClick={() => store.navigate('vessel-calls', { register: true })}><Icon name="plus" size={17} strokeWidth={2.2} /> Register Vessel Call</button>} />
      ) : (
        <>
          <div className="kpi-strip">
            <StatCard label="Active Vessel Calls" value={kpis.active} delta={{ dir: 'up', text: '+2' }} sub="vs last week" />
            <StatCard label="Inspections This Month" value={kpis.insThisMonth} delta={{ dir: 'up', text: '+1' }} sub={monthLabel} />
            <StatCard label="Harbour Dues Collected" value={fmtUSD(kpis.duesCollected, 0).replace('$', '')} cur="$" sub={monthLabel} />
            <StatCard label="Commission Earned" value={fmtUSD(kpis.commUsd, 0).replace('$', '')} cur="$" ngn={fmtNGN(kpis.commNgn)} sub={monthLabel} />
          </div>

          <div className="an-grid section-gap">
            <div className="card card-pad">
              <div className="card-head" style={{ padding: 0, border: 'none', marginBottom: 4 }}>
                <div>
                  <div className="card-title">Cargo throughput · last 12 months</div>
                  <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{fmtCompactMT(AN_TOTALS.liquidT)} MT liquid</span> · {fmtCompactMT(AN_TOTALS.dryT)} MT dry
                  </div>
                </div>
                <button className="link-btn" onClick={() => store.navigate('analytics')}>Full analytics <Icon name="chevronRight" size={14} strokeWidth={2.2} style={{ verticalAlign: '-2px' }} /></button>
              </div>
              <div className="chart-legend" style={{ marginTop: 8 }}>
                <span className="cl"><span className="sw" style={{ background: '#1B5FAA' }} /> Liquid (PMS · AGO · DPK)</span>
                <span className="cl"><span className="sw" style={{ background: '#D9A441' }} /> Dry / bulk</span>
              </div>
              <AreaTrend series={AN_SERIES} />
            </div>

            <div className="spotlight">
              <div className="sl-eyebrow"><Icon name="droplet" size={14} strokeWidth={2} /> PMS · Premium Motor Spirit</div>
              <div className="sl-num tnum">{fmtCompactMT(pms.tonnage)}<span className="sl-unit">MT</span></div>
              <div className="sl-sub">{pmsPct}% of all cargo through Calabar · last 12 months</div>
              <div className="sl-divide" />
              <div className="sl-row"><span className="l">Revenue from PMS</span><span className="v tnum">{fmtCompactUSD(pms.revenue)}</span></div>
              <div className="sl-spark"><MiniSpark values={pmsMonthly} color="#FFFFFF" w={260} h={42} /></div>
            </div>
          </div>

          <div className="card section-gap">
            <div className="card-head">
              <div className="card-title">Recent Vessel Calls</div>
              <button className="link-btn" onClick={() => store.navigate('vessel-calls')}>View all <Icon name="chevronRight" size={14} strokeWidth={2.2} style={{ verticalAlign: '-2px' }} /></button>
            </div>
            <DataTable columns={columns} rows={recent} getKey={(r) => r.id} flashId={store.flashId}
              onRowClick={(r) => store.navigate('vessel-call-detail', { id: r.id })} />
          </div>
        </>
      )}
    </div>
  );
}

// Inline row actions: completed -> Invoice + Report; else -> Open
function RowActions({ store, call }) {
  if (call.status === 'completed') {
    const f = store.financialsForCall(call);
    const rec = pdfRecord(store, call);
    return (
      <div className="cell-actions">
        <PdfButton kind="invoice" record={rec} disabled={!f} />
        <PdfButton kind="report" record={rec} disabled={!f} />
      </div>
    );
  }
  return (
    <div className="cell-actions">
      <button className="link-btn" onClick={(e) => { e.stopPropagation(); store.navigate('vessel-call-detail', { id: call.id }); }}>
        Open <Icon name="chevronRight" size={14} strokeWidth={2.2} style={{ verticalAlign: '-2px' }} />
      </button>
    </div>
  );
}

// build the query-param record a PDF page needs
function pdfRecord(store, call) {
  const f = store.financialsForCall(call);
  const insp = store.inspectionsForCall(call.id).find((i) => i.status === 'completed');
  const inv = store.invoiceForCall(call.id);
  return {
    vessel: call.vesselName, callRef: call.reference, type: call.type, flag: call.flag,
    nrt: String(call.nrt), berth: call.berth || '', date: insp?.date || call.berthDate || '',
    invoiceNo: inv?.invoiceNo || '—', dueDate: inv?.due || '',
    cargoType: insp?.cargoType || '—', tonnage: insp ? String(insp.reconciledTonnage) : '0',
    dues: String(f?.dues || 0), commRate: String(store.settings.commissionRate),
    commUsd: String(f?.commissionUsd || 0), commNgn: String(f?.commissionNgn || 0),
    fx: String(store.settings.exchangeRate), port: store.settings.portName,
  };
}

// =========================================================
// Vessel Calls — list
// =========================================================
function VesselCalls({ store }) {
  const [query, setQuery] = useStateOps('');
  const [statusFilter, setStatusFilter] = useStateOps('all');
  const [registerOpen, setRegisterOpen] = useStateOps(!!store.route.params.register);

  useEffectOps(() => { if (store.route.params.register) setRegisterOpen(true); }, [store.route.params.register]);

  const filtered = useMemo(() => {
    return store.calls.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        return c.vesselName.toLowerCase().includes(q) || c.reference.toLowerCase().includes(q);
      }
      return true;
    }).sort((a, b) => new Date(b.registered) - new Date(a.registered));
  }, [store.calls, query, statusFilter]);

  const columns = [
    { key: 'vesselName', label: 'Vessel Name', sortable: true,
      render: (r) => <div className="cell-primary">{r.vesselName}</div> },
    { key: 'reference', label: 'Reference', render: (r) => <span className="mono-ref">{r.reference}</span> },
    { key: 'type', label: 'Type', sortable: true, render: (r) => <span className="muted">{r.type}</span> },
    { key: 'flag', label: 'Flag', render: (r) => <span className="muted">{r.flag}</span> },
    { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusBadge status={r.status} /> },
    { key: 'eta', label: 'ETA / Berth', sortable: true, sortVal: (r) => r.eta,
      render: (r) => (<div><div className="tnum">{fmtDate(r.eta)}</div><div className="cell-sub tnum">{r.berthDate ? 'Berthed ' + fmtDate(r.berthDate) : 'ETA ' + new Date(r.eta).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div></div>) },
    { key: 'dues', label: 'Dues', num: true, sortable: true, sortVal: (r) => store.financialsForCall(r)?.dues || 0,
      render: (r) => { const f = store.financialsForCall(r); return f ? <span className="money tnum"><span className="usd">{fmtUSD(f.dues)}</span></span> : <span className="muted">—</span>; } },
    { key: 'actions', label: '', num: true, render: (r) => <RowActions store={store} call={r} /> },
  ];

  const STATUSES = [['all', 'All'], ['pending', 'Pending'], ['in-progress', 'In progress'], ['completed', 'Completed']];

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <h1 className="hide-sr">Vessel Calls</h1>
          <p className="desc">Every incoming vessel call at the Port of Calabar.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setRegisterOpen(true)}>
          <Icon name="plus" size={17} strokeWidth={2.2} /> Register Vessel Call
        </button>
      </div>

      <div className="filter-bar">
        <div className="search-input">
          <Icon name="search" size={17} />
          <input type="text" placeholder="Search vessel name or reference…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search vessel calls" />
        </div>
        <div className="seg" role="tablist" aria-label="Filter by status">
          {STATUSES.map(([k, l]) => (
            <button key={k} className={statusFilter === k ? 'on' : ''} onClick={() => setStatusFilter(k)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="card">
        <DataTable columns={columns} rows={filtered} getKey={(r) => r.id} flashId={store.flashId}
          onRowClick={(r) => store.navigate('vessel-call-detail', { id: r.id })}
          emptyState={<EmptyState icon="search" title="No matching vessel calls" body="Try a different search term or status filter." />} />
      </div>

      {registerOpen && <RegisterCall store={store} onClose={() => { setRegisterOpen(false); store.navigate('vessel-calls'); }} />}
    </div>
  );
}

// =========================================================
// Register Vessel Call — slide-over
// =========================================================
function RegisterCall({ store, onClose, lockedCallId }) {
  const nextRef = useMemo(() => {
    const nums = store.calls.map((c) => parseInt(c.reference.split('-')[2], 10)).filter((n) => !isNaN(n));
    const next = (Math.max(0, ...nums) + 1).toString().padStart(4, '0');
    return `ROT-2026-${next}`;
  }, []);

  const [form, setForm] = useStateOps({ vesselName: '', reference: nextRef, type: 'Tanker', flag: '', nrt: '', eta: '', berth: store.settings.terminals[0], notes: '' });
  const [errors, setErrors] = useStateOps({});
  const [refStatus, setRefStatus] = useStateOps('idle'); // idle | checking | ok | taken
  const [submitting, setSubmitting] = useStateOps(false);
  const [dirty, setDirty] = useStateOps(false);

  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setDirty(true); };

  // async uniqueness check on reference
  useEffectOps(() => {
    if (!form.reference) { setRefStatus('idle'); return; }
    setRefStatus('checking');
    const id = setTimeout(() => {
      const taken = store.calls.some((c) => c.reference.toLowerCase() === form.reference.toLowerCase());
      setRefStatus(taken ? 'taken' : 'ok');
    }, 650);
    return () => clearTimeout(id);
  }, [form.reference]);

  const validate = () => {
    const e = {};
    if (!form.vesselName.trim()) e.vesselName = 'Vessel name is required.';
    if (!form.reference.trim()) e.reference = 'Call reference is required.';
    else if (refStatus === 'taken') e.reference = 'This reference is already in use.';
    if (!form.nrt || Number(form.nrt) <= 0) e.nrt = 'Net registered tonnage is required.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = () => {
    if (!validate()) return;
    setSubmitting(true);
    setTimeout(() => {
      const id = store.addCall({
        vesselName: form.vesselName.trim(), reference: form.reference.trim(), type: form.type,
        flag: form.flag.trim() || '—', nrt: Number(form.nrt), eta: form.eta || new Date().toISOString().slice(0, 16),
        berth: form.berth, status: 'pending', notes: form.notes.trim(),
      });
      store.toast(`Vessel call ${form.reference.trim()} registered`, 'success');
      setSubmitting(false);
      onClose();
      store.navigate('vessel-calls', { flash: id });
    }, 700);
  };

  const guard = () => dirty && !submitting && !window.confirm('Discard this vessel call? Your entered details will be lost.');

  return (
    <Drawer title="Register Vessel Call" sub="Log an incoming vessel and its particulars." onClose={onClose} guard={guard}
      footer={<>
        <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={submitting || refStatus === 'checking'}>
          {submitting ? <><Icon name="spinner" size={16} className="spin" strokeWidth={2} /> Registering…</> : 'Register Call'}
        </button>
      </>}>
      <Field label="Vessel name" required error={errors.vesselName}>
        <input type="text" className={errors.vesselName ? 'invalid' : ''} value={form.vesselName}
          placeholder="e.g. MT Sea Eagle" onChange={(e) => set('vesselName', e.target.value)}
          onBlur={() => !form.vesselName.trim() && setErrors((x) => ({ ...x, vesselName: 'Vessel name is required.' }))} />
      </Field>

      <Field label="Call reference" required hint="Auto-suggested. Editable; must be unique."
        error={errors.reference || (refStatus === 'taken' ? 'This reference is already in use.' : null)}
        ok={refStatus === 'ok' && !errors.reference ? 'Reference is available.' : null}
        checking={refStatus === 'checking' ? 'Checking availability…' : null}>
        <input type="text" className={(errors.reference || refStatus === 'taken') ? 'invalid' : ''} value={form.reference}
          onChange={(e) => set('reference', e.target.value.toUpperCase())} />
      </Field>

      <div className="field-row">
        <Field label="Vessel type">
          <select value={form.type} onChange={(e) => set('type', e.target.value)}>
            {VESSEL_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Flag / registry">
          <input type="text" value={form.flag} placeholder="e.g. Liberia" onChange={(e) => set('flag', e.target.value)} />
        </Field>
      </div>

      <Field label="Net registered tonnage" required hint="Drives the NPA harbour-dues calculation." error={errors.nrt}>
        <input type="number" className={errors.nrt ? 'invalid' : ''} value={form.nrt} placeholder="e.g. 57137"
          onChange={(e) => set('nrt', e.target.value)} min="0" />
      </Field>

      <div className="field-row">
        <Field label="ETA">
          <input type="datetime-local" value={form.eta} onChange={(e) => set('eta', e.target.value)} />
        </Field>
        <Field label="Berth / terminal">
          <select value={form.berth} onChange={(e) => set('berth', e.target.value)}>
            {store.settings.terminals.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Notes" hint="Optional. Pilotage, cargo notes, special handling.">
        <textarea value={form.notes} placeholder="Anything the berth team should know…" onChange={(e) => set('notes', e.target.value)} />
      </Field>
    </Drawer>
  );
}

// =========================================================
// Vessel Call detail
// =========================================================
function VesselCallDetail({ store }) {
  const call = store.calls.find((c) => c.id === store.route.params.id);
  const [confirmDel, setConfirmDel] = useStateOps(false);
  if (!call) return <div className="content-inner"><p className="muted">Vessel call not found.</p></div>;

  const f = store.financialsForCall(call);
  const inspections = store.inspectionsForCall(call.id);
  const completedInsp = inspections.find((i) => i.status === 'completed');
  const rec = pdfRecord(store, call);

  const inspColumns = [
    { key: 'date', label: 'Date', render: (r) => <span className="tnum">{fmtDate(r.date)}</span> },
    { key: 'reference', label: 'Reference', render: (r) => <span className="mono-ref">{r.reference}</span> },
    { key: 'cargoType', label: 'Cargo', render: (r) => <CargoTag type={r.cargoType} /> },
    { key: 'reconciledTonnage', label: 'Reconciled tonnage', num: true, render: (r) => <span className="tnum">{r.status === 'draft' ? '—' : fmtTons(r.reconciledTonnage)}</span> },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div className="content-inner">
      <button className="link-btn" style={{ marginBottom: 16 }} onClick={() => store.navigate('vessel-calls')}>
        <Icon name="chevronLeft" size={15} strokeWidth={2.2} style={{ verticalAlign: '-3px' }} /> Vessel Calls
      </button>

      <div className="page-head" style={{ marginBottom: 24 }}>
        <div>
          <div className="flex items-center gap-3 wrap">
            <h1>{call.vesselName}</h1>
            <StatusBadge status={call.status} />
          </div>
          <p className="desc" style={{ marginTop: 6 }}>
            <span className="mono-ref">{call.reference}</span> &nbsp;·&nbsp; {call.type} &nbsp;·&nbsp; {call.flag}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-secondary btn-sm" onClick={() => store.navigate('new-inspection', { callId: call.id })}>
            <Icon name="plus" size={16} strokeWidth={2.2} /> Add Inspection
          </button>
          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => setConfirmDel(true)}>
            <Icon name="trash" size={16} /> Cancel call
          </button>
        </div>
      </div>

      <TrackVessel call={call} />

      <div className="card card-pad section-gap">
        <div className="card-title" style={{ marginBottom: 20 }}>Vessel particulars</div>
        <div className="kv-grid">
          <div className="kv"><div className="k">Net registered tonnage</div><div className="v tnum">{fmtNum(call.nrt)} NRT</div></div>
          <div className="kv"><div className="k">Flag / registry</div><div className="v">{call.flag}</div></div>
          <div className="kv"><div className="k">Vessel type</div><div className="v">{call.type}</div></div>
          <div className="kv"><div className="k">Berth / terminal</div><div className="v">{call.berth || '—'}</div></div>
          <div className="kv"><div className="k">ETA</div><div className="v tnum">{fmtDateTime(call.eta)}</div></div>
          <div className="kv"><div className="k">Berth date</div><div className="v tnum">{call.berthDate ? fmtDate(call.berthDate) : 'Not yet berthed'}</div></div>
          <div className="kv"><div className="k">Registered</div><div className="v tnum">{fmtDateTime(call.registered)}</div></div>
        </div>
        {call.notes && (<div style={{ marginTop: 20, paddingTop: 20, borderTop: '1px solid var(--hairline)' }}>
          <div className="k" style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--slate)' }}>Notes</div>
          <p style={{ marginTop: 6, color: 'var(--ink)' }}>{call.notes}</p>
        </div>)}
      </div>

      <div className="card section-gap">
        <div className="card-head">
          <div className="card-title">Inspections on this call</div>
          <button className="btn btn-secondary btn-sm" onClick={() => store.navigate('new-inspection', { callId: call.id })}>
            <Icon name="plus" size={16} strokeWidth={2.2} /> Add Inspection
          </button>
        </div>
        {inspections.length ? (
          <DataTable columns={inspColumns} rows={inspections} getKey={(r) => r.id}
            onRowClick={(r) => store.navigate('inspections', { focus: r.id })} />
        ) : (
          <div style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--slate)' }}>
            No inspections logged on this call yet.
          </div>
        )}
      </div>

      {completedInsp && f && (
        <div className="card card-pad section-gap">
          <div className="card-title" style={{ marginBottom: 18 }}>Financials</div>
          <div style={{ maxWidth: 480 }}>
            <div className="fin-row">
              <div className="fl">NPA harbour dues<span className="basis">{fmtNum(call.nrt)} NRT × {fmtUSD(store.settings.duesRatePerTon)}/ton</span></div>
              <div className="fv">{fmtUSD(f.dues)}</div>
            </div>
            <div className="fin-row">
              <div className="fl">Commission rate</div>
              <div className="fv">{store.settings.commissionRate}%</div>
            </div>
            <div className="fin-row">
              <div className="fl">Agency commission<span className="basis">at ₦{fmtNum(store.settings.exchangeRate)}/USD</span></div>
              <div className="fv">{fmtUSD(f.commissionUsd)} <span style={{ color: 'var(--slate)', fontWeight: 500 }}>· {fmtNGN(f.commissionNgn)}</span></div>
            </div>
            <div className="fin-total">
              <div className="fl">Invoice total</div>
              <div className="fv tnum">{fmtUSD(f.dues)}<span className="ngn">{fmtNGN(f.dues * store.settings.exchangeRate)}</span></div>
            </div>
          </div>
          <div className="flex gap-3 mt-6">
            <button className="btn btn-primary" onClick={() => openPdf('invoice', rec)}><Icon name="receipt" size={17} strokeWidth={2} /> View &amp; download invoice</button>
            <button className="btn btn-secondary" onClick={() => openPdf('report', rec)}><Icon name="fileText" size={17} strokeWidth={2} /> View &amp; download inspection report</button>
          </div>
        </div>
      )}

      {confirmDel && (
        <ConfirmModal title="Cancel this vessel call?"
          body={`This will remove ${call.vesselName} (${call.reference}) and any linked draft inspections. This cannot be undone.`}
          confirmLabel="Cancel call" danger
          onConfirm={() => { store.deleteCall(call.id); store.toast(`${call.reference} cancelled`, 'info'); store.navigate('vessel-calls'); }}
          onClose={() => setConfirmDel(false)} />
      )}
    </div>
  );
}

function openPdf(kind, record) {
  const params = new URLSearchParams({ doc: kind, ...record }).toString();
  window.open('calabar/pdf.html?' + params, '_blank', 'noopener');
}

// =========================================================
// Invoices
// =========================================================
function Invoices({ store }) {
  const [query, setQuery] = useStateOps('');
  const [statusFilter, setStatusFilter] = useStateOps('all');
  const [detail, setDetail] = useStateOps(null);

  const rows = useMemo(() => {
    return store.invoices.map((iv) => {
      const call = store.calls.find((c) => c.id === iv.callId);
      const insp = store.inspections.find((i) => i.id === iv.inspectionId);
      const f = store.financialsForCall(call);
      return { ...iv, call, cargoType: insp?.cargoType || null, dues: f?.dues || 0, commissionUsd: f?.commissionUsd || 0, commissionNgn: f?.commissionNgn || 0 };
    }).filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (query) { const q = query.toLowerCase(); return r.invoiceNo.toLowerCase().includes(q) || r.vesselName.toLowerCase().includes(q); }
      return true;
    }).sort((a, b) => new Date(b.issued) - new Date(a.issued));
  }, [store.invoices, store.calls, query, statusFilter]);

  const columns = [
    { key: 'invoiceNo', label: 'Invoice No.', sortable: true, render: (r) => <span className="cell-primary mono-ref" style={{ color: 'var(--ink)', fontWeight: 600 }}>{r.invoiceNo}</span> },
    { key: 'vesselName', label: 'Vessel', sortable: true, render: (r) => r.vesselName },
    { key: 'callRef', label: 'Call Reference', render: (r) => <span className="mono-ref">{r.callRef}</span> },
    { key: 'cargoType', label: 'Cargo', render: (r) => r.cargoType ? <CargoTag type={r.cargoType} /> : <span className="muted">—</span> },
    { key: 'dues', label: 'Amount (USD)', num: true, sortable: true, render: (r) => <span className="money tnum"><span className="usd">{fmtUSD(r.dues)}</span></span> },
    { key: 'commissionUsd', label: 'Commission', num: true, render: (r) => <span className="money tnum"><span className="usd">{fmtUSD(r.commissionUsd)}</span><span className="ngn">{fmtNGN(r.commissionNgn)}</span></span> },
    { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusBadge status={r.status} /> },
    { key: 'issued', label: 'Issued', sortable: true, sortVal: (r) => r.issued, render: (r) => <span className="tnum muted">{fmtDate(r.issued)}</span> },
    { key: 'actions', label: '', num: true, render: (r) => (
      <div className="cell-actions">
        <PdfButton kind="invoice" record={pdfRecord(store, r.call)} />
        <PdfButton kind="report" record={pdfRecord(store, r.call)} />
      </div>) },
  ];

  const STATUSES = [['all', 'All'], ['paid', 'Paid'], ['unpaid', 'Unpaid'], ['overdue', 'Overdue']];

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <h1 className="hide-sr">Invoices</h1>
          <p className="desc">Harbour-dues invoices generated from completed inspections.</p>
        </div>
      </div>

      <div className="filter-bar">
        <div className="search-input">
          <Icon name="search" size={17} />
          <input type="text" placeholder="Search invoice no. or vessel…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search invoices" />
        </div>
        <div className="seg" role="tablist" aria-label="Filter by status">
          {STATUSES.map(([k, l]) => <button key={k} className={statusFilter === k ? 'on' : ''} onClick={() => setStatusFilter(k)}>{l}</button>)}
        </div>
      </div>

      <div className="card">
        <DataTable columns={columns} rows={rows} getKey={(r) => r.id} onRowClick={(r) => setDetail(r)}
          emptyState={<EmptyState icon="invoice" title="No invoices found" body="Invoices appear here once an inspection is completed." />} />
        {/* mobile cards */}
        <div className="m-cards" style={{ padding: 16 }}>
          {rows.map((r) => (
            <div className="m-card" key={r.id} onClick={() => setDetail(r)}>
              <div className="mc-top">
                <div><div className="mc-title">{r.vesselName}</div><div className="mc-sub mono-ref">{r.invoiceNo}{r.cargoType ? ' · ' + r.cargoType : ''}</div></div>
                <StatusBadge status={r.status} />
              </div>
              <div className="mc-amt tnum">{fmtUSD(r.dues)}<span className="ngn">Commission {fmtUSD(r.commissionUsd)} · {fmtNGN(r.commissionNgn)}</span></div>
              <div className="mc-actions" onClick={(e) => e.stopPropagation()}>
                <PdfButton kind="invoice" record={pdfRecord(store, r.call)} />
                <PdfButton kind="report" record={pdfRecord(store, r.call)} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {detail && <InvoiceDetail store={store} row={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function InvoiceDetail({ store, row, onClose }) {
  const call = row.call;
  const rec = pdfRecord(store, call);
  return (
    <Drawer title={row.invoiceNo} sub={`${row.vesselName} · ${row.callRef}`} onClose={onClose}
      footer={<>
        <button className="btn btn-secondary" onClick={() => openPdf('report', rec)}><Icon name="fileText" size={16} strokeWidth={2} /> Report</button>
        <button className="btn btn-primary" onClick={() => openPdf('invoice', rec)}><Icon name="receipt" size={16} strokeWidth={2} /> Open invoice</button>
      </>}>
      <div className="flex between items-center" style={{ marginBottom: 20 }}>
        <StatusBadge status={row.status} />
        <span className="muted" style={{ fontSize: 13 }}>Issued {fmtDate(row.issued)} · Due {fmtDate(row.due)}</span>
      </div>
      <div className="card-title" style={{ marginBottom: 14 }}>Line-item breakdown</div>
      <div className="fin-row"><div className="fl">Cargo / product type</div><div className="fv">{row.cargoType ? <CargoTag type={row.cargoType} /> : '—'}</div></div>
      <div className="fin-row"><div className="fl">Net registered tonnage<span className="basis">dues basis</span></div><div className="fv tnum">{fmtNum(call.nrt)} NRT</div></div>
      <div className="fin-row"><div className="fl">Dues rate</div><div className="fv tnum">{fmtUSD(store.settings.duesRatePerTon)} / ton</div></div>
      <div className="fin-row"><div className="fl">NPA harbour dues</div><div className="fv tnum">{fmtUSD(row.dues)}</div></div>
      <div className="fin-row"><div className="fl">Agency commission<span className="basis">{store.settings.commissionRate}% · ₦{fmtNum(store.settings.exchangeRate)}/USD</span></div><div className="fv tnum">{fmtUSD(row.commissionUsd)} · {fmtNGN(row.commissionNgn)}</div></div>
      <div className="fin-total"><div className="fl">Invoice total</div><div className="fv tnum">{fmtUSD(row.dues)}<span className="ngn">{fmtNGN(row.dues * store.settings.exchangeRate)}</span></div></div>
    </Drawer>
  );
}

Object.assign(window, { Dashboard, VesselCalls, VesselCallDetail, Invoices, RegisterCall, pdfRecord, openPdf });
