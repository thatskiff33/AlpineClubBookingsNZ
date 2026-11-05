import { bookingOwner } from "@/lib/booking-owner";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { creditNoteMirrorEvidenceFrom, mirrorCreditNoteOutsideSpend } from "@/lib/xero-credit-note-mirror";
import { creditNoteSpendEvidenceMetadata, withCreditNoteSpendEvidence } from "@/lib/xero-credit-note-spend-evidence";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { type XeroObjectLinkInput, upsertXeroObjectLink } from "@/lib/xero-sync";
import { buildCreditNoteAllocationTargets, buildSyntheticAllocationLinkId, buildXeroPaymentDisplayNumber, getCreditNoteAmountCents } from "./amounts";
import { dedupeResolvedXeroObjectLinks, dedupeXeroObjectLinks, findActiveXeroObjectLinks, findPaymentIdsWithCancelledRefundNoteMirror, getDerivedInboundAllocationRole, isDeletedXeroPaymentStatus, recoverBookingScopedLinksFromOutboundOperations } from "./object-links";
import { creditNotePaymentsForAbsence, retireDeletedPaymentLinksAbsentFromPayload } from "./deleted-payment-links";
import { writeXeroInboundAuditLogs } from "./audit";
import { type XeroAuditLocalLink } from "./types";
import { repairAccountCreditAllocationBusinessState, repairRefundedPaymentBusinessState, resolveAccountCreditPaymentsFromMemberCredits, resolveAppliedCreditPaymentsFromLocalProvenance } from "./credit-note-repairs";
import { resolveModificationRefundAmountsByPaymentId } from "./modification-note-refunds";
import { accountCreditNoteHeld, accountCreditNoteRaisedFor, stampCancellationCreditXeroNote } from "@/lib/xero-account-credit-note-stamp";
import { isIncludedRefundCreditNoteStatus, isRefundNoteLinkOf, mayRecordAsCanonicalRefundNote, withoutVoidedRefundNoteLinks, xeroCreditNoteSnapshotMetadata } from "@/lib/xero-refund-note-status";

/** #4291: the audit source naming a recount reached only through a voided mirror. */
const VOIDED_MIRROR_RECOUNT_AUDIT_SOURCE = "xero-inbound-credit-note-voided-mirror-recount";

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
  // #4712: these are payments on the bookings the credit was SPENT on, not ones
  // the note was raised for, so they only open the applied-credit repair below:
  // no ACCOUNT_CREDIT_NOTE link (it would block the booking's own cancellation
  // note), no refund recount and no stamp. The slices and their ALLOCATION
  // links already record the applied credit.
  const appliedCreditPayments =
    canonicalAccountCreditPayments.length > 0
      ? []
      : await resolveAppliedCreditPaymentsFromLocalProvenance(
          creditNote.creditNoteID
        );
  const relatedLinks = dedupeResolvedXeroObjectLinks([
    ...existingCreditNoteLinks,
    ...recoveredBookingScopedLinks,
  ]);

  const existingRefundPaymentIds = new Set(
    relatedLinks
      .filter((link) => isRefundNoteLinkOf(link))
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
          metadata: xeroCreditNoteSnapshotMetadata(creditNote), // #4288: stamped with its UpdatedDateUTC
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
            metadata: xeroCreditNoteSnapshotMetadata(creditNote),
            // F4 (#1354): merge over the outbound {amountCents, watermarkCents}
            // instead of destroying the per-delta covering inputs.
            mergeMetadata: true,
          }) satisfies XeroObjectLinkInput
      ),
    ...canonicalAccountCreditPayments
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
            metadata: xeroCreditNoteSnapshotMetadata(creditNote),
            // F4 (#1354): merge over the outbound {amountCents, watermarkCents}
            // instead of destroying the per-delta covering inputs.
            mergeMetadata: true,
          }) satisfies XeroObjectLinkInput
      ),
  ]);

  // #4220: what Xero sent about the note's spend, kept with its links for the early warning.
  // Advisory only: a failure leaves the previous reading (or none) and never fails the event.
  const spendEvidence = await creditNoteSpendEvidenceMetadata(creditNote, prisma).catch((err: unknown) => {
    logger.warn({ err, creditNoteId: creditNote.creditNoteID }, "Could not refresh a credit note's spend reading; its links keep the previous one until the note's next event");
    return {};
  });
  for (const link of creditNoteLinks) {
    await upsertXeroObjectLink(withCreditNoteSpendEvidence(link, spendEvidence));
  }

  const linkedRefundPaymentIds = creditNoteLinks
    .filter((link) => isRefundNoteLinkOf(link))
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
          // #4705: the stamp's pass ends at its first stamp, so it reads them in a fixed order.
          orderBy: { id: "asc" },
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
    // #3880 F1: a per-refund note never becomes the payment's canonical one;
    // #4046: nor does a voided one, which the link loops just deactivated.
    if (
      !payment.xeroRefundCreditNoteId &&
      isIncludedRefundCreditNoteStatus(creditNote.status) &&
      canApplyCanonicalRefundLink &&
      (await mayRecordAsCanonicalRefundNote(payment.id, creditNote.creditNoteID, prisma))
    ) {
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
  // #4705: the note stamps the one credit it was raised for, through the
  // outbox's own stamp (`INV-INT-036`), and only while no lot or slice records
  // it - which also covers every note a resolver reached: a cancellation
  // credit holds it, or (#1925's local provenance) a slice does. Only a payment
  // whose own outbox row raised the note as an account-credit note is stamped
  // (PR #4711 review): an ACCOUNT_CREDIT_NOTE link alone can be one local
  // provenance wrote on a booking the credit was APPLIED to before #4712. The
  // credit that row named is stamped by id, else one equal credit, oldest
  // first; the first stamp ends the pass.
  const raisedFor =
    creditNoteAmountCents !== null && accountCreditPayments.length > 0 && !(await accountCreditNoteHeld(creditNote.creditNoteID))
      ? await accountCreditNoteRaisedFor({ creditNoteId: creditNote.creditNoteID, paymentIds: accountCreditPayments.map((payment) => payment.id) })
      : null;
  if (raisedFor && creditNoteAmountCents !== null) {
    for (const payment of accountCreditPayments) {
      if (!raisedFor.paymentIds.includes(payment.id)) continue;

      // #3369: this stamps the note onto a MEMBER CREDIT row, and an
      // organisation-owned booking has none — credit belongs to a person's
      // account. Nothing to backfill.
      const creditOwnerMemberId = bookingOwner(payment.booking).memberId;
      if (!creditOwnerMemberId) continue;

      const stampedCreditId = await stampCancellationCreditXeroNote({
        memberId: creditOwnerMemberId,
        bookingId: payment.bookingId,
        refundAmountCents: creditNoteAmountCents,
        creditNoteId: creditNote.creditNoteID,
        ...(raisedFor.memberCreditId ? { memberCreditId: raisedFor.memberCreditId } : {}),
      });
      if (stampedCreditId) {
        updatedCredits += 1;
        break;
      }
    }
  }
  const allocationTargets = buildCreditNoteAllocationTargets(creditNote);
  const resolvedCreditNoteLinks = dedupeXeroObjectLinks([
    ...creditNoteLinks,
    ...paymentCandidates
      .filter(
        (payment) =>
          !creditNoteLinks.some(
            (link) => link.localId === payment.id && isRefundNoteLinkOf(link)
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
            metadata: xeroCreditNoteSnapshotMetadata(creditNote),
            // F4 (#1354): merge over the outbound {amountCents, watermarkCents}
            // instead of destroying the per-delta covering inputs.
            mergeMetadata: true,
          }) satisfies XeroObjectLinkInput
      ),
  ]);

  for (const link of resolvedCreditNoteLinks) {
    await upsertXeroObjectLink(link);
  }

  // #4288: a LIVE reading's allocations and refund payments are as old as its
  // status, so neither is written for a payment whose refund-note row (either
  // role) is VOIDED/DELETED when it is written - read fresh at that point, never
  // a verdict kept from the link write - and a void that won is never given
  // them. Under a newer live snapshot they are written as before #4288: no money
  // reader uses a payment's CREDIT_NOTE_ALLOCATION links, and a REFUND_PAYMENT
  // reader asks only whether one names the note. An older allocation link can
  // so stay active beside a newer one.
  const withoutVoidedRefundNoteRows = async (links: XeroObjectLinkInput[]) =>
    isIncludedRefundCreditNoteStatus(creditNote.status) ? withoutVoidedRefundNoteLinks(creditNote.creditNoteID!, links, prisma) : links;
  const allocationSourceLinks = await withoutVoidedRefundNoteRows(resolvedCreditNoteLinks);

  const allocationLinks = dedupeXeroObjectLinks(
    allocationTargets.flatMap(({ invoiceId, amountCents }) => {
      return allocationSourceLinks.map(
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

  const resolveCurrentModificationRefunds = () =>
    resolveModificationRefundAmountsByPaymentId({
      creditNoteId: creditNote.creditNoteID!,
      isModificationNote: resolvedCreditNoteLinks.some(
        (link) => link.role === "MODIFICATION_CREDIT_NOTE"
      ),
      allocationTargets,
    });
  const modificationRefundAmountsByPaymentId = await resolveCurrentModificationRefunds();

  // #4291: a cancelled note still recounts the payments whose mirror its void
  // turned off (the pointer released with it), and only them: a live read
  // never resolves a voided mirror. Read AFTER this event's link writes, so a
  // concurrent event's void that committed while the reads above ran is seen
  // here. Recount only - no link, pointer or allocation is written for them.
  const voidedMirrorPaymentIds = isIncludedRefundCreditNoteStatus(creditNote.status)
    ? []
    : await findPaymentIdsWithCancelledRefundNoteMirror(creditNote.creditNoteID);
  const matchedPaymentIds = new Set(paymentCandidates.map((payment) => payment.id));
  // Audit-only entries naming the payments only this lookup found, so their
  // recount is attributed; never handed to a link write.
  const voidedMirrorAuditLinks: XeroAuditLocalLink[] = voidedMirrorPaymentIds
    .filter((paymentId) => !matchedPaymentIds.has(paymentId))
    .map((paymentId) => ({
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: creditNote.creditNoteID!,
      xeroObjectNumber: creditNote.creditNoteNumber ?? null,
      role: "REFUND_CREDIT_NOTE",
    }));

  const refundedPaymentRepair = await repairRefundedPaymentBusinessState({
    creditNoteId: creditNote.creditNoteID,
    creditNote: {
      status: creditNote.status ?? undefined,
      total: creditNote.total ?? undefined,
      appliedAmount: creditNote.appliedAmount ?? undefined,
      remainingCredit: creditNote.remainingCredit ?? undefined,
      creditNoteNumber: creditNote.creditNoteNumber ?? undefined, // #4230: named in the bank-transfer floor's alert
    },
    directPaymentIds: [
      ...paymentCandidates.map((payment) => payment.id),
      ...voidedMirrorPaymentIds,
      ...accountCreditPayments.map((payment) => payment.id),
    ],
    modificationRefundAmountsByPaymentId,
    recomputeModificationRefundAmounts: resolveCurrentModificationRefunds,
  });

  const accountCreditAllocationRepair =
    accountCreditPayments.length > 0 || appliedCreditPayments.length > 0
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

  // #4288: read again here, after the recount, for the same reason.
  const refundPaymentSourceLinks = await withoutVoidedRefundNoteRows(resolvedCreditNoteLinks);
  const refundPaymentLinks = dedupeXeroObjectLinks(
    (creditNote.payments ?? []).flatMap((payment) => {
      if (!payment.paymentID) {
        return [];
      }

      return refundPaymentSourceLinks
        .filter((link) => isRefundNoteLinkOf(link))
        .map(
          (link) =>
            ({
              localModel: link.localModel,
              localId: link.localId,
              xeroObjectType: "PAYMENT",
              xeroObjectId: payment.paymentID!,
              xeroObjectNumber: buildXeroPaymentDisplayNumber(payment),
              role: "REFUND_PAYMENT",
              active: !isDeletedXeroPaymentStatus(payment.status), // #4531: never re-adopted
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
  // #4531: a refund payment deleted in Xero leaves the note's payload; retired once Xero confirms it.
  const deletedPaymentLinks = await retireDeletedPaymentLinksAbsentFromPayload({
    session: { xero, tenantId },
    document: { kind: "CREDIT_NOTE", id: creditNote.creditNoteID },
    payments: creditNotePaymentsForAbsence(creditNote),
    localScope: resolvedCreditNoteLinks.filter((link) => isRefundNoteLinkOf(link)),
  });

  // #4712: audit-only entries naming the payments reached only through local
  // provenance, so their applied-credit repair is attributed; never handed to
  // a link write.
  const appliedCreditAuditLinks: XeroAuditLocalLink[] = appliedCreditPayments.map((payment) => ({
    localModel: "Payment",
    localId: payment.id,
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: creditNote.creditNoteID!,
    xeroObjectNumber: creditNote.creditNoteNumber ?? null,
    role: "APPLIED_CREDIT_ALLOCATION",
  }));
  const auditMetadata = {
    creditNoteId: creditNote.creditNoteID,
    creditNoteNumber: creditNote.creditNoteNumber ?? null,
    matchedPayments: paymentCandidates.length,
    matchedAccountCreditPayments: accountCreditPayments.length,
    matchedAppliedCreditPayments: appliedCreditPayments.length,
    updatedPayments,
    updatedCredits,
    updatedRefundedPayments: refundedPaymentRepair.updatedPayments,
    createdAppliedCredits: accountCreditAllocationRepair.createdAppliedCredits,
    updatedAppliedCredits: accountCreditAllocationRepair.updatedAppliedCredits,
    updatedAppliedPayments: accountCreditAllocationRepair.updatedAppliedPayments,
  };
  await writeXeroInboundAuditLogs({
    source: "xero-inbound-credit-note",
    links: [...resolvedCreditNoteLinks, ...allocationLinks, ...refundPaymentLinks, ...appliedCreditAuditLinks],
    metadata: auditMetadata,
  });
  // #4291: the payments recounted only through their voided mirror.
  await writeXeroInboundAuditLogs({
    source: VOIDED_MIRROR_RECOUNT_AUDIT_SOURCE,
    links: voidedMirrorAuditLinks,
    metadata: auditMetadata,
  });

  // #4270: LAST, after the links and repairs above, so a refund payment or booking invoice
  // the app made is already recorded when the mirror asks which spend is the app's own. It
  // reuses the note read above, writes only the credit ledger, and never fails the event:
  // the links are already written and a replay would only repeat them.
  let mirrorFailed = false;
  try {
    const mirrorEvidence = creditNoteMirrorEvidenceFrom(creditNote);
    if (mirrorEvidence) await mirrorCreditNoteOutsideSpend(mirrorEvidence);
  } catch (err) {
    mirrorFailed = true;
    logger.error({ err, creditNoteId: creditNote.creditNoteID }, "Mirroring a credit note spent outside the app failed; the sweep will try again");
  }

  return {
    handled: true,
    kind: "CREDIT_NOTE",
    mirrorFailed,
    // #4095: a refunded total whose claim was lost twice was left unwritten; a
    // stored event fails on it after every write above, so it is retried.
    ...(refundedPaymentRepair.unsettledPaymentIds
      ? {
          recountLeftUnsettled: `The refunded total of payment(s) ${refundedPaymentRepair.unsettledPaymentIds.join(", ")} lost its claim twice to a concurrent writer while credit note ${creditNote.creditNoteID} was synced; the event is retried to recount it.`,
        }
      : {}),
    resourceId: creditNote.creditNoteID,
    creditNoteNumber: creditNote.creditNoteNumber ?? null,
    matchedPayments: paymentCandidates.length,
    matchedAccountCreditPayments: accountCreditPayments.length,
    matchedAppliedCreditPayments: appliedCreditPayments.length,
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
    deletedPaymentLinks,
  };
}
