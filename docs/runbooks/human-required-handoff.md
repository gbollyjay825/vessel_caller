# Vessel Caller human-required handoff

This page lists only inputs that require the account owner, credential custodian,
business approver, or another named person. Codex continues all other safe
release-readiness work without waiting for instructions. None of the items below
may be replaced with guessed credentials, mock providers, weakened controls, or
an unrecorded approval.

## 1. Name a trusted GitHub reviewer

**Minimal action:** add one trusted person as a collaborator on
`gbollyjay825/vessel_caller`, then provide their GitHub username. They must be
allowed to review CODEOWNERS changes and protected staging/production
deployments.

**Why a person is required:** the repository currently has only one human
administrator. Enforcing approval with no second reviewer would lock the
repository or force an administrator-bypass exception.

**Codex will then:** configure `main` and signed `v*` protection, require the
documented checks and CODEOWNERS approval, disable administrator bypass, add the
reviewer to protected environments, and verify that a test pull request cannot
bypass the policy.

## 2. Create the Resend account and sender identities

**Minimal action:** create the Resend account, choose the staging and production
sender addresses, and authorize the required verified domain. Create separate
least-privilege staging and production API keys plus a staging qualification
recipient.

**Why a person is required:** account ownership, sender identity, domain
authorization, billing/terms, and API-key issuance belong to the business owner.

**Codex will then:** add any supplied DNS verification records, place each key in
its correct protected runtime/qualification store without printing it, configure
the staging allow-list, and qualify real verification, invitation, recovery,
email-change, security-notice, retry, and idempotency flows.

## 3. Create the Sentry organization and projects

**Minimal action:** create or select the Sentry organization, create isolated
staging and production projects, and issue separate DSNs plus a scoped
qualification API token.

**Why a person is required:** organization ownership, plan acceptance,
notification recipients, and credential issuance cannot be assumed by an
automation agent.

**Codex will then:** store the DSNs/token in the correct protected locations,
configure release/environment metadata and redaction, send real frontend and
backend test events, and verify alert routing without exposing application data.

## 4. Approve DigitalOcean Spaces billing and token issuance

**Minimal action:** approve the DigitalOcean Spaces charge in the **Flex School**
team and create or authorize creation of a scoped DigitalOcean API token.

**Why a person is required:** the first Space activates a paid service, and only
the account owner should approve billing and provider-token issuance.

**Codex will then:** create separate private staging application and backup
buckets, enable versioning/lifecycle controls, issue least-privilege keys,
configure encrypted off-host backups, and verify public-access denial,
authorization, checksums, retention, and restore behavior.

## 5. Approve protected Vercel staging and issue its token

**Minimal action:** approve the Vercel plan/add-on needed to protect the
`staging.vesselcalls.com` custom domain, then create a deployment token limited
to the team that owns `vessel-caller-staging` and make it available for
protected GitHub secret entry. Do not send it in chat or commit it to the
repository.

**Why a person is required:** the project currently has Standard Vercel
Authentication, which excludes custom domains; protecting all deployments is a
paid-plan/add-on decision. The CI token is also a durable account credential
that must be issued and revocable by the Vercel account owner.

**Codex will then:** enable protection for the already-created dedicated
project and verified domain, configure the automation bypass and proxy secret,
store the token in the protected GitHub environment, and deploy only the signed
prebuilt staging artifact. Git autodeploy remains disabled.

## 6. Establish signing-key custody

**Minimal action:** nominate the secure offline/password-manager location and
the people responsible for the release, qualification, and independent operator
signing private keys. Provide the corresponding public keys or explicitly
authorize generation directly into that custody system. Also configure a
GitHub-verifiable signing identity for annotated `v*` tags.

**Why a person is required:** an agent must not invent ownership of long-lived
release authority or retain the sole copy of private signing material.

**Codex will then:** pin only the public keys in GitHub and on the Droplet, place
CI private keys in write-only protected secrets where approved, verify a signed
test artifact/tag, and record the rotation and dual-key procedure.

## 7. Provide the operational alert destination

**Minimal action:** create the on-call webhook/alert endpoint, choose its human
recipients and escalation policy, and provide the protected endpoint value.

**Why a person is required:** only the operator can choose who receives
incidents and authorize messages into the organization’s on-call system.

**Codex will then:** store the endpoint as a protected secret, configure
health/error/backup/certificate/authentication alerts, fire a controlled test,
and record acknowledgement evidence.

## 8. Complete business UAT

**Minimal action:** after Codex presents the reachable Django release, complete
the named business UAT journeys and confirm the results for that exact signed
tag.

**Why a person is required:** business acceptance, financial/workflow
correctness, and production risk acceptance are accountable human decisions.

**Codex will then:** attach UAT evidence to the qualification record and finish
the documented observation and hypercare evidence. The product owner's explicit
production-cutover authorization for the current Django release is already
recorded and will not be requested again.

Technical credential names and the evidence required after these inputs are
listed in
[`post-credential-release-checklist.md`](post-credential-release-checklist.md).
