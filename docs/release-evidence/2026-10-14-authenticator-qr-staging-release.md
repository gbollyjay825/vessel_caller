# Guided authenticator setup — staging UI release, 14 October 2026

New customers replacing a generated temporary password now go directly to a focused authenticator guide. They confirm their new password, scan an inline QR code or use the manual-key/same-device alternative, verify a six-digit TOTP code, save their recovery codes and then continue to the workspace. Existing enrolled accounts keep their normal MFA challenge. The guide works during the existing enrollment grace period without changing server policy.

QRs use the exact backend provisioning URI and are generated locally with pinned `qrcode.react` 4.2.0. Passwords, setup seeds and recovery codes remain in component memory, outside shared query/mutation caches and browser persistence. Failed verification is retryable; failed session refresh preserves recovery codes and retries refresh without reenrollment. Successful confirmation does not navigate away before acknowledgment. Focus follows the scan/recovery headings.

## Validation and source

- Application source: `8e50672dd0608d77de76a0aa6657eaa1a048a270`.
- Signed candidate: `v0.2.6-staging.20261014T1612`; all eight jobs in [run 38595927517](https://github.com/gbollyjay825/vessel_caller/actions/runs/38595927517) passed.
- Hosted browser suites: **24 real Django journeys** and **72 mocked journeys** across Chromium, Firefox, WebKit and mobile.
- Local checks: **611 frontend tests**, coverage (92.43% lines, 84.75% branches), TypeScript, lint, production build and 13 focused AccountSecurity tests passed. Six real Django journeys passed on Chromium, WebKit and mobile; 30 mocked auth journeys passed on those targets. Local Firefox launch stalled and was stopped; hosted Linux Firefox passed.
- macOS Vision independently decoded the rendered demo QR to the exact expected provisioning URI. The real Django journey independently generated TOTP and verified MFA enablement, recovery-code acknowledgment and absence of secrets from browser storage.
- An early local run overlapped live component edits and was superseded by the passing rerun. One preliminary hosted run was cancelled for the alignment fix; the next caught eight stale recovery-copy assertions. Both assertions were updated before the final passing release. Neither preliminary package was deployed.

## Artifact and deployment

- CI artifact: `11909179499`.
- Signed archive SHA-256: `416e67505ba2de82fee0c21c43246d32ea657660d6fe2bc1c77b125bfb77bea0`.
- Signature-file SHA-256: `86bf9dc4f5d800bef3504d683ab44db89dd91674b87c36f0a7a27e99847fab23`.
- Existing verification-key SHA-256: `677e097fb8a4e01df2de2b46c41399162e597b442fb998640a8dbeb75ef6b2ce`.
- Local OpenSSL verification and GitHub hosted attestation matched the exact workflow, branch ref, source/signer digests and run 38595927517 attempt 1.

The full 47 MB SSH upload timed out; the partial input was retained and no deployment wrapper ran. A frontend transfer of 534,968 bytes was then constructed from the locally verified signed archive. Every selected original source-file digest is embedded in the reviewed root wrapper, along with the transfer bundle digest; the server validates the exact file set and each digest. This keeps the original signed frontend bytes unchanged while avoiding transfer of unrelated backend/wheelhouse data.

- Transfer SHA-256: `bb52b79883616211fd8c90c6bb376082a0f402770059602ef2c3b92756449d2f`.
- Compact wrapper SHA-256: `6d0ec250afdc63bf861aa281bed53ea3a9d44a8f7fb229f3b0cdbd329b0e8f28`.
- Finalization wrapper SHA-256: `25afbc14314d9fe51d16e874203945d2c57107ea129552de8baec1355bf171ef`.
- Active static root: `/opt/vessel-caller/frontend-releases/staging/v0.2.6-staging.20261014T1612-authenticator-qr/dist`.
- Rollback static root: `/opt/vessel-caller/releases/v0.2.5-staging.20261014T1430/staging/frontend/dist`.

The first compact switch verified all 14 public staging files, then an unrelated DNS health-check timeout triggered its conditional rollback. The old static target was confirmed restored. Finalization revalidated all 14 candidate files against their signed-source digests, reused the release lock and runtime/config/floor guards, and switched only the static symlink. All 14 files again matched through normal public staging HTTPS. Preserved co-hosted origins were checked using certificate-validated localhost HTTPS, without disabling TLS verification or changing DNS. Production public readiness was independently healthy; public FlexSchools DNS lookup was unavailable during the check while its unchanged origin returned 200.

Backend remains `v0.2.5-staging.20261014T1430` / `f1088a60ab64aa891d78d8bca3ed61f40ae27074`; web 172528, worker 172506 and Nginx 18608 remain active. Production targets/PIDs, Nginx configuration, eight installed controls, three compatibility floors, no-seed preparation unit and disabled System Admin mutation flag remain unchanged. No backend/schema/account/MFA setting or service restart/reload was performed. All SSH sessions used the pinned FlexSchools connector.

A separate public HTTPS check confirmed the served metadata, index, JavaScript and CSS against the signed-source digests, and backend readiness remained healthy. The live staging guide was also inspected in the owner’s authenticated account: its existing authenticator was correctly recognized, with a Continue to workspace action. This did not change the account’s MFA settings.

Local evidence, signed archive/attestation, exact transfer digests, reviewed wrappers, hosted browser log, public verification and final deployment receipt are under `/Users/gbolahan.salami/.codex/preview/vessel-agency-ui/releases/v0.2.6-staging.20261014T1612/`. Screenshots use public demo setup data, not a real user's MFA seed. Recipient password choice and actual MFA enrollment remain the recipient's actions; no recipient credentials were changed or enrolled during release verification.
