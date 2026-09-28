import { prisma } from "@/lib/prisma";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import type { PrismaTransactionClient } from "@/lib/db-transaction";

/** Capacity reader for #3413's unnamed school adults. */
type ReservationDb = Pick<
  PrismaTransactionClient,
  "bookingRequestPendingAdultReservationNight"
>;

type ReservationNightRow = { night: Date; adultCount: number };

/**
 * Reads capacity-only counts for one lodge/date window. The request hold writer
 * creates and removes these rows in its same globally-then-lodge-locked
 * transaction. They intentionally carry no person or provider identity.
 */
export async function findPendingAdultReservationNights(input: {
  lodgeId: string;
  from: Date;
  toExclusive: Date;
  db?: ReservationDb;
}): Promise<ReservationNightRow[]> {
  const db = input.db ?? prisma;
  const from = parseDateOnly(formatDateOnly(input.from));
  const toExclusive = parseDateOnly(formatDateOnly(input.toExclusive));
  if (from >= toExclusive) return [];

  // Test-double tolerance only. Every generated production client exposes this
  // delegate; a partial old capacity test double retains its zero term.
  if (typeof db.bookingRequestPendingAdultReservationNight?.findMany !== "function") {
    return [];
  }

  return db.bookingRequestPendingAdultReservationNight.findMany({
    where: {
      lodgeId: input.lodgeId,
      night: { gte: from, lt: toExclusive },
    },
    select: { night: true, adultCount: true },
  });
}

/** Builds the per-night index that the canonical occupancy engine consumes. */
export function buildPendingAdultReservationNightIndex(
  rows: readonly ReservationNightRow[],
  nights: readonly Date[],
): Map<string, number> {
  const byKey = new Map<string, number>();
  for (const row of rows) {
    if (row.adultCount <= 0) continue;
    const key = formatDateOnly(row.night);
    byKey.set(key, (byKey.get(key) ?? 0) + row.adultCount);
  }

  const index = new Map<string, number>();
  for (const night of nights) {
    const key = formatDateOnly(night);
    const count = byKey.get(key);
    if (count && count > 0) index.set(key, count);
  }
  return index;
}

/** One pending-adult occupancy term for every canonical capacity reader. */
export async function buildLodgePendingAdultReservationCounter(input: {
  lodgeId: string;
  from: Date;
  toExclusive: Date;
  nights: readonly Date[];
  db?: ReservationDb;
}): Promise<(night: Date) => number> {
  const rows = await findPendingAdultReservationNights(input);
  const index = buildPendingAdultReservationNightIndex(rows, input.nights);
  if (index.size === 0) return () => 0;
  return (night: Date) => index.get(formatDateOnly(night)) ?? 0;
}
