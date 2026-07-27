# Post-credential release checklist

This checklist is the canonical handoff for every release gate that cannot run
until approved external-provider credentials or protected-environment access
exist. Missing credentials do not block repository implementation, CI,
packaging, migration tooling, or dry-run validation. They do block provider
qualification and every production deployment except the narrowly authorized,
fail-closed production cutover documented in
`authorized-deferred-provider-cutover.md`.

Account-owner and business-approver actions are separated into
[`human-required-handoff.md`](human-required-handoff.md). Everything not listed
there remains automation-owned work.

## Non-negotiable release rule

- Never commit credentials, copy production credentials into staging, or place
  production data or credentials in Vercel.
- Never replace a provider gate with a mock adapter, placeholder credential,
  disabled security control, or manually asserted success.
- Never publish `production-qualified.json` or represent the release as fully
  qualified until every gate below has real evidence. The only deployment
  exception is the owner-authorized, fail-closed mode in
  `authorized-deferred-provider-cutover.md`; it defers only Resend and Sentry
  and does not waive any other cutover prerequisite.
- A failed or unavailable provider remains `deferred`; it is never recorded as
  passed.

## Credential-independent baseline

The following evidence is complete and remains valid for the merged source
commit until that source or its locked dependencies change:

- PR #1 merged to `main` with backend, frontend, infrastructure, CodeQL,
  dependency/static-analysis, Trivy, and real-browser checks passing.
- Django system checks, migration drift, backend tests, frontend lint/type/tests
  and production build pass locally.
- Immutable release verification, checksum/tamper rejection, Nginx variants,
  shell/YAML/JSON validation, and protected Vercel output packaging pass without
  provider access.
- The legacy SQLite importer completed two deterministic local PostgreSQL
  rehearsals with matching counts, IDs, relationships, financial controls, and
  manifests.
- Managed PostgreSQL is authenticated over TLS on the Droplet's private VPC
  route. The application role has no dangerous role attributes or inherited
  roles, has only the schema creation capability needed for Django migrations,
  and its URI remains only in the root-owned mode-`0600` credential file.
- The redundant public-IP database allow-list entry was removed after the
  authenticated private-route probe passed. Evidence is recorded in
  `docs/release-evidence/2026-07-27-digitalocean-database-readiness.md`.

These results qualify the implementation, not a production release.

## Required protected inputs

Store runtime values in encrypted Ansible Vault and root-owned Droplet files.
Store workflow-only values in the protected GitHub `staging` or `production`
environment. Record identifiers and owners in `docs/ENVIRONMENTS.md`, but never
record secret values in Git.

| Gate | Protected inputs | Required real-world evidence |
|---|---|---|
| Signed release and restricted deployment | Keychain service `vessel-caller-release-signing-key` / account `gbolahan-salami`, `RELEASE_SIGNING_PUBLIC_KEY`, `DROPLET_HOST`, `DROPLET_HOST_KEY`, `DROPLET_DEPLOY_SSH_KEY` | Signed tag/archive verifies; restricted `vessel-deploy` upload works; an unauthorized command is rejected |
| Vercel protected staging | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VERCEL_AUTOMATION_BYPASS_SECRET`, `STAGING_PROXY_SECRET`, `STAGING_API_ORIGIN` | Prebuilt artifact is deployed to the dedicated staging project; `staging.vesselcalls.com` is protected and proxies only the staging API; no production secret/data is present |
| Django and data services | Separate staging/production database URLs, Django secret keys, MFA encryption keys, Redis passwords, allowed hosts and CSRF origins | TLS database connection, least-privilege audit, connection limits, authenticated Redis, migrations, readiness, session/CSRF, MFA, and tenant isolation pass in staging |
| Private application Spaces | Separate staging/production `VC_SPACES_KEY`, `VC_SPACES_SECRET`, `VC_SPACES_BUCKET`, `VC_SPACES_ENDPOINT_URL`, and region | Private upload/download authorization, cross-tenant denial, signed-URL expiry, checksum, bucket versioning, lifecycle, and public-access denial pass |
| Resend | Separate staging/production `VC_RESEND_API_KEY` and `VC_EMAIL_FROM`; verified sender domain and staging recipient allow-list | Real verification, invitation, recovery, email-change, and security-notice messages arrive once; retries are idempotent and a forced failure is visible in outbox/alerts |
| Sentry | Separate staging/production `VC_SENTRY_DSN` values and provider alert access | Backend and frontend test events carry environment/release/request ID, redact sensitive fields, and trigger the on-call route |
| Backup and restore | `BACKUP_AGE_RECIPIENT`, `BACKUP_AGE_IDENTITY`, `BACKUP_AWS_ACCESS_KEY_ID`, `BACKUP_AWS_SECRET_ACCESS_KEY`, `BACKUP_SPACES_ENDPOINT`, `BACKUP_SPACES_BUCKET`, `RESTORE_DRILL_SOURCE_URI`, `RESTORE_DRILL_DATABASE_URL`, `PRODUCTION_DATABASE_URL_SHA256` | Encrypted off-host backup, checksum and manifest verification, isolated restore, post-migration reconciliation, retention/versioning proof, and recorded RPO/RTO pass |
| Qualification and operator signing | `LOAD_TEST_COOKIE`, `ALERT_TEST_WEBHOOK_URL`, `QUALIFICATION_SIGNING_PRIVATE_KEY`, `QUALIFICATION_SIGNING_PUBLIC_KEY`, `OPERATOR_EVIDENCE_SIGNING_PUBLIC_KEY` | Automated load, DAST, accessibility/browser, restore, rollback/recovery, transport/ingestion, and alert-rule probes pass; independently signed operator evidence supplies the application, on-call, PITR/RPO, UAT, authorization, regression, and staging-test-account controls; signed `production-qualified.json` is attached to the exact release |

The workflows require these exact GitHub names. They may reference the same
approved provider resources described above, but aliases must not be silently
substituted.

Protected environment or repository secrets:

- `ALERT_TEST_WEBHOOK_URL`, `BACKUP_AGE_IDENTITY`,
  `BACKUP_AWS_ACCESS_KEY_ID`, `BACKUP_AWS_SECRET_ACCESS_KEY`
- `DIGITALOCEAN_API_TOKEN`, `DROPLET_DEPLOY_SSH_KEY`, `DROPLET_HOST`,
  `DROPLET_HOST_KEY`, `LOAD_TEST_COOKIE`,
  `PRODUCTION_DATABASE_URL_SHA256`
- `QUALIFICATION_SIGNING_PRIVATE_KEY`
- `RESEND_QUALIFICATION_API_KEY`, `RESEND_QUALIFICATION_TO`
- `RESTORE_DRILL_DATABASE_URL`, `RESTORE_DRILL_SOURCE_URI`
- `SENTRY_AUTH_TOKEN`, `SENTRY_QUALIFICATION_DSN`
- `SPACES_QUALIFICATION_ACCESS_KEY_ID`,
  `SPACES_QUALIFICATION_SECRET_ACCESS_KEY`
- `STAGING_E2E_PASSWORD`, `STAGING_PROXY_SECRET`,
  `VERCEL_AUTOMATION_BYPASS_SECRET`,
  `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VERCEL_TOKEN`

Protected environment or repository variables:

- `BACKUP_SPACES_BUCKET`, `BACKUP_SPACES_ENDPOINT`, `SPACES_REGION`
- `OPERATOR_EVIDENCE_SIGNING_PUBLIC_KEY`,
  `QUALIFICATION_SIGNING_PUBLIC_KEY`, `RELEASE_SIGNING_PUBLIC_KEY`
- `RESEND_QUALIFICATION_FROM`
- `SENTRY_ORG_SLUG`, `SENTRY_PROJECT_SLUG`
- `SPACES_QUALIFICATION_BUCKET`, `SPACES_QUALIFICATION_ENDPOINT`,
  `SPACES_QUALIFICATION_REGION`
- `STAGING_DATABASE_CLUSTER_ID`

The encrypted Ansible inventory uses the corresponding
`vault_vessel_*` keys documented in
`ansible/group_vars/all/vault.example.yml`. Placeholder values in that example
are deliberately unusable.

The operator-evidence private key is never stored in GitHub Actions. Keep it
offline under the approved operator-signing process; GitHub contains only
`OPERATOR_EVIDENCE_SIGNING_PUBLIC_KEY`.

The release archive private key follows the same offline principle with a
separate trust boundary. CI creates a draft release after the signed tag,
archive build, test gates, SBOM, and attestation succeed. On the approved Mac,
set the non-secret public key for the current shell and finalize that exact
draft:

```bash
export RELEASE_SIGNING_PUBLIC_KEY='ssh-ed25519 AAAA... approved-release-key'
cd backend
../.venv/bin/python -m scripts.finalize_release vMAJOR.MINOR.PATCH
```

The finalizer requires an exact semantic tag and unpublished draft, validates
the checksum and GitHub attestation, retrieves the private key only from
macOS Keychain service `vessel-caller-release-signing-key` and account
`gbolahan-salami`, strictly base64-decodes the single-line Keychain value in
memory, verifies that the derived public key matches
`RELEASE_SIGNING_PUBLIC_KEY`, and publishes only after the detached OpenSSH
signature verifies. The private key is held in process memory, is never
printed, and is never written to disk.
Failure leaves the release unpublished. Do not use `security ... -w` manually,
command substitution, clipboard transfer, or a temporary key file.

## Release and operator evidence trust

Qualification requires two distinct semantic tags that resolve to two distinct
commits. GitHub must report both annotated tag signatures as verified before
any tag-controlled load or DAST job can run. That provider status enforces the
release-creation policy, but it is not the sole runtime trust decision. For
both releases, the workflow also verifies the archive checksum, GitHub artifact
attestation, signature against the pinned `RELEASE_SIGNING_PUBLIC_KEY`, and the
archive's exact tag/commit manifest. The signed archive is the authoritative
runtime artifact.

Before qualification, attach these fixed-name assets to the current release:

- `vessel-caller-<tag>.operator-evidence.json`
- `vessel-caller-<tag>.operator-evidence.json.sig`

The detached signature must verify against
`OPERATOR_EVIDENCE_SIGNING_PUBLIC_KEY`. The JSON must use
`schemaVersion: 1`, `evidenceType: vessel-caller-operator-evidence`, and the
exact current release tag and resolved commit. Its `controls` object has this
closed schema:

```json
{
  "applicationResendJourneys": true,
  "flexschoolsRegressionReviewed": true,
  "operatorChecklistSigned": true,
  "pitrPointInTimeRestore": true,
  "privateSpacesApplicationAuthorization": true,
  "productUatSigned": true,
  "resendForcedFailureVisibility": true,
  "resendRetryIdempotency": true,
  "rpoMinutes": 15,
  "sentryBackendFrontendMetadataRedaction": true,
  "sentryOnCallAcknowledged": true,
  "stagingE2eAccountsProtected": true
}
```

`rpoMinutes` may be any numeric value from zero through 15; every other field
must be exactly `true`. `stagingE2eAccountsProtected` attests that persistent
staging accounts are synthetic-only, use a high-entropy protected credential,
have access restrictions, and have an assigned rotation owner and cadence.
Production must contain no staging test accounts. The workflows consume the
protected `STAGING_E2E_PASSWORD` without printing it.

The automated Resend step proves transport delivery; the automated Sentry step
proves ingestion and alert-rule presence; the browser step proves automated
staging journeys. They do not independently claim application-delivery
semantics, on-call acknowledgement, PITR/RPO, product UAT, private-object
authorization, or reviewed FlexSchools regression. Those final qualification
gates become true only when the corresponding automated checks and the signed
operator evidence both pass.

## Runtime enablement flags

The checked-in inventory is intentionally inert:

```yaml
vessel_staging_runtime_enabled: false
vessel_production_runtime_enabled: false
vessel_provider_gates_deferred: true
vessel_production_deferred_provider_cutover: false
vessel_backups_enabled: false
```

After the staging inputs have been independently verified, set only
`vessel_staging_runtime_enabled: true` and
`vessel_provider_gates_deferred: false` in the protected inventory.
`vessel_production_runtime_enabled` and `vessel_backups_enabled` remain false
through staging qualification. Enable production and backups only during the
approved production change after signed qualification evidence exists. The
owner-authorized exception may enable production while provider gates remain
deferred only when `vessel_production_deferred_provider_cutover: true`; that
mode requires Resend and Sentry to be empty and disabled. Ansible always fails
if staging is enabled while provider gates remain deferred, and fails if
backups are enabled without the production runtime.

## Execution order after credentials arrive

1. Two people verify the target team/project/environment, secret names, public
   key fingerprints, Droplet host key, bucket identifiers, and database
   endpoints. Do not print secret values during verification.
2. Load staging values into encrypted Ansible Vault, root-owned Droplet files,
   and the protected GitHub `staging` environment. Change only the staging
   runtime flags described above, run the read-only Ansible preflight, and
   bootstrap staging only.
3. Build one signed release artifact from a signed `v*` tag and deploy that
   exact artifact to the Droplet staging service and dedicated Vercel staging
   project.
4. Run real Resend application journeys, private Spaces application
   authorization, Sentry metadata/redaction and on-call acknowledgement,
   session/MFA, upload/PDF, migration reconciliation, PITR/RPO, protected
   staging browser journeys, product UAT, the operator checklist, and the
   reviewed FlexSchools regression. Sign and attach the fixed-name operator
   evidence assets.
5. Run the qualification workflow with the current and previous signed tags.
   It must verify both immutable archives and the operator evidence before
   completing load, DAST, encrypted restore, rollback/recovery, transport,
   ingestion, browser, and alert gates and signing
   `production-qualified.json`.
6. Confirm the staging E2E accounts remain protected and within their approved
   rotation cadence. Confirm production contains none.
7. Provision and independently verify the production-only database, buckets,
   Resend/Sentry projects, runtime secrets, backup identity, and alert routes.
8. Approve the protected production GitHub environment only when the signed
   qualification evidence matches the release commit and all rows below are
   signed by their owners.
9. Follow `deployment-cutover.md`; retain FastAPI blue and compatible schema
   for seven days. Retire legacy/Vercel production paths only after hypercare.

## Release sign-off

| Gate | Owner | Evidence location | Status |
|---|---|---|---|
| Provider access and environment separation | Platform owner | Release attachment / access review | Deferred |
| Vercel protected staging | Frontend/release owner | Staging deployment evidence | Deferred |
| PostgreSQL application access and privilege audit | Data/platform owner | `docs/release-evidence/2026-07-27-digitalocean-database-readiness.md` | Passed |
| Redis staging qualification | Data/platform owner | Runtime authentication and isolation report | Deferred |
| Private Spaces and encrypted restore | Data/platform owner | Object and restore manifests | Deferred |
| Resend and Sentry | Product operations / on-call | Delivery and alert evidence | Deferred |
| Load, DAST, browser/accessibility, rollback, alert | Release owner | Signed qualification evidence | Deferred |
| Product UAT and FlexSchools regression | Product owner / infrastructure owner | Signed UAT and health report | Deferred |
| Production change approval | Change owner | Protected environment approval | Deferred |

Replace `Deferred` only from objective evidence produced against the exact
signed release. If the source commit or locked dependencies change, rerun all
affected credential-independent and provider-backed gates.
