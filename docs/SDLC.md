# Software delivery lifecycle

## Branch and change policy

- `main` is the only integration and release branch.
- Changes use short-lived `codex/*` or feature branches and pull requests.
- Require CODEOWNERS approval, up-to-date branches, resolved conversations,
  signed commits where supported, and all required checks.
- Prohibit force pushes, branch deletion, direct pushes, and administrator
  bypass on `main`.
- One pull request owns one backlog story. Database contract or initial
  migration changes require the backend owner.
- Security vulnerabilities are reported through a private GitHub advisory.

Required checks:

1. Backend CI
2. Frontend CI
3. Browser and Accessibility Tests
4. Infrastructure CI
5. Security and Supply Chain

## Environments

| Environment | Data/services | Deployment | Approval |
|---|---|---|---|
| Local | Compose PostgreSQL/Redis; sandbox integrations | Developer machine | None |
| CI | Ephemeral PostgreSQL/Redis; no production credentials | Every PR/push | Automated |
| Staging | Droplet Nginx SPA plus Django/Celery/Redis; separate managed DB, bucket, and Resend allow-list | Same signed release artifact | Engineering |
| Production | Managed DB with PITR, private Spaces, production Resend/Sentry | Same qualified artifact | Manual protected-environment approval |

Configure GitHub `staging` and `production` environments. Production must have
required reviewers, prevent self-review, restrict deployment to signed `v*`
tags, and contain only the restricted `vessel-deploy` SSH key. Never store the
root Droplet key in GitHub.

The staging environment requires `STAGING_E2E_PASSWORD` and `LOAD_TEST_COOKIE`.
The latter is a short-lived, staging-only Viewer session created for the
  approved capacity window and revoked immediately afterward

Nginx on the Droplet serves the prebuilt React assets from the signed release
at `staging.vesselcalls.com` and proxies same-origin `/api` to the isolated
staging Django service. No Vercel token, project, proxy, or runtime is used.
The 50-user capacity workflow and OWASP ZAP baseline run only against protected
staging; neither receives production credentials or data.

Required environment secrets:

- `DROPLET_HOST`: Droplet hostname/IP
- `DROPLET_HOST_KEY`: complete pinned `known_hosts` entry
- `DROPLET_DEPLOY_SSH_KEY`: restricted deployment-user key

The repository release workflow additionally requires
`RELEASE_SIGNING_PRIVATE_KEY`, a dedicated RSA/ECDSA PEM key used only to sign
release archives. The matching non-secret repository variable
`RELEASE_SIGNING_PUBLIC_KEY` verifies the CI output, and the same public key is
pinned by Ansible at
`/etc/vessel-caller/release-signing-public.pem`. It is not the SSH key. Rotate
it through a dual-key release/change procedure before revoking the old key.

Runtime application and backup secrets remain in root-owned files under
`/etc/vessel-caller`; they are provisioned through Ansible Vault, not GitHub.

A missing provider credential makes its gate `Deferred`, never `Pass`,
`Qualified`, or `Skipped`. Console/memory email, local filesystem or S3 mocks,
mocked browser responses, seeded UI state, and synthetic localhost checks do
not satisfy provider gates. Production approval remains unavailable until
root-owned production runtime credentials pass non-mutating authentication
checks and the signed qualification artifact contains every mandatory
real-provider gate listed in
`runbooks/post-credential-release-checklist.md`.

## Definition of done

- Acceptance criteria and documentation are current.
- Backend coverage is at least 90% line and 85% branch.
- Frontend coverage is at least 80% line and branch, with full critical-path
  user management, RBAC, invoice, migration, and security journeys.
- PostgreSQL integration/concurrency, Playwright browser/mobile, and WCAG 2.2
  AA checks pass.
- No high/critical dependency, SAST, secret, or filesystem findings exist.
- Moderate findings have a named owner, expiry, compensating control, and
  written approval.
- Migrations are forward-compatible with the active release and rollback plan.
- OpenAPI drift, `check --deploy`, migration drift, SBOM, provenance, backup,
  monitoring, and FlexSchools regression gates pass.
- The exact staging artifact is promoted; nothing is rebuilt on the Droplet.

## Release policy

1. Merge qualified changes into `main`.
2. Create an annotated, cryptographically signed semantic tag.
   GitHub immutable releases are enabled, so published release tags and assets
   cannot be altered in place.
3. The release workflow re-runs all gates and creates a signed/checksummed
   archive, offline wheelhouse, release manifest, SBOM, and provenance
   attestation. The Droplet refuses archives that do not verify against its
   independently pinned release public key.
4. Promote the signed candidate backend and exact frontend build to the isolated
   Droplet staging slot; run migration
   reconciliation, browser UAT, restore, rollback, load, and alert drills.
5. Produce and verify complete signed production-qualification evidence, then
   approve the protected production environment.
6. Install into the inactive slot, run migrations/checks/readiness, switch only
   the Vessel Caller Nginx upstream, and verify FlexSchools.
7. Observe for 30 minutes before completing the change. Retain the compatible
   previous slot for seven days.

No workflow deletes the legacy Vercel project or retires FastAPI automatically.
