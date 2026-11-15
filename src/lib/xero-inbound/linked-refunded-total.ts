/**
 * THE REFUNDED TOTAL A PAYMENT'S LINKS RECORD (#4449, `INV-PAY-126`): its
 * refund and account credit notes, the modification notes allocated to it or
 * to its invoice, and its refund requests' paid-back cash, read on the
 * caller's client. The one decision behind every writer of a bank-transfer
 * payment's refunded total from Xero: the inbound credit-note recount
 * (`repairRefundedPaymentBusinessState`, which adds the note being synced),
 * the kept settle (`decideInternetBankingReceiptFigure`) and the note sync's
 * allocation write (`writeCurrentCreditNoteAllocation`), the last two inside
 * their own locked transactions. It writes nothing and takes no lock; callers
 * clamp and floor what it returns.
 */
import { PaymentSource, PaymentTransactionKind, type PaymentStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { type CreditNoteAllocationCents, getJsonRecord, getRefundContributionCentsFromCreditNoteMetadata, sumAppliedCentsByCreditNote } from "./amounts";
import { isIncludedRefundCreditNoteStatus } from "@/lib/xero-refund-note-status";
import { invoiceCorrectionNoteIds, noCashModificationNoteIds } from "./account-credit-modification-notes";
import { readRefundRequestPaidBackCentsByPaymentId } from "./refund-request-paid-back";
import { receiptCountsInvoiceCorrections } from "./ib-receipt-reasons";
import { CLEARING_ALLOCATION_LINK_WHERE, distinctClearingAllocations, NOTE_ALLOCATION_ROLE } from "@/lib/xero-clearing-allocations";

type Store = Prisma.TransactionClient;

/** A payment's rows as `receiptCountsInvoiceCorrections` reads them. */
export type ReceiptRow = { kind: PaymentTransactionKind; source: PaymentSource; status: PaymentStatus; reason: string | null };

/**
 * #3979 (`INV-PAY-126`): of these payments, those an invoice correction still
 * counts against (`receiptCountsInvoiceCorrections`). `rowsOverride` stands in
 * for a payment's rows as a writer is about to leave them (the kept settle's
 * receipt, captured later in its transaction).
 */
export async function paymentsCountingInvoiceCorrections(
  paymentIds: string[],
  store: Store = prisma,
  rowsOverride?: ReadonlyMap<string, readonly ReceiptRow[]>,
): Promise<Set<string>> {
  const readIds = paymentIds.filter((paymentId) => !rowsOverride?.has(paymentId));
  const rows =
    readIds.length === 0
      ? []
      : await store.paymentTransaction.findMany({
          where: { paymentId: { in: readIds }, kind: PaymentTransactionKind.PRIMARY },
          select: { paymentId: true, kind: true, source: true, status: true, reason: true },
        });
  return new Set(
    paymentIds.filter((paymentId) =>
      receiptCountsInvoiceCorrections(rowsOverride?.get(paymentId) ?? rows.filter((row) => row.paymentId === paymentId)),
    ),
  );
}

/**
 * Each payment's refunded total as its links record it, before any clamp or
 * floor: its direct refund and account notes, each modification note applied
 * to it or (#3979) to its bank-transfer invoice once (`distinctClearingAllocations`,
 * summed per note by `sumAppliedCentsByCreditNote`) that moved cash, or is an
 * invoice correction against a receipt still at the stored figure, and (#4215,
 * `INV-PAY-118`) its refund requests' paid-back cash. `excludeCreditNoteId` is
 * the note a recount is syncing, which it adds itself.
 */
export async function decideLinkedRefundedTotalCents(
  store: Store,
  payments: ReadonlyArray<{ id: string; source: PaymentSource; xeroInvoiceId: string | null }>,
  options: { excludeCreditNoteId?: string | null; transactionRowsOverride?: ReadonlyMap<string, readonly ReceiptRow[]> } = {},
): Promise<Map<string, number>> {
  const paymentIds = payments.map((payment) => payment.id);
  const excluded = options.excludeCreditNoteId ?? null;
  // #4215: requests' paid-back cash, read AFTER the payment rows the caller holds.
  const [directRefundLinks, modificationAllocationLinks, refundRequestPaidBackCentsByPaymentId] = await Promise.all([
    store.xeroObjectLink.findMany({
      where: {
        localModel: "Payment",
        localId: { in: paymentIds },
        xeroObjectType: "CREDIT_NOTE",
        role: { in: ["REFUND_CREDIT_NOTE", "ACCOUNT_CREDIT_NOTE"] },
        active: true,
      },
      select: { localId: true, xeroObjectId: true, metadata: true },
    }),
    // The note's own role only: a payment's role-less links mirror its refund and account notes (#4786).
    store.xeroObjectLink.findMany({
      where: { localModel: "Payment", localId: { in: paymentIds }, xeroObjectType: "ALLOCATION", role: NOTE_ALLOCATION_ROLE, active: true },
      select: { localId: true, xeroObjectId: true, role: true, metadata: true, updatedAt: true },
    }),
    readRefundRequestPaidBackCentsByPaymentId(paymentIds, store),
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
  // #4786: by invoice, also a role-less link an older repair wrote on the note's anchor.
  const invoiceAllocationLinks =
    invoicePaymentIds.size === 0
      ? []
      : await store.xeroObjectLink.findMany({
          where: {
            xeroObjectType: "ALLOCATION",
            active: true,
            AND: [
              CLEARING_ALLOCATION_LINK_WHERE,
              { OR: [...invoicePaymentIds.keys()].map((invoiceId) => ({ metadata: { path: ["invoiceId"], equals: invoiceId } })) },
            ],
          },
          select: { localId: true, xeroObjectId: true, role: true, metadata: true, updatedAt: true },
        });
  // #4095 (L1), #4786: each payment's links read as what each note applied to
  // each invoice, once (`distinctClearingAllocations`): per note and invoice
  // the newest own-role link with a positive amount, else the newest
  // role-less one, so the same allocation linked to several local objects, a
  // role-less link beside the mirror's, or an older amount left active beside
  // a re-synced one never counts twice.
  const linksByPaymentId = new Map<string, Array<(typeof modificationAllocationLinks)[number]>>();
  for (const { paymentId, link } of [
    ...modificationAllocationLinks.map((link) => ({ paymentId: link.localId, link })),
    ...invoiceAllocationLinks.flatMap((link) => {
      const invoiceId = getJsonRecord(link.metadata)?.invoiceId;
      const paymentId = typeof invoiceId === "string" ? invoicePaymentIds.get(invoiceId) : undefined;
      return paymentId ? [{ paymentId, link }] : [];
    }),
  ]) {
    linksByPaymentId.set(paymentId, [...(linksByPaymentId.get(paymentId) ?? []), link]);
  }
  const existingModificationAllocations = [...linksByPaymentId].flatMap(([paymentId, links]) =>
    distinctClearingAllocations(links, { requireAmount: true }).map((allocation) => ({ ...allocation, paymentId })),
  );
  const existingModificationCreditNoteIds = [
    ...new Set(existingModificationAllocations.map((allocation) => allocation.creditNoteId).filter((id) => id !== excluded)),
  ];
  const validModificationCreditNoteIds = new Set<string>();
  const validCorrectionNoteIds = new Set<string>();

  if (existingModificationCreditNoteIds.length > 0) {
    const modificationCreditNotes = await store.xeroObjectLink.findMany({
      where: {
        xeroObjectType: "CREDIT_NOTE",
        role: "MODIFICATION_CREDIT_NOTE",
        xeroObjectId: { in: existingModificationCreditNoteIds },
        active: true,
      },
      select: { xeroObjectId: true, metadata: true },
    });

    // #3809 (review M2), #3954: a give-back or billed-offset note moved no cash.
    // #3979: nor did an invoice correction, but it is counted against a payment
    // whose bank receipt was recorded at the stored figure.
    const [noCashNoteIds, correctionNoteIds] = await Promise.all([
      noCashModificationNoteIds(existingModificationCreditNoteIds, store),
      invoiceCorrectionNoteIds(existingModificationCreditNoteIds, store),
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
    validCorrectionNoteIds.size > 0
      ? await paymentsCountingInvoiceCorrections(paymentIds, store, options.transactionRowsOverride)
      : new Set<string>();

  const linkedCents = new Map(paymentIds.map((paymentId) => [paymentId, refundRequestPaidBackCentsByPaymentId.get(paymentId) ?? 0]));
  const add = (paymentId: string, cents: number) => linkedCents.set(paymentId, (linkedCents.get(paymentId) ?? 0) + cents);

  const directRefundCentsByPaymentId = new Map<string, Map<string, number>>();
  for (const link of directRefundLinks) {
    if (link.xeroObjectId === excluded) continue;
    const contributionCents = getRefundContributionCentsFromCreditNoteMetadata(link.metadata);
    if (contributionCents === null) continue;
    const paymentRefunds = directRefundCentsByPaymentId.get(link.localId) ?? new Map<string, number>();
    paymentRefunds.set(link.xeroObjectId, contributionCents);
    directRefundCentsByPaymentId.set(link.localId, paymentRefunds);
  }
  for (const [paymentId, refunds] of directRefundCentsByPaymentId) {
    for (const cents of refunds.values()) add(paymentId, cents);
  }

  // #4095 (L1): a note's applications to a payment's invoices (one each, read
  // above), summed per note by the rule the kept settle applies
  // (`sumAppliedCentsByCreditNote`).
  const modificationAllocationsByPaymentId = new Map<string, CreditNoteAllocationCents[]>();
  for (const { creditNoteId, paymentId, amountCents } of existingModificationAllocations) {
    if (creditNoteId === excluded) continue;
    if (
      !validModificationCreditNoteIds.has(creditNoteId) &&
      !(validCorrectionNoteIds.has(creditNoteId) && paymentsCountingCorrections.has(paymentId))
    ) {
      continue;
    }
    if (amountCents === null) continue; // `requireAmount` above leaves none
    modificationAllocationsByPaymentId.set(paymentId, [
      ...(modificationAllocationsByPaymentId.get(paymentId) ?? []),
      { creditNoteId, appliedCents: Math.round(amountCents) },
    ]);
  }
  for (const [paymentId, allocations] of modificationAllocationsByPaymentId) {
    for (const cents of sumAppliedCentsByCreditNote(allocations).values()) add(paymentId, cents);
  }
  return linkedCents;
}
