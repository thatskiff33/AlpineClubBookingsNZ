/**
 * The refusals epic #2797 requires wherever a price column is persisted from a
 * priced breakdown — the ONE home for that rule (#3031, #3167, `INV-SSOT`).
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
 * ## Why `writer` is a required argument
 *
 * These throw from four call sites across three pipelines. Naming the writer is
 * how an operator reading the error learns WHICH one produced a short vector,
 * which is the whole point of refusing rather than defaulting. It is a required
 * parameter rather than an optional one so a new call site cannot omit it —
 * unrepresentable beats policed (`INV-SSOT`).
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
