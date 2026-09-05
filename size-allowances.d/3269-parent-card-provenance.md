# File-size allowances for #3269 (saved-card provenance)

The rule itself went into a NEW module, `src/lib/saved-payment-method.ts`
(inside budget), and `src/lib/cron-confirm-pending.ts` SHRANK by thirteen lines
when its private copy of the predicate moved there. Three already-over-budget
readers grow here (the page is declared beside #3266's entry, below) because each now states, at the call site, why it asks the shared
module rather than testing the columns it has in hand: the previous line at each
site read as trivially correct and was the defect.

The booking page's growth is declared in
`size-allowances.d/3266-setup-intent-retires-old-card.md` (one allowance per
path across the epic — the gate refuses two files naming one path, and both
lanes land through the same integration branch); that entry carries this
lane's reason too: the admin "Confirm pending guests" button's will-charge
wording now derives from the shared predicate over the split parent's three
card columns, selected in the page query.

file: src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts
lines: 756
reason: the route loads the parent's payment row (three lines), derives the
  card through the shared predicate, and spreads `savedPaymentMethodRowStamp`
  into its claim upsert so the claim writes only the customer onto the child's
  row. The code is net shorter; the growth is the two comments naming
  the invariant at the read and at the write, which is where the next person
  would otherwise put the populated-fields check back.

file: src/app/api/payments/charge-saved-method/route.ts
lines: 355
reason: one guard becomes one call to the shared predicate plus the eight-line
  comment explaining why THIS route deliberately has no split-parent fallback:
  it records the capture on the row it read and creates none. Without that
  comment the omission reads as an oversight the next lane would "fix".

file: src/lib/payment-link.ts
lines: 1352
reason: the `not_payable` gate now asks the same predicate the cron charges on,
  so a card the cron will refuse no longer blocks the link. Three lines, all
  comment: the existing #1967 FIX-5 note gains the sentence saying why the two
  must share one definition.
