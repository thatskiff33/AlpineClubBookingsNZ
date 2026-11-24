/**
 * #5433 review A: a restarted window is the same offer to the cross-lodge confirm.
 *
 * The cross-lodge confirm (`waitlist-cross-lodge.ts`) runs in three
 * transactions and claims the waitlist entry in the later ones on the row it
 * read in the first: every offer field, and `updatedAt`, so any change to the
 * entry in between makes the claim match nothing. The window restart (owner
 * decision D2, `waitlist-offer-window-restart.ts`) writes exactly two of those
 * columns, `waitlistOfferExpiresAt` and (through Prisma) `updatedAt`. Without
 * this, a restart between the phases would strand the entry: the member holds
 * the new booking and a live offer for the stay they booked.
 *
 * So a later phase, under its locks, re-reads the entry and claims on the
 * current values of those two columns WHEN EVERY OTHER COLUMN still equals what
 * the first phase read. Any other change, by anyone, still fails the claim
 * exactly as before. This keeps the guard's full strength (every column is
 * compared) where leaving `updatedAt` out of the guard would let a change to an
 * unguarded column through unseen. Read inside the caller's transaction, after
 * its locks (`INV-LOCK-004`): one read by primary key.
 */
import type { Prisma } from "@prisma/client";

/** The only columns a window restart writes. */
const RESTART_WRITES = new Set(["updatedAt", "waitlistOfferExpiresAt"]);

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/**
 * The claim's snapshot for a later phase: `entry` itself, or, when the only
 * change to the row since `entry` was read is a window restart, `entry` with
 * the restart's two columns as they now stand.
 */
export async function offerSnapshotAcrossWindowRestart<
  E extends { id: string; updatedAt: Date; waitlistOfferExpiresAt: Date | null },
>(tx: Pick<Prisma.TransactionClient, "booking">, entry: E): Promise<E> {
  const current = await tx.booking.findUnique({ where: { id: entry.id } });
  if (!current) return entry;
  const before = entry as Record<string, unknown>;
  const now = current as unknown as Record<string, unknown>;
  for (const [column, value] of Object.entries(now)) {
    if (RESTART_WRITES.has(column) || !(column in before)) continue;
    if (!sameValue(before[column], value)) return entry;
  }
  return { ...entry, updatedAt: current.updatedAt, waitlistOfferExpiresAt: current.waitlistOfferExpiresAt };
}
