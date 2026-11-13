/**
 * #4911 (`INV-PAY-153`): the one read of "is this capture disputed".
 *
 * A cardholder's dispute (chargeback) takes the disputed amount back through
 * Stripe, outside the app. While it is OPEN, or once it is LOST, a refund or an
 * account credit for the same capture would pay the member twice, so every
 * card-refund door (`processRefund`) and every cancel account-credit door reads
 * `disputedCaptureCents` here. A WON dispute, or one Stripe closed with no funds
 * taken, holds nothing and the normal path resumes.
 *
 * DB only: no Stripe import, so `stripe.ts` can read it without a cycle.
 */
import { StripeDisputeStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { HOLDING_DISPUTE_STATUSES } from "@/lib/stripe-dispute-note";

type DisputeReader = Pick<Prisma.TransactionClient, "stripeDispute">;

export type HoldingDispute = {
  stripeDisputeId: string;
  stripePaymentIntentId: string;
  status: StripeDisputeStatus;
  amountCents: number;
};

/** The holding disputes on these captures, oldest first: the one query behind `disputedCaptureCents`. */
async function findHoldingDisputes(
  db: DisputeReader,
  paymentIntentIds: readonly (string | null | undefined)[],
): Promise<HoldingDispute[]> {
  const ids = [...new Set(paymentIntentIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return [];
  const rows = await db.stripeDispute.findMany({
    where: { stripePaymentIntentId: { in: ids }, status: { in: [...HOLDING_DISPUTE_STATUSES] } },
    select: { stripeDisputeId: true, stripePaymentIntentId: true, status: true, amountCents: true },
    orderBy: [{ stripeCreatedAt: "asc" }, { stripeDisputeId: "asc" }],
  });
  return rows.map((row) => ({ ...row, stripePaymentIntentId: row.stripePaymentIntentId ?? "" }));
}

/** What the holding disputes on a set of captures claim, and which disputes they are. */
export type CaptureDisputeHold = { cents: number; disputes: HoldingDispute[] };

/**
 * THE read every card-refund and account-credit door makes: the cents an OPEN
 * or LOST dispute holds on these captures (0 when none, or every one is won or
 * closed with no funds taken), with the disputes, so a refusal can name them.
 * Above zero, no card refund or account credit may be issued for them. Inside a
 * caller's transaction, read it after that caller's locks (`INV-LOCK-001`).
 */
export async function disputedCaptureCents(
  db: DisputeReader,
  paymentIntentIds: readonly (string | null | undefined)[],
): Promise<CaptureDisputeHold> {
  const disputes = await findHoldingDisputes(db, paymentIntentIds);
  return { cents: disputes.reduce((sum, dispute) => sum + dispute.amountCents, 0), disputes };
}

/**
 * Every capture a booking payment holds: its ledger rows' PaymentIntents and the
 * mirror's own two, so a capture recorded before the ledger is not missed.
 */
export async function paymentCaptureIntentIds(
  db: Pick<Prisma.TransactionClient, "paymentTransaction">,
  payment: { id: string; stripePaymentIntentId: string | null; additionalPaymentIntentId: string | null },
): Promise<string[]> {
  const rows = await db.paymentTransaction.findMany({
    where: { paymentId: payment.id, stripePaymentIntentId: { not: null } },
    select: { stripePaymentIntentId: true },
  });
  const ids = [payment.stripePaymentIntentId, payment.additionalPaymentIntentId, ...rows.map((row) => row.stripePaymentIntentId)];
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/** A refund the chokepoint refused because its capture is disputed. */
export class DisputedCaptureRefundRefusedError extends Error {
  override name = "DisputedCaptureRefundRefusedError";
  readonly paymentIntentId: string;
  readonly disputes: HoldingDispute[];

  constructor(paymentIntentId: string, disputes: HoldingDispute[]) {
    super(
      `Refund refused: the payment ${paymentIntentId} is disputed by the cardholder ` +
        `(${disputes.map((dispute) => `${dispute.stripeDisputeId}, ${dispute.status.toLowerCase()}`).join("; ")}). ` +
        "The treasurer settles it by hand (INV-PAY-153).",
    );
    this.paymentIntentId = paymentIntentId;
    this.disputes = disputes;
  }

  /** True when any dispute is LOST: waiting will not release the refund. */
  get lost(): boolean {
    return this.disputes.some((dispute) => dispute.status === StripeDisputeStatus.LOST);
  }
}

/**
 * The card-refund chokepoint's guard, read before Stripe is asked. Throws while
 * the capture has a holding dispute; a won one lets the refund through.
 */
export async function assertCaptureNotDisputed(
  paymentIntentId: string,
  db: DisputeReader = prisma,
): Promise<void> {
  const hold = await disputedCaptureCents(db, [paymentIntentId]);
  if (hold.cents > 0) {
    throw new DisputedCaptureRefundRefusedError(paymentIntentId, hold.disputes);
  }
}

/**
 * The refusal, bare or as the cause of `refundPaymentTransactions`'s
 * `PartialRefundError`. Matched by name so a caller need not import the class.
 */
export function disputedCaptureRefusal(error: unknown): DisputedCaptureRefundRefusedError | null {
  if (error instanceof DisputedCaptureRefundRefusedError) return error;
  if (error instanceof Error && error.name === "PartialRefundError") {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof DisputedCaptureRefundRefusedError) return cause;
  }
  return null;
}

/**
 * #4911 (`INV-PAY-153`): the disputes on these payments, newest first, keyed by
 * payment - Finance -> Payments' dispute marker. A display read, not the hold.
 */
export async function readDisputesByPaymentId(
  db: DisputeReader,
  paymentIds: string[],
): Promise<Map<string, Array<{ stripeDisputeId: string; status: StripeDisputeStatus; amountCents: number }>>> {
  const byPayment = new Map<string, Array<{ stripeDisputeId: string; status: StripeDisputeStatus; amountCents: number }>>();
  if (paymentIds.length === 0) return byPayment;
  const disputes = await db.stripeDispute.findMany({
    where: { paymentId: { in: paymentIds } },
    select: { paymentId: true, stripeDisputeId: true, status: true, amountCents: true },
    orderBy: [{ stripeCreatedAt: "desc" }, { stripeDisputeId: "asc" }],
  });
  for (const { paymentId, ...dispute } of disputes) {
    if (paymentId) byPayment.set(paymentId, [...(byPayment.get(paymentId) ?? []), dispute]);
  }
  return byPayment;
}
