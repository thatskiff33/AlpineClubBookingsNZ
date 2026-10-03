import type { Prisma } from "@prisma/client";

import {
  DEFAULT_MODULE_SETTINGS,
  readClubModuleSettingsRecord,
} from "@/config/modules";
import { ApiError } from "@/lib/api-error";

/** The refusal `redeemPromoCode` gives a second code while `multiPromoCodes` is off. */
export const SECOND_PROMO_CODE_REFUSED_MESSAGE =
  "This booking already carries a promo code.";

/**
 * Where a new redemption sits in the booking's application order — or a
 * refusal, when the booking already carries a code and the club has not
 * switched on several codes per booking (#3826, epic #3813).
 *
 * THE ROLLOUT SWITCH'S ONE ENFORCEMENT POINT. `redeemPromoCode` (`promo.ts`) is
 * the only writer that creates a PromoRedemption row and calls this before it
 * does, so refusing here is what keeps the database free of multi-code bookings
 * while `multiPromoCodes` is off — which is what keeps the previously deployed
 * release, that reads the redemption as one-to-one, correct through a
 * blue-green cut-over and a rollback. Before #3826 the database itself refused
 * the second row (PromoRedemption_bookingId_key); this refusal stands in for
 * that unique while the switch is off.
 *
 * The switch is read only when the booking already holds a redemption, so a
 * single-code booking — every booking today — costs one indexed probe and
 * nothing else. A new code is appended after the last (D-3813-2: the booker's
 * order; a later child lets the booker choose it).
 */
export async function nextPromoApplicationOrder(
  tx: Pick<Prisma.TransactionClient, "promoRedemption" | "clubModuleSettings">,
  bookingId: string,
): Promise<number> {
  const last = await tx.promoRedemption.findFirst({
    where: { bookingId },
    orderBy: { applicationOrder: "desc" },
    select: { applicationOrder: true },
  });
  if (!last) return 0;
  const settings = await readClubModuleSettingsRecord(tx);
  const multiPromoCodes =
    settings?.multiPromoCodes ?? DEFAULT_MODULE_SETTINGS.multiPromoCodes;
  if (!multiPromoCodes) {
    throw new ApiError(SECOND_PROMO_CODE_REFUSED_MESSAGE, 409);
  }
  return last.applicationOrder + 1;
}
