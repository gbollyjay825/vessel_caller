# Role and account policy

Users belong to one organization. Effective permissions come from
`/api/auth/me`; the backend remains authoritative.

| Capability | Admin | Operations | Finance | Viewer |
|---|---:|---:|---:|---:|
| View organization operations | Yes | Yes | Yes | Yes |
| Create/edit vessel calls and inspections | Yes | Yes | No | No |
| Finalize inspections | Yes | Yes | No | No |
| View invoices and reports | Yes | Yes | Yes | Yes |
| Record/reverse payments | Yes | No | Yes | No |
| Manage charge/settings data | Yes | No | Yes | No |
| Invite, role-change, suspend, or remove users | Yes | No | No | No |
| View/export organization audit events | Yes | No | No | No |

Account states are `invited`, `active`, `suspended`, and `removed`.
Administrators cannot view or choose another user's password. Role changes,
suspension, removal, password reset, email change, and MFA reset immediately
revoke affected sessions. Last-active-Admin protection is transactional, and a
user cannot suspend, remove, or demote themselves through User Management.

Admin and Finance users must enroll TOTP MFA within seven days. Other roles may
opt in. Sessions expire after 12 idle hours and 30 absolute days. Passwords use
Argon2id; legacy Passlib PBKDF2 hashes are recognized only long enough to
upgrade on successful authentication or reset.
