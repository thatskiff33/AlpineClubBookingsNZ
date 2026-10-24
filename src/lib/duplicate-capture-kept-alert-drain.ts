/**
 * #4285 review (`INV-PAY-043`): THE PAYMENTS CRON'S DRAIN for an owed
 * `new-capture` alert - a card capture kept on a PAID or COMPLETED booking
 * with no record of its settler and no other payment the app counts as
 * settling it.
 *
 * The settle records the alert as owed in the transaction that keeps the
 * capture (`recordNewCaptureAlertOwed`), and a delivered alert clears it
 * (`alertCaptureKeptWithoutRecordedSettler`). A crash between the commit and
 * the alert, or a send that throws, leaves the marker standing. The capture's
 * next arrival re-alerts while it stands, but a delivery the app already
 * answered 200 is never re-sent by Stripe, so this run is the trigger nothing
 * else guarantees. It goes through the same alert, so the once-a-day cooldown
 * still holds; a marker the cooldown blocks waits an hour before the next try.
 *
 * It re-judges what it says before sending, in ONE read-only `RepeatableRead`
 * snapshot (`withReadOnlySnapshot`), so the booking, the capture, the refunds
 * in flight and who else holds money are read as of one moment (no lock: it
 * writes nothing there). A
 * capture whose card no longer holds money (refunded to the card since), a
 * booking gone, or a
 * capture the superseded-payment or duplicate-capture machinery owns leaves
 * nothing to tell: its marker is cleared without an email. While a card refund
 * operation that may take money from this capture is in flight it waits (a
 * cancel's card refund runs newest first and may be refunding this very
 * capture); any other operation on the payment never holds it back. Who else
 * holds money is read the way an admin is told (`readTellingWhere`, the Xero
 * conflict's reading), so a capture behind a dead cancel, or one whose
 * duplicate-capture refund failed later and open rows owe back less than all it
 * holds, is named.
 * A booking cancelled or closed since is told as `new-capture-closed`, naming
 * the cancellation's recorded refund - a card refund read as the booking page
 * reads it (`readCancelledCardRefund`), so one never sent, or one Stripe failed
 * later and owed again, is never said to be refunded; an organiser-card child's
 * as its debt to the organiser's card; a shortfall part as its hand-back task
 * stands - and a payment that holds money beside it as
 * `new-capture-later-payment`. Every alert shows what the
 * card still holds: its amount less the card refunds recorded against it
 * (`sumRecordedRefundsForCapture`), never the ledger's refunded figure, which a
 * refund as account credit also fills. Any delivered
 * alert for the capture clears the marker. Never throws for one marker.
 */
import type { Prisma } from "@prisma/client";
import { listOwedAlertKeys, noteOwedAlertAttempt, settleOwedAlert } from "@/lib/alert-cooldown";
import { bookingOwner } from "@/lib/booking-owner";
import { isPaidLikeBookingStatus } from "@/lib/booking-status";
import {
  readCancelledCardRefund,
  readCardShortfallTaskStatuses,
  readOrganiserChildCancelledCardRefund,
  type CancelledCardRefund,
} from "@/lib/cancel-card-refund-shortfall-status";
import { parsePaidCancellationDecisionSnapshot } from "@/lib/cancellation-settled-money";
import type { ClubFormat } from "@/lib/club-format";
import { clubFormatValues } from "@/lib/club-format-server";
import {
  alertCaptureKeptWithoutRecordedSettler,
  NEW_CAPTURE_ALERT_OWED_PREFIX,
  readOtherSettledCaptureWhere,
} from "@/lib/duplicate-capture-guard";
import type { CancellationRefundNote, ShortfallPartNote } from "@/lib/duplicate-capture-kept-note";
import { paidByOrganiserCard } from "@/lib/group-organiser-paid";
import logger from "@/lib/logger";
import { isManualSettlementMarkerEvent } from "@/lib/manual-settlement-reversal-event";
import type { CardShortfallTaskStatuses } from "@/lib/manual-refund-task-settlement-rules";
import { CARD_REFUND_OPERATION_WHERE, parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import { findCombinedCardSettlementForChild } from "@/lib/organiser-child-refund";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE } from "@/lib/payment-recovery-constants";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import { sumRecordedRefundsForCapture } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { withReadOnlySnapshot } from "@/lib/read-only-snapshot";
import { formatCents } from "@/lib/utils";

/** How long a marker waits before the drain tries it: the post-commit alert goes first. */
export const NEW_CAPTURE_ALERT_DRAIN_AFTER_MS = 60 * 60 * 1000;

/**
 * A card refund operation in flight on the payment that may take money from
 * this capture: its own row or intent, a frozen plan with a slice of it, or no
 * plan yet (a cancel's refund plans newest first when it runs).
 */
function cardRefundInFlightWhere(paymentId: string) {
  return { paymentId, ...CARD_REFUND_OPERATION_WHERE, ...PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE } satisfies Prisma.PaymentRecoveryOperationWhereInput;
}

function refundMayTakeFrom(
  operation: { paymentTransactionId: string | null; paymentIntentId: string; allocationPlan: unknown },
  capture: { id: string; paymentIntentId: string },
): boolean {
  if (operation.paymentTransactionId === capture.id || operation.paymentIntentId === capture.paymentIntentId) return true;
  const plan = parseRefundAllocationPlan(operation.allocationPlan);
  return !plan || plan.some((slice) => slice.paymentTransactionId === capture.id);
}

/**
 * Where the cancel's card refund stands, as the alert says it: the furthest
 * from done of its rows and of the refunds they made that Stripe failed later
 * (each owed again on a row of its own, #4166) - `sent` only once all of it
 * reached the card; no row, `unrecorded`. A close recorded as paid another way
 * names what it left unpaid (its record's, and each such failed-later part's),
 * and where only failed-later parts were closed that way, beside a refund that
 * was made, their amount rather than the whole (#4285 review).
 */
function cardRefundStanding(
  { cardRefundState, cardRefundClose, cardRefundFailedLater = [] }: CancelledCardRefund,
  money: (cents: number) => string,
): Pick<CardRefundNote, "standing" | "unpaid" | "closedAnotherWay"> {
  if (cardRefundState === undefined) return { standing: "unrecorded" };
  const states = [cardRefundState, ...cardRefundFailedLater.map((part) => part.state)];
  if (states.some((state) => state === "stalled" || state === "on-its-way")) return { standing: "not-sent" };
  const closedParts = cardRefundFailedLater.filter((part) => part.state === "paid-another-way");
  const unpaidCents =
    (cardRefundState === "paid-another-way" ? (cardRefundClose?.unpaidCents ?? 0) : 0) + closedParts.reduce((sum, part) => sum + (part.unpaidCents ?? 0), 0);
  const unpaid = unpaidCents > 0 ? { unpaid: money(unpaidCents) } : {};
  if (cardRefundState === "paid-another-way") return { standing: "paid-another-way", ...unpaid };
  if (closedParts.length === 0) return { standing: "sent" };
  return { standing: "sent", closedAnotherWay: money(closedParts.reduce((sum, part) => sum + part.amountCents, 0)), ...unpaid };
}
type CardRefundNote = NonNullable<Extract<CancellationRefundNote, { method: "card" }>["card"]>;

/** A card refund shortfall part's hand-back task, as the alert says it: owed until completed or dismissed. */
function shortfallPart(cents: number, status: CardShortfallTaskStatuses["bank"], money: (cents: number) => string): ShortfallPartNote | null {
  if (cents <= 0) return null;
  return { amount: money(cents), standing: status === "COMPLETED" ? "paid" : status === "DISMISSED" ? "closed" : "owed" };
}

/**
 * The cancellation's own record of its refund: the newest paid-path CANCELLED
 * snapshot (`parsePaidCancellationDecisionSnapshot`). Its card refund is read
 * the way the booking page reads it (`readCancelledCardRefund`, in this
 * snapshot): as its rows stand, never as planned, and not sent while a refund
 * it made that Stripe failed later is owed again. A joiner's booking the group
 * organiser paid for by card (`paidByOrganiserCard`) is refunded to the
 * ORGANISER's card, by its debt under the combined settlement
 * (`readOrganiserChildCancelledCardRefund`), and said so. A card refund
 * shortfall's parts (#4097) are said beside it, each as its hand-back task
 * stands.
 */
async function readCancellationRefund(
  tx: Prisma.TransactionClient,
  booking: { id: string; organiserSettled: boolean; parentBookingId: string | null; payment: { source: string } | null },
  format: ClubFormat,
): Promise<CancellationRefundNote | null> {
  const events = await tx.bookingEvent.findMany({
    where: { bookingId: booking.id, type: "CANCELLED" },
    orderBy: { occurredAt: "desc" },
    select: { type: true, snapshot: true },
  });
  const decision = events.flatMap((event) => {
    const parsed = isManualSettlementMarkerEvent(event) ? null : parsePaidCancellationDecisionSnapshot(event.snapshot);
    return parsed ? [parsed] : [];
  })[0];
  if (!decision) return null;
  const money = (cents: number) => formatCents(cents, format);
  if (decision.refundMethod === "card" && paidByOrganiserCard(booking)) {
    // The debt the joiner's cancel or the group's wrote: what goes to the organiser's card.
    const settlement = await findCombinedCardSettlementForChild(tx, booking);
    const debt = settlement ? await readOrganiserChildCancelledCardRefund(booking.id, settlement.id, tx) : {};
    const cents = debt.amountCents ?? decision.settledAmountCents;
    if (cents <= 0) return { method: "none" };
    return { method: "card", card: { amount: money(cents), ...cardRefundStanding(debt, money), organiserCard: true }, byBank: null, toCheck: null };
  }
  if (decision.settledAmountCents <= 0) return { method: "none" };
  if (decision.refundMethod === "credit" || decision.refundMethod === "manual") return { method: decision.refundMethod, amount: money(decision.settledAmountCents) };
  if (decision.refundMethod !== "card") return null;
  const parts = decision.cardShortfall ?? { cardCents: decision.settledAmountCents, bankCents: 0, checkCents: 0 };
  const tasks = parts.bankCents + parts.checkCents > 0 ? await readCardShortfallTaskStatuses(booking.id, tx) : {};
  return {
    method: "card",
    card: parts.cardCents > 0 ? { amount: money(parts.cardCents), ...cardRefundStanding(await readCancelledCardRefund(booking.id, tx), money) } : null,
    byBank: shortfallPart(parts.bankCents, tasks.bank, money),
    toCheck: shortfallPart(parts.checkCents, tasks.check, money),
  };
}

type Judged =
  | { action: "clear" }
  | { action: "wait" }
  | { action: "send"; alert: Omit<Parameters<typeof alertCaptureKeptWithoutRecordedSettler>[0], "format"> };

/** What to do with one owed marker, read in one snapshot. Read-only. */
async function judgeOwedAlert(bookingId: string, paymentIntentId: string, format: ClubFormat): Promise<Judged> {
  return withReadOnlySnapshot(prisma, async (tx) => {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: { member: true, organisation: { select: { name: true, email: true } }, payment: { select: { source: true } } },
    });
    const capture = await tx.paymentTransaction.findUnique({
      where: { stripePaymentIntentId: paymentIntentId },
      select: { id: true, paymentId: true, status: true, amountCents: true },
    });
    if (!booking || !capture || !isCapturedTransactionStatus(capture.status)) return { action: "clear" };
    // What the CARD still holds: its amount less the card refunds recorded against it.
    const heldCents = capture.amountCents - (await sumRecordedRefundsForCapture(tx, { id: capture.id, paymentIntentId }));
    if (heldCents <= 0) return { action: "clear" };
    const refunds = await tx.paymentRecoveryOperation.findMany({
      where: cardRefundInFlightWhere(capture.paymentId),
      select: { paymentTransactionId: true, paymentIntentId: true, allocationPlan: true },
    });
    if (refunds.some((operation) => refundMayTakeFrom(operation, { id: capture.id, paymentIntentId }))) return { action: "wait" };
    const { holdsForMember, duplicateRefundIntentIds, readTellingWhere } = await readOtherSettledCaptureWhere(tx, {
      bookingId,
      paymentId: capture.paymentId,
      paymentIntentId,
    });
    // The superseded-payment or duplicate-capture machinery owns this capture's money (and alerts on its own).
    if (holdsForMember.has(paymentIntentId) || duplicateRefundIntentIds.includes(paymentIntentId)) return { action: "clear" };
    const other = await tx.paymentTransaction.findFirst({
      where: await readTellingWhere(),
      orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
      select: { stripePaymentIntentId: true },
    });
    const closed = !isPaidLikeBookingStatus(booking.status);
    const owner = bookingOwner(booking).member;
    return {
      action: "send",
      alert: {
        booking,
        memberName: `${owner.firstName} ${owner.lastName}`,
        paymentIntentId,
        // What the card still holds, for every reason.
        amountCents: heldCents,
        otherPaymentIntentId: other?.stripePaymentIntentId ?? null,
        otherHoldsMoney: !!other,
        reason: closed ? "new-capture-closed" : other ? "new-capture-later-payment" : "new-capture",
        ...(closed ? { cancellationRefund: await readCancellationRefund(tx, booking, format) } : {}),
      },
    };
  });
}

export async function drainOwedNewCaptureAlerts(now: Date = new Date()): Promise<{ checked: number; sent: number }> {
  const keys = await listOwedAlertKeys({ prefix: NEW_CAPTURE_ALERT_OWED_PREFIX, now, retryAfterMs: NEW_CAPTURE_ALERT_DRAIN_AFTER_MS });
  if (keys.length === 0) return { checked: 0, sent: 0 };
  const format = await clubFormatValues();
  let sent = 0;
  for (const key of keys) {
    const [bookingId, paymentIntentId] = key.slice(NEW_CAPTURE_ALERT_OWED_PREFIX.length).split(":") as [string, string];
    try {
      const judged = await judgeOwedAlert(bookingId, paymentIntentId, format);
      if (judged.action === "clear") {
        await settleOwedAlert({ key });
        continue;
      }
      if (judged.action === "wait") {
        await noteOwedAlertAttempt({ key, now });
        continue;
      }
      const outcome = await alertCaptureKeptWithoutRecordedSettler({ ...judged.alert, format });
      if (outcome === "sent") sent += 1;
      // Sent: the alert cleared the marker. Blocked by the day's cooldown: try
      // again later. A send that threw stays due for the next run.
      else if (outcome === "cooldown") await noteOwedAlertAttempt({ key, now });
    } catch (err) {
      logger.error({ err, key }, "Failed to deliver an owed new-capture alert (#4285)");
    }
  }
  return { checked: keys.length, sent };
}
