import type { Prisma } from "@prisma/client";

/** The one client capability the lock needs, named so callers need not spell it. */
export type BookingGuestRowLockDb = Pick<Prisma.TransactionClient, "$executeRaw">;

/**
 * Lock one booking's guest rows `FOR UPDATE` inside the caller's transaction
 * (#3029 C3, `INV-LOCK-001`).
 *
 * The held-party rebuild at approval reads each guest row's dietary/allergy
 * value, deletes the party and recreates it. Under READ COMMITTED an admin's
 * single-row edit committing between that read and the delete would be lost
 * while its audit row says it succeeded. With the rows locked first, the edit
 * either committed before the lock (and is read) or waits, and after the delete
 * commits it matches no row and is refused.
 *
 * A LOCK, NEVER A READ: a constant is selected and the result discarded; the
 * values are read back through the Prisma model under the lock. Rows are taken
 * in id order so two lockers of the same party cannot deadlock each other. The
 * caller already holds the global booking key and the lodge capacity key, so
 * the order is global -> lodge -> BookingGuest rows. Kept in its own file so the
 * dietary module stays free of raw SQL (`member-dietary-access-census.test.ts`).
 */
export async function lockBookingGuestRowsForUpdate(
  tx: BookingGuestRowLockDb,
  bookingId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "BookingGuest" WHERE "bookingId" = ${bookingId} ORDER BY "id" FOR UPDATE`;
}
