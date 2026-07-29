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
`install-release.sh`, and `promote-release.sh`. The deployment user can invoke
only the guarded `vessel-caller-deploy` entrypoint through sudo.

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
