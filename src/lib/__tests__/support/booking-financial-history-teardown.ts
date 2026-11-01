import type { Prisma } from "@prisma/client";

/**
 * TEARDOWN ONLY, for real-PostgreSQL suites (#4514, Ledger M2; D1 on #4482).
 *
 * Before M2 a suite could delete its fixture bookings and let the database tidy
 * up behind it: a booking's ledger lines went with it (`ON DELETE CASCADE`), a
 * credit row's booking links were blanked (`SET NULL`), and an organiser's group
 * took its settlement with it. Every one of those keys is RESTRICT now
 * (`INV-MONEY-043`), so the delete is refused instead — which is the point for
 * the application, and a broken teardown for a test.
 *
 * A suite connects as the test database's owner and removes only rows it made.
 * This does, for the given bookings, exactly what those referential actions used
 * to do, so a teardown keeps its old meaning: call it immediately before the
 * suite deletes the bookings (or their modifications). One definition, so no
 * suite re-derives the list (`INV-SSOT`). Never import it outside a test: the
 * application deletes no ledger line, and `booking-ledger-append-only-census`
 * holds that for `src/`.
 */
export async function releaseBookingFinancialHistoryForTeardown(
  db: Pick<Prisma.TransactionClient, "$executeRaw">,
  bookingIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(bookingIds)];
  if (ids.length === 0) return;
  await db.$executeRaw`DELETE FROM "BookingLedgerLine" WHERE "bookingId" = ANY(${ids}::text[])`;
  await db.$executeRaw`UPDATE "MemberCredit" SET "sourceBookingId" = NULL WHERE "sourceBookingId" = ANY(${ids}::text[])`;
  await db.$executeRaw`UPDATE "MemberCredit" SET "appliedToBookingId" = NULL WHERE "appliedToBookingId" = ANY(${ids}::text[])`;
  await db.$executeRaw`UPDATE "MemberCredit" SET "sourceBookingModificationId" = NULL
    WHERE "sourceBookingModificationId" IN (SELECT "id" FROM "BookingModification" WHERE "bookingId" = ANY(${ids}::text[]))`;
  await db.$executeRaw`DELETE FROM "GroupBookingSettlement"
    WHERE "groupBookingId" IN (SELECT "id" FROM "GroupBooking" WHERE "organiserBookingId" = ANY(${ids}::text[]))`;
}
