# Account user management — staging release, 12 October 2026

## Outcome

Added organization user management and published the frontend-only release `npa-ui-20261012T191702Z` to https://staging.vesselcalls.com. Admins can open **User Management** from the sidebar or **Manage users** from their account menu, invite a colleague by name/email/role, inspect users, manage pending invitations, and view activity. NPA branding and the existing voyage UI remain included.

The UI uses the deployed user/invitation APIs. No backend source, migrations, database records, email configuration, worker, or accounting records were changed. No real invitation was sent during verification.

## Invitation behavior

- Roles are Admin, Operations, Finance and Viewer; new invitations default to Operations. Access applies across the organization. The role guide loads the existing API permission matrix only when requested.
- The existing backend queues a seven-day, single-use invitation link; the recipient chooses their own password through `/accept-invitation`.
- Submission validates required fields/email, normalizes whitespace and email case, immediately blocks repeated submits, and prevents closing a pending submission. API errors preserve entered fields.
- Successful creation shows **Invitation created**, selects the Invitations tab and refreshes the list. It does not claim email receipt.
- Pending invitations can be renewed or revoked using existing APIs. Expiry is displayed from `expiresAt`; eligible actions follow the backend's stored status.
- Current-user and cached same-organization email duplicates are blocked in the UI. The backend deliberately suppresses delivery for existing user emails, including duplicates outside the loaded user list; the API does not return a delivery indicator.
- User/account/navigation actions are permission-gated. Existing server safeguards for organization scope, self-role/status changes, last active Admin, and session revocation remain in force.

## Validation and observed journey

- Full frontend suite: 49 files / **532 tests passed**; lint, typecheck, build and `git diff --check` passed. After the final explicit input-type styling fix, all 20 User Management tests and typecheck/build passed again.
- Independent review found no blocking permission, security or API-contract regressions.
- Local mock browser exercise: invalid email blocked submission; valid invitation created once, drawer closed, and the pending invitation appeared with accurate feedback. The local mock does not send mail.
- Signed-in staging browser: account menu link opened User Management; the actual organization user list loaded; current-user suspend/remove actions were disabled; Invitations loaded; the role matrix loaded from the API; the blank Invite user drawer displayed the correct organization and default Operations role.
- A read-only infrastructure check confirmed the staging web and worker select Resend, have a configured API key/sender, and use the staging frontend URL. Secret values were not printed. Email receipt and recipient acceptance were **not exercised**.
- Browser proof: `/Users/gbolahan.salami/.codex/preview/vessel-agency-ui/user-management/staging-invite-user.png`.
- Independent outside HTTPS verification confirmed the final release identity/source checksum, Users/Account/invitation-acceptance routes, staging readiness/health, production health and FlexSchools. Full downloaded JS/CSS checksums matched the local artifact: `6f86f2a32068b0a8b62d60965625016cd0ca3475af72fd059641786d462b41c4` / `7b33c4080cc99de9c03a4d524358874f88b1acce979301050d924021fb922bee`.

The pre-existing voyage closeout limitations remain: reconciliation and extra-load invoices are browser-saved previews; guest agency-reading APIs are not implemented; staff reading evidence remains required by the current staging backend. Team invitations use separate, existing account APIs.

## Artifact and deployment

- Release: `npa-ui-20261012T191702Z`.
- Base commit: `313bd2e4c6da5a770ba910d91ea0383c25989ed2`, including current uncommitted frontend changes.
- Frontend source SHA256: `67b5e6f0766ed8d34e6969a472dc2f517fe0659669cf3f824e4a2f1c36560474`.
- Archive SHA256: `aad4c719d1024d56ce5e2d2b9683f15ba48b3e0f972c5303c3db9a8d28f47286`.
- Archive: `/Users/gbolahan.salami/.codex/preview/vessel-agency-ui/releases/npa-ui-20261012T191702Z.tar.gz`.
- Assets: `index-BWkM57OA.js`, `index-DfFVvXwW.css`.
- Public release identity: https://staging.vesselcalls.com/ui-release.json.
- Static target: `/opt/vessel-caller/frontend-releases/staging/npa-ui-20261012T191702Z/dist` through `/opt/vessel-caller/slots/staging/frontend-current`.
- Backend current remains `/opt/vessel-caller/releases/v0.2.1/staging`.
- Web/worker/Nginx PIDs remain `22712` / `22699` / `18608`. All three staging/production/FlexSchools Nginx config hashes remain unchanged. No service reload/restart was performed.

The package includes only `dist/`, `UI_RELEASE.json`, and `SHA256SUMS`; no environment files, keys or backend source. It uses explicit same-origin `VITE_API_BASE=''`. The existing bundle-size warning remains.

Each SSH session used the pinned `flexschools-droplet-ssh/scripts/connect.sh`. Deployment held the release lock, checked the expected current frontend/backend/runtime/config hashes, validated archive paths and checksums, installed an immutable artifact, ran `nginx -t`, atomically switched only the static frontend symlink, compared the HTTPS-served manifest, and checked readiness. A failure trap would restore the prior symlink.

## Rollback

Prior static target: `/opt/vessel-caller/frontend-releases/staging/npa-ui-20261012T191331Z/dist`. Backup: `/var/lib/vessel-caller/ui-backups/npa-ui-20261012T191702Z/prior-frontend-target`.

Use the pinned connector and release lock; verify the current target is still this release, then atomically switch `frontend-current` to the recorded prior target and verify outside HTTPS metadata/assets. No backend rollback, migration, Nginx configuration change or reload is needed. For the next full application release, deliberately advance or remove the separate UI overlay as described in the earlier NPA staging release evidence.
