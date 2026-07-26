# ADR 0004: Transactional outbox for external messages

- Status: Accepted
- Date: 2026-07-26

## Decision

Persist intended email work in PostgreSQL in the same transaction as its
business event. Celery claims and delivers outbox rows through Resend using
stable idempotency keys, retry backoff, and terminal failure state.

## Consequences

API success never depends on a synchronous provider call, and a database
rollback cannot leave a sent invitation without a matching account record.
Workers may retry safely. Operators can inspect sanitized status and alert on
age/failure without exposing message bodies or tokens.
