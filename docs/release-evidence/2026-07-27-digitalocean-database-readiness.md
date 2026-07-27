# DigitalOcean database readiness — 2026-07-27

## Scope

This record covers only the existing managed PostgreSQL cluster used by Vessel
Caller and its root-owned runtime credential on the Flex School Droplet. It does
not claim a Django deployment, production traffic cutover, Spaces
qualification, Resend delivery, Sentry ingestion, or release-signing approval.

The existing FastAPI service remained active on loopback port 8001 throughout.
No listener was installed on port 8002, no Nginx upstream changed, and
FlexSchools remained healthy.

## Provider mutations

- Rotated the unused `vessel_caller_app` database password.
- Stored the private-network application URI only in
  `/etc/vessel-caller/credentials/staging-database.env`, owned by
  `root:root` with mode `0600`.
- Revoked `CREATE` on the target database's `public` schema from the PostgreSQL
  `PUBLIC` role.
- Granted only `USAGE` and `CREATE` on that schema to
  `vessel_caller_app`, which is the minimum required for Django migrations.
- Removed the redundant public Droplet IP trusted source after the private
  route passed authenticated validation. The remaining trusted source is the
  Droplet's `/32` private VPC address.
- Deleted the transient `doadmin` credential and all local/remote validation
  environments after the grant.

No database, cluster size, paid provider service, unrelated project resource,
FlexSchools configuration, public Nginx route, or application data was changed.

## Validation evidence

The final application-role probe used the locked Psycopg 3.2.10 Linux wheels
whose SHA-256 hashes are pinned in `backend/requirements/production.txt`.

| Control | Result |
|---|---|
| User/database | `vessel_caller_app` / `vessel_caller_staging` |
| PostgreSQL | 18.4 |
| Transport | TLS enabled over the private database hostname |
| Role escalation attributes | superuser, create-role, create-database, replication, and bypass-RLS all false |
| Inherited roles | none |
| Database privileges | connect and temporary true; database-level create false |
| Schema privileges | `public` usage and create true for the application role |
| Migration capability | transactional table create/insert/read succeeded |
| Cleanup | rollback removed the validation table |
| Network allow-list | private Droplet `/32` only |
| Runtime file | `root:root`, mode `0600` |
| Nginx | `nginx -t` passed |
| Existing endpoints | Vessel Caller 200/TLS; FlexSchools 200/TLS |
| Rollback baseline | FastAPI active on 8001; port 8002 unused |

## Remaining production cutover gates

The database gate is complete. The Django production cutover remains blocked
by controls that this authorization did not waive:

- a private DigitalOcean Space and scoped production object-storage
  credentials, which require the account owner to approve the first paid Space;
- independent release-signing custody and its pinned public verification key;
- a signed immutable release promoted through the guarded installer;
- private-object authorization and direct green-slot readiness/browser
  validation before any Nginx switch.

Resend and Sentry may remain disabled only under the documented deferred-provider
exception. Their live qualification is not claimed.
