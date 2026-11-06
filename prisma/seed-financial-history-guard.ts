import {
  type BookingFinancialHistoryRelation,
  bookingsWithFinancialHistory,
} from "../src/lib/booking-financial-history";

type Store = Parameters<typeof bookingsWithFinancialHistory>[0];

/**
 * A seed tool that hard-deletes bookings first asks whether any of them carries
 * financial history, and refuses before it deletes anything (#4583; Ledger M2,
 * `INV-MONEY-043`). Those rows are RESTRICT keys and, for the booking ledger and
 * the member journal, append-only: a seed releasing them would be the one place
 * outside a test that erases money history, so a database holding some is
 * recreated rather than re-seeded. The relations are
 * `booking-financial-history.ts`'s; no seed keeps a list of its own (`INV-SSOT`).
 *
 * `relations` narrows the check to those the tool does not delete itself: the
 * demo seed removes payments and refund work as part of its reset and so passes
 * only the append-only ones; a tool that deletes none leaves it at all of them.
 */
export async function refuseBookingsWithFinancialHistory(
  db: Store,
  bookingIds: readonly string[],
  tool: string,
  relations?: ReadonlyArray<BookingFinancialHistoryRelation>,
): Promise<void> {
  const named = await bookingsWithFinancialHistory(db, bookingIds, relations);
  if (named.size === 0) return;
  throw new Error(
    `${tool} refused: ${named.size} booking(s) it would delete carry financial history (ledger or journal lines, credits, payments or refund work), and that history is never deleted. Recreate the database (for example drop and re-create its schema, then migrate) and run the seed again.`,
  );
}
