# File-size allowances for #4632

Each of these already-oversized Xero modules builds a document whose tax type
and line-amount basis used to be a literal. #4632 replaces each literal with the
club's tax treatment, resolved on the document's anchor outside any transaction,
so each gains the few lines of that resolution at the place the document is
built. Moving the resolution elsewhere would separate a document from the
treatment it carries, which is the drift the one renderer exists to stop.

file: src/lib/admin-permissions.ts
lines: 953
reason: registers `/api/admin/club-tax` under the finance area beside the
  other finance API prefixes; the route-area map is one list by design.

file: src/lib/membership-cancellation-xero.ts
lines: 1414
reason: the cancellation credit note resolves its invoice's tax treatment where
  the note is built, so the note repeats the invoice's treatment.

file: src/lib/xero-booking-invoices.ts
lines: 1692
reason: the create and update paths resolve the booking's tax treatment where
  each builds its lines; the update path keeps copied lines' own tax type.

file: src/lib/xero-credit-notes.ts
lines: 1337
reason: refund credit notes resolve the booking's tax treatment where each note
  is built, so a note repeats its invoice's treatment.

file: src/lib/xero-organisation.ts
lines: 1011
reason: the organisation read carries Xero's `PaysTax` flag beside the other
  organisation fields it already normalises, for the tax health check.
