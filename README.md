# Calabar Port — Inspection Platform (Frontend)

A clean, white, high-trust operational frontend for managing maritime **vessel
calls** and **cargo inspections** at the Port of Calabar — registering vessels,
logging liquid/dry inspections, and surfacing the computed NPA harbour dues,
agency commission, and downloadable invoice/report PDFs.

Built to the brief in `01-UI-Specification.md`.

---

## Running it

No build step, no Node, no dependencies. It is plain HTML + CSS + native ES
modules. Because ES modules must be served over HTTP (not `file://`), use the
included script:

```bash
./serve.sh            # http://localhost:8000
# or pick a port:
./serve.sh 4000
# or directly:
python3 -m http.server 8000
```

Then open **http://localhost:8000**.

> Tip: the PDF action buttons open a print-ready document in a **new tab** —
> allow pop-ups for localhost.

---

## What's implemented

All five screens from the spec, fully navigable and visually consistent:

- **Dashboard** — KPI strip, recent vessel calls, empty state, PDF buttons on completed rows.
- **Vessel Calls** — list (search · status · date filters · pagination), Register slide-over (inline + async-unique validation), detail (particulars · inspections · financials + PDFs).
- **Inspections** — list (Liquid/Dry tags, Report/Resume), and the 3-step flow: link & type → measurement with **live reconciled tonnage** → review with **live charge preview** → success screen with both PDFs.
- **Invoices** — list with always-two PDF buttons + line-item detail drawer.
- **Settings** — charge config, notifications (SMTP/Twilio + connection status + send test), port profile, sticky save bar with unsaved-changes guard.

Shared components (`js/components/`): status badge, PDF action button, money
figure, stat card, sortable/responsive data table, stepper, modal/slide-over
(focus-trapped, escape/backdrop dismiss), toast, live-calc display, validated
form fields.

Responsive across the three breakpoints (full sidebar → icon rail → mobile
drawer; tables collapse to cards under 768px).

---

## Architecture

```
index.html              app shell + portals (#modal-root, #toast-root)
css/
  tokens.css            design tokens (colour, type, spacing) — single source
  base.css              reset, typography, the sidebar/topbar/content shell
  components.css        every reusable component's styles
js/
  main.js               bootstrap: builds the shell, wires the router to screens
  router.js             hash router with /:param matching
  dom.js                h() hyperscript helper
  format.js             money / naira / tonnage / date formatting
  icons.js              inline line-icon set (20px, currentColor)
  pdf.js                print-ready invoice/report document (stands in for /api/pdf)
  store.js              seed data + calc engine + async `api` (mirrors §1.12)
  components/           ui.js, table.js, modal.js, toast.js
  screens/              dashboard, vesselCalls, vesselCallDetail, registerCall,
                        inspections, newInspection, invoices, settings
```

### Wiring the real backend

The UI never computes dues or commission — it only displays/formats figures.
Everything backend-facing lives in **`js/store.js`** behind an `api` object whose
methods map 1:1 to the REST contract in spec §1.12:

| `api` method | Endpoint |
|---|---|
| `listVesselCalls` / `getVesselCall` | `GET /api/vessel-calls` · `/:id` |
| `createVesselCall` | `POST /api/vessel-calls` |
| `listInspections` / `getInspection` | `GET /api/inspections` · `/:id` |
| `createInspection` | `POST /api/inspections` |
| `calcPreview` | calc-preview endpoint (live charge preview) |
| `listInvoices` | `GET /api/invoices` |
| `getSettings` / `updateSettings` | `GET`/`PUT` settings |
| PDF buttons | `GET /api/pdf/:filename` |

To go live, replace each method body with a `fetch()` and point the PDF buttons
at `/api/pdf/:filename` (see `js/components/ui.js` → `pdfButton`). No call sites
or components change.

### The calc engine (mock)

`computeCharges()` in `store.js` reproduces the spec's showcase exactly:

```
28,722.94 MT × $1.85/MT            = $53,137.44  harbour dues
$53,137.44 × 3.5%                  = $1,859.81   commission
$1,859.81 × ₦1,600/USD            = ₦2,975,696  commission (NGN)
```

These rates are configurable in **Settings → Charge configuration**.

---

## Notes

- Created records persist in `localStorage` (`cpip:v1`) so the demo survives a
  reload. `resetData()` in `store.js` restores the seed.
- Accessibility: keyboard-navigable, visible accent focus rings, ARIA labels on
  icon-only buttons, status conveyed by text+icon (not colour alone), AA-targeted
  palette.
