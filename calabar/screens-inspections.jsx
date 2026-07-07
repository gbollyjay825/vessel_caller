/* global React, Icon, StatusBadge, CargoTag, Money, PdfButton, DataTable, EmptyState, Stepper, Field, LiveCalc, fmtUSD, fmtNGN, fmtNum, fmtTons, fmtDate, calcDues, calcCommission, calcPreview, rateForInspection, pdfRecord, openPdf */
const { useState: useStateIns, useMemo: useMemoIns, useRef: useRefIns } = React;

// ---- reconciled-tonnage maths (mirrors server) ----
function vcf(temp) { return 1 - ((Number(temp) || 15) - 15) * 0.00065; } // volume correction to 15°C
function computeReconciled(cargoType, m) {
  if (cargoType === 'Liquid') {
    // Liquid cargo is reconciled by the surveyor and entered directly.
    return Math.round((Number(m.surveyorTonnage) || 0) * 100) / 100;
  }
  const before = Number(m.displBefore) || 0, after = Number(m.displAfter) || 0;
  const ded = Number(m.deductibles) || 0, con = Number(m.constant) || 0;
  return Math.round((before - after - ded + con) * 100) / 100;
}

// =========================================================
// Inspections — list
// =========================================================
function Inspections({ store }) {
  const [query, setQuery] = useStateIns('');
  const [cargoFilter, setCargoFilter] = useStateIns('all');

  const rows = useMemoIns(() => store.inspections
    .filter((i) => {
      if (cargoFilter !== 'all' && i.cargoType !== cargoFilter) return false;
      if (query) { const q = query.toLowerCase(); return i.reference.toLowerCase().includes(q) || i.vesselName.toLowerCase().includes(q); }
      return true;
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date)), [store.inspections, query, cargoFilter]);

  const columns = [
    { key: 'reference', label: 'Reference', sortable: true, render: (r) => <span className="cell-primary mono-ref" style={{ color: 'var(--ink)', fontWeight: 600 }}>{r.reference}</span> },
    { key: 'vesselName', label: 'Vessel', sortable: true, render: (r) => r.vesselName },
    { key: 'cargoType', label: 'Cargo Type', render: (r) => <CargoTag type={r.cargoType} /> },
    { key: 'reconciledTonnage', label: 'Reconciled Tonnage', num: true, sortable: true, render: (r) => <span className="tnum">{r.status === 'draft' ? '—' : fmtTons(r.reconciledTonnage)}</span> },
    { key: 'date', label: 'Date', sortable: true, sortVal: (r) => r.date, render: (r) => <span className="tnum muted">{fmtDate(r.date)}</span> },
    { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusBadge status={r.status} /> },
    { key: 'actions', label: '', num: true, render: (r) => (
      <div className="cell-actions">
        {r.status === 'completed'
          ? <PdfButton kind="report" record={pdfRecord(store, store.calls.find((c) => c.id === r.callId))} />
          : <button className="link-btn" onClick={() => store.navigate('new-inspection', { callId: r.callId, resume: r.id })}>Resume <Icon name="chevronRight" size={14} strokeWidth={2.2} style={{ verticalAlign: '-2px' }} /></button>}
      </div>) },
  ];

  const FILTERS = [['all', 'All'], ['Liquid', 'Liquid'], ['Dry', 'Dry']];

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <h1 className="hide-sr">Inspections</h1>
          <p className="desc">Liquid and dry cargo inspections logged against vessel calls.</p>
        </div>
        <button className="btn btn-primary" disabled={!store.can('addInspection')}
          title={store.can('addInspection') ? undefined : 'Requires the Admin or Operations role'}
          onClick={() => store.navigate('new-inspection', {})}>
          <Icon name="plus" size={17} strokeWidth={2.2} /> New Inspection
        </button>
      </div>

      <div className="filter-bar">
        <div className="search-input">
          <Icon name="search" size={17} />
          <input type="text" placeholder="Search reference or vessel…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search inspections" />
        </div>
        <div className="seg" role="tablist" aria-label="Filter by cargo type">
          {FILTERS.map(([k, l]) => <button key={k} className={cargoFilter === k ? 'on' : ''} onClick={() => setCargoFilter(k)}>{l}</button>)}
        </div>
      </div>

      <div className="card">
        <DataTable columns={columns} rows={rows} getKey={(r) => r.id} flashId={store.flashId}
          emptyState={<EmptyState icon="clipboard" title="No inspections yet" body="Start an inspection from a vessel call or create a new one." action={<button className="btn btn-primary" onClick={() => store.navigate('new-inspection', {})}><Icon name="plus" size={17} strokeWidth={2.2} /> New Inspection</button>} />} />
      </div>
    </div>
  );
}

// =========================================================
// New Inspection — 3-step wizard
// =========================================================
const WIZARD_STEPS = ['Link & type', 'Cargo measurement', 'Review & submit'];

function NewInspection({ store }) {
  const lockedCallId = store.route.params.callId;
  const [step, setStep] = useStateIns(0);
  const [callId, setCallId] = useStateIns(lockedCallId || '');
  const [cargoType, setCargoType] = useStateIns(lockedCallId ? '' : '');
  const [liquid, setLiquid] = useStateIns({ ullage: '', observedVol: '', temp: '', blQty: '', surveyorTonnage: '', jettyType: '', jettyCategory: '', jettyName: '' });
  const [dry, setDry] = useStateIns({ displBefore: '', displAfter: '', deductibles: '', constant: '0' });
  const [submitted, setSubmitted] = useStateIns(null); // {inspection, invoice, call}
  const [submitting, setSubmitting] = useStateIns(false);

  const call = store.calls.find((c) => c.id === callId);
  const measure = cargoType === 'Liquid' ? liquid : dry;
  const reconciled = useMemoIns(() => computeReconciled(cargoType, measure), [cargoType, liquid, dry]);
  const previewRate = rateForInspection(
    { cargoType, jetty: { type: liquid.jettyType, category: liquid.jettyType === 'Local' ? liquid.jettyCategory : null } },
    store.settings
  );
  const preview = call ? calcPreview(call.nrt, previewRate, store.settings) : null;

  const jettyOk = cargoType !== 'Liquid' || liquid.jettyType === 'International' || (liquid.jettyType === 'Local' && liquid.jettyCategory);
  const canNext0 = callId && cargoType;
  const canNext1 = reconciled > 0 && jettyOk;

  // ---- success screen ----
  if (submitted) {
    // Financials are snapshotted at submit time so a cross-tab write can
    // never null them out from under this screen.
    const { inspection, call: sc, financials: f } = submitted;
    const rec = pdfRecord(store, sc);
    return (
      <div className="content-inner">
        <div className="success-wrap">
          <div className="success-check"><Icon name="check" size={38} strokeWidth={2.4} /></div>
          <h2>Inspection submitted</h2>
          <p>{inspection.reference} for {sc.vesselName} has been recorded and the invoice generated.</p>

          <div className="card card-pad result-card">
            <div className="fin-row"><div className="fl">Reconciled tonnage</div><div className="fv tnum">{fmtTons(inspection.reconciledTonnage)}</div></div>
            <div className="fin-row"><div className="fl">NPA harbour dues</div><div className="fv tnum">{fmtUSD(f.dues)}</div></div>
            <div className="fin-row"><div className="fl">Commission · {store.settings.commissionRate}%</div><div className="fv tnum">{fmtUSD(f.commissionUsd)} <span style={{ color: 'var(--slate)', fontWeight: 500 }}>· {fmtNGN(f.commissionNgn)}</span></div></div>
          </div>

          <div className="success-actions">
            <button className="btn btn-primary" onClick={() => openPdf('invoice', rec)}><Icon name="receipt" size={17} strokeWidth={2} /> View &amp; download invoice</button>
            <button className="btn btn-secondary" onClick={() => openPdf('report', rec)}><Icon name="fileText" size={17} strokeWidth={2} /> View &amp; download report</button>
          </div>
          <button className="link-btn" style={{ marginTop: 20 }} onClick={() => store.navigate('dashboard')}>Back to dashboard</button>
        </div>
      </div>
    );
  }

  const doSubmit = async (asDraft) => {
    setSubmitting(true);
    try {
      const result = await store.addInspection({
        callId, cargoType, reconciledTonnage: asDraft ? 0 : reconciled,
        status: asDraft ? 'draft' : 'completed',
        liquid: cargoType === 'Liquid' ? liquid : undefined,
        dry: cargoType === 'Dry' ? dry : undefined,
        jetty: cargoType === 'Liquid'
          ? { type: liquid.jettyType, category: liquid.jettyType === 'Local' ? liquid.jettyCategory : null, name: liquid.jettyName.trim() }
          : null,
      });
      if (asDraft) {
        store.toast(`Draft inspection ${result.inspection.reference} saved`, 'info');
        store.navigate('inspections', { flash: result.inspection.id });
      } else {
        // snapshot the confirmed figures (same ones shown in the preview)
        setSubmitted({
          ...result,
          financials: { dues: preview.dues, commissionUsd: preview.commissionUsd, commissionNgn: preview.commissionNgn },
        });
      }
    } catch (e) {
      store.toast(e.message || 'Could not submit the inspection', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="content-inner">
      <button className="link-btn" style={{ marginBottom: 16 }} onClick={() => store.navigate(lockedCallId ? 'vessel-call-detail' : 'inspections', lockedCallId ? { id: lockedCallId } : {})}>
        <Icon name="chevronLeft" size={15} strokeWidth={2.2} style={{ verticalAlign: '-3px' }} /> {lockedCallId ? 'Back to vessel call' : 'Inspections'}
      </button>
      <div className="page-head" style={{ marginBottom: 24 }}>
        <div><h1>New Inspection</h1><p className="desc">Reconcile cargo and generate the dues invoice.</p></div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 24 }}>
        <Stepper steps={WIZARD_STEPS} current={step} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: step === 1 ? '1fr 320px' : '1fr', gap: 24, alignItems: 'start' }}>
        <div className="card card-pad">
          {/* ---------- Step 1 ---------- */}
          {step === 0 && (
            <div>
              <div className="card-title" style={{ marginBottom: 18 }}>Link to a vessel call</div>
              {lockedCallId && call ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', border: '1px solid var(--hairline)', borderRadius: 8, background: 'var(--accent-tint-2)' }}>
                  <Icon name="ship" size={20} style={{ color: 'var(--accent)' }} />
                  <div><div style={{ fontWeight: 600 }}>{call.vesselName}</div><div className="mono-ref">{call.reference} · {call.type}</div></div>
                  <span className="tag" style={{ marginLeft: 'auto' }}>Locked</span>
                </div>
              ) : (
                <CallCombobox store={store} value={callId} onChange={setCallId} />
              )}

              <div className="card-title" style={{ margin: '28px 0 18px' }}>Cargo category</div>
              <div className="big-seg">
                <button className={cargoType === 'Liquid' ? 'on' : ''} onClick={() => setCargoType('Liquid')}>
                  <div className="bs-ic"><Icon name="droplet" size={22} strokeWidth={1.8} /></div>
                  <div><div className="bs-t">Liquid cargo</div><div className="bs-d">Ullage / sounding, observed volume &amp; the surveyor's reconciled tonnage, with jetty-based dues.</div></div>
                </button>
                <button className={cargoType === 'Dry' ? 'on' : ''} onClick={() => setCargoType('Dry')}>
                  <div className="bs-ic"><Icon name="package" size={22} strokeWidth={1.8} /></div>
                  <div><div className="bs-t">Dry / bulk cargo</div><div className="bs-d">Draft survey — displacement before / after, deductibles &amp; constants.</div></div>
                </button>
              </div>

              <div className="flex between mt-6" style={{ marginTop: 28 }}>
                <span />
                <button className="btn btn-primary" disabled={!canNext0} onClick={() => setStep(1)}>Continue <Icon name="arrowRight" size={16} strokeWidth={2.2} /></button>
              </div>
            </div>
          )}

          {/* ---------- Step 2 ---------- */}
          {step === 1 && (
            <div>
              <div className="flex between items-center" style={{ marginBottom: 18 }}>
                <div className="card-title">{cargoType === 'Liquid' ? 'Liquid cargo measurement' : 'Draft survey'}</div>
                <CargoTag type={cargoType} />
              </div>

              {cargoType === 'Liquid' ? (
                <>
                  <div className="field-row">
                    <Field label="Ullage / sounding (m)"><input type="number" step="0.01" value={liquid.ullage} placeholder="0.00" onChange={(e) => setLiquid({ ...liquid, ullage: e.target.value })} /></Field>
                    <Field label="Observed volume (m³)"><input type="number" step="0.1" value={liquid.observedVol} placeholder="0.0" onChange={(e) => setLiquid({ ...liquid, observedVol: e.target.value })} /></Field>
                  </div>
                  <div className="field-row">
                    <Field label="Temperature (°C)"><input type="number" step="0.1" value={liquid.temp} placeholder="15.0" onChange={(e) => setLiquid({ ...liquid, temp: e.target.value })} /></Field>
                    <Field label="Bill of Lading quantity (MT)" hint="For variance against the surveyor's figure."><input type="number" step="0.01" value={liquid.blQty} placeholder="0.00" onChange={(e) => setLiquid({ ...liquid, blQty: e.target.value })} /></Field>
                  </div>
                  <Field label="Reconciled Surveyor's Tonnage (MT)" required hint="The surveyor's reconciled cargo quantity — the dues basis of record.">
                    <input type="number" step="0.01" value={liquid.surveyorTonnage} placeholder="0.00" onChange={(e) => setLiquid({ ...liquid, surveyorTonnage: e.target.value })} />
                  </Field>
                  <div className="field-row">
                    <Field label="Jetty type" required>
                      <select value={liquid.jettyType} onChange={(e) => setLiquid({ ...liquid, jettyType: e.target.value, jettyCategory: e.target.value === 'Local' ? liquid.jettyCategory : '' })}>
                        <option value="">Select jetty type…</option>
                        <option value="Local">Local Jetty</option>
                        <option value="International">International Jetty</option>
                      </select>
                    </Field>
                    {liquid.jettyType === 'Local' && (
                      <Field label="Jetty category" required>
                        <select value={liquid.jettyCategory} onChange={(e) => setLiquid({ ...liquid, jettyCategory: e.target.value })}>
                          <option value="">Select category…</option>
                          <option value="Government">Government Jetty</option>
                          <option value="Private">Private Jetty</option>
                        </select>
                      </Field>
                    )}
                  </div>
                  <Field label="Jetty name" hint="The specific jetty / berth the vessel worked.">
                    <input type="text" value={liquid.jettyName} placeholder="e.g. UNICEM Jetty" onChange={(e) => setLiquid({ ...liquid, jettyName: e.target.value })} />
                  </Field>
                </>
              ) : (
                <>
                  <div className="field-row">
                    <Field label="Displacement before (MT)" required><input type="number" step="1" value={dry.displBefore} placeholder="0" onChange={(e) => setDry({ ...dry, displBefore: e.target.value })} /></Field>
                    <Field label="Displacement after (MT)" required><input type="number" step="1" value={dry.displAfter} placeholder="0" onChange={(e) => setDry({ ...dry, displAfter: e.target.value })} /></Field>
                  </div>
                  <div className="field-row">
                    <Field label="Deductibles (MT)" hint="Ballast, fuel, fresh water, stores."><input type="number" step="1" value={dry.deductibles} placeholder="0" onChange={(e) => setDry({ ...dry, deductibles: e.target.value })} /></Field>
                    <Field label="Constant (MT)"><input type="number" step="1" value={dry.constant} onChange={(e) => setDry({ ...dry, constant: e.target.value })} /></Field>
                  </div>
                </>
              )}

              <div className="flex between" style={{ marginTop: 12 }}>
                <button className="btn btn-secondary" onClick={() => setStep(0)}><Icon name="chevronLeft" size={16} strokeWidth={2.2} /> Back</button>
                <button className="btn btn-primary" disabled={!canNext1} onClick={() => setStep(2)}>Review <Icon name="arrowRight" size={16} strokeWidth={2.2} /></button>
              </div>
            </div>
          )}

          {/* ---------- Step 3 ---------- */}
          {step === 2 && call && (
            <div>
              <div className="card-title" style={{ marginBottom: 18 }}>Review &amp; submit</div>
              <div className="kv-grid" style={{ marginBottom: 22 }}>
                <div className="kv"><div className="k">Vessel</div><div className="v">{call.vesselName}</div></div>
                <div className="kv"><div className="k">Rotation number</div><div className="v mono-ref" style={{ color: 'var(--ink)' }}>{call.reference}</div></div>
                <div className="kv"><div className="k">Cargo type</div><div className="v"><CargoTag type={cargoType} /></div></div>
                <div className="kv"><div className="k">Reconciled tonnage</div><div className="v tnum">{fmtTons(reconciled)}</div></div>
                {cargoType === 'Liquid' && (
                  <div className="kv"><div className="k">Jetty</div><div className="v">{liquid.jettyType === 'International' ? 'International Jetty' : `${liquid.jettyCategory} Jetty · Local`}{liquid.jettyName ? ` — ${liquid.jettyName}` : ''}</div></div>
                )}
              </div>

              <div className="live-calc" style={{ marginBottom: 8 }}>
                <div className="lc-label"><Icon name="gauge" size={14} strokeWidth={2} /> Calculated charges — preview</div>
                <div style={{ marginTop: 12 }}>
                  <div className="fin-row"><div className="fl">NPA harbour dues<span className="basis">{fmtNum(call.nrt)} NT × {fmtUSD(previewRate)}/ton · {cargoType === 'Liquid' ? `${liquid.jettyType === 'International' ? 'International' : liquid.jettyCategory} jetty` : 'dry rate'}</span></div><div className="fv tnum">{fmtUSD(preview.dues)}</div></div>
                  <div className="fin-row"><div className="fl">Commission · {store.settings.commissionRate}%</div><div className="fv tnum">{fmtUSD(preview.commissionUsd)} · {fmtNGN(preview.commissionNgn)}</div></div>
                </div>
                <div className="lc-foot">These figures are confirmed before submission. The server is the single source of truth on submit.</div>
              </div>

              <div className="flex between" style={{ marginTop: 22 }}>
                <button className="btn btn-secondary" onClick={() => setStep(1)} disabled={submitting}><Icon name="chevronLeft" size={16} strokeWidth={2.2} /> Back</button>
                <div className="flex gap-3">
                  <button className="btn btn-ghost" onClick={() => doSubmit(true)} disabled={submitting}>Save draft</button>
                  <button className="btn btn-primary" onClick={() => doSubmit(false)} disabled={submitting}>
                    {submitting ? <><Icon name="spinner" size={16} className="spin" strokeWidth={2} /> Submitting…</> : 'Submit Inspection'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ---- right rail: running reconciled tonnage (step 2) ---- */}
        {step === 1 && (
          <div style={{ position: 'sticky', top: 24 }}>
            <LiveCalc label="Reconciled tonnage" value={fmtNum(reconciled, 2)} unit="MTS" flashKey={reconciled}
              foot={cargoType === 'Liquid'
                ? (liquid.blQty ? `Variance vs B/L: ${(reconciled - Number(liquid.blQty)).toFixed(2)} MT` : "Enter the surveyor's reconciled tonnage.")
                : 'Displacement before − after − deductibles + constant.'} />
            {cargoType === 'Liquid' && (
              <div className="card card-pad mt-4" style={{ fontSize: 13 }}>
                <div className="kv" style={{ marginBottom: 10 }}><div className="k">Jetty</div><div className="v">{liquid.jettyType ? (liquid.jettyType === 'International' ? 'International' : (liquid.jettyCategory ? `${liquid.jettyCategory} · Local` : 'Local — select category')) : '—'}</div></div>
                <div className="kv" style={{ marginBottom: 10 }}><div className="k">Applicable dues rate</div><div className="v tnum">{previewRate ? `${fmtUSD(previewRate)}/ton` : '—'}</div></div>
                <div className="kv"><div className="k">B/L quantity</div><div className="v tnum">{liquid.blQty ? fmtTons(Number(liquid.blQty)) : '—'}</div></div>
              </div>
            )}
            {cargoType === 'Dry' && (
              <div className="card card-pad mt-4" style={{ fontSize: 13 }}>
                <div className="kv" style={{ marginBottom: 10 }}><div className="k">Applicable dues rate</div><div className="v tnum">{fmtUSD(store.settings.dryDuesRate)}/ton</div></div>
                <div className="kv" style={{ marginBottom: 10 }}><div className="k">Gross displacement Δ</div><div className="v tnum">{fmtNum((Number(dry.displBefore) || 0) - (Number(dry.displAfter) || 0))} MT</div></div>
                <div className="kv"><div className="k">Total deductibles</div><div className="v tnum">{fmtNum(Number(dry.deductibles) || 0)} MT</div></div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// searchable vessel-call combobox
function CallCombobox({ store, value, onChange }) {
  const [open, setOpen] = useStateIns(false);
  const [q, setQ] = useStateIns('');
  const selected = store.calls.find((c) => c.id === value);
  const options = store.calls
    .filter((c) => c.status !== 'completed')
    .filter((c) => !q || c.vesselName.toLowerCase().includes(q.toLowerCase()) || c.reference.toLowerCase().includes(q.toLowerCase()));

  return (
    <div style={{ position: 'relative' }}>
      <div className="search-input" style={{ maxWidth: 'none' }}>
        <Icon name="search" size={17} />
        <input type="text" placeholder="Search vessel name or reference…"
          value={open ? q : (selected ? `${selected.vesselName} · ${selected.reference}` : '')}
          onFocus={() => { setOpen(true); setQ(''); }}
          onChange={(e) => setQ(e.target.value)} />
      </div>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 1 }} onClick={() => setOpen(false)} />
          <div style={{ position: 'absolute', top: '110%', left: 0, right: 0, background: '#fff', border: '1px solid var(--hairline)', borderRadius: 8, boxShadow: 'var(--shadow-pop)', zIndex: 2, maxHeight: 280, overflowY: 'auto', padding: 6 }} className="scroll-host">
            {options.length ? options.map((c) => (
              <button key={c.id} className="sb-item" style={{ borderLeft: 'none', justifyContent: 'flex-start' }}
                onClick={() => { onChange(c.id); setOpen(false); }}>
                <Icon name="ship" size={17} />
                <span style={{ textAlign: 'left' }}><span style={{ display: 'block', fontWeight: 600, color: 'var(--ink)' }}>{c.vesselName}</span><span className="mono-ref">{c.reference} · {c.type}</span></span>
                <StatusBadge status={c.status} />
              </button>
            )) : <div style={{ padding: 16, textAlign: 'center', color: 'var(--slate)', fontSize: 13 }}>No open vessel calls match.</div>}
          </div>
        </>
      )}
    </div>
  );
}

Object.assign(window, { Inspections, NewInspection, computeReconciled });
