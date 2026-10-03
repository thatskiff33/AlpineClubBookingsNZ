import type { Prisma } from "@prisma/client";

import { releasePromoRedemptions } from "@/lib/promo";

export type DraftBookingForCleanup = {
  id: string;
  // Every redemption the draft carries (#3826: one per promo code).
  promoRedemptions: Array<{ id: string; promoCodeId: string }>;
};

export type DraftBookingDependentCleanupSummary = {
  bookingIds: string[];
  promoRedemptions: number;
  changeRequests: number;
  modifications: number;
  events: number;
};

export async function deleteDraftBookingDependents(
  tx: Prisma.TransactionClient,
  drafts: DraftBookingForCleanup[],
): Promise<DraftBookingDependentCleanupSummary> {
  const bookingIds = drafts.map((draft) => draft.id);
  if (bookingIds.length === 0) {
    return {
      bookingIds,
      promoRedemptions: 0,
      changeRequests: 0,
      modifications: 0,
      events: 0,
    };
  }

  let promoRedemptions = 0;
  for (const draft of drafts) {
    await releasePromoRedemptions(tx, draft.promoRedemptions);
    promoRedemptions += draft.promoRedemptions.length;
  }

  const changeRequestResult = await tx.bookingChangeRequest.deleteMany({
    where: { bookingId: { in: bookingIds } },
  });
  const modificationResult = await tx.bookingModification.deleteMany({
    where: { bookingId: { in: bookingIds } },
  });
  // BookingEvent uses onDelete: Restrict (issue #740), so its rows must be
  // removed before the draft booking can be hard-deleted.
  const eventResult = await tx.bookingEvent.deleteMany({
    where: { bookingId: { in: bookingIds } },
  });

  return {
    bookingIds,
    promoRedemptions,
    changeRequests: changeRequestResult.count,
    modifications: modificationResult.count,
    events: eventResult.count,
  };
}
