import {
  isNonNegativeIntegerCents,
  type EditFinancialReviewCause,
  type EditFinancialReviewOccurrence,
  type StoredNightPriceEvidence,
} from "@/lib/edit-financial-review-context";
import { requireCalendarDate, type CalendarDate } from "@/lib/club-time";
import {
  getExplicitGuestBedNightKeys,
  getGuestBedNightKeys,
  type BookingStayRange,
  type GuestNightInput,
} from "@/lib/booking-guest-stay-ranges";

/**
 * #3031 (epic #2797): can this guest strand's stored history price an edit
 * EXACTLY, and if not, why not — the one place that question is answered.
 *
 * ## What a stored `BookingGuestNight.priceCents` is, and is not
 *
 * It is the only per-night money this system keeps, and it is NOT provenanced.
 * Two of the three events that populated the table were themselves even splits:
 * `20260704150000_backfill_booking_guest_nights` (#1098) divided
 * `BookingGuest.priceCents` by the night count for guests with no rows, and
 * `20260810010000_backfill_booking_request_guest_nights` (#2739) did the same
 * for request-derived bookings — its own header says it "deliberately does NOT
 * reprice anything: it reads the stored total and divides it". There is no
 * `source` column, and `createdAt` does not separate a backfilled row from a
 * live one. So the database holds rows that are indistinguishable from what the
 * member was really quoted per night and are not that.
 *
 * Exactness therefore CANNOT be tested on provenance, and this module does not
 * try. It tests RECONCILIATION, which is what epic #2797 asks for in as many
 * words — "a deliberate negotiated-flat initial allocation remains valid once
 * stored", and "if required historical amount is missing/unusable or rows do
 * not reconcile … the financial adjustment becomes explicit pending admin
 * review":
 *
 * > A guest strand is EXACTLY priced when every night it holds carries a stored
 * > non-negative integer price and those prices sum to `BookingGuest.priceCents`
 * > to the cent. Anything else is `financial_review_required`.
 *
 * The visible consequence is deliberate: an evenly-split backfilled booking
 * reconciles, so it prices as exact. The alternative would be refusing to edit
 * a large share of historical bookings, which nothing in the epic asks for. What
 * the rule does buy is that no amount is ever RECONSTRUCTED — every cent this
 * module blesses was read from a row, and a strand whose rows do not add up is
 * handed to a person instead of to arithmetic.
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
};

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
 * THE ONE BUILDER for an `EditFinancialReviewOccurrence` (#3030), from an
 * unusable verdict and the two halves of the structural change (`INV-SSOT`).
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
export function editFinancialReviewOccurrence(args: {
  bookingId: string;
  bookingGuestId: string;
  evidence: Extract<StoredSoldPriceEvidence, { kind: "unusable" }>;
  /** `BookingGuest.priceCents` as stored. */
  guestTotalCents: number;
  surrenderedNightDates: readonly CalendarDate[];
  addedNightDates: readonly CalendarDate[];
}): EditFinancialReviewOccurrence {
  return composeOccurrence({
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
export function counterpartStrandReviewOccurrence(args: {
  bookingId: string;
  bookingGuestId: string;
  evidence: Extract<StoredSoldPriceEvidence, { kind: "exact" }>;
  /** `BookingGuest.priceCents` as stored. */
  guestTotalCents: number;
  surrenderedNightDates: readonly CalendarDate[];
  addedNightDates: readonly CalendarDate[];
}): EditFinancialReviewOccurrence {
  return composeOccurrence({
    ...args,
    cause: "COUNTERPART_STRAND_UNREADABLE",
    nightPrices: args.evidence.nightPrices,
  });
}

/** The one body both builders above compose the identity through. */
function composeOccurrence(args: {
  bookingId: string;
  bookingGuestId: string;
  cause: EditFinancialReviewCause;
  guestTotalCents: number;
  surrenderedNightDates: readonly CalendarDate[];
  addedNightDates: readonly CalendarDate[];
  nightPrices: readonly { date: CalendarDate; priceCents: number | null }[];
}): EditFinancialReviewOccurrence {
  return {
    bookingId: args.bookingId,
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
    }> | null;
  },
  booking: BookingStayRange,
): StoredSoldPriceEvidence {
  const priceByKey = storedNightPricesByKey(guest.nights);
  return classifyStoredSoldPriceEvidence(
    getGuestBedNightKeys(guest, booking).map((key) => ({
      date: requireCalendarDate(key),
      priceCents: priceByKey.get(key) ?? null,
    })),
    guest.priceCents,
  );
}

/**
 * What is stored against each night a guest already holds, by lodge-night key.
 *
 * `null` means the night carries NO USABLE STORED PRICE: no row, a row loaded
 * without its price, or a row whose value is not non-negative integer cents. The
 * three are one thing to every reader of this map, and the distinction from a
 * stored ZERO is the whole point of the null — zero is a real sold price (a
 * comped night), absence is not a price at all.
 *
 * KEYED THROUGH THE SAME CANONICAL HELPER that builds the night keys, one entry
 * at a time, rather than by re-deriving the key here. A price keyed even
 * slightly differently from its night would never match it, and the failure
 * would be silent — the night would quietly price at today's rate, which is the
 * defect INV-DATE-020 exists for.
 *
 * ONE PROJECTION (`INV-SSOT`). The planner and the removal path both need it and
 * had written it twice, already normalising differently.
 */
export function storedNightPricesByKey(
  nights: ReadonlyArray<GuestNightInput> | null | undefined,
): Map<string, number | null> {
  const byKey = new Map<string, number | null>();
  for (const entry of nights ?? []) {
    const priceCents =
      entry instanceof Date || typeof entry === "string"
        ? undefined
        : "priceCents" in entry
          ? entry.priceCents
          : undefined;
    const [key] = getExplicitGuestBedNightKeys({ nights: [entry] }) ?? [];
    if (key !== undefined) {
      byKey.set(key, isNonNegativeIntegerCents(priceCents) ? priceCents : null);
    }
  }
  return byKey;
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
 * known would otherwise be gone (`counterpartStrandReviewOccurrence`).
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
 * `occurrences` is EMPTY when every strand is exact — the edit prices normally.
 * A single unusable strand parks the whole edit, and then every OTHER strand
 * whose own rows were readable and whose evidence this edit destroys is recorded
 * too — removed, shortened or extended — so a parked edit never destroys a
 * number the system could have known. There is no amount anywhere in here.
 *
 * `soldNightPriceByGuestId` carries, per strand, the stored integer against each
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
  occurrences: EditFinancialReviewOccurrence[];
  soldNightPriceByGuestId: Map<string, ReadonlyMap<CalendarDate, number>>;
} {
  const unusable: EditFinancialReviewOccurrence[] = [];
  const destroyedButReadable: EditFinancialReviewOccurrence[] = [];
  const soldNightPriceByGuestId = new Map<
    string,
    ReadonlyMap<CalendarDate, number>
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
    );
    soldNightPriceByGuestId.set(
      strand.bookingGuestId,
      new Map(
        evidence.nightPrices.flatMap((night) =>
          isNonNegativeIntegerCents(night.priceCents)
            ? [[night.date, night.priceCents] as const]
            : [],
        ),
      ),
    );

    if (evidence.kind === "unusable") {
      unusable.push(
        editFinancialReviewOccurrence({
          bookingId: args.bookingId,
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
        counterpartStrandReviewOccurrence({
          bookingId: args.bookingId,
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
    occurrences:
      unusable.length > 0 ? [...unusable, ...destroyedButReadable] : [],
    soldNightPriceByGuestId,
  };
}

/**
 * The per-night vector a PARKED pre-check-in edit writes for one existing
 * strand (#3166).
 *
 * A night whose stored row carried usable money keeps that integer BYTE FOR
 * BYTE; every other night — one whose row could not be read, and one this edit
 * newly puts the strand on while its stored total is frozen — is `null`, which
 * `syncGuestNights` writes as `NULL`: not known. There is deliberately no
 * arithmetic here and no rate table in sight, so the only numbers that can
 * reach the column are ones already in it.
 *
 * The night key is derived through the SAME canonical helper the sold-price map
 * was keyed with. A key spelled even slightly differently would match nothing,
 * every night would come back `null`, and a parked edit would silently blank
 * price history it could have preserved — the failure would be invisible
 * (INV-DATE-020).
 */
export function preservedNightPrices(
  soldNightPrices: ReadonlyMap<CalendarDate, number> | undefined,
  nightDates: readonly Date[],
): (number | null)[] {
  return nightDates.map((night) => {
    const [key] = getExplicitGuestBedNightKeys({ nights: [night] }) ?? [];
    const cents = key === undefined ? undefined : soldNightPrices?.get(
      requireCalendarDate(key),
    );
    return cents === undefined ? null : cents;
  });
}

/**
 * Does this booking carry a night whose sold price is NOT KNOWN? (#3166,
 * `INV-MOD-028`.)
 *
 * A `NULL` in `BookingGuestNight.priceCents` is the column's own statement that
 * nobody knows what the night was sold for (#3170), and the rule it comes with
 * is absolute: **a blank is cleared only by a person supplying the amount, never
 * by a reprice.** A writer that re-prices a whole stay and rewrites every night
 * row would otherwise convert "not known" into a figure nobody decided, and the
 * next edit reads that column back as evidence of what the member paid.
 *
 * This is the predicate a wholesale night-row rewriter asks BEFORE it rewrites,
 * and it lives here rather than in each of them so that "what a blank is" has
 * one definition (`INV-SSOT`).
 *
 * ## Exactly a `NULL`, and deliberately not the wider class
 *
 * `storedSoldPriceEvidenceForGuest` treats a negative or non-integer row as an
 * ABSENCE of usable evidence too, and this does not. Those are damage from
 * pre-#2744 arithmetic, what to do about them is #2745's audited decision, and
 * this repository's standing answer is forward-only: nothing here repairs one
 * and nothing here refuses on account of one. A `NULL` is different in kind — it
 * was written deliberately, by a parked edit, to say that an amount is owed and
 * unknown.
 *
 * A row loaded WITHOUT its price is indistinguishable from a null one here, so
 * callers must load `priceCents`; every current caller loads whole night rows.
 */
export function carriesUnvaluedStoredNight(
  guests: ReadonlyArray<{
    nights?: ReadonlyArray<{ priceCents?: number | null }> | null;
  }>,
): boolean {
  return guests.some((guest) =>
    (guest.nights ?? []).some(
      (night) => night.priceCents === null || night.priceCents === undefined,
    ),
  );
}

/**
 * What a per-night vector position MEANS at the moment a night row is written —
 * the one statement of the three-way rule (#3031, #3170, #3166, `INV-SSOT`).
 *
 * Two writers ask it: `nightPriceCentsToWrite` in `booking-modify-plan.ts` (used
 * by `syncGuestNights`) and the `createMany` inside
 * `applyBookingDateModification`. Before this they each spelled the rule out,
 * and the second copy arrived with #3166 — so the decision that decides whether
 * a night's price is a number, a recorded blank, or a refusal had two homes
 * within one release of having one.
 *
 * The three answers, and why the last two are not the same absence:
 *
 *  - **a number** — the amount this night is being sold at, written as-is. There
 *    is no `?? 0` here and there never may be: a zero is a real financial number
 *    (a comped night), and writing one for a night nobody priced is the
 *    magic-zero defect under another name.
 *  - **`not-known`** — an explicit `null`, which is a DECISION. Only a parked
 *    composer produces one: the strand's stored total is frozen and this night's
 *    price genuinely is not known, so `NULL` is written and `INV-MOD-028`'s
 *    blank clause takes over. `buildIdentityOnlyPricing` also echoes stored
 *    blanks back byte for byte on a name-only correction — it creates no new
 *    blank, it declines to repair one.
 *  - **`unstated`** — `undefined`, because the vector is SHORTER than the night
 *    list or has a hole. Nobody decided anything; the breakdown is malformed,
 *    which is a wiring defect in whoever built it. It must REFUSE.
 *
 * Letting `unstated` fall through to `NULL` would turn every wiring defect into
 * an unpriced night, which is exactly the silent damage epic #2797 exists to
 * remove — so the unknown has to be SAID, never inferred from an absence.
 *
 * WHAT THIS DOES NOT DO IS THROW, and that is deliberate. The two call sites
 * owe their operators different failures: the modify plan raises an internal
 * `Error`, and the date path raises an `ApiError(400)` whose sentence
 * ("The new dates could not be priced night by night") is member-visible and
 * pinned by `phase8b-booking-mods.test.ts`. Those are a legitimate second
 * derivation; the DECISION they narrow is not, and it lives here.
 */
export type NightPriceToWrite =
  | { kind: "amount"; priceCents: number }
  | { kind: "not-known" }
  | { kind: "unstated" };

export function classifyNightPriceToWrite(
  cents: number | null | undefined,
): NightPriceToWrite {
  if (cents === null) return { kind: "not-known" };
  if (typeof cents !== "number") return { kind: "unstated" };
  return { kind: "amount", priceCents: cents };
}
