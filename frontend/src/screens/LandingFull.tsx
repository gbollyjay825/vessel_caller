import { useEffect, useState } from "react";
import { ProductBrand } from "../components/ProductBrand";
import { Link } from "../lib/navigation";

const NAV = [
  ["#voyage-flow", "Voyage flow"],
  ["#readings", "Readings"],
  ["#team-access", "Team access"],
] as const;

const STEPS = [
  {
    title: "Vessel & declaration",
    body: "Select the vessel and set up its voyage. Record the owner’s declared load for this trip and the declaration already paid for.",
  },
  {
    title: "Independent readings",
    body: "Select agencies from your reusable directory. Keep each agency’s reading separate, using container sizes, liquid products, bulk or mixed cargo.",
  },
  {
    title: "Readings report",
    body: "Compare the owner’s declaration with every agency’s submission, side by side. Each cargo item keeps its own row and measurement unit.",
  },
  {
    title: "NPA reconciliation",
    body: "Review differences, agree NPA’s final quantity for each row, and record the reason for the decision.",
  },
  {
    title: "Extra-load invoice preview",
    body: "Prepare a preview for load above the paid declaration. If the final quantity is lower, flag the overpayment for review.",
  },
];

function ReadingsExample() {
  return (
    <div className="home-example" aria-labelledby="example-title">
      <div className="home-example-header">
        <span className="home-example-label">Illustrative voyage</span>
        <h2 id="example-title">One voyage, side by side</h2>
        <p>MV Example · Import cargo</p>
      </div>
      <div className="home-example-table" role="region" aria-label="Illustrative voyage readings" tabIndex={0}>
        <table>
          <caption>Readings & reconciliation · container counts</caption>
          <thead>
            <tr><th scope="col">Cargo</th><th scope="col">Owner</th><th scope="col">Agency A</th><th scope="col">Agency B</th><th scope="col">NPA final</th></tr>
          </thead>
          <tbody>
            <tr><th scope="row">20 ft laden</th><td>100</td><td>102</td><td>101</td><td>102</td></tr>
            <tr><th scope="row">40 ft laden</th><td>50</td><td>50</td><td>50</td><td>50</td></tr>
          </tbody>
        </table>
      </div>
      <div className="home-example-result">
        <span>Above the paid declaration</span>
        <strong>2 extra 20 ft containers</strong>
        <p>Only this extra load goes into the invoice preview.</p>
      </div>
      <p className="home-example-note">Example figures only. NPA’s final reading is a reviewed decision, not an automatic average.</p>
    </div>
  );
}

export function Landing() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const sections = Array.from(document.querySelectorAll(".npa-home .reveal"));
    if (!("IntersectionObserver" in window)) return;
    document.documentElement.classList.add("js-reveal");
    const reveal = (section: Element) => section.classList.add("in");
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          reveal(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });
    sections.forEach((section) => {
      const bounds = section.getBoundingClientRect();
      if (bounds.top < window.innerHeight && bounds.bottom > 0) reveal(section);
      else observer.observe(section);
    });
    return () => { observer.disconnect(); document.documentElement.classList.remove("js-reveal"); };
  }, []);

  return (
    <div className="npa-home" id="top">
      <a className="home-skip-link" href="#home-content">Skip to content</a>
      <header className="home-header">
        <div className="home-wrap home-header-inner">
          <a className="home-brand" href="#top" aria-label="NPA Vessel Caller home">
            <ProductBrand subtitle="Voyage readings & reconciliation" />
          </a>
          <nav className="home-nav" aria-label="Main navigation">
            {NAV.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
          </nav>
          <Link className="home-sign-in" to="/login">Sign in</Link>
          <button className="home-menu-button" type="button" aria-label="Menu" aria-expanded={menuOpen}
            aria-controls="home-mobile-menu" onClick={() => setMenuOpen((open) => !open)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d={menuOpen ? "M6 6l12 12M6 18L18 6" : "M4 6h16M4 12h16M4 18h16"} />
            </svg>
          </button>
        </div>
        <nav className="home-mobile-menu" id="home-mobile-menu" aria-label="Mobile navigation" hidden={!menuOpen}>
          {NAV.map(([href, label]) => <a key={href} href={href} onClick={() => setMenuOpen(false)}>{label}</a>)}
          <Link to="/login" onClick={() => setMenuOpen(false)}>Sign in</Link>
        </nav>
      </header>

      <main id="home-content">
        <section className="home-hero" aria-labelledby="home-title">
          <div className="home-wrap home-hero-grid">
            <div className="home-hero-copy">
              <span className="home-kicker">Voyage measurement & reconciliation</span>
              <h1 id="home-title">One voyage.<br />One clear set<br className="home-title-break" /> of readings.</h1>
              <p className="home-lead">Compare what the owner declared with independent agency readings, agree NPA’s final quantity, and prepare an invoice preview for any extra load.</p>
              <div className="home-actions">
                <Link className="home-button home-button-primary" to="/app/dashboard">Open workspace <span aria-hidden="true">→</span></Link>
                <a className="home-button home-button-outline" href="#voyage-flow">See the voyage flow</a>
              </div>
              <p className="home-privacy">Organization data is private and available only to verified, authorized users.</p>
            </div>
            <ReadingsExample />
          </div>
          <div className="home-wrap">
            <div className="home-preview-note"><strong>Current UI preview</strong><span>Reconciliation and variation invoices are saved in this browser. An invoice preview is not an issued financial record.</span></div>
          </div>
        </section>

        <section className="home-workflow" id="voyage-flow" aria-labelledby="workflow-title">
          <div className="home-wrap">
            <div className="home-section-heading reveal">
              <span className="home-kicker">The voyage flow</span>
              <h2 id="workflow-title">From declaration to a reviewed final quantity.</h2>
              <p>The vessel is a reusable record. Each voyage has its own declaration, agency readings and NPA decision.</p>
            </div>
            <ol className="home-steps">
              {STEPS.map((step, index) => (
                <li className="home-step reveal" key={step.title}>
                  <span className="home-step-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <h3>{step.title}</h3><p>{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="home-readings" id="readings" aria-labelledby="readings-title">
          <div className="home-wrap home-readings-grid">
            <div className="home-section-heading reveal">
              <span className="home-kicker">Readings for every voyage</span>
              <h2 id="readings-title">Keep the source of every reading clear.</h2>
              <p>Read the cargo categories down the rows and the owner and agencies across the columns. Compare each quantity in its own unit before NPA reconciles it.</p>
              <ul className="home-checklist">
                <li>Container sizes and laden or empty counts</li>
                <li>Liquid cargo by product, including petroleum, chemicals or gas</li>
                <li>Bulk and mixed cargo, with separate measurement units</li>
              </ul>
            </div>
            <div className="home-next-action reveal">
              <span className="home-kicker">Your activity dashboard</span>
              <h3>Know what to do next.</h3>
              <p>Find the voyages waiting for agency readings, ready for NPA review or needing an extra-load invoice preview.</p>
              <div className="home-baseline-rule"><strong>The declared load is already paid.</strong><p>The preview covers positive extra quantities only. A lower final quantity is flagged for overpayment review.</p></div>
              <Link className="home-text-link" to="/app/dashboard">Open activity dashboard <span aria-hidden="true">→</span></Link>
            </div>
          </div>
        </section>

        <section className="home-team" id="team-access" aria-labelledby="team-title">
          <div className="home-wrap home-team-grid">
            <div className="home-section-heading reveal">
              <span className="home-kicker">Team access</span>
              <h2 id="team-title">Join the right organization.</h2>
              <p>An Admin manages team invitations, reviews join requests and assigns each person’s role.</p>
              <Link className="home-button home-button-green" to="/login">Sign in to your workspace <span aria-hidden="true">→</span></Link>
            </div>
            <div className="home-access-options reveal">
              <div><span className="home-access-number" aria-hidden="true">1</span><div><h3>Already have an account?</h3><p>Sign in to continue your voyages and see your next action.</p></div></div>
              <div><span className="home-access-number" aria-hidden="true">2</span><div><h3>Received an invitation?</h3><p>Open the link in your invitation email to set up your account with the role assigned by your Admin.</p></div></div>
              <div><span className="home-access-number" aria-hidden="true">3</span><div><h3>Received an organization sign-up link?</h3><p>Request to join, verify your email and wait for Admin approval. The link does not grant access automatically.</p></div></div>
            </div>
          </div>
        </section>
      </main>

      <footer className="home-footer">
        <div className="home-wrap home-footer-inner">
          <ProductBrand />
          <p>Declarations · Agency readings · NPA reconciliation · Invoice previews</p>
          <a className="home-back-to-top" href="#top">Back to top ↑</a>
        </div>
      </footer>
    </div>
  );
}
