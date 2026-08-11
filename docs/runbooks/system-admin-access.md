# System Admin provisioning, recovery, and revocation

This runbook is for named release/security operators. Tenant Admins, support
staff, and application System Admins cannot grant platform access.

Never provision through Django Admin, raw SQL, shell-created passwords, copied
session cookies, or an ordinary tenant invitation.

## Preconditions

- A linked access request names the person, justification, target environment,
  approver, review/expiry date, and revocation owner.
- The exact signed release is deployed and its System Admin migrations and
  security tests have passed in staging.
- Exactly one `kind=platform` organization exists. The command selects that
  typed container under the database uniqueness constraint; it never guesses
  from a display name or accepts a customer organization.
- Resend is enabled and qualified in the target environment. Provisioning must
  fail closed when delivery is unavailable.
- The recipient controls the mailbox and is not using an existing tenant-user
  email. Application addresses remain globally unique.
- A second active System Admin or documented emergency custodian exists before
  production access is enabled.
- A current encrypted database backup and status-aware rollback release are
  verified.

## Provision access

Use the signed release's idempotent provisioning management command. It
requires recipient email/name, an exact environment assertion, approved change
identifier, reason, and explicit confirmation that no tenant account is being
elevated:

```bash
python manage.py provision_system_admin \
  --email '<dedicated-operator-email>' \
  --name '<operator-name>' \
  --environment '<staging-or-production>' \
  --change-id '<approved-change-reference>' \
  --reason '<business-and-security-justification>' \
  --confirm
```

The command must:

1. refuse a customer organization, existing tenant identity, ambiguous
   platform organization, unavailable email delivery, or incomplete reason;
2. create a non-authenticating platform identity with an unusable password and
   pending mailbox verification for the approved address, plus a
   `PlatformAccessGrant`, with Django staff/superuser flags false;
3. revoke any pre-existing sessions for that identity;
4. rotate earlier pending setup tokens;
5. create a hashed, 24-hour, single-use password-setup/verification token;
6. place only encrypted context in the transactional email outbox;
7. append immutable platform audit evidence; and
8. report only that the approved change queued a 24-hour setup message—not the
   link, token, password, ciphertext, session identifier, or provider credential.

Do not copy a setup URL from the database or outbox as a fallback. Correct the
delivery problem and issue a new link.

## Recipient activation

The recipient opens the link before expiry, chooses a unique policy-compliant
password, verifies email, enrolls TOTP before organization data is displayed,
stores recovery codes offline, then signs out and signs in through MFA.

The operator verifies the expected platform grant, denial from tenant routes,
single-use token behavior, and platform audit events. Never ask for a password,
TOTP/recovery code, token, or cookie.

## Routine access review

Review access at least quarterly and when employment, duties, or incident
ownership changes. Confirm owner, need, approver, last use, review/expiry date,
active MFA, absence of Django staff/superuser privilege, no shared identity or
tenant membership, immutable audit continuity, and alert delivery.

## Revoke access

Use the signed release's revocation command with exact identity, environment,
change identifier, reason, and confirmation:

```bash
python manage.py revoke_system_admin \
  --email '<dedicated-operator-email>' \
  --actor-email '<approved-active-custodian-email>' \
  --environment '<staging-or-production>' \
  --change-id '<approved-change-reference>' \
  --reason '<revocation-justification>' \
  --confirm
```

It must transactionally:

1. lock/deactivate the grant and user identity;
2. revoke all managed and Django sessions;
3. revoke unused action tokens, MFA challenges, and recovery codes;
4. prevent new login before cleanup completes; and
5. append immutable platform audit evidence.

Revocation does not delete identity/history. It must refuse to remove the last
active production System Admin unless a replacement custodian has first been
provisioned and verified.

## Password or MFA recovery

- Password recovery dispatches a one-time reset email. The operator cannot
  choose, view, or relay password/link.
- MFA recovery validates the approved request, revokes every session/recovery
  code, deactivates platform access until fresh enrollment, and audits it.
- Email change uses verified recovery, not a direct field edit. Notify old and
  new addresses when delivery is possible.

## Suspected compromise

1. Declare a security incident and identify an unaffected custodian.
2. Revoke through the supported command; do not use ad-hoc SQL/delete audit.
3. Revoke sessions/tokens and rotate separately accessible provider/deployment
   credentials.
4. Preserve request IDs, audit, logs, release metadata, and an encrypted export.
5. Review lifecycle and tenant-Admin recovery actions by the identity.
6. Restore access only through a new approved provisioning event after signoff.
