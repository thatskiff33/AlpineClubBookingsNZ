# File-size allowances for #3548 — a refund credit note interrupted before its payment

The settlement, the read-back and the unsettled-row class live in two new
modules, `src/lib/xero-refund-note-settlement.ts` and
`src/lib/xero-refund-note-unsettled.ts`. What stays in each over-budget file is
the one call and the one import that wire those in.

file: src/lib/xero-booking-repair-classify.ts
lines: 2247
reason: the repair tool's REFUND_CREDIT_NOTE_UNSETTLED finding has to be raised
  where the tool classifies a booking's payment, beside the other refund-note
  findings; the finding and its operator-only action are built in
  `xero-booking-repair-findings.ts`, so this file gains one import and one call.

file: src/lib/xero-hardening-report.ts
lines: 1159
reason: the reconciliation report's new "Refund credit notes with no settlement
  on record" class has to join the report's summary, its issue counts and its
  sections; the section itself is built in `xero-refund-note-unsettled.ts`, so
  this file gains one import, one call and one entry in each of those lists.
