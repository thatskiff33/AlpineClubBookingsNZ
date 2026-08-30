/**
 * The refusals epic #2797 requires wherever a price column is persisted from a
 * priced breakdown — the one home for that rule on every write point that is
 * SELLING the nights it writes, and so has no honest answer other than the
 * amount (#3031, #3167, `INV-SSOT`). Two write points are neither covered nor
 * convergeable-today; they are named below, by file, with their owner.
 *
 * ## Where the rule is STILL written out inline, and who owns each one
 *
 * This module does not yet cover every write point, and claiming it does would
 * be worse than claiming nothing: `booking-modify-plan.ts` also carries a
 * header presenting itself as the home of this rule, so a reader who trusts
 * either one edits one or two files and believes the whole system changed. As
 * of 31 Aug 2026 there are SEVEN write points of a price column from a priced
 * breakdown — the five call sites listed below, plus these two:
 *
 *  - **`booking-modify-plan.ts`** (`nightPriceCentsToWrite`, used by
 *    `syncGuestNights`) — NOT convergeable, and deliberately so. #3170 made it
 *    a THREE-WAY decision: an explicit `null` is the composer saying "this
 *    night's price is not known", which it honours by writing `NULL`, while
 *    `undefined` (a short or holed vector) is still a wiring defect and still
 *    throws. The helpers here are two-way by design — every path they guard is
 *    selling the night right now, so "not known" is not an answer any of them
 *    may give. Routing that site through here would need a discriminating flag
 *    on a money helper so that one caller behaves oppositely to every other,
 *    which is the contortion `INV-SSOT-001` warns against rather than the
 *    convergence it asks for. Two rules that differ in their arity are two
 *    rules. Owned by #3170 (already merged into the epic branch).
 *  - **`booking-date-modification-service.ts`** (the
 *    `tx.bookingGuestNight.createMany` inside `applyBookingDateModification`) —
 *    a genuine two-way copy of this exact predicate, differing only in what it
 *    throws: an `ApiError(..., 400)` that the date-change route turns into the
 *    member-facing "The new dates could not be priced night by night", a
 *    sentence `phase8b-booking-mods.test.ts` pins. Converging it therefore
 *    means picking a shape for a member-visible refusal rather than swapping a
 *    call. It is owned by **#3167 itself, in a follow-on round once #3166 has
 *    landed**. #3166 was asked to do it and correctly declined: this module does
 *    not exist on its branch, so it could only have written a SECOND copy of the
 *    rule it was converging. It recorded the hand-off at that site instead. The
 *    one thing the conversion must not lose is that site's `null` branch.
 *
 * THE FAILURE THIS PARAGRAPH EXISTS TO PREVENT. Somebody widens the rule —
 * rejects a `NaN` or a fractional cent, or requires every refusal to name its
 * writer — reads the header that says "the one home", edits this file, and
 * ships a change covering five of the seven write points. Or, on the same
 * mistake pointed the other way: #3170 has already made an unpriceable night
 * PARK rather than refuse on the in-progress edit path, and a later change
 * doing the same for a DATE change while touching only the two files that
 * advertise themselves as the rule's home would leave the date path silently
 * refusing — quote and apply then disagreeing about one member's edit.
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
 * sits in. It was last recounted against the tree on 31 Aug 2026.
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
 * The guest-total counterpart of `requiredNightPriceCents`, for the one writer
 * that persists `BookingGuest.priceCents` from a split rather than a night
 * vector. Same rule, same reason: a zero here is a real price for a stay, and a
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
