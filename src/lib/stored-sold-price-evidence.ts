import {
  isNonNegativeIntegerCents,
  type EditFinancialReviewCause,
  type StoredNightPriceEvidence,
} from "@/lib/edit-financial-review-context";
import type { CalendarDate } from "@/lib/club-time";

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
 * `storedEvidence` for an `EditFinancialReviewOccurrence` (#3030), from a
 * verdict and the strand's stored total.
 *
 * `guestTotalCents` is null when the stored total is not usable money, because
 * the review context refuses a negative or fractional one — and a total that
 * cannot be represented is itself part of what the admin needs to know.
 */
export function storedEvidenceForOccurrence(
  verdict: StoredSoldPriceEvidence,
  guestTotalCents: number,
): {
  guestTotalCents: number | null;
  nightPrices: ReadonlyArray<StoredNightPriceEvidence>;
} {
  return {
    guestTotalCents: isNonNegativeIntegerCents(guestTotalCents)
      ? guestTotalCents
      : null,
    nightPrices: verdict.nightPrices.map((night) => ({
      date: night.date,
      priceCents: night.priceCents,
    })),
  };
}
