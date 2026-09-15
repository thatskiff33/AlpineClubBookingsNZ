import { CreditType } from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { prisma } from "@/lib/prisma";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { type XeroObjectLinkInput, upsertXeroObjectLink } from "@/lib/xero-sync";
import { buildCreditNoteAllocationTargets, buildSyntheticAllocationLinkId, buildXeroPaymentDisplayNumber, getCreditNoteAmountCents } from "./amounts";
import { dedupeResolvedXeroObjectLinks, dedupeXeroObjectLinks, findActiveXeroObjectLinks, getDerivedInboundAllocationRole, recoverBookingScopedLinksFromOutboundOperations } from "./object-links";
import { writeXeroInboundAuditLogs } from "./audit";
import { repairAccountCreditAllocationBusinessState, repairRefundedPaymentBusinessState, resolveAccountCreditPaymentsFromMemberCredits, resolveAppliedCreditPaymentsFromLocalProvenance, resolvePaymentIdsByInvoiceTargets } from "./credit-note-repairs";

export async function reconcileXeroCreditNote(creditNoteId: string) {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(
    () => xero.accountingApi.getCreditNote(tenantId, creditNoteId),
    {
      operation: "getCreditNote",
      resourceType: "CREDIT_NOTE",
      workflow: "reconcileXeroCreditNote",
      context: `reconcileXeroCreditNote(${creditNoteId})`,
    }
  );
  const creditNote = response.body.creditNotes?.[0];

  if (!creditNote?.creditNoteID) {
    throw new Error(`Xero credit note ${creditNoteId} was not found`);
  }

  const [
    existingCreditNoteLinks,
    recoveredBookingScopedLinks,
    canonicalPaymentLinks,
    canonicalAccountCreditPayments,
  ] = await Promise.all([
    findActiveXeroObjectLinks("CREDIT_NOTE", creditNote.creditNoteID),
    recoverBookingScopedLinksFromOutboundOperations("CREDIT_NOTE", creditNote.creditNoteID),
    prisma.payment.findMany({
      where: {
        xeroRefundCreditNoteId: creditNote.creditNoteID,
      },
      select: {
        id: true,
      },
    }),
    resolveAccountCreditPaymentsFromMemberCredits(creditNote.creditNoteID),
  ]);
  // #1925: applied-credit notes without CANCELLATION_REFUND provenance (e.g. an
  // admin-adjustment-minted remainder note) resolve to no account-credit payment
  // above. Fall back to unambiguous LOCAL provenance (precise slices + active
  // allocation links) so their deletion/allocation changes are repaired too. The
  // fallback fails closed (returns []) on any ambiguity, preserving the existing
  // skip-with-no-write behaviour. Notes WITH CANCELLATION_REFUND provenance keep
  // the existing resolver unchanged — the fallback only runs when it is empty.
  const resolvedAccountCreditPayments =
    canonicalAccountCreditPayments.length > 0
      ? canonicalAccountCreditPayments
      : await resolveAppliedCreditPaymentsFromLocalProvenance(
          creditNote.creditNoteID
        );
  const relatedLinks = dedupeResolvedXeroObjectLinks([
    ...existingCreditNoteLinks,
    ...recoveredBookingScopedLinks,
  ]);

  const existingRefundPaymentIds = new Set(
    relatedLinks
      .filter((link) => link.localModel === "Payment" && link.role === "REFUND_CREDIT_NOTE")
      .map((link) => link.localId)
  );
  const existingAccountCreditPaymentIds = new Set(
    relatedLinks
      .filter(
        (link) => link.localModel === "Payment" && link.role === "ACCOUNT_CREDIT_NOTE"
      )
      .map((link) => link.localId)
  );

  const creditNoteLinks = dedupeXeroObjectLinks([
    ...relatedLinks.map(
      (link) =>
        ({
          localModel: link.localModel,
          localId: link.localId,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: creditNote.creditNoteID!,
          xeroObjectNumber: creditNote.creditNoteNumber ?? null,
          role: link.role,
          metadata: {
            status: creditNote.status ?? null,
            total: creditNote.total ?? null,
            appliedAmount: creditNote.appliedAmount ?? null,
            remainingCredit: creditNote.remainingCredit ?? null,
          },
          // F4 (#1354): merge over the outbound {amountCents, watermarkCents}
          // instead of destroying the per-delta covering inputs.
          mergeMetadata: true,
        }) satisfies XeroObjectLinkInput
    ),
    ...canonicalPaymentLinks
      .filter((payment) => !existingRefundPaymentIds.has(payment.id))
      .map(
        (payment) =>
          ({
            localModel: "Payment",
            localId: payment.id,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: creditNote.creditNoteID!,
            xeroObjectNumber: creditNote.creditNoteNumber ?? null,
            role: "REFUND_CREDIT_NOTE",
            metadata: {
              status: creditNote.status ?? null,
              total: creditNote.total ?? null,
              appliedAmount: creditNote.appliedAmount ?? null,
              remainingCredit: creditNote.remainingCredit ?? null,
            },
            // F4 (#1354): merge over the outbound {amountCents, watermarkCents}
            // instead of destroying the per-delta covering inputs.
            mergeMetadata: true,
          }) satisfies XeroObjectLinkInput
      ),
    ...resolvedAccountCreditPayments
      .filter((payment) => !existingAccountCreditPaymentIds.has(payment.id))
      .map(
        (payment) =>
          ({
            localModel: "Payment",
            localId: payment.id,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: creditNote.creditNoteID!,
            xeroObjectNumber: creditNote.creditNoteNumber ?? null,
            role: "ACCOUNT_CREDIT_NOTE",
            metadata: {
              status: creditNote.status ?? null,
              total: creditNote.total ?? null,
              appliedAmount: creditNote.appliedAmount ?? null,
              remainingCredit: creditNote.remainingCredit ?? null,
            },
            // F4 (#1354): merge over the outbound {amountCents, watermarkCents}
            // instead of destroying the per-delta covering inputs.
            mergeMetadata: true,
          }) satisfies XeroObjectLinkInput
      ),
  ]);

  for (const link of creditNoteLinks) {
    await upsertXeroObjectLink(link);
  }

  const linkedRefundPaymentIds = creditNoteLinks
    .filter((link) => link.localModel === "Payment" && link.role === "REFUND_CREDIT_NOTE")
    .map((link) => link.localId);
  const linkedAccountCreditPaymentIds = creditNoteLinks
    .filter((link) => link.localModel === "Payment" && link.role === "ACCOUNT_CREDIT_NOTE")
    .map((link) => link.localId);
  const paymentCandidates = await prisma.payment.findMany({
    where: {
      OR: [
        {
          xeroRefundCreditNoteId: creditNote.creditNoteID,
        },
        ...(linkedRefundPaymentIds.length > 0
          ? [
              {
                id: {
                  in: linkedRefundPaymentIds,
                },
              },
            ]
          : []),
      ],
    },
    select: {
      id: true,
      xeroRefundCreditNoteId: true,
    },
  });
  const accountCreditPayments =
    linkedAccountCreditPaymentIds.length > 0
      ? await prisma.payment.findMany({
          where: {
            id: {
              in: linkedAccountCreditPaymentIds,
            },
          },
          select: {
            id: true,
            bookingId: true,
            booking: {
              select: {
                memberId: true,
              },
            },
          },
        })
      : [];

  const canApplyCanonicalRefundLink = paymentCandidates.length === 1;
  let updatedPayments = 0;
  for (const payment of paymentCandidates) {
    if (!payment.xeroRefundCreditNoteId && canApplyCanonicalRefundLink) {
      await prisma.payment.update({
        where: {
          id: payment.id,
        },
        data: {
          xeroRefundCreditNoteId: creditNote.creditNoteID,
        },
      });
      updatedPayments += 1;
    }
  }

  const creditNoteAmountCents = getCreditNoteAmountCents(creditNote);
  let updatedCredits = 0;
  for (const payment of accountCreditPayments) {
    if (creditNoteAmountCents === null) {
      continue;
    }

    // #3369: this stamps the note onto a MEMBER CREDIT row, and an
    // organisation-owned booking has none — credit belongs to a person's
    // account. Nothing to backfill.
    const creditOwnerMemberId = bookingOwner(payment.booking).memberId;
    if (!creditOwnerMemberId) continue;

    const bookingLabel = payment.bookingId.slice(0, 8);
    const backfilledCredits = await prisma.memberCredit.updateMany({
      where: {
        memberId: creditOwnerMemberId,
        sourceBookingId: payment.bookingId,
        amountCents: creditNoteAmountCents,
        type: CreditType.CANCELLATION_REFUND,
        description: `Cancellation refund for booking ${bookingLabel}`,
        xeroCreditNoteId: null,
      },
      data: {
        xeroCreditNoteId: creditNote.creditNoteID,
      },
    });
    updatedCredits += backfilledCredits.count;
  }
  const allocationTargets = buildCreditNoteAllocationTargets(creditNote);
  const resolvedCreditNoteLinks = dedupeXeroObjectLinks([
    ...creditNoteLinks,
    ...paymentCandidates
      .filter(
        (payment) =>
          !creditNoteLinks.some(
            (link) =>
              link.localModel === "Payment" &&
              link.localId === payment.id &&
              link.role === "REFUND_CREDIT_NOTE"
          )
      )
      .map(
        (payment) =>
          ({
            localModel: "Payment",
            localId: payment.id,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: creditNote.creditNoteID!,
            xeroObjectNumber: creditNote.creditNoteNumber ?? null,
            role: "REFUND_CREDIT_NOTE",
            metadata: {
              status: creditNote.status ?? null,
              total: creditNote.total ?? null,
              appliedAmount: creditNote.appliedAmount ?? null,
              remainingCredit: creditNote.remainingCredit ?? null,
            },
            // F4 (#1354): merge over the outbound {amountCents, watermarkCents}
            // instead of destroying the per-delta covering inputs.
            mergeMetadata: true,
          }) satisfies XeroObjectLinkInput
      ),
  ]);

  for (const link of resolvedCreditNoteLinks) {
    await upsertXeroObjectLink(link);
  }

  const allocationLinks = dedupeXeroObjectLinks(
    allocationTargets.flatMap(({ invoiceId, amountCents }) => {
      return resolvedCreditNoteLinks.map(
        (link) =>
          ({
            localModel: link.localModel,
            localId: link.localId,
            xeroObjectType: "ALLOCATION",
            xeroObjectId: buildSyntheticAllocationLinkId(
              creditNote.creditNoteID!,
              invoiceId,
              amountCents
            ),
            xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
            role: getDerivedInboundAllocationRole(link.role),
            metadata: {
              creditNoteId: creditNote.creditNoteID,
              invoiceId,
              amountCents,
            },
          }) satisfies XeroObjectLinkInput
      );
    })
  );

  for (const link of allocationLinks) {
    await upsertXeroObjectLink(link);
  }

  const modificationRefundPaymentIdsByInvoiceId = resolvedCreditNoteLinks.some(
    (link) => link.role === "MODIFICATION_CREDIT_NOTE"
  )
    ? await resolvePaymentIdsByInvoiceTargets(
        creditNote.creditNoteID,
        allocationTargets
      )
    : new Map<string, string>();
  const modificationRefundAmountsByPaymentId = new Map<string, number>();

  for (const target of allocationTargets) {
    const paymentId = modificationRefundPaymentIdsByInvoiceId.get(
      target.invoiceId
    );
    if (!paymentId) {
      continue;
    }

    modificationRefundAmountsByPaymentId.set(
      paymentId,
      (modificationRefundAmountsByPaymentId.get(paymentId) ?? 0) +
        target.amountCents
    );
  }

  const refundedPaymentRepair = await repairRefundedPaymentBusinessState({
    creditNoteId: creditNote.creditNoteID,
    creditNote: {
      status: creditNote.status ?? undefined,
      total: creditNote.total ?? undefined,
      appliedAmount: creditNote.appliedAmount ?? undefined,
      remainingCredit: creditNote.remainingCredit ?? undefined,
    },
    directPaymentIds: [
      ...paymentCandidates.map((payment) => payment.id),
      ...accountCreditPayments.map((payment) => payment.id),
    ],
    modificationRefundAmountsByPaymentId,
  });

  const accountCreditAllocationRepair =
    accountCreditPayments.length > 0
      ? await repairAccountCreditAllocationBusinessState(
          creditNote.creditNoteID,
          allocationTargets
        )
      : {
          matchedPayments: 0,
          createdAppliedCredits: 0,
          updatedAppliedCredits: 0,
          updatedAppliedPayments: 0,
          skippedAllocations: 0,
        };

  const refundPaymentLinks = dedupeXeroObjectLinks(
    (creditNote.payments ?? []).flatMap((payment) => {
      if (!payment.paymentID) {
        return [];
      }

      return resolvedCreditNoteLinks
        .filter((link) => link.role === "REFUND_CREDIT_NOTE")
        .map(
          (link) =>
            ({
              localModel: link.localModel,
              localId: link.localId,
              xeroObjectType: "PAYMENT",
              xeroObjectId: payment.paymentID!,
              xeroObjectNumber: buildXeroPaymentDisplayNumber(payment),
              role: "REFUND_PAYMENT",
              metadata: {
                creditNoteId: creditNote.creditNoteID,
                amount: payment.amount ?? null,
                date: payment.date ?? null,
                paymentType: payment.paymentType ?? null,
                status: payment.status ?? null,
              },
            }) satisfies XeroObjectLinkInput
        );
    })
  );

  for (const link of refundPaymentLinks) {
    await upsertXeroObjectLink(link);
  }

  await writeXeroInboundAuditLogs({
    source: "xero-inbound-credit-note",
    links: [...resolvedCreditNoteLinks, ...allocationLinks, ...refundPaymentLinks],
    metadata: {
      creditNoteId: creditNote.creditNoteID,
      creditNoteNumber: creditNote.creditNoteNumber ?? null,
      matchedPayments: paymentCandidates.length,
      matchedAccountCreditPayments: accountCreditPayments.length,
      updatedPayments,
      updatedCredits,
      updatedRefundedPayments: refundedPaymentRepair.updatedPayments,
      createdAppliedCredits: accountCreditAllocationRepair.createdAppliedCredits,
      updatedAppliedCredits: accountCreditAllocationRepair.updatedAppliedCredits,
      updatedAppliedPayments: accountCreditAllocationRepair.updatedAppliedPayments,
    },
  });

  return {
    handled: true,
    kind: "CREDIT_NOTE",
    resourceId: creditNote.creditNoteID,
    creditNoteNumber: creditNote.creditNoteNumber ?? null,
    matchedPayments: paymentCandidates.length,
    matchedAccountCreditPayments: accountCreditPayments.length,
    updatedPayments,
    updatedCredits,
    matchedRefundedPayments: refundedPaymentRepair.matchedPayments,
    updatedRefundedPayments: refundedPaymentRepair.updatedPayments,
    matchedAllocatedPayments: accountCreditAllocationRepair.matchedPayments,
    createdAppliedCredits: accountCreditAllocationRepair.createdAppliedCredits,
    updatedAppliedCredits: accountCreditAllocationRepair.updatedAppliedCredits,
    updatedAppliedPayments: accountCreditAllocationRepair.updatedAppliedPayments,
    skippedAppliedCreditAllocations: accountCreditAllocationRepair.skippedAllocations,
    relatedLinksUpdated: resolvedCreditNoteLinks.length,
    allocationsUpdated: allocationLinks.length,
    refundPaymentsUpdated: refundPaymentLinks.length,
  };
}
