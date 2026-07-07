/* global React, Icon, Field, Stepper, NPA_PORTS, ROLES, DEMO_ORG_PROFILE, userInitials, normalizeOrg */
const { useState: useStateOrg, useRef: useRefOrg } = React;

// =========================================================
// Logo upload — reads the file, downscales on a canvas and
// returns a compact data-URL (stored in the org record).
// =========================================================
function readLogoFile(file) {
  return new Promise((resolve, reject) => {
    if (!file.type || file.type.indexOf('image/') !== 0) return reject(new Error('Please choose an image file'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode the image'));
      img.onload = () => {
        const MAX = 256;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function LogoUploader({ logo, onChange, toast }) {
  const inputRef = useRefOrg(null);
  const pick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      onChange(await readLogoFile(file));
    } catch (err) {
      if (toast) toast(err.message, 'error');
    }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ width: 56, height: 56, borderRadius: 12, border: '1px solid var(--hairline)', background: logo ? '#fff' : 'var(--accent)', display: 'grid', placeItems: 'center', overflow: 'hidden', flexShrink: 0 }}>
        {logo
          ? <img src={logo} alt="Organization logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          : <Icon name="anchor" size={24} strokeWidth={2} style={{ color: '#fff' }} />}
      </div>
      <div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => inputRef.current && inputRef.current.click()}>
            <Icon name="download" size={15} strokeWidth={2} style={{ transform: 'rotate(180deg)' }} /> Upload logo
          </button>
          {logo && (
            <button type="button" className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={() => onChange(null)}>Remove</button>
          )}
        </div>
        <div className="hint" style={{ marginTop: 6 }}>PNG / JPG — shown in the sidebar and on invoices &amp; reports.</div>
      </div>
      <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={pick} />
    </div>
  );
}

function PortPicker({ ports, primary, onChange, disabled }) {
  const normalized = normalizeOrg({ ports, designatedPort: primary });
  const selected = normalized.ports;
  const primaryPort = normalized.designatedPort;
  const togglePort = (port) => {
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
            <label key={port} className={'port-option ' + (checked ? 'on' : '')}>
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
// Onboarding — Register Organization (3 steps)
// =========================================================
const OB_STEPS = ['Organization', 'Operating ports', 'Administrator'];

function Onboarding({ onComplete, toast }) {
  const [step, setStep] = useStateOrg(0);
  const [org, setOrg] = useStateOrg({ name: '', rcNumber: '', email: '', phone: '', address: '', designatedPort: NPA_PORTS[0], ports: [NPA_PORTS[0]], logo: null });
  const [admin, setAdmin] = useStateOrg({ name: '', email: '' });
  const [errors, setErrors] = useStateOrg({});
  const [saving, setSaving] = useStateOrg(false);

  const set = (k, v) => setOrg((o) => ({ ...o, [k]: v }));

  const next = () => {
    const e = {};
    if (step === 0) {
      if (!org.name.trim()) e.name = 'Organization name is required.';
      if (!org.email.trim()) e.email = 'A contact email is required.';
    }
    if (step === 1 && (!org.ports || org.ports.length === 0)) e.ports = 'Select at least one operating port.';
    setErrors(e);
    if (Object.keys(e).length === 0) setStep(step + 1);
  };

  const finish = async () => {
    const e = {};
    if (!admin.name.trim()) e.adminName = 'The administrator name is required.';
    if (!admin.email.trim()) e.adminEmail = 'The administrator email is required.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    const adminId = 'u-' + Date.now();
    const cleanOrg = normalizeOrg(org);
    try {
      await onComplete({
        registered: true,
        name: cleanOrg.name.trim(), rcNumber: cleanOrg.rcNumber.trim(), email: cleanOrg.email.trim(),
        phone: cleanOrg.phone.trim(), address: cleanOrg.address.trim(),
        designatedPort: cleanOrg.designatedPort, ports: cleanOrg.ports, logo: cleanOrg.logo,
        members: [{ id: adminId, name: admin.name.trim(), email: admin.email.trim(), role: 'Admin' }],
      }, adminId);
    } catch (err) {
      if (toast) toast(err.message || 'Could not register the organization', 'error');
      setSaving(false);
    }
  };

  const useDemo = async () => {
    setSaving(true);
    try {
      await onComplete(JSON.parse(JSON.stringify(DEMO_ORG_PROFILE)), DEMO_ORG_PROFILE.members[0].id);
    } catch (err) {
      if (toast) toast(err.message || 'Could not register the organization', 'error');
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 560 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--accent)', color: '#fff', display: 'grid', placeItems: 'center' }}>
            <Icon name="anchor" size={20} strokeWidth={2} />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 17 }}>Vessel Caller</div>
            <div style={{ fontSize: 13, color: 'var(--slate)' }}>Register your organization to get started.</div>
          </div>
        </div>

        <div className="card card-pad">
          <Stepper steps={OB_STEPS} current={step} />
          <div style={{ marginTop: 24 }}>
            {step === 0 && (
              <>
                <Field label="Organization name" required error={errors.name}>
                  <input type="text" className={errors.name ? 'invalid' : ''} value={org.name} placeholder="e.g. Vessel Caller Ltd" onChange={(e) => set('name', e.target.value)} />
                </Field>
                <div className="field-row">
                  <Field label="RC number" hint="Corporate registration (CAC).">
                    <input type="text" value={org.rcNumber} placeholder="e.g. RC-482913" onChange={(e) => set('rcNumber', e.target.value)} />
                  </Field>
                  <Field label="Phone">
                    <input type="text" value={org.phone} placeholder="+234 …" onChange={(e) => set('phone', e.target.value)} />
                  </Field>
                </div>
                <Field label="Contact email" required error={errors.email}>
                  <input type="email" className={errors.email ? 'invalid' : ''} value={org.email} placeholder="ops@youragency.ng" onChange={(e) => set('email', e.target.value)} />
                </Field>
                <Field label="Address">
                  <input type="text" value={org.address} placeholder="Street, city, state" onChange={(e) => set('address', e.target.value)} />
                </Field>
              </>
            )}

            {step === 1 && (
              <>
                <Field label="Operating ports" required error={errors.ports} hint="Choose every NPA port this organization operates at.">
                  <PortPicker ports={org.ports} primary={org.designatedPort}
                    onChange={(ports, primary) => setOrg((o) => normalizeOrg({ ...o, ports, designatedPort: primary }))} />
                </Field>
                <div style={{ marginTop: 18 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Organization logo <span style={{ color: 'var(--slate)', fontWeight: 400 }}>· optional</span></div>
                  <LogoUploader logo={org.logo} onChange={(l) => set('logo', l)} toast={toast} />
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <p className="muted" style={{ fontSize: 13, margin: '0 0 18px' }}>
                  The administrator manages settings, team members and roles. You can add Operations, Finance and Viewer members later under Settings → Team &amp; roles.
                </p>
                <Field label="Administrator name" required error={errors.adminName}>
                  <input type="text" className={errors.adminName ? 'invalid' : ''} value={admin.name} placeholder="e.g. Etim Okon" onChange={(e) => setAdmin({ ...admin, name: e.target.value })} />
                </Field>
                <Field label="Administrator email" required error={errors.adminEmail}>
                  <input type="email" className={errors.adminEmail ? 'invalid' : ''} value={admin.email} placeholder="you@youragency.ng" onChange={(e) => setAdmin({ ...admin, email: e.target.value })} />
                </Field>
              </>
            )}
          </div>

          <div className="flex between items-center" style={{ marginTop: 24 }}>
            {step > 0
              ? <button className="btn btn-secondary" onClick={() => setStep(step - 1)} disabled={saving}><Icon name="chevronLeft" size={16} strokeWidth={2.2} /> Back</button>
              : <span />}
            {step < 2
              ? <button className="btn btn-primary" onClick={next}>Continue <Icon name="arrowRight" size={16} strokeWidth={2.2} /></button>
              : <button className="btn btn-primary" onClick={finish} disabled={saving}>
                  {saving ? <><Icon name="spinner" size={16} className="spin" strokeWidth={2} /> Registering…</> : 'Register organization'}
                </button>}
          </div>
        </div>

        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button className="link-btn" onClick={useDemo} disabled={saving}>Skip — use the demo organization</button>
        </div>
      </div>
    </div>
  );
}

// =========================================================
// Settings → Organization (profile, operating ports, logo)
// =========================================================
function OrganizationSection({ form, set, canEdit, toast }) {
  const normalized = normalizeOrg(form);
  return (
    <div className="card card-pad" style={{ maxWidth: 640 }}>
      <div className="card-title">Organization</div>
      <p className="muted" style={{ fontSize: 13, margin: '6px 0 20px' }}>
        The registered agency profile. Operating ports and logo appear across the app and on invoices &amp; inspection reports.
      </p>
      <fieldset disabled={!canEdit} style={{ border: 'none', padding: 0, margin: 0 }}>
        <Field label="Organization name" required>
          <input type="text" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <div className="field-row">
          <Field label="RC number"><input type="text" value={form.rcNumber} onChange={(e) => set('rcNumber', e.target.value)} /></Field>
          <Field label="Phone"><input type="text" value={form.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
        </div>
        <Field label="Contact email"><input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Address"><input type="text" value={form.address} onChange={(e) => set('address', e.target.value)} /></Field>
        <Field label="Operating ports" hint="Select every NPA port this organization can work from.">
          <PortPicker ports={normalized.ports} primary={normalized.designatedPort} disabled={!canEdit}
            onChange={(ports, primary) => { set('ports', ports); set('designatedPort', primary); }} />
        </Field>
      </fieldset>
      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Logo</div>
        {canEdit
          ? <LogoUploader logo={form.logo} onChange={(l) => set('logo', l)} toast={toast} />
          : <div className="muted" style={{ fontSize: 13 }}>Only Admins can change the logo.</div>}
      </div>
    </div>
  );
}

// =========================================================
// Settings → Team & roles
// =========================================================
const ROLE_HELP = {
  Admin: 'Full access — settings, team, operations and payments.',
  Operations: 'Register vessel calls and submit inspections.',
  Finance: 'Record and track invoice payments.',
  Viewer: 'Read-only access to every screen.',
};

function TeamSection({ form, set, canEdit, currentUser, toast }) {
  const [draft, setDraft] = useStateOrg({ name: '', email: '', role: 'Operations' });
  const members = form.members || [];

  const addMember = () => {
    if (!draft.name.trim() || !draft.email.trim()) {
      if (toast) toast('A name and email are required to add a member', 'error');
      return;
    }
    set('members', [...members, { id: 'u-' + Date.now(), name: draft.name.trim(), email: draft.email.trim(), role: draft.role }]);
    setDraft({ name: '', email: '', role: 'Operations' });
  };

  const setRole = (id, role) => set('members', members.map((m) => (m.id === id ? { ...m, role } : m)));
  const remove = (id) => set('members', members.filter((m) => m.id !== id));

  const adminCount = members.filter((m) => m.role === 'Admin').length;

  return (
    <div className="card card-pad" style={{ maxWidth: 640 }}>
      <div className="card-title">Team &amp; roles</div>
      <p className="muted" style={{ fontSize: 13, margin: '6px 0 18px' }}>
        Admin — everything · Operations — vessel calls &amp; inspections · Finance — payments · Viewer — read-only.
      </p>

      {members.map((m) => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--hairline)' }}>
          <div className="avatar" style={{ width: 34, height: 34, fontSize: 12, flexShrink: 0 }}>{userInitials(m.name)}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>
              {m.name}{currentUser && currentUser.id === m.id && <span className="tag" style={{ marginLeft: 8 }}>you</span>}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--slate)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.email}</div>
          </div>
          <select value={m.role} disabled={!canEdit || (m.role === 'Admin' && adminCount === 1)}
            title={m.role === 'Admin' && adminCount === 1 ? 'The last Admin cannot be demoted' : ROLE_HELP[m.role]}
            style={{ width: 140 }} onChange={(e) => setRole(m.id, e.target.value)}>
            {ROLES.map((r) => <option key={r}>{r}</option>)}
          </select>
          <button className="icon-btn" aria-label={'Remove ' + m.name} title={m.role === 'Admin' && adminCount === 1 ? 'The last Admin cannot be removed' : 'Remove member'}
            disabled={!canEdit || (m.role === 'Admin' && adminCount === 1)}
            style={{ color: 'var(--danger)' }} onClick={() => remove(m.id)}>
            <Icon name="trash" size={16} />
          </button>
        </div>
      ))}

      {canEdit && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Add member</div>
          <div className="field-row">
            <Field label="Name"><input type="text" value={draft.name} placeholder="Full name" onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <Field label="Email"><input type="email" value={draft.email} placeholder="member@youragency.ng" onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></Field>
          </div>
          <div className="flex between items-center">
            <Field label="Role" hint={ROLE_HELP[draft.role]}>
              <select value={draft.role} style={{ width: 180 }} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
                {ROLES.map((r) => <option key={r}>{r}</option>)}
              </select>
            </Field>
            <button className="btn btn-secondary" style={{ marginTop: 6 }} onClick={addMember}>
              <Icon name="plus" size={16} strokeWidth={2.2} /> Add member
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { Onboarding, OrganizationSection, TeamSection, LogoUploader, PortPicker });
