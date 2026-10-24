import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";

import type { ClubTimeZone } from "@/lib/club-time";

import {
  reconcileBookingMoney,
  summarizeBookingMoneyReconciliations,
  type BookingMoneyReconciliation,
  type BookingMoneyReconciliationSummary,
} from "@/lib/booking-money-reconciliation";
import {
  summarizeLedgerNightValues,
  type LedgerNightValueCensus,
} from "@/lib/ledger-night-value-census";
import {
  summarizeEditFinancialReviews,
  summarizeNightPriceProvenance,
  type EditFinancialReviewCensus,
  type NightPriceProvenanceCensus,
} from "@/lib/night-price-provenance-census";
import { withReadOnlySnapshot } from "@/lib/read-only-snapshot";

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
  promoRedemptions: {
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

export type BookingMoneyReconciliationCensus = BookingMoneyReconciliationSummary & {
  /**
   * #3531 3c: what the stored night prices are made of, per booking-creation
   * month, and every edit financial review by cause and month - the two
   * figures that show whether 3a and 3b changed what parks. Read in the same
   * snapshot as the verdicts above.
   */
  nightPriceProvenance: NightPriceProvenanceCensus;
  editFinancialReviews: EditFinancialReviewCensus;
  /**
   * #4317 review M3: the bookings confirmed on the ledger whose live per-night
   * lines differ from what an edit now values those nights at - each one an
   * edit would leave unposted (an `UNPOSTED_EDIT` gap) until wave B's re-base.
   */
  ledgerNightValues: LedgerNightValueCensus;
};

/**
 * Reproducible whole-table classification from one read-only repeatable-read
 * snapshot (`withReadOnlySnapshot`). The transaction contains only the ordered
 * reads; this function has no repair or write path, and the server refuses one.
 */
export async function censusBookingMoneyReconciliation(
  client: Pick<PrismaClient, "$transaction">,
  // The club's zone decides which calendar month a creation instant falls in
  // (`INV-DATE-019`). The caller reads it, so this module reaches no zone
  // reader and drags no Prisma singleton into the graph of every page that
  // imports the store.
  zone: ClubTimeZone,
): Promise<BookingMoneyReconciliationCensus> {
  // #4285 review: the one read-only snapshot opener - the server refuses a write in it.
  return withReadOnlySnapshot(client, async (tx) => {
    const bookings = await tx.booking.findMany({
      orderBy: { id: "asc" },
      // #4317 review round 2: status and deletedAt, so `ledgerNightValues`
      // counts only bookings an edit can still reach.
      select: { ...BOOKING_MONEY_RECONCILIATION_SELECT, createdAt: true, status: true, deletedAt: true },
    });
    const reviews = await tx.manualRefundTask.findMany({
      where: { kind: "EDIT_FINANCIAL_REVIEW" },
      orderBy: { id: "asc" },
      select: { createdAt: true, status: true, reviewContext: true },
    });
    // #4317 review M3: the guests as an edit values them, and every guest-night
    // ledger line with its reversals, from the same snapshot.
    const guests = await tx.bookingGuest.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        bookingId: true,
        priceCents: true,
        stayStart: true,
        stayEnd: true,
        nights: { select: { stayDate: true, priceCents: true, priceSource: true } },
      },
    });
    const lines = await tx.bookingLedgerLine.findMany({
      where: { side: "CHARGE" },
      orderBy: { id: "asc" },
      select: {
        id: true,
        bookingId: true,
        kind: true,
        sign: true,
        quantity: true,
        unitCents: true,
        bookingGuestId: true,
        nightStart: true,
        nightEndExclusive: true,
        reversesLineId: true,
        anchorKind: true,
      },
    });
    return {
      ...summarizeBookingMoneyReconciliations(bookings),
      nightPriceProvenance: summarizeNightPriceProvenance(bookings, zone),
      editFinancialReviews: summarizeEditFinancialReviews(reviews, zone),
      ledgerNightValues: summarizeLedgerNightValues({ bookings, guests, lines }),
    };
  });
}
