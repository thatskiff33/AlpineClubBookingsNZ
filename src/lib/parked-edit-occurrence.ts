import {
  isNonNegativeIntegerCents,
  type EditFinancialReviewCause,
  type EditFinancialReviewOccurrence,
  type EditFinancialReviewStrandRecord,
} from "@/lib/edit-financial-review-context";
import type { CalendarDate } from "@/lib/club-time";
// TYPE-ONLY, and it has to stay that way. `stored-sold-price-evidence.ts` calls
// the builders below, so a value import back into it would be a runtime cycle;
// a type import is erased.
import type { StoredSoldPriceEvidence } from "@/lib/stored-sold-price-evidence";

/**
 * #3498 (epic #2797, owner decision D1): WHAT A PARKED EDIT WRITES DOWN, and how
 * the strands it records compose into the ONE work item it raises.
 *
 * ## Why this is its own module
 *
 * `stored-sold-price-evidence.ts` answers ONE question about ONE strand: can
 * this guest's stored history price an edit exactly, and if not, why not. That
 * is a classification, it is the same question every caller asks, and it has no
 * idea what an edit is.
 *
 * This module answers a different one: given those verdicts, what does the edit
 * RECORD, and which of the strands it records does the officer see first. It is
 * about the shape of a work item rather than about the readability of a row, it
 * moved here when #3498 doubled its size, and the seam is the one that module's
 * own docblock already draws - "this module classifies; it does not key".
 *
 * Nothing here reads a rate, computes an amount, or writes a row. There is no
 * amount anywhere in it, which is the property epic #2797 exists to keep.
 */

/**
 * THE ONE BUILDER for an unreadable strand's record (#3030), from an unusable
 * verdict and the two halves of the structural change (`INV-SSOT`).
 *
 * It built a whole `EditFinancialReviewOccurrence` until #3498, when owner
 * decision D1 moved the grain to the edit. What it composes is byte-for-byte
 * what it composed before; it is now one entry on a per-edit occurrence rather
 * than an occurrence of its own, which is the whole of that change.
 *
 * Three call sites used to compose this literal by hand — the planner twice and
 * the single-guest removal once — and the identity they build is the material
 * the occurrence key is hashed from, so a field spelled differently at one site
 * is a duplicate task at that site and nowhere else.
 *
 * `guestTotalCents` is recorded as null when the stored total is not usable
 * money, because the review context refuses a negative or fractional one — and a
 * total that cannot be represented is itself part of what the admin needs to
 * know.
 */
export function unpriceableStrandRecord(args: {
  bookingGuestId: string;
  evidence: Extract<StoredSoldPriceEvidence, { kind: "unusable" }>;
  /** `BookingGuest.priceCents` as stored. */
  guestTotalCents: number;
  surrenderedNightDates: readonly CalendarDate[];
  addedNightDates: readonly CalendarDate[];
}): EditFinancialReviewStrandRecord {
  return composeStrandRecord({
    ...args,
    cause: args.evidence.cause,
    nightPrices: args.evidence.nightPrices,
  });
}

/**
 * #3032: the occurrence for a strand whose OWN rows are exact, on an edit that
 * was parked because a DIFFERENT strand on the same booking is unreadable.
 *
 * ## Why this exists rather than "exact strands raise nothing"
 *
 * It closes a hole that silently destroyed money. The single-guest removal
 * settles a DIFFERENCE OF REPRICINGS, so one unreadable strand anywhere parks
 * the whole edit: nothing is settled, `priceDiffCents` is 0 and the booking's
 * stored total does not move. If the strand actually LEAVING is exact, it was
 * skipped by the unreadable-strand filter — and the delete that follows takes
 * its `BookingGuest` row and every `BookingGuestNight` row with it, while
 * `BookingModification.previousData` keeps only name, age tier and membership.
 * The departing member's refund was then a number no longer present anywhere in
 * the database, behind a task that named a REMAINING guest, carried no
 * surrendered nights, and read as "reviewed, nothing to adjust".
 *
 * So a parked edit records the departing strand too, with its real per-night
 * prices, and the invariant is: **a parked edit never destroys a number the
 * system could have known.**
 *
 * ## Not only the departing strand (#3166)
 *
 * A removal is one of three ways a parked edit destroys an exact strand's
 * evidence, and it was the only one this was raised for at first. The other two
 * are the ordinary pre-check-in edit: a strand that gives nights BACK has the
 * price stored against each of them deleted (both night writers delete every row
 * and recreate only the proposed ones), and a strand that GAINS nights against a
 * frozen stored total stops reconciling — it becomes
 * `PARTIAL_STORED_NIGHT_PRICES` and is unpriceable for good. Both destroy real
 * money evidence just as finally as a delete does, and neither is recoverable
 * from `BookingModification.previousData`, which keeps booking-level totals and
 * no per-night price at all. `preCheckInEditEvidence` decides which of the three
 * applies; this builder does not care which.
 *
 * ## Why it is a separate function rather than a `cause` argument
 *
 * The cause is not a choice the caller gets to make. `COUNTERPART_STRAND_UNREADABLE`
 * is true exactly when this strand's evidence is `exact`, and the three other
 * causes are true exactly when it is `unusable` — so the input type decides the
 * value, and neither function can be handed the other's case (`INV-SSOT`'s
 * "prefer unrepresentable over policed"). Both compose the identity through the
 * one body below, so a field spelled differently at one of them is impossible.
 *
 * ## What it deliberately does NOT do
 *
 * It carries no amount. The strand's stored total is on the evidence and an
 * admin can read it, but the money that goes back also depends on the
 * cancellation tier and the promo recalculation this parked path skipped — so
 * writing the gross figure into `amountCents` would be a policy guess dressed as
 * a fact, which is the thing epic #2797 exists to stop. The rows are preserved;
 * the person decides.
 */
export function counterpartStrandRecord(args: {
  bookingGuestId: string;
  evidence: Extract<StoredSoldPriceEvidence, { kind: "exact" }>;
  /** `BookingGuest.priceCents` as stored. */
  guestTotalCents: number;
  surrenderedNightDates: readonly CalendarDate[];
  addedNightDates: readonly CalendarDate[];
}): EditFinancialReviewStrandRecord {
  return composeStrandRecord({
    ...args,
    cause: "COUNTERPART_STRAND_UNREADABLE",
    nightPrices: args.evidence.nightPrices,
  });
}

/**
 * The one body both builders above compose a strand's record through.
 *
 * EVERY FIELD HERE IS EVIDENCE SOMEBODY LOSES IF IT STOPS BEING WRITTEN, which
 * is why `edit-financial-review-strand-census.test.ts` enumerates them against
 * this function's output rather than against a list written out by hand: a field
 * dropped here fails that census by name (#3498, owner decision D1's "no
 * evidence may be lost").
 */
function composeStrandRecord(args: {
  bookingGuestId: string;
  cause: EditFinancialReviewCause;
  guestTotalCents: number;
  surrenderedNightDates: readonly CalendarDate[];
  addedNightDates: readonly CalendarDate[];
  nightPrices: readonly { date: CalendarDate; priceCents: number | null }[];
}): EditFinancialReviewStrandRecord {
  return {
    bookingGuestId: args.bookingGuestId,
    cause: args.cause,
    surrenderedNightDates: args.surrenderedNightDates,
    addedNightDates: args.addedNightDates,
    storedEvidence: {
      guestTotalCents: isNonNegativeIntegerCents(args.guestTotalCents)
        ? args.guestTotalCents
        : null,
      nightPrices: args.nightPrices.map((night) => ({
        date: night.date,
        priceCents: night.priceCents,
      })),
    },
  };
}

/**
 * THE ONE PARKED EDIT'S OCCURRENCE, from every strand it recorded (#3498, owner
 * decision D1).
 *
 * ## What it decides, and what it deliberately does not
 *
 * It decides which strand LEADS and in what order the rest are carried. It does
 * NOT decide which strands are recorded, and it does not decide whether the edit
 * parks at all - both of those are the caller's, unchanged: a single unreadable
 * strand still parks the whole edit, and every strand the current code records
 * is still recorded. Handed an empty list it answers `null`, which is the shape
 * of an edit that prices normally.
 *
 * ## Why a lead has to be chosen at all
 *
 * A work item is one card with one **Record the adjustment** button, so
 * something has to be at the top of it. Until #3498 there was one card per
 * strand and the officer chose between them, which is precisely the near-miss
 * this issue exists to remove: on the live shape that prompted it, seven cards
 * carried the same evidence block and the only tell between them was one line
 * reading `Nights given back:` with dates instead of `none`.
 *
 * ## THE RANKING, and why it is this way round
 *
 * Lower is more urgent:
 *
 *  0. a strand whose own stored rows could not be read AND whose night set this
 *     edit moves. Money is owed on those nights and the system cannot say how
 *     much - the case the whole epic exists for;
 *  1. a strand whose night set this edit moves, whose own rows read perfectly
 *     (`COUNTERPART_STRAND_UNREADABLE`). The departing guest of a removal is
 *     this, and on the production booking it was the one item of seven that
 *     carried the real $140.00;
 *  2. a strand the edit does not move at all. It is recorded because
 *     `applyGuestChanges` deletes and recreates its rows, and it is the
 *     SUPPORTING DETAIL D1 names - six of the seven production items were this.
 *
 * Ties break on `bookingGuestId`, so the answer is a pure function of the strand
 * set rather than of the order the planner happened to walk the booking's
 * guests in. That matters beyond tidiness: `editFinancialReviewOccurrenceKey`
 * hashes the lead's fields separately from the rest, so a lead that moved with
 * the read order would make one edit hash two ways and a replay raise a second
 * task.
 *
 * A PURE GUEST ADD RANKS EVERYTHING AT 2 and still produces an item - which is
 * the case that rules out the tempting "filter to the strands the edit touched"
 * fix, because no existing strand moves and that filter would raise nothing at
 * all. What the add is worth rides on `EditFinancialReviewContext.guestsAddedByEdit`,
 * exactly as it did before.
 */
export function parkedEditOccurrence(args: {
  bookingId: string;
  strands: readonly EditFinancialReviewStrandRecord[];
}): EditFinancialReviewOccurrence | null {
  const ordered = [...args.strands].sort((left, right) => {
    const byRank = leadRank(left) - leadRank(right);
    if (byRank !== 0) return byRank;
    return left.bookingGuestId < right.bookingGuestId ? -1 : 1;
  });
  const [lead, ...otherStrands] = ordered;
  if (lead === undefined) return null;
  return {
    bookingId: args.bookingId,
    ...lead,
    // Absent rather than empty for a one-strand edit, so the stored row is
    // byte-identical to the shape every pre-#3498 reader already understands.
    ...(otherStrands.length > 0 ? { otherStrands } : {}),
  };
}

/** The ranking `parkedEditOccurrence` documents, and its only implementation. */
function leadRank(strand: EditFinancialReviewStrandRecord): number {
  const nightSetMoves =
    strand.surrenderedNightDates.length > 0 ||
    strand.addedNightDates.length > 0;
  if (!nightSetMoves) return 2;
  return strand.cause === "COUNTERPART_STRAND_UNREADABLE" ? 1 : 0;
}
