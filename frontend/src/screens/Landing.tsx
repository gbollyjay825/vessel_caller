// Compact homepage. The full dark-navy marketing landing is ported on top of
// this in the screens phase; this keeps the route working and on-brand.
import { Link } from "react-router-dom";

const anchor = (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22V8" /><path d="M5 12H2a10 10 0 0 0 20 0h-3" /><circle cx="12" cy="5" r="3" />
  </svg>
);

export function Landing() {
  return (
    <div className="hero" style={{ minHeight: "100vh" }}>
      <header className="nav">
        <div className="wrap nav-in">
          <span className="brand"><span className="mark">{anchor}</span> Vessel Caller</span>
          <div className="nav-cta">
            <Link className="btn btn-line" to="/login">Sign in</Link>
            <Link className="btn btn-amber" to="/register">Get started</Link>
          </div>
        </div>
      </header>
      <div className="wrap hero-in">
        <span className="badge"><span className="dot" /> NPA tariff-aligned · Built for Nigerian ports</span>
        <h1>Every vessel call,<br />from <span className="serif">berth</span> to <span className="serif">paid.</span></h1>
        <p className="sub">
          The end-to-end platform for maritime cargo inspection — vessel calls, liquid &amp; dry reconciliation,
          automated harbour dues, invoicing and payment tracking, in one auditable system.
        </p>
        <div className="hero-cta">
          <Link className="btn btn-amber" to="/register">Get started</Link>
          <Link className="btn btn-line" to="/login">Sign in</Link>
        </div>
      </div>
    </div>
  );
}
