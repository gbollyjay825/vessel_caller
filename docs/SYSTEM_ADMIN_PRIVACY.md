# System Admin privacy, audit, and exclusions

## Purpose and minimization

The platform console administers organization accounts and recovers
tenant-Admin access. It is not a support backdoor into tenant operations.
Every returned field/action must be necessary for lifecycle, identity
recovery, security investigation, or accountable support.

It may expose organization contact and minimized user/invitation identity and
status. It must not expose vessel/cargo operations, evidence, invoices or
payments, private storage references, authentication material, provider
credentials, or email-outbox payloads.

Search values containing email, phone, registration number, or organization
IDs must not enter shareable URLs, analytics, Sentry breadcrumbs, application
logs, or CI/browser artifacts.

## Audit separation

Platform actions use an immutable platform ledger with event/correlation IDs,
actor and active grant, action and target opaque ID, mandatory bounded reason,
sanitized before/after, timestamp, source IP/user agent, and outcome.

The ledger rejects update/delete through model, queryset, API, and Django
Admin. Exports prevent spreadsheet formula injection and require a separate
permission. Retention is seven years unless legal policy requires longer.

An affected tenant may receive a correlated event/notification showing
“Vessel Caller System”, safe action/reason category, timestamp, and correlation
ID. It never exposes operator identity, internal notes, IP, or another tenant.

Authorization denials, throttling, and enumeration attempts belong in redacted
security telemetry; attacker requests must not create unbounded audit rows.

## Sensitive-data exclusions

These never appear in platform API/UI, exports, logs, error reporting,
fixtures, screenshots, or audit state:

- passwords or password hashes;
- session cookies/keys and CSRF secrets;
- raw invitation, verification, reset, or action tokens;
- MFA secrets, TOTP codes, recovery codes/hashes, or challenge details;
- outbox encrypted context, provider IDs, or credentials;
- private object keys, signed URLs, or uploaded evidence content; and
- database, Redis, Spaces, Resend, Sentry, signing, SSH, or deploy secrets.

System Admin cannot request, reveal, replace, export, or relay these values.
Recovery uses server-generated, rotating, single-use links delivered directly
to the verified recipient.

## Prohibited capabilities

- impersonation, login-as, tenant switching, shared/delegated sessions, or
  support-generated tenant cookies;
- tenant endpoints with organization override;
- viewing/editing calls, inspections, evidence, invoices, payments, rates,
  workflow, reports, or private files;
- direct password/MFA/token manipulation or MFA bypass;
- platform privilege from web UI, tenant action, email domain, Django group,
  `is_staff`, or `is_superuser`;
- hard deletion, cascade removal, audit alteration, or reactivation solely for
  unsafe rollback; and
- unrestricted export/analytics over customer contact data.

Any future exception requires a new ADR, purpose/retention policy, abuse-case
analysis, customer-visible audit, tests, and protected approval.

## Suspension privacy effects

Suspension blocks new sessions/object URLs and revokes current sessions/tokens.
A URL issued earlier may work until short expiry; runbooks must state/test that
maximum window. Suspension does not delete data or change retention duties.

Tenant notices contain no internal investigation notes. A legal/security hold
may suppress detail externally, but platform audit records approved reason and
authority.

## Review and monitoring

- Review platform access quarterly and after personnel/role changes.
- Alert on login failures, grants/revocations, lifecycle mutations, repeated
  lookups, exports, MFA recovery, and kill-switch changes.
- Review UI, audit, telemetry, and exports for minimization/redaction each
  release.
- Treat cross-tenant exposure, impersonation, mutable audit, or status bypass
  as SEV-1.
