# System Admin RBAC and scope matrix

This policy supplements [tenant RBAC](RBAC.md). System Admin is a platform
identity, not an organization role. Backend authorization is authoritative;
frontend route guards are navigation affordances only.

## Identity boundaries

| Identity | Scope | Tenant workspace | Platform console |
|---|---|---:|---:|
| Tenant Admin | One customer organization | Yes | No |
| Operations | One customer organization | Yes | No |
| Finance | One customer organization | Yes | No |
| Viewer | One customer organization | Yes | No |
| System Admin | Organization-account administration | No | Yes |
| Django staff/superuser | Restricted `/staff/` operator surface | No product right implied | No product right implied |

An identity cannot act as both a tenant user and System Admin in the same
session. Platform access is granted by an explicit active
`PlatformAccessGrant`, not by `role=Admin`, `is_staff`, `is_superuser`, an email
address/domain, or a Django group.

## Capability matrix

| Capability | System Admin | Tenant Admin | Notes |
|---|---:|---:|---|
| List/search/filter all customer organizations | Yes | No | Paginated, allow-listed filters/sorts |
| View minimized organization account summary | Yes | No | No business records or object keys |
| Create organization and first Admin invitation | Yes | No | Atomic defaults plus 24-hour setup link |
| View minimized tenant user/invitation status | Yes | Yes, own organization | No role mutation or authentication material |
| View sanitized organization identity/lifecycle audit | Yes | Yes, own organization | No operational event payloads or internal reason |
| View own organization profile/workflows | No | Yes | System Admin has no tenant workspace |
| Suspend organization access | Yes | No | Recent MFA, reason, idempotency, audit |
| Reactivate organization access | Yes | No | Does not restore sessions/tokens |
| Create/resend/revoke tenant-Admin setup invitation | Yes | No | 24-hour, rotating, single-use; no password |
| Dispatch password reset to active tenant Admin | Yes | Yes, own organization | Sender cannot see link or password |
| Correct allow-listed organization profile fields | Yes | Yes, own organization | Revision check; no rate/workflow/financial edits |
| Manage tenant users | No | Yes, own organization | Platform recovery is Admin-only |
| View/export platform audit | Yes | No | Separate from tenant audit |
| View/export tenant audit | No | Yes, own organization | Sanitized system events may appear |
| View calls, inspections, evidence, invoices, payments | No | Per tenant role | No impersonation or switching |
| Change rates, invoice workflow, operational settings | No | Per tenant RBAC | Outside platform scope |
| Read/set passwords, MFA secrets, codes, or tokens | No | No | Never exposed to an administrator |
| Hard delete organization/user/business data | No | No | Retention workflow is separate |
| Grant/revoke System Admin in web UI | No in v1 | No | Audited operator command only |

## Minimized data projection

Organization list/detail APIs may return only what is necessary to manage the
customer account:

- opaque ID, name, registration state, access status, and dates;
- contact details needed for recovery/support;
- active-user and active-Admin counts;
- minimized user/invitation identity and status needed for Admin onboarding or
  recovery; and
- sanitized identity/lifecycle audit and last-activity summaries.

They must not return calls, inspections, evidence, invoices, payments,
financial settings, private object keys/URLs, password/MFA/token material,
outbox ciphertext/provider IDs, API credentials, or internal audit reasons.

## Authorization invariants

1. Unauthenticated platform requests return `401`.
2. Every tenant identity, including tenant Admin, receives a uniform `403`
   before target lookup. A Django superuser without a platform grant is also
   denied.
3. An authorized System Admin receives a generic `404` for an unknown target.
4. A System Admin is denied from tenant APIs even when an object ID is known or
   the platform identity's tenant role field is `Admin`.
5. Platform mutations require CSRF, active mandatory MFA, recent MFA assurance,
   an allow-listed action, an idempotency key, and an audited reason. Lifecycle
   and recovery actions require the operator to enter that reason; routine
   create/profile/invitation actions use a fixed, reviewable action reason.
6. The target is derived from the route and locked by the service. Clients
   cannot override organization scope through bodies, headers, query values,
   object keys, or nested IDs.
7. Access status is enforced independently in authentication, middleware,
   permissions, token/invitation flows, workers, and storage URL issuance.
8. Searches/filters are allow-listed and rate-limited. Direct identifiers are
   redacted from logs and telemetry.

## Lifecycle semantics

`registered` continues to mean onboarding completed. `access_status` is
separate:

- `active`: tenant authentication and authorized tenant work are permitted.
- `suspended`: tenant access is denied; sessions and usable security/onboarding
  tokens are revoked; no new private-object URL may be issued.

No deleted state or destructive cascade is part of this release. Archive or
erasure requires a separate retention, legal, restore, and approval design.

## Platform routes

- `/system`: minimized platform overview.
- `/system/organizations`: customer organization list and create flow.
- `/system/organizations/:id`: Overview, Access, and Audit tabs.
- `/system/audit`: immutable platform audit search/export.
- `/system/account`: platform profile, mandatory MFA, recovery codes, sessions,
  and sign-out controls.

These routes use the platform shell. They must never mount tenant `AppLoader`,
tenant stores, offline queues, or tenant navigation.
