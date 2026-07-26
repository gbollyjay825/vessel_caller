# Environment registry

This registry contains identifiers and ownership only. Secret values belong in
the approved password manager/Ansible Vault and root-owned Droplet files.

| Environment | Frontend | Backend | Data and integrations | Data policy |
|---|---|---|---|---|
| Local | Vite `127.0.0.1:5173` | Django `127.0.0.1:8002` | Compose PostgreSQL/Redis; sandbox providers | Synthetic only |
| CI | Vite/Playwright runner | Django test process | Ephemeral PostgreSQL/Redis; no outbound production providers | Generated fixtures, destroyed per run |
| Staging | Protected dedicated Vercel project at `staging.vesselcalls.com` | Droplet `127.0.0.1:8010` through a secret-authenticated Vercel proxy | Separate managed DB, authenticated Redis on 6381, private bucket, Resend allow-list, Sentry project | Synthetic/anonymized only; never production credentials/data |
| Production | Droplet Nginx at `vesselcalls.com` | Active blue/green loopback slot | Managed PostgreSQL/PITR, authenticated Redis on 6380, private versioned bucket, Resend, Sentry | Live organization data |

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
Vercel custom-domain/Preview binding and managed
PostgreSQL/Spaces/Resend/Sentry credentials remain incomplete. These are
release blockers, not reasons to reuse production or legacy credentials.
