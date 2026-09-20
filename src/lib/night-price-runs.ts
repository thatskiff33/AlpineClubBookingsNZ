/**
 * THE ONE SPLITTER for a run of priced nights (#713, #1163; lifted out of
 * `xero-booking-invoices.ts` on #3530 so a booking edit's delta lines are cut
 * on exactly the same runs the original invoice's lines are).
 *
 * Pure: dates in, runs out, no database and no provider. Output is
 * byte-identical to the invoice builder's own before the move; the invoice
 * builder imports it back.
 */
import { formatDateOnly } from "@/lib/date-only";

export interface NightPriceRun {
  startDate: Date;
  endExclusive: Date;
  nightCount: number;
  totalCents: number;
  perNightCents: number;
}

export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Split a guest's included nights into maximal blocks of consecutive nights
 * that share the same nightly price (issue #713 date-contiguity + issue #1163
 * price-homogeneity). Each block becomes one Xero line item, so:
 *   - a non-contiguous stay reads as e.g. two lines
 *     "2 nights — 6 Jun – 8 Jun" and "2 nights — 13 Jun – 15 Jun", and
 *   - a stay crossing a price boundary (season change, or locked vs re-priced
 *     nights) splits at that boundary instead of averaging the rate.
 * Every returned run satisfies `perNightCents * nightCount === totalCents`, so a
 * line `{ quantity: nightCount, unitAmount: perNightCents / 100 }` reconciles to
 * the exact cent total by construction — no `round(total/n) * n` drift (#1163).
 * A fully contiguous, uniformly-priced guest still yields exactly one run, so
 * existing invoices are unchanged.
 */
export function splitNightsIntoPriceRuns(
  nights: Array<{ stayDate: Date; priceCents: number }>
): NightPriceRun[] {
  const sorted = [...nights].sort(
    (a, b) => a.stayDate.getTime() - b.stayDate.getTime()
  );
  const runs: NightPriceRun[] = [];
  for (const night of sorted) {
    const last = runs[runs.length - 1];
    const contiguous =
      last !== undefined &&
      formatDateOnly(new Date(last.endExclusive)) === formatDateOnly(night.stayDate);
    // Extend the current run only when the date is contiguous AND the nightly
    // price is unchanged; otherwise open a new run. This keeps every run a
    // single price over a whole number of nights.
    if (last && contiguous && last.perNightCents === night.priceCents) {
      last.endExclusive = new Date(night.stayDate.getTime() + ONE_DAY_MS);
      last.nightCount += 1;
      last.totalCents += night.priceCents;
    } else {
      runs.push({
        startDate: night.stayDate,
        endExclusive: new Date(night.stayDate.getTime() + ONE_DAY_MS),
        nightCount: 1,
        totalCents: night.priceCents,
        perNightCents: night.priceCents,
      });
    }
  }
  return runs;
}

/**
 * Split an integer cent total evenly across `count` nights using the
 * largest-remainder method: the first `remainder` nights carry one extra cent.
 * The returned vector always sums to `totalCents` exactly (no floating-point
 * cent accumulation). Callers must guarantee `count > 0`.
 */
export function evenlySplitCents(totalCents: number, count: number): number[] {
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => (i < remainder ? base + 1 : base));
}
