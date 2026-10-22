# Temporary-password users — staging release, 13 October 2026

## Delivered behavior

Tenant Admins can use **User Management → Add user → Temporary password** to create a colleague in their existing organization with a selected Admin, Operations, Finance or Viewer role. A strong generated password is returned once, masked initially, for the Admin to share directly. It expires after seven days. First sign-in returns only a five-minute password-change capability; the recipient must choose a different valid password before a normal workspace session or role access is available. Existing MFA requirements apply after replacement. No credential email is sent and Admin provisioning does not falsely mark an email as verified.

Admins can regenerate a temporary password only for their own organization's pending accounts. Regeneration invalidates previous credentials, password-change/MFA capabilities and sessions. Activated accounts retain the existing password-reset flow. Existing email invitations and approved organization sign-up remain available.

Plaintext credentials are held only in the one-time response and ephemeral component state. They are excluded from query caches, browser persistence, URLs, audit payloads and diagnostic request/frame data. Capability and credential responses use `Cache-Control: no-store`.

## Verified release identity

| Item | Value |
| --- | --- |
| Signed staging candidate | `v0.2.3-staging.20261013T1019` |
| Deployed source | `b31124085b43edfae6eec5462f394079b2a7ecda` |
| CI run | [38382786142](https://github.com/gbollyjay825/vessel_caller/actions/runs/38382786142) |
| Candidate artifact | `11804103058` |
| Archive SHA-256 | `04cbd8c7993667be8d139f28e0e971f55b262725e44a52808ce59c42b47c39fd` |
| Signature-file SHA-256 | `8061d175686ee29996a3c27dce40d202d4c6239246d69c959094aa7742d9ef36` |
| Trusted public-key SHA-256 | `677e097fb8a4e01df2de2b46c41399162e597b442fb998640a8dbeb75ef6b2ce` |
| Reviewed deployment wrapper SHA-256 | `1d5fc088b0863b832c0487730e8bb71ee8bb3bfef48babaf8cc7c0156b80152e` |

The archive checksum and OpenSSL signature were verified against the pinned staging public key. GitHub attestation verification required the repository release workflow, exact source digest/ref and no self-hosted runners; its invocation matched run 38382786142. The signed manifest contains `organizationApprovalLifecycle: true`, `temporaryPasswordLifecycle: true` and `stagingOnlySchemaCutover: true`. It blocks production installation. Frontend metadata reports the same source/tag and `frontend-and-backend` scope with a same-origin API.

All eight hosted jobs passed: backend, frontend, infrastructure, browser, dependency/static security scan, both CodeQL languages and signed packaging. Hosted browser validation ran **20 real Django** and **72 mocked** journeys across four browser targets; the new temporary-password journey ran rather than being skipped. The isolated E2E database guard was corrected in b311240 before this final candidate was produced.

Local validation passed **329 PostgreSQL tests**, including real concurrency races, with **94.57% branch coverage**; Ruff, formatting, mypy, Django and migration drift checks passed. **580 frontend tests** passed with coverage, lint, TypeScript and a production build. The complete create → regenerate → temporary sign-in → mandatory replacement → Viewer session/reload/denied Admin access journey passed locally on Chromium, WebKit and mobile Chromium. Firefox ran successfully in hosted CI; the local macOS Firefox runtime could not launch.

## Staging installation and preservation checks

SSH operations used the mandatory pinned `flexschools-droplet-ssh` connector. The first preflight rejected root-owned uploaded inputs because the trusted snapshot helper requires the deploy account as their owner. This happened before backup, writer freeze, migration or application changes. Each input's exact bytes and regular-file identity were checked, ownership was corrected to the expected deploy account, and the unchanged reviewed wrapper succeeded on retry.

The wrapper acquired the release lock, verified installed control/config/PID pins, authenticated root-owned release snapshots, froze staging writers and created a consistent PostgreSQL dump using the digest-pinned PostgreSQL 18.6 client. The dump catalog was checked before encrypting the backup; plaintext dump and temporary database connection files were removed. Preparation ran **without seeding**.

- Encrypted backup: `/var/lib/vessel-caller/ui-backups/v0.2.3-staging.20261013T1019/staging.dump.age`, **480672 bytes**.
- Ciphertext SHA-256: `ea9c5ea8dfbeae37f1487c798cb11e214264cc0f0696969a71d4a26da96bf6f3`.
- **17 existing users preserved**. Their original field projection was identical before/after migration; aggregate SHA-256: `d9ad7028570d22f49e5a608afcaae3cf32f84e4186dcd6ff8a19d9f786115465`.
- Additive accounts migration `0007_user_admin_provisioned_at_user_admin_provisioned_by_and_more` was verified in the migration ledger. Existing users have `password_change_required=false`, with expiry/provisioning timestamp/provisioning actor all null.
- Backend target: `/opt/vessel-caller/releases/v0.2.3-staging.20261013T1019/staging`.
- Frontend target: `/opt/vessel-caller/releases/v0.2.3-staging.20261013T1019/staging/frontend/dist`.
- Staging web and worker are active; post-deploy PIDs are 152609 and 152591.
- HTTPS `/api/readiness` reports ready, database/cache true, exact b311240/T1019 identity and `temporaryPasswordLifecycle: true`.
- HTTPS `/ui-release.json` matches the installed candidate. Every served frontend file was compared byte-for-byte with the signed package.

Three reviewed host controls were installed root-owned mode 0755 from authenticated archive bytes:

| Control | SHA-256 |
| --- | --- |
| `staging-lifecycle-state.sh` | `b7fc8c19fcf062952b45eca600b817f0fb4d80c12373d9f1622f6e7409c7d808` |
| `release-target-policy.sh` | `2eeda9294ff143672936b2980f0be903186397678ae7ed9d72d82123f4d5eb94` |
| `staging-compatibility-guard.sh` | `b09b92f941edf7ea81cab7cae5a8c70c589b7b4cfa706d9bef98da8b953810c2` |

The root-owned mode 0644 marker `/var/lib/vessel-caller/staging-temporary-password-lifecycle.cutover` was persisted before migration with `temporaryPasswordLifecycle=true`. The migration ledger reconstructs the compatibility floor on host replacement. The previous backend cannot be restarted against pending temporary-password accounts. Recovery must use a compatible signed release; no reverse migration, database restoration or automatic legacy writer rollback was performed.

The no-seed prepare unit SHA-256 remains `bfa86a47dc60fddffe14faad7d980c43025b1464dd47f77c4f1d4d170e62eab4`. Nginx was validated without reloading. Its PID/configurations and the production symlink/processes remained unchanged: Nginx 18608; production web 18566/18567, production-blue worker 18568, production-green worker inactive. Outside HTTPS production readiness remains healthy at v0.1.9 / `c9cb5c7ca7d0015f967b3e7146c8c737f55ce69a`. [FlexSchools](https://flexschools.ng/) returned HTTPS 200.

## Live browser acceptance and limits

The original signed-in staging Admin session survived the deployment. Reloading User Management displayed the current NPA crest/name/title and **Add user**. Opening the blank drawer confirmed **Temporary password** selected by default, the existing **Email invitation** alternative, Full name/Email/Role inputs, all four roles, generation/expiry guidance and a disabled **Create user** action until required details are supplied. A cropped screenshot of the blank drawer was saved outside Git as `staging-add-user-temporary-password-20261013.png` in the local release evidence directory; it contains no credentials or recipient contact data.

No actual staging user was created, no real password was entered or changed, and no invitation or verification email was sent during this release. Complete account acceptance was tested against isolated PostgreSQL locally and in CI; the live staging observation covers the existing Admin session and blank creation form. The user's separate email acceptance test remains paused; prior provider acceptance did not prove inbox receipt or recipient acceptance.

The existing voyage product boundaries remain: reconciliation and invoice previews are browser-saved UI data. This release does not add durable guest readings/PDF persistence, accounting invoice issuance/payment verification or production publication.

Local detailed logs, attestation proof, HTTPS metadata, host audit and screenshot are under `/Users/gbolahan.salami/.codex/preview/vessel-agency-ui/releases/v0.2.3-staging.20261013T1019/`. The evidence-only commit after deployment is not the deployed application source.
