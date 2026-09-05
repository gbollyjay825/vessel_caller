# Transactional notifications

Vessel Caller sends material security and operational notifications through the
encrypted PostgreSQL email outbox. Celery delivers each message with a stable
idempotency key and redacts its encrypted context after delivery. The service
does not send marketing mail, credentials, or public storage links.

## Recipients

| Event | Recipients |
| --- | --- |
| Registration, verification link, password reset, invitation | Affected email address |
| Organization approved | Active or invited tenant Admins in the approved organization |
| Account verified, password changed/reset, MFA changed, email change request/completion, access changed, account removed | Affected user; an email-change completion also notifies the previous address |
| Invitation accepted | Inviter |
| Vessel call created or status changed | Active Admin and Operations users other than the actor |
| Vessel call cancelled | Active Admin, Operations, and Finance users other than the actor |
| Inspection finalized and invoice created | Active Admin, Operations, and Finance users other than the actor |
| Invoice status changed | Active users in the recipient roles configured by an Admin for the destination status, other than the actor |
| Invoice document uploaded or removed | Active Admin and Finance users other than the actor |
| Payment recorded or reversed | Active Admin and Finance users other than the actor |

The actor is deliberately excluded from team notices because the API already
confirms their own action. Suspended and removed users never receive
organization notices. Message text and action URLs are HTML-escaped; action
links are emitted only for HTTPS URLs.

Only organization Admins can configure invoice-status notification policies.
Each status has an explicit enable switch and one or more validated roles from
the fixed Admin, Operations, Finance, and Viewer role matrix. Existing
non-Paid statuses initially retain the prior Admin-and-Finance behavior; Paid
starts disabled to avoid an unexpected duplicate beside the separate payment
receipt notice. Paid's workflow identity remains protected even though its
notification policy is configurable. Manual same-status requests, partial
payments, idempotent payment/reversal replays, void transitions, and migration
history do not generate status-notification messages.

## Broker recovery

The web process writes encrypted outbox rows transactionally and attempts to
publish their task only after commit. If Redis is unavailable, the committed
row remains pending and the API result remains successful. Every active Celery
worker schedules a short-lived bounded dispatcher once per minute. It
republishes pending and conservatively stale-sending rows by durable outbox ID;
delivery still uses the original provider idempotency key. Permanently failed
rows are not swept and remain visible for operator investigation.

## Staging qualification

Before enabling the same release in production, a controlled staging recipient
must prove each required path with `VC_EMAIL_DELIVERY_BACKEND=resend`:

1. A new registration sends exactly one verification email; the link verifies
   onboarding while workspace access remains pending until explicit System
   Admin approval.
2. Invitation, resend-verification, password reset, profile-email change,
   password change, MFA enable/disable/reset, role/status change, and removal
   create the expected outbox message.
3. Vessel-call, inspection-finalization, invoice-status, payment/reversal, and
   invoice-attachment events notify only the documented roles.
4. The worker records a Resend provider ID, no retry/error remains in the
   outbox, and the recipient receives the rendered message.

## Production activation gates

Production stays fail-closed until all of these are complete:

1. Store a **production-specific** Resend API key and approved sender in the
   encrypted production Ansible Vault/runtime file; never copy the staging key
   into production or commit either secret.
2. Set `VC_EMAIL_DELIVERY_BACKEND=resend` and clear the deferred-provider flag
   only in the production deployment artifact/runtime configuration.
3. Perform the staging qualification above, then run a controlled production
   smoke delivery after deployment and inspect the outbox/worker result without
   logging recipient data or provider secrets.
4. Verify readiness, Nginx configuration, backup/rollback position, and the
   production release signature before switching public traffic. The legacy
   FastAPI baseline must be made a viable rollback target or replaced by a
   verified, schema-compatible prior Django release before the switch.
