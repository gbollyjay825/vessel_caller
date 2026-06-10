# Vessel Caller — Calabar Port Inspection (Frontend)

The approved **Vessel Caller** UI for managing maritime vessel calls and cargo
inspections at the Port of Calabar — vessel registration, liquid/dry cargo
inspections, NPA harbour dues & agency commission, invoices, analytics, and
printable invoice/report documents.

This is the design-master UI (from `Vessel master.zip`), copied exactly.

---

## Running it

No build step. The app is React 18 + Babel Standalone loaded from CDN, so it
runs from any static file server (internet access required for the CDN):

```bash
./serve.sh            # http://localhost:8000
# or:
python3 server.py
```

| Entry | What it is |
|---|---|
| `index.html` | The desktop app (identical copy of `Calabar Port Inspection.html` from the design master) |
| `Mobile Data Capture.html` | The mobile quayside data-capture app (iOS-framed) |
| `calabar/pdf.html` | Print-ready invoice/report document opened by the PDF buttons |

## Structure

```
index.html                  desktop entry (React + Babel via CDN)
Mobile Data Capture.html    mobile capture entry (shares calabar/data + icons)
calabar/
  styles.css                design system styles
  data.jsx                  seed data (vessel calls, inspections, invoices)
  analytics-data.jsx        port-level throughput / product mix aggregates
  icons.jsx                 icon set
  ui.jsx                    shared UI components
  charts.jsx                chart components
  shell.jsx                 sidebar + topbar shell
  app.jsx                   root app + routing
  screens-ops.jsx           dashboard + vessel calls
  screens-inspections.jsx   inspections + flow
  screen-analytics.jsx      analytics
  screens-settings.jsx      settings
  track-vessel.jsx          vessel tracking
  pdf.html                  printable invoice/report template
mobile/                     mobile app modules (ios-frame, mobile-app, css)
```

## Deploy

Deployed on Vercel as a static site: **https://vessel-caller.vercel.app**

```bash
npx vercel deploy --prod   # (run from a copy at a path without spaces)
```

> Note: the prior zero-dependency vanilla-JS implementation lives in git
> history (up to commit 3e5bb56) if it's ever needed for reference.
