// Shared types, Prisma selects, and finding/action code tables for the
// booking-vs-Xero repair tool. Extracted verbatim from xero-booking-repair.ts
// as the leaf module of the #1208 item-2 split; the entry re-exports the public
// subset. Import xero source modules directly (no @/lib/xero facade, #1208).
import { Prisma } from "@prisma/client";
import type { XeroOperationRetryMeta } from "@/lib/xero-operation-retry";
import type { PaidAnotherWayXeroNote } from "@/lib/manual-refund-task-settlement-rules";
import type { PaidAnotherWayReceiptState } from "@/lib/xero-kept-late-capture-invoice";

export const XERO_BOOKING_REPAIR_FINDING_CODES = [
  "MISSING_PRIMARY_INVOICE",
  "STALE_PRIMARY_INVOICE_DETAILS",
  "CANCELLED_BOOKING_OPEN_INVOICE",
  "MISSING_SUPPLEMENTARY_INVOICE",
  "MISSING_MODIFICATION_CREDIT_NOTE",
  "MISSING_CREDIT_NOTE_ALLOCATION",
  "MISSING_ACCOUNT_CREDIT_NOTE",
  "CANCELLED_IN_FLIGHT_PAYMENT",
  "LATE_CAPTURE_AFTER_CANCELLATION",
  // #3635: a late capture a treasurer kept on a cancelled booking, whose
  // booking payment Xero has no invoice for.
  "KEPT_LATE_CAPTURE_WITHOUT_XERO_INVOICE",
  // #3635 round-3 R5: a kept capture an officer recorded by hand in Xero was
  // refunded; the app raises no note for it, so an officer records the refund
  // by hand too. Report-only, never actionable.
  "KEPT_LATE_CAPTURE_REFUND_RECORD_BY_HAND",
  // #3924 round 7 (money M2, `INV-PAY-122`): a late capture whose approved
  // refund was closed as paid another way, and whose Xero receipt - which the
  // close's bank-transfer note waits for - failed or was never queued.
  "PAID_ANOTHER_WAY_LATE_CAPTURE_WITHOUT_XERO_RECEIPT",
  // #3924 round 8 (owner, 8 Oct 2026: "Raise a refund note for all"): that
  // close's receipt is in Xero - a change's invoice sent after the close, or
  // a receipt row that failed after its link - and its note was never queued.
  "PAID_ANOTHER_WAY_REFUND_NOTE_NOT_QUEUED",
  "BLOCKED_BY_XERO_OPERATION",
  "XERO_LINK_MISMATCH",
  "XERO_AMOUNT_MISMATCH",
  "MANUAL_REVIEW_REQUIRED",
  // B5 (#2262): informational, never actionable. A cash / off-Xero settlement
  // is PAID with no Xero objects BY DESIGN, so it must not classify as the
  // MISSING_PRIMARY_INVOICE critical finding with its QUEUE_PRIMARY_INVOICE
  // action — that action would mint (and email) an awaiting-payment invoice for
  // money the club already holds.
  "MANUALLY_SETTLED_NO_XERO_EXPECTED",
  // #3635 (orchestrator decision 2): informational, never actionable. An
  // officer resolved the operation in Xero and the club's records hold no
  // document for it: done, never re-run, but still seen.
  "RESOLVED_IN_XERO_BY_OFFICER",
  // #3548: a completed refund-note row whose note has neither its settling
  // payment nor a skip on record, or is part-settled. Never auto-applied.
  "REFUND_CREDIT_NOTE_UNSETTLED",
  // #3836: a credit-only card booking's invoice with its applied credit never
  // allocated (raised before #3836). Queues the one allocation engine.
  "UNALLOCATED_APPLIED_CREDIT",
] as const;

export type XeroBookingRepairFindingCode =
  (typeof XERO_BOOKING_REPAIR_FINDING_CODES)[number];

export const XERO_BOOKING_REPAIR_ACTION_TYPES = [
  "QUEUE_PRIMARY_INVOICE",
  "QUEUE_PRIMARY_INVOICE_UPDATE",
  "QUEUE_SUPPLEMENTARY_INVOICE",
  "QUEUE_MODIFICATION_CREDIT_NOTE",
  "QUEUE_ACCOUNT_CREDIT_NOTE",
  "QUEUE_REFUND_CREDIT_NOTE",
  "QUEUE_CREDIT_NOTE_ALLOCATION",
  "REQUEUE_XERO_OPERATION",
  "SYNC_PAYMENT_PRIMARY_INVOICE_FIELD",
  "SYNC_PAYMENT_PRIMARY_INVOICE_LINK",
  "SYNC_PAYMENT_REFUND_CREDIT_NOTE_FIELD",
  "SYNC_BOOKING_SCOPED_LINK",
  "REPAIR_CANCELLED_IN_FLIGHT_PAYMENT",
  "AUTO_REFUND_LATE_CAPTURED_PAYMENT",
  // #3635: the invoice, paid from Stripe, recording a kept late capture.
  "QUEUE_KEPT_LATE_CAPTURE_INVOICE",
  // #3924 round 8: a paid-another-way close's note, once its receipt is in Xero.
  "QUEUE_PAID_ANOTHER_WAY_REFUND_NOTE",
  // #3548: operator-applied only (`--apply-action`), through the one settle.
  "SETTLE_REFUND_CREDIT_NOTE",
  // #3836: the applied-credit allocation operation, as booking creation queues it.
  "QUEUE_APPLIED_CREDIT_ALLOCATION",
  "MARK_MANUAL_REVIEW",
] as const;

export type XeroBookingRepairActionType =
  (typeof XERO_BOOKING_REPAIR_ACTION_TYPES)[number];

export type XeroBookingRepairSeverity =
  | "critical"
  | "warning"
  | "info"
  | "manual_review";

export type XeroBookingRepairActionStatus =
  | "planned"
  | "applied"
  | "queued"
  | "processed"
  | "skipped"
  | "failed"
  | "manual_review";

export interface BookingXeroRepairScope {
  bookingId?: string;
  /**
   * The first and last club calendar days to sweep, INCLUSIVE, as `yyyy-MM-dd`
   * (#2868, INV-DATE-013).
   *
   * Deliberately NOT `Date`. What the operator types on `--from`/`--to` is a
   * calendar day, and a calendar day is not an instant: turning one into a
   * `Date` requires a zone, and the zone is exactly what nobody supplied. The
   * previous shape held `new Date("2026-07-01T00:00:00")` — midnight in
   * whatever zone the process happened to be pinned to — and
   * `buildScopeWhere` then bound that single value against both a `@db.Date`
   * column and three real instants. Under the deployment's
   * `TZ=Pacific/Auckland` pin that instant is the PREVIOUS UTC day, so the
   * `Booking.checkIn` arm swept `[30 Jun, 30 Jul]` for a requested
   * `[1 Jul, 31 Jul]`.
   *
   * Carrying the day as a string keeps the operator's answer intact all the
   * way to `buildScopeWhere`, which is the only place that knows which column
   * each bound is for and can therefore derive the right value for each.
   */
  from?: string;
  to?: string;
  all?: boolean;
}

export interface BookingXeroRepairAction {
  key: string;
  bookingId: string;
  type: XeroBookingRepairActionType;
  description: string;
  safeToAutoApply: boolean;
  payload: Record<string, unknown>;
  status: XeroBookingRepairActionStatus;
  resultMessage: string | null;
}

export interface BookingXeroRepairFinding {
  code: XeroBookingRepairFindingCode;
  severity: XeroBookingRepairSeverity;
  summary: string;
  safeToAutoApply: boolean;
  details: Record<string, unknown>;
  actions: BookingXeroRepairAction[];
}

export interface BookingXeroRepairBookingSummary {
  bookingId: string;
  bookingStatus: string;
  paymentId: string | null;
  paymentStatus: string | null;
  /** The booking OWNER, or null when it is owned by an Organisation (#3369). */
  memberId: string | null;
  memberName: string;
  memberEmail: string;
  checkIn: string;
  checkOut: string;
  findings: BookingXeroRepairFinding[];
  actions: BookingXeroRepairAction[];
}

export interface BookingXeroRepairPassReport {
  pass: number;
  bookingsScanned: number;
  bookingsWithFindings: number;
  findingsByCode: Record<string, number>;
  actionsByType: Record<string, number>;
  actionStatuses: Record<string, number>;
  bookings: BookingXeroRepairBookingSummary[];
}

export interface BookingXeroRepairRunSummary {
  bookingsScanned: number;
  bookingsWithFindings: number;
  findingsByCode: Record<string, number>;
  actionsByType: Record<string, number>;
  actionStatuses: Record<string, number>;
  manualReviewBookings: string[];
  xeroConnectionAvailable: boolean;
  // #1491: --apply-action keys that matched no planned action this run (typo,
  // or the key's embedded amount went stale) — the operator must know the
  // refund they asked for did NOT execute.
  unmatchedForcedActionKeys: string[];
}

export interface BookingXeroRepairRunReport {
  mode: "dry-run" | "apply";
  scope: {
    bookingId: string | null;
    from: string | null;
    to: string | null;
    all: boolean;
  };
  startedAt: string;
  completedAt: string;
  passes: BookingXeroRepairPassReport[];
  summary: BookingXeroRepairRunSummary;
}

export const bookingRepairSelect = Prisma.validator<Prisma.BookingSelect>()({
  id: true,
  memberId: true,
  // #3369: the owner may be an Organisation; bookingOwner() reads both.
  organisation: { select: { name: true, email: true } },
  status: true,
  checkIn: true,
  checkOut: true,
  totalPriceCents: true,
  discountCents: true,
  finalPriceCents: true,
  createdAt: true,
  updatedAt: true,
  member: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
  payment: {
    select: {
      id: true,
      amountCents: true,
      stripePaymentIntentId: true,
      stripePaymentMethodId: true,
      stripeCustomerId: true,
      xeroInvoiceId: true,
      xeroInvoiceNumber: true,
      status: true,
      refundedAmountCents: true,
      changeFeeCents: true,
      additionalPaymentIntentId: true,
      additionalAmountCents: true,
      additionalPaymentStatus: true,
      xeroRefundCreditNoteId: true,
      creditAppliedCents: true,
      // B5 (#2262): manual settlement provenance, so the classifier can tell a
      // cash / off-Xero settlement (no Xero objects expected) apart from a
      // genuinely missing invoice.
      manuallyMarkedPaidAt: true,
      // #3635: only a Stripe payment's refund gap is read (the note-eligible cash).
      source: true,
      transactions: {
        orderBy: {
          createdAt: "asc",
        },
        select: {
          id: true,
          paymentId: true,
          kind: true,
          source: true,
          stripePaymentIntentId: true,
          amountCents: true,
          refundedAmountCents: true,
          status: true,
          paymentMethodId: true,
          reason: true,
          // #3528: a withdrawn charge request must not plan a new invoice.
          withdrawnAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      createdAt: true,
      updatedAt: true,
    },
  },
  modifications: {
    orderBy: {
      createdAt: "asc",
    },
    select: {
      id: true,
      bookingId: true,
      modificationType: true,
      previousData: true,
      newData: true,
      priceDiffCents: true,
      changeFeeCents: true,
      createdAt: true,
    },
  },
  creditsFromCancellation: {
    orderBy: {
      createdAt: "asc",
    },
    select: {
      id: true,
      amountCents: true,
      type: true,
      description: true,
      xeroCreditNoteId: true,
      createdAt: true,
    },
  },
  // #1491: paid-path cancels freeze their policy decision (tier, retained
  // amount, method) in the CANCELLED event's snapshot — the one artifact
  // every tier writes, including 0%-tier retentions. Unpaid-branch cancels
  // write CANCELLED events WITHOUT a snapshot, so snapshot presence is the
  // policy-decision discriminator.
  events: {
    where: {
      type: "CANCELLED",
    },
    orderBy: {
      occurredAt: "asc",
    },
    select: {
      id: true,
      type: true,
      snapshot: true,
      occurredAt: true,
    },
  },
});

export type BookingRepairRecord = Prisma.BookingGetPayload<{
  select: typeof bookingRepairSelect;
}>;

export type BookingModificationRecord = BookingRepairRecord["modifications"][number];
export type BookingPaymentRecord = NonNullable<BookingRepairRecord["payment"]>;

export const xeroObjectLinkSelect = Prisma.validator<Prisma.XeroObjectLinkSelect>()({
  id: true,
  localModel: true,
  localId: true,
  xeroObjectType: true,
  xeroObjectId: true,
  xeroObjectNumber: true,
  xeroObjectUrl: true,
  role: true,
  active: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
});

export type XeroObjectLinkRecord = Prisma.XeroObjectLinkGetPayload<{
  select: typeof xeroObjectLinkSelect;
}>;

export const xeroOperationSelect = Prisma.validator<Prisma.XeroSyncOperationSelect>()({
  id: true,
  direction: true,
  entityType: true,
  operationType: true,
  localModel: true,
  localId: true,
  status: true,
  idempotencyKey: true,
  correlationKey: true,
  queueType: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  requestPayload: true,
  responsePayload: true,
  xeroObjectType: true,
  xeroObjectId: true,
  xeroObjectNumber: true,
  xeroObjectUrl: true,
  createdByMemberId: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  replayable: true,
  // #3643 F1 / #3635 (`INV-INT-025`): an officer's "resolved in Xero" mark
  // means the operation is done - never retried, and never re-minted beside.
  manuallyResolvedAt: true,
  manuallyResolvedReason: true,
});

export type XeroOperationRecord = Prisma.XeroSyncOperationGetPayload<{
  select: typeof xeroOperationSelect;
}>;

export interface ResolvedLocalObject {
  objectId: string;
  objectNumber: string | null;
  objectUrl: string | null;
  source: "field" | "link" | "operation";
  link: XeroObjectLinkRecord | null;
  operation: XeroOperationRecord | null;
  conflicts: string[];
}

/**
 * What `getBlockingOperation` found (#3635, `INV-INT-025`). A discriminated
 * union so that every call site has to say what it does with each case:
 *
 * - `retryable`: a live FAILED/PARTIAL row the retry helper can replay. The
 *   only shape `buildRetryAction` accepts, so a repair offer can never be
 *   built from anything else.
 * - `blocked`: a live row that must not be retried or minted beside - PENDING,
 *   RUNNING, WAITING_PAYMENT, or a FAILED/PARTIAL row the helper refuses.
 * - `resolved`: the only matching rows are ones an officer marked resolved in
 *   Xero. The object was made by hand, so the answer is "done": nothing is
 *   retried and nothing new is queued (a new document would be a rival to the
 *   officer's). It deliberately carries no `operation` field, so a site that
 *   reads `.operation` without first excluding it fails to compile.
 */
export type BlockingOperationMatch =
  | RetryableOperationMatch
  | {
      kind: "blocked";
      operation: XeroOperationRecord;
      retryMeta: XeroOperationRetryMeta;
    }
  | {
      kind: "resolved";
      resolvedOperation: XeroOperationRecord;
    };

export interface RetryableOperationMatch {
  kind: "retryable";
  operation: XeroOperationRecord;
  retryMeta: XeroOperationRetryMeta & { supported: true };
}

export interface XeroAmountEvidence {
  source: "link" | "operation-request" | "operation-response";
  amountCents: number;
  linkId?: string;
  operationId?: string;
}

// #1491: the cancel's durable card-path refund decision, frozen inside the
// cancellation claim transaction (payment-recovery.ts). Its presence — like a
// cancellation credit for the credit path — proves the cancel RECORDED a
// refund decision, so any remaining captured value is the deliberate
// policy-retained penalty, not a late capture.
export interface BookingCancellationRefundRecoveryRecord {
  id: string;
  bookingId: string;
  status: string;
  amountCents: number;
  createdAt: Date;
}

export interface BookingClassificationContext {
  booking: BookingRepairRecord;
  paymentLinks: XeroObjectLinkRecord[];
  /**
   * #3548 round 3: the payment's `REFUND_PAYMENT` links ACTIVE OR NOT
   * (`refundPaymentLinkWhere`) - `paymentLinks` holds active links only, and
   * these are single-active per payment - so the unsettled-refund-note finding
   * reads the same evidence as the hardening report.
   */
  paymentRefundPaymentLinks: XeroObjectLinkRecord[];
  bookingLinks: XeroObjectLinkRecord[];
  modificationLinksById: Map<string, XeroObjectLinkRecord[]>;
  paymentOperations: XeroOperationRecord[];
  bookingOperations: XeroOperationRecord[];
  modificationOperationsById: Map<string, XeroOperationRecord[]>;
  cancellationRefundRecoveryOperations: BookingCancellationRefundRecoveryRecord[];
  /**
   * #3639 review F3: the payment intents on this booking a treasurer-approval
   * task owns, whatever its status. A held or kept late capture is DECIDED, so
   * the late-capture finding must not offer to refund it.
   */
  lateCaptureApprovalIntentIds: Set<string>;
  /**
   * #3635: of those, the ones a treasurer KEPT (task DISMISSED), by intent: the
   * task and the Xero rows anchored on it. A kept booking payment is recorded
   * by its own invoice, anchored on that task (`late-capture-kept-xero-rules.ts`).
   */
  keptLateCaptures: Map<
    string,
    { taskId: string; raisedAt: Date; operations: XeroOperationRecord[] }
  >;
  /**
   * #3635 round-3 N1/R5: EVERY #3639 approval task on this booking, whatever
   * its status, by intent, with the Xero rows anchored on it. A kept invoice
   * raised before a reopen and approval can still lack its payment, and one an
   * officer recorded by hand can still have been refunded.
   */
  lateCaptureTasks: Map<
    string,
    {
      taskId: string;
      status: string;
      operations: XeroOperationRecord[];
      /**
       * #3924 round 7 (money M2): how the close of this APPROVED capture's card
       * refund as paid another way is recorded in Xero, and when the task was
       * raised (the capture day its receipt is dated from). Absent when it was
       * never closed so. Set after the load (`withPaidAnotherWayCloses`).
       */
      paidAnotherWayClose?: {
        xeroRefundNote: PaidAnotherWayXeroNote;
        raisedAt: Date;
        /**
         * #3924 round 8: for a close whose note waits for the receipt, where
         * the receipt and the note stand (`readPaidAnotherWayReceiptState`).
         */
        receiptState?: PaidAnotherWayReceiptState;
      };
    }
  >;
  /**
   * #3643 F2: the payments on this booking the organisation late-cash arm
   * raised a `CANCELLED_BOOKING_HAND_BACK` task for. Beside a retired clearing
   * note it means cash arrived and no clearing note is owed.
   */
  cancelledBookingHandBackPaymentIds: Set<string>;
  /**
   * #3635: the refund cents a note may still answer for a cancelled booking's
   * payment, any source (#3880 round 3), through `readRefundCreditNoteGap`, or
   * null when not read. The missing-refund-note arm asks for no more than
   * this, and nothing at all when it is zero.
   */
  refundNoteUncoveredCents: number | null;
  /**
   * #3643 (owner decision 28 Sep 2026, `INV-PAY-107`): the payments on this
   * booking whose part-payment review task a treasurer has closed. A review
   * closes only as DISMISSED - COMPLETED is unrepresentable
   * (`ManualRefundTask_part_payment_review_shape`), a deliberate narrowing of
   * the owner's "completes or dismisses", since there is no amount to complete
   * at. The payment was settled by hand in Xero, so the cancelled-open-invoice
   * arm reports nothing for it and never queues a clearing note.
   */
  closedPartPaymentReviewPaymentIds: Set<string>;
  /**
   * #3643 (`INV-PAY-108`): the payments on this booking with an OPEN
   * part-payment review. Counted as a recorded invoice payment even when the
   * local PAYMENT link is absent (an over/prepayment allocation, or a link the
   * inbound sync has not written yet), so the cancelled-open-invoice arm never
   * offers the full-size clearing note over a part payment.
   */
  openPartPaymentReviewPaymentIds: Set<string>;
  /**
   * #3187: what this booking's COMPLETED edit-financial-review tasks settled as
   * money owed to the club, totalled per `BookingModification` anchor.
   *
   * Empty for every booking that has never had a review parked on it, which is
   * what keeps the ordinary arms of the classifier exactly as they were. A
   * parked edit writes `priceDiffCents: 0` and `changeFeeCents: 0` on its
   * modification row BY CONSTRUCTION - the booking's stored totals do not move,
   * because the money is unresolved - so the modification row alone can never
   * say what such an edit owes. This map is where that number comes from.
   */
  editReviewChargeCentsByModificationId: Map<string, number>;
  /**
   * #3535: the booking's applied credit already allocated to its invoice as a
   * Xero credit note (sum of `MemberCreditNoteAllocation.amountCents`), so the
   * cancelled-open-invoice arm sizes its note by INV-PAY-017.
   */
  xeroAllocatedAppliedCreditCents: number;
  /**
   * #3836: the booking's applied credit not yet allocated against its invoice
   * - its `BOOKING_APPLIED` rows with no Xero note stamped, the engine's own
   * predicate (`unallocatedAppliedCents`).
   */
  unallocatedAppliedCreditCents: number;
  /**
   * #3187 fix round: the edits whose additional PaymentIntent mint FAILED and
   * is still owed by the recovery replay (PENDING or PROCESSING).
   *
   * From the ledger alone this state is indistinguishable from the
   * internet-banking route - both have no charge request row - and the two need
   * opposite handling: internet banking wants an unpaid invoice raised, a failed
   * mint wants the repair DEFERRED so the replay can raise it properly. Empty
   * for every booking with no failed mint, which is every booking the tool
   * repaired before this map existed.
   */
  openEditReviewChargeIntentRecoveryModificationIds: Set<string>;
}

export interface MutableFinding {
  code: XeroBookingRepairFindingCode;
  severity: XeroBookingRepairSeverity;
  summary: string;
  safeToAutoApply: boolean;
  details: Record<string, unknown>;
  actionKeys: string[];
}
