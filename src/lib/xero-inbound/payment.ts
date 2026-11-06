import { prisma } from "@/lib/prisma";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { checkMembershipStatus } from "@/lib/xero-membership-sync";
import { type XeroObjectLinkInput, upsertXeroObjectLink } from "@/lib/xero-sync";
import { buildXeroPaymentDisplayNumber } from "./amounts";
import { dedupeXeroObjectLinks, findActiveXeroObjectLinks, getDerivedInboundPaymentRole, isDeletedXeroPaymentStatus } from "./object-links";
import { writeXeroInboundAuditLogs } from "./audit";

export async function syncLinkedPaymentInvoiceMetadata(
  invoiceId: string,
  invoiceNumber: string | null,
  linkedPaymentIds: string[]
) {
  const paymentWhere = [
    {
      xeroInvoiceId: invoiceId,
    },
    ...(linkedPaymentIds.length > 0
      ? [
          {
            id: {
              in: linkedPaymentIds,
            },
          },
        ]
      : []),
  ];
  const payments = await prisma.payment.findMany({
    where: {
      OR: paymentWhere,
    },
    select: {
      id: true,
      xeroInvoiceId: true,
      xeroInvoiceNumber: true,
    },
  });
  const canApplyCanonicalPaymentLink = payments.length === 1;
  let updatedPayments = 0;

  for (const payment of payments) {
    const updates: Record<string, unknown> = {};

    if (!payment.xeroInvoiceId && canApplyCanonicalPaymentLink) {
      updates.xeroInvoiceId = invoiceId;
    }

    if (invoiceNumber && payment.xeroInvoiceNumber !== invoiceNumber) {
      updates.xeroInvoiceNumber = invoiceNumber;
    }

    if (Object.keys(updates).length > 0) {
      await prisma.payment.update({
        where: {
          id: payment.id,
        },
        data: updates,
      });
      updatedPayments += 1;
    }
  }

  return {
    matchedPayments: payments.length,
    updatedPayments,
  };
}

export async function refreshLinkedSubscriptionsForInvoice(
  invoiceId: string,
  linkedSubscriptionIds: string[]
) {
  const subscriptionWhere = [
    {
      xeroInvoiceId: invoiceId,
    },
    ...(linkedSubscriptionIds.length > 0
      ? [
          {
            id: {
              in: linkedSubscriptionIds,
            },
          },
        ]
      : []),
  ];
  const subscriptions = await prisma.memberSubscription.findMany({
    where: {
      OR: subscriptionWhere,
    },
    select: {
      id: true,
      memberId: true,
      seasonYear: true,
    },
  });

  const refreshedSubscriptions = new Set<string>();
  for (const subscription of subscriptions) {
    await checkMembershipStatus(subscription.memberId, subscription.seasonYear);
    refreshedSubscriptions.add(`${subscription.memberId}:${subscription.seasonYear}`);
  }

  return {
    subscriptions,
    refreshedSubscriptions,
  };
}

export async function reconcileXeroPayment(paymentId: string) {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(
    () => xero.accountingApi.getPayment(tenantId, paymentId),
    {
      operation: "getPayment",
      resourceType: "PAYMENT",
      workflow: "reconcileXeroPayment",
      context: `reconcileXeroPayment(${paymentId})`,
    }
  );
  const payment = response.body.payments?.[0];

  if (!payment?.paymentID) {
    throw new Error(`Xero payment ${paymentId} was not found`);
  }

  const invoiceId = payment.invoice?.invoiceID ?? null;
  const creditNoteId = payment.creditNote?.creditNoteID ?? null;
  const [existingPaymentLinks, invoiceLinks, creditNoteLinks] = await Promise.all([
    findActiveXeroObjectLinks("PAYMENT", payment.paymentID),
    invoiceId
      ? findActiveXeroObjectLinks(["INVOICE", "SUBSCRIPTION"], invoiceId)
      : Promise.resolve([]),
    creditNoteId
      ? findActiveXeroObjectLinks("CREDIT_NOTE", creditNoteId)
      : Promise.resolve([]),
  ]);

  const paymentLinks = dedupeXeroObjectLinks(
    [...existingPaymentLinks, ...invoiceLinks, ...creditNoteLinks]
      .flatMap((link) => {
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
            // #4531: a payment Xero reports deleted is never re-adopted.
            active: !isDeletedXeroPaymentStatus(payment.status),
            metadata: {
              invoiceId,
              creditNoteId,
              amount: payment.amount ?? null,
              date: payment.date ?? null,
              paymentType: payment.paymentType ?? null,
              status: payment.status ?? null,
            },
          },
        ] satisfies XeroObjectLinkInput[];
      })
  );

  for (const link of paymentLinks) {
    await upsertXeroObjectLink(link);
  }

  const linkedPaymentIds = invoiceLinks
    .filter((link) => link.localModel === "Payment" && link.role === "PRIMARY_INVOICE")
    .map((link) => link.localId);
  const linkedSubscriptionIds = invoiceLinks
    .filter(
      (link) =>
        link.localModel === "MemberSubscription" &&
        link.role === "SUBSCRIPTION_INVOICE"
    )
    .map((link) => link.localId);

  const { matchedPayments, updatedPayments } = invoiceId
    ? await syncLinkedPaymentInvoiceMetadata(
        invoiceId,
        payment.invoice?.invoiceNumber ?? payment.invoiceNumber ?? null,
        linkedPaymentIds
      )
    : { matchedPayments: 0, updatedPayments: 0 };
  const { refreshedSubscriptions } = invoiceId
    ? await refreshLinkedSubscriptionsForInvoice(invoiceId, linkedSubscriptionIds)
    : { refreshedSubscriptions: new Set<string>() };

  await writeXeroInboundAuditLogs({
    source: "xero-inbound-payment",
    links: paymentLinks,
    metadata: {
      paymentId: payment.paymentID,
      paymentNumber: buildXeroPaymentDisplayNumber(payment),
      invoiceId,
      creditNoteId,
      matchedPayments,
      updatedPayments,
      refreshedSubscriptions: refreshedSubscriptions.size,
    },
  });

  return {
    handled: true,
    kind: "PAYMENT",
    resourceId: payment.paymentID,
    paymentNumber: buildXeroPaymentDisplayNumber(payment),
    invoiceId,
    creditNoteId,
    matchedPayments,
    updatedPayments,
    refreshedSubscriptions: refreshedSubscriptions.size,
    relatedLinksUpdated: paymentLinks.length,
  };
}
