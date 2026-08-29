# File-size allowances for #3031

Eight files grow. Seven of them grow by ten to seventy lines, and every one of
those lines is either the discriminated result being threaded through, a refusal
replacing a silent default, or the reasoning for a money rule at the site it
governs. The eighth — `booking-edit-guest-ranges.ts` — is the one that would
normally be split, and the reason it is not is written out under its entry.

Two counts that argue against splitting anything here, both measurable: this
change **removes** four estimators and a whole `pricePartyNights` pass, so the
executable surface of the planner is smaller than it was; and #3032 is the next
child on this epic and rewires four of these files again. A seam invented now
would be rebuilt in a fortnight, which is the case
`size-allowances.d/README.md` names as an allowance rather than a split.

file: src/lib/booking-edit-guest-ranges.ts
lines: 1509
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
  it and records the removals at the sites they were at.

file: src/lib/booking-modify-plan.ts
lines: 2503
reason: `PricingResult` becomes a discriminated union, so the priced fields move
  behind `PricedModification` and every reader narrows once — plus
  `requiredNightPriceCents`, the refusal that replaces `perNightCents[k] ?? 0`
  in the writer that BECOMES the booking's sold-price history. Splitting this
  file is specifically forbidden by its own header and by
  `booking-guest-profile-gates.test.ts`, which compares positions inside it.

file: src/lib/booking-batch-modification-service.ts
lines: 1556
reason: the apply path narrows the pricing result once and refuses the review
  branch inside the transaction, so the structural change rolls back with it;
  plus the identity-only echo's `?? 0` becoming a refusal. The comment weight is
  the seam #3032 re-routes — there the stay change commits and a review task is
  raised in the same transaction — and naming that here is what stops the next
  lane re-deriving it.

file: src/lib/booking-guest-removal-service.ts
lines: 1115
reason: the evidence gate, which is the whole of E10: a removal's credit was
  derived as the difference between two repricings of the REMAINING guests, so a
  remaining guest with no stored price was revalued at today's rate and that
  movement landed inside the departing guest's credit. The gate has to sit in
  this function, before the guest delete, because it is about the booking this
  function has just loaded; the classification it calls is shared
  (`stored-sold-price-evidence.ts`) rather than copied.

file: src/lib/booking-date-modification-service.ts
lines: 1817
reason: eleven lines. `perNightCents[k] ?? 0` becomes a refusal in the writer
  that persists the new range's night rows — a magic zero there is a real sold
  price of nothing on a real night, which the next edit reads back as evidence.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2083
reason: the preview consumes the same discriminated result as the save and
  refuses with the same code and sentence, which is the issue's own quote/apply
  parity requirement. It cannot be lifted out without moving the plan call with
  it, and this route is the parity partner the census already tracks.

file: src/app/api/bookings/[id]/modify/route.ts
lines: 490
reason: one error branch, above the generic `ApiError` branch that would
  otherwise drop the machine-readable code — the same shape and the same
  ordering rule as the four refusal branches already beside it.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 522
reason: the same one branch, for the same reason, on the removal route.
