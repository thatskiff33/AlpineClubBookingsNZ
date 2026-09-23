/**
 * READS OF THE BOOKING LEDGER FOR ITS OWN BOOKKEEPING (#3595).
 *
 * Not a reader in #3584's sense: nothing here produces a figure a member or an
 * officer sees. These are the questions a POSTER has to ask before it posts —
 * has this booking been confirmed on the ledger yet, which line would a
 * reversal reverse — and they live in one module so the next poster asks them
 * the same way.
 *
 * Every function takes the caller's client, so a question asked inside a
 * transaction is answered from that transaction's snapshot and under its locks.
 */
import type { Prisma } from "@prisma/client";

export type BookingLedgerReadStore = Pick<Prisma.TransactionClient, "bookingLedgerLine">;

/**
 * Has this booking's confirmation already been posted?
 *
 * THE FENCE THAT MAKES CONFIRMATION HAPPEN ONCE PER BOOKING. A booking can pass
 * the settle's PAID claim twice — an officer marks it paid, reverses the
 * mark-paid, and the member pays by card — and between the two its nights can
 * change (a date shift recreates them; a guest removed and re-added gets a new
 * id). Per-night keys would then all be new, and the whole night charge would
 * post twice. A booking is confirmed once; what changes afterwards is a
 * modification, posted as one (#3582).
 *
 * Counts ANY confirmation line, keyed or not, so lines #3580 posted before keys
 * existed fence a later settle as well. Asked under the settle's global
 * `lock(1)`, which serialises every settle, so the check cannot race.
 */
export async function bookingHasConfirmationLines(
  store: BookingLedgerReadStore,
  bookingId: string,
): Promise<boolean> {
  const existing = await store.bookingLedgerLine.findFirst({
    where: { bookingId, anchorKind: "CONFIRMATION" },
    select: { id: true },
  });
  return existing !== null;
}
