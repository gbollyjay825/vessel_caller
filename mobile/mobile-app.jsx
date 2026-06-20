/* global React, ReactDOM, Icon, IOSDevice, SEED_CALLS, SEED_INSPECTIONS, DEFAULT_SETTINGS, calcPreview, rateForInspection, fmtUSD, fmtNGN, fmtNum, fmtTons, fmtDate, CURRENT_USER */
const { useState, useEffect, useRef, useMemo } = React;

// reconciled-tonnage maths (mirrors the desktop / server)
function vcf(t) { return 1 - ((Number(t) || 15) - 15) * 0.00065; }
function reconcile(cargo, m) {
  if (cargo === 'Liquid') {
    // Reconciled by the surveyor and entered directly.
    return Math.round((Number(m.surveyorTonnage) || 0) * 100) / 100;
  }
  return Math.round(((Number(m.displBefore) || 0) - (Number(m.displAfter) || 0) - (Number(m.deductibles) || 0) + (Number(m.constant) || 0)) * 100) / 100;
}

function MBadge({ status }) {
  const L = { pending: 'Pending', 'in-progress': 'In progress', completed: 'Completed', synced: 'Synced', draft: 'Draft' };
  return <span className={'m-badge ' + status}><span className="dot" />{L[status] || status}</span>;
}
function MTag({ type }) {
  const liquid = type === 'Liquid';
  return <span className={'m-tag ' + (liquid ? 'liquid' : 'dry')}><Icon name={liquid ? 'droplet' : 'package'} size={12} strokeWidth={2} />{type}</span>;
}

// =========================================================
// Root
// =========================================================
function MobileApp() {
  const [tab, setTab] = useState('tasks');
  const [capture, setCapture] = useState(null); // { callId }
  const [calls, setCalls] = useState(SEED_CALLS);
  const [captured, setCaptured] = useState(
    SEED_INSPECTIONS.filter((i) => i.status === 'completed').map((i) => ({ ...i, synced: true }))
  );

  const awaiting = calls.filter((c) => c.status !== 'completed');
  const pendingSync = captured.filter((c) => !c.synced).length;

  const onSubmit = (rec) => {
    setCaptured((cs) => [{ ...rec, synced: false }, ...cs]);
    // simulate background sync
    setTimeout(() => setCaptured((cs) => cs.map((c) => c.id === rec.id ? { ...c, synced: true } : c)), 2600);
    setCalls((cs) => cs.map((c) => c.id === rec.callId ? { ...c, status: 'completed' } : c));
  };

  return (
    <div className="stage">
      <IOSDevice>
        <div className="mob">
          {capture ? (
            <CaptureFlow call={calls.find((c) => c.id === capture.callId)} onClose={() => setCapture(null)} onSubmit={onSubmit} />
          ) : (
            <div className="mob-app">
              <div className="mob-body">
                {tab === 'tasks' && <TasksTab awaiting={awaiting} pendingSync={pendingSync} onStart={(id) => setCapture({ callId: id })} />}
                {tab === 'captured' && <CapturedTab captured={captured} calls={calls} />}
                {tab === 'account' && <AccountTab pendingSync={pendingSync} />}
              </div>
              <TabBar tab={tab} setTab={setTab} badge={pendingSync} />
            </div>
          )}
        </div>
      </IOSDevice>
    </div>
  );
}

// =========================================================
// Tasks
// =========================================================
function TasksTab({ awaiting, pendingSync, onStart }) {
  const ready = awaiting.filter((c) => c.status === 'in-progress');
  const upcoming = awaiting.filter((c) => c.status === 'pending');
  return (
    <>
      <div className="mob-head">
        <div className="row">
          <div>
            <div className="eyebrow">Port of Calabar</div>
            <h1>Inspections</h1>
          </div>
          <span className={'sync-chip ' + (pendingSync ? 'pending' : '')}>
            <span className="cdot" />{pendingSync ? `${pendingSync} to sync` : 'All synced'}
          </span>
        </div>
      </div>

      {pendingSync > 0 && (
        <div className="offline-banner"><Icon name="info" size={16} strokeWidth={2} /> {pendingSync} capture{pendingSync > 1 ? 's' : ''} waiting to upload — will sync automatically.</div>
      )}

      <div className="mob-section">
        {ready.length > 0 && <div className="mob-section-label">Berthed · ready to inspect</div>}
        {ready.map((c) => <TaskCard key={c.id} call={c} onStart={onStart} />)}
        {upcoming.length > 0 && <div className="mob-section-label">Awaiting berth</div>}
        {upcoming.map((c) => <TaskCard key={c.id} call={c} onStart={onStart} />)}
        {awaiting.length === 0 && (
          <div className="empty-tab"><div className="ei"><Icon name="check" size={26} /></div><h3>All caught up</h3><p>No vessels are awaiting inspection right now.</p></div>
        )}
      </div>
    </>
  );
}

function TaskCard({ call, onStart }) {
  const berthed = call.status === 'in-progress';
  return (
    <div className="task-card" onClick={() => onStart(call.id)}>
      <div className="tc-top">
        <div>
          <div className="tc-name">{call.vesselName}</div>
          <div className="tc-ref">{call.reference} · {call.type}</div>
        </div>
        <MBadge status={call.status} />
      </div>
      <div className="tc-meta">
        <span className="mi"><Icon name="anchor" size={15} strokeWidth={2} /> {call.berth ? call.berth.split('—')[0].trim() : 'TBA'}</span>
        <span className="mi"><Icon name="calendar" size={15} strokeWidth={2} /> {fmtDate(call.eta)}</span>
        <span className="tc-cta">{berthed ? 'Capture' : 'Open'} <Icon name="chevronRight" size={15} strokeWidth={2.4} /></span>
      </div>
    </div>
  );
}

// =========================================================
// Capture flow
// =========================================================
function CaptureFlow({ call, onClose, onSubmit }) {
  const [step, setStep] = useState(0);
  const [cargo, setCargo] = useState('');
  const [liquid, setLiquid] = useState({ ullage: '', observedVol: '', temp: '', blQty: '', surveyorTonnage: '', jettyType: '', jettyCategory: '', jettyName: '' });
  const [dry, setDry] = useState({ displBefore: '', displAfter: '', deductibles: '', constant: '0' });
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null);

  const m = cargo === 'Liquid' ? liquid : dry;
  const tonnage = useMemo(() => reconcile(cargo, m), [cargo, liquid, dry]);
  const previewRate = rateForInspection({ cargoType: cargo, jetty: { type: liquid.jettyType, category: liquid.jettyType === 'Local' ? liquid.jettyCategory : null } }, DEFAULT_SETTINGS);
  const preview = call ? calcPreview(call.nrt, previewRate, DEFAULT_SETTINGS) : null;
  const jettyOk = cargo !== 'Liquid' || liquid.jettyType === 'International' || (liquid.jettyType === 'Local' && liquid.jettyCategory);
  const numRef = useRef(null);
  useEffect(() => { const el = numRef.current; if (!el) return; el.classList.remove('rb-flash'); void el.offsetWidth; el.classList.add('rb-flash'); }, [tonnage]);

  if (!call) return null;

  const submit = () => {
    setSubmitting(true);
    setTimeout(() => {
      const insNum = 314 + Math.floor(Math.random() * 40);
      const rec = { id: 'in-' + Date.now(), reference: `INS-2026-${insNum}`, callId: call.id, vesselName: call.vesselName, cargoType: cargo, reconciledTonnage: tonnage, date: new Date().toISOString().slice(0, 16), status: 'completed', dues: preview.dues, commissionUsd: preview.commissionUsd, commissionNgn: preview.commissionNgn };
      setSubmitting(false);
      setDone(rec);
      onSubmit(rec);
    }, 850);
  };

  if (done) {
    return (
      <div className="mob-app"><div className="mob-body"><div className="cap-success">
        <div className="sc"><Icon name="check" size={42} strokeWidth={2.4} /></div>
        <h2>Inspection captured</h2>
        <p>{done.reference} saved for {call.vesselName}. Uploading to the platform…</p>
        <div className="sc-result">
          <div className="rev-row"><span className="rk">Reconciled tonnage</span><span className="rv">{fmtTons(done.reconciledTonnage)}</span></div>
          <div className="rev-row"><span className="rk">NPA harbour dues</span><span className="rv">{fmtUSD(done.dues)}</span></div>
          <div className="rev-row"><span className="rk">Commission · {DEFAULT_SETTINGS.commissionRate}%</span><span className="rv">{fmtUSD(done.commissionUsd)}</span></div>
          <div className="rev-row"><span className="rk">Sync status</span><span className="rv"><span className="sync-chip pending"><span className="cdot" />Uploading</span></span></div>
        </div>
      </div></div>
        <div className="mob-cta"><button className="mbtn mbtn-primary" onClick={onClose}>Done</button></div>
      </div>
    );
  }

  const StepWrap = (children, footer) => (
    <div className="mob-app">
      <div className="cap-head">
        <button className="cap-back" onClick={() => step === 0 ? onClose() : setStep(step - 1)}><Icon name={step === 0 ? 'x' : 'chevronLeft'} size={20} /></button>
        <div className="cap-title">New inspection<span className="cs">{['Vessel & cargo', 'Measurement', 'Review & submit'][step]}</span></div>
      </div>
      <div className="cap-progress">{[0, 1, 2].map((i) => <div key={i} className={'seg ' + (i <= step ? 'on' : '')} />)}</div>
      <div className="mob-body">{children}</div>
      {footer}
    </div>
  );

  // Step 0 — vessel + cargo
  if (step === 0) {
    return StepWrap(
      <>
        <div className="cap-vessel">
          <div className="cv-ic"><Icon name="ship" size={22} /></div>
          <div><div className="cv-name">{call.vesselName}</div><div className="cv-ref">{call.reference} · {call.type}</div></div>
        </div>
        <div className="cap-label">Cargo category</div>
        <div className="cargo-pick">
          <button className={'cargo-opt ' + (cargo === 'Liquid' ? 'on' : '')} onClick={() => setCargo('Liquid')}>
            <div className="co-ic"><Icon name="droplet" size={24} strokeWidth={1.8} /></div>
            <div><div className="co-t">Liquid cargo</div><div className="co-d">PMS, AGO, DPK — ullage survey</div></div>
            <div className="co-check">{cargo === 'Liquid' && <Icon name="check" size={15} strokeWidth={3} />}</div>
          </button>
          <button className={'cargo-opt ' + (cargo === 'Dry' ? 'on' : '')} onClick={() => setCargo('Dry')}>
            <div className="co-ic"><Icon name="package" size={24} strokeWidth={1.8} /></div>
            <div><div className="co-t">Dry / bulk cargo</div><div className="co-d">Grain, fertiliser — draft survey</div></div>
            <div className="co-check">{cargo === 'Dry' && <Icon name="check" size={15} strokeWidth={3} />}</div>
          </button>
        </div>
      </>,
      <div className="mob-cta"><button className="mbtn mbtn-primary" disabled={!cargo} onClick={() => setStep(1)}>Continue</button></div>
    );
  }

  // Step 1 — measurement + running tonnage
  if (step === 1) {
    return StepWrap(
      <div className="mfields">
        {cargo === 'Liquid' ? (
          <>
            <div className="mfield-row">
              <div className="mfield"><label>Ullage <span className="opt">(m)</span></label><input type="number" inputMode="decimal" value={liquid.ullage} placeholder="0.00" onChange={(e) => setLiquid({ ...liquid, ullage: e.target.value })} /></div>
              <div className="mfield"><label>Temp <span className="opt">(°C)</span></label><input type="number" inputMode="decimal" value={liquid.temp} placeholder="15.0" onChange={(e) => setLiquid({ ...liquid, temp: e.target.value })} /></div>
            </div>
            <div className="mfield"><label>Observed volume <span className="opt">(m³)</span></label><input type="number" inputMode="decimal" value={liquid.observedVol} placeholder="0.0" onChange={(e) => setLiquid({ ...liquid, observedVol: e.target.value })} /></div>
            <div className="mfield"><label>Reconciled surveyor's tonnage <span className="opt">(MT)</span></label><input type="number" inputMode="decimal" value={liquid.surveyorTonnage} placeholder="0.00" onChange={(e) => setLiquid({ ...liquid, surveyorTonnage: e.target.value })} /></div>
            <div className="mfield"><label>Jetty type</label><select value={liquid.jettyType} onChange={(e) => setLiquid({ ...liquid, jettyType: e.target.value, jettyCategory: e.target.value === 'Local' ? liquid.jettyCategory : '' })}><option value="">Select…</option><option value="Local">Local Jetty</option><option value="International">International Jetty</option></select></div>
            {liquid.jettyType === 'Local' && (
              <div className="mfield"><label>Jetty category</label><select value={liquid.jettyCategory} onChange={(e) => setLiquid({ ...liquid, jettyCategory: e.target.value })}><option value="">Select…</option><option value="Government">Government Jetty</option><option value="Private">Private Jetty</option></select></div>
            )}
            <div className="mfield"><label>Jetty name</label><input type="text" value={liquid.jettyName} placeholder="e.g. UNICEM Jetty" onChange={(e) => setLiquid({ ...liquid, jettyName: e.target.value })} /></div>
            <div className="mfield"><label>Bill of Lading qty <span className="opt">(MT)</span></label><input type="number" inputMode="decimal" value={liquid.blQty} placeholder="0.00" onChange={(e) => setLiquid({ ...liquid, blQty: e.target.value })} /></div>
          </>
        ) : (
          <>
            <div className="mfield"><label>Displacement before <span className="opt">(MT)</span></label><input type="number" inputMode="decimal" value={dry.displBefore} placeholder="0" onChange={(e) => setDry({ ...dry, displBefore: e.target.value })} /></div>
            <div className="mfield"><label>Displacement after <span className="opt">(MT)</span></label><input type="number" inputMode="decimal" value={dry.displAfter} placeholder="0" onChange={(e) => setDry({ ...dry, displAfter: e.target.value })} /></div>
            <div className="mfield-row">
              <div className="mfield"><label>Deductibles <span className="opt">(MT)</span></label><input type="number" inputMode="decimal" value={dry.deductibles} placeholder="0" onChange={(e) => setDry({ ...dry, deductibles: e.target.value })} /></div>
              <div className="mfield"><label>Constant <span className="opt">(MT)</span></label><input type="number" inputMode="decimal" value={dry.constant} onChange={(e) => setDry({ ...dry, constant: e.target.value })} /></div>
            </div>
          </>
        )}
      </div>,
      <>
        <div className="running-bar">
          <div className="rb-top">
            <span className="rb-l"><Icon name="gauge" size={14} strokeWidth={2} /> Reconciled tonnage</span>
          </div>
          <div className="rb-n tnum" ref={numRef}>{fmtNum(tonnage, 2)}<span className="u">MTS</span></div>
          <div className="rb-foot">{cargo === 'Liquid' ? (liquid.blQty ? `Variance vs B/L: ${(tonnage - Number(liquid.blQty)).toFixed(2)} MT` : "Enter the surveyor's reconciled tonnage") : 'Before − after − deductibles + constant'}</div>
        </div>
        <div className="mob-cta"><button className="mbtn mbtn-primary" disabled={tonnage <= 0 || !jettyOk} onClick={() => setStep(2)}>Review</button></div>
      </>
    );
  }

  // Step 2 — review + photos + submit
  return StepWrap(
    <>
      <div className="rev-card">
        <div className="rev-row"><span className="rk">Vessel</span><span className="rv">{call.vesselName}</span></div>
        <div className="rev-row"><span className="rk">Rotation</span><span className="rv">{call.reference}</span></div>
        <div className="rev-row"><span className="rk">Cargo</span><span className="rv"><MTag type={cargo} /></span></div>
        {cargo === 'Liquid' && <div className="rev-row"><span className="rk">Jetty</span><span className="rv">{liquid.jettyType === 'International' ? 'International' : `${liquid.jettyCategory} · Local`}</span></div>}
        <div className="rev-row"><span className="rk">Reconciled tonnage</span><span className="rv">{fmtTons(tonnage)}</span></div>
      </div>

      <div className="charge-preview">
        <div className="cp-label"><Icon name="gauge" size={14} strokeWidth={2} /> Charges preview</div>
        <div className="cp-row"><span className="l">NPA harbour dues</span><span className="v">{fmtUSD(preview.dues)}</span></div>
        <div className="cp-row"><span className="l">Commission · {DEFAULT_SETTINGS.commissionRate}%</span><span className="v">{fmtUSD(preview.commissionUsd)}</span></div>
        <div className="cp-row"><span className="l">&nbsp;</span><span className="v" style={{ color: 'var(--slate)', fontWeight: 500 }}>{fmtNGN(preview.commissionNgn)}</span></div>
      </div>

      <div className="photo-label"><span className="pl">Evidence photos</span><span style={{ fontSize: 12, color: 'var(--soft)' }}>optional</span></div>
      <div className="photo-grid">
        <image-slot id="cap-photo-1" shape="rounded" radius="12" placeholder="Ullage / draft"></image-slot>
        <image-slot id="cap-photo-2" shape="rounded" radius="12" placeholder="Cargo / seal"></image-slot>
      </div>
      <div style={{ height: 12 }} />
    </>,
    <div className="mob-cta">
      <button className="mbtn mbtn-primary" disabled={submitting} onClick={submit}>
        {submitting ? <><Icon name="spinner" size={18} className="spin" strokeWidth={2} /> Submitting…</> : 'Submit inspection'}
      </button>
      <button className="mbtn mbtn-ghost" disabled={submitting} onClick={onClose}>Save as draft</button>
    </div>
  );
}

// =========================================================
// Captured
// =========================================================
function CapturedTab({ captured, calls }) {
  return (
    <>
      <div className="mob-head"><div className="eyebrow">Recent</div><h1>Captured</h1></div>
      <div className="mob-section">
        {captured.map((i) => {
          const call = calls.find((c) => c.id === i.callId);
          return (
            <div className="task-card" key={i.id} style={{ cursor: 'default' }}>
              <div className="tc-top">
                <div><div className="tc-name">{i.vesselName}</div><div className="tc-ref">{i.reference}</div></div>
                <MBadge status={i.synced ? 'synced' : 'draft'} />
              </div>
              <div className="tc-meta">
                <MTag type={i.cargoType} />
                <span className="mi tnum">{fmtTons(i.reconciledTonnage)}</span>
                <span className="mi tnum" style={{ marginLeft: 'auto' }}>{fmtDate(i.date)}</span>
              </div>
            </div>
          );
        })}
        {captured.length === 0 && <div className="empty-tab"><div className="ei"><Icon name="clipboard" size={26} /></div><h3>Nothing captured yet</h3><p>Submitted inspections appear here.</p></div>}
      </div>
    </>
  );
}

// =========================================================
// Account
// =========================================================
function AccountTab({ pendingSync }) {
  return (
    <>
      <div className="mob-head"><h1>Account</h1></div>
      <div className="acct-profile">
        <div className="ap-av">{CURRENT_USER.initials}</div>
        <div><div className="ap-name">{CURRENT_USER.name}</div><div className="ap-role">{CURRENT_USER.role} · Calabar</div></div>
      </div>
      <div className="acct-list">
        <div className="acct-row"><div className="ar-ic"><Icon name="anchor" size={17} strokeWidth={2} /></div> Port<span className="ar-detail">Port of Calabar</span></div>
        <div className="acct-row"><div className="ar-ic"><Icon name="download" size={17} strokeWidth={2} /></div> Pending sync<span className="ar-detail">{pendingSync} item{pendingSync === 1 ? '' : 's'}</span></div>
        <div className="acct-row"><div className="ar-ic"><Icon name="gauge" size={17} strokeWidth={2} /></div> Units<span className="ar-detail">Metric (MT)</span></div>
      </div>
      <div className="acct-list">
        <div className="acct-row"><div className="ar-ic"><Icon name="settings" size={17} strokeWidth={2} /></div> Capture settings<Icon name="chevronRight" size={16} style={{ marginLeft: 'auto', color: 'var(--soft)' }} /></div>
        <div className="acct-row"><div className="ar-ic"><Icon name="info" size={17} strokeWidth={2} /></div> Help &amp; offline guide<Icon name="chevronRight" size={16} style={{ marginLeft: 'auto', color: 'var(--soft)' }} /></div>
      </div>
      <div className="mob-cta"><button className="mbtn mbtn-secondary" style={{ color: 'var(--danger)' }}><Icon name="logout" size={18} /> Sign out</button></div>
    </>
  );
}

// =========================================================
// Tab bar
// =========================================================
function TabBar({ tab, setTab }) {
  const tabs = [['tasks', 'Tasks', 'clipboard'], ['captured', 'Captured', 'check'], ['account', 'Account', 'settings']];
  return (
    <div className="tabbar">
      {tabs.map(([k, l, ic]) => (
        <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
          <Icon name={ic} size={23} strokeWidth={tab === k ? 2.1 : 1.8} />{l}
        </button>
      ))}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<MobileApp />);
