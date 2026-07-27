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
| Staging | Vercel static SPA; Droplet Django/Celery/Redis; separate managed DB, bucket, and Resend allow-list | Same signed release artifact | Engineering |
| Production | Managed DB with PITR, private Spaces, production Resend/Sentry | Same qualified artifact | Manual protected-environment approval |

Configure GitHub `staging` and `production` environments. Production must have
required reviewers, prevent self-review, restrict deployment to signed `v*`
tags, and contain only the restricted `vessel-deploy` SSH key. Never store the
root Droplet key in GitHub.

The staging environment also requires:

- `VERCEL_TOKEN`: token scoped to the dedicated staging project/team
- `VERCEL_ORG_ID`: staging project organization identifier
- `VERCEL_PROJECT_ID`: dedicated staging project identifier
- `VERCEL_AUTOMATION_BYPASS_SECRET`: deployment-protection automation secret
- `LOAD_TEST_COOKIE`: short-lived, staging-only Viewer session created for the
  approved capacity window and revoked immediately afterward

The Vercel project serves only a Preview deployment of the prebuilt React assets extracted from the
qualified release. Its same-origin `/api` route proxies to
`https://staging-api.vesselcalls.com`; Django, Celery, Redis, and PostgreSQL do
not run on Vercel. The project must have deployment protection, a stable
`staging.vesselcalls.com` domain, no production credentials/data, and no
browser local-storage fallback. CI uses the pinned Vercel CLI with
`--prebuilt --target=preview`, aliases the qualified deployment to the stable
staging domain, and reruns Playwright against the protected deployed URL.
The 50-user capacity workflow and OWASP ZAP baseline run only against protected
staging; neither receives production credentials or data.

Required environment secrets:

- `DROPLET_HOST`: Droplet hostname/IP
- `DROPLET_HOST_KEY`: complete pinned `known_hosts` entry
- `DROPLET_DEPLOY_SSH_KEY`: restricted deployment-user key

The repository release workflow builds and attests the immutable archive, then
creates an unpublished draft release. It never receives an archive-signing
private key. A trusted macOS operator finalizes the draft with
`python -m scripts.finalize_release`; that command reads the approved OpenSSH
Ed25519 private key directly from macOS Keychain service
`vessel-caller-release-signing-key`, account `gbolahan-salami`, signs in memory,
uploads only the detached signature, and publishes the release after local
verification. The Keychain password is the strict single-line base64 encoding
of the OpenSSH private key; the finalizer decodes it only in memory.

The matching non-secret repository variable `RELEASE_SIGNING_PUBLIC_KEY`
contains the OpenSSH public key and is also pinned by Ansible at
`/etc/vessel-caller/release-signing-public.pem`. Existing RSA/ECDSA PEM
signatures remain verifiable during a controlled dual-key rotation. Never copy
the Keychain private key into GitHub, a shell variable, a temporary file, or
the repository.

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
4. Promote the signed candidate backend to the isolated Droplet staging service
   and the exact frontend build to the protected Vercel staging project; run migration
   reconciliation, browser UAT, restore, rollback, load, and alert drills.
5. Produce and verify complete signed production-qualification evidence, then
   approve the protected production environment.
6. Install into the inactive slot, run migrations/checks/readiness, switch only
   the Vessel Caller Nginx upstream, and verify FlexSchools.
7. Observe for 30 minutes before completing the change. Retain the compatible
   previous slot for seven days.

No workflow deletes the Vercel project or retires FastAPI automatically.
Post-hypercare removes Vercel production/demo usage while retaining the
credential-isolated staging project.
