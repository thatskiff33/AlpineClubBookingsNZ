import {
  isNonNegativeIntegerCents,
  type EditFinancialReviewCause,
  type StoredNightPriceEvidence,
} from "@/lib/edit-financial-review-context";
import { requireCalendarDate, type CalendarDate } from "@/lib/club-time";
import {
  getGuestBedNightKeys,
  type BookingStayRange,
} from "@/lib/booking-guest-stay-ranges";
import type { BookingGuestNightPriceSource } from "@prisma/client";
import { storedNightPriceDetailsByKey } from "@/lib/stored-night-price-write";

/**
 * #3031 (epic #2797): does this guest strand's stored history reconcile EXACTLY,
 * and if not, why not — the one place that question is answered.
 *
 * Since #4317 (epic #4302) no EDIT asks it to decide whether to price: every
 * edit values its nights through `valueStrandNights`, whose R1 is this
 * classifier's `exact` verdict (`INV-MOD-028`). Its other readers are the
 * review re-base and its census, the night-price provenance census, the ledger
 * line differ and the rate-derived backfill; waves C and D retire what is left
 * of the review side.
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
 * > to the cent. Anything else is `unusable`, with its cause.
 *
 * An edit no longer parks on `unusable` (#4317): `valueStrandNights` values
 * such a strand by its R2/R3 rule instead.
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
 * (`getExplicitGuestBedNightKeys`, `getGuestBedNightKeys`), and a key
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
 * At `INDIVIDUAL_NIGHT` grain, does this row's origin disprove its own sold
 * price? The two backfill origins do (the docblock above); a live quote or an
 * officer's figure does not. A row with no origin recorded is not judged here -
 * both readers treat it as they always did. The one home for the rule, read by
 * this module's classifier and by the edit-lines diff (#3530, `INV-SSOT`).
 */
export const INEXACT_NIGHT_PRICE_SOURCES = ["EVEN_SPLIT", "UNKNOWN"] as const satisfies readonly BookingGuestNightPriceSource[];

export function storedNightPriceSourceIsInexact(
  source: BookingGuestNightPriceSource | undefined,
): boolean {
  return source !== undefined && (INEXACT_NIGHT_PRICE_SOURCES as readonly string[]).includes(source);
}
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
    heldNights.some((night) => storedNightPriceSourceIsInexact(night.priceSource))
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
 * One guest's verdict, from the guest as loaded (#3031, E6). A reader whose
 * money depends on the stored history being complete asks this and gets a
 * verdict rather than a best effort; `unusable` carries no amount.
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
