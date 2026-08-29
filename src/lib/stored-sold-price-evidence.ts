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
  type GuestStayRange,
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
  return {
    bookingId: args.bookingId,
    bookingGuestId: args.bookingGuestId,
    cause: args.evidence.cause,
    surrenderedNightDates: args.surrenderedNightDates,
    addedNightDates: args.addedNightDates,
    storedEvidence: {
      guestTotalCents: isNonNegativeIntegerCents(args.guestTotalCents)
        ? args.guestTotalCents
        : null,
      nightPrices: args.evidence.nightPrices.map((night) => ({
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
  guest: GuestStayRange & { priceCents: number },
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
