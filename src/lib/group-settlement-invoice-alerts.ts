/**
 * #3642 (`INV-PAY-105`): the one operator alert about money on a combined group
 * invoice that the app will not apply by itself — a payment for a different
 * total, a payment on an invoice the settlement no longer uses or that a card
 * already covered, or an invoice that started being paid before the app could
 * void or replace it. Every arm names the group's organiser and stay, the
 * invoice and its Xero link, and what a person has to do.
 *
 * ONE COOLDOWN PER INVOICE AND KIND: each alert keys on (kind, settlement,
 * invoice), so a PAID invoice re-fetched on every Xero event alerts once per
 * window, while a later, DIFFERENT instruction about the same invoice (the
 * group cancelled after the reaper held it, say) is never swallowed by the
 * first one's cooldown.
 *
 * CONVERGED WITH #3638 (#3635): `claimGroupSettlementInvoiceAlert` claims
 * through `claimAlertCooldownFailOpen`, the one home of #3638's rule, with the
 * shared 24-hour `SETTLEMENT_MONEY_ALERT_REPEAT_MS`: a failed claim sends anyway
 * rather than staying silent about unreconciled money, because the next Xero
 * event about this invoice may never come.
 */
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import {
  SETTLEMENT_MONEY_ALERT_REPEAT_MS,
  claimAlertCooldownFailOpen,
} from "@/lib/alert-cooldown";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import type { ClubFormat } from "@/lib/club-format";

/**
 * What an alert asks a person to do. Two alerts of one kind about one invoice
 * are the same instruction; two kinds are two instructions.
 */
export type GroupSettlementInvoiceAlertKind =
  /** A paid invoice the settle refused (wrong total, superseded, cancelled). */
  | "paid_not_applied"
  /** A payment on an invoice the settlement had already abandoned. */
  | "paid_after_abandon"
  /** An invoice paid on top of a card settlement. */
  | "paid_twice"
  /** A paid invoice whose cash could not be read exactly. */
  | "paid_unreadable"
  /** A VOID not attempted because the invoice carries money. */
  | "void_blocked_by_money"
  /** An invoice Xero no longer has (deleted, or another organisation). */
  | "invoice_not_found"
  /** A replacement refused because the invoice carries money. */
  | "replace_blocked_by_money"
  /** The reaper kept a group whose invoice has started being paid. */
  | "reaper_held_for_money"
  /** The reaper kept a group whose invoice Xero could not show. */
  | "reaper_held_unreadable"
  /** The reaper released a group it could not check, at the end of the hold. */
  | "reaper_released_unchecked"
  /** Xero raised an invoice at a total different from the settlement's. */
  | "raised_at_wrong_total"
  /** A joiner's stored prices do not add up, so no invoice can be raised. */
  | "lines_disagree_with_prices";

/** The cooldown key of one kind of alert about one invoice (or settlement). */
export function groupSettlementInvoiceAlertKey(
  kind: GroupSettlementInvoiceAlertKind,
  settlementId: string,
  invoiceId: string | null
): string {
  return `group-settlement-invoice:${kind}:${settlementId}:${invoiceId ?? "no-invoice"}`;
}

/** True when this caller holds the alert for `key`; fails open. */
export async function claimGroupSettlementInvoiceAlert(key: string): Promise<boolean> {
  return claimAlertCooldownFailOpen({
    key,
    windowMs: SETTLEMENT_MONEY_ALERT_REPEAT_MS,
    context: {},
    logMessage:
      "Failed to claim the group settlement invoice alert cooldown; sending anyway rather than staying silent about unreconciled money",
  });
}

/** Alert the operators about one invoice, at most once per window. */
export async function alertGroupSettlementInvoice(
  params: {
    kind: GroupSettlementInvoiceAlertKind;
    settlementId: string;
    /** Null when no invoice exists yet (the lines could not be raised). */
    invoiceId: string | null;
    errorMessage: string;
  },
  format: ClubFormat
): Promise<void> {
  const holdsClaim = await claimGroupSettlementInvoiceAlert(
    groupSettlementInvoiceAlertKey(params.kind, params.settlementId, params.invoiceId)
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
      errorMessage: params.invoiceId
        ? `${params.errorMessage} Xero invoice: ${buildXeroInvoiceUrl(params.invoiceId)}`
        : params.errorMessage,
      paymentIntentId: params.invoiceId ?? `group settlement ${params.settlementId}`,
    }, format);
  } catch (alertErr) {
    logger.error(
      { err: alertErr, invoiceId: params.invoiceId, settlementId: params.settlementId },
      "Failed to send admin alert for a group settlement invoice"
    );
  }
}
