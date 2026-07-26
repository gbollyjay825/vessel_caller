# ADR 0003: Immutable blue-green releases on the shared Droplet

- Status: Accepted
- Date: 2026-07-26

## Decision

CI builds one checksummed release containing source, frontend assets, offline
Python wheels, manifest, and SBOM. The same artifact is qualified in staging
and promoted to production. Production uses loopback blue/green services and an
atomic Nginx upstream include; only the Vessel Caller site is changed.

## Consequences

The Droplet performs no package downloads or source builds. Releases require a
signed semantic tag and protected production approval. Database migrations
must use expand/contract compatibility while both slots are retained. Nginx is
validated before reload, and FlexSchools is probed before and after promotion.
