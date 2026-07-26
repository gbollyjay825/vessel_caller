# Credential-independent release evidence — 2026-07-26

## Scope

- Merged implementation: `main` at PR #1 merge commit
  `f5e2b4f4b9ab5121351add8644d80ae52ad7bfbe`.
- Follow-up purpose: finish every safe release check that does not require an
  external-provider credential and make all remaining provider gates explicitly
  deferred.
- No provider success, production qualification, staging deployment, production
  deployment, DNS change, or shared-Droplet mutation is claimed by this record.

## GitHub evidence

PR #1 merged on 2026-07-26. Its final head
`8dc790f08eb392163ec675932ef4d45c838e3153` passed:

- Backend CI
- Frontend CI
- Infrastructure CI
- CodeQL for Python and JavaScript/TypeScript
- dependency and static analysis
- Trivy
- real Django/PostgreSQL browser journeys in Chromium, Firefox, WebKit, and
  mobile

## Local verification

The merged tree and follow-up release controls passed:

| Command/control | Result |
|---|---|
| `make backend-check` | Django system check passed; no migration drift |
| backend pytest/coverage | 51 passed; one row-lock concurrency test skipped locally because it requires PostgreSQL; 96.13% lines and 85.40% branches |
| frontend dependency/lint/type/tests | npm audit reported zero vulnerabilities; ESLint and TypeScript passed; 124 tests passed; 89.62% lines and 80.38% branches |
| frontend production build | Vite production bundle built successfully |
| mocked browser journeys | Chromium, Firefox, WebKit, and mobile passed 8/8 authentication journeys |
| `make infra-test` | Bash/YAML/JSON/ShellCheck and immutable release harness passed |
| release integrity | checksum/signature verification passed; tampered archive was rejected |
| Vercel packaging | immutable protected-staging Build Output package was produced locally without provider access |
| release identity smoke | exact Django tag/SHA passed; mismatched tag and legacy payload were rejected as qualification evidence |
| availability smoke | legacy-shaped health remained available only in explicitly non-qualifying mode |
| Ansible syntax | pinned Ansible 2.18.18 passed `preflight.yml`, `bootstrap.yml`, and `verify.yml` |
| runtime isolation | all four staging/production enablement combinations rendered correctly; deferred providers fail closed |
| credential and evidence guards | predictable E2E credentials were removed; operator/release evidence uses closed schemas and pinned signatures; same-tag/same-commit rollback is rejected |
| runtime monitoring contract | public no-store Django runtime config and fail-disabled frontend Sentry initialization passed backend/frontend contract and redaction tests |

Additional fail-closed dry runs verified:

- legacy SQLite online backup, checksum, integrity check, and isolated
  restore/readback;
- PostgreSQL restore confirmation, target-environment, target-hash,
  production-target, and production-change-ID guards;
- root-only install/promote/deploy guards and restricted SSH command patterns;
- PostgreSQL URL parsing and mode-`0600` libpq credential-file handling;
- Nginx production and staging bootstrap variants.
- independent staging/production service, Redis, environment-file, deployment
  sudo-rule, and readiness gating;
- production-backup dependency on an explicitly enabled production runtime.

## Deferred provider evidence

The following were deliberately not executed without approved credentials:

- protected Vercel project deployment/domain binding;
- real Resend delivery through application outbox flows;
- private Spaces authorization, versioning, and lifecycle;
- Sentry ingestion, redaction, and alert acknowledgement;
- managed PostgreSQL staging migration/restore rehearsals and PITR audit;
- encrypted off-host PostgreSQL backup/restore;
- 50-user protected-staging load, DAST, full UAT, and rollback drill;
- signed production qualification and any production deployment.

The exact protected inputs, owners, objective evidence, and execution order are
in `docs/runbooks/post-credential-release-checklist.md`. A deferred row cannot
be converted to passed by a mock, placeholder, local adapter, manual assertion,
or skipped workflow step.
