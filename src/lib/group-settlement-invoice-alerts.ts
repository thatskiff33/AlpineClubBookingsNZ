/**
 * #3642 (`INV-PAY-105`): the one operator alert about money on a combined group
 * invoice that the app will not apply by itself — a payment for a different
 * total, a payment on an invoice the settlement no longer uses or that a card
 * already covered, or an invoice that started being paid before the app could
 * void or replace it. Every arm names the group's organiser and stay, the
 * invoice and its Xero link, and what a person has to do.
 *
 * ONE COOLDOWN PER INVOICE: every arm keys on (settlement, invoice), so a PAID
 * invoice re-fetched on every Xero event, and the same money seen by the
 * inbound reconciliation, the reaper and the VOID worker, alerts once per
 * window rather than once per observer.
 *
 * CONVERGENCE WITH #3638: `claimGroupSettlementInvoiceAlert` is the cooldown
 * half of #3638's settlement-conflict alert (`src/lib/xero-inbound/
 * settlement-conflicts.ts`) — the same 24-hour window and the same rule that a
 * failed claim sends anyway rather than staying silent about unreconciled
 * money. When that module exports its claim, this function's body becomes a
 * call to it and the window constant here is deleted.
 */
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { claimAlertCooldown } from "@/lib/alert-cooldown";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import type { ClubFormat } from "@/lib/club-format";

const GROUP_SETTLEMENT_INVOICE_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The cooldown key every alert about one invoice on one settlement shares. */
export function groupSettlementInvoiceAlertKey(
  settlementId: string,
  invoiceId: string
): string {
  return `group-settlement-invoice-conflict:${settlementId}:${invoiceId}`;
}

/** True when this caller holds the alert for `key`; fails open. */
export async function claimGroupSettlementInvoiceAlert(key: string): Promise<boolean> {
  return claimAlertCooldown({
    key,
    windowMs: GROUP_SETTLEMENT_INVOICE_ALERT_COOLDOWN_MS,
  }).catch((err) => {
    logger.error(
      { err, key },
      "Failed to claim the group settlement invoice alert cooldown; sending anyway rather than staying silent about unreconciled money"
    );
    return true;
  });
}

/** Alert the operators about one invoice, at most once per window. */
export async function alertGroupSettlementInvoice(
  params: {
    settlementId: string;
    invoiceId: string;
    errorMessage: string;
  },
  format: ClubFormat
): Promise<void> {
  const holdsClaim = await claimGroupSettlementInvoiceAlert(
    groupSettlementInvoiceAlertKey(params.settlementId, params.invoiceId)
  );
  if (!holdsClaim) return;
  try {
    const settlementDetail = await prisma.groupBookingSettlement.findUnique({
      where: { id: params.settlementId },
      select: {
        amountCents: true,
        groupBooking: {
          select: {
            organiserMember: { select: { firstName: true, lastName: true } },
            organiserBooking: { select: { checkIn: true, checkOut: true } },
          },
        },
      },
    });
    await sendAdminPaymentFailureAlert({
      memberName: settlementDetail
        ? `${settlementDetail.groupBooking.organiserMember.firstName} ${settlementDetail.groupBooking.organiserMember.lastName}`
        : "Unknown group organiser",
      checkIn: settlementDetail?.groupBooking.organiserBooking.checkIn ?? null,
      checkOut: settlementDetail?.groupBooking.organiserBooking.checkOut ?? null,
      amountCents: settlementDetail?.amountCents ?? 0,
      errorMessage: `${params.errorMessage} Xero invoice: ${buildXeroInvoiceUrl(params.invoiceId)}`,
      paymentIntentId: params.invoiceId,
    }, format);
  } catch (alertErr) {
    logger.error(
      { err: alertErr, invoiceId: params.invoiceId, settlementId: params.settlementId },
      "Failed to send admin alert for a group settlement invoice"
    );
  }
}
