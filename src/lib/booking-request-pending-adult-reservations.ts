import { prisma } from "@/lib/prisma";
import { eachDateOnlyInRange, formatDateOnly, parseDateOnly } from "@/lib/date-only";
import type { PrismaTransactionClient } from "@/lib/db-transaction";

/** Capacity reader for #3413's unnamed school adults. */
type ReservationDb = Pick<
  PrismaTransactionClient,
  "bookingRequestPendingAdultReservationNight"
>;

type ReservationNightRow = { night: Date; adultCount: number };

/** Refuse to promise a held anonymous bed unless every reserved night agrees. */
export async function pendingAdultReservationNightsMatch(input: {
  db: ReservationDb;
  bookingRequestId: string;
  bookingId: string;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
  adultCount: number;
}): Promise<boolean> {
  const expectedNights = eachDateOnlyInRange(input.checkIn, input.checkOut);
  const rows = await input.db.bookingRequestPendingAdultReservationNight.findMany({
    where: { bookingRequestId: input.bookingRequestId },
    select: { bookingId: true, lodgeId: true, night: true, adultCount: true },
    orderBy: { night: "asc" },
  });
  if (input.adultCount === 0) return rows.length === 0;
  return rows.length === expectedNights.length && rows.every((row, index) =>
    row.bookingId === input.bookingId &&
    row.lodgeId === input.lodgeId &&
    row.adultCount === input.adultCount &&
    formatDateOnly(row.night) === formatDateOnly(expectedNights[index]!),
  );
}

/**
 * Reads capacity-only counts for one lodge/date window. The request hold writer
 * creates and removes these rows in its same globally-then-lodge-locked
 * transaction. They intentionally carry no person or provider identity.
 */
export async function findPendingAdultReservationNights(input: {
  lodgeId: string;
  from: Date;
  toExclusive: Date;
  excludeBookingId?: string;
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
      ...(input.excludeBookingId ? { bookingId: { not: input.excludeBookingId } } : {}),
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
  excludeBookingId?: string;
  db?: ReservationDb;
}): Promise<(night: Date) => number> {
  const rows = await findPendingAdultReservationNights(input);
  const index = buildPendingAdultReservationNightIndex(rows, input.nights);
  if (index.size === 0) return () => 0;
  return (night: Date) => index.get(formatDateOnly(night)) ?? 0;
}

/** Write only while the caller holds the request's global and lodge locks. */
export async function reservePendingAdultNights(input: {
  db: ReservationDb;
  bookingRequestId: string;
  bookingId: string;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
  adultCount: number;
}): Promise<void> {
  if (!Number.isSafeInteger(input.adultCount) || input.adultCount < 0) {
    throw new Error("Pending adult count must be a nonnegative safe integer");
  }
  if (input.adultCount === 0) return;
  await input.db.bookingRequestPendingAdultReservationNight.createMany({
    data: eachDateOnlyInRange(input.checkIn, input.checkOut).map((night) => ({
      bookingRequestId: input.bookingRequestId,
      bookingId: input.bookingId,
      lodgeId: input.lodgeId,
      night,
      adultCount: input.adultCount,
    })),
  });
}

/** Remove the anonymous capacity term in the same transaction as hold release. */
export async function releasePendingAdultNights(input: {
  db: ReservationDb;
  bookingId: string;
}): Promise<void> {
  // Existing cancellation test doubles model only pre-#3413 tables. The
  // generated production client always has this delegate.
  if (typeof input.db.bookingRequestPendingAdultReservationNight?.deleteMany !== "function") return;
  await input.db.bookingRequestPendingAdultReservationNight.deleteMany({
    where: { bookingId: input.bookingId },
  });
}
