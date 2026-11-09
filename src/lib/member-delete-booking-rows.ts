/**
 * #4850: member hard-delete takes the booking rows that name the member BEFORE
 * its Member-row fence, so its order is booking row, then Member: the order
 * member merge and the booking writers #4840 aligned share
 * (docs/CONCURRENCY_AND_LOCKING.md, "A booking writer takes the booking row
 * before a Member key share").
 *
 * The delete's `ON DELETE SET NULL` on Booking's actor columns (`createdById`,
 * `adminReviewedById`, the hold and override columns, …) updates every booking
 * row that names the member. Taken only there, after the Member row
 * `FOR UPDATE` (the Xero fence), that was Member, then booking. A writer that
 * held such a booking row and then named the member (a manual settle, an edit
 * review's closure, a change-request approval since #4845: each FK takes
 * `FOR KEY SHARE` on the Member row) waited on the delete while the delete
 * waited on it. The approvals that still name their officer in a claim before
 * they take the booking row (policy exceptions, #4853; booking requests, #4857)
 * are brought into the same order by those issues, not here.
 *
 * The set is read, then locked, sorted, before the fence. It can grow until the
 * fence holds: a writer that names the member on another booking needs the
 * Member row's key share, which the fence then blocks. So the set is read again
 * under the fence, and a booking that joined it refuses the delete (nothing
 * written; the admin retries) rather than be locked late, Member first.
 *
 * The owner (`Booking.memberId`) is not one of these columns: that FK is
 * Restrict, and eligibility refuses a member who owns a booking.
 *
 * Payment rows naming the member (`manuallyMarkedPaidByMemberId`) are taken
 * `NOWAIT` once the fence holds, as merge takes them (#4823): writers take a
 * Payment row before its booking row (a card settle, the back-post), so the
 * delete, which now holds booking rows from the start, must never wait for one.
 */
import { Prisma } from "@prisma/client";

import { MEMBER_MERGE_RELATION_SPECS } from "@/lib/member-merge-relations";
import { isPostgresLockNotAvailable } from "@/lib/prisma-errors";

/** The Booking columns naming a Member that the delete's SET NULL updates: every Booking relation but the owner. */
export const BOOKING_ACTOR_COLUMNS: readonly string[] = MEMBER_MERGE_RELATION_SPECS
  .filter((spec) => spec.model === "Booking" && spec.key !== "Booking.member")
  .map((spec) => spec.column);

/** PostgreSQL caps bind parameters at 65535; the ids are locked in sorted chunks well under it. */
const BOOKING_ROW_LOCK_CHUNK_SIZE = 10_000;

type BookingRowsDb = Pick<Prisma.TransactionClient, "$executeRaw" | "booking">;

async function bookingIdsNaming(db: BookingRowsDb, memberId: string): Promise<string[]> {
  const rows = await db.booking.findMany({
    where: { OR: BOOKING_ACTOR_COLUMNS.map((column) => ({ [column]: memberId })) },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => row.id);
}

/** Lock, in id order, every booking row naming `memberId` as an actor. Call before the Member-row fence. Returns the ids locked. */
export async function lockBookingRowsNamingMember(db: BookingRowsDb, memberId: string): Promise<string[]> {
  const ids = await bookingIdsNaming(db, memberId);
  for (let offset = 0; offset < ids.length; offset += BOOKING_ROW_LOCK_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + BOOKING_ROW_LOCK_CHUNK_SIZE);
    await db.$executeRaw`SELECT 1 FROM "Booking" WHERE "id" IN (${Prisma.join(chunk)}) ORDER BY "id" FOR NO KEY UPDATE`;
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

/**
 * Under the Member-row fence, so the set cannot grow: lock every Payment row
 * naming `memberId`, sorted and `NOWAIT`. A held row throws `refuse()`; any
 * other error is rethrown.
 */
export async function lockPaymentRowsNamingMemberNowait(db: Pick<Prisma.TransactionClient, "$executeRaw">, memberId: string, refuse: () => Error): Promise<void> {
  try {
    await db.$executeRaw`SELECT 1 FROM "Payment" WHERE "manuallyMarkedPaidByMemberId" = ${memberId} ORDER BY "id" FOR NO KEY UPDATE NOWAIT`;
  } catch (error) {
    if (isPostgresLockNotAvailable(error)) throw refuse();
    throw error;
  }
}
