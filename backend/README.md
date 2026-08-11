# Vessel Caller Django API

Production API for Vessel Caller, built with Django 5.2 LTS, Django REST
Framework 3.17, PostgreSQL, Redis/Celery, private object storage, and Resend.
The retired FastAPI implementation is retained in `legacy_fastapi/` only for
the controlled blue/green rollback window.

## Local setup

Python 3.12 and PostgreSQL are required.

```bash
python3.12 -m venv .venv
.venv/bin/pip install --require-hashes -r backend/requirements/development.txt
cp backend/.env.example backend/.env.local
set -a; source backend/.env.local; set +a
.venv/bin/python backend/manage.py migrate
.venv/bin/python backend/manage.py runserver 127.0.0.1:8000
```

The local environment file is ignored by Git. Django does not silently load
it; source it explicitly or let the process supervisor inject variables.

Use `vessel_caller.settings.development` locally,
`vessel_caller.settings.test` in tests, and
`vessel_caller.settings.production` under Gunicorn. Production settings fail
fast when PostgreSQL TLS, Redis, Resend, Spaces, release identity, MFA
encryption, or Sentry configuration is missing.

## Authentication and CSRF

Authentication is a server-side Django session. The browser never receives a
bearer token.

1. `GET /api/auth/csrf` sets `csrftoken` and returns `{csrfToken}`.
2. Send cookies on every request.
3. Send `X-CSRFToken` on every unsafe request.
4. Production sets a Secure, HttpOnly, SameSite=Lax `__Host-vessel_session`
   cookie. Development uses `vessel_session` so HTTP browser tests work.

Registration returns `202` and creates no session until the 24-hour email link
is verified. Additional users join through rotating, seven-day invitations.
Admin and Finance MFA becomes mandatory after the seven-day enrollment grace
period. Sessions expire after 12 idle hours or 30 absolute days and are
revoked after sensitive access changes.

## API overview

All JSON uses camelCase, exact no-trailing-slash routes, and errors shaped as
`{detail, errors, requestId}`.

- Identity: `/api/auth/*`, `/api/profile`, `/api/users`, `/api/invitations`
- Security: `/api/auth/mfa/*`, `/api/auth/sessions`
- Operations: `/api/vessel-calls`, `/api/inspections`
- Billing: `/api/invoices/{id}/payments`, `/api/payments/{id}/reverse`
- Evidence: `/api/evidence/presign`, `/api/evidence`
- Documents: `/api/{vessel-calls|inspections|invoices}/{id}/document`
- Compatibility: `/api/state` remains for one transition release
- Monitoring: `/api/health` and `/api/readiness`

The health responses contain `VC_RELEASE_SHA` and `VC_RELEASE_TAG`, never
secrets, so promotion checks can prove artifact identity.

## Tests and quality gates

The isolated test database URL belongs in `VC_TEST_DATABASE_URL`.

```bash
set -a; source backend/.env.local; set +a
export DJANGO_SETTINGS_MODULE=vessel_caller.settings.test
cd backend
../.venv/bin/python -m pytest
# Focused private organization-logo API, validation, and PDF-branding checks:
../.venv/bin/python -m pytest tests/test_organization_logo.py -q
# Focused configurable invoice workflow, reconciliation, and RBAC checks:
../.venv/bin/python -m pytest tests/test_invoice_status_workflow.py -q
../.venv/bin/python manage.py makemigrations --check --dry-run
../.venv/bin/python manage.py check
../.venv/bin/ruff check .
../.venv/bin/mypy .
../.venv/bin/bandit -r accounts api audit billing operations organizations vessel_caller
```

`python manage.py seed_e2e --password '<local-strong-password>'` creates four
deterministic role accounts only for local DEBUG use. Staging or isolated CI
must pass `--force` and obtain a strong `VC_E2E_PASSWORD` from protected
configuration. The command contains no reusable password and is permanently
disabled when `VC_ENVIRONMENT=production`. Ansible Vault writes the staging
value to a prepare-only environment file; the web and worker services do not
receive it.

## Legacy SQLite migration

First take a consistent SQLite backup with the SQLite backup API. The importer
also creates an internal backup snapshot so the WAL is included:

```bash
python manage.py import_legacy_sqlite /secure/path/vessel_caller.db \
  --manifest /secure/path/import-manifest.json
```

The command accepts the reviewed legacy schema fingerprint
`031d952f0cc24632ad038e59684463d319cfe9d116e2441a4b347d8afdbafcd3`,
rejects unknown schemas unless `--allow-unknown-schema` is explicitly used,
preserves opaque IDs and legacy password hashes, normalizes decimal money and
payments, rebuilds number sequences, and emits row/ID checksums, counts, and
financial totals. Use `--dry-run` before importing and rehearse from production
snapshots twice. Legacy Passlib PBKDF2 hashes upgrade to Argon2id at the next
successful login.

## Processes

```bash
gunicorn vessel_caller.wsgi:application \
  --bind 127.0.0.1:8002 --workers 3 --threads 2 --timeout 60
celery -A vessel_caller worker --loglevel=INFO
```

Run migrations and `manage.py check --deploy` before switching the Nginx
upstream. Build static files once with `manage.py collectstatic --noinput`.
Production email uses an encrypted transactional database outbox. Celery retries Resend
delivery with a stable provider idempotency key, while the active worker runs a bounded
periodic dispatcher that republishes pending or stale-sending rows after broker/worker
outages. Permanently failed rows are excluded from the sweep to preserve retry backoff.
Production evidence uses private Spaces
objects and short-lived signed upload/download URLs.
