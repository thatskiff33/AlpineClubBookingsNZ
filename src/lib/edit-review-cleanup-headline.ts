import "server-only";

import { ManualRefundTaskKind, type PrismaClient } from "@prisma/client";

import { bookingOwner } from "@/lib/booking-owner";
import { hasIssuedPrimaryXeroInvoice } from "@/lib/booking-payment-state";
import {
  rebaseDivergesFromIssuedInvoice,
  type BookingPriceRebase,
} from "@/lib/booking-review-price-rebase";
import type { ClubFormat } from "@/lib/club-format";
import type { CalendarDate } from "@/lib/club-time";
import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import { prisma } from "@/lib/prisma";
import { recordReviewClosurePricing } from "@/lib/stored-night-price-repair-store";
import type { BookingJournalContext } from "@/lib/member-money/doors";
import {
  isFrozenEditReviewHeadline,
  type CleanupBooking,
  type CleanupMoneyColumns,
} from "@/lib/edit-review-cleanup-plan";

/**
 * Wave B (#4343), the headline pass: re-base one frozen booking headline to the
 * sum of its guests' stored totals, moving no money. Split out of
 * `edit-review-cleanup.ts`, which runs it once per frozen booking.
 */

export type HeadlinePassResult =
  | { kind: "unchanged"; bookingId: string; before: CleanupMoneyColumns }
  | {
      kind: "declined";
      bookingId: string;
      before: CleanupMoneyColumns;
      message: string;
    }
  | {
      kind: "raced";
      bookingId: string;
      message: string;
    }
  | {
      kind: "rebased";
      bookingId: string;
      before: CleanupMoneyColumns;
      after: CleanupMoneyColumns;
      invoiceDiverged: boolean;
      /** False when the closure poster wrote no line for the new history row. */
      ledgerPosted: boolean;
    };

const HEADLINE_NOTE =
  "Wave B cleanup: re-set the booking's headline to the sum of its guests' stored totals. No money was moved.";

class HeadlineDryRun extends Error {
  constructor(readonly result: HeadlinePassResult) {
    super("edit-review headline dry-run");
    this.name = "HeadlineDryRun";
  }
}

export function moneyColumns(booking: CleanupMoneyColumns): CleanupMoneyColumns {
  return {
    totalPriceCents: booking.totalPriceCents,
    discountCents: booking.discountCents,
    promoAdjustmentCents: booking.promoAdjustmentCents,
    finalPriceCents: booking.finalPriceCents,
  };
}

/**
 * Re-base one frozen headline. `commit: false` runs the same writes and rolls
 * them back, so the report shows the figures apply would store.
 *
 * `editReviewHeadlineRebase#1`: global settlement key first (`INV-LOCK-001`).
 * The booking is re-read under that key. The closure poster compare-and-sets
 * the four money columns; a miss rolls this booking back.
 */
export async function editReviewHeadlineRebase({
  bookingId,
  anchorTaskId: taskId,
  actingMemberId,
  todayAtClub,
  format,
  journal,
  commit,
  client = prisma,
}: {
  bookingId: string;
  anchorTaskId: string;
  actingMemberId: string;
  todayAtClub: CalendarDate;
  format: ClubFormat;
  journal: BookingJournalContext;
  commit: boolean;
  client?: Pick<PrismaClient, "$transaction">;
}): Promise<HeadlinePassResult> {
  try {
    return await client.$transaction(async (tx) => {
      // editReviewHeadlineRebase#1 (INV-LOCK-001): settlement-money authority,
      // taken first. No lodge key: this pass does not admit capacity.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: {
          id: true,
          status: true,
          lodgeId: true,
          memberId: true,
          totalPriceCents: true,
          discountCents: true,
          promoAdjustmentCents: true,
          finalPriceCents: true,
          guests: { select: { id: true, priceCents: true } },
          payment: { select: { id: true, xeroInvoiceId: true } },
        },
      });
      if (booking === null) {
        return { kind: "raced", bookingId, message: "The booking was not there when the re-base ran." };
      }
      const reviews = await tx.manualRefundTask.findMany({
        where: { bookingId, kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW },
        select: { id: true, bookingId: true, status: true },
      });
      const before = moneyColumns(booking);
      const candidate: CleanupBooking = {
        ...before,
        id: booking.id,
        guests: booking.guests.map((guest) => ({ id: guest.id, priceCents: guest.priceCents })),
      };
      if (!isFrozenEditReviewHeadline(candidate, reviews)) {
        return { kind: "unchanged", bookingId, before };
      }
      const historyBefore = await tx.bookingModification.count({
        where: { bookingId, modificationType: "PRICE_REBASE" },
      });
      await recordReviewClosurePricing({
        plans: [],
        task: {
          id: taskId,
          bookingId,
          booking: { memberId: bookingOwner(booking).memberId, lodgeId: booking.lodgeId }, // INV-SSOT-005
        },
        actingMemberId,
        resolution: "dismissed",
        note: HEADLINE_NOTE,
        todayAtClub,
        hasIssuedXeroInvoice: hasIssuedPrimaryXeroInvoice(booking),
        paymentLinkRead: booking.payment,
        settlementRoute: null,
        settlementAmountCents: null,
        settlementDirection: null,
        settleAgainstRebase: null,
        store: tx,
        format,
        journal,
      });
      const afterRow = await tx.booking.findUnique({
        where: { id: bookingId },
        select: {
          totalPriceCents: true,
          discountCents: true,
          promoAdjustmentCents: true,
          finalPriceCents: true,
        },
      });
      if (afterRow === null) {
        return { kind: "raced", bookingId, message: "The booking disappeared during the re-base." };
      }
      const after = moneyColumns(afterRow);
      if (
        after.totalPriceCents === before.totalPriceCents &&
        after.discountCents === before.discountCents &&
        after.promoAdjustmentCents === before.promoAdjustmentCents &&
        after.finalPriceCents === before.finalPriceCents
      ) {
        const declined: HeadlinePassResult = {
          kind: "declined",
          bookingId,
          before,
          message: "The re-base left the headline as it was.",
        };
        if (!commit) throw new HeadlineDryRun(declined);
        return declined;
      }
      const history = await tx.bookingModification.findFirst({
        where: { bookingId, modificationType: "PRICE_REBASE" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      const historyCount = await tx.bookingModification.count({
        where: { bookingId, modificationType: "PRICE_REBASE" },
      });
      const createdId = historyCount > historyBefore ? (history?.id ?? null) : null;
      const ledgerPosted =
        createdId !== null &&
        (await tx.bookingLedgerLine.count({ where: { anchorId: createdId } })) > 0;
      const rebase: BookingPriceRebase = {
        previousTotalPriceCents: before.totalPriceCents,
        previousDiscountCents: before.discountCents,
        previousPromoAdjustmentCents: before.promoAdjustmentCents,
        previousFinalPriceCents: before.finalPriceCents,
        newTotalPriceCents: after.totalPriceCents,
        newDiscountCents: after.discountCents,
        newPromoAdjustmentCents: after.promoAdjustmentCents,
        newFinalPriceCents: after.finalPriceCents,
        promoRemoved: false,
      };
      const rebased: HeadlinePassResult = {
        kind: "rebased",
        bookingId,
        before,
        after,
        invoiceDiverged: rebaseDivergesFromIssuedInvoice({
          rebase,
          hasIssuedXeroInvoice: hasIssuedPrimaryXeroInvoice(booking),
          settlement: { issuesXeroDocument: false },
        }),
        ledgerPosted,
      };
      if (!commit) throw new HeadlineDryRun(rebased);
      return rebased;
    });
  } catch (error) {
    if (error instanceof HeadlineDryRun) return error.result;
    if (error instanceof ManualBookingPaymentError) {
      return { kind: "raced", bookingId, message: error.message };
    }
    throw error;
  }
}
