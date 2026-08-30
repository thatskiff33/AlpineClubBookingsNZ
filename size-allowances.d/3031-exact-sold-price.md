# File-size allowances for #3031

Nine files grow. Eight of them grow by ten to seventy lines, and every one of
those lines is either the discriminated result being threaded through, a refusal
replacing a silent default, or the reasoning for a money rule at the site it
governs. The ninth — `booking-edit-guest-ranges.ts` — is the one that would
normally be split, and the reason it is not is written out under its entry. It
is the only one of the nine whose body actually SHRANK.

Two counts that argue against splitting anything here, both measurable: this
change **removes** four estimators and a whole `pricePartyNights` pass, so the
executable surface of the planner is smaller than it was; and #3032 is the next
child on this epic and rewires four of these files again. A seam invented now
would be rebuilt in a fortnight, which is the case
`size-allowances.d/README.md` names as an allowance rather than a split.

file: src/lib/booking-edit-guest-ranges.ts
lines: 1467
reason: the file that must NOT be split, and the file's own header says why in a
  way this change strengthens. `booking-guest-profile-gates.test.ts` compares
  string indexes WITHIN a single file to prove the pipeline stays in one place,
  and the 960-case equivalence matrix in
  `booking-edit-guest-ranges-sparse.test.ts` re-implements the pre-#2736
  arithmetic and compares against it — both are properties of the whole plan,
  not of any one function. The growth is +140 against a body that lost a
  32-line even-split helper, a 22-line refund-ceiling clamp and an entire
  pre-edit pricing pass: the code shrank, and what replaced it is the WHY. A
  money rule that says "never reconstruct this amount" is worth nothing if the
  next reader cannot see which reconstruction was removed and what it used to
  paper over, and this repository has already re-fixed one stay-boundary rule
  four times (#2622/#2630/#2631/#2632) because the reasoning was somewhere the
  reader was not. The rule itself lives once, in `INV-MOD-028`; the file cites
  it and records the removals at the sites they were at. The review round pulled
  it DOWN 42 lines against the first draft, by moving the duplicated occurrence
  builder, night-price projection and calendar-date narrowing into
  `stored-sold-price-evidence.ts`.

file: src/lib/booking-modify-plan.ts
lines: 2490
reason: `PricingResult` becomes a discriminated union, so the priced fields move
  behind `PricedModification` and every reader narrows once — plus
  `requiredNightPriceCents`, the refusal that replaces `perNightCents[k] ?? 0`
  in the writer that BECOMES the booking's sold-price history. Splitting this
  file is specifically forbidden by its own header and by
  `booking-guest-profile-gates.test.ts`, which compares positions inside it.

file: src/lib/booking-batch-modification-service.ts
lines: 1613
reason: the apply path narrows the pricing result once and refuses the review
  branch inside the transaction, so the structural change rolls back with it;
  plus the identity-only echo's `?? 0` becoming a refusal. The comment weight is
  the seam #3032 re-routes — there the stay change commits and a review task is
  raised in the same transaction — and naming that here is what stops the next
  lane re-deriving it.
  Merged forward: #3032's pending-review fence is now in this file too, taken
  under both locks before the pricing call. One file, one allowance, so this
  entry carries both lanes' growth rather than #3032 declaring it twice.
  Raise-trigger round (+21): the refusal STAYS on this path and the comment says
  why, in the one place a reader will look for it. #3032 parked the removal path
  and could not park this one — this branch is reached only from the in-progress
  planner, whose structural change rewrites every strand's night rows from a
  per-night integer that an unreadable strand does not have — and the three ways
  to supply one are money decisions rather than implementation choices. Twenty-one
  lines is what it takes to leave that open question stated instead of leaving the
  next lane to re-derive it, or worse, to assume it was an oversight.

file: src/lib/booking-guest-removal-service.ts
lines: 1302
reason: the evidence gate, which is the whole of E10: a removal's credit was
  derived as the difference between two repricings of the REMAINING guests, so a
  remaining guest with no stored price was revalued at today's rate and that
  movement landed inside the departing guest's credit. The gate has to sit in
  this function, before the guest delete, because it is about the booking this
  function has just loaded; the classification it calls is shared
  (`stored-sold-price-evidence.ts`) rather than copied. The review round added
  the owner decision D-14 exemption and the hand-off it owes #3032 — a consent
  DECLINE or EXPIRY must always be able to take its target off the booking, and
  the reasoning has to be at the gate, because the comment that states the rule
  it would otherwise break is seventy lines further down the same function.
  Merged forward: #3032's fence and the D-14 hand-off it satisfies now sit in
  this file beside the evidence gate. One file, one allowance, so this entry
  carries both lanes' growth.
  Raise-trigger round (+159): the gate became a PARK, which is the epic's actual
  answer rather than the interim refusal. The money block is now branched — no
  reprice, no promotion recalculation, no settlement options and no per-guest
  price write when the booking's history cannot price the removal — and the raise
  itself sits inside the same transaction after the `BookingModification` anchor
  is written. Splitting was weighed and rejected on the same ground as the gate
  itself: the park is a decision about the booking THIS function has loaded under
  THIS function's two locks, and the branch is only trustworthy while the reader
  can see the settlement it is skipping a few lines below it. Roughly half the
  growth is reasoning — why the exemption is gone rather than merely unused, why
  `priceDiffCents` being zero is not a `$0` decision, and why the stored total is
  left alone — and this repository has re-fixed one stay-boundary rule four times
  (#2622/#2630/#2631/#2632) because the reasoning was somewhere the reader was
  not.

file: src/lib/booking-date-modification-service.ts
lines: 1797
reason: eleven lines. `perNightCents[k] ?? 0` becomes a refusal in the writer
  that persists the new range's night rows — a magic zero there is a real sold
  price of nothing on a real night, which the next edit reads back as evidence.
  Merged forward: #3032's fence on the date path. One file, one allowance.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2095
reason: the preview consumes the same discriminated result as the save and
  refuses with the same code and sentence, which is the issue's own quote/apply
  parity requirement. It cannot be lifted out without moving the plan call with
  it, and this route is the parity partner the census already tracks.
  Merged forward: #3032 fences the PREVIEW too, so quote and apply refuse the
  same edit rather than the preview pricing a refund the save then rejects.
  One file, one allowance.

file: src/app/api/bookings/[id]/modify/route.ts
lines: 503
reason: one error branch, above the generic `ApiError` branch that would
  otherwise drop the machine-readable code — the same shape and the same
  ordering rule as the four refusal branches already beside it.
  Raise-trigger round (+13): a second branch of exactly that shape, for the
  pending-review FENCE. It was falling through to the generic branch and losing
  its code, while the preview route already surfaced it — so quote and apply
  disagreed about one refusal, which is the parity this epic requires of them.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 534
reason: the same one branch, for the same reason, on the removal route.
  Raise-trigger round (+12): that branch is REPLACED rather than added to. An
  unpriceable removal is no longer refused — it is parked — and DELETE is the
  only handler in this file, so the `FINANCIAL_REVIEW_REQUIRED` catch became dead
  code claiming a behaviour the route does not have. What took its place is the
  fence branch, which does still arrive here and was losing its code. The growth
  is the note saying which one went and why, so the next reader does not add the
  dead branch back.

file: src/lib/waitlist.ts
lines: 1379
reason: the offer-time reprice writes the per-night rows it prices. It moved
  `BookingGuest.priceCents` and never touched `BookingGuestNight` — zero
  references in the file — so after a rate change the rows summed to the old
  total while the guest carried the new one, and every later edit on that
  booking would be refused as unreconciled. The write cannot move out of this
  function: the amounts come from the pricing pass this function ran, inside the
  transaction and under the lodge capacity lock it already holds. Most of the
  growth is the ordering rule — the rows are built and checked BEFORE the first
  write, because this function's catch degrades to the stored snapshot and lets
  the offer go out, so a throw between two writes would commit half a reprice.
