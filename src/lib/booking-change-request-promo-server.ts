import type { Prisma } from "@prisma/client";

import {
  promoChangeReadsMultiPromoSwitch,
  promoChangeRefusal,
  type CarriedPromoCode,
  type ChangeRequestPromoChange,
} from "@/lib/booking-change-request-promo";
import { multiPromoCodesEnabled } from "@/lib/promo-redemption-slot";

/**
 * #4533 review: `promoChangeRefusal` with the club's `multiPromoCodes` switch
 * read the way the edit reads it — only where the switch can change what the
 * change means (`promoRequestReadsMultiPromoSwitch`). Kept apart from
 * `booking-change-request-promo.ts`, which the browser bundle imports.
 *
 * `db` is the caller's client: the request route's, or the executor's
 * transaction (the edit reads the same switch on its own `tx`).
 */
export async function promoChangeRefusalFor(
  db: Prisma.TransactionClient,
  change: ChangeRequestPromoChange,
  carried: ReadonlyArray<CarriedPromoCode>,
): Promise<string | null> {
  const multiPromoCodes = promoChangeReadsMultiPromoSwitch(change, carried) ? await multiPromoCodesEnabled(db) : true;
  return promoChangeRefusal(change, carried, multiPromoCodes);
}
