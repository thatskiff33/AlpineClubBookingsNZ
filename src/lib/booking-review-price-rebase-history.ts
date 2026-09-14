import type { Prisma } from "@prisma/client";

import type { BookingMoneyBuildUpSelection } from "@/lib/booking-money-build-up";
import type { BookingPriceRebase } from "@/lib/booking-review-price-rebase";

export async function recordBookingPriceRebaseHistory({
  bookingId,
  actingMemberId,
  taskId,
  resolution,
  rebase,
  moneyBuildUpSelection,
  xeroInvoiceDiverged,
  store,
}: {
  bookingId: string;
  actingMemberId: string;
  taskId: string;
  resolution: "completed" | "dismissed";
  rebase: BookingPriceRebase;
  moneyBuildUpSelection: BookingMoneyBuildUpSelection;
  xeroInvoiceDiverged: boolean;
  store: Prisma.TransactionClient;
}): Promise<void> {
  await store.bookingModification.create({
    data: {
      bookingId,
      memberId: actingMemberId,
      modificationType: "PRICE_REBASE",
      previousData: {
        totalPriceCents: rebase.previousTotalPriceCents,
        discountCents: rebase.previousDiscountCents,
        promoAdjustmentCents: rebase.previousPromoAdjustmentCents,
        finalPriceCents: rebase.previousFinalPriceCents,
      },
      newData: {
        totalPriceCents: rebase.newTotalPriceCents,
        discountCents: rebase.newDiscountCents,
        promoAdjustmentCents: rebase.newPromoAdjustmentCents,
        finalPriceCents: rebase.newFinalPriceCents,
        promoRemoved: rebase.promoRemoved,
        xeroInvoiceDiverged,
        financialReviewTaskId: taskId,
        financialReviewResolution: resolution,
        // The signed movement of the booking's final price, kept HERE rather
        // than on `priceDiffCents` - see the docblock. Nothing that decides
        // whether money is owed reads `newData`.
        rebasedPriceMovementCents:
          rebase.newFinalPriceCents - rebase.previousFinalPriceCents,
        ...moneyBuildUpSelection.historyMetadata,
      },
      // NOT a settlement: no money is moved by this row, and the review's own
      // task carries what was settled. Both components stay 0 so no money
      // reader can mistake the re-base for an unbilled ask (docblock above).
      priceDiffCents: 0,
      changeFeeCents: 0,
    },
  });
}
