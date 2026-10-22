# Pending-invitation replacement — verified staging release, 14 October 2026

## Result

An organization Admin can create a temporary-password user at the same email as their organization's pending invitation. The form preserves the entered name and selected role, offers an unchecked **Replace pending invitation** confirmation, then submits `replacePendingInvitation: true`. Creation and revocation commit together. Failed creation leaves the invitation usable. Existing users, other organizations' invitations and open join requests cannot be overwritten. The old invitation cannot be accepted or revived through resend after conversion.

The Add user form now includes a readonly **Temporary password** field explaining when generation happens. After creation, the actual password is immediately visible, with **Copy password**, **Copy sign-in details** and optional Hide/Show. The old invitation-success banner clears when starting a new action. The sign-up panel always renders its URL/copy field, with a prominent replacement action when the previous one-time bearer URL cannot be retrieved. No actual shared link was rotated during verification.

Credentials and generated bearer URLs remain in ephemeral component state, outside React Query caches and browser persistence. Existing seven-day expiry, mandatory first password change, role/MFA controls, honest Admin provenance, no credential email and bounded pending-account regeneration remain in place. No schema or installed deployment-control changes were introduced.

## Signed candidate and checks

| Item | Verified value |
| --- | --- |
| Candidate | `v0.2.4-staging.20261014T1254` |
| Deployed source | `e9b54f333f88cfdcb028ce7d396562589a3bcfb3` |
| Hosted run | [38567398067](https://github.com/gbollyjay825/vessel_caller/actions/runs/38567398067) |
| Artifact | `11895783901` |
| Archive SHA-256 | `bb90add8ca077d2e469c37dbcae9ff902be721f17b47d56986837ab56689e727` |
| Signature-file SHA-256 | `9882897383346e763444f6150454e4936815e8110f26e72425c9795332e72c37` |
| Trusted public-key SHA-256 | `677e097fb8a4e01df2de2b46c41399162e597b442fb998640a8dbeb75ef6b2ce` |
| Reviewed wrapper SHA-256 | `dc93121447195be67b2e9318d5cb2cb74df9e927b5985b8a575ea7aab3f5d10f` |

All eight hosted jobs passed: backend, frontend, infrastructure, dependency/static security scan, both CodeQL languages, browser and signed packaging. Browser logs confirm **20 real Django journeys** and **72 mocked UI journeys** across four targets. The new complete journey replaces a pending invitation, checks visible one-time credentials and revoked invitation status, signs in with the temporary password, requires a different password, verifies Viewer access/reload and rejects Admin operations/replayed or old credentials.

Locally, **361 PostgreSQL tests** passed with **94.61% branch coverage**, including acceptance/resend/duplicate-conversion races. **588 frontend tests**, coverage, lint, TypeScript and production build passed. The complete conversion journey passed Chromium, WebKit and mobile Chromium. Independent review found no blockers.

The first candidate's hosted full type check found a missing non-null assertion in a new test. The assertion was corrected without changing application behavior. Full backend mypy then passed **149 source files**, Ruff/format passed **121 files**, and the focused conversion/race suite passed **37 tests**. The corrected candidate above reran and passed every hosted gate; the first candidate was not installed.

Archive checksum, OpenSSL signature, exact source/tag/same-origin UI metadata and all eight helper bytes were independently verified. GitHub attestation verification required the exact source/ref, repository release workflow, run 38567398067 and no self-hosted runners. The signed staging-only manifest retains both organization-approval and temporary-password lifecycle capabilities and blocks production installation.

## Installation and preservation

Every SSH operation used the pinned FlexSchools connector. Uploads were exclusive regular files, validated by SHA-256 before assigning the deploy-account ownership required by the trusted snapshot helper. The reviewed wrapper held the release lock, authenticated root-owned snapshots, checked host/config/process pins and preserved both compatibility floors and all eight existing helpers.

Staging writers were frozen for a consistent PostgreSQL backup and no-seed preparation. The complete User and Invitation field projections, plus the full migration ledger, were identical before and after: **17 Users, 6 Invitations and 40 migration rows**. Existing temporary-password flags were preserved without assuming false/null defaults. No new migration was applied. Temporary database connection files and the plaintext dump were removed.

- Encrypted backup: `/var/lib/vessel-caller/ui-backups/v0.2.4-staging.20261014T1254/staging.dump.age`, **482960 bytes**.
- Ciphertext SHA-256: `d9a44701d04be8d6c13ddc4a23b806eed5d7922828a8897dc91aa2f57d240ace`.
- Backend: `/opt/vessel-caller/releases/v0.2.4-staging.20261014T1254/staging`.
- Frontend: the same release's `frontend/dist`, switched atomically after readiness passed.
- Staging web/worker are active with PIDs **170293 / 170275**.
- HTTPS readiness reports database/cache ready and the exact e9b54f3/T1254 identity. HTTPS UI metadata matches; every served frontend file was compared byte-for-byte with the signed package.

The no-seed prepare unit, disabled System Admin mutation flag, Nginx configuration/PID and production symlink/processes remain unchanged. Nginx was validated without reloading. Production HTTPS readiness remains healthy at v0.1.9 / `c9cb5c7ca7d0015f967b3e7146c8c737f55ce69a`; FlexSchools HTTPS returned 200. Recovery remains compatible and fail-closed, with no reverse migration, automatic database restoration or production publication.

## Live acceptance and limits

The original staging Admin session survived. A fresh browser load confirmed the NPA brand, visible **Shareable sign-up link** field, disabled copy control until a fresh URL exists, replacement guidance/action, and the unchanged active-link expiry. Opening Add user confirmed Temporary password selected by default, all four roles, the labelled readonly generated-password field and generation/copy guidance. The blank form was left open for the user.

Screenshots `staging-signup-link-field-20261014.png` and `staging-generated-password-field-20261014.png`, attestation proof, full CI/source metadata, HTTPS responses, host audit and deployment log are saved under `/Users/gbolahan.salami/.codex/preview/vessel-agency-ui/releases/v0.2.4-staging.20261014T1254/`.

No actual staging account was created or invitation converted, no password was entered or changed, and no credential email was sent by this task. Complete account acceptance was tested against isolated PostgreSQL locally and in hosted CI; live observation covers the Admin session and blank form. The separate recipient email-acceptance investigation remains paused.

Voyage reconciliation, agency directory and invoice previews remain browser-saved UI data. This change does not add durable guest-reading/PDF persistence, accounting invoice issuance/payment verification or a durable NPA reconciliation audit trail. The later evidence-only commit is not the deployed application source.
