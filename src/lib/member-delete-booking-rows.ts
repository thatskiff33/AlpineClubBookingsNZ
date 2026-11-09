/**
 * #4850: member hard-delete takes the booking rows that name the member BEFORE
 * its Member-row fence, so its order is booking row, then Member: the order
 * member merge and every booking writer share (docs/CONCURRENCY_AND_LOCKING.md,
 * "A booking writer takes the booking row before a Member key share").
 *
 * The delete's `ON DELETE SET NULL` on Booking's actor columns (`createdById`,
 * `adminReviewedById`, the hold and override columns, …) updates every booking
 * row that names the member. Taken only there, after the Member row
 * `FOR UPDATE` (the Xero fence), that was Member, then booking. A writer that
 * held such a booking row and then named the member (a manual settle, an edit
 * review's closure, a change-request approval: each FK takes `FOR KEY SHARE` on
 * the Member row) waited on the delete while the delete waited on it.
 *
 * The set is read, then locked, sorted, before the fence. It can grow until the
 * fence holds: a writer that names the member on another booking needs the
 * Member row's key share, which the fence then blocks. So the set is read again
 * under the fence, and a booking that joined it refuses the delete (nothing
 * written; the admin retries) rather than be locked late, Member first.
 *
 * The columns come from `MEMBER_MERGE_RELATION_SPECS`, whose DMMF test fails
 * when a Booking→Member relation is added without a row there.
 */
import { Prisma } from "@prisma/client";

import { MEMBER_MERGE_RELATION_SPECS } from "@/lib/member-merge-relations";

/** Every Booking column that names a Member. `memberId` (the owner) is Restrict and blocks a delete anyway. */
const BOOKING_MEMBER_COLUMNS: readonly string[] = MEMBER_MERGE_RELATION_SPECS
  .filter((spec) => spec.model === "Booking")
  .map((spec) => spec.column);

type BookingRowsDb = Pick<Prisma.TransactionClient, "$executeRaw" | "booking">;

async function bookingIdsNaming(db: BookingRowsDb, memberId: string): Promise<string[]> {
  const rows = await db.booking.findMany({
    where: { OR: BOOKING_MEMBER_COLUMNS.map((column) => ({ [column]: memberId })) },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => row.id);
}

/** Lock, in id order, every booking row naming `memberId`. Call before the Member-row fence. Returns the ids locked. */
export async function lockBookingRowsNamingMember(db: BookingRowsDb, memberId: string): Promise<string[]> {
  const ids = await bookingIdsNaming(db, memberId);
  if (ids.length > 0) {
    await db.$executeRaw`SELECT 1 FROM "Booking" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR NO KEY UPDATE`;
  }
  return ids;
}

/**
 * Under the Member-row fence: the bookings naming `memberId` that were not
 * locked before it. Empty means the delete's SET NULL touches only rows it
 * already holds.
 */
export async function bookingsNamingMemberSinceLocked(db: BookingRowsDb, memberId: string, locked: readonly string[]): Promise<string[]> {
  const held = new Set(locked);
  return (await bookingIdsNaming(db, memberId)).filter((id) => !held.has(id));
}
