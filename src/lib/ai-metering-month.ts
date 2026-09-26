import "server-only";

import type { ClubTimeZone } from "@/lib/club-time";
import { resolveClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * The billing month for the two AI budgets, from the club's STORED time zone
 * (#3567 D6), resolved once per call and before any transaction or lock
 * (INV-LOCK-004). The two ledgers key their month on it.
 *
 * WHY A FAILED READ IS NOT SILENT (#3567 review). The zone resolver never
 * throws: when the settings row cannot be read it answers the seed or the
 * shipped default. For a budget that is the wrong trade. The GATES — the page
 * help's pre-call check and the diagnostics reservation — decide whether money
 * may be spent, and "we could not read the club's zone" is exactly the state in
 * which they cannot prove which month's budget applies, so they FAIL CLOSED
 * ({@link gateMonth} answers `null`). The WRITERS — recording a call that has
 * already happened, settling a roundtrip already paid for — must book the spend
 * somewhere rather than lose it, so they keep the fallback month and log that
 * they did ({@link bookingMonth}).
 */
type MonthKey = (date: Date, zone: ClubTimeZone) => string;

/** The month a spend GATE uses, or `null` when the zone could not be read. */
export async function gateMonth(now: Date, monthKey: MonthKey): Promise<string | null> {
  const resolved = await resolveClubTimeZoneOutsideRequest();
  return resolved.readFailed ? null : monthKey(now, resolved.zone);
}

/** The month a spend WRITER books into; a failed read keeps the fallback, logged. */
export async function bookingMonth(
  now: Date,
  monthKey: MonthKey,
  ledger: "ai-assistant" | "ai-diagnostics",
): Promise<string> {
  const resolved = await resolveClubTimeZoneOutsideRequest();
  const month = monthKey(now, resolved.zone);
  if (resolved.readFailed) {
    logger.warn(
      { scope: "ai-metering", ledger, month, fallbackZone: resolved.zone },
      "AI spend was booked into the month of a fallback time zone because the club's stored zone could not be read",
    );
  }
  return month;
}

/**
 * The month a diagnostics SETTLE books into: the reservation's own month when
 * the reservation is still there (the house pattern — settle releases and books
 * where reserve counted, even across a month end or a change of the club's
 * zone), else the club-zone month as {@link bookingMonth} answers it. Read
 * before the settle's locked transaction, whose lock key it is.
 */
export async function settleMonth(
  reservationId: string | null,
  now: Date,
  monthKey: MonthKey,
): Promise<string> {
  if (reservationId) {
    const reserved = await Promise.resolve(
      prisma.diagnosticsBudgetReservation?.findUnique?.({
        where: { id: reservationId },
        select: { month: true },
      }),
    ).then((row) => row?.month ?? null, () => null);
    if (reserved) return reserved;
  }
  return bookingMonth(now, monthKey, "ai-diagnostics");
}
