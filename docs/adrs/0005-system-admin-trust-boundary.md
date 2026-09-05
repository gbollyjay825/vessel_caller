# ADR 0005: Separate System Admin trust boundary

- Status: Accepted
- Date: 2026-08-10

## Context

Vessel Caller users belong to exactly one organization and receive one of the
fixed tenant roles: Admin, Operations, Finance, or Viewer. Tenant services
derive their data scope from the authenticated user's organization. Django
staff and superuser accounts are deployment/operator identities; they are not
an application-level multi-organization authorization model.

The service needs a System Admin who can administer organization accounts
without weakening tenant isolation or gaining silent access to vessel calls,
inspections, evidence, invoices, payments, or organization credentials.

## Decision

System administration is a separate application trust boundary.

- System Admin is not a fifth tenant role. A platform identity has an explicit
  `PlatformAccessGrant` and belongs to the single `kind=platform` organization,
  not a customer organization.
- Application System Admin identities are not granted Django `is_staff` or
  `is_superuser`. Existing Django staff or superusers receive no System Admin
  API access merely because of those flags.
- Platform APIs live under `/api/system/`; the platform UI lives under
  `/system/`. Platform identities are denied from tenant application routes,
  and tenant identities are denied from platform routes before object lookup.
- Platform authorization requires an active, verified identity, an active
  platform grant, mandatory TOTP MFA with no grace period, and recent MFA
  assurance for high-impact mutations.
- Organization onboarding and access are separate concepts. The existing
  registration state continues to describe onboarding; `access_status`
  controls whether tenant authentication and requests are allowed.
- Self-registration creates a `pending_approval` customer organization. Email
  verification is the only pre-approval capability; tenant authentication and
  all workspace access stay fail-closed until a System Admin approves a fully
  registered organization with a verified tenant Admin.
- Lifecycle actions are approval, suspension, and reactivation. Approval is
  the only transition from `pending_approval` to `active`. Suspension changes
  state first, then revokes tenant sessions and usable onboarding/security
  tokens. Neither approval nor reactivation restores a previous session or
  token.
- Cross-organization support is exposed only as explicit, narrowly scoped
  actions. No tenant-switch header, implicit tenant context, impersonation, or
  generic cross-tenant object access is permitted.
- Platform activity is recorded in a separate immutable platform audit
  ledger. A correlated, sanitized event may be visible to the affected tenant,
  but it must not reveal the platform operator's identity or internal reason.
- Platform access is provisioned and revoked through audited management
  commands. Provisioning sends a 24-hour, single-use password-setup link and
  never creates or prints a default password.
- The complete lifecycle authorization boundary is deployed before lifecycle
  mutation controls are enabled. Qualification requires the exact signed
  tag/SHA to disable implicit per-response session saves, persist sessions only
  inside the active organization/actor lock, lock every customer mutation and
  signed-capability issuance organization-first, and pass deterministic
  PostgreSQL suspension/session barrier tests. Once any organization is
  non-active, access-status awareness alone never qualifies a rollback.

## Allowed product scope

System Admin may list and search customer organizations, inspect a minimized
account/health summary, create an organization with its first Admin setup
invitation, edit allow-listed core profile fields, inspect minimized
user/invitation and lifecycle-audit projections, approve verified
self-registration, suspend or reactivate access, and perform safe tenant-Admin
recovery through one-time invitations or password-reset dispatch. Every
mutation requires a reason where material, optimistic concurrency, idempotency
protection, and immutable audit evidence; high-impact mutations also require
recent MFA.

## Excluded product scope

System Admin may not impersonate a tenant, open tenant workflows, view or set a
password, bypass MFA, read recovery codes or action tokens, access private
evidence or signed-object keys, mutate financial/operational records, hard
delete organizations or users, or acquire platform rights from a tenant role,
email domain, Django group, staff flag, or superuser flag.

## Consequences

- The platform console needs separate permissions, serializers, navigation,
  audit, tests, and operational ownership.
- Tenant middleware, authentication, permissions, background services, token
  flows, and private-object issuance must all enforce organization access
  state; frontend hiding alone is never sufficient.
- Existing organizations retain active access without changing registration
  state. Approval metadata is nullable so existing active organizations are
  not relabelled or falsely attributed. The platform organization must be
  marked or created explicitly; a data migration must not infer it from a
  display name.
- Organization suspension and concurrent login must use a consistent locking
  and status-check strategy. Status is committed before bulk revocation so
  new requests fail closed even if cleanup continues.
- Previously issued short-lived object URLs cannot be recalled. Their maximum
  lifetime is part of the suspension risk envelope and release evidence.
- Only the exact qualified lifecycle-boundary release is a valid rollback
  target after lifecycle mutations are enabled. A release that merely reads
  `access_status` but can race session persistence or a customer mutation is
  not qualified.
