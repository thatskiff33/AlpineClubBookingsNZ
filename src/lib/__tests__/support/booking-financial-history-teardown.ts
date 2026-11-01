import type { Prisma, PrismaClient } from "@prisma/client";

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
 *
 * From M3a (#4626) a suite can also post member-money journal batches naming its
 * bookings. Those rows are immutable for every role: triggers refuse UPDATE,
 * DELETE and TRUNCATE (`INV-MONEY-041`). So the journal part runs in one
 * transaction under `SET LOCAL session_replication_role = replica`, which only a
 * superuser may set (CI's race database runs as `postgres`). It removes exactly
 * the batches naming the bookings, by a leg or by a bridge to one of their legacy
 * lines, and every batch linked to those (a reversal, or a leg or application
 * naming one of their obligations or legs), then puts the role back.
 */
type TeardownDb = Pick<PrismaClient, "$executeRaw" | "$queryRaw" | "$transaction">;

export async function releaseBookingFinancialHistoryForTeardown(
  db: TeardownDb,
  bookingIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(bookingIds)];
  if (ids.length === 0) return;
  await db.$transaction((tx) => releaseMemberMoneyJournalForTeardown(tx, ids));
  await db.$executeRaw`DELETE FROM "BookingLedgerLine" WHERE "bookingId" = ANY(${ids}::text[])`;
  await db.$executeRaw`UPDATE "MemberCredit" SET "sourceBookingId" = NULL WHERE "sourceBookingId" = ANY(${ids}::text[])`;
  await db.$executeRaw`UPDATE "MemberCredit" SET "appliedToBookingId" = NULL WHERE "appliedToBookingId" = ANY(${ids}::text[])`;
  await db.$executeRaw`UPDATE "MemberCredit" SET "sourceBookingModificationId" = NULL
    WHERE "sourceBookingModificationId" IN (SELECT "id" FROM "BookingModification" WHERE "bookingId" = ANY(${ids}::text[]))`;
  await db.$executeRaw`DELETE FROM "GroupBookingSettlement"
    WHERE "groupBookingId" IN (SELECT "id" FROM "GroupBooking" WHERE "organiserBookingId" = ANY(${ids}::text[]))`;
}

async function releaseMemberMoneyJournalForTeardown(tx: Prisma.TransactionClient, ids: string[]): Promise<void> {
  const batches = await tx.$queryRaw<{ journalId: string; eventId: string }[]>`
    WITH RECURSIVE named(id) AS (
      SELECT "journalId" FROM "MemberMoneyLine" WHERE "bookingId" = ANY(${ids}::text[])
      UNION
      SELECT s."journalId" FROM "MemberMoneySourceLink" s
        JOIN "BookingLedgerLine" b ON b.id = s."bookingLedgerLineId"
        WHERE b."bookingId" = ANY(${ids}::text[])
      UNION
      SELECT linked.id FROM named n CROSS JOIN LATERAL (
        SELECT j.id FROM "MemberMoneyJournal" j WHERE j."reversesJournalId" = n.id
        UNION SELECT l."journalId" FROM "MemberMoneyLine" l
          JOIN "MemberMoneyObligation" o ON o.id = l."obligationId" WHERE o."journalId" = n.id
        UNION SELECT a."journalId" FROM "MemberMoneyApplication" a
          JOIN "MemberMoneyObligation" o ON o.id = a."obligationId" WHERE o."journalId" = n.id
        UNION SELECT a."journalId" FROM "MemberMoneyApplication" a
          JOIN "MemberMoneyLine" l ON l.id = a."sourceLineId" WHERE l."journalId" = n.id
      ) linked
    )
    SELECT j.id AS "journalId", j."eventId" FROM "MemberMoneyJournal" j WHERE j.id IN (SELECT id FROM named)`;
  if (batches.length === 0) return;
  const journals = batches.map((batch) => batch.journalId);
  const events = batches.map((batch) => batch.eventId);
  await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
  await tx.$executeRaw`DELETE FROM "MemberMoneyApplication" WHERE "journalId" = ANY(${journals}::text[])`;
  await tx.$executeRaw`DELETE FROM "MemberMoneySourcePosting" WHERE "journalId" = ANY(${journals}::text[])`;
  await tx.$executeRaw`DELETE FROM "MemberMoneyLine" WHERE "journalId" = ANY(${journals}::text[])`;
  await tx.$executeRaw`DELETE FROM "MemberMoneyObligation" WHERE "journalId" = ANY(${journals}::text[])`;
  await tx.$executeRaw`DELETE FROM "MemberMoneySourceLink" WHERE "journalId" = ANY(${journals}::text[])`;
  await tx.$executeRaw`DELETE FROM "MemberMoneyJournal" WHERE id = ANY(${journals}::text[])`;
  await tx.$executeRaw`DELETE FROM "MemberMoneyEvent" WHERE id = ANY(${events}::text[])`;
  await tx.$executeRaw`SET LOCAL session_replication_role = origin`;
}
