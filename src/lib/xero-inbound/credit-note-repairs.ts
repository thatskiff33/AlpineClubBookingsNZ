import { APPLIED_CREDIT_ALLOCATION_ROLE } from "@/lib/xero-applied-credit-link-roles";
import { type CreditNote as XeroCreditNote } from "xero-node";
import { CreditType, PaymentSource, PaymentStatus } from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { syncBookingLedgerCredits } from "@/lib/booking-ledger-credit-sync";
import { prisma } from "@/lib/prisma";
import { lockPaymentForRefundedTotal, PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS } from "@/lib/payment-transactions";
import logger from "@/lib/logger";
import { type AccountCreditAllocationRepairResult, type AccountCreditAllocationTarget, type RefundedPaymentBusinessStateRepairResult } from "./types";
import { buildBookingAppliedCreditDescription, type CreditNoteAllocationCents, getAmountCentsFromAllocationMetadata, getCreditNoteAmountCents, getCreditNoteIdFromAllocationMetadata, getJsonRecord, getNextRefundedPaymentStatus, getRefundContributionCentsFromCreditNoteMetadata, sumAppliedCentsByCreditNote } from "./amounts";
import { isIncludedRefundCreditNoteStatus, readRefundNoteRowsByPayment } from "@/lib/xero-refund-note-status";
import { findActiveXeroObjectLinks } from "./object-links";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";
import { floorBankTransferRefundedTotal } from "./credit-note-bank-transfer-floor";
import { createAuditLog } from "@/lib/audit";
import { lockMemberCreditLedger } from "@/lib/member-credit";
import { repairLegacyAppliedCreditNoteAllocationsForBooking } from "@/lib/xero-applied-credit-allocation-repair";
import { assertNoAppliedCreditDeallocationFence } from "@/lib/xero-applied-credit-operation-serialization";
import { getClubFormat } from "@/lib/club-format-settings";
import { formatCents } from "@/lib/utils";
import { invoiceCorrectionNoteIds, noCashModificationNoteIds } from "./account-credit-modification-notes";
import { paymentsCountingInvoiceCorrections, uncapturedPrimaryStatus } from "./modification-note-refunds";
import { capOrganiserChildMirrorAtStripeRefunds } from "@/lib/organiser-child-refund";
import { readRefundRequestPaidBackCentsByPaymentId } from "./refund-request-paid-back";

/** #3792: the operator alert, and the audit action, for a refused change. */
const RESTORED_BOOKING_ALLOCATION_CHANGE_ERROR_TYPE =
  "applied-credit-restored-booking-allocation-change";
const RESTORED_BOOKING_ALLOCATION_CHANGE_AUDIT_ACTION =
  "xero.allocation.restored-booking-change-refused";

/**
 * #3792: the durable record of a refused change. The email alert is throttled
 * to one per hour across every Xero error type (`notifyXeroSyncError`), so it
 * can be suppressed by an unrelated alert; this critical `xero` audit row, the
 * category the inbound reconcile already writes, is what an officer can always
 * find (the audit log, filtered to `xero`). One row per booking, note,
 * direction and amount, so a replayed sync
 * adds none. Best-effort, as the inbound audit writes are: a failed write is
 * logged and never undoes the refusal.
 */
async function recordRestoredBookingAllocationRefusal(
  creditNoteId: string,
  refused: { bookingId: string; memberId: string; invoiceId: string; direction: "reduced" | "increased"; refusedCents: number; restoredCents: number },
  errorMessage: string,
): Promise<void> {
  try {
    const recorded = await prisma.auditLog.findFirst({
      where: {
        action: RESTORED_BOOKING_ALLOCATION_CHANGE_AUDIT_ACTION,
        entityId: refused.bookingId,
        AND: [
          { metadata: { path: ["xeroCreditNoteId"], equals: creditNoteId } },
          { metadata: { path: ["direction"], equals: refused.direction } },
          { metadata: { path: ["refusedCents"], equals: refused.refusedCents } },
        ],
      },
      select: { id: true },
    });
    if (recorded) return;
    await createAuditLog({
      action: RESTORED_BOOKING_ALLOCATION_CHANGE_AUDIT_ACTION,
      targetId: refused.bookingId,
      // No subject member: the row is for officers, and a subject would put
      // its summary on the member's own timeline (INV-PRIV-018).
      entityType: "Booking",
      entityId: refused.bookingId,
      category: "xero",
      severity: "critical",
      outcome: "failure",
      summary: "Xero allocation change refused on a cancelled booking whose credit was already restored",
      details: errorMessage,
      metadata: {
        source: "xero-inbound-credit-note",
        xeroCreditNoteId: creditNoteId,
        xeroInvoiceId: refused.invoiceId,
        direction: refused.direction,
        refusedCents: refused.refusedCents,
        restoredCents: refused.restoredCents,
      },
    });
  } catch (err) {
    logger.error(
      { err, creditNoteId, bookingId: refused.bookingId },
      "Failed to record a refused Xero allocation change on a restored booking (#3792)",
    );
  }
}

const APPLIED_CREDIT_ALLOCATION_ROLES = [APPLIED_CREDIT_ALLOCATION_ROLE, "APPLIED_CREDIT_REMAINDER_ALLOCATION"] as const;

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

/** #4288: named so this recount is not read as a transaction wrapper - it opens one, but this callback never runs in it. */
type RecomputeModificationRefundAmounts = () => Promise<Map<string, number>>;

export async function repairRefundedPaymentBusinessState(input: {
  creditNoteId: string | null; // #4095: null for a recount with no note being synced; every note then counts from its links as read here
  creditNote: Pick<XeroCreditNote, "status" | "total" | "appliedAmount" | "remainingCredit" | "creditNoteNumber">;
  directPaymentIds: string[];
  modificationRefundAmountsByPaymentId: Map<string, number>;
  /**
   * #3979: how the caller derived `modificationRefundAmountsByPaymentId`, so a
   * repair that lost its claim to a concurrent writer recomputes it too - an
   * invoice correction's count depends on the payment's receipt, which that
   * writer (the inbound settle) may just have recorded.
   */
  recomputeModificationRefundAmounts?: RecomputeModificationRefundAmounts;
  /** Internal: the one re-run, for the payments whose claims were lost. */
  retryPaymentIds?: string[];
}): Promise<RefundedPaymentBusinessStateRepairResult> {
  const directPaymentIds = Array.from(
    new Set(
      input.directPaymentIds.filter(
        (paymentId): paymentId is string => typeof paymentId === "string" && paymentId.trim().length > 0
      )
    )
  );
  const paymentIds =
    input.retryPaymentIds ??
    Array.from(
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
      id: true, bookingId: true, // #4230: the bank-transfer floor's alert names the booking
      amountCents: true,
      refundedAmountCents: true,
      status: true,
      // F5 (#1353): Stripe payments get a raise-only ledger floor below.
      source: true,
      xeroInvoiceId: true,
      // #3979: the claim below is on the whole row as read.
      updatedAt: true,
      booking: { select: { organiserSettled: true } },
    },
  });
  if (payments.length === 0) return { matchedPayments: 0, updatedPayments: 0 };

  // #4215 (`INV-PAY-118`): requests' paid-back cash, read AFTER the payment rows, so one completed in between loses the claim
  // below. #4288: the note's own refund-note row too; its void may move no Payment column, so `repairOne` re-reads it locked.
  const [directRefundLinks, modificationAllocationLinks, refundRequestPaidBackCentsByPaymentId, currentNoteRows] = await Promise.all([
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
        updatedAt: true,
      },
    }),
    readRefundRequestPaidBackCentsByPaymentId(paymentIds),
    input.creditNoteId === null ? new Map<string, { active: boolean; metadata: unknown }>() : readRefundNoteRowsByPayment(input.creditNoteId, paymentIds, prisma),
  ]);

  // #3979 (`INV-PAY-126`): a bank-transfer payment's modification notes are
  // found by its invoice too. The inbound sync links an edit's note and its
  // allocation to the edit, not the payment, so a recount triggered by any
  // later note used to drop every earlier modification note from the total -
  // overstating the net of a payment whose receipt kept the stored figure.
  const invoicePaymentIds = new Map(
    payments.flatMap((payment) =>
      payment.source === PaymentSource.INTERNET_BANKING && payment.xeroInvoiceId
        ? [[payment.xeroInvoiceId, payment.id] as const]
        : [],
    ),
  );
  const invoiceAllocationLinks =
    invoicePaymentIds.size === 0
      ? []
      : await prisma.xeroObjectLink.findMany({
          where: {
            xeroObjectType: "ALLOCATION",
            role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
            active: true,
            OR: [...invoicePaymentIds.keys()].map((invoiceId) => ({
              metadata: { path: ["invoiceId"], equals: invoiceId },
            })),
          },
          select: { localId: true, xeroObjectId: true, metadata: true, updatedAt: true },
        });
  // Oldest first, so where two links hold one allocation the newest counts
  // (`sumAppliedCentsByCreditNote` below).
  const linkWrittenAt = (link: { updatedAt?: Date | null }) => link.updatedAt?.getTime() ?? 0;
  const existingModificationAllocations = [
    ...modificationAllocationLinks.map((link) => ({ paymentId: link.localId, link })),
    ...invoiceAllocationLinks.flatMap((link) => {
      const invoiceId = getJsonRecord(link.metadata)?.invoiceId;
      const paymentId = typeof invoiceId === "string" ? invoicePaymentIds.get(invoiceId) : undefined;
      return paymentId ? [{ paymentId, link }] : [];
    }),
  ]
    .sort((a, b) => linkWrittenAt(a.link) - linkWrittenAt(b.link))
    .map(({ paymentId, link }) => ({ paymentId, xeroObjectId: link.xeroObjectId, metadata: link.metadata }));

  const existingModificationCreditNoteIds = Array.from(
    new Set(
      existingModificationAllocations
        .map((link) => getCreditNoteIdFromAllocationMetadata(link.metadata))
        .filter(
          (creditNoteId): creditNoteId is string =>
            Boolean(creditNoteId) && creditNoteId !== input.creditNoteId
        )
    )
  );
  const validModificationCreditNoteIds = new Set<string>();
  const validCorrectionNoteIds = new Set<string>();

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

    // #3809 (review M2), #3954: a give-back or billed-offset note moved no cash.
    // #3979: nor did an invoice correction, but it is counted against a payment
    // whose bank receipt was recorded at the stored figure.
    const [noCashNoteIds, correctionNoteIds] = await Promise.all([
      noCashModificationNoteIds(existingModificationCreditNoteIds),
      invoiceCorrectionNoteIds(existingModificationCreditNoteIds),
    ]);
    for (const link of modificationCreditNotes) {
      if (!isIncludedRefundCreditNoteStatus(getJsonRecord(link.metadata)?.status)) continue;
      if (!noCashNoteIds.has(link.xeroObjectId)) {
        validModificationCreditNoteIds.add(link.xeroObjectId);
      } else if (correctionNoteIds.has(link.xeroObjectId)) {
        validCorrectionNoteIds.add(link.xeroObjectId);
      }
    }
  }
  const paymentsCountingCorrections =
    validCorrectionNoteIds.size > 0 ? await paymentsCountingInvoiceCorrections(paymentIds) : new Set<string>();

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

  // #4095 (L1): a note's allocations to a payment's invoices, summed per note
  // by the rule the kept settle applies (`sumAppliedCentsByCreditNote`). An
  // allocation is the note's application to one invoice: the sync writes one
  // link per note and invoice with its applied amounts summed, so links naming
  // the same invoice - the same allocation linked to several local objects, or
  // an older amount left active beside a re-synced one - count once, newest.
  const modificationAllocationsByPaymentId = new Map<string, CreditNoteAllocationCents[]>();
  for (const link of existingModificationAllocations) {
    const creditNoteId = getCreditNoteIdFromAllocationMetadata(link.metadata);
    if (!creditNoteId || creditNoteId === input.creditNoteId) {
      continue;
    }
    if (
      !validModificationCreditNoteIds.has(creditNoteId) &&
      !(validCorrectionNoteIds.has(creditNoteId) && paymentsCountingCorrections.has(link.paymentId))
    ) {
      continue;
    }

    const contributionCents = getAmountCentsFromAllocationMetadata(link.metadata);
    if (contributionCents === null) {
      continue;
    }

    const invoiceId = getJsonRecord(link.metadata)?.invoiceId;
    const allocations = modificationAllocationsByPaymentId.get(link.paymentId) ?? [];
    allocations.push({
      creditNoteId,
      appliedCents: contributionCents,
      allocationKey: typeof invoiceId === "string" ? `invoice:${invoiceId}` : `link:${link.xeroObjectId}`,
    });
    modificationAllocationsByPaymentId.set(link.paymentId, allocations);
  }
  const modificationRefundCentsByPaymentId = new Map(
    [...modificationAllocationsByPaymentId].map(([paymentId, allocations]) => [
      paymentId,
      sumAppliedCentsByCreditNote(allocations),
    ]),
  );

  // #4288: each payment's current note as its own refund-note row holds it NOW (read above, after the payment rows),
  // never the reading or a remembered verdict: an inactive or VOIDED/DELETED row counts nothing; no row, the reading; no note being synced (#4095), nothing.
  const includesCurrentCreditNoteContribution = (paymentId: string, row = currentNoteRows.get(paymentId)) =>
    input.creditNoteId !== null && (row ? row.active && isIncludedRefundCreditNoteStatus(getJsonRecord(row.metadata)?.status) : isIncludedRefundCreditNoteStatus(input.creditNote.status));
  const currentCreditNoteAmountCents = (paymentId: string, row = currentNoteRows.get(paymentId)) =>
    !includesCurrentCreditNoteContribution(paymentId) ? null : row ? getRefundContributionCentsFromCreditNoteMetadata(row.metadata) : getCreditNoteAmountCents(input.creditNote);
  const currentDirectRefundPaymentId = directPaymentIds.length === 1 ? directPaymentIds[0] : null;

  if (directPaymentIds.length > 1 && directPaymentIds.some((paymentId) => currentCreditNoteAmountCents(paymentId) !== null)) {
    logger.warn(
      {
        creditNoteId: input.creditNoteId,
        matchedPayments: directPaymentIds.length,
      },
      "Skipping direct refunded-payment repair contribution because the Xero credit note resolved to multiple local payments"
    );
  }

  let updatedPayments = 0;
  // Resolve once for the whole inbound repair run, never inside the payment
  // loop or a write transaction (the operator message may name several rows).
  const format = await getClubFormat();

  type RepairedPayment = (typeof payments)[number];
  const repairOne = async (payment: RepairedPayment): Promise<"updated" | "unchanged" | "lost" | "recount"> => {
    const directRefundTotalCents = Array.from(
      directRefundCentsByPaymentId.get(payment.id)?.values() ?? []
    ).reduce((sum, amountCents) => sum + amountCents, 0);
    const modificationRefundTotalCents = Array.from(
      modificationRefundCentsByPaymentId.get(payment.id)?.values() ?? []
    ).reduce((sum, amountCents) => sum + amountCents, 0);

    const currentDirectRefundContributionCents =
      currentDirectRefundPaymentId === payment.id ? currentCreditNoteAmountCents(payment.id) ?? 0 : 0;
    const currentModificationRefundContributionCents =
      includesCurrentCreditNoteContribution(payment.id)
        ? input.modificationRefundAmountsByPaymentId.get(payment.id) ?? 0
        : 0;

    const rawRefundedTotalCents =
      directRefundTotalCents +
      modificationRefundTotalCents +
      currentDirectRefundContributionCents +
      currentModificationRefundContributionCents +
      (refundRequestPaidBackCentsByPaymentId.get(payment.id) ?? 0);
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
        operation: `inbound-credit-note-repair:${input.creditNoteId ?? `recount:${payment.id}`}`,
        errorMessage: `Xero-derived refund total (${formatCents(nextRefundedTotalCents, format)}) for payment ${payment.id} is below the local Stripe refund ledger (${formatCents(payment.refundedAmountCents, format)}). The local ledger was kept (raise-only floor, #1353). Likely causes: a missing refund-delta credit note in Xero, or a refund credit note voided in Xero after Stripe paid the refund out.`,
      });
      effectiveRefundedTotalCents = payment.refundedAmountCents;
    }
    // #4162 (`INV-ADDPAY-021`): never below a bank-transfer payment's own refund detail; less is alerted, not applied.
    effectiveRefundedTotalCents = await floorBankTransferRefundedTotal({ payment, xeroDerivedCents: effectiveRefundedTotalCents, creditNoteId: input.creditNoteId, creditNoteNumber: input.creditNote.creditNoteNumber ?? null, format });
    // #3653 (`INV-PAY-114`): a Xero note never raises an organiser child's cash
    // mirror past the refunds Stripe recorded for it.
    if (isStripePayment && payment.booking.organiserSettled) {
      effectiveRefundedTotalCents = await capOrganiserChildMirrorAtStripeRefunds(prisma, payment, effectiveRefundedTotalCents);
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
    if (
      nextStatus === PaymentStatus.SUCCEEDED &&
      (payment.status === PaymentStatus.REFUNDED ||
        payment.status === PaymentStatus.PARTIALLY_REFUNDED)
    ) {
      // #3979 (`INV-PAY-126`): a refunded total falling to nothing on a payment
      // nothing was ever captured on undoes an older fold (an invoice correction
      // counted as a refund), never a refund given back: the payment returns to
      // its uncaptured state, never to SUCCEEDED. An organiser-settled child is
      // the #3653 mirror's, and a payment with no rows keeps today's answer.
      if (!payment.booking.organiserSettled) {
        nextStatus = (await uncapturedPrimaryStatus(payment.id)) ?? nextStatus;
      }
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

    // #3979: a claim on the row as read, so a concurrent writer is never
    // overwritten with a figure derived from the row before it wrote. The
    // inbound settle touches the payment at every transition, even when it
    // keeps the stored figure and leaves status and refunded total alone, so
    // `updatedAt` is what catches it.
    const asRead = { id: payment.id, status: payment.status, refundedAmountCents: payment.refundedAmountCents, amountCents: payment.amountCents, updatedAt: payment.updatedAt };
    if (!currentNoteRows.has(payment.id)) {
      if (Object.keys(updates).length === 0) return "unchanged";
      return (await prisma.payment.updateMany({ where: asRead, data: updates })).count === 1 ? "updated" : "lost";
    }
    // #4288: with the note's own refund-note row on this payment, decide under the Payment row lock - the claim alone cannot
    // see a void's link write - re-reading that row there (a plain read; no provider call, no other lock). It no longer
    // counting writes nothing ("recount"); an unchanged verdict also checks the row as read, so a recount that waited on this
    // lock sees the write it waited for. Every outcome is then some serial order of the claim and the void. The budget is
    // the Payment row's (`PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS`), not Prisma's 2s/5s: the nightly bank-void follow-up holds it for up to 30s.
    return prisma.$transaction(async (tx) => {
      await lockPaymentForRefundedTotal(tx, payment.id);
      const now = input.creditNoteId === null ? undefined : (await readRefundNoteRowsByPayment(input.creditNoteId, [payment.id], tx)).get(payment.id);
      if (includesCurrentCreditNoteContribution(payment.id) && !(now && includesCurrentCreditNoteContribution(payment.id, now))) return "recount" as const;
      if (Object.keys(updates).length === 0) return (await tx.payment.findFirst({ where: asRead, select: { id: true } })) ? ("unchanged" as const) : ("lost" as const);
      return (await tx.payment.updateMany({ where: asRead, data: updates })).count === 1 ? ("updated" as const) : ("lost" as const);
    }, PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS);
  };

  const lostPaymentIds: string[] = [];
  let unsettledPaymentIds: string[] = [];
  for (const payment of payments) {
    const outcome = await repairOne(payment);
    if (outcome === "updated") updatedPayments += 1; // #4288: a "recount" wrote nothing; its retry counts its own write
    if (outcome === "lost" || outcome === "recount") lostPaymentIds.push(payment.id);
  }

  // One retry at most, for a lost claim or (#4288) a counted note that no longer counts; a second fails the inbound event, retried after its backoff (#4095).
  if (lostPaymentIds.length > 0) {
    if (input.retryPaymentIds) {
      logger.warn(
        { creditNoteId: input.creditNoteId, paymentIds: lostPaymentIds },
        "Refunded-payment repair lost its claim twice to a concurrent writer; the caller fails its event so it is retried (#3979, #4095)"
      );
      unsettledPaymentIds = lostPaymentIds;
    } else {
      // Decide once more from scratch for those payments: every input is read
      // again - the rows, the links, which notes count, and the current note's
      // own contribution - from what the other writer left (#3979).
      const amounts = input.recomputeModificationRefundAmounts
        ? await input.recomputeModificationRefundAmounts()
        : input.modificationRefundAmountsByPaymentId;
      const retry = await repairRefundedPaymentBusinessState({
        ...input,
        modificationRefundAmountsByPaymentId: new Map(
          [...amounts].filter(([paymentId]) => lostPaymentIds.includes(paymentId)),
        ),
        retryPaymentIds: lostPaymentIds,
      });
      updatedPayments += retry.updatedPayments;
      unsettledPaymentIds = retry.unsettledPaymentIds ?? [];
    }
  }

  return { matchedPayments: payments.length, updatedPayments, ...(unsettledPaymentIds.length > 0 ? { unsettledPaymentIds } : {}) };
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
  // Resolve once before the per-target transaction and credit-ledger lock.
  const format = await getClubFormat();
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

  // #3792: provider allocation changes the guard below refused to post to a
  // restored booking's member ledger, recorded and alerted after their
  // transaction commits (the alert reads EmailLog and sends mail).
  const restoredBookingAllocationChanges: {
    bookingId: string;
    memberId: string;
    invoiceId: string;
    direction: "reduced" | "increased";
    refusedCents: number;
    restoredCents: number;
  }[] = [];

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
    // also interleave and transiently under-set creditAppliedCents; the write
    // is the ledger's applied total, read under the lock (invariant (b),(d),
    // #1234; #3836). DB-only work: no external Xero call runs inside this transaction.
    await prisma.$transaction(async (tx) => {
      const creditLedgerMemberId = bookingOwner(payment.booking).memberId;
      // #3369: this whole repair is about a MEMBER's applied credit — the
      // ledger rows, the per-member lock that serialises them against the
      // spend engine, and the `creditAppliedCents` they sum to. An
      // organisation-owned booking has no member ledger, so there is nothing
      // here to repair and no key to take. Skipping is the answer, not a
      // branch inside one: a null advisory key would degenerate to a shared
      // key, which is an `INV-LOCK` hazard visible only under concurrency.
      if (!creditLedgerMemberId) return;
      await lockMemberCreditLedger(creditLedgerMemberId, tx);
      await assertNoAppliedCreditDeallocationFence(payment.id, tx);
      // #3792 (INV-PAY-019): a cancelled booking whose applied credit was
      // already given back has a restore row (`restoredFromBookingId`, written
      // only by restoreCreditFromBooking, on every cancel path). Its member
      // ledger is settled: a provider allocation change must neither credit
      // the member again (paid twice) nor debit them (charged for a cancelled
      // stay). Every BOOKING_APPLIED amount write below is refused for it and
      // an operator is alerted instead. A live booking has no restore row, so
      // a genuine Xero change still reaches the member's ledger.
      const restoredFromThisBooking = await tx.memberCredit.findUnique({
        where: { restoredFromBookingId: payment.bookingId },
        select: { amountCents: true },
      });

      const existingAppliedCredits = await tx.memberCredit.findMany({
        where: {
          memberId: creditLedgerMemberId,
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
          outsideSpendConvergedAt: true,
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

        if (appliedCredit.description !== expectedDescription && appliedCredit.outsideSpendConvergedAt === null) {
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
        // #4219: a row the credit-note convergence wrote keeps the description that says why.
        const staleDescriptions = linkedAppliedCredits.filter((credit) => credit.description !== expectedDescription && credit.outsideSpendConvergedAt === null);
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
        } else if (restoredFromThisBooking === null) {
          await tx.memberCredit.create({
            data: {
              memberId: creditLedgerMemberId,
              amountCents: expectedAmountCents,
              type: CreditType.BOOKING_APPLIED,
              description: expectedDescription,
              appliedToBookingId: payment.bookingId,
              xeroCreditNoteId: creditNoteId,
            },
          });
          await syncBookingLedgerCredits({ bookingId: payment.bookingId, store: tx });
          createdAppliedCredits += 1;
        }
      }

      await repairLegacyAppliedCreditNoteAllocationsForBooking(
        payment.bookingId,
        target.invoiceId,
        tx,
        format,
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
            memberId: creditLedgerMemberId,
            appliedToBookingId: payment.bookingId,
            type: CreditType.BOOKING_APPLIED,
            xeroCreditNoteId: null,
          },
          _sum: { amountCents: true },
        }),
        tx.memberCredit.aggregate({
          where: {
            memberId: creditLedgerMemberId,
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
      // #3792: the restored booking's ledger takes neither direction (above).
      if (restoredFromThisBooking && ledgerDeltaCents !== 0) {
        skippedAllocations += 1;
        restoredBookingAllocationChanges.push({
          bookingId: payment.bookingId,
          memberId: creditLedgerMemberId,
          invoiceId: target.invoiceId,
          direction: ledgerDeltaCents < 0 ? "reduced" : "increased",
          refusedCents: Math.abs(ledgerDeltaCents),
          restoredCents: restoredFromThisBooking.amountCents,
        });
      } else if (ledgerDeltaCents !== 0) {
        await tx.memberCredit.create({
          data: {
            memberId: creditLedgerMemberId,
            amountCents: -ledgerDeltaCents,
            type: CreditType.BOOKING_APPLIED,
            description: `Xero allocation reconciliation for booking ${payment.bookingId.slice(0, 8)}`,
            appliedToBookingId: payment.bookingId,
            xeroCreditNoteId: creditNoteId,
          },
        });
        await syncBookingLedgerCredits({ bookingId: payment.bookingId, store: tx });
        if (ledgerDeltaCents > 0) createdAppliedCredits += 1;
        else updatedAppliedCredits += 1;
      }

      const aggregate = await tx.memberCredit.aggregate({
        where: {
          memberId: creditLedgerMemberId,
          appliedToBookingId: payment.bookingId,
          type: CreditType.BOOKING_APPLIED,
        },
        _sum: {
          amountCents: true,
        },
      });
      // #3836: the ledger's figure, uncapped. A cap at the card amount zeroed a
      // credit-only booking's mirror and clipped a card-and-credit one's; a cap
      // at the booking's worth cut a booking reduced before #3809, which keeps
      // all its credit at a cancel (owner decision, 4 Oct 2026). The worth cap
      // belongs to the cancel alone, for #3809's bookings
      // (`cancelAppliedCreditBaseCents`).
      const appliedCreditTotalCents = Math.max(-(aggregate._sum.amountCents ?? 0), 0);

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

  for (const refused of restoredBookingAllocationChanges) {
    // A tiered restore gave back less than was applied: say what WAS restored.
    const tieredRestore = refused.direction === "reduced" && refused.refusedCents > refused.restoredCents;
    const errorMessage = `Credit note ${creditNoteId}'s allocation to invoice ${refused.invoiceId} was ${refused.direction} in Xero by ${formatCents(refused.refusedCents, format)}, but booking ${refused.bookingId} is cancelled and ${tieredRestore ? `the credit restored to the member was ${formatCents(refused.restoredCents, format)}` : `its applied credit (${formatCents(refused.restoredCents, format)}) was already restored to the member`}. The member's balance was left as it is: ${refused.direction === "reduced" ? "crediting it would pay the member twice" : "debiting it would charge the member for a cancelled booking"}.${tieredRestore ? ` ${formatCents(refused.refusedCents - refused.restoredCents, format)} of this is beyond what was restored (the cancellation fee); grant it by hand if the waiver was intended.` : ""} Check the credit note and the member's balance in Xero; adjust by hand only if they disagree.`;
    logger.warn(
      { creditNoteId, ...refused },
      "Refused to post a Xero applied-credit allocation change to a cancelled booking whose applied credit was already restored (#3792)",
    );
    await recordRestoredBookingAllocationRefusal(creditNoteId, refused, errorMessage);
    await notifyXeroSyncError({
      errorType: RESTORED_BOOKING_ALLOCATION_CHANGE_ERROR_TYPE,
      operation: `inbound-applied-credit-repair:${creditNoteId}`,
      errorMessage,
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
