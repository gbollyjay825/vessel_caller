# Environment registry

This registry contains identifiers and ownership only. Secret values belong in
the approved password manager/Ansible Vault and root-owned Droplet files.

| Environment | Frontend | Backend | Data and integrations | Data policy | Current status |
|---|---|---|---|---|---|
| Local | Vite `127.0.0.1:5173` | Django `127.0.0.1:8002` | Compose PostgreSQL/Redis; sandbox providers | Synthetic only | Available for implementation verification |
| CI | Vite/Playwright runner | Django test process | Ephemeral PostgreSQL/Redis; no outbound production providers | Generated fixtures, destroyed per run | Active; merged PR checks passed |
| Staging | Dedicated Vercel project at `staging.vesselcalls.com`; custom-domain protection is not yet qualified | Droplet `127.0.0.1:8010` through a secret-authenticated Vercel proxy | Separate managed DB, authenticated Redis on 6381, private bucket, Resend allow-list, Sentry project | Synthetic/anonymized only; never production credentials/data | **Partial:** Vercel project/domain/TLS and managed PostgreSQL exist; frontend has no deployment and API remains fail-closed. Custom-domain protection, Spaces, Resend, Sentry, and full provider evidence are deferred |
| Production | Droplet Nginx at `vesselcalls.com` | Target active blue/green loopback slot | Target managed PostgreSQL/PITR, authenticated Redis on 6380, private versioned bucket, Resend, Sentry | Live organization data | **Legacy active:** FastAPI/SQLite blue remains live. Target Django/provider credentials are not qualified; production deployment is prohibited |

## Ownership

| System | Owner | Access/review |
|---|---|---|
| GitHub repository/environments | Repository administrator | Quarterly and on personnel change |
| Droplet root/bootstrap | Infrastructure owner | Emergency/bootstrap only; never in GitHub |
| Restricted `vessel-deploy` user | Release automation owner | Rotated annually or on compromise/change |
| Managed PostgreSQL | Data/platform owner | Least privilege; quarterly |
| Spaces and backup bucket | Data/platform owner | Separate app/backup credentials; quarterly |
| Resend sender/domain | Product operations | Staging allow-list and production separated |
| Sentry projects/alerts | Engineering on-call | PII scrubbing and alert test quarterly |
| Vercel staging project | Frontend/release owner | Protected; staging-only token/project IDs |

## Required DNS

- `vesselcalls.com`: production Droplet.
- `staging.vesselcalls.com`: dedicated protected Vercel staging project.
- `staging-api.vesselcalls.com`: Droplet staging Nginx/API.

As of 2026-07-26, Namecheap has:

- CNAME `staging` → `cname.vercel-dns-0.com` (TTL one minute)
- A `staging-api` → `146.190.76.23` (TTL one minute)

The staging API certificate was issued on 2026-07-26 and its HTTP bootstrap
site remains fail-closed until the qualified Django release is installed.
The managed staging PostgreSQL cluster `vessel-caller-staging`
(`ce0c85f3-cd31-412c-a2e9-d276649f8ae3`) is active in the `Flex School` team,
`first-project`, and `default-nyc1` VPC. Its least-privilege application URI is
held in `/etc/vessel-caller/credentials/staging-database.env` on the Droplet,
and the private endpoint is reachable only from the allow-listed Droplet
network addresses.

The isolated Vercel project `vessel-caller-staging`
(`prj_5NqwmdNkrccuz5iratZCyxGmLDDn`) exists under team
`team_EeFv4vhUKO0m6a2lb36eyCi4`. `staging.vesselcalls.com` is verified for that
project and has valid TLS, but returns 404 because no release has been deployed.
The project has no Git integration and therefore cannot autodeploy repository
pushes. Its current Standard Vercel Authentication scope excludes custom
domains; deployment remains prohibited until `staging.vesselcalls.com` itself
is protected and an automation bypass is stored in the protected GitHub
environment.

Vercel custom-domain protection/deployment and Spaces/Resend/Sentry credentials
are `Deferred`—not passed, waived, or complete. These are release blockers, not
reasons to reuse production or legacy credentials.

The exact protected inputs, evidence requirements, execution order, and owner
sign-offs are maintained in
`docs/runbooks/post-credential-release-checklist.md`. Until those gates have
real provider evidence, the implementation may continue through
credential-independent qualification, but no release may be marked
production-qualified and no production deployment may begin.
