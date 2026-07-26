# Vessel Caller production backlog

This is the canonical backlog until GitHub Issues/Projects are available. Each
story must link a pull request and retain test, staging, migration, and operator
evidence. `Done` means the stated exit evidence exists; merged code alone is not
enough.

Status values: `Not started`, `In progress`, `Blocked`, `Qualified`, `Done`.

## Release blockers

| Blocker | Owner | Required resolution | Status |
|---|---|---|---|
| Vercel staging binding is incomplete | Product/operator | DNS already points `staging` to Vercel and `staging-api` has a valid Droplet certificate; authenticate the providers, provision isolated services, then bind the qualified Vercel Preview | Blocked |
| Managed PostgreSQL credentials are absent | Product/operator | Provision isolated staging/production databases with TLS, PITR, and least-privilege users | Blocked |
| Spaces credentials/buckets are absent | Product/operator | Provision separate private staging/production buckets with versioning and lifecycle policy | Blocked |
| Resend credentials/domain are absent | Product/operator | Verify the sender domain and provide staging allow-list plus production API keys | Blocked |
| Sentry DSN and alert route are absent | Product/operator | Create staging/production projects and test an alert end to end | Blocked |
| GitHub Project/branch environments are not configured | Repository admin | Configure `main` protection and staging/production environment approvals from `docs/SDLC.md` | Blocked |
| Full qualification has not run | Release owner | Meet every gate in E14 against PostgreSQL staging | Not started |

## Backlog

| ID | Epic / deliverable | Dependencies | Status | Acceptance evidence |
|---|---|---|---|---|
| E00-S01 | Preserve source and freeze legacy API fixtures | None | In progress | Commit references and fixture checksums |
| E00-S02 | Create a WAL-safe production SQLite backup and restore it off-host | None | Done | 2026-07-26 backup evidence below |
| E00-S03 | Configure labels, milestones, Project, CODEOWNERS, templates, and branch protection | Repository admin | Blocked | Settings export/screenshots and protected-branch rejection test |
| E00-S04 | Approve architecture, security, migration, and release ADRs | E00-S01 | In progress | Recorded approvals in ADR PR |
| E01-S01 | Pin Python/Node and locked production/development dependencies | E00 | In progress | Runtime files, lock validation, clean bootstrap |
| E01-S02 | Upgrade vulnerable frontend routing packages | E01-S01 | In progress | `npm audit` report with no high/critical and disposition for moderate findings |
| E01-S03 | Make local PostgreSQL and Redis reproducible | E01-S01 | In progress | `docker compose up --wait`, Django migration, readiness output |
| E01-S04 | Remove legacy Vercel production/demo paths while retaining isolated staging preview | E14 | Not started | Search proof and production/staging routing evidence |
| E02-S01 | Django settings, custom user, DRF, request IDs, secure errors, and admin | E01 | In progress | System checks, OpenAPI, API tests |
| E02-S02 | Health/readiness and hardened Gunicorn runtime | E02-S01 | In progress | local/service probes and `check --deploy` |
| E03-S01 | Organization, operations, billing, settings, and audit models | E02 | In progress | migrations, constraints, model/service tests |
| E03-S02 | Decimal money, sequences, idempotency, and immutable audit | E03-S01 | In progress | concurrency, audit, and accounting tests |
| E03-S03 | Soft cancellation/removal and payment reversal | E03-S01 | In progress | state-transition and authorization tests |
| E04-S01 | SQLite schema fingerprint and deterministic importer | E03 | In progress | importer tests against frozen snapshots |
| E04-S02 | Reconciliation counts, IDs, FKs, totals, sequences, and object manifest | E04-S01 | In progress | signed reconciliation manifest |
| E04-S03 | Complete two staging migration rehearsals | E04-S02, E10, E12 | Blocked | two timestamped parity reports and durations |
| E05-S01 | Registration verification, invitations, recovery, and email changes | E02 | In progress | API, email sandbox, expiry/replay tests |
| E05-S02 | Session security, password hashing, MFA, and recovery codes | E05-S01 | In progress | security tests and session-revocation proof |
| E05-S03 | Fixed-role RBAC and last-active-Admin concurrency | E05-S01 | In progress | complete role matrix and race tests |
| E05-S04 | Users, invitations, sessions, security, and audit UI | E05-S01 | In progress | component, accessibility, and browser tests |
| E06-S01 | Vessel editing, status transitions, and cancellation | E03 | In progress | API/UI transition tests |
| E06-S02 | Inspection draft/resume/finalize and exactly-one invoice | E03, E04 | In progress | idempotency and concurrency tests |
| E06-S03 | Normalized payments, reversal, and server-generated PDFs | E03 | In progress | accounting, authorization, and snapshot tests |
| E06-S04 | Private evidence uploads | E03, Spaces | Blocked | MIME/size/tenant tests and signed-URL expiry proof |
| E06-S05 | Real IndexedDB PWA queue and conflict recovery | E06-S02 | In progress | offline browser journeys |
| E07-S01 | Remove every fake control, simulated success, demo credential, and unsupported claim | E05, E06 | In progress | repository search manifest and UAT checklist |
| E08-S01 | Cookie/CSRF client, effective permissions, and expiry handling | E05 | In progress | role/session component and browser tests |
| E08-S02 | Paginated resource queries, caching, and accessible responsive states | E05, E06 | In progress | component/accessibility/performance tests |
| E09-S01 | Backend/frontend/browser CI with enforced coverage | E01, E02 | In progress | required checks passing on `main` |
| E09-S02 | CodeQL, SAST, secret/dependency/container scans, SBOM, and scheduled scans | E09-S01 | In progress | security workflow artifacts and zero high/critical findings |
| E10-S01 | Idempotent Droplet bootstrap preserving FlexSchools | E00 | In progress | Ansible check-mode diff, `nginx -t`, before/after FlexSchools probes |
| E10-S02 | Vercel staging frontend plus Droplet staging API DNS/TLS, isolated DB/bucket/Redis and deployment user | DNS/credentials | Blocked | environment registry and external staging checks |
| E11-S01 | Build-once immutable release with checksums, wheelhouse, SBOM, and provenance | E09 | In progress | signed release and offline install rehearsal |
| E11-S02 | Protected staging/production promotion with blue-green rollback | E10, E11-S01 | In progress | promotion and rollback drill logs |
| E12-S01 | Managed PostgreSQL TLS, PITR, least privilege, and connection limits | Provider credentials | Blocked | provider configuration and privilege audit |
| E12-S02 | Encrypted daily export, Spaces versioning/lifecycle, and restore automation | E12-S01 | Blocked | fresh backup marker, off-host object, quarterly restore report |
| E13-S01 | Structured redacted logs, Sentry releases, synthetic checks, and alerts | Credentials, E10 | Blocked | injected-failure alert evidence |
| E13-S02 | Capacity test and operational dashboards | E13-S01 | Not started | 50-user p95/p99/error-rate report |
| E13-S03 | Incident, deploy, rollback, backup, and DR runbooks | E10–E13 | In progress | tabletop sign-off |
| E14-S01 | Full UAT/security/accessibility/browser qualification | All P0 implementation | Not started | signed qualification report |
| E14-S02 | Migration/restore/rollback rehearsals | E04, E11, E12 | Blocked | rehearsal evidence |
| E14-S03 | FastAPI blue stabilization and Django green cutover | E14-S01, E14-S02 | Blocked | approved change record and 30-minute observation report |
| E14-S04 | Seven-day hypercare and FastAPI retirement | E14-S03 | Blocked | seven-day SLO report and service removal evidence |
| E14-S05 | Retire Vercel production/demo use; retain protected staging only | E14-S04 | Blocked | production routing proof, staging isolation proof, and no production secrets/data in Vercel |
| E15-S01 | Architecture, API, RBAC, privacy, support, and operator handoff | Updated continuously | In progress | documentation review and named operator sign-off |

## E00 backup acceptance evidence

The first recoverable production baseline completed on 2026-07-26:

- SQLite online backup: `2026-07-26T08:32:24Z`
- Server-side backup: `/var/lib/vessel-caller/backups/vessel_caller-20260726T083224621243Z.sqlite3`
- Size: `90,112` bytes
- SHA-256: `2141086410096978059f265cff47533b21aef3694fc385ec484e70de26bcb3d8`
- SQLite integrity check: `ok`
- The encrypted off-host copy was decrypted into an isolated location, restored,
  and its checksum matched.
- Source counts: organizations, users, vessel calls, inspections, invoices, and
  settings each equal `1`.
- Financial control totals: dues `25043.76`, commission USD `876.53`, and
  commission NGN `1402448.0`.

This proves a recoverable legacy baseline; it does not satisfy the PostgreSQL
PITR/daily-backup gate in E12.

## E04 pre-staging migration rehearsal evidence

Two independent PostgreSQL imports of the verified WAL-safe production snapshot
completed on 2026-07-26. Each rehearsal began with an empty database and applied
the Django migrations before running the fingerprint-aware importer.

- Source SHA-256:
  `2141086410096978059f265cff47533b21aef3694fc385ec484e70de26bcb3d8`
- Accepted schema fingerprint:
  `031d952f0cc24632ad038e59684463d319cfe9d116e2441a4b347d8afdbafcd3`
- Reconciliation manifest SHA-256 for both runs:
  `121192a6d91973d03d24280a72c654fd165b4d8f653a27d0c0664f105b724ef5`
- The two manifests were byte-for-byte identical.
- Every source and target table count was `1`; all opaque-ID and row checksums
  matched across rehearsals.
- Financial controls matched exactly: dues `25043.76`, commission USD `876.53`,
  and commission NGN `1402448.00`.

These runs qualify the deterministic importer and reconciliation controls. They
do not close E04-S03 or E14-S02: the same two-run proof must still be repeated
against the isolated managed staging PostgreSQL service, followed by the backup
restore and release rollback drills.

## Local implementation qualification evidence

The final local code qualification completed on 2026-07-26 after closing the
independent security review findings:

- Django/PostgreSQL: `43` tests passed; line coverage `96.28%`; branch coverage
  `85.23%`; Ruff format/lint, mypy, Bandit, migration drift, Django system
  checks, and production-shaped `check --deploy` passed.
- React: `113` tests passed; line coverage `89.34%`; branch coverage `80.19%`;
  ESLint, TypeScript, production build, and `npm audit` passed with zero known
  vulnerabilities.
- Browser qualification: mocked and real Django/PostgreSQL journeys passed in
  Chromium, Firefox, WebKit, and mobile emulation (`8/8` in each suite).
- Deployment controls: Actionlint, ShellCheck, immutable release tamper tests,
  JSON validation, and production/HTTP-bootstrap/TLS-bootstrap Nginx
  configurations passed.
- Database exports and reconciliation manifests now use the same exported
  PostgreSQL snapshot. Restore qualification compares stable controls again
  after release migrations before evidence can be signed.
- Finalized evidence is copied from the temporary upload namespace to a new
  server-controlled evidence key, verified again, and only then referenced by
  the database.
- `staging-api.vesselcalls.com` presents its own valid Let's Encrypt certificate
  and deliberately returns `503` until the isolated staging application and
  managed services are ready. Production Vessel Caller and `flexschools.ng`
  both returned `200` after the Nginx change.

This qualifies the repository implementation locally. It does not qualify a
release: the provider-backed staging, backup/restore, load, DAST, alert,
Resend, private Spaces, rollback, and UAT gates remain mandatory.
