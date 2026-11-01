/**
 * What the operators are told about a bank transfer the inbound settle
 * recorded (#3979, `INV-PAY-125`): the stored figure was kept instead of the
 * invoice's cash, or the cash is not what the booking owes.
 *
 * The notice is read inside the settle's transaction; for a booking the settle
 * leaves live, a durable admin-only marker (`SETTLEMENT_MARKERS`) is written in
 * that same transaction, so the record commits with the receipt, and the
 * unmuteable alert follows the commit and is recorded on the marker once sent
 * - the #3638 pattern. The two cancel arms turn the cash into credit and alert
 * about it themselves, so they write no marker.
 */
import { BookingEventType, type Prisma } from "@prisma/client";
import { readBookingAmountOwed } from "@/lib/booking-amount-owed";
import type { ClubFormat } from "@/lib/club-format";
import { sendAdminBankTransferSettlementFigureAlert } from "@/lib/email";
import { claimAlertCooldownFailOpen } from "@/lib/alert-cooldown-fail-open";
import type { IbSettlementKeptReason } from "@/lib/ib-settlement-figure-note";
import logger from "@/lib/logger";
import {
  CASH_SETTLEMENT_ALERT_MAX_UNDELIVERED,
  IB_SETTLEMENT_FIGURE_CHECK_EVENT_KIND,
  IB_SETTLEMENT_FIGURE_CHECK_EVENT_REASON,
  asIbSettlementFigureCheckSnapshot,
  type IbSettlementFigureCheckEventSnapshot,
} from "@/lib/manual-settlement-reversal-event";
import { prisma } from "@/lib/prisma";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import type { CashSettlementPlan, InvoiceCash } from "./settle-from-cash";

/** What the settle tells the operators about the figure it recorded. */
export type CashSettlementNotice = {
  /** Why the stored figure was kept although the cash says otherwise, or null. */
  keptReason: IbSettlementKeptReason | null;
  /** The receipt figure recorded. */
  recordedCents: number;
  cash: InvoiceCash;
  /** What the booking owes, when the cash disagrees with it (`INV-PAY-119`), else null. */
  owedCents: number | null;
  owed: "overpaid" | "underpaid" | null;
  /** Whether the booking has a supplementary invoice of its own. */
  hasSupplementaryInvoice: boolean;
};

/**
 * What the booking's own supplementary invoices bill: the edits that raised one
 * (an active `SUPPLEMENTARY_INVOICE` link), each its price change plus fee.
 */
async function supplementaryBilledCents(tx: Prisma.TransactionClient, bookingId: string): Promise<number> {
  const modifications = await tx.bookingModification.findMany({
    where: { bookingId },
    select: { id: true, priceDiffCents: true, changeFeeCents: true },
  });
  if (modifications.length === 0) return 0;
  const links = await tx.xeroObjectLink.findMany({
    where: {
      localModel: "BookingModification",
      localId: { in: modifications.map((modification) => modification.id) },
      xeroObjectType: "INVOICE",
      role: "SUPPLEMENTARY_INVOICE",
      active: true,
    },
    select: { localId: true },
  });
  const invoiced = new Set(links.map((link) => link.localId));
  return modifications
    .filter((modification) => invoiced.has(modification.id))
    .reduce((sum, modification) => sum + Math.max(0, modification.priceDiffCents + modification.changeFeeCents), 0);
}

/**
 * The cross-check, and the notice it and a refusal produce, read inside the
 * settle's transaction at the transition. `bookingAmountOwedCents`
 * (`INV-PAY-119`) never sets the figure; it only says when the cash disagrees
 * with it. A cancelled booking is not asked: its applied credit has gone back,
 * and its late-cash arm alerts on its own. A shortfall no larger than what the
 * booking's supplementary invoices bill is the expected shape of a price raised
 * after the invoice (`INV-PAY-047`), so it alone does not alert.
 */
export async function readCashSettlementNotice(
  tx: Prisma.TransactionClient,
  input: {
    plan: CashSettlementPlan;
    recordedCents: number;
    cash: InvoiceCash;
    matchedPayments: number;
    booking: { id: string; finalPriceCents: number; cancelled: boolean };
    changeFeeCents: number | null;
  },
): Promise<CashSettlementNotice | null> {
  // A replay decides nothing; a second instrument (#3638) raises its own alert
  // and the settle writes nothing further, so neither is asked anything here.
  const { plan } = input;
  if (plan.kind === "replay") return null;
  if (plan.kind === "keep" && plan.reason === "second-instrument") return null;
  // Nothing was refused when the stored figure already IS the complete cash of
  // the one payment the invoice matched.
  const keptReason: IbSettlementKeptReason | null =
    plan.kind === "keep" &&
    plan.reason !== "second-instrument" &&
    !(input.cash.complete && input.matchedPayments === 1 && input.cash.knownCents === input.recordedCents)
      ? plan.reason
      : null;

  let owedCents: number | null = null;
  let owed: CashSettlementNotice["owed"] = null;
  let hasSupplementaryInvoice = false;
  if (!input.booking.cancelled && input.cash.complete && input.matchedPayments === 1) {
    const owedNow = (
      await readBookingAmountOwed(
        {
          id: input.booking.id,
          finalPriceCents: input.booking.finalPriceCents,
          payment: { changeFeeCents: input.changeFeeCents },
        },
        tx,
      )
    ).owedCents;
    if (owedNow !== input.cash.knownCents) {
      const supplementaryCents = await supplementaryBilledCents(tx, input.booking.id);
      hasSupplementaryInvoice = supplementaryCents > 0;
      const shortfallCents = owedNow - input.cash.knownCents;
      const explained = shortfallCents > 0 && shortfallCents <= supplementaryCents;
      if (!explained) {
        owedCents = owedNow;
        owed = input.cash.knownCents > owedNow ? "overpaid" : "underpaid";
      }
    }
  }

  if (keptReason === null && owedCents === null) return null;
  return { keptReason, recordedCents: input.recordedCents, cash: input.cash, owedCents, owed, hasSupplementaryInvoice };
}

/** The marker as recorded: its row and snapshot. */
export type CashSettlementMarker = { id: string; snapshot: IbSettlementFigureCheckEventSnapshot };

async function findCashSettlementMarker(
  tx: Pick<Prisma.TransactionClient, "bookingEvent">,
  { bookingId, invoiceId }: { bookingId: string; invoiceId: string },
): Promise<CashSettlementMarker | null> {
  const row = await tx.bookingEvent.findFirst({
    where: {
      bookingId,
      type: BookingEventType.CANCELLED,
      snapshot: { path: ["kind"], equals: IB_SETTLEMENT_FIGURE_CHECK_EVENT_KIND },
      AND: [{ snapshot: { path: ["invoiceId"], equals: invoiceId } }],
    },
    select: { id: true, snapshot: true },
  });
  const snapshot = row ? asIbSettlementFigureCheckSnapshot(row.snapshot) : null;
  return row && snapshot ? { id: row.id, snapshot } : null;
}

/**
 * The marker for a booking the settle leaves live, in its transaction: the
 * notice's, written once per booking and invoice, or - with no notice, on a
 * later delivery - one already written whose alert never went out, so it is
 * sent again. Null when there is nothing to say.
 */
export async function cashSettlementMarkerInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    bookingId: string;
    invoiceId: string;
    invoiceNumber: string | null;
    notice: CashSettlementNotice | null;
  },
): Promise<CashSettlementMarker | null> {
  const existing = await findCashSettlementMarker(tx, input);
  if (existing) return existing.snapshot.alertSentAt ? null : existing;
  const { notice } = input;
  if (!notice) return null;
  const snapshot: IbSettlementFigureCheckEventSnapshot = {
    kind: IB_SETTLEMENT_FIGURE_CHECK_EVENT_KIND,
    invoiceId: input.invoiceId,
    invoiceNumber: input.invoiceNumber,
    refusal: notice.keptReason,
    recordedCents: notice.recordedCents,
    cashCents: notice.cash.knownCents,
    cashComplete: notice.cash.complete,
    owedCents: notice.owedCents,
    hasSupplementaryInvoice: notice.hasSupplementaryInvoice,
    alertSentAt: null,
  };
  const created = await tx.bookingEvent.create({
    data: {
      bookingId: input.bookingId,
      type: BookingEventType.CANCELLED,
      actorMemberId: null,
      amountCents: notice.cash.knownCents,
      reason: IB_SETTLEMENT_FIGURE_CHECK_EVENT_REASON,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return { id: created.id, snapshot };
}

/** How long one sender holds the right to send a marker's alert (as #3638's). */
export const CASH_SETTLEMENT_ALERT_IN_FLIGHT_MS = 10 * 60 * 1000;

/**
 * The alert, after the settle has committed. Sent ONCE per marker: skipped when
 * the marker records it sent, and recorded there only after the send succeeds,
 * so a crash or a failed send leaves it to the inbound cron sweep (#4446).
 * Failed sends are counted on the existing JSON marker; no new lock is taken.
 */
export async function raiseCashSettlementAlert(input: {
  payment: { id?: string; bookingId: string; booking: { checkIn: Date; checkOut: Date } };
  memberName: string;
  marker: CashSettlementMarker;
  invoiceId: string;
  format: ClubFormat;
}): Promise<void> {
  const { payment, marker } = input;
  if (marker.snapshot.alertSentAt) return;
  let snapshot = marker.snapshot;
  logger.warn(
    {
      bookingId: payment.bookingId,
      paymentId: payment.id,
      invoiceId: input.invoiceId,
      refusal: snapshot.refusal,
      recordedCents: snapshot.recordedCents,
      xeroCashCents: snapshot.cashCents,
      owedCents: snapshot.owedCents,
    },
    "Internet Banking settlement: the recorded figure needs an operator's check (#3979)",
  );
  const holdsClaim = await claimAlertCooldownFailOpen({
    key: `ib-settlement-figure-alert:${marker.id}`,
    windowMs: CASH_SETTLEMENT_ALERT_IN_FLIGHT_MS,
    context: { markerId: marker.id, invoiceId: input.invoiceId },
    logMessage:
      "Failed to claim the bank-transfer settlement alert; sending anyway rather than staying silent about a recorded figure that needs checking",
  });
  if (!holdsClaim) return;
  // A delivery and the sweep may both hold an old snapshot. Re-read AFTER the
  // existing cooldown claim, so neither repeats a sent or exhausted marker.
  const current = await prisma.bookingEvent.findUnique({
    where: { id: marker.id },
    select: { snapshot: true },
  });
  const fresh = asIbSettlementFigureCheckSnapshot(current?.snapshot);
  if (!fresh || fresh.alertSentAt || (fresh.alertUndeliveredCount ?? 0) >= CASH_SETTLEMENT_ALERT_MAX_UNDELIVERED) return;
  snapshot = fresh;

  const owed =
    snapshot.owedCents === null ? null : snapshot.cashCents > snapshot.owedCents ? "overpaid" : "underpaid";
  try {
    const outcome = await sendAdminBankTransferSettlementFigureAlert(
      {
        memberName: input.memberName,
        checkIn: payment.booking.checkIn,
        checkOut: payment.booking.checkOut,
        bookingId: payment.bookingId,
        keptReason: snapshot.refusal as IbSettlementKeptReason | null,
        owed,
        hasSupplementaryInvoice: snapshot.hasSupplementaryInvoice,
        recordedCents: snapshot.recordedCents,
        cashCents: snapshot.cashCents,
        owedCents: snapshot.owedCents,
        xeroInvoiceNumber: snapshot.invoiceNumber,
        // Cross-lane #2283: Xero deep links are BUILT, never hand-rolled.
        xeroInvoiceUrl: buildXeroInvoiceUrl(input.invoiceId),
      },
      input.format,
    );
    if (outcome === "undelivered") throw new Error("Settlement figure alert reached no recipient");
  } catch (err) {
    logger.error(
      { err, bookingId: payment.bookingId, paymentId: payment.id, invoiceId: input.invoiceId },
      "Failed to alert admins about a bank-transfer settlement figure; the inbound cron retries until the cap (#4446)",
    );
    await prisma.bookingEvent.updateMany({
      // A sender that outlived its cooldown cannot erase a newer sent stamp.
      where: { id: marker.id, snapshot: { equals: snapshot as unknown as Prisma.InputJsonValue } },
      data: {
        snapshot: {
          ...snapshot,
          alertUndeliveredCount: (snapshot.alertUndeliveredCount ?? 0) + 1,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return;
  }

  await prisma.bookingEvent
    .update({
      where: { id: marker.id },
      data: {
        snapshot: { ...snapshot, alertSentAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue,
      },
    })
    .catch((err) =>
      logger.error(
        { err, markerId: marker.id, invoiceId: input.invoiceId },
        "Sent the bank-transfer settlement alert but could not record it on the marker; a later retry may send it once more (#4446)",
      ),
    );
}
