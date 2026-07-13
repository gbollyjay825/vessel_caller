/* global React, ReactDOM */
// ============================================================
// landing.jsx — the Vessel Caller marketing homepage, as React.
// Same vendored React 18 + Babel runtime as the app (app.html) and
// the mobile capture app — no build step. Styles: calabar/landing.css.
// ============================================================
const { useState: useStateLanding, useEffect: useEffectLanding } = React;

// ---- tiny inline icon set (stroke, inherits currentColor) ----
const STROKE = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' };
function Svg({ size = 20, sw = 2, vb = '0 0 24 24', children, ...rest }) {
  return <svg width={size} height={size} viewBox={vb} strokeWidth={sw} {...STROKE} {...rest}>{children}</svg>;
}
const IcAnchor = (p) => <Svg {...p}><path d="M12 22V8" /><path d="M5 12H2a10 10 0 0 0 20 0h-3" /><circle cx="12" cy="5" r="3" /></Svg>;
const IcArrow = (p) => <Svg sw={2.6} {...p}><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></Svg>;
const IcCheck = (p) => <Svg sw={3} {...p}><polyline points="20 6 9 17 4 12" /></Svg>;

const ArrBtn = () => <span className="arr"><IcArrow size={12} /></span>;

// ---- content ----
const NAV = [['#platform', 'Platform'], ['#how', 'How it works'], ['#dues', 'Tariff'], ['#quayside', 'Quayside']];

const STATS = [
  ['6', '+', 'NPA ports supported, multi-port organizations'],
  ['2', '×', 'Cargo modes — ullage survey & draft survey'],
  ['USD', '·₦', 'Dual-currency dues, commission & receivables'],
  ['100', '%', 'Of figures traceable to their tonnage basis'],
];

const PORTS = ['Port of Calabar', 'Apapa Port, Lagos', 'Tin Can Island Port', 'Onne Port, Rivers',
  'Port Harcourt Port', 'Warri Port, Delta', 'NPA tariff-aligned', 'Liquid · PMS · AGO · DPK', 'Dry & bulk cargo'];

const SMALL_FEATURES = [
  { icon: <IcAnchor size={22} sw={1.8} />, title: 'Vessel calls & tracking',
    body: 'Rotation numbers, net tonnage, arrival & sailing ETAs, berth terminals — with AIS-style voyage tracking to the berth.' },
  { icon: <Svg size={22} sw={1.8}><path d="M12 2.7l5.66 5.66a8 8 0 1 1-11.32 0z" /></Svg>, title: 'Liquid & dry surveys',
    body: "Guided three-step wizard: the surveyor's reconciled tonnage for liquid, draft survey for dry — the figure forms live as you type." },
  { icon: <Svg size={22} sw={1.8}><rect x="4" y="3" width="16" height="18" rx="2" /><line x1="8" y1="8" x2="16" y2="8" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="8" y1="16" x2="13" y2="16" /></Svg>, title: 'Invoices & payments',
    body: 'Invoices issue automatically with the amount locked at the issued rate. Record payments with a reference and audit trail; overdue flags itself.' },
  { icon: <Svg size={22} sw={1.8}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></Svg>, title: 'Roles & permissions',
    body: 'Admin, Operations, Finance and Viewer — every action gated to the right role, from registering calls to recording payments.' },
];

const STEPS = [
  { k: '01', icon: <Svg sw={2}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 2v4M16 2v4M3 10h18" /></Svg>,
    title: 'Register your organization', body: 'Company profile, operating ports, your logo, and a team with the right roles.' },
  { k: '02', icon: <IcAnchor sw={2} />, title: 'Register the vessel call',
    body: 'Rotation number, net tonnage, arrival & sailing ETAs and the berth terminal.' },
  { k: '03', icon: <Svg sw={2}><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></Svg>,
    title: 'Capture the inspection', body: 'Console or quayside. Dues and commission preview before the surveyor submits.' },
  { k: '04', icon: <Svg sw={2}><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></Svg>,
    title: 'Invoice & get paid', body: 'The invoice issues itself at the locked rate. Record payment; receivables update everywhere.' },
];

const TARIFF = [
  ['Liquid', ' · Government Jetty', '$1.68'],
  ['Liquid', ' · Private Jetty', '$2.88'],
  ['Liquid', ' · International Jetty', '$4.23'],
  ['Dry / bulk', ' · all cargo', '$2.17'],
];

const DUES_POINTS = [
  'Government / Private / International jetty classification',
  'Agency commission in USD and naira at your FX rate',
  'Basis printed on every breakdown, invoice and report',
];

const FOOTER = [
  ['Platform', [['#platform', 'Operations console'], ['#quayside', 'Quayside capture'], ['#dues', 'Harbour dues'], ['#how', 'How it works']]],
  ['App', [['app.html', 'Launch console'], ['Mobile Data Capture.html', 'Mobile capture'], ['app.html', 'Sign in']]],
  ['Operations', [['app.html', 'Vessel calls'], ['app.html', 'Inspections'], ['app.html', 'Invoices'], ['app.html', 'Analytics']]],
];

// ---- the port scene (decorative) ----
const CONTAINERS = [
  [470, 238, 64, '#E8A33D'], [538, 238, 64, '#3E7CC0'], [606, 238, 64, '#D9A441'], [674, 238, 64, '#2C6BB0'],
  [742, 238, 64, '#E8A33D'], [810, 238, 64, '#4C88C8'], [878, 238, 64, '#D9A441'], [946, 238, 56, '#2C6BB0'],
  [504, 216, 64, '#3574B8'], [572, 216, 64, '#E8A33D'], [640, 216, 64, '#4C88C8'], [708, 216, 64, '#D9A441'],
  [776, 216, 64, '#2C6BB0'], [844, 216, 64, '#E8A33D'],
  [540, 194, 64, '#D9A441'], [608, 194, 64, '#2C6BB0'], [676, 194, 64, '#E8A33D'], [744, 194, 64, '#4C88C8'],
];
function PortScene() {
  return (
    <div className="scene" aria-hidden="true">
      <svg viewBox="0 0 1440 330" preserveAspectRatio="xMidYMax slice">
        <g fill="rgba(255,255,255,0.35)">
          <circle cx="140" cy="46" r="1.6" /><circle cx="360" cy="24" r="1.2" /><circle cx="620" cy="58" r="1.4" />
          <circle cx="980" cy="30" r="1.2" /><circle cx="1180" cy="66" r="1.6" /><circle cx="1340" cy="34" r="1.2" />
        </g>
        <circle cx="1150" cy="70" r="26" fill="rgba(232,163,61,0.9)" />
        <circle cx="1150" cy="70" r="42" fill="rgba(232,163,61,0.18)" />
        <g stroke="rgba(255,255,255,0.30)" strokeWidth="3" fill="none">
          <path d="M210 250 V96 M210 96 H340 M340 96 V120 M300 96 V150 M210 130 L268 96" />
          <rect x="196" y="250" width="28" height="14" fill="rgba(255,255,255,0.30)" stroke="none" />
          <path d="M300 150 h20 v16 h-20 z" fill="rgba(232,163,61,0.65)" stroke="none" />
        </g>
        <g stroke="rgba(255,255,255,0.44)" strokeWidth="4" fill="none">
          <path d="M96 262 V70 M96 70 H262 M262 70 V98 M212 70 V132 M96 112 L168 70" />
          <rect x="80" y="262" width="34" height="16" fill="rgba(255,255,255,0.44)" stroke="none" />
          <path d="M212 132 h26 v20 h-26 z" fill="var(--amber)" stroke="none" opacity="0.9" />
        </g>
        <g>
          <path d="M420 258 L1120 258 L1082 306 L470 306 Z" fill="#123A63" />
          <path d="M420 258 L1120 258 L1112 272 L432 272 Z" fill="#1B5FAA" opacity="0.85" />
          <rect x="1010" y="196" width="66" height="62" rx="3" fill="#E9EEF4" />
          <rect x="1018" y="206" width="50" height="9" rx="2" fill="#9FB4C8" />
          <rect x="1018" y="222" width="50" height="9" rx="2" fill="#9FB4C8" />
          <rect x="1042" y="176" width="7" height="20" fill="#E9EEF4" />
          <g>
            {CONTAINERS.map(([x, y, w, fill], i) => (
              <rect key={i} x={x} y={y} width={w} height="20" rx="2" fill={fill} />
            ))}
          </g>
          <g fill="rgba(232,163,61,0.9)">
            <circle cx="500" cy="282" r="2.4" /><circle cx="580" cy="282" r="2.4" /><circle cx="660" cy="282" r="2.4" />
            <circle cx="740" cy="282" r="2.4" /><circle cx="820" cy="282" r="2.4" /><circle cx="900" cy="282" r="2.4" />
            <circle cx="980" cy="282" r="2.4" /><circle cx="1050" cy="282" r="2.4" />
          </g>
        </g>
        <g>
          <path d="M1250 292 l10 -22 10 22 z" fill="#E8A33D" />
          <circle cx="1260" cy="266" r="4" fill="rgba(232,163,61,0.9)" />
        </g>
        <rect x="0" y="300" width="1440" height="30" fill="#081627" />
        <path d="M0 300 Q 120 292 240 300 T 480 300 T 720 300 T 960 300 T 1200 300 T 1440 300 V330 H0 Z" fill="#0B2A49" />
        <g stroke="rgba(120,180,240,0.35)" strokeWidth="2" strokeLinecap="round">
          <path d="M180 314 h56" /><path d="M420 320 h44" /><path d="M760 316 h60" /><path d="M1020 320 h40" /><path d="M1280 314 h52" />
        </g>
        <g stroke="rgba(232,163,61,0.4)" strokeWidth="2" strokeLinecap="round">
          <path d="M560 322 h36" /><path d="M900 322 h30" /><path d="M1160 318 h30" />
        </g>
      </svg>
    </div>
  );
}

// ============================================================
function Landing() {
  const [menuOpen, setMenuOpen] = useStateLanding(false);
  const closeMenu = () => setMenuOpen(false);

  // Scroll-reveal: fade sections in as they enter the viewport. Content
  // is visible up-front if IntersectionObserver is unavailable.
  useEffectLanding(() => {
    const els = Array.from(document.querySelectorAll('.reveal'));
    // Without an observer, leave everything visible (the CSS default).
    if (!('IntersectionObserver' in window)) return;
    // Opt into the hidden-then-revealed animation only now that JS is live.
    document.documentElement.classList.add('js-reveal');
    const reveal = (el) => el.classList.add('in');
    // Reveal whatever is already on screen at load; observe the rest so they
    // fade in as they scroll into view.
    const onScreen = (el) => { const r = el.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; };
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) { reveal(en.target); io.unobserve(en.target); } });
    }, { threshold: 0.1 });
    els.forEach((el) => { if (onScreen(el)) reveal(el); else io.observe(el); });
    return () => { io.disconnect(); document.documentElement.classList.remove('js-reveal'); };
  }, []);

  const Brand = ({ light }) => (
    <a className="brand" href="#top" style={light ? { color: '#fff' } : undefined}>
      <span className="mark"><IcAnchor size={19} /></span>
      <span>Vessel Caller<small style={light ? { color: 'rgba(255,255,255,.4)' } : undefined}>Port Inspection</small></span>
    </a>
  );

  return (
    <React.Fragment>
      {/* ================= NAV ================= */}
      <header className="nav">
        <div className="wrap nav-in">
          <Brand />
          <nav className="nav-links">
            {NAV.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
          </nav>
          <div className="nav-cta">
            <a className="btn btn-line" href="app.html">Sign in</a>
            <a className="btn btn-amber" href="app.html">Launch app</a>
          </div>
          <button className="hamburger" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
            <Svg><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></Svg>
          </button>
        </div>
        <div className={'mobile-menu' + (menuOpen ? ' open' : '')} onClick={(e) => { if (e.target.tagName === 'A') closeMenu(); }}>
          {NAV.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
          <a href="app.html" style={{ color: 'var(--amber)', fontWeight: 700 }}>Launch app →</a>
        </div>
      </header>

      {/* ================= HERO ================= */}
      <a id="top" />
      <div className="hero">
        <div className="wrap hero-in">
          <span className="badge"><span className="dot" /> NPA tariff-aligned · Built for Nigerian ports</span>
          <h1>Every vessel call,<br />from <span className="serif">berth</span> to <span className="serif">paid.</span></h1>
          <p className="sub">Vessel Caller runs the complete port-inspection workflow — vessel registration, liquid &amp; dry cargo reconciliation, automated harbour dues, invoicing and payment tracking — in one auditable system.</p>
          <div className="hero-cta">
            <a className="btn btn-amber" href="app.html">Launch the app <ArrBtn /></a>
            <a className="btn btn-line" href="#how">See how it works</a>
          </div>

          <form className="track" action="app.html" aria-label="Look up a vessel call">
            <span className="ic"><Svg size={19}><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" /></Svg></span>
            <input type="text" placeholder="Look up a rotation number — e.g. ROT-2026-0438" aria-label="Rotation number" />
            <button className="btn btn-blue" type="submit">Track vessel</button>
          </form>
          <div className="track-hint"><b>Try the live demo</b> — seeded with vessel calls, inspections and invoices.</div>
        </div>

        <PortScene />
      </div>

      {/* stats */}
      <div className="stats">
        <div className="wrap stats-in">
          {STATS.map(([n, sym, t], i) => (
            <div className="stat" key={i}><div className="n">{n}<span>{sym}</span></div><div className="t">{t}</div></div>
          ))}
        </div>
      </div>

      {/* marquee */}
      <div className="marquee" aria-hidden="true">
        <div className="mq-track">
          {[...PORTS, ...PORTS].map((t, i) => (
            <span className="mq-chip" key={i}><IcAnchor size={13} sw={2.4} />{t}</span>
          ))}
        </div>
      </div>

      {/* ================= PLATFORM (bento) ================= */}
      <section id="platform">
        <div className="wrap">
          <div className="sec-head reveal">
            <span className="eyebrow">The platform</span>
            <h2>One system, <span className="serif">from vessel-in to paid invoice.</span></h2>
            <p>Purpose-built for agencies and marine surveyors at Nigerian ports — no spreadsheets, no re-keying, one trustworthy set of figures for operations and finance.</p>
          </div>

          <div className="bento">
            <div className="cell big reveal">
              <div className="cic"><Svg size={23} sw={1.8}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></Svg></div>
              <h3>The operations console</h3>
              <p>Vessel calls, inspections, invoices and analytics in one dashboard — with live voyage tracking for every inbound ship and a full audit trail behind every number.</p>
              <div className="mini">
                <div className="mini-frame">
                  <div className="mini-kpis">
                    <div className="mini-kpi"><div className="l">Active calls</div><div className="v">4</div></div>
                    <div className="mini-kpi"><div className="l">Dues collected</div><div className="v tnum">$100,587</div></div>
                    <div className="mini-kpi"><div className="l">Outstanding</div><div className="v tnum">$224,639</div></div>
                  </div>
                  <div className="mini-row"><b>MT Sea Eagle</b><span className="rf">ROT-2026-0438</span><span className="pill ok">Paid</span></div>
                  <div className="mini-row"><b>MV Calabar Pride</b><span className="rf">ROT-2026-0437</span><span className="pill warn">Unpaid</span></div>
                  <div className="mini-row"><b>MV Atlantic Dawn</b><span className="rf">ROT-2026-0435</span><span className="pill due">Overdue</span></div>
                </div>
              </div>
            </div>

            <div className="cell big reveal">
              <div className="cic" style={{ background: 'var(--amber-soft)', color: '#B97F22' }}><Svg size={23} sw={1.8}><rect x="7" y="2" width="10" height="20" rx="2.5" /><line x1="11" y1="18" x2="13" y2="18" /></Svg></div>
              <h3>Quayside capture, synced live</h3>
              <p>Surveyors capture ullage, draft and jetty details at the berth — offline if the signal drops — and every inspection lands on the office console in seconds.</p>
              <div className="mini-phone">
                <div className="mini-scr">
                  <div className="ms-top"><div className="e">Port of Calabar</div><div className="h">Inspections</div></div>
                  <div className="ms-num"><div className="l">Reconciled tonnage</div><div className="v tnum">38,000.00 <small>MTS</small></div></div>
                  <div className="ms-card"><div className="nm">MT Niger Trader</div><div className="rf">ROT-2026-0439 · International Jetty · $4.23/NT</div></div>
                </div>
              </div>
            </div>

            {SMALL_FEATURES.map((f, i) => (
              <div className="cell small reveal" key={i}>
                <div className="cic">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ================= HOW ================= */}
      <section id="how" className="how">
        <div className="wrap">
          <div className="sec-head center reveal">
            <span className="eyebrow">How it works</span>
            <h2>Four steps. <span className="serif">One audit trail.</span></h2>
          </div>
          <div className="steps">
            {STEPS.map((s) => (
              <div className="step reveal" key={s.k}>
                <span className="k">{s.k}</span>
                <div className="sic">{s.icon}</div>
                <h3>{s.title}</h3><p>{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ================= TARIFF ================= */}
      <section id="dues" className="dues-band">
        <div className="wrap dues-grid">
          <div className="reveal">
            <span className="eyebrow">Automated harbour dues</span>
            <h2>The right rate, applied the moment the survey lands.</h2>
            <p className="lead">Dues are assessed on the vessel's net tonnage at the applicable NPA rate — selected by jetty classification for liquid cargo, flat for dry — and locked onto the invoice at issue time. Change your tariff later; history stays honest.</p>
            <ul>
              {DUES_POINTS.map((pt, i) => (
                <li key={i}><span className="ck"><IcCheck size={12} /></span> {pt}</li>
              ))}
            </ul>
          </div>
          <div className="tariff reveal">
            <div className="th"><b>Harbour dues tariff</b><span>USD per net-tonnage ton</span></div>
            {TARIFF.map(([cat, rest, rate], i) => (
              <div className="trow" key={i}>
                <span className="c"><b>{cat}</b>{rest}</span>
                <span className="r tnum">{rate} <small>/ NT</small></span>
              </div>
            ))}
            <div className="note">Default tariff shown — each organization sets its own rates. Changes apply to future inspections only; issued invoices keep their locked amounts.</div>
          </div>
        </div>
      </section>

      {/* ================= QUOTE ================= */}
      <section id="quayside">
        <div className="wrap">
          <div className="quote reveal">
            <span className="qmark">“</span>
            <blockquote>We stopped arguing about figures. The surveyor submits at the jetty, the invoice issues itself at the right rate, and finance sees the payment the moment it's recorded.</blockquote>
            <div className="who">
              <span className="av">EO</span>
              <span><span className="nm">Etim Okon</span><br /><span className="rl">Port Agent · Port of Calabar</span></span>
            </div>
          </div>
        </div>
      </section>

      {/* ================= CTA ================= */}
      <section style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="cta reveal">
            <h2>Bring your next vessel call in<br />with Vessel Caller.</h2>
            <p>Register your organization, add your team, and run your first inspection today — the demo is live and seeded.</p>
            <div className="hero-cta">
              <a className="btn btn-amber" href="app.html">Launch the app <ArrBtn /></a>
              <a className="btn btn-line" href="Mobile Data Capture.html">Open the quayside app</a>
            </div>
          </div>
        </div>
      </section>

      {/* ================= FOOTER ================= */}
      <footer>
        <div className="wrap">
          <div className="foot-grid">
            <div className="foot-brand">
              <Brand light />
              <p>The end-to-end platform for maritime vessel calls, cargo inspection, harbour dues and payment tracking at Nigerian ports.</p>
            </div>
            {FOOTER.map(([heading, links]) => (
              <div className="foot-col" key={heading}>
                <h5>{heading}</h5>
                {links.map(([href, label]) => <a key={label} href={href}>{label}</a>)}
              </div>
            ))}
          </div>
          <div className="foot-mega" aria-hidden="true">VESSEL CALLER</div>
          <div className="foot-bottom">
            <span>© 2026 Vessel Caller · Built for the Port of Calabar and Nigerian ports.</span>
            <span>Vessel calls · Inspections · Harbour dues · Payments</span>
          </div>
        </div>
      </footer>
    </React.Fragment>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Landing />);
