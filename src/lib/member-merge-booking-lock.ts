/**
 * MEMBER MERGE'S BOOKING TRY-LOCK AND THE ONE-ROW WAIT IT SHARES WITH THE
 * MEMBER WAIT (#4860, `INV-LOCK`).
 *
 * Merge re-points the duplicate's bookings in one set `UPDATE`, which locks
 * its rows in whatever order the plan visits them and waits on a busy row while
 * holding the ones it already has. A writer that holds one of those bookings and
 * then updates a sibling can therefore form a wait-for cycle with it. Merge now
 * takes the whole captured set with one `FOR NO KEY UPDATE SKIP LOCKED`, or none of
 * it, and on a shortfall throws {@link MemberMergeBookingRowBusyError} so the
 * attempt wrapper (`withMemberMergeParticipantRows`, in
 * `adult-member-hosting-queue-participants.ts`) rolls the attempt back and
 * waits for that one booking holding nothing.
 *
 * Every lock here is `FOR NO KEY UPDATE`, the strength the `memberId` update
 * itself takes (`memberId` is in no unique index). It still conflicts with the
 * sibling writers' `FOR NO KEY UPDATE`, which is the cycle this closes, but not
 * with the `FOR KEY SHARE` a child insert's foreign-key check takes on the
 * booking (a `BookingGuest`, a `Payment`). `FOR UPDATE` blocked those inserts
 * until the merge committed, and skipped any booking one had touched (#5004).
 *
 * These pieces live apart from the wrapper only to keep that module inside its
 * size budget. They add no advisory key and no new order: see
 * `docs/CONCURRENCY_AND_LOCKING.md` ("Merge never holds one of the duplicate's
 * bookings while waiting for another (#4860)").
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import { isPostgresLockNotAvailable } from "@/lib/prisma-errors";

/**
 * Bound one statement's lock wait, for the current transaction only.
 *
 * `set_config(..., is_local => true)` rather than `SET LOCAL` because the value
 * is then an ordinary bound parameter instead of interpolated SQL — `SET` takes
 * no placeholders. It runs through `$executeRaw` for the same reason every other
 * raw statement in this module does: nothing reads the returned row, only that
 * the statement succeeded.
 *
 * Only ever called inside a savepoint that is then rolled back, which restores
 * the value in force before it exactly — a database- or role-level bound
 * included (#2623 F4). So there is no undo to get wrong: not `0`, which means
 * "wait forever", and not `RESET`, which is session-scoped and survives the
 * commit on a pooled connection (both measured on real PostgreSQL in #2623).
 */
export async function setTransactionLockTimeout(
  db: Pick<PrismaClient, "$executeRaw">,
  milliseconds: number,
): Promise<void> {
  await db.$executeRaw(
    Prisma.sql`SELECT set_config('lock_timeout', ${String(milliseconds)}, true)`,
  );
}

/** Apart from the attempt and from the Member wait, so neither can release the other (#4860). */
const BOOKING_WAIT_SAVEPOINT = {
  open: Prisma.sql`SAVEPOINT member_merge_booking_wait`,
  rollBack: Prisma.sql`ROLLBACK TO SAVEPOINT member_merge_booking_wait`,
  release: Prisma.sql`RELEASE SAVEPOINT member_merge_booking_wait`,
} as const;

/**
 * The captured booking another transaction holds. Thrown from inside the
 * attempt; the wrapper rolls the attempt back before it waits (#4860).
 */
export class MemberMergeBookingRowBusyError extends Error {
  readonly bookingId: string;

  constructor(bookingId: string) {
    super("A booking this merge must re-point is locked by another writer.");
    this.name = "MemberMergeBookingRowBusyError";
    this.bookingId = bookingId;
  }
}

/**
 * The single-booking wait found the row gone, or the shared budget ran out.
 * Merge converts this into the existing booking-ownership 409. Not a retry.
 */
export class MemberMergeBookingOwnershipDriftError extends Error {
  constructor() {
    super(
      "Booking ownership changed while the merge was running. Nothing was saved. Re-run the preview and try again.",
    );
    this.name = "MemberMergeBookingOwnershipDriftError";
  }
}

/**
 * Wait for one busy booking, holding none of the others (#4860), for at most
 * `milliseconds`. Same shape as `waitForOneParticipantRow` in
 * `adult-member-hosting-queue-participants.ts`, on `"Booking"`, under its own
 * savepoint. The rollback releases the row and the `lock_timeout`.
 */
export async function waitForOneBookingRow(
  db: Pick<PrismaClient, "$executeRaw">,
  bookingId: string,
  milliseconds: number,
): Promise<"free" | "missing" | "timedOut"> {
  await db.$executeRaw(BOOKING_WAIT_SAVEPOINT.open);
  let outcome: "free" | "missing" | "timedOut";
  try {
    await setTransactionLockTimeout(db, milliseconds);
    const locked = await db.$executeRaw(Prisma.sql`
      SELECT 1
      FROM "Booking"
      WHERE "id" = ${bookingId}
      FOR NO KEY UPDATE
    `);
    outcome = locked === 1 ? "free" : "missing";
  } catch (error) {
    if (!isPostgresLockNotAvailable(error)) throw error;
    outcome = "timedOut";
  }
  await db.$executeRaw(BOOKING_WAIT_SAVEPOINT.rollBack);
  await db.$executeRaw(BOOKING_WAIT_SAVEPOINT.release);
  return outcome;
}

/**
 * The first captured booking this attempt could not lock. A row the attempt
 * already holds counts 1; a row another transaction holds, or one that is gone,
 * counts 0. The id sort only makes "first" stable. It does not have to match
 * any other writer.
 */
async function firstSkippedBookingRow(
  db: Pick<PrismaClient, "$executeRaw">,
  ids: readonly string[],
): Promise<string | undefined> {
  for (const id of ids) {
    const locked = await db.$executeRaw(Prisma.sql`
      SELECT 1
      FROM "Booking"
      WHERE "id" = ${id}
      FOR NO KEY UPDATE SKIP LOCKED
    `);
    if (locked !== 1) return id;
  }
  return undefined;
}

/**
 * Take every captured loser-owned booking, or none of them (#4860).
 *
 * Called at the `Booking.member` arm, before that `updateMany`, and only for
 * the ids the preview captured. An empty set issues no statement (`IN ()` is
 * invalid, and there is no row to wait for). Otherwise one counted
 * `SELECT 1 … ORDER BY "id" FOR NO KEY UPDATE SKIP LOCKED` (`INV-OPS-001`). Uncontended,
 * the count equals the captured length and this transaction holds every row, so
 * the `updateMany` re-points `memberId` without waiting. A short count throws
 * {@link MemberMergeBookingRowBusyError} for the first skipped id and does not
 * wait: the attempt wrapper rolls back, then waits for that one booking alone.
 */
export async function lockCapturedLoserOwnedBookings(
  db: Pick<PrismaClient, "$executeRaw">,
  capturedIds: readonly string[],
): Promise<void> {
  if (capturedIds.length === 0) return;
  const ids = [...capturedIds].sort();
  const locked = await db.$executeRaw(Prisma.sql`
    SELECT 1
    FROM "Booking"
    WHERE "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR NO KEY UPDATE SKIP LOCKED
  `);
  if (locked === ids.length) return;
  const busy = await firstSkippedBookingRow(db, ids);
  if (busy !== undefined) throw new MemberMergeBookingRowBusyError(busy);
}

