# Organization-specific accounts — verified staging release, 14 October 2026

## Result

A customer organization Admin can create an independent account for an email already used in another customer organization. The new account has its own password, role, MFA, sessions and action tokens. The target organization's pending invitation can be replaced atomically, while the existing account's complete field projection remains unchanged. Platform operator addresses remain reserved.

Generated details identify the organization and its scoped sign-in URL. The password is visible once, can be copied with the complete sign-in details, expires after seven days and must be replaced before workspace access. Normal role/MFA rules apply afterward. Provisioning records the actual tenant Admin as actor without claiming email ownership. No credential email is sent; credentials remain outside query caches and browser persistence.

General sign-in offers only password-proven organizations, without granting a workspace session. Selection rechecks the chosen account under its lifecycle lock. Recovery and verification use organization-specific links; anonymous candidate work and email fanout are bounded. Tests cover an old temporary password racing first change/regeneration and a normal password racing reset; stale proof is rejected.

## Signed release and validation

| Item | Verified value |
| --- | --- |
| Candidate | `v0.2.5-staging.20261014T1430` |
| Deployed application source | `f1088a60ab64aa891d78d8bca3ed61f40ae27074` |
| Hosted run | [38580786281](https://github.com/gbollyjay825/vessel_caller/actions/runs/38580786281) |
| Signed artifact | `11904386030` |
| Archive SHA-256 | `2eabc58f68ade6b614572485f23882cb9ef2b42d706d50a68caa76eb46fe7b0c` |
| Signature-file SHA-256 | `c15969f791cbc275047e5549de68e76aa45017b717cf60f0e512c4650bb54f9a` |
| Existing public-key SHA-256 | `677e097fb8a4e01df2de2b46c41399162e597b442fb998640a8dbeb75ef6b2ce` |
| Reviewed final wrapper SHA-256 | `ccbc79ec04f83165dd9685d5d111b98827cff9331e964a43ecfa0c47a8cc07ab` |

All eight hosted jobs passed. The browser job passed **24 real Django journeys** and **72 mocked UI journeys** across four targets. Backend checks passed **398 PostgreSQL tests**, full mypy (155 source files), Ruff/format (126 files), Django checks and migration consistency. Hosted coverage was **95.90% lines**, **87.72% branches**, **94.45% combined**. The frontend passed **600 tests**, coverage, lint, TypeScript and production build. The new complete journey also passed three local browser targets. Independent application and deployment review found no remaining blockers.

The initial preliminary candidate was cancelled before installation to include the new PostgreSQL race-test file. The final source/run above includes it. Two early local browser attempts found test-locator issues; corrected selectors passed the full journey. No failed or preliminary candidate was installed.

Archive checksum, pinned OpenSSL signature, exact source/tag/UI metadata and all eight helper bytes were checked locally. GitHub attestation verification required the exact workflow/ref, source and signer digest, hosted runner and run38580786281. The signed staging-only manifest blocks production installation.

## Staging cutover and preservation

Every SSH session used the pinned FlexSchools connector. Exclusive uploads were checksum-verified before the trusted root snapshot helper copied them under the release lock. Staging writers were frozen, an encrypted PostgreSQL backup was checked, and no-seed preparation applied only `accounts.0008_organization_scoped_email`.

The migration preserved all fields of **17 Users** and **6 Invitations**. All **40 prior migration ledger rows** were unchanged; the ledger gained exactly accounts0008 for **41 rows**. The original requested account's complete credential/MFA/role/organization projection was identical before and after migration.

Only the three authenticated lifecycle controls changed: release-target-policy, lifecycle-state and process-start guard. Their signed `organizationScopedIdentity=true` floor was persisted before schema preparation. The other five controls, both earlier floors, no-seed preparation unit, disabled System Admin mutation flag, production symlinks/processes, Nginx configuration/PID and unrelated FlexSchools service remained unchanged. A legacy global-email backend is blocked after this cutover; recovery requires a compatible signed release rather than reverse migration or routine database restoration.

- Encrypted backup: `/var/lib/vessel-caller/ui-backups/v0.2.5-staging.20261014T1430/staging.dump.age`, **483148 bytes**.
- Ciphertext SHA-256: `7462da5bea97bc6bd4f3e8f0d125afea1426167e28b83abb6affea66855b0ebd`.
- Staging web/worker PIDs: **172528 / 172506**, active.
- Backend and frontend use the T1430 release. Public HTTPS readiness and UI metadata match the signed artifact; the wrapper compared every served frontend file with its signed bytes.

Signature/provenance proof, CI logs, masked creation screenshot, backup aggregates, cutover log, HTTPS metadata and post-deployment checks are stored locally under `/Users/gbolahan.salami/.codex/preview/vessel-agency-ui/releases/v0.2.5-staging.20261014T1430/`. No plaintext credential is saved in this evidence.

## Actual account creation

After deployment validation, the authenticated tenant Admin session created the requested **Admin** using the exact original email and selected **Replace pending invitation**. The success panel showed Digicomme, the scoped sign-in URL and generated temporary password; **Copy sign-in details** confirmed success. The panel was left open with the password visible for the requester. The saved proof image masks the credential.

Read-only verification confirms the new account has mandatory first password change, honest Admin provenance, no platform privileges and the expected seven-day expiry. Its pending invitation is revoked. The existing account's entire field projection remains identical to the pre-cutover snapshot, and no alias was created. There are now **18 Users**, with two independent organization accounts for the requested email.

The recipient's permanent password choice, MFA enrollment and first workspace session are not claimed as completed. Email-delivery investigation remains paused. Voyage reconciliation, agency directory and invoice previews retain their browser-saved UI scope; this release does not add durable guest/PDF persistence, accounting issuance/payment verification or a durable NPA reconciliation audit trail. The later evidence-only commit is not the deployed application source.
