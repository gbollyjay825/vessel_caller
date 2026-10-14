# ADR 0002: Server-side sessions, CSRF, and MFA

- Status: Accepted
- Date: 2026-07-26

## Decision

Use Django database sessions in a Secure, HttpOnly, SameSite=Lax `__Host-`
cookie. Unsafe requests require Django CSRF token and origin validation.
Passwords use Argon2id. Admin/Finance MFA is mandatory after seven days; TOTP
secrets are encrypted and recovery codes are hashed.

## Consequences

The login response never exposes a bearer token, and all legacy JWTs become
invalid at cutover. Password changes, security/role changes, and account
suspension/removal revoke sessions immediately. Redis may cache challenges but
cannot be the only record of authentication or audit state.

## Organization-specific accounts (14 October 2026)

An email can have a separate User record in more than one customer organization.
Each record keeps its own password, role, MFA, sessions and action tokens. Email
is unique ignoring case within an organization. Adding an account or replacing
an invitation in one organization never updates the other organization's User.
Platform operator addresses remain reserved.

Generated sign-in and recovery links carry `organizationId` as a routing hint;
the server still proves the selected account's password and enforces its normal
MFA, lifecycle and first-password-change requirements. General sign-in can
select a single password-proven account. When a password proves multiple
accounts, only those organization names are offered, and selection rechecks
the credentials before creating a session. The chooser itself grants no
workspace session. Credentials and choice state remain in component memory.

The accounts0008 schema cutover has a signed release compatibility floor.
Legacy global-email authentication must not run against the expanded schema;
recovery uses another compatible signed release rather than a reverse migration.
