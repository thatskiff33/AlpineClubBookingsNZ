import "server-only";

/**
 * POST A GROUP ORGANISER'S SETTLEMENT TO ITS CHILDREN'S LEDGERS (#3854,
 * programme #3527 Stage 4; design `docs/design/booking-ledger.md` §5.1–§5.2).
 *
 * The store-facing half of `booking-ledger-group-settlement-posting.ts`. Three
 * writers call it, each inside the transaction and under the locks that already
 * move the money it records:
 *
 *  - the group settle (`settleConfirmedChildrenAndNotify`, card capture and the
 *    Internet Banking invoice's inbound reconcile alike), under `lock(1)` and the
 *    children's lodge keys, in the transaction that flips them CONFIRMED -> PAID;
 *  - the organiser cancel's per-child claim (`group-cancel.ts`), under its
 *    `lock(1)`, for the refund its frozen `refundPlan` hands back and the figure
 *    the cancellation keeps;
 *  - that plan's recovery replay (`executeGroupSettlementRefundPlan`), in the
 *    transaction that writes the refund's mirror.
 *
 * A GROUP CHILD IS CONFIRMED ON THE LEDGER HERE. The settle body that posts every
 * other booking's confirmation lines (`INV-PAY-038`) never sees a group child:
 * the group settle flips it PAID itself. So the settle posts the child's charge
 * lines through the same planner and the same per-booking fence
 * (`bookingHasConfirmationLines`, §4.1a), then its share — without the charges,
 * a share would read as money the club owes back.
 *
 * WHAT IS SWALLOWED AND WHAT IS NOT is `booking-ledger-settlement-sync.ts`'s
 * rule: planning and building are pure, so a throw there is caught and logged
 * and the money movement stands (C4's census reports the gap); the reads and the
 * write are statements and are not wrapped. A replayed settle or cancel posts
 * nothing more: every key is deterministic (`INV-MONEY-033`), and the write
 * skips a key already posted.
 */
import { BookingStatus, type PaymentSource, type Prisma } from "@prisma/client";

import { hasCapturedPayment } from "@/lib/booking-payment-state";
import { planConfirmationChargeLines } from "@/lib/booking-ledger-confirmation-posting";
import {
  planGroupSettlementRefundLine,
  planGroupSettlementShareLines,
  type GroupSettlementForPosting,
} from "@/lib/booking-ledger-group-settlement-posting";
import { bookingHasConfirmationLines } from "@/lib/booking-ledger-read";
import {
  buildBookingLedgerRows,
  writeBookingLedgerRows,
  type BookingLedgerPosting,
} from "@/lib/booking-ledger-write";
import logger from "@/lib/logger";
import { organiserChildCommittedRefundCents } from "@/lib/organiser-child-refund";
import { cancellationKeptCents } from "@/lib/paid-cancellation-money";

type SettleStore = Pick<Prisma.TransactionClient, "booking" | "bookingLedgerLine">;

/**
 * The settle's half: each paid child's confirmation lines (once per booking)
 * and its share of the settlement. `children` are exactly the children this
 * settle flipped to PAID, with the price the settlement's total was checked
 * against under the same lock.
 */
export async function postGroupSettlementLedgerLines({
  store,
  settlement,
  children,
}: {
  store: SettleStore;
  settlement: GroupSettlementForPosting;
  children: ReadonlyArray<{ id: string; lodgeId: string; finalPriceCents: number }>;
}): Promise<number> {
  if (children.length === 0) return 0;
  const bookings = await store.booking.findMany({
    where: { id: { in: children.map((child) => child.id) } },
    select: {
      id: true,
      lodgeId: true,
      totalPriceCents: true,
      promoAdjustmentCents: true,
      guests: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          ageTier: true,
          rateMembershipTypeId: true,
          nights: { select: { stayDate: true, priceCents: true } },
        },
      },
    },
  });
  // The fence, asked per child under the settle's `lock(1)` (§4.1a).
  const unconfirmed = new Set<string>();
  for (const booking of bookings) {
    if (!(await bookingHasConfirmationLines(store, booking.id))) unconfirmed.add(booking.id);
  }

  let rows: ReturnType<typeof buildBookingLedgerRows> = [];
  try {
    const postings: BookingLedgerPosting[] = [];
    for (const booking of bookings) {
      if (!unconfirmed.has(booking.id)) continue;
      const plan = planConfirmationChargeLines(booking);
      if (!plan.reconciles) {
        logger.warn(
          { bookingId: booking.id, settlementId: settlement.id, unpricedStrandIds: plan.unpricedStrandIds },
          "Booking ledger: a group-settled child's charge lines do not add up to its final price (#3854)",
        );
      }
      postings.push(...plan.postings);
    }
    const shares = planGroupSettlementShareLines({
      settlement,
      children: children.map((child) => ({
        bookingId: child.id,
        lodgeId: child.lodgeId,
        shareCents: child.finalPriceCents,
      })),
    });
    if (!shares.reconciles) {
      logger.error(
        { settlementId: settlement.id, settlementCents: settlement.amountCents, totalShareCents: shares.totalShareCents },
        "Booking ledger: a group settlement's children do not add up to what it collected; no share was posted (#3854)",
      );
    }
    postings.push(...shares.postings);
    rows = buildBookingLedgerRows(postings);
  } catch (error) {
    logger.error(
      { err: error, settlementId: settlement.id },
      "Booking ledger: could not build a group settlement's lines; the settle stands and the gap is the census's to report (#3854)",
    );
    return 0;
  }
  return writeBookingLedgerRows(store, rows);
}

/** The refund a frozen organiser-cancel plan hands back on one child. */
export async function postGroupSettlementRefundLedgerLine({
  store,
  settlement,
  bookingId,
  lodgeId,
  refundCents,
}: {
  store: Pick<Prisma.TransactionClient, "bookingLedgerLine">;
  settlement: { id: string; source: PaymentSource };
  bookingId: string;
  lodgeId: string;
  refundCents: number;
}): Promise<number> {
  let rows: ReturnType<typeof buildBookingLedgerRows> = [];
  try {
    const posting = planGroupSettlementRefundLine({ settlement, bookingId, lodgeId, refundCents });
    rows = buildBookingLedgerRows(posting ? [posting] : []);
  } catch (error) {
    logger.error(
      { err: error, settlementId: settlement.id, bookingId },
      "Booking ledger: could not build a group settlement refund line; the refund stands and the gap is the census's to report (#3854)",
    );
    return 0;
  }
  return writeBookingLedgerRows(store, rows);
}

/**
 * What the organiser's cancellation keeps of one child (§5.1's kept figure for
 * this path): what the settlement paid for it, less every refund made or still
 * owed on it — this cancel's own included — so `owed(b)` is zero once they post.
 * Nothing for a child the settlement never paid.
 *
 * Two plans, two readings of "owed". A card settlement since #3653 refunds each
 * child by its own debt, and `organiserChildCommittedRefundCents` counts the
 * refund rows and every debt still owed. A plan frozen before #3653, or an
 * Internet Banking settlement's, is the `{childId: cents}` mirror plan: the
 * child's mirror before this cancel plus its planned share, whether or not the
 * card refund has gone through yet (a failed one is replayed from the plan).
 */
export async function groupSettledChildCancellationKeptCents(
  db: Prisma.TransactionClient,
  child: {
    status: BookingStatus;
    payment: { id: string; status: string; amountCents: number; refundedAmountCents: number } | null;
  },
  plan: { kind: "per-child"; paymentIntentId: string } | { kind: "mirror"; plannedRefundCents: number },
): Promise<number> {
  const payment = child.payment;
  if (child.status !== BookingStatus.PAID || !payment || !hasCapturedPayment(payment)) return 0;
  const committedRefundCents =
    plan.kind === "per-child"
      ? await organiserChildCommittedRefundCents(db, payment, plan.paymentIntentId)
      : payment.refundedAmountCents + plan.plannedRefundCents;
  return cancellationKeptCents({
    retainedAmountCents: Math.max(0, payment.amountCents - committedRefundCents),
    appliedCreditCents: 0,
    creditRestoredCents: 0,
  });
}
