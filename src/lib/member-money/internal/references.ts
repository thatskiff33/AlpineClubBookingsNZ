import type { Prisma } from "@prisma/client";

/**
 * Read-only: what a posted journal row retains (M2 #4514, decision D1 on #4482).
 * Neither function writes or posts; booking doors post since M3b (INV-MONEY-044).
 *
 * A leg names a booking through a RESTRICT key, so the database refuses to delete
 * that booking; `bookingIdsNamedByJournal` lets a hard-delete path skip it instead
 * of meeting the refusal. A debtor is a retained identity string, not a key, so
 * nothing in the database stops a member's row going: `journalRowsNamingDebtor`
 * is what lets member hard delete refuse a member whose balance the journal moves.
 */
export async function bookingIdsNamedByJournal(
  db: Pick<Prisma.TransactionClient, "memberMoneyLine">,
  bookingIds: readonly string[],
): Promise<string[]> {
  if (bookingIds.length === 0) return [];
  const rows = await db.memberMoneyLine.findMany({
    where: { bookingId: { in: [...bookingIds] } },
    select: { bookingId: true },
    distinct: ["bookingId"],
  });
  return rows.flatMap((row) => (row.bookingId === null ? [] : [row.bookingId]));
}

/** #4525 (M13): a booking an export manifest names, by the same RESTRICT rule. */
export async function bookingIdsNamedByExportManifest(
  db: Pick<Prisma.TransactionClient, "memberMoneyExportManifest">,
  bookingIds: readonly string[],
): Promise<string[]> {
  if (bookingIds.length === 0) return [];
  const rows = await db.memberMoneyExportManifest.findMany({
    where: { bookingId: { in: [...bookingIds] } },
    select: { bookingId: true },
    distinct: ["bookingId"],
  });
  return rows.map((row) => row.bookingId);
}

export async function journalRowsNamingDebtor(
  db: Pick<Prisma.TransactionClient, "memberMoneyLine" | "memberMoneyObligation">,
  memberId: string,
): Promise<number> {
  const [legs, obligations] = await Promise.all([
    db.memberMoneyLine.count({ where: { memberId } }),
    db.memberMoneyObligation.count({ where: { memberId } }),
  ]);
  return legs + obligations;
}
