# Organization sign-up — staging release, 12 October 2026

## Deployed outcome

Deployed **`v0.2.2-staging.20261012T2113`**, commit **`65aa3618e60ffac60221c9cf1611ff6c2a309044`**, to [staging](https://staging.vesselcalls.com). User Management now supports a reusable organization sign-up link with expiry and revocation. Recipients submit their details, verify their email and choose their own password; an organization Admin must approve the request and assign a role before workspace access is granted.

The earlier `T2046` deployment passed infrastructure checks but its anonymous public form could remain loading when authentication hydration cleared the query cache. The corrected release keeps the public lookup in component state while preserving private-cache cleanup. The deployed package is the signed CI artifact for the exact commit above; local build output and later documentation changes are not substitutes for that artifact.

This is a staging-only candidate, with no official release tag published. Its signed manifest rejects production deployment. The security scan reported no findings; its 12 target-parser limitations are documented in [the scanning runbook](../runbooks/security-scanning.md). Production/capacity qualification is not claimed.

## Validation and observed journey

- [CI run 38309091190](https://github.com/gbollyjay825/vessel_caller/actions/runs/38309091190): all eight jobs passed, including security checks and signed packaging. Validation comprised **279 PostgreSQL backend tests**, **561 frontend tests**, **16 real-backend browser tests** and **72 mocked browser tests**.
- The release operator verified the archive signature against the pinned public key and GitHub provenance against the exact run/commit. Archive SHA256: `bca6a8da1debc0b76a3281c7a642a796fcbdb9ccc7c219c5bdba7dd7c7d7ab83`.
- The original signed-in Admin created and copied a seven-day sign-up link. After the correction, the original anonymous in-app browser displayed the **Join Digicomme** form successfully.
- The original staff Admin also reloaded `T2113`: the workspace loaded, the sign-up link remained active with its original expiry, and no verified requests awaited approval. The unverified test request was not displayed in the review list, including its All filter.
- An explicitly authorized test request was submitted. The backend audit observed **one UNVERIFIED request**, **zero new User accounts**, and **one Resend outbox record marked SENT**, at **21:19:22 UTC**. SENT records provider acceptance; inbox receipt was not observed.
- Recipient email receipt, password selection, email verification, Admin approval, and subsequent login/workspace access remain **unobserved**. The test is not evidence of a completed signup journey.

No share/verification tokens, recipient identities, credentials or provider payloads are retained in this record.

## Independent deployment checks

Outside HTTPS health/readiness and [frontend metadata](https://staging.vesselcalls.com/ui-release.json) matched `T2113` / `65aa3618`. Users, dashboard, registered public join/verification and voyage invoice routes served the current application shell; interactive public-form verification is recorded separately above.

Downloaded assets exactly matched the installed files:

| Asset | Bytes | SHA256 |
| --- | ---: | --- |
| `index-NuyeLnsl.js` | 790,679 | `583a5687d48d66454469ed87b0e28ecac89bf8e024519276994deccbe06c7c49` |
| `index-CECduhPy.css` | 171,801 | `b9d1836cd13079b968fa6a8a337588373b8fdd8c12859e487f74a5e011626078` |

Both staging symlinks select `/opt/vessel-caller/releases/v0.2.2-staging.20261012T2113/staging`, with `frontend-current` selecting its `frontend/dist`. Accounts migration `0006_organizationsignuplink_organizationjoinrequest_and_more` is applied. Web/worker were active with PIDs `145334` / `145320` when checked.

All **17 existing users** were preserved: hashes covering every User field matched before cutover, after cutover and at independent verification. The prepare unit contains no `seed_e2e` command and retained SHA256 `bfa86a47dc60fddffe14faad7d980c43025b1464dd47f77c4f1d4d170e62eab4`.

Nginx PID `18608` and staging, production and FlexSchools configuration hashes remained unchanged; no Nginx reload was required. Production health/readiness remained healthy at `v0.1.9` / `c9cb5c7ca7d0015f967b3e7146c8c737f55ce69a`. [FlexSchools](https://flexschools.ng/) responded successfully. Every SSH session used the pinned `flexschools-droplet-ssh/scripts/connect.sh` connector.

## Backup and bounded recovery

Deployment held the release lock, verified immutable signed inputs and target policy, froze platform mutations and paused staging writers before backup/cutover. The PostgreSQL **18.6** client was digest-pinned to `postgres@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c`; host/production database tools were not replaced.

Encrypted backup and prior targets are under `/var/lib/vessel-caller/ui-backups/v0.2.2-staging.20261012T2113`. Independent checks confirmed the ciphertext checksum, nonempty dump catalog and absence of plaintext partial dumps or temporary libpq credentials. A failure after cutover leaves staging writers stopped for inspection.

Recovery must first inspect current state using the pinned connector and release lock. The recorded prior backend/frontend targets are `T2046`, which remains compatible with the additive schema but restores the known anonymous-form loading defect. Prefer a verified forward correction. Any reviewed rollback must coordinate both staging symlinks and writers, retain the no-seed unit and lifecycle floor, and verify outside health/assets. Do not reverse migration `0006`, refresh fixture accounts, or restore the database as a routine rollback; database restoration needs a separate decision accounting for subsequent writes. No production or financial recovery was performed.

## Voyage scope remains unchanged

Organization signup now has backend support; this does not complete the voyage accounting backend. Reconciliation approvals, variation invoice drafts, preview history and the agency directory remain browser-saved UI data. Guest agency-reading link/submission/PDF APIs remain unimplemented on staging, and staff reading evidence remains required by its backend. Tariff lookup, verified paid declarations, issued variation invoices, payment/accounting integration and durable NPA reconciliation audit records still require backend work. The complete quantity-to-invoice journey was demonstrated locally, not as a persisted staging accounting transaction.
