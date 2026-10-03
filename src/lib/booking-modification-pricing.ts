/**
 * An edit's priced sides, composed once and handed to both of their readers
 * (#3582): the stored `priceLines` (`computeModificationPriceLines`) and the
 * booking ledger (`postModificationLedgerLines`). Its own module only because
 * `booking-modification-lines.ts` is at its size budget.
 */
import {
  bookingPromoRedemptions,
  type PromoRedemptionCarrier,
} from "@/lib/booking-promo-redemptions";
import type { PromoSideCodes } from "@/lib/booking-modification-promo-delta";
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
  context: {
    bookingId: string;
    site: string;
    /**
     * #3828: where each code's own figure comes from — the booking snapshot the
     * edit loaded before it wrote anything, and the transaction to re-read the
     * redemptions the edit has just re-priced. With it, an edit on a
     * several-code booking stores one `PROMO_DELTA` per code that moved.
     */
    promoCodes?: { store: PromoRedemptionStore; before: PromoRedemptionCarrier<PromoSideRedemption> };
  },
  buildSides: () => ModificationPricingSides | Promise<ModificationPricingSides>,
  expectedDeltaCents: number,
  log: Parameters<typeof computeModificationPriceLines>[2],
): Promise<{ priceLines: ModificationLine[] | null; sides: ModificationPricingSides | null }> {
  let sides: ModificationPricingSides | null = null;
  const priceLines = await computeModificationPriceLines(
    { bookingId: context.bookingId, site: context.site },
    async () => {
      const composed = await withPromoCodeSides(await buildSides(), context);
      sides = composed;
      return diffBookingPricing(composed.before, composed.after, expectedDeltaCents);
    },
    log,
  );
  return { priceLines, sides };
}

/** The one read this needs: the booking's redemptions, inside the edit's transaction. */
type PromoRedemptionStore = {
  promoRedemption: {
    findMany(args: {
      where: { bookingId: string };
      select: {
        id: true;
        applicationOrder: true;
        priceAdjustmentCents: true;
        promoCode: { select: { code: true } };
      };
    }): Promise<ReadonlyArray<PromoSideRedemption>>;
  };
};

/** A redemption as an edit's snapshot carries it. */
type PromoSideRedemption = {
  id?: string | null;
  applicationOrder?: number | null;
  priceAdjustmentCents: number;
  promoCode?: { code: string } | null;
};

function promoSideCodes(
  carrier: PromoRedemptionCarrier<PromoSideRedemption> | null | undefined,
): PromoSideCodes {
  return bookingPromoRedemptions(carrier).flatMap((redemption) =>
    redemption.promoCode
      ? [{ code: redemption.promoCode.code, amountCents: redemption.priceAdjustmentCents }]
      : [],
  );
}

/**
 * Attach each side's per-code figures, but ONLY where either side carries more
 * than one code: a one-code edit's sides — and so its stored lines and its
 * ledger postings — are exactly what its site composed. The after side is
 * re-read in the edit's own transaction, after its re-price was written; a
 * read that cannot be made leaves the sides as composed, so the edit stores the
 * single aggregate line rather than none.
 */
async function withPromoCodeSides(
  sides: ModificationPricingSides,
  context: Parameters<typeof computeModificationPricing>[0],
): Promise<ModificationPricingSides> {
  if (!context.promoCodes) return sides;
  const before = promoSideCodes(context.promoCodes.before);
  if (before.length === 0 && sides.after.promoAdjustmentCents === 0) return sides;
  let after: PromoSideCodes;
  try {
    const rows = await context.promoCodes.store.promoRedemption.findMany({
      where: { bookingId: context.bookingId },
      select: {
        id: true,
        applicationOrder: true,
        priceAdjustmentCents: true,
        promoCode: { select: { code: true } },
      },
    });
    if (!Array.isArray(rows)) return sides;
    after = promoSideCodes({ promoRedemptions: rows });
  } catch {
    return sides;
  }
  if (before.length <= 1 && after.length <= 1) return sides;
  return {
    before: { ...sides.before, promoByCode: before },
    after: { ...sides.after, promoByCode: after },
  };
}
