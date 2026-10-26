# Django/PostgreSQL build-out — 22 October 2026

## Current implementation

The application already has Django/DRF services for organizations, identity, vessel calls,
measurement plans, immutable submissions, reconciliations, assessments, invoices and audit.
This increment closes the collection gaps between those services and the current voyage UI.
PostgreSQL is now the default application database. Explicit SQLite support remains only for
legacy tooling; no user data is silently imported from the browser or the legacy database.

Implemented in this increment:

- Organization-owned agency directory: Admin creation, editing and archiving; authorized
  staff reading; optimistic versions and case-insensitive name/role uniqueness. Selection
  copies a voyage-specific snapshot rather than rewriting historical readings.
- Agency-specific expiring/revocable links. Raw invitation secrets are returned once and
  stored only as SHA-256 digests. Exchange creates a separate signed, HttpOnly browser capability;
  it does not sign in as a staff user or modify the staff login session.
- Independent guest submissions, bound to a specific agency and cargo structure, protected
  by CSRF, request throttling, organization lifecycle checks and PostgreSQL transactions.
  Concurrent/repeated submissions create one record. A changed retry is rejected.
- Evidence is optional for a reading. Paper acknowledgement evidence remains required if
  a plan explicitly requires those acknowledgements. The final reviewer remains independent
  of the preparer; this increment does not weaken existing role or approval rules.
- After submission, the guest can download its own receipt and see completed peer quantities.
  Before submission the endpoint returns no peer readings or owner baseline. Peer output
  excludes notes, evidence, staff identities and private document references.
- Immutable submission snapshots, server PDF receipts, voyage Readings JSON/PDF with cargo
  rows and owner/agency columns, and a tenant-scoped activity summary/events endpoint.
- The current agency setup and selection UI now use Django, and Readings has a server PDF
  download. Browser-only agency storage is preserved, not silently migrated or overwritten.

Endpoints are under `/api`: `agencies`, `measurement-plans/{id}/agency-links`, the participant
link creation and revocation endpoints, `agency-portal/{csrf,exchange,context,submission,receipt}`,
`measurement-plans/{id}/submissions/{id}/receipt`, `voyages/{id}/readings`,
`voyages/{id}/readings/document` and `measurement-activity`.

## Open issue disposition

GitHub still lists E00–E15 as broad open epics. Local implementation and a passing test are not
sufficient evidence to close release qualification, provider, backup or operational epics.

| Area | State after this increment | Remaining acceptance |
| --- | --- | --- |
| Django/PostgreSQL foundation | Implemented; fresh PostgreSQL migrations tested | Deploy and verify the candidate in staging |
| Reusable agencies and secure guest collection | Implemented and connected to the current UI | Operator acceptance in staging |
| Optional evidence and generated receipts | Implemented | Operator acceptance and private-storage qualification |
| Reconciliation and disparity billing services | Existing durable services retained and regression-tested | Connect the newer voyage-level closeout screens, which still use browser previews |
| Activity dashboard | New server summary and sanitized event API | Replace browser-only closeout-derived dashboard status with the durable closeout adapter |
| Source security alerts | Eight affected paths remediated: six exception detail disclosures, legacy HTML injection and dynamic settings-path assignment | Hosted CodeQL scan and merge; alerts are not manually dismissed |
| Dependency security | Vite 7.3.7, Vitest 4.1.12, Pillow 13.0.0 and certifi 2026.10.19 pinned; production Python and frontend registry audits clean | Check the final lockfile scan in CI |
| Email delivery | Existing delivery work preserved | Provider delivery/bounce evidence; the user previously deferred this investigation |
| Release / production readiness | Not certified by this work | Existing provider, restore, rollback, load, observability and UAT gates remain open |

The next product increment is a durable adapter for the newer reconciliation, variation
invoice and activity screens. It must reuse immutable approved sources, preserve independent
NPA review, bill only additional load, and flag overpayments for review. It must not treat
browser-saved previews as issued accounting documents or independently verified payments.

## Data and release controls

Migrations 0003–0004 add the agency/link/session tables and submission provenance, plus database
constraints for one current link per agency and valid staff/guest actor attribution. Historical
staff readings remain staff readings. Roll back application code only with a compatible schema;
once guest submissions exist their null staff actor must not be coerced into a fabricated user.

All development verification uses isolated local PostgreSQL databases with synthetic data.
This increment does not change staging/production databases, user credentials, MFA settings,
email delivery configuration or existing browser previews. A backend candidate must be packaged
and its migration/compatibility controls reviewed before deployment.

## Local verification

- 416 Django tests passed against an isolated PostgreSQL database, with no skipped tests.
  Independent coverage thresholds passed: 95.95% lines and 87.29% branches.
- Ruff, mypy, Django system checks and migration-drift checks passed.
- 612 frontend tests passed; coverage thresholds, ESLint, TypeScript and the production
  build passed. Vite continues to report the existing large application-bundle warning.
- Six real Django browser journeys passed across Chromium, WebKit and mobile: each target
  ran secure guest collection through reload/PDF download and the existing staff workflow
  through independent reconciliation and one persisted disparity invoice. Hosted Firefox
  and the full CI matrix are separate acceptance evidence.
- Locked frontend and production Python dependency audits reported no known vulnerabilities.
- The receipt PDF was rendered and visually inspected using synthetic data.

The browser test found and fixed PDF content negotiation that returned 406 for an explicit
`Accept: application/pdf`. It also now uses unique server agency names per test run instead
of relying on separate browser-local directories. Local evidence is retained outside Git
under `/tmp/vessel-*-20261022*`; the sample receipt is in `output/pdf/`.


A hosted CodeQL follow-up additionally replaced organization-join exception echoes
with fixed public messages and added integrity protection for guest cookies. Its
password-hashing warning traced to test code rehashing the randomly generated
`passwordChangeToken`, not to a user's password. Those tests now inspect the active
challenge by user and purpose and still prove token acceptance/rejection through HTTP;
application password hashing and existing token digests are unchanged.
