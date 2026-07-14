# Vessel Caller API

Standalone **FastAPI** backend for the Vessel Caller platform — a real REST API
with **JWT authentication**, **server-enforced roles**, a **relational SQLite**
schema (SQLAlchemy 2), and **analytics computed from the database**. Deployable
independently of the frontend.

## Run it

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                 # then set VC_JWT_SECRET
uvicorn app.main:app --reload        # http://127.0.0.1:8000
```

Interactive API docs (OpenAPI/Swagger): **http://127.0.0.1:8000/docs**

On first run the DB is created and seeded with a demo organization, a team
across all four roles, and ~12 months of vessel calls / inspections / invoices.

**Demo login:** `admin@calabarport.ng` / `demo1234`
(also `operations@`, `finance@`, `viewer@calabarport.ng`, same password).

## Configuration

All via env vars (prefix `VC_`) or `.env` — see [.env.example](.env.example).
The essentials for production: `VC_JWT_SECRET` (long random string),
`VC_CORS_ORIGINS` (your frontend origin), and `VC_DATABASE_URL`.

## Auth & roles

- `POST /api/auth/register` creates a new organization + its first **Admin**.
- `POST /api/auth/login` → `{ token }` (JWT bearer, send `Authorization: Bearer …`).
- Roles **Admin / Operations / Finance / Viewer** are enforced server-side on
  every mutating endpoint (not just in the UI). e.g. only Admin/Finance can
  record a payment; only Admin can change settings or manage the team.

## Endpoints

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | Liveness |
| POST | `/api/auth/register` | — | New org + first Admin |
| POST | `/api/auth/login` | — | Get a token |
| GET | `/api/auth/me` | any | Current user + org |
| GET | `/api/state[?rev=N]` | any | Org-scoped bulk state; `{changed:false}` if current |
| PUT | `/api/organization` | Admin | Org profile / ports / logo |
| POST·PUT·DELETE | `/api/organization/members[/id]` | Admin | Team management |
| POST | `/api/vessel-calls` | Admin·Ops | Register a call |
| DELETE | `/api/vessel-calls/{id}` | Admin·Ops | Cancel (cascades) |
| POST | `/api/inspections` | Admin·Ops | Submit; issues a snapshotted invoice |
| PUT | `/api/invoices/{id}` | Admin·Finance | Record / clear payment |
| PUT | `/api/settings` | Admin | Charge rates / notifications / port |
| GET | `/api/analytics[?months=12]` | any | Throughput / revenue / mix, from the DB |

Harbour dues = **net tonnage × the applicable rate** (liquid by jetty class —
Government $1.68 / Private $2.88 / International $4.23; dry $2.17). The dues,
rate, commission and FX are **snapshotted onto the invoice at issue time**, so
changing tariff rates never rewrites already-issued figures.

## Tests

```bash
python -m pytest        # auth, roles, vessel→invoice flow, snapshot integrity, analytics
```

## Deploy (Docker)

```bash
docker build -t vessel-caller-api .
docker run -p 8000:8000 \
  -e VC_JWT_SECRET="$(python -c 'import secrets;print(secrets.token_urlsafe(48))')" \
  -e VC_CORS_ORIGINS="https://your-frontend.example" \
  -e VC_ENVIRONMENT=production \
  -v vessel-data:/data -e VC_DATABASE_URL="sqlite:////data/vessel_caller.db" \
  vessel-caller-api
```

Works on any container host (Render, Railway, Fly.io, Cloud Run, a VPS). For
higher scale point `VC_DATABASE_URL` at Postgres — no code change.

## Structure

```
app/
  main.py        FastAPI app: CORS, security headers, routers, lifespan seed
  config.py      env-driven settings
  db.py          SQLAlchemy engine/session (SQLite WAL, FKs on)
  models.py      relational schema (users, orgs, calls, inspections, invoices, settings)
  schemas.py     Pydantic request models
  security.py    password hashing + JWT + role dependencies
  services.py    dues/commission maths + serialization
  seed.py        demo org + team + 12-month history
  routers/       auth · state · organization · vessel_calls · inspections · invoices · settings · analytics
tests/           pytest suite
```
