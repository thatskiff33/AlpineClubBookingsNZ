import {
  isNonNegativeIntegerCents,
  type EditFinancialReviewCause,
  type EditFinancialReviewOccurrence,
  type EditFinancialReviewStrandRecord,
  type StoredNightPriceEvidence,
} from "@/lib/edit-financial-review-context";
import { requireCalendarDate, type CalendarDate } from "@/lib/club-time";
import {
  getExplicitGuestBedNightKeys,
  getGuestBedNightKeys,
  type BookingStayRange,
} from "@/lib/booking-guest-stay-ranges";
import type { BookingGuestNightPriceSource } from "@prisma/client";
import { storedNightPriceDetailsByKey } from "@/lib/stored-night-price-write";

/**
 * #3031 (epic #2797): can this guest strand's stored history price an edit
 * EXACTLY, and if not, why not — the one place that question is answered.
 *
 * ## What a stored `BookingGuestNight.priceCents` is, and is not
 *
 * It is the only per-night money this system keeps. Since #3275 each row also
 * records its origin. Stage 3 of programme #3272 uses that origin at the grain
 * of the operation: reconciliation can prove a whole guest's stored total, but
 * an individual night is exact only when its row is `SOLD` or
 * `OFFICER_PRICED`. The two backfill migrations that divided stored guest
 * totals across nights (`20260704150000`, #1098, and `20260810010000`, #2739)
 * are therefore distinguishable from live quotes. Their `EVEN_SPLIT` rows may
 * support a reconciling whole-guest total and never prove one night's sold
 * price. `UNKNOWN` is treated the same way at individual-night grain and is
 * never re-derived from the amount, rate table, timestamp, or surrounding
 * data.
 *
 * > A guest strand is EXACTLY priced when every night it holds carries a stored
 * > non-negative integer price and those prices sum to `BookingGuest.priceCents`
 * > to the cent. Anything else is `financial_review_required`.
 *
 * The visible consequence is deliberate: removing an entire evenly-split
 * guest may use the reconciling guest total, while giving back one of those
 * nights parks for a person. No amount is reconstructed, and a strand whose
 * rows do not add up is also handed to a person instead of to arithmetic.
 *
 * ## Why "unusable" rather than "missing"
 *
 * `priceCents` is a bare `Int`: no non-negative constraint, and pre-#2744
 * arithmetic could write a negative row (an even split of a total a today's-rate
 * refund had driven below zero). A negative or non-integer row is not a cheap
 * night; it is a row that cannot be money. Treating it as evidence would invert
 * an edit — giving a night back would CHARGE the member — on a booking an
 * earlier defect had already damaged. It is therefore classified exactly like an
 * absent row, and NOTHING here rewrites it: what those rows should become is a
 * separate audited decision on #2745. This refuses; it does not repair.
 */

/**
 * One night the guest holds, and whatever is stored against it.
 *
 * The KEY IS DERIVED BY THE CALLER, on purpose. Every call site already holds
 * the guest's night keys from a canonical helper
 * (`getExplicitGuestBedNightKeys`, `lockedNightPricesForGuest`), and a key
 * re-derived here could differ from the one the caller matches prices against —
 * a mismatch that would be silent and would price the night at today's rate,
 * which is the exact failure INV-DATE-020 exists for. This module classifies;
 * it does not key.
 *
 * `priceCents` is `undefined` where no row exists for the night at all and the
 * stored value where one does — including a value that is not usable money.
 */
export type HeldNightPrice = {
  date: CalendarDate;
  priceCents: number | null | undefined;
  priceSource?: BookingGuestNightPriceSource;
};
export type StoredSoldPriceGrain = "WHOLE_GUEST" | "INDIVIDUAL_NIGHT";
/**
 * The verdict on one guest strand.
 *
 * A DISCRIMINATED UNION WITH NO AMOUNT ON THE UNUSABLE BRANCH, deliberately.
 * Epic #2797 prohibits a magic zero and prohibits an estimate, and the cheapest
 * way to honour both is to make the fake amount unrepresentable rather than
 * policed: there is no field a caller could read `?? 0` from.
 */
export type StoredSoldPriceEvidence =
  | {
      kind: "exact";
      /** Every held night with the price stored against it, in the order given. */
      nightPrices: ReadonlyArray<{ date: CalendarDate; priceCents: number }>;
      /** What those rows come to — equal to the strand's stored total. */
      totalCents: number;
    }
  | {
      kind: "unusable";
      cause: EditFinancialReviewCause;
      /** The evidence as it stands, for the review context (#3030). */
      nightPrices: ReadonlyArray<StoredNightPriceEvidence>;
    };

/**
 * Classify one guest strand's stored night rows against its stored total.
 *
 * `guestTotalCents` is `BookingGuest.priceCents` as stored. A strand holding no
 * nights at all reconciles only against a zero total: a guest carrying money
 * with nothing to show for it is exactly the unpriceable case, and a degenerate
 * stay envelope is one of the populations #3031 names.
 */
export function classifyStoredSoldPriceEvidence(
  heldNights: readonly HeldNightPrice[],
  guestTotalCents: number,
  grain: StoredSoldPriceGrain,
): StoredSoldPriceEvidence {
  const usable: Array<{ date: CalendarDate; priceCents: number }> = [];
  const evidence: StoredNightPriceEvidence[] = [];
  for (const night of heldNights) {
    if (isNonNegativeIntegerCents(night.priceCents)) {
      usable.push({ date: night.date, priceCents: night.priceCents });
      evidence.push({ date: night.date, priceCents: night.priceCents });
      continue;
    }
    // Null, not the stored number: `StoredNightPriceEvidence.priceCents` is
    // typed non-negative and the review context refuses anything else, so a
    // negative row is recorded as an ABSENCE of usable evidence rather than
    // smuggled into the admin's screen as if it were a price.
    evidence.push({ date: night.date, priceCents: null });
  }

  if (usable.length < heldNights.length) {
    return {
      kind: "unusable",
      cause:
        usable.length === 0
          ? "NO_STORED_NIGHT_PRICES"
          : "PARTIAL_STORED_NIGHT_PRICES",
      nightPrices: evidence,
    };
  }
  if (
    grain === "INDIVIDUAL_NIGHT" &&
    heldNights.some(
      (night) =>
        night.priceSource === "EVEN_SPLIT" || night.priceSource === "UNKNOWN",
    )
  ) {
    return {
      kind: "unusable",
      cause: "INEXACT_STORED_NIGHT_PRICES",
      nightPrices: evidence,
    };
  }
  if (heldNights.length === 0 && guestTotalCents !== 0) {
    // Nothing to reconcile against, and money on the strand. Named as the
    // absence it is rather than as a mismatch: there are no rows to disagree
    // with the total.
    return {
      kind: "unusable",
      cause: "NO_STORED_NIGHT_PRICES",
      nightPrices: evidence,
    };
  }

  const totalCents = usable.reduce((sum, night) => sum + night.priceCents, 0);
  if (totalCents !== guestTotalCents) {
    return {
      kind: "unusable",
      cause: "STORED_TOTAL_MISMATCH",
      nightPrices: evidence,
    };
  }

  return { kind: "exact", nightPrices: usable, totalCents };
}

/**
 * A verdict for a strand this module could not classify as unusable ITSELF, but
 * whose rows a caller has since found do not add up.
 *
 * The one caller is the planner's post-compose reconciliation check, which
 * discovers a mismatch only after composing the proposed rows. It is here rather
 * than there so the "which stored values count as money" rule is applied by the
 * module that owns it — a caller hand-rolling the union literal wrote a fourth,
 * weaker spelling of that rule and could have recorded a negative row as if it
 * were a price (`INV-SSOT`).
 */
export function unusableStoredSoldPriceEvidence(
  cause: EditFinancialReviewCause,
  heldNights: readonly HeldNightPrice[],
): Extract<StoredSoldPriceEvidence, { kind: "unusable" }> {
  return {
    kind: "unusable",
    cause,
    nightPrices: heldNights.map((night) => ({
      date: night.date,
      priceCents: isNonNegativeIntegerCents(night.priceCents)
        ? night.priceCents
        : null,
    })),
  };
}

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

/**
 * The strict twin of `lockedNightPricesForGuest` (#3031, E6).
 *
 * That function is LENIENT by design and stays that way: it turns whatever
 * prices a guest's rows carry into locks, and a night without one prices at
 * current policy. That is the right answer for a night the edit is genuinely
 * BUYING, and the wrong answer for a night it is giving BACK — where a missing
 * lock silently revalues history at today's rate, which epic #2797 prohibits.
 * The lenient reader cannot tell those apart, because it is handed no idea what
 * the edit is doing.
 *
 * So a path whose money depends on the guest's stored history being complete
 * asks THIS instead, and gets a verdict rather than a best effort. `unusable`
 * carries no locks at all, so there is nothing a caller can price with by
 * accident.
 *
 * The guest's held nights come from `getGuestBedNightKeys` itself — their
 * explicit `BookingGuestNight` rows where they have any, and their stay envelope
 * (falling back to the BOOKING's own range for a guest carrying neither)
 * otherwise. Calling the canonical helper rather than restating its rule is what
 * keeps these keys identical to the ones every other reader derives
 * (INV-DATE-020, `INV-SSOT`): a local `stayStart && stayEnd ? … : []` twin
 * classified a null-envelope strand as holding no nights at all, which for a
 * zero-priced strand reconciled to "exact" instead of asking for a person.
 */
export function storedSoldPriceEvidenceForGuest(
  guest: {
    /** `BookingGuest.priceCents` as stored. */
    priceCents: number;
    stayStart?: Date | null;
    stayEnd?: Date | null;
    /**
     * The guest's `BookingGuestNight` rows as loaded. Spelled out rather than
     * reusing `GuestNightInput`, which does not know about `priceCents` — a
     * caller building the rows as an object literal would be refused by the
     * excess-property check, and the price is the whole point here. Assignable
     * to `GuestNightInput` either way, which is what `getGuestBedNightKeys`
     * below needs.
     */
    nights?: ReadonlyArray<{
      stayDate: Date | string;
      priceCents?: number | null;
      priceSource?: BookingGuestNightPriceSource;
    }> | null;
  },
  booking: BookingStayRange,
  grain: StoredSoldPriceGrain,
): StoredSoldPriceEvidence {
  const detailsByKey = storedNightPriceDetailsByKey(
    guest.nights?.map((night) => ({
      ...night,
      priceSource: night.priceSource ?? "UNKNOWN",
    })),
  );
  return classifyStoredSoldPriceEvidence(
    getGuestBedNightKeys(guest, booking).map((key) => ({
      date: requireCalendarDate(key),
      priceCents: detailsByKey.get(key)?.priceCents ?? null,
      priceSource: detailsByKey.get(key)?.priceSource,
    })),
    guest.priceCents,
    grain,
  );
}

/**
 * One existing guest strand as an edit to a NOT-YET-STARTED booking proposes to
 * leave it (#3166, epic #2797).
 *
 * `proposedNightDates` is the night list the writer will actually persist for
 * this strand — `priceBreakdown.guests[i].nightDates`, the array
 * `syncGuestNights` consumes — and NOT a re-derivation of it. That is the whole
 * reason this type asks for it rather than for the request: a second derivation
 * of "which nights does this guest end up with" would be a second answer to a
 * question the pricing pass has already answered, and the gate would then be
 * judging an edit different from the one being written (`INV-SSOT`).
 *
 * A strand the edit REMOVES passes an empty list and sets `rowsDestroyed`, which
 * is what earns it a counterpart occurrence when some other strand parks the
 * edit — its rows are about to be deleted, so a number the system could have
 * known would otherwise be gone (`counterpartStrandRecord`).
 */
export type PreCheckInEditStrand = {
  bookingGuestId: string;
  /** `BookingGuest.priceCents` as stored. */
  guestTotalCents: number;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  nights?: ReadonlyArray<{
    stayDate: Date | string;
    priceCents?: number | null;
    priceSource: BookingGuestNightPriceSource;
  }> | null;
  /** The nights this strand ends up holding. Empty for a strand being removed. */
  proposedNightDates: ReadonlyArray<Date | string>;
  /**
   * True when the edit deletes this strand's rows outright (a removal).
   *
   * NOT the only way a parked edit destroys an exact strand's evidence, and not
   * the test for whether one is recorded — shortening and extending do it too.
   * See `evidenceDestroyed` in `preCheckInEditEvidence`.
   */
  rowsDestroyed?: boolean;
};

/**
 * The verdict on an edit to a booking that has NOT started yet (#3166, epic
 * #2797) — the pre-check-in twin of the in-progress planner's own evidence gate.
 *
 * ## Why every existing strand is judged, not only the ones giving nights back
 *
 * For exactly the reason the in-progress planner states: `applyGuestChanges`
 * DELETES AND RECREATES every existing guest's `BookingGuestNight` rows from the
 * per-night vector it is handed. A strand whose stored prices cannot be
 * preserved would therefore have its price history rewritten at today's rate by
 * an edit that never touched it — and the next edit would read those numbers
 * back as evidence of what the member paid. Preserving a row byte for byte and
 * having no row to preserve are different situations, and only the first can be
 * written.
 *
 * ## No carve-out for a strand this edit deliberately reprices
 *
 * A placeholder→member link (#2337) and an other-club rate election both CLEAR a
 * strand's locked night prices on purpose, so their nights price fresh under
 * current policy rather than from history. It is tempting to exempt them, and
 * this deliberately does not: the exemption would be a second rule about which
 * strands are judged, the flag that says a tick was honoured is written from
 * what pricing actually charged, and a parked edit charges nothing — so a
 * parked link or tick is recorded as un-honoured, which is exactly what
 * `otherLodgeRatedGuestIds` already promises. One rule, no exceptions to state.
 *
 * ## What it returns, and what it deliberately does not
 *
 * `occurrence` is NULL when every strand is exact — the edit prices normally.
 * A single unusable strand parks the whole edit, and then every OTHER strand
 * whose own rows were readable and whose evidence this edit destroys is recorded
 * too — removed, shortened or extended — so a parked edit never destroys a
 * number the system could have known. There is no amount anywhere in here.
 *
 * #3498: those records used to be returned as one occurrence EACH, which is what
 * made a seven-guest booking raise seven work items for one edit. They are
 * composed into one occurrence now, by `parkedEditOccurrence`, and nothing about
 * which strands are recorded changed with it.
 *
 * `storedNightPriceByGuestId` carries, per strand, the stored integer and source against each
 * night it holds — usable rows only, from either verdict, so a PARTIAL strand
 * keeps the rows it does have. It is the ONLY source of a historical amount for
 * the parked write, which is what makes "preserved byte for byte" true by
 * construction rather than by inspection.
 */
export function preCheckInEditEvidence(args: {
  bookingId: string;
  booking: BookingStayRange;
  strands: readonly PreCheckInEditStrand[];
}): {
  /**
   * The ONE occurrence a parked edit raises, or null when the edit prices
   * normally (#3498). It was a list until owner decision D1 moved the grain to
   * the edit; every strand that list held is on this one occurrence.
   */
  occurrence: EditFinancialReviewOccurrence | null;
  storedNightPriceByGuestId: Map<
    string,
    ReadonlyMap<
      CalendarDate,
      { priceCents: number; priceSource: BookingGuestNightPriceSource }
    >
  >;
} {
  const unusable: EditFinancialReviewStrandRecord[] = [];
  const destroyedButReadable: EditFinancialReviewStrandRecord[] = [];
  const storedNightPriceByGuestId = new Map<
    string,
    ReadonlyMap<
      CalendarDate,
      { priceCents: number; priceSource: BookingGuestNightPriceSource }
    >
  >();

  for (const strand of args.strands) {
    const heldKeys = getGuestBedNightKeys(strand, args.booking).map((key) =>
      requireCalendarDate(key),
    );
    const proposedKeys = getExplicitGuestBedNightKeys({
      nights: [...strand.proposedNightDates],
    })?.map((key) => requireCalendarDate(key)) ?? [];
    const heldSet = new Set<CalendarDate>(heldKeys);
    const proposedSet = new Set<CalendarDate>(proposedKeys);
    const surrenderedNightDates = heldKeys.filter(
      (key) => !proposedSet.has(key),
    );
    const addedNightDates = proposedKeys.filter((key) => !heldSet.has(key));

    const evidence = storedSoldPriceEvidenceForGuest(
      {
        priceCents: strand.guestTotalCents,
        stayStart: strand.stayStart,
        stayEnd: strand.stayEnd,
        nights: strand.nights,
      },
      args.booking,
      surrenderedNightDates.length === heldKeys.length &&
        addedNightDates.length === 0
        ? "WHOLE_GUEST"
        : "INDIVIDUAL_NIGHT",
    );
    storedNightPriceByGuestId.set(
      strand.bookingGuestId,
      new Map(
        [...storedNightPriceDetailsByKey(strand.nights)].flatMap(
          ([date, stored]) =>
            isNonNegativeIntegerCents(stored.priceCents)
              ? [
                  [
                    requireCalendarDate(date),
                    {
                      priceCents: stored.priceCents,
                      priceSource: stored.priceSource,
                    },
                  ] as const,
                ]
              : [],
        ),
      ),
    );

    if (evidence.kind === "unusable") {
      unusable.push(
        unpriceableStrandRecord({
          bookingGuestId: strand.bookingGuestId,
          evidence,
          guestTotalCents: strand.guestTotalCents,
          surrenderedNightDates,
          addedNightDates,
        }),
      );
      continue;
    }
    /**
     * Does this parked edit DESTROY what this exact strand's rows say?
     *
     * Three ways, and only the first was covered when #3166 first shipped:
     *
     *  - its rows are deleted outright (a removal);
     *  - it gives nights BACK. `syncGuestNights` and the date path both delete
     *    every one of its rows and recreate only the proposed ones, so the price
     *    stored against each surrendered night stops existing - and
     *    `BookingModification.previousData` keeps booking-level totals, never
     *    per-night prices;
     *  - it GAINS nights while its stored total is frozen. Every new night is
     *    written `NULL`, so a strand that reconciled exactly before the edit no
     *    longer does afterwards: it becomes `PARTIAL_STORED_NIGHT_PRICES` and is
     *    unpriceable for good, with real money owed and nothing recording what
     *    the strand used to be worth.
     *
     * A strand whose night set does not move keeps every row byte for byte, so
     * there is nothing to record and it raises nothing.
     */
    const evidenceDestroyed =
      strand.rowsDestroyed === true ||
      surrenderedNightDates.length > 0 ||
      addedNightDates.length > 0;
    if (evidenceDestroyed) {
      destroyedButReadable.push(
        counterpartStrandRecord({
          bookingGuestId: strand.bookingGuestId,
          evidence,
          guestTotalCents: strand.guestTotalCents,
          surrenderedNightDates,
          addedNightDates,
        }),
      );
    }
  }

  return {
    // Unchanged from before #3498 in the only respect that decides money: a
    // single unusable strand parks the whole edit, and nothing else does. What
    // changed is that the recorded strands are composed into ONE occurrence
    // instead of one each.
    occurrence:
      unusable.length > 0
        ? parkedEditOccurrence({
            bookingId: args.bookingId,
            strands: [...unusable, ...destroyedButReadable],
          })
        : null,
    storedNightPriceByGuestId,
  };
}


/**
 * The strands of a pre-check-in edit, assembled from what the booking holds and
 * what the pricing pass proposes — for `preCheckInEditEvidence` (#3166,
 * `INV-SSOT`).
 *
 * ## Why this is shared and the derivations around it are not
 *
 * The SAVE (`calculateModifiedPricing`) and the PREVIEW (`modify-quote`) must
 * agree exactly about which strands an edit is judged on, or one of them quotes
 * a price the other will not honour — the disagreement INV-MOD-028 exists to
 * make impossible. They used to build this list twice, ~40 identical lines each,
 * with no divergence yet: precisely the shape #3131 measured, where one of five
 * copies had already drifted. The predicate they feed it to was properly shared
 * from the start; the input to it was not.
 *
 * ## The proposed night set comes from the PRICING PASS, never re-derived
 *
 * `pricedGuests[i].nightDates` is the night set the edit really proposes and the
 * one `syncGuestNights` will write. Deriving it again here would be a second
 * answer to a question already answered, and a divergence between the two would
 * be silent — a strand judged against nights it does not end up holding.
 * `pricedGuests` is therefore INDEX-ALIGNED with `guestsForPricing`, exactly as
 * the pricing engine returns it; a guest with no `bookingGuestId` (a new
 * arrival, whose money is known) is skipped rather than shifting the alignment.
 *
 * ## Removed strands are appended, and only they carry `rowsDestroyed`
 *
 * The writer DELETES a removed guest's `BookingGuest` row and its night rows
 * cascade with it, so an exact strand leaving a parked edit is the one place a
 * number the system could have known is about to stop existing outright. The
 * other two ways a parked edit destroys evidence — surrendering nights and
 * gaining them — fall out of the proposed night set and are decided inside
 * `preCheckInEditEvidence`, not here.
 */
export function preCheckInEditStrands(args: {
  bookingGuests: ReadonlyArray<{
    id: string;
    priceCents: number;
    stayStart?: Date | null;
    stayEnd?: Date | null;
    nights?: ReadonlyArray<{
      stayDate: Date | string;
      priceCents?: number | null;
      priceSource: BookingGuestNightPriceSource;
    }> | null;
  }>;
  guestsForPricing: ReadonlyArray<{ bookingGuestId?: string | null }>;
  /** Index-aligned with `guestsForPricing`, as the pricing pass returns it. */
  pricedGuests: ReadonlyArray<{
    nightDates?: ReadonlyArray<Date | string> | null;
  }>;
  removeGuestIds?: Iterable<string> | null;
}): PreCheckInEditStrand[] {
  const storedGuestById = new Map(
    args.bookingGuests.map((guest) => [guest.id, guest]),
  );
  const removeSet = new Set(args.removeGuestIds ?? []);
  const strands: PreCheckInEditStrand[] = [];

  args.guestsForPricing.forEach((guest, index) => {
    const bookingGuestId = guest.bookingGuestId;
    if (!bookingGuestId) return;
    const stored = storedGuestById.get(bookingGuestId);
    if (!stored) return;
    strands.push({
      bookingGuestId,
      guestTotalCents: stored.priceCents,
      stayStart: stored.stayStart,
      stayEnd: stored.stayEnd,
      nights: stored.nights,
      proposedNightDates: args.pricedGuests[index]?.nightDates ?? [],
    });
  });

  for (const guest of args.bookingGuests) {
    if (!removeSet.has(guest.id)) continue;
    strands.push({
      bookingGuestId: guest.id,
      guestTotalCents: guest.priceCents,
      stayStart: guest.stayStart,
      stayEnd: guest.stayEnd,
      nights: guest.nights,
      proposedNightDates: [],
      rowsDestroyed: true,
    });
  }

  return strands;
}
