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
lines: 1909
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
  `stored-sold-price-evidence.ts`. #3170 round (+338): the planner composes the STRUCTURAL half of an edit it cannot value - which beds, on which nights, with what on each - so the batch path commits and parks instead of refusing. One shared capacity-coverage function, extracted so the priced and parked plans cannot propose different beds; one required argument on the night-price composer, with no default because the two callers need opposite answers; and the paragraphs saying why a parked edit prices an ADDED guest and not an existing strand's new night. Every input is local state of this function. #3170 fix round (+18): the paragraph reconciling two positions that look contradictory - why a parked write blanks a damaged negative night row while the identity echo in the same change preserves one byte for byte - and the cost that difference carries. #3166 fix round 2 (+42): the two parked exits compose their occurrence lists through ONE function, because appending the destroyed-evidence record at only the first of them made the record depend on WHEN the failure was found - and the shared function has to de-duplicate, since a strand can legitimately be in both lists at the second exit and two occurrences for one strand raise two tasks for one guest. The measured shape that produced it is in the docblock, because nothing about the old one-line append looked wrong.

file: src/lib/booking-modify-plan.ts
lines: 2871
reason: `PricingResult` becomes a discriminated union, so the priced fields move
  behind `PricedModification` and every reader narrows once — plus
  `requiredNightPriceCents`, the refusal that replaces `perNightCents[k] ?? 0`
  in the writer that BECOMES the booking's sold-price history. Splitting this
  file is specifically forbidden by its own header and by
  `booking-guest-profile-gates.test.ts`, which compares positions inside it. #3170 round (+195): the write itself. `syncGuestNights` now tells an explicit "not known" from a vector that is merely SHORT - writing NULL for the first and still throwing on the second - and that docblock is longer than the code it guards, because it is the paragraph a later reader is most likely to delete as redundant and the one whose loss turns every future wiring defect into a silently unpriced night. #3170 fix round (+18): the write-site docblock named ONE producer of a blank night price and claimed it only ever fired for a night the guest already held. Both were false against this same change, and it is the paragraph the reasoning above argues nobody may delete - a later reader trusting it could add a held-night assertion and silently revert the parked path to a refusal. It now names both producers and both arms. #3166 round (+164): the gate itself, on the busiest edit path in the product. It has to sit in `calculateModifiedPricing`, AFTER the ordinary pricing pass, because that pass is what decides which nights each strand ends up holding and the gate must judge the edit that will be WRITTEN rather than a second derivation of it. Most of the growth is the paragraph saying why it is placed there and what a parked pre-check-in edit deliberately does not do, which is the reasoning a later reader would otherwise have to reconstruct from a ternary. Splitting is forbidden by this file's own header and by `booking-guest-profile-gates.test.ts`, which compares positions inside it. #3179 fix round (+24): `PromoChangeResult` now carries `promoEngineRan`, and this function's in-progress early return is one of the two places that answers it. It has to be reported HERE rather than re-derived by the caller: that early return is invisible from the batch service, which sees only the pricing branch, so a caller-side predicate covered the parked edit and left the in-progress priced one silent - the exact branch a future relaxation of the in-progress refusals would make silent. Most of the growth is the field's docblock saying why it is not derivable from `promoRemoved`/`promoChanged`, both of which are also false on an ordinary edit that asked for no promo change at all.

file: src/lib/booking-batch-modification-service.ts
lines: 1867
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
  next lane to re-derive it, or worse, to assume it was an oversight. #3170 round (+135): the branch that makes the epic's promise true on the busiest edit path - the change commits and the money parks. Every money door is closed individually (reprice, promotion, change fee, settlement options, refund, credit, Xero delta, stored totals), each with the sentence saying it is a decision rather than an omission, and the raise sits after the booking-modification row because it anchors to it. The branch's position inside the locked transaction is its safety property, so none of it can move. #3170 fix round (+21): why a promo-code change dropped on a parked edit is a stated limit of the whole in-progress edit path rather than a defect of the parked branch - the priced branch beside it answers identically, and fixing one alone would put the two into disagreement about the same member request. #3166 round (+5): the writer selector. A pre-check-in park carries no in-progress plan and commits through the ORDINARY branch of `applyGuestChanges` - the branch that knows about member links, consent columns, other-club flags and guest removal - while an in-progress park still takes its own. One field decides which writer runs and the rows both are handed are composed upstream, so neither branch composes its own. #3179 round (+76): the stated limit above is now closed, and closing it is what the lines are. The stub that keeps the booking's stored promotion figures now also builds the member's notice, which then rides to the response, the modification's own `newData`, the audit details and the modified email - four one-line call sites in this file plus the paragraph saying which reason applies where. It cannot move: the notice is composed from the same request fields and the same branch decision the stub is, inside the transaction that made it. #3179 fix round (+11): the notice reads `promo.promoEngineRan` rather than this file's own stub predicate, which is now named `promoFiguresStubbedHere` because that is all it decides. There are TWO stubs and this file can see only one of them - `applyPromoCodeChanges` stubs the figures again for any in-progress plan - so the old predicate built nothing on the in-progress priced branch, the one the STAY_IN_PROGRESS wording exists for. The added lines are the flag on the local literal, the re-gate, and the paragraph naming the second stub, which is the fact a reader cannot get from this file alone. It also deletes the stated-limit docblock thirty lines above the fix that makes it.

file: src/lib/booking-guest-removal-service.ts
lines: 1329
reason: #3032's delta round added the rule that a parked removal always records
  the DEPARTING strand, readable or not — the filter used to skip it for being
  exact, and since nothing settles on a parked removal and the delete destroys
  its night rows, that lost the departing member's refund entirely. The lines are
  the two-branch occurrence build and the block explaining the loss, which has to
  sit at the filter it fixes. Beneath that, the evidence gate, which is the whole
  of E10: a removal's credit was
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
lines: 2046
reason: eleven lines. `perNightCents[k] ?? 0` becomes a refusal in the writer
  that persists the new range's night rows — a magic zero there is a real sold
  price of nothing on a real night, which the next edit reads back as evidence.
  Merged forward: #3032's fence on the date path. One file, one allowance. #3166 round (+185): the date path parks. It read night prices through the LENIENT reader, so a night recorded as "not known" got no lock, was repriced at today's rate and was written back as a real integer - the one route by which a blank could turn back into a guess, and it opened the moment an earlier review was settled. The change is not liftable: `parked` gates the total, the promotion block, the change fee, the settlement options, the credit clamp, the per-guest write and the night-row write, each of which is a separate money door in this one function, and the task raise has to sit after the `BookingModification` row it anchors to. The growth is those seven guards plus the paragraph naming the window, which belongs at the gate because nothing about the old code looked wrong. (+29): the stated hand-off of this file's inline missing-price refusal to #3167's `required-price-cents`, which cannot be imported from this branch because that module is on a sibling lane that has not merged. Writing a second copy of the module would be a second definition of the rule being converged, so the site records instead which caller it will be and what the conversion must not lose.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2272
reason: the preview consumes the same discriminated result as the save and
  refuses with the same code and sentence, which is the issue's own quote/apply
  parity requirement. It cannot be lifted out without moving the plan call with
  it, and this route is the parity partner the census already tracks.
  Merged forward: #3032 fences the PREVIEW too, so quote and apply refuse the
  same edit rather than the preview pricing a refund the save then rejects.
  One file, one allowance. #3170 round (+60): the preview parks in step with the save, or it blocks the member from a change that would have succeeded - this same parity, pointing the other way. Placed AFTER the capacity block rather than before it, so "no beds" is still said before "an officer will confirm the amount". #3166 round (+89): the preview parks a PRE-CHECK-IN edit in step with the save, or it quotes money the save will not move. The parked payload is now composed once and returned from both review exits rather than written twice - the in-progress exit before pricing, the pre-check-in one after it - which is what stops the two previews drifting from each other and from the save. #3179 round (+27): that one parked payload now also says which promo-code change it is NOT carrying, because a parked preview re-runs no promotion and was quoting a settled-looking total while silently ignoring a code the member had just applied. It goes in the shared payload for the same reason the rest of it does - written at either exit it would be written twice - and the sentence itself is composed in `promo-change-not-applied.ts`, so the preview and the save cannot word one member's request two ways. #3179 fix round (+28): the in-progress branch BUILDS that sentence too, where the first round only wrote a note saying why it need not. It resolves to null while the refusal a few hundred lines above holds, and that is the point - wording nothing calls for warns nobody, so leaving it unwired is precisely what would make relaxing that refusal silent again. The lines are the one call, the variable it sets, the field on the response, and the paragraph saying why the reason is fixed rather than chosen (`inProgressPlan` is produced only under `isInProgressEdit`, so the other arm would be dead and untrue). It has to be here: this is the branch that prices from nights already agreed, and a caller cannot see which branch the route took.

file: src/app/api/bookings/[id]/modify/route.ts
lines: 491
reason: one error branch, above the generic `ApiError` branch that would
  otherwise drop the machine-readable code — the same shape and the same
  ordering rule as the four refusal branches already beside it.
  Raise-trigger round (+13): a second branch of exactly that shape, for the
  pending-review FENCE. It was falling through to the generic branch and losing
  its code, while the preview route already surfaced it — so quote and apply
  disagreed about one refusal, which is the parity this epic requires of them. #3170 round (-12): the `FINANCIAL_REVIEW_REQUIRED` catch is DELETED along with the error class. Nothing throws it any more, and its sentence - "nothing has been changed yet" - is false for what the save now does.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 543
reason: the same one branch, for the same reason, on the removal route.
  Raise-trigger round (+12): that branch is REPLACED rather than added to. An
  unpriceable removal is no longer refused — it is parked — and DELETE is the
  only handler in this file, so the `FINANCIAL_REVIEW_REQUIRED` catch became dead
  code claiming a behaviour the route does not have. What took its place is the
  fence branch, which does still arrive here and was losing its code. The growth
  is the note saying which one went and why, so the next reader does not add the
  dead branch back.

file: src/lib/waitlist.ts
lines: 1418
reason: one line of the growth is #3032's correction to this docblock's claim
  that a later removal "would be refused" — it parks. Docblock claims are
  contracts here, and a stale one at the site that explains why the write exists
  is the shape that survives longest. The rest: the offer-time reprice writes the per-night rows it prices. It moved
  `BookingGuest.priceCents` and never touched `BookingGuestNight` — zero
  references in the file — so after a rate change the rows summed to the old
  total while the guest carried the new one, and every later edit on that
  booking would be refused as unreconciled. The write cannot move out of this
  function: the amounts come from the pricing pass this function ran, inside the
  transaction and under the lodge capacity lock it already holds. Most of the
  growth is the ordering rule — the rows are built and checked BEFORE the first
  write, because this function's catch degrades to the stored snapshot and lets
  the offer go out, so a throw between two writes would commit half a reprice.
  #3167 round (+5): that refusal is now a call to `requiredNightPriceCents`
  rather than the same predicate restated inline. The module claiming to be the
  rule's one home was not, and this is one of the two siblings that made it
  false; the other is assigned in that module's header.
