import { compareCalendarDates, type CalendarDate } from "@/lib/club-time";
import { evenlySplitCents } from "@/lib/night-price-runs";
import {
  classifyStoredSoldPriceEvidence,
  type HeldNightPrice,
} from "@/lib/stored-sold-price-evidence";

/**
 * #4305 (epic #4302, owner decision D1, 23 Oct 2026): what each night a guest
 * holds is worth, read from what is stored, and always adding up to the
 * guest's stored total. `INV-MOD-028` states the rule; this is its one home.
 *
 * - **R1, rows add up.** Every night has a usable stored row and the rows sum
 *   to `BookingGuest.priceCents`: the rows are the values, whatever their
 *   provenance.
 * - **R2, some nights unvalued.** Otherwise, when some nights have no usable
 *   row and the usable rows sum to no more than the total, the usable rows keep
 *   their figures and the remainder is split evenly over the unvalued nights.
 * - **R3, fallback.** Otherwise the whole total is split evenly over every
 *   night held.
 * - **Negative total (D11).** Every night is worth $0, and the result is
 *   flagged for #2745 rather than turned into a charge for giving a night back.
 *
 * ## What it reuses rather than restates (`INV-SSOT-001`)
 *
 * - "Which stored value is usable money, and do the rows reconcile" is
 *   `classifyStoredSoldPriceEvidence`'s question. R1 is exactly its `exact`
 *   verdict, and an unusable row (missing, `NULL`, negative, non-integer) is
 *   whatever it reports as `null`. It is asked at `WHOLE_GUEST` grain always,
 *   not through `editStrandEvidenceGrain`: provenance never decides a value
 *   under D1, and `WHOLE_GUEST` is the grain that does not read it.
 * - The even split is `evenlySplitCents`, the largest-remainder rule the
 *   night-row backfills and the Xero synthetic lines already use: leftover
 *   cents go one each on the earliest nights.
 * - Night keys are the caller's, from the canonical helpers, for the reason
 *   `HeldNightPrice` gives (INV-DATE-020). "Earliest" is
 *   `compareCalendarDates` order, so the nights may arrive in any order and
 *   are returned in the order given.
 *
 * Pure: no clock, no database, no rate table.
 */

/** Which branch of the rule valued the strand. */
export type StrandNightValuationRule =
  | "R1_STORED_ROWS"
  | "R2_FILL_UNVALUED"
  | "R3_EVEN_SPLIT"
  | "NEGATIVE_TOTAL";

/** Where one night's value came from. */
export type StrandNightValueBasis =
  /** The night's own stored row, unchanged. */
  | "STORED_ROW"
  /** A share of an even split (R2's remainder, or R3's whole total). */
  | "SPLIT"
  /** $0 because the stored guest total is negative (D11). */
  | "NEGATIVE_TOTAL";

export type ValuedStrandNight = {
  date: CalendarDate;
  valueCents: number;
  basis: StrandNightValueBasis;
};

export type StrandNightValuation = {
  rule: StrandNightValuationRule;
  /**
   * Set only on a negative stored total, the one case the values do not sum to
   * it. A caller surfaces it for #2745 and never prices from the total.
   */
  flag: "NEGATIVE_STORED_TOTAL" | null;
  /** Every held night, in the order given. */
  nights: ReadonlyArray<ValuedStrandNight>;
  /** The values' sum: the stored total, or 0 under `NEGATIVE_TOTAL`. */
  totalCents: number;
};

/**
 * Value every night one guest holds.
 *
 * `guestTotalCents` is `BookingGuest.priceCents` as stored. `heldNights` is
 * every night the guest holds, each with whatever row is stored against it
 * (`priceCents` `undefined` where there is no row at all).
 *
 * Throws, rather than inventing a figure, where no answer can reconcile: a
 * non-integer total, a night listed twice, or money on a strand holding no
 * nights.
 */
export function valueStrandNights(
  heldNights: readonly HeldNightPrice[],
  guestTotalCents: number,
): StrandNightValuation {
  if (!Number.isSafeInteger(guestTotalCents)) {
    throw new RangeError(
      `valueStrandNights: the stored guest total must be integer cents, got ${guestTotalCents} (INV-MOD-028).`,
    );
  }
  const seen = new Set<CalendarDate>();
  for (const night of heldNights) {
    if (seen.has(night.date)) {
      throw new RangeError(
        `valueStrandNights: night ${night.date} is listed twice; each held night is valued once (INV-MOD-028).`,
      );
    }
    seen.add(night.date);
  }

  if (guestTotalCents < 0) {
    return {
      rule: "NEGATIVE_TOTAL",
      flag: "NEGATIVE_STORED_TOTAL",
      nights: heldNights.map((night) => ({
        date: night.date,
        valueCents: 0,
        basis: "NEGATIVE_TOTAL",
      })),
      totalCents: 0,
    };
  }
  if (heldNights.length === 0) {
    if (guestTotalCents === 0) {
      return { rule: "R1_STORED_ROWS", flag: null, nights: [], totalCents: 0 };
    }
    throw new RangeError(
      "valueStrandNights: a strand holding no nights cannot carry a non-zero stored total (INV-MOD-028).",
    );
  }

  const evidence = classifyStoredSoldPriceEvidence(
    heldNights,
    guestTotalCents,
    "WHOLE_GUEST",
  );
  if (evidence.kind === "exact") {
    return {
      rule: "R1_STORED_ROWS",
      flag: null,
      nights: evidence.nightPrices.map((night) => ({
        date: night.date,
        valueCents: night.priceCents,
        basis: "STORED_ROW",
      })),
      totalCents: guestTotalCents,
    };
  }

  switch (evidence.cause) {
    case "NO_STORED_NIGHT_PRICES":
    case "PARTIAL_STORED_NIGHT_PRICES": {
      const rowSum = evidence.nightPrices.reduce(
        (sum, night) => (night.priceCents === null ? sum : sum + night.priceCents),
        0,
      );
      return rowSum <= guestTotalCents
        ? splitOver(evidence.nightPrices, guestTotalCents, "R2_FILL_UNVALUED")
        : splitOver(evidence.nightPrices, guestTotalCents, "R3_EVEN_SPLIT");
    }
    case "STORED_TOTAL_MISMATCH":
      return splitOver(evidence.nightPrices, guestTotalCents, "R3_EVEN_SPLIT");
    case "INEXACT_STORED_NIGHT_PRICES":
    case "COUNTERPART_STRAND_UNREADABLE":
      // Neither is reachable at WHOLE_GUEST grain from the classifier. Named so
      // a new cause fails to compile here instead of falling through.
      throw new Error(
        `valueStrandNights: unexpected classifier cause ${evidence.cause} at WHOLE_GUEST grain (INV-MOD-028).`,
      );
    default: {
      const unhandled: never = evidence.cause;
      throw new Error(`valueStrandNights: unhandled cause ${String(unhandled)}`);
    }
  }
}

/**
 * R2 keeps every usable row and splits what the total has left over them
 * across the unvalued nights; R3 keeps no row and splits the whole total. Both
 * put leftover cents on the earliest split nights and return the nights in
 * the order given. `priceCents` is `null` exactly where the classifier found
 * no usable row.
 */
function splitOver(
  nights: ReadonlyArray<{ date: CalendarDate; priceCents: number | null }>,
  guestTotalCents: number,
  rule: "R2_FILL_UNVALUED" | "R3_EVEN_SPLIT",
): StrandNightValuation {
  const keepRows = rule === "R2_FILL_UNVALUED";
  let keptCents = 0;
  const splitDates: CalendarDate[] = [];
  for (const night of nights) {
    if (keepRows && night.priceCents !== null) keptCents += night.priceCents;
    else splitDates.push(night.date);
  }
  splitDates.sort(compareCalendarDates);
  const shares = evenlySplitCents(guestTotalCents - keptCents, splitDates.length);
  const shareByDate = new Map(
    splitDates.map((date, index) => [date, shares[index]] as const),
  );
  return {
    rule,
    flag: null,
    nights: nights.map((night): ValuedStrandNight => {
      const share = shareByDate.get(night.date);
      if (share === undefined && night.priceCents !== null) {
        return { date: night.date, valueCents: night.priceCents, basis: "STORED_ROW" };
      }
      if (share === undefined) {
        throw new Error(`valueStrandNights: night ${night.date} was left unvalued (INV-MOD-028).`);
      }
      return { date: night.date, valueCents: share, basis: "SPLIT" };
    }),
    totalCents: guestTotalCents,
  };
}
