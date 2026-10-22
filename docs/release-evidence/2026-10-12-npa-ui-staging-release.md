# NPA voyage UI — staging release, 12 October 2026

## Outcome and scope

Deployed `npa-ui-20261012T185309Z` to https://staging.vesselcalls.com. This is a frontend-only artifact: no backend code, database migration, backend release symlink, worker configuration or accounting record changed. Nginx configuration validation passed before reload.

The signed-in staging browser displayed the NPA logo and green theme, the action-led Dashboard, Voyages, the three-step vessel/declaration/agency entry screen, and the voyage-linked Invoices view. The current account has no registered active vessel voyages, so its dashboard correctly starts with vessel/owner declaration setup. No demonstration records were inserted into the staging account.

## Demonstration of one complete voyage

The complete demonstration was exercised through the local preview UI for **MV Horizon / CALL-HORIZON**, importing wheat, with quantities in tonnes. The local mock server and browser-saved closeout previews are separate from staging data.

| Stage | Observed result |
| --- | --- |
| Vessel and voyage | Existing demo MV Horizon; CALL-HORIZON; Apapa, Berth 4. |
| Owner declaration | 19,500 tonnes; source `DEMO-OWNER-HORIZON-001`. |
| Independent agency readings | Demo Harbour Agency: 19,508; Demo Terminal: 19,500; Demo Cargo Agency: 19,508. |
| Agency link demonstration | Demo Terminal submitted through the local no-login portal. The owner baseline was not shown during entry. After submission, its own receipt/PDF and already completed peer reading were available. |
| Readings report | Owner declaration and all three latest agency readings appeared in separate columns for the same cargo row. |
| NPA reconciliation preview | Explicit final quantity 19,508, reason recorded, version 1 saved; agency readings and owner declaration retained unchanged. No averaging. |
| Original paid invoice | `DEMO-PAID-HORIZON-001`, USD 195,000, manually recorded as paid in the preview. |
| Additional invoice preview | Extra quantity = 19,508 − 19,500 = 8 tonnes. Demonstration rate USD 10/tonne, previous variation charges USD 0; additional amount USD 80. |

The rate is explicitly **DEMO ONLY**, not an NPA tariff. The original payment is excluded from the additional charge. No invoice was issued and no payment, refund or credit note was created. A lower final quantity is flagged for overpayment review.

Demo routes, while the local server is running:

- http://127.0.0.1:5178/app/measurements/voyages/call-horizon/readings
- http://127.0.0.1:5178/app/measurements/voyages/call-horizon/reconciliation
- http://127.0.0.1:5178/app/measurements/voyages/call-horizon/variation-invoice

Screenshots are saved under `/Users/gbolahan.salami/.codex/preview/vessel-agency-ui/horizon-walkthrough/`: `03-readings.png`, `04-reconciliation.png`, `05-additional-invoice.png`, and the authenticated `07-staging-dashboard.png`.

## Artifact and validation

- Base Git commit: `313bd2e4c6da5a770ba910d91ea0383c25989ed2`, branch `codex/measurement-agency-ui`, including the current uncommitted frontend changes.
- Frontend source SHA256: `541dde5c963439577535521059016d9a297b5fcbca88f1614407dff7587328d6`.
- Archive SHA256: `7d1d172fc7717fc8711ae803e78f616702b289c9bf67d1d00db5a36ca24a66c8`.
- Archive: `/Users/gbolahan.salami/.codex/preview/vessel-agency-ui/releases/npa-ui-20261012T185309Z.tar.gz`.
- Package contains only `dist/`, `UI_RELEASE.json`, and `SHA256SUMS`; no environment files, keys or backend source.
- 49 frontend test files / **517 tests passed**. Typecheck, lint, build and whitespace validation passed. The existing build-size warning remains.
- Built with explicit `VITE_API_BASE=''`, so API calls use staging's same origin.
- Public release identity: https://staging.vesselcalls.com/ui-release.json.

Independent outside HTTPS verification confirmed the release identity, new JS/CSS, NPA logo, index and deep-route SPA fallbacks returning 200. A second agent verified the uploaded archive and every package file checksum on the droplet.

## Live deployment state

- Immutable UI directory: `/opt/vessel-caller/frontend-releases/staging/npa-ui-20261012T185309Z/dist`.
- Dedicated static symlink: `/opt/vessel-caller/slots/staging/frontend-current` → that directory.
- Only the staging SPA `root` directive changed, to `/opt/vessel-caller/slots/staging/frontend-current`.
- Staging Nginx config: `/etc/nginx/sites-available/vessel-caller-staging`.
- Rollback configuration: `/var/lib/vessel-caller/ui-backups/npa-ui-20261012T185309Z/nginx.conf`.
- Backend current remains `/opt/vessel-caller/releases/v0.2.1/staging`.
- Web PID 22712, worker PID 22699 and Nginx master PID 18608 stayed unchanged and active. No failed units.
- Staging readiness and health returned 200; backend version remains v0.2.1.
- Production health remained 200, version v0.1.9; https://flexschools.ng remained 200.
- Production and FlexSchools Nginx configuration checksums remained unchanged.
- Replacing the new staging root with the old root in a read-only reconstruction exactly reproduced the predeployment config SHA256, proving the root directive was the only config change.

Every SSH connection used the pinned `flexschools-droplet-ssh/scripts/connect.sh` connector. Installation held `/run/lock/vessel-caller-release.lock`, validated archive paths and checksums, installed an immutable release, backed up the live config, then switched the static symlink and staging config atomically. A failure trap would restore the previous configuration and frontend link. The ordinary full release installer was deliberately not invoked because it performs backend preparation/migrations and restarts writers.

## Rollback and future releases

To roll back this first UI overlay, use the pinned connector, hold the release lock, restore the saved config with root ownership and mode 0644, run `nginx -t`, then reload Nginx. The restored SPA root points to the untouched v0.2.1 frontend. Leave the immutable UI release and dedicated symlink in place for evidence; they are inactive after restoring the old root. Recheck staging readiness and outside HTTPS assets after rollback. Do not restore if another deployment has subsequently changed the staging config without first reviewing that newer state.

Before the next **full application release**, either restore the conventional `current/frontend/dist` SPA root or deliberately update `frontend-current` to the new frontend. A backend release switch alone will not advance this separate UI overlay.

## Remaining backend work

This release does not make the new workflow a durable shared accounting system:

- Reconciliation approvals, invoice drafts, preview history and the agency directory remain browser-saved UI data.
- The existing staging backend still requires evidence for staff readings; the optional-evidence local UI has not changed that API constraint.
- Guest agency link, submission and receipt/PDF APIs are not implemented on the staging backend. The local portal demonstration uses mocks.
- Tariff lookup, verified paid declarations, issued variation invoices, accounting/payment integration and durable NPA audit records still need backend work.

Signed-in staging checks verified screen loading and navigation, not a persisted full voyage submission. The complete quantity-to-invoice journey was demonstrated locally only, as required by the current UI-only scope.
