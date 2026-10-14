# Signed staging candidates

The existing Build Immutable Release workflow can package its exact workflow
commit with `staging_candidate=true` and a `vMAJOR.MINOR.PATCH-staging.*`
artifact name. This is a staging candidate, not a published verified release
tag or production qualification. All five existing backend, frontend, browser,
infrastructure and security jobs must pass before packaging. Each job and the
package checkout use the same `github.sha`.

The local annotated tag only satisfies the deterministic builder's input
contract; it is never pushed. The archive is signed with the existing protected
release key, independently verified against the unchanged public pin, and
attested to the workflow commit. Candidate output is retained as a GitHub
Actions artifact. The official release path still requires a GitHub-verified
signed tag and publishes the release only when candidate mode is false.

The signed manifest includes `stagingOnlySchemaCutover=true`, so the production
target policy rejects it. Deploy only after verifying the expected workflow
commit, downloaded artifact checksums, attestation and pinned signature. Hold
the release lock, stop staging web/worker together, validate an encrypted backup
of the staging database, and use the existing compatibility/writer guards and
signed installer. Do not reset fixtures during preparation: migration and
static collection are sufficient for an existing staging environment.

When the separate frontend overlay is active, deliberately advance its symlink
to the candidate's built frontend after backend readiness passes. Verify the
public `/ui-release.json`, assets and API readiness match the candidate. For an
additive migration, retain added tables when returning to a compatible previous
release; do not reverse migrations or replace the database as routine rollback.

The `accounts.0008_organization_scoped_email` migration removes global email
uniqueness while retaining a case-insensitive email constraint within each
organization. Its signed capability is `organizationScopedIdentity=true`.
Before applying it, install the reviewed lifecycle-state, target-policy and
process-start guard changes, stop staging writers, and persist the
`staging-organization-scoped-identity.cutover` marker. Both the migration ledger
and the root-owned marker block releases that assume one global account per
email. A failed cutover must stay closed until a compatible signed release is
ready; do not return to a previous global-email backend or reverse the schema
after organization-specific accounts exist. Keep the other lifecycle floors,
production blocks, signature pins, no-seed preparation and encrypted backup.

Existing User and Invitation field projections must be identical before and
after schema preparation. The migration ledger gains only accounts0008. Account
creation is a separate, authenticated Admin action after deployment validation;
never provision credentials in a release wrapper or use database access to
impersonate the Admin.
