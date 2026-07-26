# Vessel Caller

Vessel Caller manages organization users, vessel calls, inspections, evidence,
invoices, payments, and port analytics. This repository implements the target
React/Vite SPA backed by Django 5.2 LTS and Django REST Framework.

As of 2026-07-26, `vesselcalls.com` still serves the legacy FastAPI/SQLite blue
service. Django is merged and independently verified, but is not production
deployed or production qualified.

## Architecture

- `frontend/`: TypeScript React application
- `backend/`: Django API, database sessions, role enforcement, Celery, and
  PostgreSQL migrations
- `compose.yml`: local PostgreSQL and Redis
- `deploy/`: immutable release, blue-green Nginx/systemd, backup, and monitoring
- `ansible/`: guarded FlexSchools Droplet bootstrap
- `docs/`: architecture, RBAC, SDLC, backlog, ADRs, and operator runbooks

Production remains hosted only at `https://vesselcalls.com` on the FlexSchools
Droplet. The target staging design uses a dedicated protected Vercel project
for the static SPA and an isolated Droplet Django service. The Vercel binding
and provider-backed staging qualification are deferred until approved
credentials exist.

The root legacy HTML/Babel files and `backend/legacy_fastapi/` are migration
compatibility sources. They are not production targets and will be removed
after the qualified Django cutover and compatibility window. There are no
production demo credentials or automatic seed/reset behavior.

## Local development

Prerequisites: Python from `.python-version`, Node from `.nvmrc`, and Docker.

```bash
cp .env.example .env
make services-up
make bootstrap
.venv/bin/python backend/manage.py migrate
.venv/bin/python backend/manage.py runserver 127.0.0.1:8002
```

In another terminal:

```bash
cd frontend
npm run dev
```

The frontend is at `http://127.0.0.1:5173`; Vite proxies `/api` to Django.
Create test accounts through explicit test fixtures/commands only. Never copy
production credentials or data into local, CI, Vercel, or staging.

## Quality and release

```bash
make backend-check
make backend-test
make frontend-check
make release-check
```

Pull requests must pass backend, frontend, browser/accessibility, and security
workflows. Signed semantic tags build an immutable checksummed archive with an
offline wheelhouse, SBOM, and provenance. The same artifact is promoted to
staging and then to the inactive production slot.

Production promotion is intentionally blocked until every P0 gate in
[the canonical backlog](docs/BACKLOG.md) is qualified, including provider
credentials, migration parity, restore/rollback drills, security/accessibility
tests, load targets, alerts, and FlexSchools regression checks.
Missing provider credentials make those gates `Deferred`, never passed or
waived. Console/memory email, local filesystem/S3 substitutes, mocked browser
responses, and localhost checks cannot count as production-provider evidence.

Start with:

- [Architecture](docs/ARCHITECTURE.md)
- [SDLC and release policy](docs/SDLC.md)
- [Role matrix](docs/RBAC.md)
- [Deployment/cutover](docs/runbooks/deployment-cutover.md)
- [Backup/restore](docs/runbooks/backup-restore.md)
- [Incident/monitoring](docs/runbooks/monitoring-incident.md)
- [Post-credential release checklist](docs/runbooks/post-credential-release-checklist.md)
