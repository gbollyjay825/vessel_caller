# Transactional notifications

Vessel Caller sends material security and operational notifications through the
encrypted PostgreSQL email outbox. Celery delivers each message with a stable
idempotency key and redacts its encrypted context after delivery. The service
does not send marketing mail, credentials, or public storage links.

## Recipients

| Event | Recipients |
| --- | --- |
| Registration, verification link, password reset, invitation | Affected email address |
| Account verified, password changed/reset, MFA changed, email change request/completion, access changed, account removed | Affected user; an email-change completion also notifies the previous address |
| Invitation accepted | Inviter |
| Vessel call created or status changed | Active Admin and Operations users other than the actor |
| Vessel call cancelled | Active Admin, Operations, and Finance users other than the actor |
| Inspection finalized and invoice created | Active Admin, Operations, and Finance users other than the actor |
| Invoice status changed, invoice document uploaded or removed | Active Admin and Finance users other than the actor |
| Payment recorded or reversed | Active Admin and Finance users other than the actor |

The actor is deliberately excluded from team notices because the API already
confirms their own action. Suspended and removed users never receive
organization notices. Message text and action URLs are HTML-escaped; action
links are emitted only for HTTPS URLs.

## Staging qualification

Before enabling the same release in production, a controlled staging recipient
must prove each required path with `VC_EMAIL_DELIVERY_BACKEND=resend`:

1. A new registration sends exactly one verification email and the link
   activates the account.
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
