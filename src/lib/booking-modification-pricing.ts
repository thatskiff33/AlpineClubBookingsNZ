/**
 * An edit's priced sides, composed once and handed to both of their readers
 * (#3582): the stored `priceLines` (`computeModificationPriceLines`) and the
 * booking ledger (`postModificationLedgerLines`). Its own module only because
 * `booking-modification-lines.ts` is at its size budget.
 */
import {
  computeModificationPriceLines,
  diffBookingPricing,
  type ModificationLine,
  type ModificationPricingSide,
} from "@/lib/booking-modification-lines";

/** The two sides of one edit, as its site composed them. */
export type ModificationPricingSides = {
  before: ModificationPricingSide;
  after: ModificationPricingSide;
};

/**
 * `computeModificationPriceLines`, handing back the SIDES it diffed as well
 * (#3582), so the booking ledger posts from exactly the before and after the
 * stored lines were computed from - one composition per edit, not two that
 * could drift. `sides` is null where composing them threw; the lines are then
 * null too and the ledger posts nothing.
 */
export async function computeModificationPricing(
  context: { bookingId: string; site: string },
  buildSides: () => ModificationPricingSides | Promise<ModificationPricingSides>,
  expectedDeltaCents: number,
  log: Parameters<typeof computeModificationPriceLines>[2],
): Promise<{ priceLines: ModificationLine[] | null; sides: ModificationPricingSides | null }> {
  let sides: ModificationPricingSides | null = null;
  const priceLines = await computeModificationPriceLines(
    context,
    async () => {
      const composed = await buildSides();
      sides = composed;
      return diffBookingPricing(composed.before, composed.after, expectedDeltaCents);
    },
    log,
  );
  return { priceLines, sides };
}
