# ADR 0004: Transactional outbox for external messages

- Status: Accepted
- Date: 2026-07-26

## Decision

Persist intended email work in PostgreSQL in the same transaction as its
business event. Celery claims and delivers outbox rows through Resend using
stable idempotency keys, retry backoff, and terminal failure state.

Broker publication happens only after the database commit and is best effort:
an unavailable broker leaves the encrypted row pending without turning the
committed API operation into a false failure. The active Celery worker's main
process runs a 60-second timer bootstep that publishes a bounded dispatcher
task. Each pass republishes at most 100 pending rows plus rows left in
`sending` for more than ten minutes after a worker crash. It never calls the
email provider directly. Rows in terminal `failed` state are excluded so the
dispatcher cannot bypass delivery backoff or create an infinite hot loop.

## Consequences

API success never depends on a synchronous provider call, and a database
rollback cannot leave a sent invitation without a matching account record.
Workers may retry safely. A broker outage between commit and task publication,
or loss of a previously published task, is recovered without another user
request. During a brief blue/green worker overlap, more than one dispatcher may
publish the same durable row. The sent-state check discards completed replays,
and the stable Resend idempotency key makes concurrent delivery attempts safe.
Operators can inspect sanitized status and alert on age/failure without
exposing message bodies or tokens.
