# System Admin lifecycle-boundary rollout and rollback

Organization suspension creates a durable authorization decision. A binary
that does not understand it is unsafe because rollback would accept suspended
organizations. Access-status awareness alone is not rollback qualification.
This release therefore uses two phases.

A **qualified lifecycle-boundary release** is the exact signed tag and SHA
whose code and PostgreSQL evidence prove all of the following together:

- `SESSION_SAVE_EVERY_REQUEST=false` prevents SessionMiddleware from writing a
  session again after the authorization transaction;
- every intentional session write is explicit and occurs while the active
  organization and actor locks are held;
- customer mutations and new signed-object capabilities acquire the active
  customer organization lock before the actor lock; and
- deterministic PostgreSQL barrier tests prove suspension cannot race those
  paths or the full session response cycle to mint or resurrect access.

## Required release properties

- Expand-only migrations add platform grant/audit structures and extend
  `Organization.access_status` with `pending_approval`; existing rows retain
  `active` and nullable approval metadata.
- Registration state remains separate. The unique platform organization is
  selected by its explicit `kind=platform`; migrations do not infer it from a
  display name and no customer ID can be supplied as an override.
- New self-registrations remain locked in `pending_approval` after email
  verification. Only explicit, audited System Admin approval may activate
  them; reactivation cannot be used as an approval shortcut.
- Authentication, managed-session middleware, tenant permissions,
  invitation/action-token flows, async entry points, and private-object URL
  issuance deny every non-active organization. The only pending-approval
  exception is typed email verification; suspension has no exception.
- Enforcement is independent of the System Admin UI and mutation gate.
- Suspension and login acquire the organization lock in a consistent order.
- A kill switch disables lifecycle mutations without disabling enforcement.
- Both blue and green rollback candidates run the exact qualified
  lifecycle-boundary tag/SHA before the first production lifecycle mutation
  is permitted.

## Phase 0: preflight

1. Identify release, migrations, artifact checksum/signature, backup,
   blue/green slots, change owner, rollback owner, and observation window.
2. Confirm existing customer organizations remain `active`, no existing row is
   rewritten to `pending_approval`, and the platform organization is not
   selected by name.
3. Rehearse migration/restore on production-shaped staging; reconcile
   organization, user, session, invitation, and token counts.
4. Drain and prove both Celery queues/unacknowledged sets empty. Run the
   read-only System Admin rollout preflight and retain its root-owned evidence.
   It must prove that no pending or sending outbox row lacks an organization;
   the status-aware worker refuses to deliver an unscoped row instead of
   guessing a tenant. The check covers the default Celery queue and every
   configured Redis priority shard, plus the unacknowledged hash and index.
   Record the count and checksum of historical exhausted failures without
   replaying or altering them. Reissue only a separately approved,
   attributable message.
5. Pass System Admin UAT/security, tenant regression, PostgreSQL concurrency,
   browser/accessibility, load, secret, SBOM, and deploy-check gates that apply
   to staging. While the signed staging-only marker is true, the production
   qualification workflow must reject the release rather than publish
   contradictory `production-qualified` evidence.
6. Record signed-object URL maximum lifetime as suspension risk.
7. Keep lifecycle mutations disabled.

## Phase 1: staging enforcement and UAT

0. Before the first staging release that introduces writer quiescence, update
   the host-installed restricted deployment controls separately. The normal
   deployment invokes `/usr/local/sbin/vessel-caller-deploy`; it cannot replace
   its own running control script from the candidate archive. On the trusted
   release controller, verify the exact published archive, checksum, detached
   signature, and GitHub attestation. Transfer all three verified inputs
   through the trusted root/Ansible channel directly into a fresh disk-backed
   `root:root` mode `0700` directory under `/var/lib/vessel-caller`; do not use
   the deploy account's mutable `/var/tmp` files for this bootstrap. Reverify
   the closed root-owned snapshot on the host with the pinned staging key.
   Acquire the release lock; then atomically install only that verified
   archive's `deploy-release.sh`, `install-release.sh`, `verify-release.sh`,
   `release-target-policy.sh`, `snapshot-release.py`,
   `staging-writer-guard.sh`, `staging-compatibility-guard.sh`,
   `staging-lifecycle-state.sh`, and `libpq-env.sh` as `root:root` mode
   `0755`. From the same authenticated archive, install the staging web,
   worker, and prepare systemd units as `root:root` mode `0644`, run
   `systemctl daemon-reload`, and verify each installed unit contains the
   compatibility `ExecStartPre`. Do not restart staging during this bootstrap;
   the normal release operation performs the ordered quiescence. Retain
   root-only backups, record all twelve hashes, and re-read every installed
   file before dispatch. Remove only the exact bootstrap snapshot after
   verification. Do not install unverified working-tree files or let the
   incoming archive replace a running control script itself.
1. Deploy the signed artifact to staging with mutations disabled.
   The restricted deployment entrypoint acquires the release lock and
   atomically rewrites the environment's root-owned mutation flag to
   `disabled` before it installs, restarts, or promotes any slot. A missing,
   linked, or incorrectly owned flag blocks deployment rather than preserving
   an earlier `enabled` state. Before switching the release symlink or running
   migrations, it stops the public web writer first and then gracefully stops
   the worker. A stop failure before installation resumes the prior services.
   Once installation begins, any prepare, migration, health, or resume failure
   keeps both writers stopped; the old binary must not reopen against the
   expanded schema. The operator verifies the selected link, migration state,
   and readiness before recovering or reopening UAT.
   This prevents an old process from creating an active, unapproved
   registration against the expanded schema.
2. Verify active tenant login and core journeys are unchanged.
3. After the staging service reports the status-enforcement capability,
   temporarily enable only the staging mutation flag through protected
   Ansible configuration. Suspend only a synthetic UAT organization, verify
   login, sessions, tokens, and new object URLs fail closed, restore the
   fixture, then disable the staging mutation flag again.
4. Disable the staging mutation flag again, refresh the operator session, and
   retain the exact release/UAT evidence. Observe authorization, sessions,
   database, errors, and latency for the normal window.

This release carries the authenticated manifest field
`stagingOnlySchemaCutover: true` and the compatibility capability
`organizationApprovalLifecycle: true`. CI and the root-owned host entrypoint both
reject it when the target is production. Phase 1 authorizes no production
application deployment, platform provisioning, or lifecycle mutation.
After proving both staging writers inactive and before running the prepare
unit, the host persists the root-owned approval-lifecycle compatibility floor.
The systemd start guard also checks the authoritative Django migration ledger
when that local marker is absent, such as after host replacement, and rebuilds
the marker only through a compatible signed release. From that point—including
after a failed cutover—legacy releases are rejected and only a compatible
signed retry may start staging web or worker processes.

## Phase 2: future production qualification and enablement

1. Implement and rehearse a protected production maintenance/drain handoff so
   no old web or worker can create or consume approval-era records after the
   expand migration. Remove the signed staging-only marker only in that
   separately reviewed release.
2. Obtain protected approval referencing Phase 1 evidence, then deploy that
   exact signed artifact to both production slots with mutations disabled.
   Directly prove ports 8001 and 8002 report the qualified tag/SHA and
   `capabilities.organizationAccessStatus=true`; verify the active worker is on
   the same release and run tenant/FlexSchools regression before reopening.
3. Provision/verify approved identities through
   [the access runbook](system-admin-access.md).
4. Confirm recent MFA, audit alerts, notifications, idempotency, and kill switch.
5. Set the target environment's
   `vessel_*_system_admin_qualified_release_tag` and
   `vessel_*_system_admin_qualified_release_sha` to the separately reviewed,
   production-qualified Phase 2 artifact proven on both production slots,
   then set only its
   `vessel_*_system_admin_mutations_enabled=true` through protected Ansible.
   Ansible requires readiness, database/cache health, exact tag/SHA, and the
   access-status capability on every relevant slot. It first writes the target
   flag to `disabled`, then invokes the root-owned enablement wrapper. The
   wrapper holds `/run/lock/vessel-caller-release.lock`, the same lock used by
   signed deployment, across a final exact-slot probe, the preflight, a second
   probe, and the atomic flag transition. It runs the exact qualified
   release's `system_admin_rollout_preflight --evidence-file -` through a
   transient, restricted systemd service as the target runtime user. systemd
   loads the root-owned runtime and `RELEASE.env` files without placing secrets
   in the process arguments. The wrapper validates canonical JSON,
   `passed=true`, the exact environment/tag/SHA, and a zero command status
   before it writes the `enabled` flag. Slot directories and `current` links
   must be root-owned and resolve to the expected
   `/opt/vessel-caller/releases/<tag>/<slot>` directories; runtime processes
   have traversal/read access but cannot replace a rollback target. It also
   requires every web slot to
   report effective Resend readiness and verifies, without printing values,
   that the active Celery worker process loaded the Resend backend, a non-empty
   key, and a non-empty sender. A stale process therefore fails closed; rerun
   the signed two-slot deployment rather than toggling the flag or manually
   sourcing secrets. It stores the evidence and checksum as root-owned
   mode-0600 files under
   `/var/lib/vessel-caller/system-admin-rollout-evidence/`, keyed by
   environment, tag, and SHA. A failed enable attempt leaves mutations
   disabled. Setting the toggle false never invokes the wrapper, Django,
   PostgreSQL, or Redis, so the emergency kill switch remains available during
   dependency failure. The dynamic flag itself needs no restart; any preceding
   provider change does. Confirm the other environment's flag remains disabled.
   Every later signed deployment fail-closes the target flag under the same
   release lock before changing a slot. The new exact tag/SHA must complete
   this qualification and protected enablement flow again; deployment never
   carries an earlier release's mutation authorization forward.
6. Run read-only production smoke; never suspend a real customer to test.
7. Record the first non-active customer state. From then on, any release that
   is not the exact qualified lifecycle-boundary tag/SHA is an invalid rollback
   target, even if it reads access status.

## Suspension transaction order

1. Authorize platform identity and recent MFA.
2. Validate CSRF, reason, idempotency, revision, and customer target.
3. Lock target; reject platform/unknown/already-suspended targets safely.
4. Within one database transaction, write suspended status and immutable audit
   correlation, then revoke member sessions and usable invitation/action/MFA
   challenges. No intermediate commit is permitted.
5. Commit the state and revocations together; login, token acceptance, and new
   object URL issuance remain denied throughout the lock boundary.
6. Queue the idempotent tenant-Admin notice through the transactional outbox;
   delivery occurs after commit and is recoverable if broker publication fails.
7. Return only sanitized result and request/correlation ID.

Reactivation changes access state only. It restores no session, invitation,
token, recovery code, or previously issued object URL.

Approval similarly changes a verified, registered customer from
`pending_approval` to `active` without restoring or minting authentication
material. The tenant Admin must sign in after approval.

## Rollback matrix

| State | Permitted rollback |
|---|---|
| Before Phase 2 production deployment | Normal schema-compatible prior release |
| Phase 2 deployed, mutations disabled, all active | Exact qualified lifecycle-boundary release; no access-status-only fallback |
| Phase 2 enabled, no lifecycle mutation yet | Exact qualified lifecycle-boundary release unless incident commander proves all active and approves an exception |
| Any organization pending or suspended now/historically | Qualified lifecycle-boundary release only; UI may be disabled but enforcement remains |
| Migration/data integrity uncertain | Maintenance plus restore/reconciliation in new DB; no reverse migration/raw SQL |

Turning off UI/mutations is containment, not rollback of state. Reactivating an
organization to make an old binary safe is prohibited.

## Rollback after Phase 2

1. Disable mutations and enable maintenance if integrity is uncertain.
2. Preserve audit, request IDs, logs, release evidence, and encrypted export.
3. Promote only a slot running the exact qualified lifecycle-boundary tag/SHA.
4. Run drift, readiness, active/suspended authorization, session revocation,
   object authorization, and tenant smoke checks.
5. Validate Nginx and FlexSchools before reopening traffic.
6. Reconcile every pending or suspended organization and document why it
   remains so.

Never reverse the access-status migration, bulk-reactivate organizations,
delete audit, route to an access-status-only or otherwise unqualified
FastAPI/Django release, or use raw SQL as a rollback shortcut.
