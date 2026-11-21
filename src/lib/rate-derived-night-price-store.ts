import "server-only";
import type { BookingGuestNightPriceSource, Prisma } from "@prisma/client";

/**
 * #3531 3b: the rate-derived backfill's write, and nothing else.
 *
 * It lived in `stored-night-price-repair-store.ts` because that was the module
 * that rewrote a night row in place, and the census wanted one such module. It
 * moved here on #4344 because that module is the officer review's closure
 * pricing, which is being retired, while this writer serves the backfill that
 * outlives it. `stored-night-price-repair-census.test.ts` names this file as the
 * second permitted in-place writer and pins the shape that makes it safe: it
 * never fills a NULL.
 *
 * NO ADVISORY LOCK IS TAKEN HERE. Every write is a compare-and-set on the price
 * and provenance the row was planned from, so a concurrent change to a night
 * matches nothing and rolls the caller's transaction back.
 */

/** Thrown when a planned row no longer holds what it was planned from. */
export class RateDerivedBackfillRacedError extends Error {
  constructor(bookingGuestId: string, nightId: string) {
    super(`Night ${nightId} of guest ${bookingGuestId} changed since it was planned; booking rolled back`);
    this.name = "RateDerivedBackfillRacedError";
  }
}

type RateDerivedNightRewrite = {
  bookingGuestId: string;
  nights: ReadonlyArray<{
    id: string;
    fromPriceCents: number;
    fromSource: BookingGuestNightPriceSource;
    toPriceCents: number;
  }>;
};

/**
 * Rewrite planned rows as `RATE_DERIVED`, every one a compare-and-set on the
 * price and provenance it was planned from: a row that no longer holds what it
 * was read holding matches nothing, and the caller's transaction rolls back.
 * Never fills a NULL: the planner lists such a strand instead
 * (`INV-MOD-028`), and the fence's `fromPriceCents` is an integer.
 */
export async function applyRateDerivedNightRewrites(
  rewrites: ReadonlyArray<RateDerivedNightRewrite>,
  store: Pick<Prisma.TransactionClient, "bookingGuestNight">,
): Promise<number> {
  let rows = 0;
  for (const strand of rewrites) {
    for (const night of strand.nights) {
      const written = await store.bookingGuestNight.updateMany({
        where: {
          id: night.id,
          bookingGuestId: strand.bookingGuestId,
          priceCents: night.fromPriceCents,
          priceSource: night.fromSource,
        },
        data: { priceCents: night.toPriceCents, priceSource: "RATE_DERIVED" },
      });
      if (written.count !== 1) {
        throw new RateDerivedBackfillRacedError(strand.bookingGuestId, night.id);
      }
      rows += 1;
    }
  }
  return rows;
}
