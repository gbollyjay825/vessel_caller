# Vessel Caller — backend

Standalone Python backend for the Vessel Caller port-inspection app.
Pure standard library (Python 3.9+, no pip installs): `http.server` +
SQLite document store. It serves the REST API **and** the static frontend
from one port.

## Run

```bash
python3 backend/run.py          # from the repo root
# or the historical entry point (same server, repo-root DB):
python3 server.py
./serve.sh [port]
```

## Environment variables

| Var            | Default                      | Meaning                                        |
|----------------|------------------------------|------------------------------------------------|
| `PORT`         | `8000`                       | Listen port                                    |
| `HOST`         | `127.0.0.1`                  | Bind address                                   |
| `VESSEL_DB`    | `backend/vessel_caller.db`\* | SQLite database file                           |
| `STATIC_DIR`   | repo root                    | Directory the frontend is served from          |
| `ALLOW_ORIGIN` | *(unset)*                    | CORS origin (`*` or a URL). Unset = no CORS.   |

\* the `server.py` shim keeps the pre-package default of a repo-root
`vessel_caller.db` so existing setups keep their data.

## Endpoints

| Method   | Path                     | Purpose                                                            |
|----------|--------------------------|--------------------------------------------------------------------|
| `GET`    | `/api/state[?rev=N]`     | Full app state; `{changed:false}` when `rev` is already current    |
| `POST`   | `/api/vessel-calls`      | Register a vessel call → `{call, rev}`                             |
| `DELETE` | `/api/vessel-calls/<id>` | Cancel a call and its inspections/invoices                         |
| `POST`   | `/api/inspections`       | Submit an inspection; completion issues the invoice (with a frozen dues/commission snapshot) → `{inspection, invoice, call, rev}` |
| `PUT`    | `/api/organization`      | Save organization profile, ports, logo and roles                   |
| `PUT`    | `/api/invoices/<id>`     | Record / clear payment tracking (`payment.amount` defaults to the invoice's snapshotted dues) |
| `PUT`    | `/api/settings`          | Save charge/notification/port settings                             |
| `POST`   | `/api/reset`             | Wipe the database back to the demo seeds                           |
| `GET`    | *anything else*          | Static frontend files from `STATIC_DIR`                            |

## CORS

By default the API emits no CORS headers — the frontend is served from the
same origin. To call the API from another origin (e.g. a separately hosted
frontend), set `ALLOW_ORIGIN=*` (or a specific URL): API responses then carry
`Access-Control-Allow-Origin/Methods/Headers` and `OPTIONS` preflights on
`/api/*` answer `204`.

## Layout

```
backend/
  run.py                    entry point
  vessel_backend/
    config.py               env-driven configuration
    seeds.py                demo seed data (kept in lockstep with calabar/data.jsx)
    db.py                   SQLite document store (WAL) + rev counter
    services.py             business logic + dues/commission maths
    api.py                  HTTP handler, routing, CORS, static serving
  tests/test_api.py         end-to-end API tests (stdlib unittest)
```

## Tests

```bash
cd backend
python3 -m unittest discover -s tests -t .
```

The suite boots the real server on an ephemeral port with a temp database,
then exercises every endpoint (seeds, call registration, inspection →
invoice snapshot, payment recording, org roundtrip, rev polling, reset,
CORS preflight).
