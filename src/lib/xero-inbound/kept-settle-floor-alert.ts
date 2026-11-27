/**
 * THE KEPT SETTLE'S FLOOR ALERT, RECORDED WITH THE TOTAL IT EXPLAINS (#5289 F,
 * owner decision D4, `INV-ADDPAY-021`).
 *
 * A kept bank-transfer settle that moves the payment's refunded total and holds
 * it at the bank-transfer floor owes the officer the floor's alert. Before
 * #5289 that alert lived only in the settle's process: stopped between the
 * commit and the send, it was gone, and a retry could not send it again (the
 * total was already at the floor, so the keep moved nothing).
 *
 * Now the alert is a durable admin-only marker (`IB_KEPT_SETTLE_FLOOR_ALERT_EVENT_KIND`,
 * one of `SETTLEMENT_MARKERS`) written in the settle's own transaction, as
 * #3979's cash-settlement marker is. After the commit a sender claims it with
 * one conditional write on the marker as read (unsent, and not claimed within
 * `CASH_SETTLEMENT_ALERT_IN_FLIGHT_MS`), sends only on a won claim, and records
 * it sent. A lost claim sends nothing, so the settle's own send, a retried
 * delivery and the inbound cron (`retryCashSettlementAlerts`) never both send.
 * No lock is taken.
 *
 * The marker is this alert's own claim, so it is sent straight through
 * `sendAdminXeroSyncErrorAlert`, never through the hour's one Xero error alert
 * (`notifyXeroSyncError`): an hour another error already holds would swallow
 * it, and the marker would record sent an alert nobody was shown. It is
 * recorded sent only on what the send reports: an admin has it, the email
 * retry cron holds a copy, or the club's delivery rules send it to nobody (a
 * final answer; the booking's staff timeline still shows the marker). A send
 * that threw, or that reached nobody and left nothing to replay
 * (`adminAlertNeedsResend`), gives the claim back for the next sender.
 */
import { BookingEventType, Prisma } from "@prisma/client";
import type { ClubFormat } from "@/lib/club-format";
import { sendAdminXeroSyncErrorAlert } from "@/lib/email";
import { adminAlertNeedsResend } from "@/lib/email/admin-alert-send-result";
import logger from "@/lib/logger";
import {
  asIbKeptSettleFloorAlertSnapshot,
  IB_KEPT_SETTLE_FLOOR_ALERT_EVENT_KIND,
  IB_KEPT_SETTLE_FLOOR_ALERT_EVENT_REASON,
  type IbKeptSettleFloorAlertEventSnapshot,
} from "@/lib/manual-settlement-reversal-event";
import { prisma } from "@/lib/prisma";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";
import { type BankTransferFloorAlert, bankTransferFloorAlertOf } from "./credit-note-bank-transfer-floor";
import { CASH_SETTLEMENT_ALERT_IN_FLIGHT_MS } from "./settle-from-cash-notice";

/** In the settle's transaction: the marker for a keep held at the floor, its alert owed. */
export async function recordKeptFloorAlertInTransaction(
  tx: Prisma.TransactionClient,
  input: { bookingId: string; invoiceId: string; invoiceNumber: string | null; alert: BankTransferFloorAlert },
): Promise<void> {
  const { alert } = input;
  const snapshot: IbKeptSettleFloorAlertEventSnapshot = {
    kind: IB_KEPT_SETTLE_FLOOR_ALERT_EVENT_KIND,
    paymentId: alert.paymentId,
    invoiceId: input.invoiceId,
    invoiceNumber: input.invoiceNumber,
    creditNoteId: alert.creditNoteId,
    creditNoteNumber: alert.creditNoteNumber,
    xeroDerivedCents: alert.xeroDerivedCents,
    floorCents: alert.floorCents,
    alertClaimedAt: null,
    alertSentAt: null,
  };
  await tx.bookingEvent.create({
    data: {
      bookingId: input.bookingId,
      type: BookingEventType.CANCELLED,
      actorMemberId: null,
      amountCents: alert.floorCents,
      reason: IB_KEPT_SETTLE_FLOOR_ALERT_EVENT_REASON,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
  });
}

const owedMarkerWhere = {
  type: BookingEventType.CANCELLED,
  snapshot: { path: ["kind"], equals: IB_KEPT_SETTLE_FLOOR_ALERT_EVENT_KIND },
} satisfies Prisma.BookingEventWhereInput;

function claimedInFlight(snapshot: IbKeptSettleFloorAlertEventSnapshot, now: Date): boolean {
  return snapshot.alertClaimedAt !== null && now.getTime() - new Date(snapshot.alertClaimedAt).getTime() < CASH_SETTLEMENT_ALERT_IN_FLIGHT_MS;
}

/** Rewrite the marker only if it is still exactly as this sender last saw it. */
function rewriteIfUnchanged(id: string, seen: IbKeptSettleFloorAlertEventSnapshot, next: IbKeptSettleFloorAlertEventSnapshot) {
  return prisma.bookingEvent.updateMany({
    where: { id, snapshot: { equals: seen as unknown as Prisma.InputJsonValue } },
    data: { snapshot: next as unknown as Prisma.InputJsonValue },
  });
}

/**
 * Send every owed floor alert in `scope`: one payment's (after its settle
 * commits, a replay included), or every marker written before a time (the
 * inbound cron, leaving recent ones to their after-commit sender). Each is
 * claimed first and sent only on a won claim. Returns how many it recorded
 * sent. Never throws for a failed send: it is logged and the claim given back.
 */
export async function sendOwedKeptFloorAlerts(
  scope: { paymentId: string } | { writtenBefore: Date },
  format: ClubFormat,
): Promise<number> {
  const rows = await prisma.bookingEvent.findMany({
    where: {
      ...owedMarkerWhere,
      AND: [
        { snapshot: { path: ["alertSentAt"], equals: Prisma.JsonNull } },
        ...("paymentId" in scope ? [{ snapshot: { path: ["paymentId"], equals: scope.paymentId } }] : []),
      ],
      ...("writtenBefore" in scope ? { createdAt: { lt: scope.writtenBefore } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, bookingId: true, snapshot: true },
  });
  let sent = 0;
  for (const row of rows) {
    const seen = asIbKeptSettleFloorAlertSnapshot(row.snapshot);
    const now = new Date();
    if (!seen || seen.alertSentAt || claimedInFlight(seen, now)) continue;
    const claimed = { ...seen, alertClaimedAt: now.toISOString() };
    if ((await rewriteIfUnchanged(row.id, seen, claimed)).count !== 1) continue;
    try {
      const alert = bankTransferFloorAlertOf(
        {
          paymentId: seen.paymentId,
          bookingId: row.bookingId,
          creditNoteId: seen.creditNoteId,
          creditNoteNumber: seen.creditNoteNumber,
          xeroDerivedCents: seen.xeroDerivedCents,
          floorCents: seen.floorCents,
        },
        format,
      );
      const result = await sendAdminXeroSyncErrorAlert({ ...alert, errorMessage: redactSensitiveText(alert.errorMessage), timestamp: now });
      if (adminAlertNeedsResend(result)) throw new Error("The floor alert reached no admin and no copy waits for the email retry cron");
    } catch (err) {
      logger.error({ err, markerId: row.id, paymentId: seen.paymentId }, "Failed to send a kept bank-transfer settle's floor alert; the next delivery or the inbound cron sends it (#5289)");
      await rewriteIfUnchanged(row.id, claimed, { ...claimed, alertClaimedAt: null }).catch(() => undefined);
      continue;
    }
    sent += 1;
    await rewriteIfUnchanged(row.id, claimed, { ...claimed, alertSentAt: new Date().toISOString() }).catch((err: unknown) =>
      logger.error({ err, markerId: row.id }, "Sent a kept bank-transfer settle's floor alert but could not record it; it may be sent once more after its claim expires (#5289)"),
    );
  }
  return sent;
}
