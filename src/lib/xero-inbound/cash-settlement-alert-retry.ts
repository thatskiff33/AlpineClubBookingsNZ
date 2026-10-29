import { BookingEventType, Prisma } from "@prisma/client";
import { BOOKING_OWNER_NAME_SELECT, bookingOwnerName } from "@/lib/booking-owner-name";
import type { ClubFormat } from "@/lib/club-format";
import {
  asIbSettlementFigureCheckSnapshot,
  CASH_SETTLEMENT_ALERT_MAX_UNDELIVERED,
  IB_SETTLEMENT_FIGURE_CHECK_EVENT_KIND,
} from "@/lib/manual-settlement-reversal-event";
import { prisma } from "@/lib/prisma";
import {
  CASH_SETTLEMENT_ALERT_IN_FLIGHT_MS,
  raiseCashSettlementAlert,
} from "./settle-from-cash-notice";

const pendingMarkerWhere = {
  type: BookingEventType.CANCELLED,
  snapshot: { path: ["kind"], equals: IB_SETTLEMENT_FIGURE_CHECK_EVENT_KIND },
  AND: [{ snapshot: { path: ["alertSentAt"], equals: Prisma.JsonNull } }],
} satisfies Prisma.BookingEventWhereInput;

/** Durable counterpart to the email-delivery escalation, which ages out. */
export async function countExhaustedCashSettlementAlerts(): Promise<number> {
  return prisma.bookingEvent.count({
    where: {
      ...pendingMarkerWhere,
      AND: [
        ...pendingMarkerWhere.AND,
        { snapshot: { path: ["alertUndeliveredCount"], gte: CASH_SETTLEMENT_ALERT_MAX_UNDELIVERED } },
      ],
    },
  });
}

/**
 * Backstop for an invoice that is never delivered again (#4446, INV-INT-001).
 * No money or booking transition, transaction or new lock (INV-LOCK-001–003):
 * the sender's existing cooldown arbitrates against deliveries and other runs.
 * Recent markers belong to their after-commit sender for ten minutes. A failed
 * row fails the recorded cron run, leaving its durable marker for another run.
 */
export async function retryCashSettlementAlerts(format: ClubFormat): Promise<number> {
  const rows = await prisma.bookingEvent.findMany({
    where: {
      ...pendingMarkerWhere,
      createdAt: { lt: new Date(new Date().getTime() - CASH_SETTLEMENT_ALERT_IN_FLIGHT_MS) },
    },
    select: {
      id: true,
      bookingId: true,
      snapshot: true,
      booking: {
        select: {
          checkIn: true,
          checkOut: true,
          ...BOOKING_OWNER_NAME_SELECT,
        },
      },
    },
  });
  let candidates = 0;
  for (const row of rows) {
    const snapshot = asIbSettlementFigureCheckSnapshot(row.snapshot);
    if (!snapshot?.invoiceId || snapshot.alertSentAt || (snapshot.alertUndeliveredCount ?? 0) >= CASH_SETTLEMENT_ALERT_MAX_UNDELIVERED) continue;
    candidates += 1;
    await raiseCashSettlementAlert({
      marker: { id: row.id, snapshot },
      invoiceId: snapshot.invoiceId,
      memberName: bookingOwnerName(row.booking),
      payment: { bookingId: row.bookingId, booking: row.booking },
      format,
    });
  }
  return candidates;
}
