# ADR 0001: Django and PostgreSQL production architecture

- Status: Accepted
- Date: 2026-07-26

## Decision

Replace FastAPI/SQLite with Django 5.2 LTS, Django REST Framework, and managed
PostgreSQL. Use a custom email-based user from the initial Django migration.
Keep the React/Vite SPA and same-origin `/api` boundary. Add Redis/Celery for
asynchronous outbox delivery and private Spaces for evidence/documents.

## Consequences

PostgreSQL is mandatory for CI concurrency tests and every deployed
environment. SQLite exists only as a legacy migration source. The importer
must preserve opaque identifiers and reconcile counts, relationships, sequence
state, object checksums, and financial totals. Managed services add provider
dependencies but remove the production durability risk of local SQLite.
