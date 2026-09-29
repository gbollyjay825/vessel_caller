# Cargo measurement and reconciliation

Implementation status, 29 September 2026: implemented and verified locally against
PostgreSQL. Staging deployment and operator acceptance must be recorded separately;
this document does not certify a staging or production release.

## Supported scope

A measurement plan belongs to a vessel call and defines one cargo scope, stage,
method, schedule, lead surveyor, participating parties and cargo lines. Lines retain
their cargo category, import/export direction, container size and load status where
applicable. Supported quantity units are `tonnes`, whole-number `count`, and `m3`.
There is no automatic conversion, stakeholder averaging or summation of overlapping
observations. Ship NRT/GRT, cargo mass, volume and container counts are distinct.

The first release provides staff-entered returns and acknowledgements backed by
uploaded paper evidence. It does not provide an external stakeholder portal,
authenticated electronic stakeholder signatures, automatic OCR, measurement hardware
integration, automatic waivers, or an offline queue for this new workflow. The
existing inspection queue does not make measurement finalization or billing offline.

Legacy inspections and harbour-dues invoices remain available. Measurement
finalization does not close the vessel call or recalculate existing harbour dues.

## Roles

| Action | Permission | Authorized roles |
|---|---|---|
| Read plans, returns, reconciliation sheets and evidence | `measurements.view` | Admin, Operations, Finance, Viewer |
| Plan measurements, record returns, propose reconciliations and record paper acknowledgements | `measurements.manage` | Admin, Operations |
| Finalize a reconciliation | `measurements.approve` | Admin, other than that proposal's preparer |
| Assess disparity and issue its invoice | `measurements.bill` | Admin, Finance |

All access is scoped to the user's customer organization. Suspended organizations
cannot read or mutate measurement records or obtain new signed evidence links.
Already-issued storage links retain their short expiry. The backend enforces role,
organization and version checks even if a client displays an obsolete action.

## Operator workflow

1. From a vessel call or Measurements, create the plan. Enter each distinct cargo
   line, its physical unit and basis, and its manifest quantity if known. A known
   manifest quantity requires a source reference. Leave an unknown value blank;
   an explicit zero means a verified zero. Configure each party's required-return
   and required-acknowledgement flags independently.
2. Upload PDF, JPEG, PNG or WebP evidence, up to 15 MiB per file. The service checks
   the declared size, SHA-256 checksum and supported content signature, then retains
   a private copy. A return needs at least one evidence file and a source reference.
3. Record each party's return covering every plan line. Use an explicit quantity,
   including zero, or `not-applicable` with an explanation and no quantity. Missing
   returns remain missing. A correction creates a new immutable return revision and
   requires a revision reason.
4. Compare the manifest and stakeholder returns. Propose the agreed quantity and
   explanation for every cargo line; all required returns must be present. No value
   is selected automatically as the agreed result.
5. Record each relevant paper acknowledgement against this proposal, identifying
   the representative, decision, source reference and supporting evidence. The app
   records the staff member who entered it; it does not claim the party signed in.
   Updated decisions retain the earlier acknowledgement history. Any current dispute
   blocks finalization, including a dispute from an optional party.
6. A different Admin reviews and finalizes the exact proposal. Every required
   acknowledgement must be agreed, evidence must be retained, and the source returns
   must match the proposal. A newer return makes the proposal stale: prepare a new
   proposal and record new acknowledgements before finalizing.
7. Download the reconciliation sheet. A final record retains the vessel/call context,
   cargo lines, exact source revisions, decisions, evidence checksums, preparer and
   final reviewer in a frozen snapshot. The PDF is an application record, not an
   NPA-issued document. Subsequent call edits do not rewrite the final context.
8. Finance assesses the approved result using the rules below, reviews the result,
   then explicitly issues a positive ready assessment. Issuance enters the existing
   invoice review workflow; payment and reversal continue through existing billing.

Before any return or reconciliation exists, plan participants and cargo lines can
be replaced through the versioned plan API. After collection starts they are locked.
Scheduling details remain editable. Cancellation requires a reason and is blocked
once any reconciliation has been finalized. Refresh after a version conflict rather
than silently overwriting another user's work.

## Explicit financial configuration

The first release supports **USD, a linear per-unit rate, and no implicit tax or
currency conversion**. Finance must enter the payer, approved tariff reference,
reason, a verified opening-charge reference, and a rate/tolerance/opening amount for
every line. These fields are declarations recorded by Finance; the app does not
independently verify an external tariff or external invoices.

Choose one of two policies:

| Policy | Baseline used for the quantity difference |
|---|---|
| Manifest disparity | The known manifested quantity for the cargo line |
| Quantity adjustment | The explicitly entered quantity previously billed for that same scope |

An absent baseline blocks the assessment. The signed variance is the final agreed
quantity minus the selected baseline. Shortfalls are not changed into positive
charges. Each line also has an explicit tolerance mode:

- **Threshold:** charge the full positive difference only when it exceeds tolerance.
- **Deductible:** charge only the part of the positive difference above tolerance.

At the exact tolerance boundary the chargeable quantity is zero. The server uses
Decimal arithmetic and rounds monetary entitlement to cents using half-up rounding.
The calculation for each line is:

```text
entitlement = chargeable quantity × rate, rounded to cents
remaining amount = entitlement − opening billed amount − prior valid disparity invoices
```

The opening billed amount represents existing charges for this **additional charge
scope outside the app**. It is not the original base charge and must not include
in-app disparity invoices, which the app deducts separately. Enter a verified
reference such as `No prior cargo charges` only when that position is known.
Existing NRT harbour dues are not a cargo baseline and are not deducted from an
unrelated disparity. Payments do not reduce prior invoiced charges for this calculation;
voided disparity invoices are excluded.

Any negative variance or negative remaining line amount holds the entire assessment
for credit/adjustment review, even when other lines are positive. This release does
not issue automatic credits, refunds or negative invoices. Zero outcomes are retained
as no-charge assessments. Only a positive ready assessment can issue an invoice.

For the sample bulk case, a verified 19,500-tonne baseline and 19,508-tonne final
quantity give +8 tonnes. At an explicitly approved USD 2.17 per tonne, zero tolerance
and no prior charges, the additional charge is USD 17.36. This is a test scenario,
not a tariff inferred from the scanned documents.

Once a plan has an issued disparity invoice, its billing configuration is locked:
payer, currency, policy, tariff/opening references, baseline, rate, tolerance and
opening amounts must carry forward unchanged. Changing that commercial basis needs
a separately designed adjustment process; editing an old assessment is unsupported.

## Amendments and history

To correct a final result, create an amendment proposal with a reason. The existing
final remains preserved while the new draft is reviewed. A newer unresolved draft
blocks further assessment or issuance against the old final. After opening the
amendment, record revised returns as needed; those revisions stale the draft, so
create a refreshed proposal and obtain new acknowledgements.

When the replacement is independently finalized, the prior final becomes superseded
and its frozen snapshot remains unchanged. A new assessment uses the same approved
billing configuration and subtracts prior valid disparity invoices for each line.
For example, after USD 17.36 was issued for +8 tonnes at USD 2.17, an amended +10-tonne
entitlement produces only USD 4.34 more, assuming no other changes.

Assessments are immutable calculations. A newer assessment, or a newer reconciliation,
marks an unissued assessment as superseded; it cannot issue. Repeated finalization or
invoice issuance requests return the same completed result, and concurrent issuance
cannot create a second invoice for the same assessment. Supporting evidence has no
operator delete endpoint.

## Staging acceptance checklist

Use synthetic data and retain the deployed release identifier, migration output and
operator results. Do not mark this checklist complete based on local tests.

- Create a bulk plan and a container plan with separate 20/40/45-foot import/export
  lines, preserving laden/empty classifications and whole counts.
- Upload a signed-source PDF and a photo; record differing returns from multiple
  parties. Verify zero, missing and not-applicable remain distinct.
- Confirm missing required returns, a recorded dispute, missing agreement, stale
  proposal and an attempt by the preparer to finalize are blocked. Confirm an
  independent Admin can finalize and download the expected sheet.
- Change current vessel details after finalization and confirm the final sheet
  retains the original snapshot. Confirm source history cannot be deleted.
- Confirm Operations cannot assess/issue, Finance cannot finalize, Viewer cannot
  mutate, another tenant cannot access the records, and suspension denies access.
- Assess the +8 bulk scenario with the organization's approved test configuration;
  verify tolerance boundaries, unknown baseline rejection, negative-line holds,
  verified opening charges, and visible calculation detail.
- Issue once, retry, and confirm the same invoice appears in the call's financial
  totals and existing invoice review/payment screens.
- Amend the final tally and verify only the remaining charge is issued. Confirm a
  new draft blocks the earlier final's pending assessment and the old final remains
  available in history.
- Verify legacy inspections, harbour-dues amounts, invoices, payments and reversals
  remain unchanged and usable.

Local evidence: all 246 backend tests passed against PostgreSQL, including concurrent
finalization and issuance, with 95.92% line and 87.03% branch coverage. All 272 frontend
tests passed with 90.05% line and 81.35% branch coverage; lint, type checks, build and
migration drift were clean. The complete Operations → independent Admin → Finance
journey passed against the real backend in Chromium, Firefox, WebKit and iPhone 13,
including private evidence, PDF downloads, invoice persistence, keyboard tab
activation and viewport checks. These synthetic checks do not certify staging.
See the release record for hosted gates and staging results.
