/**
 * THE ONE FORMULA FOR WHAT THE CLUB KEEPS ON A CANCELLATION (design
 * `docs/design/booking-ledger.md` §5.1), in a module of its own so a pure
 * reader — the projection census and the group child planner it shares with
 * the back-post (#3854) — can use it without `paid-cancellation-money`'s
 * import chain, which reaches the Prisma client through `cancellation.ts`.
 *
 * Pure: imports nothing.
 */

/** The one formula for what the club keeps on a cancellation (design §5.1). */
export function cancellationKeptCents({
  retainedAmountCents,
  appliedCreditCents,
  creditRestoredCents,
}: {
  retainedAmountCents: number;
  appliedCreditCents: number;
  creditRestoredCents: number;
}): number {
  return retainedAmountCents + appliedCreditCents - creditRestoredCents;
}
