/**
 * THE SNAPSHOT ONE BOOKING IS JUDGED FROM by the booking-ledger projection
 * census (#3583, `INV-MONEY-037`; design `docs/design/booking-ledger.md` §6):
 * the row shape `booking-ledger-projection-census-store.ts` reads and every
 * census predicate takes. Types only.
 */
import type {
  BookingStatus,
  CreditType,
  LedgerAnchorKind,
  LedgerLineKind,
  LedgerSide,
  ManualRefundTaskDirection,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  SettlementMethod,
} from "@prisma/client";

// ---------------------------------------------------------------------------
// The snapshot one booking is judged from
// ---------------------------------------------------------------------------

export type CensusLedgerLine = {
  id: string;
  side: LedgerSide;
  kind: LedgerLineKind;
  sign: number;
  quantity: number;
  unitCents: number;
  amountCents: number;
  bookingGuestId: string | null;
  nightStart: Date | null;
  nightEndExclusive: Date | null;
  anchorKind: LedgerAnchorKind;
  anchorId: string;
  settlementMethod: SettlementMethod | null;
  reversesLineId: string | null;
  postingKey: string | null;
  postedAt: Date;
};

export type BookingLedgerCensusRow = {
  booking: {
    id: string;
    status: BookingStatus;
    deletedAt: Date | null;
    organiserSettled: boolean;
    finalPriceCents: number;
  };
  payment: {
    id: string;
    source: PaymentSource;
    status: PaymentStatus;
    amountCents: number;
    creditAppliedCents: number;
    refundedAmountCents: number;
    changeFeeCents: number;
    additionalAmountCents: number;
    additionalPaymentStatus: string | null;
    /** #3632's settlement evidence (`INTERNET_BANKING_SETTLEMENT_EVIDENCE_SELECT`). */
    xeroInvoiceId: string | null;
    manuallyMarkedPaidAt: Date | null;
  } | null;
  transactions: ReadonlyArray<{
    id: string;
    kind: PaymentTransactionKind;
    status: PaymentStatus;
    source: PaymentSource;
    xeroInvoiceId: string | null;
    amountCents: number;
    refundedAmountCents: number;
    reason: string | null;
    withdrawnAt: Date | null;
    createdAt: Date;
  }>;
  refunds: ReadonlyArray<{
    id: string;
    status: string;
    amountCents: number;
    paymentTransactionId: string | null;
  }>;
  /** Every `MemberCredit` row applied to or minted from the booking (`member-credit-booking-rows.ts`). */
  credits: ReadonlyArray<{
    id: string;
    type: CreditType;
    amountCents: number;
    sourceBookingId: string | null;
    appliedToBookingId: string | null;
    restoredFromBookingId: string | null;
    description: string;
    xeroCreditNoteId: string | null;
  }>;
  tasks: ReadonlyArray<{
    id: string;
    kind: ManualRefundTaskKind | null;
    status: ManualRefundTaskStatus;
    amountCents: number | null;
    settlementDirection: ManualRefundTaskDirection | null;
    paymentId: string | null;
    lateCaptureApprovalIntentId: string | null;
  }>;
  modifications: ReadonlyArray<{
    id: string;
    modificationType: string;
    priceDiffCents: number;
    changeFeeCents: number;
    createdAt: Date;
    /**
     * A review closure's `PRICE_REBASE` row: the task it re-priced for and the
     * signed movement of the final price it recorded (`newData`). Null on any
     * other row.
     */
    reviewRebase: { taskId: string; movementCents: number } | null;
  }>;
  recoveryOperations: ReadonlyArray<{
    type: PaymentRecoveryOperationType;
    status: PaymentRecoveryOperationStatus;
    amountCents: number;
    idempotencyKey: string;
  }>;
  /**
   * The paid path's CANCELLED event snapshot (`writePaidCancellationEvent`):
   * the refund it decided and, since #3611, the kept figure it froze for the
   * ledger. Null where there is none.
   */
  cancellation: { refundMethod: string | null; settledAmountCents: number | null; keptCents: number | null } | null;
  lines: readonly CensusLedgerLine[];
};
