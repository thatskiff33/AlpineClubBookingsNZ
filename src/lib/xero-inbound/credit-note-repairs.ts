import { type CreditNote as XeroCreditNote } from "xero-node";
import { CreditType, PaymentSource, PaymentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { type AccountCreditAllocationRepairResult, type AccountCreditAllocationTarget, type RefundedPaymentBusinessStateRepairResult } from "./types";
import { buildBookingAppliedCreditDescription, getAmountCentsFromAllocationMetadata, getCreditNoteAmountCents, getCreditNoteIdFromAllocationMetadata, getJsonRecord, getNextRefundedPaymentStatus, getRefundContributionCentsFromCreditNoteMetadata } from "./amounts";
import { isIncludedRefundCreditNoteStatus } from "@/lib/xero-refund-note-status";
import { findActiveXeroObjectLinks } from "./object-links";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";
import { lockMemberCreditLedger } from "@/lib/member-credit";
import { repairLegacyAppliedCreditNoteAllocationsForBooking } from "@/lib/xero-applied-credit-allocation-repair";
import { assertNoAppliedCreditDeallocationFence } from "@/lib/xero-applied-credit-operation-serialization";

const APPLIED_CREDIT_ALLOCATION_ROLES = [
  "APPLIED_CREDIT_ALLOCATION",
  "APPLIED_CREDIT_REMAINDER_ALLOCATION",
] as const;

async function includeDeletedAppliedCreditAllocationTargets(
  creditNoteId: string,
  allocationTargets: AccountCreditAllocationTarget[],
): Promise<AccountCreditAllocationTarget[]> {
  const activeHistoricalLinks = await prisma.xeroObjectLink.findMany({
    where: {
      xeroObjectType: "ALLOCATION",
      role: { in: [...APPLIED_CREDIT_ALLOCATION_ROLES] },
      active: true,
      metadata: { path: ["creditNoteId"], equals: creditNoteId },
    },
    select: { metadata: true },
  });
  const targetsByInvoiceId = new Map(
    allocationTargets.map((target) => [target.invoiceId, target]),
  );

  for (const link of activeHistoricalLinks) {
    const metadata = getJsonRecord(link.metadata);
    const invoiceId = typeof metadata?.invoiceId === "string"
      ? metadata.invoiceId
      : null;
    if (invoiceId && !targetsByInvoiceId.has(invoiceId)) {
      // Xero omits zero-valued allocations entirely. An active local link proves
      // this note was previously allocated to the invoice, so absence from the
      // provider response is an observed target of zero, not "no information".
      targetsByInvoiceId.set(invoiceId, { invoiceId, amountCents: 0 });
    }
  }

  return [...targetsByInvoiceId.values()];
}

export async function resolvePaymentIdsByInvoiceTargets(
  creditNoteId: string,
  allocationTargets: AccountCreditAllocationTarget[]
) {
  const uniqueInvoiceIds = Array.from(
    new Set(
      allocationTargets
        .map((target) => target.invoiceId)
        .filter((invoiceId): invoiceId is string => Boolean(invoiceId))
    )
  );
  if (uniqueInvoiceIds.length === 0) {
    return new Map<string, string>();
  }

  const paymentIdsByInvoiceId = new Map<string, Set<string>>();
  const directMatches = await prisma.payment.findMany({
    where: {
      xeroInvoiceId: {
        in: uniqueInvoiceIds,
      },
    },
    select: {
      id: true,
      xeroInvoiceId: true,
    },
  });

  for (const payment of directMatches) {
    if (!payment.xeroInvoiceId) {
      continue;
    }

    const ids = paymentIdsByInvoiceId.get(payment.xeroInvoiceId) ?? new Set<string>();
    ids.add(payment.id);
    paymentIdsByInvoiceId.set(payment.xeroInvoiceId, ids);
  }

  const unresolvedInvoiceIds = uniqueInvoiceIds.filter(
    (invoiceId) => (paymentIdsByInvoiceId.get(invoiceId)?.size ?? 0) !== 1
  );
  if (unresolvedInvoiceIds.length > 0) {
    const linkedMatches = await prisma.xeroObjectLink.findMany({
      where: {
        localModel: "Payment",
        xeroObjectType: "INVOICE",
        xeroObjectId: {
          in: unresolvedInvoiceIds,
        },
        active: true,
      },
      select: {
        localId: true,
        xeroObjectId: true,
      },
    });

    for (const link of linkedMatches) {
      const ids = paymentIdsByInvoiceId.get(link.xeroObjectId) ?? new Set<string>();
      ids.add(link.localId);
      paymentIdsByInvoiceId.set(link.xeroObjectId, ids);
    }
  }

  const resolvedPaymentIds = new Map<string, string>();
  for (const invoiceId of uniqueInvoiceIds) {
    const paymentIds = paymentIdsByInvoiceId.get(invoiceId);
    // "Exactly one payment" said as a first with no rest, so the id the
    // resolution stores is a value this branch already holds (#2800).
    const [onlyPaymentId, ...extraPaymentIds] = paymentIds ?? [];
    if (onlyPaymentId !== undefined && extraPaymentIds.length === 0) {
      resolvedPaymentIds.set(invoiceId, onlyPaymentId);
      continue;
    }

    if ((paymentIds?.size ?? 0) > 1) {
      logger.warn(
        {
          creditNoteId,
          invoiceId,
          matchedPayments: paymentIds?.size ?? 0,
        },
        "Skipping refunded-payment repair because the allocated invoice resolved to multiple local payments"
      );
    }
  }

  return resolvedPaymentIds;
}

export async function repairRefundedPaymentBusinessState(input: {
  creditNoteId: string;
  creditNote: Pick<XeroCreditNote, "status" | "total" | "appliedAmount" | "remainingCredit">;
  directPaymentIds: string[];
  modificationRefundAmountsByPaymentId: Map<string, number>;
}): Promise<RefundedPaymentBusinessStateRepairResult> {
  const directPaymentIds = Array.from(
    new Set(
      input.directPaymentIds.filter(
        (paymentId): paymentId is string => typeof paymentId === "string" && paymentId.trim().length > 0
      )
    )
  );
  const paymentIds = Array.from(
    new Set([
      ...directPaymentIds,
      ...Array.from(input.modificationRefundAmountsByPaymentId.keys()),
    ])
  );
  if (paymentIds.length === 0) {
    return {
      matchedPayments: 0,
      updatedPayments: 0,
    };
  }

  const payments = await prisma.payment.findMany({
    where: {
      id: {
        in: paymentIds,
      },
    },
    select: {
      id: true,
      amountCents: true,
      refundedAmountCents: true,
      status: true,
      // F5 (#1353): Stripe payments get a raise-only ledger floor below.
      source: true,
    },
  });
  if (payments.length === 0) {
    return {
      matchedPayments: 0,
      updatedPayments: 0,
    };
  }

  const [directRefundLinks, modificationAllocationLinks] = await Promise.all([
    prisma.xeroObjectLink.findMany({
      where: {
        localModel: "Payment",
        localId: {
          in: paymentIds,
        },
        xeroObjectType: "CREDIT_NOTE",
        role: {
          in: ["REFUND_CREDIT_NOTE", "ACCOUNT_CREDIT_NOTE"],
        },
        active: true,
      },
      select: {
        localId: true,
        xeroObjectId: true,
        metadata: true,
      },
    }),
    prisma.xeroObjectLink.findMany({
      where: {
        localModel: "Payment",
        localId: {
          in: paymentIds,
        },
        xeroObjectType: "ALLOCATION",
        role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        active: true,
      },
      select: {
        localId: true,
        xeroObjectId: true,
        metadata: true,
      },
    }),
  ]);

  const existingModificationCreditNoteIds = Array.from(
    new Set(
      modificationAllocationLinks
        .map((link) => getCreditNoteIdFromAllocationMetadata(link.metadata))
        .filter(
          (creditNoteId): creditNoteId is string =>
            Boolean(creditNoteId) && creditNoteId !== input.creditNoteId
        )
    )
  );
  const validModificationCreditNoteIds = new Set<string>();

  if (existingModificationCreditNoteIds.length > 0) {
    const modificationCreditNotes = await prisma.xeroObjectLink.findMany({
      where: {
        xeroObjectType: "CREDIT_NOTE",
        role: "MODIFICATION_CREDIT_NOTE",
        xeroObjectId: {
          in: existingModificationCreditNoteIds,
        },
        active: true,
      },
      select: {
        xeroObjectId: true,
        metadata: true,
      },
    });

    for (const link of modificationCreditNotes) {
      if (isIncludedRefundCreditNoteStatus(getJsonRecord(link.metadata)?.status)) {
        validModificationCreditNoteIds.add(link.xeroObjectId);
      }
    }
  }

  const directRefundCentsByPaymentId = new Map<string, Map<string, number>>();
  for (const link of directRefundLinks) {
    if (link.xeroObjectId === input.creditNoteId) {
      continue;
    }

    const contributionCents = getRefundContributionCentsFromCreditNoteMetadata(
      link.metadata
    );
    if (contributionCents === null) {
      continue;
    }

    const paymentRefunds =
      directRefundCentsByPaymentId.get(link.localId) ?? new Map<string, number>();
    paymentRefunds.set(link.xeroObjectId, contributionCents);
    directRefundCentsByPaymentId.set(link.localId, paymentRefunds);
  }

  const modificationRefundCentsByPaymentId = new Map<string, Map<string, number>>();
  for (const link of modificationAllocationLinks) {
    const creditNoteId = getCreditNoteIdFromAllocationMetadata(link.metadata);
    if (!creditNoteId || creditNoteId === input.creditNoteId) {
      continue;
    }
    if (!validModificationCreditNoteIds.has(creditNoteId)) {
      continue;
    }

    const contributionCents = getAmountCentsFromAllocationMetadata(link.metadata);
    if (contributionCents === null) {
      continue;
    }

    const paymentRefunds =
      modificationRefundCentsByPaymentId.get(link.localId) ??
      new Map<string, number>();
    paymentRefunds.set(link.xeroObjectId, contributionCents);
    modificationRefundCentsByPaymentId.set(link.localId, paymentRefunds);
  }

  const includesCurrentCreditNoteContribution = isIncludedRefundCreditNoteStatus(
    input.creditNote.status
  );
  const currentCreditNoteAmountCents = includesCurrentCreditNoteContribution
    ? getCreditNoteAmountCents(input.creditNote)
    : null;
  const currentDirectRefundPaymentId =
    currentCreditNoteAmountCents !== null && directPaymentIds.length === 1
      ? directPaymentIds[0]
      : null;

  if (currentCreditNoteAmountCents !== null && directPaymentIds.length > 1) {
    logger.warn(
      {
        creditNoteId: input.creditNoteId,
        matchedPayments: directPaymentIds.length,
      },
      "Skipping direct refunded-payment repair contribution because the Xero credit note resolved to multiple local payments"
    );
  }

  let updatedPayments = 0;

  for (const payment of payments) {
    const directRefundTotalCents = Array.from(
      directRefundCentsByPaymentId.get(payment.id)?.values() ?? []
    ).reduce((sum, amountCents) => sum + amountCents, 0);
    const modificationRefundTotalCents = Array.from(
      modificationRefundCentsByPaymentId.get(payment.id)?.values() ?? []
    ).reduce((sum, amountCents) => sum + amountCents, 0);

    const currentDirectRefundContributionCents =
      currentCreditNoteAmountCents !== null &&
      currentDirectRefundPaymentId === payment.id
        ? currentCreditNoteAmountCents
        : 0;
    const currentModificationRefundContributionCents =
      includesCurrentCreditNoteContribution
        ? input.modificationRefundAmountsByPaymentId.get(payment.id) ?? 0
        : 0;

    const rawRefundedTotalCents =
      directRefundTotalCents +
      modificationRefundTotalCents +
      currentDirectRefundContributionCents +
      currentModificationRefundContributionCents;
    const nextRefundedTotalCents = Math.min(
      Math.max(rawRefundedTotalCents, 0),
      payment.amountCents
    );

    if (rawRefundedTotalCents > payment.amountCents) {
      logger.warn(
        {
          creditNoteId: input.creditNoteId,
          paymentId: payment.id,
          paymentAmountCents: payment.amountCents,
          rawRefundedTotalCents,
        },
        "Clamping refunded payment state because the derived Xero refund total exceeded the local payment amount"
      );
    }

    // F5 (#1353): for source=STRIPE the local refund ledger is Stripe-truth
    // (written by processed refunds and the recovery machinery) — the repair
    // may RAISE it from Xero-derived totals but must never LOWER it. A lower
    // Xero-derived total means either a refund-delta credit note is missing
    // in Xero (the F4 class this floor stops self-masking: the
    // missing-credit-note detector compares against refundedAmountCents) or
    // an operator voided a refund note in Xero for money Stripe has already
    // paid out. Both are Xero-side divergences to surface, not local-ledger
    // corruption to apply — so keep the ledger, log, and raise the deduped
    // Xero sync alert. Non-Stripe payments (Internet Banking) keep the
    // existing treat-Xero-as-authoritative behaviour: Xero IS their payment
    // rail.
    const isStripePayment = payment.source === PaymentSource.STRIPE;
    let effectiveRefundedTotalCents = nextRefundedTotalCents;
    if (
      isStripePayment &&
      nextRefundedTotalCents < payment.refundedAmountCents
    ) {
      logger.warn(
        {
          creditNoteId: input.creditNoteId,
          paymentId: payment.id,
          localRefundedAmountCents: payment.refundedAmountCents,
          xeroDerivedRefundedTotalCents: nextRefundedTotalCents,
        },
        "Xero-derived refund total is below the local Stripe refund ledger; keeping the local ledger (raise-only floor)"
      );
      await notifyXeroSyncError({
        errorType: "refund-ledger-divergence",
        operation: `inbound-credit-note-repair:${input.creditNoteId}`,
        errorMessage: `Xero-derived refund total (${nextRefundedTotalCents}c) for payment ${payment.id} is below the local Stripe refund ledger (${payment.refundedAmountCents}c). The local ledger was kept (raise-only floor, #1353). Likely causes: a missing refund-delta credit note in Xero, or a refund credit note voided in Xero after Stripe paid the refund out.`,
      });
      effectiveRefundedTotalCents = payment.refundedAmountCents;
    }

    let nextStatus = getNextRefundedPaymentStatus(
      payment.status,
      payment.amountCents,
      effectiveRefundedTotalCents
    );
    if (
      isStripePayment &&
      nextStatus === PaymentStatus.SUCCEEDED &&
      (payment.status === PaymentStatus.REFUNDED ||
        payment.status === PaymentStatus.PARTIALLY_REFUNDED)
    ) {
      // F5 (#1353): never un-refund a Stripe payment from Xero-derived data.
      nextStatus = null;
    }
    const updates: {
      refundedAmountCents?: number;
      status?: PaymentStatus;
    } = {};

    if (payment.refundedAmountCents !== effectiveRefundedTotalCents) {
      updates.refundedAmountCents = effectiveRefundedTotalCents;
    }
    if (nextStatus && payment.status !== nextStatus) {
      updates.status = nextStatus;
    }

    if (Object.keys(updates).length === 0) {
      continue;
    }

    await prisma.payment.update({
      where: {
        id: payment.id,
      },
      data: updates,
    });
    updatedPayments += 1;
  }

  return {
    matchedPayments: payments.length,
    updatedPayments,
  };
}

export async function resolveAccountCreditPaymentsFromMemberCredits(creditNoteId: string) {
  const credits = await prisma.memberCredit.findMany({
    where: {
      xeroCreditNoteId: creditNoteId,
      type: CreditType.CANCELLATION_REFUND,
      sourceBookingId: {
        not: null,
      },
    },
    select: {
      sourceBookingId: true,
    },
  });

  const bookingIds = Array.from(
    new Set(
      credits
        .map((credit) => credit.sourceBookingId)
        .filter((bookingId): bookingId is string => Boolean(bookingId))
    )
  );

  if (bookingIds.length === 0) {
    return [];
  }

  return prisma.payment.findMany({
    where: {
      bookingId: {
        in: bookingIds,
      },
    },
    select: {
      id: true,
      bookingId: true,
    },
  });
}

/**
 * Fallback resolver (#1925) for applied-credit notes that carry no
 * `CANCELLATION_REFUND` provenance — e.g. an admin-adjustment-minted remainder
 * note (schema: a "freshly minted note for an admin-adjustment (noteless) lot").
 * `resolveAccountCreditPaymentsFromMemberCredits` only recognises
 * `CANCELLATION_REFUND` rows, so such a note whose allocations change or are
 * deleted in Xero would silently skip inbound repair, leaving local slices
 * claiming an allocation Xero no longer has.
 *
 * This derives the payment/member context from unambiguous LOCAL provenance:
 * the precise `MemberCreditNoteAllocation` slices stamped with the note joined
 * to their funding lots, cross-checked against the note's ACTIVE
 * `XeroObjectLink` allocation provenance. It is used ONLY when the
 * `CANCELLATION_REFUND` resolver returns empty and it FAILS CLOSED (returns
 * `[]`, causing the caller to skip repair exactly as today, with a visible
 * warn log) whenever the evidence is missing or ambiguous. When local evidence
 * EXISTS but is contradictory/ambiguous (multiple members, a slice missing its
 * funding lot, conflicting slice-vs-link, a remainder link outside the set, or
 * no resolvable payment) it also raises the deduped operator alert
 * (`notifyXeroSyncError`, #1925 review) so a note that genuinely needs repair is
 * not silently dropped; the benign short-circuits (no stamped slices at all, no
 * active link) stay warn-only "nothing to do". The downstream
 * repair (`repairAccountCreditAllocationBusinessState`) still derives every
 * amount from the provider targets and precise slices, so this resolver never
 * introduces an amount guess of its own.
 *
 * Unambiguity conditions — repair proceeds ONLY when ALL hold:
 *  - at least one `MemberCreditNoteAllocation` slice is stamped with this note;
 *  - at least one ACTIVE applied-credit allocation `XeroObjectLink` references
 *    this note (tombstoned/inactive links never resurrect a repair);
 *  - every stamped slice resolves to a funding lot and a booking;
 *  - the funding lots resolve to exactly ONE member;
 *  - every active MemberCreditNoteAllocation link points at a slice stamped for
 *    this note (a link to a foreign slice is conflicting evidence);
 *  - every active Payment (remainder) link points at a payment inside the
 *    resolved member/booking set;
 *  - the stamped bookings resolve to at least one local payment for the member.
 * Any failure => `[]` (no write).
 */
export async function resolveAppliedCreditPaymentsFromLocalProvenance(
  creditNoteId: string,
): Promise<{ id: string; bookingId: string }[]> {
  // Query slices FIRST and short-circuit on none, so the common no-provenance
  // path adds no extra XeroObjectLink read (keeps ordered link mocks stable).
  const slices = await prisma.memberCreditNoteAllocation.findMany({
    where: { xeroCreditNoteId: creditNoteId },
    select: {
      id: true,
      appliedToBookingId: true,
      memberCredit: { select: { memberId: true } },
    },
  });
  if (slices.length === 0) {
    // No non-refund provenance to prove — skip silently, as the
    // CANCELLATION_REFUND resolver does when it finds nothing.
    return [];
  }

  const activeAllocationLinks = await prisma.xeroObjectLink.findMany({
    where: {
      xeroObjectType: "ALLOCATION",
      role: { in: [...APPLIED_CREDIT_ALLOCATION_ROLES] },
      active: true,
      metadata: { path: ["creditNoteId"], equals: creditNoteId },
    },
    select: { localModel: true, localId: true },
  });
  if (activeAllocationLinks.length === 0) {
    // Precise slices exist but no ACTIVE link proves Xero ever carried this
    // allocation. A note whose links are all tombstoned must never be
    // resurrected into a repair.
    logger.warn(
      { creditNoteId, slices: slices.length },
      "Skipping non-refund applied-credit repair: no active allocation link proves the note was allocated (fail-closed, #1925)",
    );
    return [];
  }

  const memberIds = new Set<string>();
  const bookingIds = new Set<string>();
  const sliceIds = new Set<string>();
  for (const slice of slices) {
    const memberId = slice.memberCredit?.memberId;
    if (!memberId || !slice.appliedToBookingId) {
      logger.warn(
        { creditNoteId, sliceId: slice.id },
        "Skipping non-refund applied-credit repair: a stamped slice is missing its funding lot or booking (fail-closed, #1925)",
      );
      // Ambiguous local evidence (a slice stamped for this note but missing its
      // funding lot/booking) — surface it so an operator can reconcile the note
      // that genuinely needs repair instead of it being silently dropped (#1925
      // review). notifyXeroSyncError dedupes to one alert/hour, so replayed
      // webhooks stay idempotent-safe.
      await notifyXeroSyncError({
        errorType: "applied-credit-repair-ambiguous",
        operation: `inbound-applied-credit-repair:${creditNoteId}`,
        errorMessage: `Non-refund applied-credit repair skipped (fail-closed) for credit note ${creditNoteId}: stamped slice ${slice.id} is missing its funding lot or booking. Local provenance is ambiguous; the note may need manual reconciliation.`,
      });
      return [];
    }
    memberIds.add(memberId);
    bookingIds.add(slice.appliedToBookingId);
    sliceIds.add(slice.id);
  }

  if (memberIds.size !== 1) {
    logger.warn(
      { creditNoteId, candidateMembers: memberIds.size },
      "Skipping non-refund applied-credit repair: stamped slices resolve to multiple members (fail-closed, #1925)",
    );
    await notifyXeroSyncError({
      errorType: "applied-credit-repair-ambiguous",
      operation: `inbound-applied-credit-repair:${creditNoteId}`,
      errorMessage: `Non-refund applied-credit repair skipped (fail-closed) for credit note ${creditNoteId}: stamped slices resolve to ${memberIds.size} members. Local provenance is ambiguous; the note may need manual reconciliation.`,
    });
    return [];
  }
  const memberId = [...memberIds][0];

  // Cross-check active links against the stamped slices. A link to a
  // MemberCreditNoteAllocation outside this note's stamped set is conflicting
  // slice-vs-link evidence; remainder (Payment) links are verified below.
  const linkPaymentIds = new Set<string>();
  for (const link of activeAllocationLinks) {
    if (link.localModel === "MemberCreditNoteAllocation") {
      if (!sliceIds.has(link.localId)) {
        logger.warn(
          { creditNoteId, linkLocalId: link.localId },
          "Skipping non-refund applied-credit repair: an active allocation link references a slice not stamped for this note (fail-closed, #1925)",
        );
        await notifyXeroSyncError({
          errorType: "applied-credit-repair-ambiguous",
          operation: `inbound-applied-credit-repair:${creditNoteId}`,
          errorMessage: `Non-refund applied-credit repair skipped (fail-closed) for credit note ${creditNoteId}: an active allocation link references slice ${link.localId} not stamped for this note (conflicting slice-vs-link evidence). The note may need manual reconciliation.`,
        });
        return [];
      }
    } else if (link.localModel === "Payment") {
      linkPaymentIds.add(link.localId);
    }
  }

  const payments = await prisma.payment.findMany({
    where: {
      bookingId: { in: [...bookingIds] },
      booking: { memberId },
    },
    select: { id: true, bookingId: true },
  });
  const resolvedPaymentIds = new Set(payments.map((payment) => payment.id));

  for (const paymentId of linkPaymentIds) {
    if (!resolvedPaymentIds.has(paymentId)) {
      logger.warn(
        { creditNoteId, paymentId },
        "Skipping non-refund applied-credit repair: an active remainder link points at a payment outside the stamped member/booking set (fail-closed, #1925)",
      );
      await notifyXeroSyncError({
        errorType: "applied-credit-repair-ambiguous",
        operation: `inbound-applied-credit-repair:${creditNoteId}`,
        errorMessage: `Non-refund applied-credit repair skipped (fail-closed) for credit note ${creditNoteId}: an active remainder link points at payment ${paymentId} outside the stamped member/booking set. Local provenance is ambiguous; the note may need manual reconciliation.`,
      });
      return [];
    }
  }

  if (payments.length === 0) {
    logger.warn(
      { creditNoteId, memberId, bookings: bookingIds.size },
      "Skipping non-refund applied-credit repair: stamped bookings resolve to no local payment for the member (fail-closed, #1925)",
    );
    await notifyXeroSyncError({
      errorType: "applied-credit-repair-ambiguous",
      operation: `inbound-applied-credit-repair:${creditNoteId}`,
      errorMessage: `Non-refund applied-credit repair skipped (fail-closed) for credit note ${creditNoteId}: stamped bookings for member ${memberId} resolve to no local payment. Local provenance is ambiguous; the note may need manual reconciliation.`,
    });
    return [];
  }

  return payments.map((payment) => ({
    id: payment.id,
    bookingId: payment.bookingId,
  }));
}

export async function repairAccountCreditAllocationBusinessState(
  creditNoteId: string,
  allocationTargets: AccountCreditAllocationTarget[]
): Promise<AccountCreditAllocationRepairResult> {
  const providerTargets = await includeDeletedAppliedCreditAllocationTargets(
    creditNoteId,
    allocationTargets,
  );
  if (providerTargets.length === 0) {
    return {
      matchedPayments: 0,
      createdAppliedCredits: 0,
      updatedAppliedCredits: 0,
      updatedAppliedPayments: 0,
      skippedAllocations: 0,
    };
  }

  let matchedPayments = 0;
  let createdAppliedCredits = 0;
  let updatedAppliedCredits = 0;
  let updatedAppliedPayments = 0;
  let skippedAllocations = 0;

  for (const target of providerTargets) {
    const linkedPaymentIds = (
      await findActiveXeroObjectLinks("INVOICE", target.invoiceId)
    )
      .filter((link) => link.localModel === "Payment")
      .map((link) => link.localId);
    const paymentWhere = [
      {
        xeroInvoiceId: target.invoiceId,
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
    const paymentCandidates = await prisma.payment.findMany({
      where: {
        OR: paymentWhere,
      },
      select: {
        id: true,
        bookingId: true,
        amountCents: true,
        creditAppliedCents: true,
        booking: {
          select: {
            memberId: true,
          },
        },
      },
    });

    // "Exactly one local payment" said as a first with no rest: the repair
    // below then holds the payment itself rather than a count that licenses a
    // later read. A no-match and a multi-match are both skipped, exactly as
    // the length check skipped them (#2800).
    const [payment, ...extraPaymentCandidates] = paymentCandidates;
    if (payment === undefined || extraPaymentCandidates.length > 0) {
      skippedAllocations += 1;
      logger.warn(
        {
          creditNoteId,
          invoiceId: target.invoiceId,
          matchedPayments: paymentCandidates.length,
        },
        "Skipping account-credit allocation repair because the allocated invoice did not resolve to exactly one local payment"
      );
      continue;
    }

    matchedPayments += 1;
    const expectedAmountCents = -target.amountCents;
    const expectedDescription = buildBookingAppliedCreditDescription(
      payment.bookingId
    );
    // Serialize each payment's applied-credit repair on the PER-MEMBER credit
    // ledger lock (#1881) so the existing-credit read, the create/link, the
    // aggregate, and the creditAppliedCents write commit atomically AND mutually
    // exclude the credit spend engine (applyCreditToBooking / restore, which take
    // the same lockMemberCreditLedger key). The previous global lock(1) did NOT
    // exclude those per-member writers, so a BOOKING_APPLIED repair could
    // interleave with a concurrent spend/restore of the same member's ledger.
    // Without serialization two concurrent credit-note events for one payment can
    // also interleave and transiently under-set creditAppliedCents; the clamp
    // keeps the applied total within the payment amount (invariant (b),(d),
    // #1234). DB-only work: no external Xero call runs inside this transaction.
    await prisma.$transaction(async (tx) => {
      await lockMemberCreditLedger(payment.booking.memberId, tx);
      await assertNoAppliedCreditDeallocationFence(payment.id, tx);

      const existingAppliedCredits = await tx.memberCredit.findMany({
        where: {
          memberId: payment.booking.memberId,
          appliedToBookingId: payment.bookingId,
          type: CreditType.BOOKING_APPLIED,
          OR: [
            {
              xeroCreditNoteId: creditNoteId,
            },
            {
              xeroCreditNoteId: null,
              amountCents: expectedAmountCents,
            },
          ],
        },
        select: {
          id: true,
          amountCents: true,
          description: true,
          xeroCreditNoteId: true,
        },
      });

      const linkedAppliedCredits = existingAppliedCredits.filter(
        (credit) => credit.xeroCreditNoteId === creditNoteId
      );

      // One linked row is a first with no rest; the two multi-row branches
      // below are unchanged (#2800).
      const [onlyLinkedCredit, ...extraLinkedCredits] = linkedAppliedCredits;
      if (onlyLinkedCredit !== undefined && extraLinkedCredits.length === 0) {
        const appliedCredit = onlyLinkedCredit;
        const updates: {
          description?: string;
        } = {};

        if (appliedCredit.description !== expectedDescription) {
          updates.description = expectedDescription;
        }

        if (Object.keys(updates).length > 0) {
          await tx.memberCredit.update({
            where: {
              id: appliedCredit.id,
            },
            data: updates,
          });
          updatedAppliedCredits += 1;
        }
      } else if (extraLinkedCredits.length > 0) {
        // Historical negative rows plus later positive/negative offsets are an
        // intentional append-only record. The precise slice reconciler below,
        // not destructive rewrites of those rows, determines provider truth.
        const staleDescriptions = linkedAppliedCredits.filter(
          (credit) => credit.description !== expectedDescription,
        );
        if (staleDescriptions.length > 0) {
          await tx.memberCredit.updateMany({
            where: { id: { in: staleDescriptions.map((credit) => credit.id) } },
            data: { description: expectedDescription },
          });
          updatedAppliedCredits += staleDescriptions.length;
        }
      } else {
        const unlinkedExactCredits = existingAppliedCredits.filter(
          (credit) =>
            credit.xeroCreditNoteId === null &&
            credit.amountCents === expectedAmountCents
        );

        const [onlyUnlinkedCredit, ...extraUnlinkedCredits] =
          unlinkedExactCredits;
        if (onlyUnlinkedCredit !== undefined && extraUnlinkedCredits.length === 0) {
          await tx.memberCredit.update({
            where: {
              id: onlyUnlinkedCredit.id,
            },
            data: {
              xeroCreditNoteId: creditNoteId,
              description: expectedDescription,
            },
          });
          updatedAppliedCredits += 1;
        } else if (extraUnlinkedCredits.length > 0) {
          skippedAllocations += 1;
          logger.warn(
            {
              creditNoteId,
              invoiceId: target.invoiceId,
              bookingId: payment.bookingId,
              appliedCredits: unlinkedExactCredits.length,
            },
            "Skipping account-credit allocation repair because multiple matching unlinked applied-credit rows exist locally"
          );
        } else {
          await tx.memberCredit.create({
            data: {
              memberId: payment.booking.memberId,
              amountCents: expectedAmountCents,
              type: CreditType.BOOKING_APPLIED,
              description: expectedDescription,
              appliedToBookingId: payment.bookingId,
              xeroCreditNoteId: creditNoteId,
            },
          });
          createdAppliedCredits += 1;
        }
      }

      await repairLegacyAppliedCreditNoteAllocationsForBooking(
        payment.bookingId,
        target.invoiceId,
        tx,
        {
          providerTarget: {
            xeroCreditNoteId: creditNoteId,
            amountCents: target.amountCents,
          },
        },
      );

      // Provider-aware slice reconciliation is append-only at the credit-ledger
      // layer. Bring the signed ledger total to precise allocated slices plus
      // any genuinely unallocated (net-negative) rows. This preserves original
      // negative applications and positive clamp offsets instead of rewriting
      // history when a Xero user manually increases/decreases an allocation.
      const [precise, unstamped, currentLedger] = await Promise.all([
        tx.memberCreditNoteAllocation.aggregate({
          where: { appliedToBookingId: payment.bookingId },
          _sum: { amountCents: true },
        }),
        tx.memberCredit.aggregate({
          where: {
            memberId: payment.booking.memberId,
            appliedToBookingId: payment.bookingId,
            type: CreditType.BOOKING_APPLIED,
            xeroCreditNoteId: null,
          },
          _sum: { amountCents: true },
        }),
        tx.memberCredit.aggregate({
          where: {
            memberId: payment.booking.memberId,
            appliedToBookingId: payment.bookingId,
            type: CreditType.BOOKING_APPLIED,
          },
          _sum: { amountCents: true },
        }),
      ]);
      const preciseCents = precise._sum.amountCents ?? 0;
      const unallocatedCents = Math.max(0, -(unstamped._sum.amountCents ?? 0));
      const currentAppliedCents = Math.max(
        0,
        -(currentLedger._sum.amountCents ?? 0),
      );
      const providerAwareAppliedCents = preciseCents + unallocatedCents;
      const ledgerDeltaCents = providerAwareAppliedCents - currentAppliedCents;
      if (ledgerDeltaCents !== 0) {
        await tx.memberCredit.create({
          data: {
            memberId: payment.booking.memberId,
            amountCents: -ledgerDeltaCents,
            type: CreditType.BOOKING_APPLIED,
            description: `Xero allocation reconciliation for booking ${payment.bookingId.slice(0, 8)}`,
            appliedToBookingId: payment.bookingId,
            xeroCreditNoteId: creditNoteId,
          },
        });
        if (ledgerDeltaCents > 0) createdAppliedCredits += 1;
        else updatedAppliedCredits += 1;
      }

      const aggregate = await tx.memberCredit.aggregate({
        where: {
          memberId: payment.booking.memberId,
          appliedToBookingId: payment.bookingId,
          type: CreditType.BOOKING_APPLIED,
        },
        _sum: {
          amountCents: true,
        },
      });
      const appliedCreditTotalCents = Math.min(
        Math.max(-(aggregate._sum.amountCents ?? 0), 0),
        payment.amountCents
      );

      // Compare against the payment's current creditAppliedCents read under the
      // lock; the pre-loop snapshot can be stale, so the write only fires on a
      // real change against the freshly-aggregated (and clamped) total.
      const freshPayment = await tx.payment.findUnique({
        where: {
          id: payment.id,
        },
        select: {
          creditAppliedCents: true,
        },
      });

      if (
        freshPayment &&
        freshPayment.creditAppliedCents !== appliedCreditTotalCents
      ) {
        await tx.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            creditAppliedCents: appliedCreditTotalCents,
          },
        });
        updatedAppliedPayments += 1;
      }
    });
  }

  return {
    matchedPayments,
    createdAppliedCredits,
    updatedAppliedCredits,
    updatedAppliedPayments,
    skippedAllocations,
  };
}
