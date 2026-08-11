# System Admin UAT and security release checklist

All required rows must pass against the exact signed artifact in staging.
Mocks, Django `force_authenticate` alone, console email, local storage
substitutes, hidden frontend controls, or tests against another commit are not
release evidence.

## Fixtures and evidence

- [ ] Record tag, commit, artifact checksum/signature, migrations, frontend
      build, environment, tester, timestamps, and request/correlation IDs.
- [ ] Use one platform organization, two platform custodians, two customer
      organizations, and tenant users in every role/state; use no copied
      production personal or business data.
- [ ] Use staging PostgreSQL, Redis/Celery, qualified Resend delivery, and
      private staging Spaces with production-equivalent controls.
- [ ] Capture a pre-test backup and prove restore without overwriting the only
      database.

## Identity and authentication

- [ ] Provisioning refuses a customer email, ambiguous/missing typed platform
      container, missing reason/change reference, wrong environment, and
      disabled delivery; it accepts no organization override.
- [ ] It emits no password, setup link/token, outbox context, MFA secret, or
      provider credential to stdout, logs, audit, or CI artifacts.
- [ ] Setup expires in exactly 24 hours, is single-use, and rotation invalidates
      the earlier link.
- [ ] No platform data is shown before email verification and TOTP enrollment;
      there is no MFA grace period.
- [ ] Recovery codes are shown once and stored hashed; replay fails.
- [ ] Login throttling covers account and IP without disclosing identity,
      tenant, platform grant, or suspension existence.
- [ ] High-impact actions fail when recent-MFA assurance is missing/expired and
      succeed only after supported step-up.
- [ ] Grant, revoke, password-reset, MFA-reset, and privilege changes revoke all
      prior sessions.
- [ ] Django superuser/staff without an active platform grant has no platform
      product access.

## Authorization and tenant isolation

- [ ] Anonymous calls to every `/api/system/*` endpoint return `401`.
- [ ] Admin, Operations, Finance, and Viewer receive uniform `403` before
      target lookup for every platform method.
- [ ] System Admin is denied tenant APIs and `/app`, including when a valid
      object ID or organization override is supplied.
- [ ] Unknown organization IDs return generic `404` only after platform
      authorization. Unauthorized callers cannot distinguish target existence.
- [ ] The platform organization never appears in customer lists, search,
      counts, exports, or lifecycle actions.
- [ ] Platform responses contain only the approved minimized projection; no
      operational records, secrets, object keys, outbox/provider data, or
      internal audit notes are serialized.
- [ ] Pagination, sorts, and filters are allow-listed; injection, oversized
      input, IDOR, mass assignment, and organization overrides fail.
- [ ] CSRF, origin, Secure/HttpOnly/SameSite cookies, CORS, and CSP match
      production.

## Console routes and organization UAT

- [ ] `/system` Overview shows accurate account totals and recent customer
      organizations without operational/financial aggregates.
- [ ] `/system/organizations` search, filters, pagination, empty states, and
      status labels distinguish registration from access suspension.
- [ ] `/system/organizations/:id` Overview, Access, and Audit tabs show only
      safe profile, user/invitation identity/status, and sanitized audit data.
- [ ] `/system/audit` enforces permission, safe filters, pagination, and export
      controls; `/system/account` supports mandatory MFA/recovery safely.
- [ ] Create organization atomically creates settings/defaults and sends one
      24-hour single-use first-Admin invitation; no password is chosen/shown.
- [ ] Profile editing is allow-listed, rejects lifecycle/financial/workflow
      mass assignment, requires revision control, and audits before/after.
- [ ] Tenant-user/invitation lists never expose password, token, session, MFA,
      private object, or another organization's data. Only Admin invitations
      can be issued from the platform console.
- [ ] Loading, forbidden, not-found, stale revision, throttling, server error,
      retry, success, and no-op states are explicit and accessible.
- [ ] Keyboard and screen-reader checks identify routes, tabs, validation, and
      action results; suspension requires confirmation and reason.

## Suspension

- [ ] Only an active System Admin with recent MFA can suspend an active customer
      organization; reason, expected revision, and idempotency are mandatory.
- [ ] Replaying an idempotency key yields one outcome, platform audit event, and
      notification.
- [ ] Concurrent suspend and suspend-versus-login/invitation acceptance
      preserve one state and cannot mint a usable session/token.
- [ ] All tenant sessions are revoked across devices; subsequent requests fail
      closed.
- [ ] Login, MFA completion, invitation accept/resend, action-token flows, and
      new private-object URLs are denied. Queued organization-scoped business
      email is suppressed when suspension wins the organization lock; only an
      explicitly marked lifecycle notice may deliver while suspended. Verify
      both lock-order outcomes.
- [ ] Tenant data remains intact; last-active-Admin membership is unchanged; no
      hard delete or cascade occurs.
- [ ] Tenant Admin notice is sent once with a safe reason and no platform
      identity/internal note. Outbox failure is visible/retryable and does not
      roll back suspension.
- [ ] Every new application outbox row is organization-scoped. Delivery of an
      unscoped row fails closed before any provider call. The rollout preflight
      proves there are no unscoped pending/sending rows, records a non-secret
      checksum of historical exhausted failures without replaying them, and
      records any separately approved deliberate reissue.
- [ ] A previously issued signed URL stops no later than its documented maximum
      TTL; no new URL issues after suspension.

## Reactivation

- [ ] Reactivation requires recent MFA, reason, expected revision, idempotency,
      and a suspended customer organization.
- [ ] It restores no session, invitation, token, challenge, recovery code, or
      object URL.
- [ ] Users authenticate afresh; only otherwise-active, verified identities
      regain original tenant RBAC.
- [ ] One tenant-visible safe event and one platform event correlate without
      leaking operator/internal data.

## Tenant-Admin onboarding and recovery

- [ ] System Admin targets only Admin invitations/users in the selected
      organization; cross-organization nested IDs and non-Admin mutations fail.
- [ ] Setup/recovery uses rotating, hashed, single-use links delivered directly
      to the recipient; System Admin cannot see/set password or link.
- [ ] Global email uniqueness does not disclose another tenant to tenant
      callers; authorized platform errors reveal only the minimum needed.
- [ ] Acceptance cannot violate last-active-Admin rules or create a platform
      grant.
- [ ] Suspended organizations cannot receive or accept usable recovery links.

## Audit, privacy, and abuse cases

- [ ] Platform audit rejects instance save/delete, queryset update/delete, API
      mutation, and Django Admin mutation.
- [ ] Every success/no-op/rejected business mutation has its documented audit
      and telemetry result; attacker traffic cannot create unbounded rows.
- [ ] Tenant audit shows “Vessel Caller System” and a sanitized reason; never
      platform actor, IP, internal notes, or another organization.
- [ ] CSV exports neutralize formula prefixes and enforce permission, size
      limits, purpose, and audit.
- [ ] Password/token/MFA/session/object/provider secrets are absent from API,
      page source, browser storage, logs, Sentry, audit, email, exports, and
      test artifacts.
- [ ] Impersonation, switching, organization override, hard delete,
      business-record access, password selection, and MFA bypass have no route,
      control, or undocumented behavior.

## Concurrency, performance, and rollback

- [ ] PostgreSQL proves consistent locks for concurrent login, suspension,
      reactivation, invitation acceptance, organization creation, and recovery.
- [ ] Large-tenant suspension meets the agreed threshold while status fails
      closed before cleanup completes.
- [ ] Tenant journeys, 50-user load, browser matrix, accessibility, FlexSchools,
      readiness, and alerts pass.
- [ ] The same qualified lifecycle-boundary signed tag is installed through
      two production deployments; ports 8001 and 8002 report the expected
      tag/SHA and access-status capability before mutations can be enabled.
- [ ] That exact tag has `SESSION_SAVE_EVERY_REQUEST=false`, persists sessions
      explicitly inside the active organization/actor lock, wraps every tenant
      mutation and signed-capability issuance in organization-then-actor locks,
      and passes deterministic PostgreSQL suspension and full response-cycle
      session no-resurrection barriers.
- [ ] Kill switch is tested and does not disable status enforcement.
- [ ] Rollback uses only the exact qualified lifecycle-boundary release and
      preserves suspended organizations, revocations, and audit; access-status
      awareness by itself is not qualification.
- [ ] Reverse migration, bulk reactivation, any unqualified binary, raw SQL,
      and audit deletion are absent from the rollback procedure.

## Release decision

- [ ] Security owner signs tenant-isolation and abuse-case evidence.
- [ ] Product owner signs capability/exclusion matrix and UAT journeys.
- [ ] Operations signs access, monitoring, backup, qualified
      lifecycle-boundary rollback, and named-custodian evidence.
- [ ] Privacy signs minimized projection, audit visibility, notifications,
      export, and retention.
- [ ] Production approver confirms Phase 1 before Phase 2. Any failed or
      deferred required row blocks mutation enablement.
