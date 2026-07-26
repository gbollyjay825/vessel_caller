# Rollback

## Triggers

Rollback immediately for data-integrity/reconciliation failure, cross-tenant
access, authentication lockout, sustained 5xx/error-budget breach, p99 above
the release threshold, failed core journey, or FlexSchools regression.

## Before production writes reopen

Run `promote-release.sh` for the previous production slot. It validates the
candidate, switches the Vessel Caller upstream/static symlink, validates Nginx,
reloads it, and probes both public applications.

## After Django writes begin

Do not point FastAPI at a schema or business state it cannot understand.

1. Enable the Vessel Caller maintenance marker.
2. Preserve logs, request IDs, audit events, release metadata, and a current
   encrypted PostgreSQL export.
3. If schema remains backward compatible, promote the previous Django slot.
4. Otherwise, declare an incident and recover PostgreSQL to an approved point
   in a new database. Never overwrite the only production database.
5. Run full reconciliation, update protected environment credentials, restore
   the compatible app release, test privately, then reopen traffic.

Never use destructive Git commands, reverse migrations, or ad-hoc SQL as a
rollback. Keep the failed release/data intact for investigation.
