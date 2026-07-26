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
