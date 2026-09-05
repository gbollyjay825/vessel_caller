# Vessel Caller Droplet deployment

Vessel Caller’s target deployment uses immutable, offline-installable releases
and isolated Django blue/green services. Production and staging are hosted on
the shared FlexSchools Droplet. Staging serves the immutable SPA and Django API
together at `staging.vesselcalls.com`; it never uses Vercel. Missing provider
credentials keep external-provider gates deferred and fail-closed.

## Layout

- Environment-owned release copies: `/opt/vessel-caller/releases/<signed-tag>/{production-blue,production-green,staging}`
- Slots: `/opt/vessel-caller/slots/{production-blue,production-green,staging}`
- Active static release: `/opt/vessel-caller/current`
- Protected environments: `/etc/vessel-caller/*.env`
- State/backups: `/var/lib/vessel-caller`
- Production API: loopback ports 8001/8002
- Staging API: loopback port 8010
- Authenticated production Redis: loopback port 6380
- Independently authenticated staging Redis: loopback port 6381

CI runs `scripts/build-release.sh`; the Droplet uses `verify-release.sh`,
`install-release.sh`, `release-target-policy.sh`, `staging-writer-guard.sh`,
`staging-compatibility-guard.sh`, `staging-lifecycle-state.sh`, and
`promote-release.sh`. The deployment user can invoke only the guarded
`vessel-caller-deploy` entrypoint through sudo. A signed manifest with
`stagingOnlySchemaCutover: true` is rejected for production in both CI and the
root-owned host entrypoint.

The same signed manifest carries `organizationApprovalLifecycle: true`. After
staging web and worker are proven inactive, the host atomically persists a
root-owned compatibility marker under `/var/lib/vessel-caller` before running
the migration. If that local marker is absent after a host replacement, the
root-installed guard consults the authoritative Django migration ledger and
reconstructs it only from a compatible signed release. The supported deployment
path permanently rejects older releases that could reopen legacy writers
against the expanded approval schema, including after a failed cutover.

The entrypoint and installer are host controls, not self-updating application
files. The staging systemd units are part of the same host safety boundary. A
release that changes their safety contract requires a separate, privileged
bootstrap from that exact signed release before its normal deploy.
Verify the archive with the environment's pinned release key, hold the same
release lock, install only the reviewed scripts atomically as `root:root 0755`,
retain root-only backups, install the exact authenticated staging units, run
`systemctl daemon-reload`, and record all hashes. Never copy controls from an
unsigned checkout or let a candidate replace the script currently executing
it.

Ansible changes only files named for Vessel Caller and records the set of
enabled Nginx sites before/after bootstrap. It validates Nginx before reload
and probes `flexschools.ng` after infrastructure changes. It does not deploy an
application release, provision managed provider resources, or edit FlexSchools.
Run `ansible/playbooks/preflight.yml` first; it is read-only and records the
operating system, listeners, existing sites/services, Nginx validation, and
both public health checks.

Read [the SDLC](../docs/SDLC.md), [deployment/cutover
runbook](../docs/runbooks/deployment-cutover.md), and [rollback
runbook](../docs/runbooks/rollback.md) before operating production. The
[post-credential checklist](../docs/runbooks/post-credential-release-checklist.md)
must have no deferred rows before any production operation.

The previously checked-in FastAPI installer/systemd definition and Vercel
serverless demo function were removed. Existing FastAPI blue on the Droplet is
retained operationally during cutover, but this repository can no longer
install or seed that legacy runtime.
