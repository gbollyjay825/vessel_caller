# Role and account policy

Users belong to one organization. Effective permissions come from
`/api/auth/me`; the backend remains authoritative.

| Capability | Admin | Operations | Finance | Viewer |
|---|---:|---:|---:|---:|
| View organization operations | Yes | Yes | Yes | Yes |
| Create/edit vessel calls and inspections | Yes | Yes | No | No |
| Finalize inspections | Yes | Yes | No | No |
| View measurement plans, returns, reconciliations and evidence (`measurements.view`) | Yes | Yes | Yes | Yes |
| Plan/capture measurements and record paper acknowledgements (`measurements.manage`) | Yes | Yes | No | No |
| Finalize a reconciliation (`measurements.approve`) | Independent reviewer only | No | No | No |
| Assess/issue disparity invoices (`measurements.bill`) | Yes | No | Yes | No |
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

After replacing an Admin-generated temporary password, users without a
configured authenticator are guided to `/app/account?setup=authenticator`.
The guide confirms their new password, renders the provisioning URI as a local
QR code (with manual-key and same-device alternatives), verifies a six-digit
TOTP code and keeps recovery codes visible until they acknowledge saving them.
Setup seeds, passwords and recovery codes stay in component memory, outside
query caches and browser persistence. The existing server role/grace policy
still applies; the guide changes the onboarding experience only.

After mandatory MFA grace expires, authenticated customers are routed to
`/app/account` before workspace data is requested. Account security remains
available independently of tenant data permissions. Successful enrollment
refreshes permissions but keeps the recovery codes on screen until the user
chooses to open the workspace. Disabling MFA that is already disabled cannot
renew its enrollment grace period.

Measurement final approval must be performed by an Admin other than the proposal's
preparer. Acknowledgements record staff-entered paper evidence; stakeholder parties
are not application user roles. Measurement permissions remain subject to customer
organization lifecycle, active-account and MFA requirements. Suspended organizations
cannot read or mutate measurement records or obtain new private evidence links.
See [measurement operations](MEASUREMENTS.md) for approval, amendment and billing controls.
