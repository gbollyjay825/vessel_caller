# Vessel Caller — Port Inspection

The **Vessel Caller** platform for managing maritime vessel calls and cargo
inspections for a designated port — organization registration, logo branding,
role-based access, vessel registration, liquid/dry cargo inspections with
jetty-based harbour dues, agency commission, invoice/payment tracking,
analytics, printable invoice/report documents, and a mobile quayside
data-capture app.

React 18 + Babel Standalone frontend (design-master UI, no build step,
runtime vendored locally) wired to a **Python backend** (stdlib only, no
dependencies) with SQLite persistence.

---

## Running it

```bash
./serve.sh            # http://localhost:8000
# or:
python3 server.py     # PORT / HOST / VESSEL_DB env vars supported
```

One process serves everything: the static frontend, the REST API, and the
SQLite database (`vessel_caller.db`, created on first run and seeded with
demo data).

| Entry | What it is |
|---|---|
| `index.html` | The desktop app |
| `Mobile Data Capture.html` | The mobile quayside data-capture app (iOS-framed) |
| `calabar/pdf.html` | Print-ready invoice/report document opened by the PDF buttons |

The desktop and mobile apps share the same backend, so an inspection
captured on the quayside app appears in the desktop app (clients poll a
server `rev` counter every 5 s — it works across devices and browsers).

## The API (server.py)

| Endpoint | Behaviour |
|---|---|
| `GET /api/state[?rev=N]` | Full app state; `{changed:false}` when the client is current |
| `POST /api/vessel-calls` | Register a call (validates rotation-number uniqueness) |
| `DELETE /api/vessel-calls/:id` | Cancel a call, cascading its inspections and invoices |
| `POST /api/inspections` | Submit an inspection — the server numbers it and, when completed, marks the call completed and issues the next invoice |
| `PUT /api/organization` | Save registered organization profile, designated port, logo, members and roles |
| `PUT /api/invoices/:id` | Record or clear invoice payment status and audit details |
| `PUT /api/settings` | Save charge rates / notifications / port profile |
| `POST /api/reset` | Restore the demo seed data |

Harbour dues are computed from the vessel's **net tonnage × the applicable
rate**: liquid cargo by jetty classification (Government $1.68 · Private
$2.88 · International $4.23) and dry/bulk at a flat $2.17. Rates are
editable in Settings → Charge configuration.

## No backend? Automatic fallback

The frontend probes `/api/state` at boot (see `calabar/api.jsx`, the single
wiring seam). When the API isn't there — e.g. the static Vercel deploy at
**https://vessel-caller.vercel.app** — it falls back to browser
localStorage with the same behaviour, so the hosted demo stays fully
interactive. Settings → Port profile shows which store is active and offers
a data reset.

## Structure

```
server.py                   Python backend: static files + REST API + SQLite
index.html                  desktop entry (React + Babel, vendored locally)
Mobile Data Capture.html    mobile capture entry (shares the calabar modules)
vendor/                     react / react-dom / @babel/standalone (pinned)
calabar/
  api.jsx                   the wiring seam: backend client + local fallback
  styles.css                design system styles
  data.jsx                  demo seeds + rates + formatters
  icons.jsx / ui.jsx        icon set + shared components
  charts.jsx                chart components
  shell.jsx / app.jsx       sidebar + topbar shell, root app + store
  screens-org.jsx           organization onboarding, logo upload, team roles
  screens-ops.jsx           dashboard + vessel calls + invoice tracking
  screens-inspections.jsx   inspections + 3-step wizard
  screen-analytics.jsx      analytics
  screens-settings.jsx      settings (organization, team, rates, channels, port, data store)
  track-vessel.jsx          live voyage tracker
  pdf.html                  printable invoice/report template
mobile/                     mobile app modules (ios-frame, mobile-app, css)
```
