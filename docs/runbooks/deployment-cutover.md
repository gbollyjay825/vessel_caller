# Deployment and Django cutover

## Preconditions

For the explicitly authorized internal-admin-only cutover, the narrowly scoped
exception in `authorized-deferred-provider-cutover.md` replaces the deferred
provider and external-onboarding rows below. It requires public registration
and every email-dependent onboarding action to be fail-closed; it does not
qualify Resend, Sentry, external invitations, public UAT, or a future external
launch.

- Every deferred provider row in
  `post-credential-release-checklist.md` has objective evidence for the exact
  signed release; `Deferred` is not an acceptable production status.
- Approved signed release; all GitHub gates green.
- `staging.vesselcalls.com` is bound to the protected Vercel Preview deployment
  and `staging-api.vesselcalls.com` has a valid Droplet TLS certificate.
- Staging has passed UAT, security/accessibility/browser tests, 50-user load,
  migration reconciliation, restore, rollback, and alert drills.
- Managed PostgreSQL PITR and a fresh encrypted export are verified.
- Current FastAPI and FlexSchools health are captured.
- Candidate migrations are expand/contract compatible with the retained slot.
- Change owner, rollback owner, and incident channel are active.

## Normal release

1. Download the signed GitHub release and verify provenance/checksum.
2. Promote to staging with the protected `deploy.yml` workflow. It installs the
   Django/Celery release at Droplet port 8010, deploys the exact archive's SPA
   through pinned Vercel CLI `--prebuilt`, then runs protected public E2E.
3. Attach staging evidence and approve the production GitHub environment.
4. The workflow uploads through the restricted `vessel-deploy` account.
5. The Droplet verifies the archive, installs wheels offline, runs
   `check --deploy`, migrations, static collection, and candidate readiness.
6. `promote-release.sh` probes FlexSchools, atomically updates only Vessel
   Caller’s upstream and static symlink, runs `nginx -t`, and reloads Nginx.
7. It executes public smoke tests and a second FlexSchools check. A failure
   automatically restores the prior upstream/symlink.
8. Observe readiness, error rate, latency, auth failures, worker/outbox lag,
   PostgreSQL, Redis, disk, and FlexSchools for at least 30 minutes.

## Framework/data cutover

1. Create and verify a fresh SQLite online backup; never copy only the main
   file while WAL is active.
2. Import into managed PostgreSQL and sign the full reconciliation manifest.
3. Point FastAPI blue at PostgreSQL and observe before introducing Django.
4. Install Django green at `127.0.0.1:8002` and test it directly with the
   production host header.
5. Enable `/var/lib/vessel-caller/maintenance`, drain in-flight writes, perform
   final synchronization, and rerun parity checks.
6. Promote green, run external authentication/user/vessel/inspection/invoice/
   payment/evidence/PDF journeys, verify FlexSchools, then remove maintenance.
7. Observe for 30 minutes. Keep compatible blue and backups for seven days.

During that seven-day window, port 8001 remains FastAPI rollback capacity.
The guarded deploy script refuses to overwrite it; routine production releases
wait until the approved legacy retirement. Emergency remediation follows the
rollback/incident process rather than destroying the rollback service.

Record release/tag, commit, artifact checksum, migration plan/duration, active
slot, operator, test evidence, before/after metrics, and rollback deadline.
