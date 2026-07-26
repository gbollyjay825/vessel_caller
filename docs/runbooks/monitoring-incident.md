# Monitoring and incident response

## Signals and alert thresholds

- GitHub-hosted external `/`, `/api/health`, and `/api/readiness` checks every
  five minutes, plus on-Droplet checks. The external failure must notify the
  engineering on-call through protected workflow notifications.
- FlexSchools check after every infrastructure/release change.
- Alert on sustained 5xx, p95/p99 regression, elevated auth/MFA/reset failures,
  outbox age/failures, PostgreSQL/Redis connectivity, disk above 80%, stale
  backup over 26 hours, certificate expiry inside 14 days, and systemd crash
  loops.
- Sentry events include environment, release, request ID, and sanitized actor/
  organization IDs; never passwords, tokens, cookies, MFA data, credentials,
  email bodies, evidence URLs, or payment identifiers.

## Severity

- SEV-1: data loss/corruption, cross-tenant exposure, active compromise, or both
  public applications unavailable.
- SEV-2: critical Vessel Caller workflow unavailable or widespread lockout.
- SEV-3: degraded behavior with a documented workaround.

## Response

1. Acknowledge, name incident commander and scribe, and start a timeline.
2. Preserve evidence; rotate/revoke credentials if compromise is suspected.
3. Reduce harm: maintenance mode, session revocation, upload disablement, or
   rollback, choosing the smallest scoped action.
4. Verify FlexSchools independently before and after any Droplet change.
5. Communicate impact and next update time without exposing personal/security
   data.
6. Recover with the rollback/restore runbook and validate critical journeys.
7. Within two business days, produce a blameless review with root cause,
   detection gap, corrective owners/dates, and backlog links.
