import type { Prisma } from "@prisma/client";

/** The one client capability the lock needs, named so callers need not spell it. */
export type BookingRowLockDb = Pick<Prisma.TransactionClient, "$executeRaw">;

/**
 * The booking row lock an owner read takes (`FOR NO KEY UPDATE`, an UPDATE's own strength). A door whose owner read
 * comes after writes of its own takes it first, where its lock order puts the booking row (#4516 review F1: an
 * approved appeal right after `lock(1)`, before the Payment row and its request's claim). Taken again, a no-op.
 *
 * A LOCK, NEVER A READ: a constant is selected and the result discarded (#2289). Kept in its own file, away from
 * the member-money journal's boundary, so a business writer that only needs the lock (the locked-period change
 * request approval, #4845) names no journal module and stays under the journal census's raw-SQL checks. The
 * boundary's `doors` re-exports it, so one statement serves every caller.
 */
export async function lockBookingRowForOwnerRead(tx: BookingRowLockDb, bookingId: string): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "Booking" WHERE "id" = ${bookingId} FOR NO KEY UPDATE`;
}
