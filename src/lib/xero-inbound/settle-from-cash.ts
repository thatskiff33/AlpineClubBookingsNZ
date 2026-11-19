/**
 * SETTLE A BANK TRANSFER FROM THE CASH ITS INVOICE COLLECTED (#3979,
 * `INV-PAY-125`).
 *
 * When Xero reports a booking's PRIMARY invoice paid, the inbound settle
 * (`invoice-paid-effects.ts`) records the bank receipt. Before #3979 it kept the
 * figure the PRIMARY `PaymentTransaction` and `Payment.amountCents` were born
 * with, when the Internet Banking payment was first written. No edit path
 * rewrites either one, so an unpaid booking re-priced before its invoice was
 * raised was settled at its OLD price: the ledger's bank receipt was wrong, and
 * so was every refund and credit cap that reads the payment.
 *
 * Owner decision, 13 Oct 2026 (#3979): the receipt is the cash the paid invoice
 * actually collected (`quantifyXeroInvoiceCashCents`), not the amount the booking
 * owes. A price raised after the invoice is billed on a supplementary invoice,
 * which this invoice never collected, so the amount owed would overstate it.
 *
 * This module decides, from the rows the settle reads under its locks and the
 * paid invoice it already holds, whether that figure may be written. The settle
 * writes it; this module writes nothing and takes no lock. What the operators
 * are told lives in `settle-from-cash-notice.ts`.
 */
import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import type { Invoice } from "xero-node";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import {
  deriveAggregatePaymentStatus,
  grossCapturedCents,
  isCapturedTransactionStatus,
} from "@/lib/payment-transaction-status";
import { readModificationNoteCash } from "@/lib/xero-inbound/account-credit-modification-notes";
import { type CreditNoteAllocationCents, sumAppliedCentsByCreditNote } from "@/lib/xero-inbound/amounts";
import type { IbSettlementKeptReason } from "@/lib/ib-settlement-figure-note";
import { IB_RECEIPT_FROM_CASH_REASON, IB_RECEIPT_KEPT_REASON, isInternetBankingPrimary } from "./ib-receipt-reasons";
import { decideLinkedRefundedTotalCents } from "./linked-refunded-total";
import { type BankTransferFloorAlert } from "./credit-note-bank-transfer-floor";
import { decideXeroRefundedColumns } from "./xero-refunded-columns";

/** The paid invoice's cash, as `quantifyXeroInvoiceCashCents` measures it. */
export type InvoiceCash = { knownCents: number; complete: boolean };

/**
 * Why a settle kept the stored figure instead of the invoice's cash: the
 * reasons its alert words (`IbSettlementKeptReason`, with that wording), and a
 * second instrument (#3638), whose own alert speaks for it.
 *
 * - `refund-note-applied`: a modification credit note worded as a refund is
 *   applied to the invoice; the note sync counts it as refunded whenever it
 *   runs, so writing the cash (which already leaves it out) would count the
 *   reduction twice.
 * - `folded-refund`: the refunded total holds money no row records (an older
 *   note folded into it) that the invoice's no-cash notes do not exactly explain.
 */
export type CashSettlementRefusal = IbSettlementKeptReason | "second-instrument";

export type CashSettlementPlan =
  /** The PRIMARY receipt was already captured: a replay, which decides no amount again. */
  | { kind: "replay" }
  /**
   * The receipt is the cash. The payment's columns are what
   * `reconcilePaymentAggregates` projects from the same rows with the receipt
   * captured at the cash: its figure the cash plus whatever else is captured on
   * it (a card capture refunded before the switch, #1765), its refunded total
   * the rows' own (an older correction folded into it, exactly explained by the
   * invoice's no-cash notes, comes off), and its status from both.
   */
  | {
      kind: "rewrite";
      receiptCents: number;
      paymentAmountCents: number;
      refundedAmountCents: number;
      status: PaymentStatus;
    }
  | { kind: "keep"; reason: CashSettlementRefusal };

export type CashSettlementTransaction = {
  kind: PaymentTransactionKind;
  source: PaymentSource;
  status: PaymentStatus;
  amountCents: number;
  refundedAmountCents: number;
};

/**
 * The one decision (`INV-PAY-125`). It is taken only at the TRANSITION, while
 * no Internet Banking PRIMARY row of the payment is captured; a replay keeps
 * whatever the first settle wrote. The cash is written only when it is a
 * complete, positive figure that belongs to this payment alone: exactly one
 * matched payment, no refund-worded modification note applied to the invoice,
 * no folded refund the invoice's no-cash notes do not exactly explain, at most
 * one uncaptured Internet Banking PRIMARY row, and no second instrument.
 */
export function planInternetBankingCashSettlement(input: {
  refundedAmountCents: number;
  transactions: readonly CashSettlementTransaction[];
  cash: InvoiceCash;
  matchedPayments: number;
  secondInstrument: boolean;
  /** Modification notes applied to the invoice: worded as refunds, and moving no cash. */
  appliedNotes: { refundWordedCents: number; noCashCents: number };
}): CashSettlementPlan {
  const primaryRows = input.transactions.filter(isInternetBankingPrimary);
  if (primaryRows.some((row) => isCapturedTransactionStatus(row.status))) {
    return { kind: "replay" };
  }
  if (input.secondInstrument) return { kind: "keep", reason: "second-instrument" };
  if (!input.cash.complete) return { kind: "keep", reason: "cash-incomplete" };
  if (input.cash.knownCents <= 0) return { kind: "keep", reason: "cash-zero" };
  if (input.matchedPayments !== 1) return { kind: "keep", reason: "several-payments" };
  if (input.appliedNotes.refundWordedCents > 0) return { kind: "keep", reason: "refund-note-applied" };
  const ledgerRefundedCents = input.transactions.reduce((sum, row) => sum + row.refundedAmountCents, 0);
  const foldedCents = input.refundedAmountCents - ledgerRefundedCents;
  if (foldedCents > 0 && foldedCents !== input.appliedNotes.noCashCents) {
    return { kind: "keep", reason: "folded-refund" };
  }
  if (primaryRows.length > 1) return { kind: "keep", reason: "several-primary-rows" };
  const paymentAmountCents =
    input.cash.knownCents + grossCapturedCents(input.transactions.filter((row) => !isInternetBankingPrimary(row)));
  return {
    kind: "rewrite",
    receiptCents: input.cash.knownCents,
    paymentAmountCents,
    refundedAmountCents: ledgerRefundedCents,
    status: deriveAggregatePaymentStatus(
      PaymentStatus.SUCCEEDED,
      paymentAmountCents,
      ledgerRefundedCents,
      PaymentStatus.SUCCEEDED,
    ),
  };
}

/** A credit note Xero lists as applied to the paid invoice. */
export type AppliedCreditNote = { id: string; appliedCents: number };

/** What the paid invoice says, beyond its cash. */
export type PaidInvoiceFacts = {
  /** The invoice's total, or null when the payload carries none. */
  totalCents: number | null;
  appliedCreditNotes: readonly AppliedCreditNote[];
};

/** The paid invoice's total and the credit notes it lists as applied, in cents. */
export function paidInvoiceFacts(invoice: Pick<Invoice, "total" | "creditNotes">): PaidInvoiceFacts {
  return {
    totalCents: providerAmountToCents(invoice.total),
    appliedCreditNotes: (invoice.creditNotes ?? []).flatMap((note) => {
      const appliedCents = providerAmountToCents(note.appliedAmount);
      return note.creditNoteID && appliedCents !== null && appliedCents > 0
        ? [{ id: note.creditNoteID, appliedCents }]
        : [];
    }),
  };
}

/**
 * #4449 (`INV-PAY-126`): the whole refunded total a KEEP leaves on the payment,
 * decided in the settle's own transaction from every link it reads there
 * (`decideLinkedRefundedTotalCents`), with the receipt as the keep captures it.
 * That receipt holds the stored figure, which still includes each invoice
 * correction, so every correction already synced counts now, as the note's
 * own sync would count it against that receipt, and a refunded total the rows
 * do not record (a refund note folded into it) is the links' too: a writer
 * queued on the settle's locks (a cancel on `lock(1)`) reads the net the cash
 * supports. A correction whose allocation the note sync writes while the
 * settle runs waits on the Payment row the settle holds, and its sync decides
 * the total again after this commit (`writeCurrentCreditNoteAllocation`). The
 * bank-transfer floor applies (`INV-ADDPAY-021`); its alert waits for the commit,
 * and goes out only when the keep moves the stored total.
 */
async function keptRefundedTotal(
  tx: Prisma.TransactionClient,
  input: {
    invoiceId: string;
    payment: { id: string; bookingId: string; amountCents: number; refundedAmountCents: number };
    rows: ReadonlyArray<CashSettlementTransaction & { reason: string | null }>;
  },
): Promise<{ refundedAmountCents: number; status: PaymentStatus; floorAlert: BankTransferFloorAlert | null }> {
  const { payment } = input;
  // The receipt as the keep captures it: every uncaptured bank-transfer PRIMARY
  // row SUCCEEDED, or one created when there is none.
  const capturedRows = input.rows.some(isInternetBankingPrimary)
    ? input.rows.map((row) => (isInternetBankingPrimary(row) ? { ...row, status: PaymentStatus.SUCCEEDED } : row))
    : [
        ...input.rows,
        { kind: PaymentTransactionKind.PRIMARY, source: PaymentSource.INTERNET_BANKING, status: PaymentStatus.SUCCEEDED, reason: IB_RECEIPT_KEPT_REASON },
      ];
  const linked = await decideLinkedRefundedTotalCents(
    tx,
    [{ ...payment, source: PaymentSource.INTERNET_BANKING, xeroInvoiceId: input.invoiceId }],
    { transactionRowsOverride: new Map([[payment.id, capturedRows]]) },
  );
  // #4449 (`INV-SSOT`): the clamp, floor and status step every writer from Xero takes, from the status
  // the keep leaves the payment in: captured, so SUCCEEDED before any refund.
  const decided = await decideXeroRefundedColumns(tx, {
    payment: { ...payment, source: PaymentSource.INTERNET_BANKING, status: PaymentStatus.SUCCEEDED, booking: { organiserSettled: false } },
    decidedCents: linked.get(payment.id) ?? 0,
    creditNoteId: null,
  });
  // A keep that leaves the stored total where it was alerts nothing (as before #4449): a refund on
  // record whose note is still in the outbox is not a shortfall in Xero. A keep that moves the
  // total and is held at the floor does alert.
  const moved = decided.refundedAmountCents !== payment.refundedAmountCents;
  return { refundedAmountCents: decided.refundedAmountCents, status: decided.status ?? PaymentStatus.SUCCEEDED, floorAlert: moved ? decided.floorAlert : null };
}

/**
 * The settle's one call, inside its locked transaction after both fences
 * (`INV-PAY-125`): the payment's rows, the plan, the receipt and the payment's
 * columns to write, and the invoice-side figure the cancel arms report a mixed
 * invoice against.
 */
export async function decideInternetBankingReceiptFigure(
  tx: Prisma.TransactionClient,
  input: {
    /** The paid invoice: a keep decides the refunded total its links record, by this invoice too (#4449). */
    invoiceId: string;
    payment: { id: string; bookingId: string; amountCents: number; refundedAmountCents: number };
    cash: InvoiceCash;
    matchedPayments: number;
    secondInstrument: boolean;
    invoice: PaidInvoiceFacts;
  },
): Promise<{
  plan: CashSettlementPlan;
  /** The receipt's figure: the cash, or the stored receipt's when kept. */
  receiptCents: number;
  /** What the PRIMARY row update adds: the cash marker, and the amount where it differs. */
  primaryRowWrite: { amountCents?: number; reason?: string };
  /**
   * The payment's columns when the plan rewrote them, or when a keep's whole
   * refunded total (#4449, `keptRefundedTotal`) differs from the stored one
   * (its figure unchanged); else null.
   */
  paymentColumns: { amountCents: number; refundedAmountCents: number; status: PaymentStatus } | null;
  /** A keep's bank-transfer floor alert (`INV-ADDPAY-021`), for the settle to send after its commit. */
  floorAlert: BankTransferFloorAlert | null;
  /**
   * The cash the invoice expected - its total less the member's own account
   * credit and the correction and no-cash notes applied to it - when the cash
   * came short of it: the rest was cleared some other way (a write-off, a
   * clearing note) and an operator should know (#1459). Null when the cash
   * covers it.
   */
  mixedInvoiceExpectedCents: number | null;
  /**
   * Whether a cancel arm's mint (`resolveMintableCents`) credits only part of
   * the cash a full payment brings - the receipt, or less when the invoice
   * expected less (applied corrections and no-cash notes, #4095 item 2) - or
   * the invoice is mixed. The one rule both cancel arms apply (`INV-SSOT`).
   */
  isPartPayment: (mint: { mintableCents: number; mintPartial: boolean }) => boolean;
  /**
   * The invoice-correction notes applied to the invoice, one per note with its
   * applied amounts summed (`sumAppliedCentsByCreditNote`: a note allocated
   * twice counts whole), for the recount after a kept settle (#4095); none
   * when several payments match it.
   */
  appliedCorrectionNotes: AppliedCreditNote[];
}> {
  const { payment } = input;
  const rows = await tx.paymentTransaction.findMany({
    where: { paymentId: payment.id },
    select: { kind: true, source: true, status: true, amountCents: true, refundedAmountCents: true, reason: true },
  });
  const noteIds = input.invoice.appliedCreditNotes.map((note) => note.id);
  const [noteCash, memberCreditNotes] =
    noteIds.length === 0
      ? [new Map(), new Set<string>()]
      : await Promise.all([
          readModificationNoteCash(noteIds, tx),
          tx.memberCredit
            .findMany({ where: { xeroCreditNoteId: { in: noteIds } }, select: { xeroCreditNoteId: true } })
            .then((credits) => new Set(credits.map((credit) => credit.xeroCreditNoteId))),
        ]);
  let refundWordedCents = 0;
  let noCashCents = 0;
  let memberCreditCents = 0;
  const appliedCorrections: CreditNoteAllocationCents[] = [];
  for (const note of input.invoice.appliedCreditNotes) {
    // The member's own account credit first (#3979 final review): an edit's
    // credit kept as account credit on ANOTHER booking is a modification
    // account-credit note, but applied here it is this booking's credit.
    if (memberCreditNotes.has(note.id)) {
      memberCreditCents += note.appliedCents;
      continue;
    }
    const kind = noteCash.get(note.id);
    if (kind === "refund") refundWordedCents += note.appliedCents;
    else if (kind) noCashCents += note.appliedCents;
    // Each entry the invoice lists is one application of its note.
    if (kind === "correction") appliedCorrections.push({ creditNoteId: note.id, appliedCents: note.appliedCents });
  }
  // On an invoice matched to several payments no payment's share of a
  // correction is known, as the note's own sync finds (one payment per invoice).
  const appliedCorrectionNotes: AppliedCreditNote[] =
    input.matchedPayments === 1
      ? [...sumAppliedCentsByCreditNote(appliedCorrections)].map(([id, appliedCents]) => ({ id, appliedCents }))
      : [];

  const plan = planInternetBankingCashSettlement({
    refundedAmountCents: payment.refundedAmountCents,
    transactions: rows,
    cash: input.cash,
    matchedPayments: input.matchedPayments,
    secondInstrument: input.secondInstrument,
    appliedNotes: { refundWordedCents, noCashCents },
  });
  const uncapturedPrimary = rows.filter(
    (row) => isInternetBankingPrimary(row) && !isCapturedTransactionStatus(row.status),
  );
  const [onlyUncapturedPrimary, ...moreUncapturedPrimary] = uncapturedPrimary;
  const storedReceiptCents =
    onlyUncapturedPrimary && moreUncapturedPrimary.length === 0 ? onlyUncapturedPrimary.amountCents : payment.amountCents;
  const receiptCents = plan.kind === "rewrite" ? plan.receiptCents : storedReceiptCents;

  // An applied correction or give-back note lowered what the invoice asked for
  // and moved no cash, so it is not a part cleared some other way (#4095 item 2).
  const expectedCents =
    input.invoice.totalCents !== null
      ? input.invoice.totalCents - memberCreditCents - noCashCents
      : storedReceiptCents;
  // Only cash that quantified to something can be "part" of the invoice; a
  // figure that read as nothing is the unquantifiable fallback, not a mix.
  const mixedInvoiceExpectedCents =
    input.cash.knownCents > 0 && input.cash.knownCents < expectedCents ? expectedCents : null;
  const partialFaceCents = Math.min(receiptCents, expectedCents);
  const isPartPayment = (mint: { mintableCents: number; mintPartial: boolean }) =>
    (mint.mintPartial && mint.mintableCents < partialFaceCents) || mixedInvoiceExpectedCents !== null;

  if (plan.kind !== "rewrite") {
    // On an invoice matched to several payments no payment's share of a
    // correction is known, so a keep there leaves the stored total.
    const kept =
      plan.kind === "keep" && input.matchedPayments === 1
        ? await keptRefundedTotal(tx, { invoiceId: input.invoiceId, payment, rows })
        : null;
    const paymentColumns =
      kept && kept.refundedAmountCents !== payment.refundedAmountCents
        ? {
            amountCents: payment.amountCents,
            refundedAmountCents: kept.refundedAmountCents,
            status: kept.status,
          }
        : null;
    return { plan, receiptCents, primaryRowWrite: {}, paymentColumns, floorAlert: kept?.floorAlert ?? null, mixedInvoiceExpectedCents, isPartPayment, appliedCorrectionNotes };
  }
  const primaryDiffers = uncapturedPrimary.some((row) => row.amountCents !== plan.receiptCents);
  return {
    plan,
    receiptCents,
    primaryRowWrite: {
      reason: IB_RECEIPT_FROM_CASH_REASON,
      ...(primaryDiffers ? { amountCents: plan.receiptCents } : {}),
    },
    paymentColumns: {
      amountCents: plan.paymentAmountCents,
      refundedAmountCents: plan.refundedAmountCents,
      status: plan.status,
    },
    floorAlert: null,
    mixedInvoiceExpectedCents,
    isPartPayment,
    appliedCorrectionNotes,
  };
}
