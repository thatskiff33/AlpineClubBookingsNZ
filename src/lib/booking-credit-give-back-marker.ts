import type { Prisma } from "@prisma/client";

/** What a paid booking's price reduction gave back of its applied credit (#3809). */
export type PaidReductionCreditGiveBack = {
  /** The credit slice the tier applies to: the reduction the card basis left, capped at the credit applied. */
  basisCents: number;
  givenBackCents: number;
};

/**
 * #3809 (owner decision of 4 Oct 2026, "Cap new reductions only"): WHICH
 * BOOKINGS A CANCELLATION CAPS. The card rule `INV-PAY-114` caps the applied
 * credit a cancellation tiers at what the booking is now worth - but only where
 * the booking's price was lowered through #3809's settlement of applied credit.
 * A credit-paid booking reduced before that release keeps `main`'s
 * cancellation, which tiers all the credit still applied.
 *
 * THE RECORD IS THE EDIT'S OWN HISTORY ROW, `BookingModification.newData` (a
 * JSON column, so no migration), under one key written only here. Not the
 * give-back's credit row, for three reasons: at a tier that returns nothing
 * (0%), or where a captured card payment covers the whole reduction, the
 * settlement writes no credit row at all, yet the booking still holds credit
 * above its new price and must be capped like a card-paid one; no existing
 * credit column tells the row apart from the clamp's or a review's
 * (`sourceBookingId` is #3791's review marker, `sourceBookingModificationId` is
 * unique and taken by a credit election's minted row on the same edit); and a
 * row's description is rewritten by the Xero inbound repair. A history row is
 * written once and never edited.
 */
const HISTORY_KEY = "appliedCreditGiveBack" as const;

/** The `newData` fields an edit writes for its settlement of applied credit, or none. */
export function creditGiveBackHistory(
  giveBack: PaidReductionCreditGiveBack | null,
): { [HISTORY_KEY]?: PaidReductionCreditGiveBack } {
  return giveBack ? { [HISTORY_KEY]: { basisCents: giveBack.basisCents, givenBackCents: giveBack.givenBackCents } } : {};
}

/** The give-back an edit's history row records, or null where its settlement did not reach applied credit. */
export function recordedCreditGiveBack(newData: unknown): PaidReductionCreditGiveBack | null {
  const record = newData && typeof newData === "object" && !Array.isArray(newData) ? (newData as Record<string, unknown>)[HISTORY_KEY] : null;
  if (!record || typeof record !== "object") return null;
  const { basisCents, givenBackCents } = record as Record<string, unknown>;
  return Number.isInteger(basisCents) && Number.isInteger(givenBackCents)
    ? { basisCents: basisCents as number, givenBackCents: givenBackCents as number }
    : null;
}

/** Whether a cancellation of this booking caps the applied credit it tiers (`INV-PAY-114`). */
export async function bookingReducedThroughCreditGiveBack(
  bookingId: string,
  db: Pick<Prisma.TransactionClient, "bookingModification">,
): Promise<boolean> {
  const row = await db.bookingModification.findFirst({
    where: { bookingId, newData: { path: [HISTORY_KEY, "basisCents"], gte: 0 } },
    select: { id: true },
  });
  return row !== null;
}
