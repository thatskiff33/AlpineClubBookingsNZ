import { type Invoice } from "xero-node";
import { prisma } from "@/lib/prisma";
import { clubToday } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  getFinancialYearEndMonth,
  seasonYearOfCalendarDate,
} from "@/lib/financial-year";
import { xeroCalendarDate } from "@/lib/xero-provider-dates";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import {
  buildSubscriptionInvoiceMatchOptions,
  checkMembershipStatus,
  hasStrongSubscriptionInvoiceMatch,
} from "@/lib/xero-membership-sync";
import { type XeroObjectLinkInput, upsertXeroObjectLink } from "@/lib/xero-sync";
import { type IncrementalInvoiceReconciliationResult, type IncrementalMembershipReconciliationResult } from "./types";
import { buildXeroPaymentDisplayNumber } from "./amounts";
import { dedupeResolvedXeroObjectLinks, dedupeXeroObjectLinks, getDerivedInboundPaymentRole, recoverBookingScopedLinksFromOutboundOperations } from "./object-links";
import { writeXeroInboundAuditLogs } from "./audit";
import { resolveMemberIdsForContact } from "./contact";
import { refreshLinkedSubscriptionsForInvoice, syncLinkedPaymentInvoiceMetadata } from "./payment";
import { syncGroupSettlementForPaidInvoice, syncInternetBankingPaymentsForPaidInvoice } from "./invoice-paid-effects";

function buildSkippedInvoiceReconciliation(
  reason: string
): IncrementalInvoiceReconciliationResult {
  return {
    processed: 0,
    succeeded: 0,
    failed: 0,
    errorDetails: [],
    skipped: true,
    reason,
  };
}

/**
 * The membership season a Xero invoice belongs to, from its CALENDAR DATE.
 *
 * `Invoice.date` is a calendar day. The retired `getSeasonYear` decided from
 * `date.getMonth()`/`getFullYear()` — the HOST's calendar components — so the old
 * `new Date(invoice.date)` made the season boundary move with the container's
 * timezone as well as with the wire shape Xero happened to send (#2869). Both
 * halves are now explicit: the day is classified at the Xero boundary, and the
 * season is derived from that day's own parts by the shared calendar-date rule.
 *
 * When Xero sends no date at all the fallback is the CLUB's today, not the UTC
 * clock's (`INV-DATE-019`).
 */
async function buildSeasonYearFromInvoice(invoice: Invoice): Promise<number> {
  const zone = await readClubTimeZoneOutsideRequest();
  const invoiceDate = xeroCalendarDate(invoice.date) ?? clubToday(zone);
  return seasonYearOfCalendarDate(invoiceDate, getFinancialYearEndMonth());
}

export async function reconcileXeroInvoice(
  invoiceId: string,
  options?: { skipSubscriptionRefresh?: boolean }
) {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(
    () => xero.accountingApi.getInvoice(tenantId, invoiceId),
    {
      operation: "getInvoice",
      resourceType: "INVOICE",
      workflow: "reconcileXeroInvoice",
      context: `reconcileXeroInvoice(${invoiceId})`,
    }
  );
  const invoice = response.body.invoices?.[0];

  if (!invoice?.invoiceID) {
    throw new Error(`Xero invoice ${invoiceId} was not found`);
  }

  const invoiceUrl = buildXeroInvoiceUrl(invoice.invoiceID);
  const [existingLinks, recoveredBookingScopedLinks] = await Promise.all([
    prisma.xeroObjectLink.findMany({
      where: {
        xeroObjectId: invoice.invoiceID,
        xeroObjectType: {
          in: ["INVOICE", "SUBSCRIPTION"],
        },
        active: true,
      },
      select: {
        localModel: true,
        localId: true,
        xeroObjectType: true,
        role: true,
      },
    }),
    recoverBookingScopedLinksFromOutboundOperations("INVOICE", invoice.invoiceID),
  ]);
  const relatedLinks = dedupeResolvedXeroObjectLinks([
    ...existingLinks,
    ...recoveredBookingScopedLinks,
  ]);

  for (const link of relatedLinks) {
    await upsertXeroObjectLink({
      localModel: link.localModel,
      localId: link.localId,
      xeroObjectType: link.xeroObjectType,
      xeroObjectId: invoice.invoiceID,
      xeroObjectNumber: invoice.invoiceNumber ?? null,
      xeroObjectUrl: invoiceUrl,
      role: link.role,
    });
  }

  const paymentLinks = dedupeXeroObjectLinks(
    (invoice.payments ?? []).flatMap((payment) => {
      if (!payment.paymentID) {
        return [];
      }

      return relatedLinks.flatMap((link) => {
        const role = getDerivedInboundPaymentRole(link);
        if (!role) {
          return [];
        }

        return [
          {
            localModel: link.localModel,
            localId: link.localId,
            xeroObjectType: "PAYMENT",
            xeroObjectId: payment.paymentID!,
            xeroObjectNumber: buildXeroPaymentDisplayNumber(payment),
            role,
            metadata: {
              invoiceId: invoice.invoiceID,
              amount: payment.amount ?? null,
              date: payment.date ?? null,
              paymentType: payment.paymentType ?? null,
              status: payment.status ?? null,
            },
          },
        ] satisfies XeroObjectLinkInput[];
      });
    })
  );

  for (const link of paymentLinks) {
    await upsertXeroObjectLink(link);
  }

  const linkedPaymentIds = relatedLinks
    .filter((link) => link.localModel === "Payment" && link.role === "PRIMARY_INVOICE")
    .map((link) => link.localId);
  const { matchedPayments, updatedPayments } =
    await syncLinkedPaymentInvoiceMetadata(
      invoice.invoiceID,
      invoice.invoiceNumber ?? null,
      linkedPaymentIds
    );
  const internetBankingPaymentSync =
    await syncInternetBankingPaymentsForPaidInvoice(
      invoice,
      linkedPaymentIds
    );
  const groupSettlementSync = await syncGroupSettlementForPaidInvoice(invoice);

  const linkedSubscriptionIds = relatedLinks
    .filter(
      (link) =>
        link.localModel === "MemberSubscription" &&
        link.role === "SUBSCRIPTION_INVOICE"
    )
    .map((link) => link.localId);
  const { refreshedSubscriptions } = options?.skipSubscriptionRefresh
    ? { refreshedSubscriptions: new Set<string>() }
    : await refreshLinkedSubscriptionsForInvoice(
        invoice.invoiceID,
        linkedSubscriptionIds
      );

  const seasonYear = await buildSeasonYearFromInvoice(invoice);
  // Member-less inbound gate (#2109 FIX-3): the reconciler sees ONE invoice at a
  // time and cannot run prefer-paid selection, so it treats an invoice as a
  // subscription ONLY on a STRONG match (account code, the flat primary/fallback
  // item code, or the text fallback) — never on a union-only fee-schedule code
  // shared with hut/joining/promo fees. A union-only inbound invoice is simply
  // not treated as a subscription here (writing no SUBSCRIPTION_INVOICE audit
  // links and triggering no per-member checkMembershipStatus refresh, which also
  // removes a recurring per-webhook Xero API cost); per-member detection still
  // sees it when a member's full invoice set is evaluated. The settings overlap
  // warning still steers admins away from configuring overlapping codes.
  const looksLikeSubscriptionInvoice = hasStrongSubscriptionInvoiceMatch(
    [invoice],
    seasonYear,
    await buildSubscriptionInvoiceMatchOptions()
  );
  const fallbackSubscriptionMemberIds: string[] = [];

  if (
    !options?.skipSubscriptionRefresh &&
    looksLikeSubscriptionInvoice &&
    refreshedSubscriptions.size === 0
  ) {
    const contactId = invoice.contact?.contactID ?? null;
    if (contactId) {
      const memberIds = await resolveMemberIdsForContact(contactId);
      for (const memberId of memberIds) {
        await checkMembershipStatus(memberId, seasonYear);
        refreshedSubscriptions.add(`${memberId}:${seasonYear}`);
        fallbackSubscriptionMemberIds.push(memberId);
      }
    }
  }

  await writeXeroInboundAuditLogs({
    source: "xero-inbound-invoice",
    links: [
      ...relatedLinks.map((link) => ({
        localModel: link.localModel,
        localId: link.localId,
        xeroObjectType: link.xeroObjectType,
        xeroObjectId: invoice.invoiceID!,
        xeroObjectNumber: invoice.invoiceNumber ?? null,
        role: link.role,
      })),
      ...paymentLinks,
      ...fallbackSubscriptionMemberIds.map((memberId) => ({
        localModel: "Member",
        localId: memberId,
        xeroObjectType: "SUBSCRIPTION",
        xeroObjectId: invoice.invoiceID!,
        xeroObjectNumber: invoice.invoiceNumber ?? null,
        role: "SUBSCRIPTION_INVOICE",
      })),
    ],
    metadata: {
      invoiceId: invoice.invoiceID,
      invoiceNumber: invoice.invoiceNumber ?? null,
      matchedPayments,
      updatedPayments,
      internetBankingPaymentSync,
      groupSettlementSync,
      refreshedSubscriptions: refreshedSubscriptions.size,
      looksLikeSubscriptionInvoice,
    },
  });

  return {
    handled: true,
    kind: "INVOICE",
    resourceId: invoice.invoiceID,
    invoiceNumber: invoice.invoiceNumber ?? null,
    matchedPayments,
    internetBankingPaymentSync,
    groupSettlementSync,
    paymentLinksUpdated: paymentLinks.length,
    updatedPayments,
    refreshedSubscriptions: refreshedSubscriptions.size,
    relatedLinksUpdated: relatedLinks.length,
    looksLikeSubscriptionInvoice,
  };
}

export async function runIncrementalInvoiceReconciliation(options: {
  membershipReconciliation: IncrementalMembershipReconciliationResult | null;
}): Promise<IncrementalInvoiceReconciliationResult> {
  const changedInvoiceIds =
    options.membershipReconciliation?.changedInvoiceIds ?? [];
  if (changedInvoiceIds.length === 0) {
    return buildSkippedInvoiceReconciliation(
      "No changed membership invoices required invoice-linked reconciliation."
    );
  }

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const errorDetails: Array<{ invoiceId: string; error: string }> = [];

  for (const invoiceId of changedInvoiceIds) {
    processed += 1;

    try {
      await reconcileXeroInvoice(invoiceId, { skipSubscriptionRefresh: true });
      succeeded += 1;
    } catch (error) {
      failed += 1;
      errorDetails.push({
        invoiceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    processed,
    succeeded,
    failed,
    errorDetails,
  };
}
