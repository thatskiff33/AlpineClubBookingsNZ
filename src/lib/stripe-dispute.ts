/**
 * #4911 (`INV-PAY-154`): a cardholder's dispute (chargeback) of a Stripe payment.
 *
 * Stripe takes a disputed amount back from the club's balance outside the app,
 * and before #4911 the webhook endpoint did not subscribe to `charge.dispute.*`,
 * so nothing told the treasurer, and a cancel could refund or credit a member
 * the bank had already paid back.
 *
 * Now each of the four dispute events keeps ONE durable `StripeDispute` row per
 * dispute, claimed by its unique `stripeDisputeId`:
 * - the first event to arrive inserts it (duplicates skipped), whichever it is,
 *   so an out-of-order `closed` still records the dispute;
 * - every event then merges its snapshot under the row's lock
 *   (`mergeDisputeSnapshot`): a closed dispute never reads open again, an older
 *   event never overwrites a newer one, and a replay changes nothing;
 * - the capture is matched by `stripePaymentIntentId` to its payment
 *   transaction (or a group organiser's settlement), so the row names the
 *   booking; an unknown charge is recorded with no booking and still alerts.
 *
 * Two unmuteable Finance-editor alerts, each once ever per dispute: one when it
 * opens (raised by whichever event first records it) and one when it closes.
 * A third (#5061 follow-up) when a dispute closed as lost is reported won by a
 * newer event: the lost alert told the treasurer to record the loss in Xero, so
 * this one says to reverse it. The merge that sees LOST become WON writes its
 * durable owed marker in the same transaction, since a redelivery reads the row
 * already WON and could not see the change again.
 * Each is claimed by its once-ever `AlertCooldown` key and stamped on the row
 * once a recipient was sent, as #4532's unrecognised-payment alert is
 * (`INV-INT-032`): a send nobody received throws and the webhook answers 500 so
 * Stripe redelivers.
 *
 * A record and a hold, and no money moves: nothing here writes a ledger line,
 * a refund, `Payment.refundedAmountCents` or Xero. The hold is read by
 * `disputedCaptureCents` (`stripe-dispute-hold.ts`). Its one journal effect
 * (#5197, `INV-PAY-154`): a late win reopens each hand-back task dismissed while
 * the dispute read lost, posting its refund debt again
 * (`stripe-dispute-late-win.ts`), once the move to WON has committed.
 *
 * Two deliveries of one dispute are decided by the unique key and the row lock.
 * A WON event also takes `pg_advisory_xact_lock(1)` first, bounded, so a move
 * from LOST to WON never interleaves with an officer's Dismiss or Reduce of a
 * hand-back on the payment (#5197); no other event takes an advisory lock. The
 * charge read, a provider call, runs before any write.
 */
import type Stripe from "stripe";
import { StripeDisputeStatus, type StripeDispute } from "@prisma/client";

import { findHeldOnceEverAlertKeys } from "@/lib/admin-alert-once";
import { sendAdminAlertOnceEverWithTakeover } from "@/lib/admin-alert-once-takeover";
import { ALERT_ONCE_EVER_WINDOW_MS, claimAlertCooldown, settleOwedAlert } from "@/lib/alert-cooldown";
import { bookingOwner } from "@/lib/booking-owner";
import type { ClubFormat } from "@/lib/club-format";
import { sendAdminStripeDisputeAlert } from "@/lib/email";
import { UNMUTEABLE_ALERT_SENT } from "@/lib/email/admin-alert-send-result";
import type { StripeDisputeAlertFields } from "@/lib/email-templates/admin-stripe-dispute";
import { emailClubDateTime } from "@/lib/email-templates-club-time";
import logger from "@/lib/logger";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";
import { setTransactionLockTimeout } from "@/lib/member-merge-booking-lock";
import { prisma } from "@/lib/prisma";
import { getChargePaymentIntentId } from "@/lib/stripe-charge";
import {
  STRIPE_DISPUTE_NEXT_STEP,
  STRIPE_DISPUTE_STATUS_LABEL,
  stripeDisputeWonAfterLossNextStep,
  type LateWinHandBackReport,
  type StripeDisputeAlertStage,
} from "@/lib/stripe-dispute-note";
import { settleLateWinHandBacks } from "@/lib/stripe-dispute-late-win";
import { stripeDisputeAlertKey, stripeDisputeWonAfterLossOwedKey } from "@/lib/stripe-dispute-keys";
import {
  UNRECOGNISED_ALERT_IN_FLIGHT_MS,
  stripeDashboardPaymentUrl,
  unrecognisedPaymentAmountLabel,
} from "@/lib/unrecognised-stripe-payment";

/** A bounded charge read, as a webhook's other Stripe reads. */
export const STRIPE_DISPUTE_CHARGE_READ_TIMEOUT_MS = 10_000;

/** What an absent value reads as in the alert. */
const NONE = "None";

/** Stripe's status, as the app's lifecycle. Anything not closed holds as OPEN. */
export function disputeStatusFromStripe(status: string): StripeDisputeStatus {
  switch (status) {
    case "won":
      return StripeDisputeStatus.WON;
    case "lost":
      return StripeDisputeStatus.LOST;
    case "warning_closed":
    case "prevented":
      return StripeDisputeStatus.CLOSED_OTHER;
    default:
      return StripeDisputeStatus.OPEN;
  }
}

export function disputeIsClosed(status: StripeDisputeStatus): boolean {
  return status !== StripeDisputeStatus.OPEN;
}

/** What one event says about the dispute. */
export type DisputeSnapshot = {
  amountCents: number;
  currency: string;
  reason: string;
  status: StripeDisputeStatus;
  stripeStatus: string;
  withdrawnCents: number;
  reinstatedCents: number;
  eventCreatedAt: Date;
};

type StoredSnapshot = Pick<
  StripeDispute,
  | "amountCents"
  | "currency"
  | "reason"
  | "status"
  | "stripeStatus"
  | "withdrawnCents"
  | "reinstatedCents"
  | "lastEventCreatedAt"
>;

/**
 * The dispute's balance movements as Stripe lists them on the object: negative
 * amounts left the club's balance, positive ones came back. Fees included,
 * since each balance transaction's `net` carries them.
 */
export function disputeBalanceMovements(
  balanceTransactions: ReadonlyArray<Pick<Stripe.BalanceTransaction, "net">> | null | undefined,
): { withdrawnCents: number; reinstatedCents: number } {
  let withdrawnCents = 0;
  let reinstatedCents = 0;
  for (const transaction of balanceTransactions ?? []) {
    if (transaction.net < 0) withdrawnCents += -transaction.net;
    else reinstatedCents += transaction.net;
  }
  return { withdrawnCents, reinstatedCents };
}

export function disputeSnapshot(dispute: Stripe.Dispute, event: Pick<Stripe.Event, "created">): DisputeSnapshot {
  return {
    amountCents: dispute.amount,
    currency: dispute.currency,
    reason: dispute.reason,
    status: disputeStatusFromStripe(dispute.status),
    stripeStatus: dispute.status,
    ...disputeBalanceMovements(dispute.balance_transactions),
    eventCreatedAt: new Date(event.created * 1000),
  };
}

/**
 * The stored dispute after one event, monotonic so delivery order cannot undo
 * it: a closed dispute never reads open again; between two closed outcomes, and
 * for the other fields, the newer event wins (a tie keeps the stored row); the
 * balance movements only grow, since every event lists them all.
 */
export function mergeDisputeSnapshot(stored: StoredSnapshot, incoming: DisputeSnapshot): StoredSnapshot {
  const newer = incoming.eventCreatedAt.getTime() > stored.lastEventCreatedAt.getTime();
  const reopens = disputeIsClosed(stored.status) && !disputeIsClosed(incoming.status);
  const closes = !disputeIsClosed(stored.status) && disputeIsClosed(incoming.status);
  const takeStatus = !reopens && (closes || newer);
  return {
    amountCents: newer ? incoming.amountCents : stored.amountCents,
    currency: newer ? incoming.currency : stored.currency,
    reason: newer ? incoming.reason : stored.reason,
    status: takeStatus ? incoming.status : stored.status,
    stripeStatus: takeStatus ? incoming.stripeStatus : stored.stripeStatus,
    withdrawnCents: Math.max(stored.withdrawnCents, incoming.withdrawnCents),
    reinstatedCents: Math.max(stored.reinstatedCents, incoming.reinstatedCents),
    lastEventCreatedAt: newer ? incoming.eventCreatedAt : stored.lastEventCreatedAt,
  };
}

function sameSnapshot(left: StoredSnapshot, right: StoredSnapshot): boolean {
  return (
    left.amountCents === right.amountCents &&
    left.currency === right.currency &&
    left.reason === right.reason &&
    left.status === right.status &&
    left.stripeStatus === right.stripeStatus &&
    left.withdrawnCents === right.withdrawnCents &&
    left.reinstatedCents === right.reinstatedCents &&
    left.lastEventCreatedAt.getTime() === right.lastEventCreatedAt.getTime()
  );
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

/** The disputed capture's PaymentIntent: the dispute's own, else its charge's. */
async function resolvePaymentIntentId(dispute: Stripe.Dispute): Promise<string | null> {
  const own = idOf(dispute.payment_intent);
  if (own) return own;
  const chargeId = idOf(dispute.charge);
  if (!chargeId) return null;
  return getChargePaymentIntentId(chargeId, STRIPE_DISPUTE_CHARGE_READ_TIMEOUT_MS);
}

/**
 * The app's capture for this intent, read only: its transaction, else a
 * pre-ledger payment, else a group organiser's settlement, which names the
 * organiser's booking (its payment is the settlement, not a `Payment`).
 */
async function matchCapture(
  paymentIntentId: string | null,
): Promise<{ paymentTransactionId: string | null; paymentId: string | null; bookingId: string | null }> {
  const none = { paymentTransactionId: null, paymentId: null, bookingId: null };
  if (!paymentIntentId) return none;
  const transaction = await prisma.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { id: true, paymentId: true, payment: { select: { bookingId: true } } },
  });
  if (transaction) {
    return {
      paymentTransactionId: transaction.id,
      paymentId: transaction.paymentId,
      bookingId: transaction.payment.bookingId,
    };
  }
  const payment = await prisma.payment.findFirst({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { id: true, bookingId: true },
  });
  if (payment) return { paymentTransactionId: null, paymentId: payment.id, bookingId: payment.bookingId };
  const settlement = await prisma.groupBookingSettlement.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { groupBooking: { select: { organiserBookingId: true } } },
  });
  return settlement ? { ...none, bookingId: settlement.groupBooking.organiserBookingId } : none;
}

/** The stored row for this dispute: the existing one, or the one this delivery inserts. */
async function claimRecord(dispute: Stripe.Dispute, event: Stripe.Event): Promise<StripeDispute> {
  const where = { stripeDisputeId: dispute.id };
  const existing = await prisma.stripeDispute.findUnique({ where });
  if (existing) return existing;

  const paymentIntentId = await resolvePaymentIntentId(dispute);
  const match = await matchCapture(paymentIntentId);
  const snapshot = disputeSnapshot(dispute, event);
  await prisma.stripeDispute.createMany({
    data: [
      {
        stripeDisputeId: dispute.id,
        stripeChargeId: idOf(dispute.charge) ?? NONE,
        stripePaymentIntentId: paymentIntentId,
        ...match,
        amountCents: snapshot.amountCents,
        currency: snapshot.currency,
        withdrawnCents: snapshot.withdrawnCents,
        reinstatedCents: snapshot.reinstatedCents,
        reason: snapshot.reason,
        status: snapshot.status,
        stripeStatus: snapshot.stripeStatus,
        stripeCreatedAt: new Date(dispute.created * 1000),
        lastEventCreatedAt: snapshot.eventCreatedAt,
        stripeEventId: event.id,
      },
    ],
    skipDuplicates: true,
  });
  // Ours or a concurrent delivery's: both describe the same dispute.
  const stored = await prisma.stripeDispute.findUnique({ where });
  if (!stored) {
    throw new Error(`The record of Stripe dispute ${dispute.id} was not found after it was written`);
  }
  return stored;
}

/** #5197: how long a WON event waits for `lock(1)` before the webhook answers 500 and Stripe redelivers. */
export const STRIPE_DISPUTE_WON_LOCK_TIMEOUT_MS = 5_000;

/**
 * Apply this event to the stored row under its lock; a replay writes nothing. A WON event first takes `lock(1)`
 * (#5197), bounded, so a move from LOST to WON is serialised with every officer's Dismiss and Reduce of a dispute-loss
 * hand-back, which decide under `lock(1)` on the disputes as recorded: the officer either reads WON and is refused,
 * or commits first and the late win finds the task dismissed or reduced. A timeout throws, writing nothing.
 */
async function applyEvent(row: StripeDispute, snapshot: DisputeSnapshot): Promise<StripeDispute> {
  return prisma.$transaction(async (tx) => {
    if (snapshot.status === StripeDisputeStatus.WON) {
      await setTransactionLockTimeout(tx, STRIPE_DISPUTE_WON_LOCK_TIMEOUT_MS);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    }
    // Lock raw, read typed (`INV-OPS-001`): a concurrent event's merge waits.
    await tx.$executeRaw`SELECT 1 FROM "StripeDispute" WHERE "id" = ${row.id} FOR NO KEY UPDATE`;
    const current = await tx.stripeDispute.findUniqueOrThrow({ where: { id: row.id } });
    const merged = mergeDisputeSnapshot(current, snapshot);
    if (sameSnapshot(current, merged)) return current;
    if (current.status === StripeDisputeStatus.LOST && merged.status === StripeDisputeStatus.WON) {
      // #5061 follow-up: owed until sent, settled by `ensureWonAfterLossAlert`.
      const key = stripeDisputeWonAfterLossOwedKey(row.stripeDisputeId);
      await tx.alertCooldown.upsert({ where: { key }, create: { key, lastAlertedAt: new Date() }, update: {} });
    }
    return tx.stripeDispute.update({ where: { id: row.id }, data: merged });
  }, LOCK1_HOLDER_TRANSACTION_BUDGET);
}

/**
 * Record one `charge.dispute.*` event and raise the alerts it owes. Throws when
 * an owed alert reached nobody, so the webhook answers 500 and Stripe redelivers.
 */
export async function recordStripeDispute(
  dispute: Stripe.Dispute,
  event: Stripe.Event,
  format: ClubFormat,
): Promise<void> {
  const claimed = await claimRecord(dispute, event);
  const row = await applyEvent(claimed, disputeSnapshot(dispute, event));
  logger.warn(
    {
      disputeId: row.stripeDisputeId,
      eventType: event.type,
      paymentIntentId: row.stripePaymentIntentId,
      bookingId: row.bookingId,
      amountCents: row.amountCents,
      status: row.status,
      stripeStatus: row.stripeStatus,
    },
    row.bookingId
      ? "Stripe dispute on a booking payment: recorded, refunds and credits for it held (#4911)"
      : "Stripe dispute on a charge the app does not know: recorded with no booking (#4911)",
  );

  // Every dispute opened once, whichever event recorded it first.
  await ensureAlert(row, "opened", event.livemode, format);
  if (disputeIsClosed(row.status)) {
    await ensureAlert(row, "closed", event.livemode, format);
  }
  await ensureWonAfterLossAlert(row, event.livemode, format);
}

type AlertStage = StripeDisputeAlertStage;

/**
 * Send the won-after-loss alert while its owed marker stands, then settle the
 * marker. A replay after the send finds the once-ever claim kept and sends
 * nothing; an OPEN dispute that is won never writes the marker. Runs after the
 * move to WON committed (`applyEvent`); until the alert is sent, each delivery
 * first reopens the hand-backs the loss dismissed (#5197,
 * `settleLateWinHandBacks`, which never throws) and the alert names them.
 */
async function ensureWonAfterLossAlert(row: StripeDispute, livemode: boolean, format: ClubFormat): Promise<void> {
  // The marker is written only on a move to WON, so no other row can owe it.
  if (row.status !== StripeDisputeStatus.WON) return;
  const key = stripeDisputeWonAfterLossOwedKey(row.stripeDisputeId);
  const owed = await prisma.alertCooldown.findUnique({ where: { key }, select: { key: true } });
  if (!owed) return;
  if (!(await alertWasSent(row, "won-after-loss"))) {
    await ensureAlert(row, "won-after-loss", livemode, format, await settleLateWinHandBacks(row));
  }
  await settleOwedAlert({ key });
}

/** The marker that the alert went out although its stamp on the row failed. */
export function stripeDisputeAlertSentKey(disputeId: string, stage: AlertStage): string {
  return `${stripeDisputeAlertKey(disputeId, stage)}:sent`;
}

/** The alert was neither sent nor left claimed, so the webhook must fail and Stripe redeliver. */
export class StripeDisputeAlertNotSentError extends Error {
  constructor(readonly disputeId: string, readonly stage: AlertStage) {
    super(`The ${stage} alert for Stripe dispute ${disputeId} was not sent; Stripe will redeliver`);
    this.name = "StripeDisputeAlertNotSentError";
  }
}

/** The row's stamp per stage; the won-after-loss alert has none and is known by its sent marker alone. */
const STAMP_FIELD: Record<AlertStage, "openedAlertedAt" | "closedAlertedAt" | null> = {
  opened: "openedAlertedAt",
  closed: "closedAlertedAt",
  "won-after-loss": null,
};

/**
 * Send one stage's alert once, by the shared sequence #4532's alert uses
 * (`sendAdminAlertOnceEverWithTakeover`, #4690), with the same in-flight window
 * against the same webhook lease.
 */
async function ensureAlert(
  row: StripeDispute,
  stage: AlertStage,
  livemode: boolean,
  format: ClubFormat,
  lateWin: LateWinHandBackReport | null = null,
): Promise<void> {
  const stampField = STAMP_FIELD[stage];
  if (stampField && row[stampField] != null) return;
  const key = stripeDisputeAlertKey(row.stripeDisputeId, stage);
  const context = { disputeId: row.stripeDisputeId, stage };
  const fields = await alertFields(row, stage, livemode, format, lateWin);
  const outcome = await sendAdminAlertOnceEverWithTakeover({
    key,
    label: `Stripe dispute ${stage} alert`,
    context,
    send: async () => {
      // `queued-for-retry` means the email retry cron holds every copy.
      const sent = await sendAdminStripeDisputeAlert(fields);
      if (sent === "undelivered") throw new StripeDisputeAlertNotSentError(row.stripeDisputeId, stage);
      await stampAlertSent(row, stage, context);
      return UNMUTEABLE_ALERT_SENT;
    },
    isSent: () => alertWasSent(row, stage),
    inFlightMs: UNRECOGNISED_ALERT_IN_FLIGHT_MS,
  });
  if (outcome === "not-sent" || outcome === "taken-over") {
    throw new StripeDisputeAlertNotSentError(row.stripeDisputeId, stage);
  }
}

/** Stamp the row once the alert went out; a failed write falls back to the sent marker. */
async function stampAlertSent(row: StripeDispute, stage: AlertStage, context: Record<string, unknown>): Promise<void> {
  const stampField = STAMP_FIELD[stage];
  if (stampField) {
    try {
      await prisma.stripeDispute.update({ where: { id: row.id }, data: { [stampField]: new Date() } });
      return;
    } catch (err) {
      logger.error({ ...context, err }, "The Stripe dispute alert was sent, but its stamp failed; writing the sent marker");
    }
  }
  const sentKey = stripeDisputeAlertSentKey(row.stripeDisputeId, stage);
  await claimAlertCooldown({ key: sentKey, windowMs: ALERT_ONCE_EVER_WINDOW_MS }).catch((err) =>
    logger.error({ ...context, err }, "The Stripe dispute alert was sent, but neither its stamp nor its sent marker was written"),
  );
}

async function alertWasSent(row: StripeDispute, stage: AlertStage): Promise<boolean> {
  const current = await prisma.stripeDispute.findUnique({
    where: { id: row.id },
    select: { openedAlertedAt: true, closedAlertedAt: true },
  });
  const stampField = STAMP_FIELD[stage];
  if (stampField && current?.[stampField] != null) return true;
  const sentKey = stripeDisputeAlertSentKey(row.stripeDisputeId, stage);
  return (await findHeldOnceEverAlertKeys([sentKey], new Date())).has(sentKey);
}

/** Who the booking is for: its member, else its organisation. */
async function bookingOwnerName(bookingId: string | null): Promise<string> {
  if (!bookingId) return NONE;
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      memberId: true,
      member: { select: { firstName: true, lastName: true } },
      organisation: { select: { name: true } },
    },
  });
  if (!booking) return NONE;
  // `INV-SSOT-005`: the accessor answers who owns it, member or organisation.
  // Only the owner projection is selected, never the organisation link
  // (#3367): this decides nothing about a school. A member named but
  // unreadable comes back empty; the alert still goes.
  const owner = bookingOwner(booking).member as { firstName: string; lastName: string } | null;
  if (!owner) return NONE;
  return `${owner.firstName} ${owner.lastName}`.trim() || NONE;
}

async function alertFields(
  row: StripeDispute,
  stage: AlertStage,
  livemode: boolean,
  format: ClubFormat,
  lateWin: LateWinHandBackReport | null,
): Promise<StripeDisputeAlertFields> {
  // The opened alert reports the dispute as open, whatever event raised it.
  const status = stage === "opened" ? StripeDisputeStatus.OPEN : row.status;
  return {
    stage,
    outcome: STRIPE_DISPUTE_STATUS_LABEL[status],
    amount: unrecognisedPaymentAmountLabel(row.amountCents, row.currency, format),
    reason: row.reason.replaceAll("_", " "),
    openedAt: emailClubDateTime(row.stripeCreatedAt),
    bookingId: row.bookingId ?? "None - the app has no payment for this charge",
    bookingOwner: await bookingOwnerName(row.bookingId),
    disputeId: row.stripeDisputeId,
    paymentIntentId: row.stripePaymentIntentId ?? NONE,
    chargeId: row.stripeChargeId,
    disputeNextStep: stage === "won-after-loss"
      ? stripeDisputeWonAfterLossNextStep(lateWin ?? { kind: "read-failed" }, (cents) => unrecognisedPaymentAmountLabel(cents, row.currency, format))
      : STRIPE_DISPUTE_NEXT_STEP[status],
    stripeDashboardUrl: stripeDashboardPaymentUrl(row.stripePaymentIntentId ?? row.stripeChargeId, livemode),
  };
}
