# File-size allowances for the moving-in import and opening credits (#4988)

Six already-over-budget files grow. The new logic lives in new modules
(`opening-credit-batch.ts`, `opening-credit-csv.ts`,
`member-csv-import-type-family.ts`, `member-import-type-family.ts` and the
`opening-credit-batches-card.tsx` component); what stays here is the wiring
that can only live in the file that owns it.

file: src/lib/member-csv-import.ts
lines: 1184
reason: two field definitions, Membership Type and Family Key, with their
  aliases and the note on why none collides with a lastName alias.
  `MEMBER_IMPORT_FIELD_DEFINITIONS` is the one list that column mapping, the
  alias-collision test and the preview read. The type and family rules
  themselves moved out to `member-csv-import-type-family.ts`; only their two
  calls in the preview stay here. One doc line exports the header normaliser
  so the opening-credit CSV reuses it rather than copying it.

file: src/app/api/admin/members/import/route.ts
lines: 892
reason: three calls into `member-import-type-family.ts` (resolve the row's
  type and family key, create the family groups inside the import
  transaction, assign the season's types after commit) and the two counts in
  the response. They sit in the per-row loop and the transaction this route
  owns; the helpers hold the logic.

file: src/app/(admin)/admin/membership/members/_components/member-import-dialog.tsx
lines: 928
reason: the club's active type names passed into the preview, so a misspelt
  type is shown before upload, and the result panel's family-group and type
  counts with the list of members whose type could not be saved. Both belong
  to this dialog's preview and result steps.

file: src/app/(admin)/admin/finance/refund-requests/page.tsx
lines: 973
reason: renders the new Opening credits card with the page's existing
  finance-edit flag; the card is its own component.

file: src/app/(admin)/admin/membership/members/page.tsx
lines: 602
reason: passes the already-loaded membership types to the import dialog.

file: src/lib/admin-permissions.ts
lines: 951
reason: `/api/admin/opening-credits` in the finance area's prefix list.
  `ROUTE_AREA_PREFIXES` is the single table the drift guard compares the
  route tree against.
