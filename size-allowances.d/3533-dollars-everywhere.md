# File-size allowances for #3533 — every amount a person reads is `$84.50`

Seven already-over-budget files grow by **exactly one line each**: the import
of `formatCents` from `@/lib/utils`.

That is the whole of it, and it is irreducible. The change replaces
`${someCents} cents` with `${formatCents(someCents)}` inside sentences that
already exist — no statement is added, no branch, no helper. What each of these
files gains is the one import line that makes the shared formatter reachable,
which is precisely what `INV-SSOT-001` asks for: the alternative to the import
is a local copy of the formatter, which is the defect the rule exists to
prevent.

No split was taken, and none was available that would be an improvement: the
seam these files would be split along is "the file's sentences", and moving a
module's own error and audit text out of it so that the module can afford an
import would make both halves harder to read for no gain. Every one of these
files was over budget on the base ref for reasons this change had no part in;
each is a candidate for a real split of its own, which is a refactor with its
own issue rather than something to attempt inside a rendering fix.

file: src/app/(admin)/admin/audit-log/page.tsx
lines: 1124
reason: one import of formatAuditMetadataJson, which renders the metadata panel.
  The annotation logic itself went into a new module
  (src/lib/audit-metadata-amounts.ts, inside its own budget) rather
  than into this page, so the page gains the import and nothing else.

file: src/lib/config-transfer/categories/membership-fees.ts
lines: 1077
reason: one import of formatCents for the three component-sum error messages an
  operator reads when a config bundle does not balance.

file: src/lib/group-cancel.ts
lines: 925
reason: one import of formatCents for the two organiser-refund audit details.

file: src/lib/payment-recovery.ts
lines: 3159
reason: one import of formatCents for the still-owed figure in the recovery
  error. This file is the largest in the tree and badly wants splitting, which
  is a refactor of its own.

file: src/lib/payment-transactions.ts
lines: 1188
reason: one import of formatCents for the partial-refund failure message.

file: src/lib/stripe-webhook-service.ts
lines: 1766
reason: one import of formatCents for the amount-mismatch error an officer reads
  when Stripe reports a figure the booking did not expect.

file: src/lib/xero-hardening-report.ts
lines: 1094
reason: one import of formatCents for the credit-note coverage detail line.
