import type { PromoCodeAdjustment } from "@/lib/booking-money-lines";
import {
  bookingPromoCodeLabel,
  bookingPromoRedemptions,
} from "@/lib/booking-promo-redemptions";

/**
 * #2267: the promo options a booking-confirmation email needs, read off a
 * booking once.
 *
 * Callers hand-rolled this bag at every confirmation send site, and two of them
 * — the confirm-pending cron and the admin confirm-pending-guests route —
 * carried it verbatim, so a promo shape fixed in one could stay broken in the
 * other. The promo fields are supplied only when the booking actually redeemed
 * a promo code, so a booking without one renders no promo lines at all.
 *
 * Deliberately a standalone, dependency-free module rather than part of the
 * email barrel: it composes data, sends nothing, and tests that stub the email
 * module (to avoid its send machinery) still get the real behaviour here.
 *
 * #3826: a booking may carry several codes; `promoCode` names them all, in
 * application order, through `bookingPromoCodeLabel` — exactly the one code a
 * single-code booking always showed. #3828: such a booking also carries
 * `promoLines`, each code's own adjustment, so the confirmation shows one row
 * per code; a single-code booking's fields are exactly what they always were.
 */
type BookingPromoEmailSource = {
  discountCents: number;
  promoAdjustmentCents: number;
  promoRedemptions?: ReadonlyArray<{
    id?: string | null;
    applicationOrder?: number | null;
    // Required so a send site cannot load the codes without their figures.
    priceAdjustmentCents: number;
    promoCode?: { code: string } | null;
  }> | null;
};

/**
 * The promo fields alone, for a send site that builds the rest of its options
 * itself. Empty when the booking carries no code.
 */
export function bookingPromoEmailFields(booking: BookingPromoEmailSource): {
  discountCents?: number;
  promoAdjustmentCents?: number;
  promoCode?: string;
  promoLines?: PromoCodeAdjustment[];
} {
  const promoCode = bookingPromoCodeLabel(booking);
  const promoLines = bookingPromoRedemptions(booking).flatMap((redemption) =>
    redemption.promoCode
      ? [{ code: redemption.promoCode.code, amountCents: redemption.priceAdjustmentCents }]
      : [],
  );
  return promoCode
    ? {
        discountCents: booking.discountCents,
        promoAdjustmentCents: booking.promoAdjustmentCents,
        promoCode,
        ...(promoLines.length > 1 ? { promoLines } : {}),
      }
    : {};
}

export function bookingPromoEmailOptions(
  booking: BookingPromoEmailSource & { lodgeId: string | null },
): {
  lodgeId: string | null;
  discountCents?: number;
  promoAdjustmentCents?: number;
  promoCode?: string;
  promoLines?: PromoCodeAdjustment[];
} {
  return {
    lodgeId: booking.lodgeId,
    ...bookingPromoEmailFields(booking),
  };
}
