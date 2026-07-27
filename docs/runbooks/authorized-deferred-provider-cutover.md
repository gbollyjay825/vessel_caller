# Authorized deferred-provider production cutover

This runbook records the product owner's explicit authorization to treat the
current FastAPI/SQLite deployment as a rollback-only legacy staging baseline
and cut over the current Django release without waiting for Resend or Sentry.
It does not waive any other production control.

## Exact exception

Only Resend delivery and Sentry ingestion may be deferred:

```yaml
vessel_provider_gates_deferred: true
vessel_production_runtime_enabled: true
vessel_production_deferred_provider_cutover: true
```

In that mode Ansible and Django require both provider values to be empty,
select the disabled email backend, and skip Sentry initialization. Attempts to
send email fail visibly and the encrypted transactional outbox remains the
source of truth. No console, memory, mock, or fake-success adapter is allowed
in production.

PostgreSQL with TLS, isolated authenticated Redis, private Spaces, strong
Django and MFA secrets, TLS/DNS, a restricted deployment user, a pinned release
verification key, a signed immutable artifact, migrations, readiness, browser
smoke tests, Nginx validation, FlexSchools regression, and a tested rollback
path remain mandatory. A missing paid Spaces resource or release-signing
custodian blocks the cutover.

## Cutover sequence

1. Preserve the current FastAPI service on port 8001 and record its health,
   service definition, Nginx configuration, and rollback command.
2. Verify authenticated PostgreSQL access and an empty-or-approved target
   state. Apply Django migrations to the managed database.
3. Install the signed artifact into the inactive Django green slot on port
   8002. Do not change the public Nginx upstream.
4. Run `manage.py check --deploy`, readiness, API/UI/browser smoke tests,
   private-object authorization, and FlexSchools regression.
5. Run `nginx -t`, switch only the Vessel Caller upstream to port 8002, reload,
   and repeat external checks. Reopen writes only after they pass.
6. Observe for at least 30 minutes. Preserve port 8001 and its compatible data
   path for rollback during the seven-day hypercare period.

Do not mark Resend or Sentry qualified. After credentials arrive, complete
`post-credential-release-checklist.md`, turn off the deferred flag, deploy the
same or a newer qualified release, and prove both live integrations.

## Administrator handoff

After the public Django deployment is verified ready and Resend is qualified,
run `issue_release_admin_invitation` on the deployed release for the approved
organization and inviter. The command creates an Admin invitation valid for
exactly 24 hours from issuance, rotates any pending invitation for the same
address, encrypts the setup link in the outbox, and never prints it. Acceptance
is single-use and requires the recipient to choose their password before the
account becomes active.

Never run the command while delivery is disabled, copy the link from the
database, place it in a task log, or substitute a temporary password. Report
only that delivery succeeded, not the link or any credential.
