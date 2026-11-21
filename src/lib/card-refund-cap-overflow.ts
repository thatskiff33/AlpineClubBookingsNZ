import { createHash } from "crypto";

import type { Prisma } from "@prisma/client";

import { compareOrdinal } from "@/lib/ordinal-order";
import logger from "@/lib/logger";
import { NON_CANCELLATION_HAND_BACK_WHERE, NOT_NON_CANCELLATION_HAND_BACK_WHERE } from "@/lib/manual-refund-task-settlement-rules";
import { EXCLUDED_LEDGER_REFUND_STATUSES } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { accountCreditDispositionCents } from "@/lib/stripe-cash-refund-evidence";
import { formatCents } from "@/lib/utils";

/**
 * #4159 review round 2 (F2, `INV-PAY-135`): A CARD REFUND THE CHARGE'S
 * REFUNDED TOTAL COULD NOT HOLD.
 *
 * `recordStripeRefundsAgainstTransaction` caps a charge's refunded total at the
 * charge. Cents it has to discard are refund money already counted another
 * way - most often a hand-back or "Paid another way" close recorded by hand on
 * the same charge, then a card refund made for the same money (a capacity
 * race's hand-back whose charge Stripe refunded after the completion read it).
 * The member may have been paid back twice - where money already went back
 * another way on the payment (`memberPaidAnotherWay`) - or the charge's records
 * simply drifted. The alert says which. The cap keeps
 * the ledger whole, so nothing else would ever show it: the officers are told,
 * once per charge and set of counted refunds (a replay of the same refunds
 * alerts nothing new, any new refund does),
 * through the payment recovery alert, after the refund's own commit - never
 * inside it. The alert's claim and the email row are the durable record; the
 * error log stays beside them. Nothing raises it again, so the alert is stored
 * for the payments cron's sweep, which re-sends it until it is out
 * (`sendReplayableAdminAlertOnceEver`, #5255, `INV-INT-042`).
 */
export type CardRefundCapOverflow = {
  paymentId: string;
  paymentTransactionId: string;
  discardedCents: number;
  /** The charge's recorded, non-refused card refunds when the cap discarded. */
  recordedRefundCents: number;
  /** Round 3 (4): the Stripe ids of those refunds - the alert's key, in any order. */
  countedRefundIds: readonly string[];
};

export function cardRefundCapOverflowAlertKey(overflow: CardRefundCapOverflow): string {
  const refunds = createHash("sha256").update([...overflow.countedRefundIds].sort(compareOrdinal).join(",")).digest("hex").slice(0, 24);
  return `card-refund-cap-overflow:${overflow.paymentTransactionId}:${refunds}`;
}

/**
 * The overflow a refund write's cap discarded, or null: logged as an error here, inside the write's transaction; the
 * officers are alerted after its commit (`alertCardRefundCapOverflow`). Round 3 (4): it names the refunds the charge
 * counts, which key the alert, so a replay of them alerts nothing new and any new refund does.
 */
export async function readCardRefundCapOverflow(
  db: Pick<Prisma.TransactionClient, "paymentRefund">,
  params: Omit<CardRefundCapOverflow, "countedRefundIds"> & { previousCents: number; nextCents: number },
): Promise<CardRefundCapOverflow | null> {
  const { previousCents, nextCents, ...overflow } = params;
  if (overflow.discardedCents <= 0) return null;
  logger.error({ ...overflow, previousCents, nextCents }, "A card refund took this charge's refunded total past the charge; the excess was discarded - check whether the member was also paid back another way (#4154)");
  const counted = await db.paymentRefund.findMany({
    where: { paymentTransactionId: overflow.paymentTransactionId, status: { notIn: EXCLUDED_LEDGER_REFUND_STATUSES } },
    select: { stripeRefundId: true },
  });
  return { ...overflow, countedRefundIds: counted.map((row) => row.stripeRefundId) };
}

/**
 * Round 3 (3), round 4 (F1): "paid twice" wherever the member already has money back another way - a hand-back marked
 * paid back (a cancellation's, an edit's or a refund request's), a card refund closed as Paid another way, or account
 * credit given back from the booking; otherwise the records drifted.
 */
export function cardRefundCapOverflowMessage(discarded: string, paidAnotherWay: boolean): string {
  const lead = `A card refund took this booking's card charge past what was charged: ${discarded} of refunds could not be recorded against it.`;
  return paidAnotherWay
    ? `${lead} The member has already had money back another way on this payment - a hand-back marked paid back, a card refund closed as Paid another way, or account credit given back - so they may have been paid back twice. Check the charge in Stripe, the bank transfers and the member's account credit, and recover any overpayment from the member.`
    : `${lead} The charge's records already read it fully refunded with nothing on record behind it (record drift). Check the charge in Stripe against the booking's payment records.`;
}

/**
 * Round 4 (F1), round 5 (2, 3): has the member already had money back another way on this payment or booking? A
 * wording-only read: it picks the email's sentence, never a figure.
 * - Every completed hand-back on the payment: a cancellation's (with `INV-PAY-117`'s exclusion, its census's one
 *   spelling), and an edit's, a refund request's or a Paid-another-way close (`NON_CANCELLATION_HAND_BACK_WHERE`).
 * - A booking-change review paid back by hand: completed, owed to the member, on a booking whose payment is not a card
 *   payment (`local-allocation`, `editReviewRefundGoesBackOnCard`). Such a payment can still hold a card charge - one
 *   captured before an Internet Banking switch and refunded (`INV-PAY-102`), or a second instrument kept - so a card
 *   refund can overflow beside that by-hand money.
 * - Account credit given back from the booking (`accountCreditDispositionCents`). Matched by booking, not by charge,
 *   so it can say "paid twice" for credit that had nothing to do with this charge: erring on the safe side, since the
 *   email then asks for a check the drift wording would also want.
 */
async function memberPaidAnotherWay(paymentId: string, bookingId: string): Promise<boolean> {
  const handBacks = await prisma.manualRefundTask.count({
    where: {
      status: "COMPLETED",
      OR: [
        { paymentId, OR: [{ kind: "CANCELLED_BOOKING_HAND_BACK", ...NOT_NON_CANCELLATION_HAND_BACK_WHERE }, NON_CANCELLATION_HAND_BACK_WHERE] },
        // A review completed before #3170 stored no direction, and could then only owe the member.
        { bookingId, kind: "EDIT_FINANCIAL_REVIEW", OR: [{ settlementDirection: "REFUND_TO_MEMBER" }, { settlementDirection: null }], booking: { payment: { source: { not: "STRIPE" } } } },
      ],
    },
  });
  return handBacks > 0 || (await accountCreditDispositionCents(prisma, bookingId)) > 0;
}

/** Tell the officers, once per charge and set of counted refunds. After the commit; never throws. */
export async function alertCardRefundCapOverflow(overflow: CardRefundCapOverflow): Promise<boolean> {
  const context = { ...overflow };
  try {
    const row = await prisma.paymentTransaction.findUnique({
      where: { id: overflow.paymentTransactionId },
      select: { stripePaymentIntentId: true, payment: { select: { bookingId: true } } },
    });
    const bookingId = row?.payment?.bookingId ?? null;
    if (!bookingId) {
      logger.error(context, "A card refund's discarded cents have no booking to alert the officers about (#4159)");
      return false;
    }
    const paidAnotherWay = await memberPaidAnotherWay(overflow.paymentId, bookingId);
    // Loaded here, not at the top: the payment ledger imports this module, and the alert's own imports reach back to it.
    const [{ clubFormatValues }, { sendReplayableAdminAlertOnceEver }] = await Promise.all([
      import("@/lib/club-format-server"),
      import("@/lib/admin-alert-once-replayable"),
    ]);
    const format = await clubFormatValues();
    return await sendReplayableAdminAlertOnceEver({
      key: cardRefundCapOverflowAlertKey(overflow),
      label: "card refund past its charge alert",
      context,
      alert: {
        kind: "payment-recovery",
        bookingId,
        amountCents: overflow.discardedCents,
        paymentIntentId: row?.stripePaymentIntentId ?? "",
        errorMessage: cardRefundCapOverflowMessage(formatCents(overflow.discardedCents, format), paidAnotherWay),
      },
      format,
    });
  } catch (err) {
    logger.error({ ...context, err }, "Could not alert the officers to a card refund past its charge (#4159)");
    return false;
  }
}
