# Import voyage declarations and agency readings

This iteration stops at collecting independent agency reports. The owner’s declaration belongs to a specific voyage; it is separate from every agency’s measurement. The vessel-grouped voyage log retains earlier trips and their individual records.

## Linear input flow

1. **Setup vessel.** Select the vessel and its recorded voyage. Users permitted to register calls can open **Register vessel / voyage** in a separate tab. Optional berth, schedule and survey lead details stay collapsed. The lead defaults to “To be assigned.” Changing an edited voyage requires confirmation before clearing its declaration.
2. **Owner declaration.** Choose the cargo type, enter the owner’s reference and copy quantities into the paper’s matching categories. Container presets use 20, 40 and 45 ft, each laden/empty. Vehicle presets include Cars, Buses, Trucks and Mafi Trailer / HDV. Tanker items identify the cargo/product, including petroleum, chemicals or gas. Mixed cargo preserves separate items and units. Blank is unknown; 0 is an explicit NIL declaration.
3. **Agencies.** Select reusable directory entries or create an agency inline. Confirm its attending representative, then **Create voyage sheet**. There is no separate review/scheduling step. A compact review disclosure is optional.
4. **Report vessel load.** Each selected agency has its own card, submission status and quantities. Staff can open the chosen agency’s reading form. Owner quantities remain in a separate declaration disclosure. The default screen has no reconciliation or disparity billing actions.

Agency setup remains at **Settings → Agency setup**. It is browser-local and organization-scoped, not a shared backend directory. Saved agency snapshots on existing voyage sheets retain the names and representatives copied at creation. The vessel selector groups existing calls by name and flag; it does not create a persistent vessel registry.

## No-login agency form: frontend prepared for review

When a server supports agency links, staff can generate an agency-specific link with an expiry, copy it and revoke unused links. This UI does not send messages. The public `/agency-reading` route sits outside the staff login flow. It removes the token fragment before its first network request and exchanges it through a separate guest adapter. Only a non-secret context ID stays in the address.

The agency is fixed to the form. It enters its representative, observation time, source reference and every applicable quantity. Explicit NIL is 0; blank is unknown and cannot be submitted; N/A requires an explanation. Owner quantities are omitted from guest entry to preserve independent measurements.

After submission, the form shows the submitted record, **Download your PDF** and completed peer quantities from this same measurement sheet. Peer readings are hidden until the agency submits. Peer summaries omit representatives, source references, notes and evidence. The PDF action is restricted to the agency’s own report. A lost submission response first refreshes the same context; an identical retry preserves its request ID. A different context never silently replaces it.

These frontend protections are not security enforcement. The backend endpoints, token validation, guest session authorization, idempotent publication, durable report storage and PDF generation are not implemented in this UI-only change. The review server uses isolated in-memory demo records and labels the interaction as a preview. No real agency access is granted. On existing servers that lack the link endpoints, link and PDF controls are hidden and the public route reports the feature unavailable.

## Prepared endpoint contract

The staff adapter expects:

- `GET /api/measurement-plans/{planId}/agency-links`
- `POST /api/measurement-plans/{planId}/participants/{participantId}/agency-links` with `expiryDays`, returning link metadata and its URL once
- `POST /api/measurement-plans/{planId}/agency-links/{linkId}/revoke`
- `GET /api/measurement-plans/{planId}/submissions/{submissionId}/receipt`

The guest adapter expects:

- `GET /api/agency-portal/csrf` → `csrfToken`
- `POST /api/agency-portal/exchange` with `token` → `contextId`
- `GET /api/agency-portal/context?contextId=...` → `context`
- `POST /api/agency-portal/submission` with context ID, input fingerprint, request ID and guest readings → confirmed `context`
- `GET /api/agency-portal/receipt?contextId=...` → `application/pdf`

The server must derive the organization, plan, agency and external actor from the grant and session, validate revocation/expiry/plan state at publication, and return only authorized completed peer quantities after the agency’s own publication. It must bind the guest session to the requested context, preserve idempotent receipts, avoid recording an external submission as the staff link issuer, and freeze receipt data. These are future backend requirements, not implemented capabilities.

## Existing records and verification

Historical reconciliation records remain accessible through a secondary link; the previous workspace uses `?workspace=reconciliation`. Existing reconciliation, assessment and billing behavior is retained for regression coverage. Count, tonnes and m3 are never added into a cargo total.

Validation covers the linear setup, inline agency failures, selected agency and version handling, cancellation/permission changes, token removal, ambiguous submission retries, own PDF download, post-submission peer visibility and mobile layouts. Browser guest journeys use API mocks. Existing real-backend regression tests do not establish a working secure-link backend. No schema, permission, billing, infrastructure or staging changes are included.
