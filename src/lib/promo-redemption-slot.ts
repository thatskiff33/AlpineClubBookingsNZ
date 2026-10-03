import type { Prisma } from "@prisma/client";

import { readClubModuleSettingsRecord } from "@/config/modules";
import { ApiError } from "@/lib/api-error";
import { normalizeClubModuleSettings } from "@/lib/module-settings";

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
 * the second row (PromoRedemption_bookingId_key); this refusal replaces that
 * unique while the switch is off — but ONLY UNDER THE PRECONDITION BELOW.
 *
 * PRECONDITION — THE CALLER SERIALISES WRITERS TO THIS BOOKING. This is an
 * unlocked read-then-write: two transactions that each probe an empty booking
 * would both see "no redemption" and both write order 0, and the database no
 * longer refuses the second row (the new unique is per booking AND code, so two
 * DIFFERENT codes both land). It is safe only because every `redeemPromoCode`
 * caller either created the booking in the same transaction, so no other
 * transaction can see it yet (`booking-create.ts`), or holds the global
 * lifecycle lock `pg_advisory_xact_lock(1)` (the modify plan,
 * `booking-modify-plan.ts`, run under it by
 * `booking-batch-modification-service.ts`). The one other caller is the offline
 * demo seed (`prisma/demo-seed.ts`), a single writer on a booking it just made.
 * `redeem-promo-code-call-sites.test.ts`
 * enumerates those call sites and fails on a new one, so a writer added later
 * (C2 of epic #3813) has to establish the same precondition and extend that
 * allowlist on purpose.
 *
 * The switch is read only when the booking already holds a redemption, so a
 * single-code booking — every booking today — costs one indexed probe and
 * nothing else. A new code is appended after the last (D-3813-2: the booker's
 * order; a later child lets the booker choose it).
 */
export async function nextPromoApplicationOrder(
  tx: Prisma.TransactionClient,
  bookingId: string,
): Promise<number> {
  const last = await tx.promoRedemption.findFirst({
    where: { bookingId },
    orderBy: { applicationOrder: "desc" },
    select: { applicationOrder: true },
  });
  if (!last) return 0;
  // Normalised by the one module-settings normaliser: a club that has never
  // saved the Modules page reads the default, which is OFF — fail-closed.
  const { multiPromoCodes } = normalizeClubModuleSettings(
    await readClubModuleSettingsRecord(tx),
  );
  if (!multiPromoCodes) {
    throw new ApiError(SECOND_PROMO_CODE_REFUSED_MESSAGE, 409);
  }
  return last.applicationOrder + 1;
}
