import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  BOOKING_MONEY_RECONCILIATION_REASON_ORDER,
  reconcileBookingMoney,
  type BookingMoneyReconciliation,
  type BookingMoneyReconciliationReason,
} from "@/lib/booking-money-reconciliation";

export const BOOKING_MONEY_RECONCILIATION_SELECT = {
  id: true,
  checkIn: true,
  checkOut: true,
  totalPriceCents: true,
  discountCents: true,
  promoAdjustmentCents: true,
  finalPriceCents: true,
  guests: {
    select: {
      priceCents: true,
      stayStart: true,
      stayEnd: true,
      nights: {
        select: {
          stayDate: true,
          priceCents: true,
          priceSource: true,
        },
      },
    },
  },
  promoRedemption: {
    select: {
      priceAdjustmentCents: true,
      allocations: {
        select: { memberId: true, priceAdjustmentCents: true },
      },
    },
  },
  nightAdjustments: {
    select: { beneficiaryMemberId: true, amountCents: true },
  },
} as const satisfies Prisma.BookingSelect;

export type StoredBookingMoneyReconciliationProjection =
  Prisma.BookingGetPayload<{
    select: typeof BOOKING_MONEY_RECONCILIATION_SELECT;
  }>;

type BookingMoneyReconciliationStore = Pick<Prisma.TransactionClient, "booking">;

export function reconcileStoredBookingMoney(
  booking: StoredBookingMoneyReconciliationProjection,
): BookingMoneyReconciliation {
  return reconcileBookingMoney(booking);
}

export async function readBookingMoneyReconciliation(
  store: BookingMoneyReconciliationStore,
  bookingId: string,
): Promise<BookingMoneyReconciliation | null> {
  const booking = await store.booking.findUnique({
    where: { id: bookingId },
    select: BOOKING_MONEY_RECONCILIATION_SELECT,
  });
  return booking ? reconcileStoredBookingMoney(booking) : null;
}

export type BookingMoneyReconciliationCensus = {
  totalBookings: number;
  byState: { RECONCILED: number; UNRECONCILED: number };
  byReason: Record<BookingMoneyReconciliationReason, number>;
};

/**
 * Reproducible whole-table classification from one repeatable-read snapshot.
 * The transaction contains only the ordered read; this function has no repair
 * or write path.
 */
export async function censusBookingMoneyReconciliation(
  client: Pick<PrismaClient, "$transaction">,
): Promise<BookingMoneyReconciliationCensus> {
  return client.$transaction(
    async (tx) => {
      const bookings = await tx.booking.findMany({
        orderBy: { id: "asc" },
        select: BOOKING_MONEY_RECONCILIATION_SELECT,
      });
      const byReason = Object.fromEntries(
        BOOKING_MONEY_RECONCILIATION_REASON_ORDER.map((reason) => [reason, 0]),
      ) as Record<BookingMoneyReconciliationReason, number>;
      let reconciled = 0;
      for (const booking of bookings) {
        const result = reconcileStoredBookingMoney(booking);
        if (result.state === "RECONCILED") {
          reconciled += 1;
          continue;
        }
        for (const reason of result.reasons) byReason[reason] += 1;
      }
      return {
        totalBookings: bookings.length,
        byState: {
          RECONCILED: reconciled,
          UNRECONCILED: bookings.length - reconciled,
        },
        byReason,
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}

