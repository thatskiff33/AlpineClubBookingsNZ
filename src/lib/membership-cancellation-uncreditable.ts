import { sendAdminXeroSyncErrorAlert } from "@/lib/email";
import logger from "@/lib/logger";
import {
  findOtherLiveMembersCoveredBySubscriptionInvoice,
  findSubscriptionInvoiceIdFromCoverage,
} from "@/lib/membership-cancellation-subscription-credit";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import { completeXeroSyncOperation } from "@/lib/xero-sync";

/**
 * A membership cancellation whose subscription is not creditable: PAID, or
 * never invoiced. Split out of `createXeroMembershipCancellationCreditNote`
 * (#4519) unchanged; it raises no credit note, alerts when the cancellation
 * strands an invoice or a paid subscription, and completes the operation as
 * skipped.
 */
export async function completeUncreditableMembershipCancellation(
  subscription: {
    id: string;
    memberId: string;
    status: string;
    xeroInvoiceId: string | null;
    xeroInvoiceNumber: string | null;
    member: { firstName: string; lastName: string };
  },
  params: { requestId: string; participantId: string },
  operationClaim: XeroOperationClaim | null,
): Promise<null> {
  // #2400 (review F3): this cancellation is raising nothing. If it is also the
  // LAST member the invoice covers, nobody else's cancellation will ever
  // credit it either — so the balance stands forever, and until now nothing
  // said so. Resolved before either branch below because both need it, and it
  // costs only local reads.
  const strandedInvoice = await findStrandedSubscriptionInvoice(subscription);
  const strandedInvoiceSentence = strandedInvoice
    ? ` The membership was billed on Xero invoice ${
        strandedInvoice.invoiceNumber ?? strandedInvoice.invoiceId
      }, and no other member that invoice covers is still with the club, so no cancellation will credit it automatically. Open it in Xero: if it still carries a balance, take the payment, credit it with an allocated credit note, or void it.`
    : "";
  const strandedInvoicePayload = strandedInvoice
    ? {
        sharedInvoiceLeftUncredited: {
          invoiceId: strandedInvoice.invoiceId,
          invoiceNumber: strandedInvoice.invoiceNumber,
          lastCoveredMember: true,
        },
      }
    : {};
  const strandedInvoiceLinks = strandedInvoice
    ? {
        xeroObjectType: "INVOICE",
        xeroObjectId: strandedInvoice.invoiceId,
        xeroObjectNumber: strandedInvoice.invoiceNumber,
        xeroObjectUrl: buildXeroInvoiceUrl(strandedInvoice.invoiceId),
      }
    : {};

  // Option B from the audit: paid subscriptions are not auto-refunded.
  // The booking-side refund pipeline is not yet wired into the
  // membership cancellation flow. Skipping silently for PAID would
  // leave the member's money in Stripe with no admin visibility, so
  // surface an explicit alert and a distinct skip reason whenever the
  // subscription is PAID and otherwise would have been creditable.
  if (
    subscription.status === "PAID" &&
    Boolean(subscription.xeroInvoiceId)
  ) {
    logger.warn(
      {
        subscriptionId: subscription.id,
        memberId: subscription.memberId,
        xeroInvoiceId: subscription.xeroInvoiceId,
        requestId: params.requestId,
        participantId: params.participantId,
        strandedInvoiceId: strandedInvoice?.invoiceId ?? null,
      },
      "Paid membership subscription cancelled without automatic refund",
    );
    await sendAdminXeroSyncErrorAlert({
      errorType: "membership_cancellation_paid_subscription_no_refund",
      operation: "createXeroMembershipCancellationCreditNote",
      errorMessage: `Member ${subscription.member.firstName} ${subscription.member.lastName} (${subscription.memberId}) had a PAID season subscription cancelled. No Stripe refund or Xero credit note was issued automatically; manual reconciliation required.${strandedInvoiceSentence}`,
      timestamp: new Date(),
    }).catch((err) =>
      logger.error(
        {
          err,
          subscriptionId: subscription.id,
          requestId: params.requestId,
        },
        "Failed to send admin alert for paid membership cancellation",
      ),
    );
    if (operationClaim) {
      await completeXeroSyncOperation(operationClaim, {
        responsePayload: {
          skipped: true,
          reason: "paid_subscription_no_refund",
          status: subscription.status,
          xeroInvoiceId: subscription.xeroInvoiceId,
          adminAlertSent: true,
          ...strandedInvoicePayload,
        },
        ...strandedInvoiceLinks,
      });
    }
    return null;
  }

  // Not creditable for any other reason — NOT_INVOICED, or PAID before the
  // family's invoice was even raised, which is the shape that leaves no
  // `xeroInvoiceId` behind at all. Silent until now; it is only reported when
  // an invoice is actually identified AND this member is the last one it
  // covers, so an ordinary uninvoiced cancellation still says nothing.
  if (strandedInvoice) {
    logger.warn(
      {
        subscriptionId: subscription.id,
        memberId: subscription.memberId,
        status: subscription.status,
        xeroInvoiceId: strandedInvoice.invoiceId,
        requestId: params.requestId,
        participantId: params.participantId,
      },
      "Membership cancellation credited nothing and left a shared subscription invoice with nobody covered by it",
    );
    await sendAdminXeroSyncErrorAlert({
      errorType: "membership_cancellation_shared_invoice_left_uncredited",
      operation: "createXeroMembershipCancellationCreditNote",
      errorMessage: `Member ${subscription.member.firstName} ${subscription.member.lastName} (${subscription.memberId}) was cancelled with a ${subscription.status} season subscription, so no Xero credit note was raised.${strandedInvoiceSentence}`,
      timestamp: new Date(),
    }).catch((err) =>
      logger.error(
        {
          err,
          subscriptionId: subscription.id,
          requestId: params.requestId,
        },
        "Failed to send admin alert for an uncredited shared subscription invoice",
      ),
    );
  }

  if (operationClaim) {
    await completeXeroSyncOperation(operationClaim, {
      responsePayload: {
        skipped: true,
        reason: "subscription_status_not_creditable",
        status: subscription.status,
        xeroInvoiceId: subscription.xeroInvoiceId,
        ...strandedInvoicePayload,
        ...(strandedInvoice ? { adminAlertSent: true } : {}),
      },
      ...strandedInvoiceLinks,
    });
  }
  return null;
}

/**
 * The subscription invoice a cancellation is walking away from when it credits
 * nothing AND nobody else covered by that invoice is left with the club (#2400
 * review, F3).
 *
 * The shape that motivates it: an invoice covering A, B and C where C's
 * subscription is PAID — either marked paid by hand, or already PAID when the
 * invoice was raised, in which case `createXeroMembershipSubscriptionInvoice`'s
 * `status: { not: "PAID" }` guard left C with no `xeroInvoiceId` at all and C is
 * covered only by the charge's coverage claim. A skips (C is live), B skips (C
 * is live), and C has no creditable subscription — so the invoice keeps its full
 * balance forever, having told the reviewer the last cancellation would credit
 * it in full. Nothing said so.
 *
 * Returns null when the invoice cannot be identified, or when somebody covered
 * by it is still with the club — their cancellation may yet credit it, so there
 * is nothing stranded to report.
 */
async function findStrandedSubscriptionInvoice(subscription: {
  id: string;
  memberId: string;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
}): Promise<{ invoiceId: string; invoiceNumber: string | null } | null> {
  const invoiceId =
    subscription.xeroInvoiceId ??
    (await findSubscriptionInvoiceIdFromCoverage(subscription.id));
  if (!invoiceId) return null;

  const stillCovered = await findOtherLiveMembersCoveredBySubscriptionInvoice({
    invoiceId,
    leavingMemberId: subscription.memberId,
  });
  if (stillCovered.length > 0) return null;

  return {
    invoiceId,
    invoiceNumber: subscription.xeroInvoiceId
      ? subscription.xeroInvoiceNumber
      : null,
  };
}
