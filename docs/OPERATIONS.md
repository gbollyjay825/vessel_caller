# Lifecycle and operational policy

## Data retention

- Audit/security events: seven years unless legal policy requires longer.
- Financial invoice/payment snapshots: seven years.
- Inspection evidence and generated documents: contract/legal retention,
  default seven years; deletion is a separately approved lifecycle job.
- Active sessions: 30-day absolute maximum; revoked/expired records are purged
  after 90 days while sanitized security audit evidence remains.
- Invitations/verification/password-reset tokens: retain sanitized outcome for
  one year; never retain usable plaintext tokens.
- Application logs: 30 days on-host; external retention 90 days, redacted.
- Database exports: daily for 30 days plus managed PITR meeting 15-minute RPO.

Removal requests suspend access immediately. Irreversible personal-data erasure
requires identity/authority validation, legal-retention review, a scoped export,
and an audited operator change; it must not corrupt financial/audit records.

## Dependency and platform cadence

- Dependabot and security scans run weekly.
- High/critical vulnerabilities trigger immediate triage and release.
- Moderate findings require an owner, compensating control, written waiver, and
  expiry; otherwise they block release.
- Apply routine dependency updates monthly and supported runtime patches
  quarterly after staging qualification.
- Review Django/DRF/Python/Node/PostgreSQL/Redis support dates quarterly and
  open an upgrade epic at least six months before end of support.
- Run backup restoration, credential/access review, and alert/tabletop drills
  quarterly.

## Support and changes

Product support records organization, affected workflow, timestamps, request
IDs, and sanitized evidence. It never asks for passwords, session cookies, MFA
secrets/codes, recovery codes, API keys, or payment credentials.

Production changes require a linked backlog item, peer review, signed artifact,
staging evidence, protected approval, named operator/rollback owner, observation
window, and completed change record. Emergency changes follow the same artifact
and evidence path as soon as containment permits.

## Privacy and security review

Review new fields, uploads, exports, logs, analytics, and provider integrations
for purpose, minimization, tenant isolation, retention, access, and deletion.
Secrets and direct personal/payment identifiers may not enter logs, Sentry,
widgets, CI artifacts, fixtures, or pull requests. Security design changes
require an ADR and abuse-case tests.
