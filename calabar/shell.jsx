/* global React, Icon, CURRENT_USER */
const { useState: useStateShell } = React;
const NAV_ITEMS = [
  { key: 'dashboard',   label: 'Dashboard',    icon: 'dashboard' },
  { key: 'vessel-calls', label: 'Vessel Calls', icon: 'ship' },
  { key: 'inspections', label: 'Inspections',  icon: 'clipboard' },
  { key: 'invoices',    label: 'Invoices',     icon: 'invoice' },
  { key: 'analytics',   label: 'Analytics',    icon: 'gauge' },
  { key: 'settings',    label: 'Settings',     icon: 'settings' },
];

function Sidebar({ active, navigate, mobileOpen, closeMobile }) {
  return (
    <nav className={'sidebar ' + (mobileOpen ? 'open' : '')} aria-label="Primary">
      <div className="sb-brand">
        <div className="sb-mark"><Icon name="anchor" size={19} strokeWidth={2} /></div>
        <div className="sb-wordmark">Vessel Caller<span>Calabar Port · Inspection</span></div>
      </div>
      <div className="sb-nav scroll-host">
        <div className="sb-nav-label">Operations</div>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            className={'sb-item ' + (active === item.key ? 'active' : '')}
            onClick={() => { navigate(item.key); closeMobile(); }}
            aria-current={active === item.key ? 'page' : undefined}
          >
            <Icon name={item.icon} size={19} className="ico" />
            <span className="lbl">{item.label}</span>
          </button>
        ))}
      </div>
      <div className="sb-user">
        <div className="avatar">{CURRENT_USER.initials}</div>
        <div className="sb-user-meta">
          <div className="nm">{CURRENT_USER.name}</div>
          <div className="rl">{CURRENT_USER.role}</div>
        </div>
        <button className="sb-signout" title="Sign out" aria-label="Sign out"><Icon name="logout" size={17} /></button>
      </div>
    </nav>
  );
}

function TopBar({ title, onHamburger, portName }) {
  const [menuOpen, setMenuOpen] = useStateShell(false);
  return (
    <header className="topbar">
      <div className="flex items-center" style={{ minWidth: 0 }}>
        <button className="hamburger" onClick={onHamburger} aria-label="Open menu"><Icon name="menu" /></button>
        <h1>{title}</h1>
      </div>
      <div className="topbar-right">
        <button className="port-select">
          <Icon name="anchor" size={15} strokeWidth={2} />
          <span className="ps-label">{portName}</span>
          <Icon name="chevronDown" size={15} />
        </button>
        <button className="icon-btn" aria-label="Notifications" title="Notifications">
          <Icon name="bell" size={19} /><span className="bell-dot" />
        </button>
        <div style={{ position: 'relative' }}>
          <button className="icon-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="User menu"
            style={{ width: 'auto', padding: '0 6px', gap: 6 }}>
            <div className="avatar" style={{ width: 30, height: 30, fontSize: 12 }}>{CURRENT_USER.initials}</div>
            <Icon name="chevronDown" size={15} />
          </button>
          {menuOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 1 }} onClick={() => setMenuOpen(false)} />
              <div style={{ position: 'absolute', right: 0, top: '110%', background: '#fff', border: '1px solid var(--hairline)', borderRadius: 8, boxShadow: 'var(--shadow-pop)', minWidth: 200, zIndex: 2, padding: 6 }}>
                <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--hairline)', marginBottom: 4 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{CURRENT_USER.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--slate-soft)' }}>{CURRENT_USER.role}</div>
                </div>
                <button className="sb-item" style={{ borderLeft: 'none' }}><Icon name="settings" size={17} /><span className="lbl">Account settings</span></button>
                <button className="sb-item" style={{ borderLeft: 'none', color: 'var(--danger)' }}><Icon name="logout" size={17} /><span className="lbl">Sign out</span></button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

window.Sidebar = Sidebar;
window.TopBar = TopBar;
