# Vessel Caller

Vessel Caller manages organization users, vessel calls, inspections, evidence,
invoices, payments, and port analytics. The production application is a
React/Vite SPA backed by Django 5.2 LTS and Django REST Framework.

## Architecture

- `frontend/`: TypeScript React application
- `backend/`: Django API, database sessions, role enforcement, Celery, and
  PostgreSQL migrations
- `compose.yml`: local PostgreSQL and Redis
- `deploy/`: immutable release, blue-green Nginx/systemd, backup, and monitoring
- `ansible/`: guarded FlexSchools Droplet bootstrap
- `docs/`: architecture, RBAC, SDLC, backlog, ADRs, and operator runbooks

Production runs only at `https://vesselcalls.com` on the FlexSchools Droplet.
A dedicated protected Vercel project serves the static staging SPA only; it
holds no production credentials or data and proxies same-origin `/api` requests
to the isolated Droplet staging Django service.

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

Start with:

- [Architecture](docs/ARCHITECTURE.md)
- [SDLC and release policy](docs/SDLC.md)
- [Role matrix](docs/RBAC.md)
- [Deployment/cutover](docs/runbooks/deployment-cutover.md)
- [Backup/restore](docs/runbooks/backup-restore.md)
- [Incident/monitoring](docs/runbooks/monitoring-incident.md)
