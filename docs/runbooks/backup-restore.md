# Backup and restore

## Legacy SQLite

Use `deploy/scripts/legacy-sqlite-backup.sh`. It invokes SQLite’s online backup
API, so committed WAL content is captured consistently. It runs an integrity
check and writes SHA-256 evidence; setting `BACKUP_AGE_RECIPIENT` encrypts the
result. Never back up a live deployment by copying only the `.sqlite3` file.

## PostgreSQL

When provider credentials are supplied and E12 is qualified,
`vessel-caller-backup.timer` will run a custom-format `pg_dump`, validate its
catalog, encrypt it with an offline-held age recipient, upload it plus a
checksum to private Spaces, and update a local success marker. Until then,
PostgreSQL backup/PITR qualification is deferred. The WAL-safe SQLite backup is
not a substitute. The target bucket must have versioning and a provider
lifecycle retaining daily backups for at least 30 days.

Target objectives:

- RPO: no more than 15 minutes using managed PITR.
- RTO: no more than 4 hours.

## Quarterly restore drill

1. Open an approved drill/change and create an empty isolated database.
2. Select a backup and record its version ID, timestamp, and checksum.
3. Put the age identity in a temporary root-only file outside the repository.
4. Set `RESTORE_TARGET_ENVIRONMENT`, the independently calculated
   `TARGET_DATABASE_URL_SHA256`, and the registered
   `PRODUCTION_DATABASE_URL_SHA256`. Export `RESTORE_TARGET_DATABASE_URL` from
   the approved secret store, then run
   `postgres-restore.sh <s3-uri> drill --confirm-restore`. The database URL is
   never passed in a process argument.
   Production additionally requires matching `RESTORE_CHANGE_ID` and
   `ALLOW_PRODUCTION_RESTORE_CHANGE_ID` values from the approved incident
   change.
5. Apply the matching release, run Django checks and migration reconciliation.
6. Verify counts, opaque IDs, FKs, invoice snapshots, sequence state, object
   checksums, and financial totals.
7. Run critical browser journeys and measure elapsed recovery time/data age.
8. Destroy the drill database and identity material per provider policy.
9. Attach sanitized evidence to E12; never record keys or customer data.

Production restore requires matching `RESTORE_CHANGE_ID` and
`ALLOW_PRODUCTION_RESTORE_CHANGE_ID`; prefer restoring into a new database and
switching credentials after proof.
