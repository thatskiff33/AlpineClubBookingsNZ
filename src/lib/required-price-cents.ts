/**
 * The refusals epic #2797 requires wherever a price column is persisted from a
 * priced breakdown — the one home for that rule on every write point that is
 * SELLING the nights it writes, and so has no honest answer other than the
 * amount (#3031, #3167, `INV-SSOT`). Two write points are outside it. They are
 * named below with where their rule DOES live, because the reason they are
 * outside is arity, not scope, and neither is a copy of anything here.
 *
 * ## The two write points this module does not cover
 *
 * Claiming it covered them all would be worse than claiming nothing, because a
 * reader who trusts the claim edits one file and believes the whole system
 * changed. As of 5 Sep 2026 there are SEVEN write points of a price column
 * from a priced breakdown — the five call sites listed below, plus these two.
 *
 * **Recount them with this criterion or you will get a different number.** What
 * is counted is a write whose index runs over an INNER vector —
 * `perNightCents[k]`, `split[index]` — whose length has no declared relation to
 * the loop bound. Two shapes look like write points to a bare grep and are
 * deliberately NOT counted, for two different reasons:
 *
 *  - a guest-total write that carries NO `?? 0`, so a short breakdown throws
 *    rather than persisting a zero — `priceBreakdown.guests[i].priceCents` in
 *    `waitlist.ts` and `booking-date-modification-service.ts`,
 *    `repricedGuests.guests[index].priceCents` in
 *    `booking-guest-removal-service.ts`, and the `for (let i = 0; …)` in
 *    `booking-modify-plan.ts`. They are not magic-zero write points, which is
 *    what this module is the home of.
 *
 *    An earlier version of this bullet excluded them as "indexed by its own
 *    enclosing `map`, over the very array the breakdown was built from". That
 *    was not true of the code and a reader applying it literally would have
 *    counted EIGHT: in each of the four the loop bound and the indexed array are
 *    different objects (`candidate.guests` against `priceBreakdown.guests`, and
 *    so on), one is not a `map` at all, and `booking-guest-removal-service.ts`
 *    optional-chains the very next line — so its own author did not treat that
 *    index as guaranteed. They are related only by the single-producer
 *    convention this header calls undeclared two paragraphs above, which is
 *    exactly the thing a recount criterion may not lean on;
 *  - a read of an inner vector whose length is CHECKED against the loop bound
 *    immediately above it — `engine[index]` in `buildApprovalGuestNights`
 *    (`booking-request-shared.ts`), fenced by `engine.length === count` and
 *    falling back to an even split when that check fails. It is the closest
 *    near-miss in the tree: a night price, read from a vector, by index.
 *
 * Those five are cited by SYMBOL. Four of them were cited by LINE until 31 Aug
 * 2026, and all four numbers had drifted within a day of being written — which
 * is the same reason `AGENTS.md` bans line-number citations in the invariant
 * documents.
 *
 * ### Both of them are THREE-WAY, and both already share one definition
 *
 * `booking-modify-plan.ts` (`nightPriceCentsToWrite`, used by `syncGuestNights`)
 * and `booking-date-modification-service.ts` (the
 * `tx.bookingGuestNight.createMany` inside `applyBookingDateModification`) make
 * a three-way decision, not this module's two-way one: #3170 made an explicit
 * `null` the composer SAYING that a night's price is not known, which both
 * honour by writing `NULL`, while `undefined` — a short or holed vector — is
 * still a wiring defect and still throws.
 *
 * The helpers here are two-way by design. Every path they guard is selling the
 * night it writes, so "not known" is not an answer any of them may give, and
 * `requiredNightPriceCents`'s signature (`readonly number[] | undefined` to
 * `number`) cannot express the not-known arm at all. Routing either site through
 * here would need a discriminating flag on a money helper so that one caller
 * behaves oppositely to every other — the contortion `INV-SSOT-001` warns
 * against rather than the convergence it asks for. Two rules that differ in
 * their arity are two rules.
 *
 * **Since #3166 both sites narrow ONE definition of the three-way rule:**
 * `classifyNightPriceToWrite` in `stored-night-price-write.ts`. What each still
 * spells out for itself is the FAILURE it owes its operator — an internal
 * `Error` in the modify plan, and on the date path an `ApiError(..., 400)`
 * whose member-facing sentence ("The new dates could not be priced night by
 * night") `phase8b-booking-mods.test.ts` pins. That is one definition with two
 * derivations, which `INV-SSOT-001` permits explicitly; a second DEFINITION is
 * what it prohibits, and there is no longer one.
 *
 * **The #3167 follow-on round this header used to promise is discharged, and
 * nothing was converted.** It was recorded here, and at the date site, as a
 * two-way copy of this module's predicate awaiting a conversion once #3166
 * landed. #3166 landed first and converged the decision itself, so by the time
 * the round ran there was no copy left to move — only the two stale claims,
 * which is what it fixed instead. Anyone reading this looking for the promised
 * conversion: it is not missing, it is unnecessary.
 *
 * THE FAILURE THIS PARAGRAPH EXISTS TO PREVENT. Somebody widens the rule —
 * rejects a `NaN` or a fractional cent, or requires every refusal to name its
 * writer — reads the header that says "the one home", edits this file, and
 * ships a change covering five of the seven write points. The other two reach
 * their decision through `stored-night-price-write.ts`, so a change to what a
 * night price may BE has to visit both modules.
 *
 * ## What these enforce, and why they are not defensive padding
 *
 * `BookingGuestNight.priceCents` and `BookingGuest.priceCents` are the only
 * record this system keeps of what a stay was sold for, and #3031 made the
 * night rows load-bearing: an edit reads them back as sold-price evidence, and
 * a strand whose rows do not reconcile to its guest total sends the whole edit
 * to manual review. A `0` written because a vector came up short is a real
 * financial number that cannot afterwards be told apart from a genuine free
 * night, so it does not surface as the caller bug it is — it surfaces months
 * later as an unexplained review, on a different day, for a different person.
 *
 * The breakdown types declare NO length relation between a guest's
 * `perNightCents` and its `nightDates` (nor between a price split and the guest
 * list), so a producer whose halves disagree type-checks cleanly today — two
 * existing mock fixtures already construct disagreeing pairs, in the harmless
 * direction. The relation is real, but it lives only in the shape of the
 * function that builds it. These helpers are what turn that convention into
 * something enforced at the write.
 *
 * ## The census behind them (#3167)
 *
 * Every current caller of every writer these guard was read before they went
 * in, and NONE can produce a short breakdown: no member is on a path where a
 * refusal here replaces a silent zero with a failed booking. The strength of
 * that guarantee differs by site, and each call site records which kind it has.
 *
 * ONE site was read by that census and deliberately left alone:
 * `booking-request-quotes.ts`'s `totalCents: split[guestIndex] ?? 0`, which
 * builds a quote option's `guestBreakdown`. That is quote JSON — an offer shown
 * to the requester and rendered by the respond page — not
 * `BookingGuest.priceCents`, and approval never reads it back for money: it
 * re-splits from the request's own `priceCents` at `booking-request.ts`
 * (`splitPriceAcrossGuests(priceCents, guests.length)`) before calling
 * `buildApprovalGuestCreates`. So it persists no price column and is out of
 * scope for this rule. It is named here rather than left unmentioned because
 * the same file DOES carry a guarded site, and silence would read as "the file
 * was swept".
 *
 * ## Why `writer` is a required argument
 *
 * These throw from five call sites:
 *
 *   1. the add-guest route (`app/api/bookings/[id]/guests/route.ts`);
 *   2. the booking-create guest writer (`booking-create-guests.ts`);
 *   3. the booking-request capacity hold (`booking-request-quotes.ts`);
 *   4. the shared approval guest writer (`booking-request-shared.ts`), which
 *      all three approval pipelines go through — the public booking request,
 *      the school request and the member whole-lodge request;
 *   5. the waitlist offer reprice (`waitlist.ts`).
 *
 * Naming the writer is how an operator reading the error learns WHICH one
 * produced a short vector, which is the whole point of refusing rather than
 * defaulting. It is a required parameter rather than an optional one so a new
 * call site cannot omit it — unrepresentable beats policed (`INV-SSOT`).
 *
 * That list is a convenience, not the gate: `git grep` for the two exported
 * names is the authority, and a stale count here discredits the paragraph it
 * sits in. It was last recounted against the tree on 5 Sep 2026. The separate
 * `booking-guest-night-price-source-census.test.ts` pins the wider set of direct
 * and nested runtime `BookingGuestNight` writers, including the executable demo
 * and E2E seeds outside `src`, and the explicit provenance each now carries
 * (INV-MONEY-028); this module still owns amount completeness only.
 */

/**
 * The amount priced for night `index` of a guest's breakdown.
 *
 * Throws rather than defaulting. The alternative — a zero — is a real financial
 * number written into `BookingGuestNight.priceCents`, which is the only record
 * of what a night was sold for. A per-night vector shorter than the night list
 * is a wiring defect in whoever built the breakdown, and refusing is the only
 * answer that does not invent money.
 *
 * @param writer Human-readable name of the persistence site, for the error.
 */
export function requiredNightPriceCents(
  perNightCents: readonly number[] | undefined,
  index: number,
  stayDate: Date,
  writer: string
): number {
  const cents = perNightCents?.[index];
  if (typeof cents !== "number") {
    throw new Error(
      `No priced amount for the night of ${stayDate.toISOString()} in ${writer} (#3031)`
    );
  }
  return cents;
}

/**
 * The amount priced for guest `index` of a per-guest price split.
 *
 * The guest-total counterpart of `requiredNightPriceCents`, for the two writers
 * that persist `BookingGuest.priceCents` from a split rather than a night
 * vector — the bed hold at quote time and the shared approval guest writer. Same rule, same reason: a zero here is a real price for a stay, and a
 * split shorter than the guest list is a caller defect.
 *
 * @param writer Human-readable name of the persistence site, for the error.
 */
export function requiredGuestPriceCents(
  guestPriceCents: readonly number[] | undefined,
  index: number,
  writer: string
): number {
  const cents = guestPriceCents?.[index];
  if (typeof cents !== "number") {
    throw new Error(
      `No priced amount for guest ${index + 1} in ${writer} (#3167)`
    );
  }
  return cents;
}
