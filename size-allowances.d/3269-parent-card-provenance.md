# File-size allowances for #3269 (saved-card provenance)

The rule itself went into a NEW module, `src/lib/saved-payment-method.ts`
(inside budget), and `src/lib/cron-confirm-pending.ts` SHRANK by thirteen lines
when its private copy of the predicate moved there. Four already-over-budget
readers grow because each now states, at the call site, why it asks the shared
module rather than testing the columns it has in hand: the previous line at each
site read as trivially correct and was the defect.

file: src/app/(authenticated)/bookings/[id]/page.tsx
lines: 2736
reason: the admin "Confirm pending guests" button's will-charge wording has to
  agree with the route that charges, so the query now selects the split parent's
  three card columns and the prop is derived by the shared predicate. Eleven of
  the twenty lines are the nested `select`; the rest is the comment saying which
  route this must stay in step with. Splitting the page is a refactor of its own
  and would not remove this select.

file: src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts
lines: 756
reason: the route loads the parent's payment row (three lines), derives the
  card through the shared predicate, and spreads `savedPaymentMethodRowStamp`
  into its claim upsert so a borrowed parent card is never written onto the
  child's row. The code is net shorter; the growth is the two comments naming
  the invariant at the read and at the write, which is where the next person
  would otherwise put the populated-fields check back.

file: src/app/api/payments/charge-saved-method/route.ts
lines: 358
reason: one guard becomes one call to the shared predicate plus the six-line
  comment explaining why THIS route deliberately has no split-parent fallback:
  it records the capture on the row it read and creates none. Without that
  comment the omission reads as an oversight the next lane would "fix".

file: src/lib/payment-link.ts
lines: 1352
reason: the `not_payable` gate now asks the same predicate the cron charges on,
  so a card the cron will refuse no longer blocks the link. Three lines, all
  comment: the existing #1967 FIX-5 note gains the sentence saying why the two
  must share one definition.
