# Entering a voyage measurement sheet

The measurement screens follow the cargo rows and agency columns in the NPA
voyage reconciliation sheets. The owner's baseline declaration, independent
agency observations and the reconciled result remain distinct records.

1. **Choose the vessel.** Select an existing vessel call and check its reference,
   berth and available vessel details.
2. **Record the owner's baseline declaration.** Choose the cargo type and copy
   the owner-provided quantities into the matching cargo rows.
   Containers use 20, 40 and 45 ft rows, separated into
   laden/empty and import/export. Include only applicable rows. Vehicle presets
   include the paper categories Cars, Buses, Trucks and Mafi Trailer / HDV.
   Tanker rows identify the product carried, such as petroleum, chemicals or gas.
   Mixed cargo keeps separate rows and units for each category.
   Enter a shared vessel declaration reference once; a row-specific
   reference overrides it. Blank is unknown; 0 is an explicit NIL declaration.
   Container details can be expanded when the preset needs editing. Changing
   an edited cargo template requires an explicit replacement choice.
3. **Name participating agencies.** Add the Agent, Ops / Terminal, Master,
   Surveyor and Tally clerk parties required for this operation. This names the
   sources of later independent measurements; it does not enter their readings.
4. **Arrange independent measurements.** Review the schedule, suggested method
   and scope, and name the survey lead.
5. **Record each independent agency reading.** Select its reporting agency, enter the source
   reference and all included cargo rows, and attach evidence. Use 0 for NIL.
   An N/A reading needs a reason. Unsaved drafts and selected evidence remain
   separate for each agency while the form is open; they are not stored after
   closing the form. Mobile entry uses labelled cargo cards.
6. **Review NPA reconciliation.** After the required agency readings are received,
   the sheet shows the owner's baseline declaration, each
   agency reading, the proposed/final tally and the difference in that row's
   unit. Agency readings are not averaged or overwritten. Saved versions use
   their original declaration and return snapshots. NPA can follow its review
   process using the existing proposal, acknowledgement and independent Admin
   finalization actions.
7. **Continue to disparity billing.** Existing assessment and invoicing rules
   apply to the stored final reconciliation. Count, tonnes and m3 are never
   combined into one cargo total.

## Current access boundary

This change updates the frontend only. Admin and Operations users with the
existing measurement permission can record a return for any listed party in
their organization. The reporting agency identifies the source; the server
records the actual signed-in user separately. Participant roles do not grant
application permissions.

Agency-linked accounts, collaboration between separate organization tenants,
and NPA-only reconciliation permissions require a later backend change. This
UI does not enforce or claim those capabilities.

## Release impact

There are no API, schema, migration, permission or billing-rule changes.
Validation covers form payloads, draft isolation, exact decimal comparisons,
saved snapshots, browser/mobile layout and the existing frontend tests.
Rollback a regression through the normal signed release process; no data or
schema rollback is introduced by this change.
