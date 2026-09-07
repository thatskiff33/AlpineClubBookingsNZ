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

The admin route's and the member charge route's growth are declared in
`size-allowances.d/3267-one-charge-attempt-per-key.md` (one allowance per path
across the epic; #3267 rebuilds both charge calls and carries this lane's reason
too: each reads the card through the shared predicate and loads the parent row).

file: src/lib/payment-link.ts
lines: 1352
reason: the `not_payable` gate now asks the same predicate the cron charges on,
  so a card the cron will refuse no longer blocks the link. Three lines, all
  comment: the existing #1967 FIX-5 note gains the sentence saying why the two
  must share one definition.
