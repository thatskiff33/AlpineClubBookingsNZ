# File-size allowances for #3033

Three files this change makes longer were already over budget on `main`. A
fourth — `src/app/api/admin/payments/manual-refund-tasks/route.ts` — was
**inside** its 250-line budget, so it gets no entry here and none would be
honoured: its row mapping and the redaction that goes with it were lifted into
`src/lib/manual-refund-task-queue-payload.ts` instead, which is the split the
gate exists to force and a better home for that code anyway.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 1094
reason: this is where the whole admin half of the feature lands — the two
  kind-aware intro paragraphs, the captured-evidence block, the permission-gated
  booking link, and the per-kind dialog copy. The obvious split is to lift the
  evidence renderer out, and it was considered and rejected on evidence rather
  than on effort: three suites scan this file BY PATH
  (`view-only-banner-contract`, `late-capture-decision-provenance`,
  `unverified-write-copy-contract`), and moving code out of a path a disk-scanning
  guard hardcodes is this repository's known silent-false-green failure — the
  guard keeps passing over the half that stayed. Splitting it is worth doing on an
  issue where those three guards can be re-pointed and mutation-proved as the
  change's own subject, not as a line-count tidy-up ridden in on a money-copy fix.

file: src/lib/email/booking.ts
lines: 1533
reason: the growth is the composed money note in `sendBookingModifiedEmail` —
  a review sentence rendered ALONGSIDE the settlement sentence rather than
  instead of it, which is what stops a member being told there is nothing to do
  while an additional payment goes uncollected. It has to sit in the sender that
  builds `templateData`, because the flat admin-editable body's `{{paymentNote}}`
  is composed there and nowhere else. The sentences themselves were moved OUT, to
  `booking-financial-review-copy.ts`, so what remains is the composition and the
  reasoning for it.

file: src/app/(authenticated)/bookings/[id]/page.tsx
lines: 2698
reason: this page is the assembly point for the member booking view, and the
  addition is assembly: one read of whether the booking has money held for
  review, handed to the narrative resolver, the history builder and the admin
  warning so all three answer from one query on one page load. Splitting that
  apart would give each surface its own read and let them disagree about the same
  booking, which is the specific failure the single read exists to prevent.
