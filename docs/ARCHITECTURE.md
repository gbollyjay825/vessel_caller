# Production architecture

Vessel Caller is a same-origin React/Vite SPA and Django 5.2 LTS/DRF service.
Nginx terminates TLS and routes only `vesselcalls.com`; FlexSchools remains a
separate Nginx site and application.

## Runtime

- Django apps: accounts, organizations, operations, billing, audit, and API.
- Gunicorn: three workers, two threads, loopback only.
- PostgreSQL: durable application, session, audit, invitation, outbox, and
  migration state; TLS and least-privilege credentials are mandatory.
- Dedicated Redis: `127.0.0.1:6380`; production DB 0, staging DB 1. It handles
  Celery and short-lived cache/challenge state, never authoritative records.
- Celery consumes a transactional PostgreSQL outbox for Resend email. Database
  transactions and idempotency keys prevent duplicate business effects.
- Private DigitalOcean Spaces stores evidence, logos, and generated documents.
  Access is authorized by Django and uses short-lived signed URLs.
- Sentry receives redacted frontend/backend failures and release versions.

## Network and deployment

| Purpose | Address |
|---|---|
| Legacy/Future production blue | `127.0.0.1:8001` |
| Initial Django production green | `127.0.0.1:8002` |
| Django staging API | `127.0.0.1:8010`, public through `staging-api.vesselcalls.com` |
| Dedicated Redis | `127.0.0.1:6380` |

The active production backend is a one-line Nginx include changed atomically only after
candidate readiness. `/opt/vessel-caller/current` points to the same active
release for static assets. Staging has an independent database, bucket, service
environment, and API hostname. The exact prebuilt staging SPA is served by a
dedicated protected Vercel project at `staging.vesselcalls.com`; its `/api`
route proxies to the staging API so browser sessions remain same-origin.
Vercel holds no production data or runtime credentials and runs no Django,
Celery, Redis, or PostgreSQL service.

The Droplet allows inbound SSH, HTTP, and HTTPS only. Managed PostgreSQL,
Spaces, Resend, Sentry, and GitHub are external dependencies. The single
Droplet remains one compute failure domain; encrypted off-host backups and
reproducible infrastructure meet recovery, not compute high availability.

## Security boundaries

- Django server-side sessions use Secure, HttpOnly, SameSite cookies and CSRF
  origin/token validation. Tokens are never stored in browser localStorage.
- Roles and organization ownership are enforced in backend services and
  querysets. Frontend permission checks are navigation affordances only.
- Django Admin is denied by Nginx until trusted operator CIDRs are allow-listed.
- Uploaded objects are private, type/size checked, organization-scoped, and
  accessed through expiring URLs.
- Application users cannot modify release, Nginx, systemd, environment, or
  backup configuration. The deployment user has a two-command sudo surface.
- Audit events are append-only and redact passwords, tokens, MFA secrets,
  recovery codes, provider credentials, and direct personal/contact data.
