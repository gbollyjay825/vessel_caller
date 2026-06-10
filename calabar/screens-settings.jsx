/* global React, Icon, Field, fmtNum */
const { useState: useStateSet } = React;

function Settings({ store }) {
  const [tab, setTab] = useStateSet('charges');
  const [form, setForm] = useStateSet(() => JSON.parse(JSON.stringify(store.settings)));
  const [dirty, setDirty] = useStateSet(false);
  const [saving, setSaving] = useStateSet(false);

  const set = (path, val) => {
    setForm((f) => {
      const next = JSON.parse(JSON.stringify(f));
      const keys = path.split('.');
      let o = next;
      for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
      o[keys[keys.length - 1]] = val;
      return next;
    });
    setDirty(true);
  };

  const save = () => {
    setSaving(true);
    setTimeout(() => {
      store.updateSettings(form);
      setSaving(false); setDirty(false);
      store.toast('Settings saved', 'success');
    }, 600);
  };

  const TABS = [['charges', 'Charge configuration'], ['notifications', 'Notifications'], ['port', 'Port profile']];

  return (
    <div className="content-inner">
      <div className="page-head"><div><h1 className="hide-sr">Settings</h1><p className="desc">Charge rates, notification channels and port profile.</p></div></div>

      <div className="settings-tabs" role="tablist">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {/* ---------- Charge configuration ---------- */}
      {tab === 'charges' && (
        <div className="card card-pad" style={{ maxWidth: 640 }}>
          <div className="card-title">Charge configuration</div>
          <p className="muted" style={{ fontSize: 13, margin: '6px 0 24px' }}>Changes affect future calculations only. Existing invoices keep the rate they were issued under.</p>
          <div className="field-row">
            <Field label="Commission rate (%)" hint="Agency commission on harbour dues.">
              <input type="number" step="0.1" value={form.commissionRate} onChange={(e) => set('commissionRate', Number(e.target.value))} />
            </Field>
            <Field label="USD → ₦ exchange rate" hint="Used for the naira commission figure.">
              <input type="number" step="1" value={form.exchangeRate} onChange={(e) => set('exchangeRate', Number(e.target.value))} />
            </Field>
          </div>
          <Field label="NPA dues rate basis (USD per NRT ton)" hint="Harbour dues = net registered tonnage × this rate.">
            <input type="number" step="0.01" value={form.duesRatePerTon} onChange={(e) => set('duesRatePerTon', Number(e.target.value))} />
          </Field>
          <div className="live-calc" style={{ marginTop: 8 }}>
            <div className="lc-label"><Icon name="gauge" size={14} strokeWidth={2} /> Worked example · 50,000 NRT vessel</div>
            <div style={{ marginTop: 10, fontSize: 14 }}>
              <div className="fin-row"><div className="fl">Harbour dues</div><div className="fv tnum">${fmtNum(50000 * form.duesRatePerTon, 2)}</div></div>
              <div className="fin-row"><div className="fl">Commission · {form.commissionRate}%</div><div className="fv tnum">${fmtNum(50000 * form.duesRatePerTon * form.commissionRate / 100, 2)} · ₦{fmtNum(50000 * form.duesRatePerTon * form.commissionRate / 100 * form.exchangeRate)}</div></div>
            </div>
          </div>
        </div>
      )}

      {/* ---------- Notifications ---------- */}
      {tab === 'notifications' && (
        <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div className="card card-pad">
            <div className="flex between items-center" style={{ marginBottom: 4 }}>
              <div className="card-title"><Icon name="mail" size={17} style={{ verticalAlign: '-3px', marginRight: 6, color: 'var(--slate)' }} /> Email (SMTP)</div>
              <span className={'channel-status ' + (form.smtp.connected ? 'connected' : 'disconnected')}><span className="cdot" />{form.smtp.connected ? 'Connected' : 'Not connected'}</span>
            </div>
            <p className="muted" style={{ fontSize: 13, margin: '4px 0 20px' }}>Used to email invoices and inspection reports to agents.</p>
            <div className="field-row">
              <Field label="SMTP host"><input type="text" value={form.smtp.host} onChange={(e) => set('smtp.host', e.target.value)} /></Field>
              <Field label="Port"><input type="text" value={form.smtp.port} onChange={(e) => set('smtp.port', e.target.value)} /></Field>
            </div>
            <Field label="Username"><input type="text" value={form.smtp.user} onChange={(e) => set('smtp.user', e.target.value)} /></Field>
            <Field label="From address"><input type="text" value={form.smtp.from} onChange={(e) => set('smtp.from', e.target.value)} /></Field>
            <button className="btn btn-secondary btn-sm" onClick={() => store.toast('Test email sent to ' + form.smtp.user, 'success')}><Icon name="send" size={15} strokeWidth={2} /> Send test</button>
          </div>

          <div className="card card-pad">
            <div className="flex between items-center" style={{ marginBottom: 4 }}>
              <div className="card-title"><Icon name="phone" size={17} style={{ verticalAlign: '-3px', marginRight: 6, color: 'var(--slate)' }} /> SMS (Twilio)</div>
              <span className={'channel-status ' + (form.sms.connected ? 'connected' : 'disconnected')}><span className="cdot" />{form.sms.connected ? 'Connected' : 'Not connected'}</span>
            </div>
            <p className="muted" style={{ fontSize: 13, margin: '4px 0 20px' }}>Optional SMS alerts on vessel berthing and invoice issue.</p>
            <Field label="Account SID"><input type="text" value={form.sms.sid} onChange={(e) => set('sms.sid', e.target.value)} /></Field>
            <Field label="From number"><input type="text" value={form.sms.from} onChange={(e) => set('sms.from', e.target.value)} /></Field>
            <button className="btn btn-secondary btn-sm" onClick={() => store.toast(form.sms.connected ? 'Test SMS sent' : 'Connect Twilio before sending a test', form.sms.connected ? 'success' : 'error')}><Icon name="send" size={15} strokeWidth={2} /> Send test</button>
          </div>
        </div>
      )}

      {/* ---------- Port profile ---------- */}
      {tab === 'port' && (
        <div className="card card-pad" style={{ maxWidth: 640 }}>
          <div className="card-title" style={{ marginBottom: 20 }}>Port profile</div>
          <Field label="Port name"><input type="text" value={form.portName} onChange={(e) => set('portName', e.target.value)} /></Field>
          <Field label="Default terminals" hint="One per line. Offered when registering a vessel call.">
            <textarea style={{ minHeight: 120 }} value={form.terminals.join('\n')} onChange={(e) => set('terminals', e.target.value.split('\n'))} />
          </Field>
        </div>
      )}

      <div className="save-bar">
        <span className="unsaved">{dirty ? <><Icon name="alert" size={14} strokeWidth={2} /> You have unsaved changes</> : <span className="muted">All changes saved</span>}</span>
        <div className="flex gap-3">
          <button className="btn btn-secondary" disabled={!dirty || saving} onClick={() => { setForm(JSON.parse(JSON.stringify(store.settings))); setDirty(false); }}>Discard</button>
          <button className="btn btn-primary" disabled={!dirty || saving} onClick={save}>{saving ? <><Icon name="spinner" size={16} className="spin" strokeWidth={2} /> Saving…</> : 'Save changes'}</button>
        </div>
      </div>
    </div>
  );
}

window.Settings = Settings;
