import type { EntranceFeeCategory } from "@prisma/client";
import { asRecord, readNumber, readString } from "@/lib/xero-json";
import {
  parseRefundMethod,
  readModificationNoteWording,
  type ModificationNoteWording,
  type RefundMethod,
} from "@/lib/xero-refund-method";

export const XERO_OUTBOX_ENTRANCE_FEE_TYPE = "ENTRANCE_FEE_INVOICE";
export const XERO_OUTBOX_BOOKING_INVOICE_TYPE = "BOOKING_INVOICE";
export const XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE =
  "BOOKING_INVOICE_UPDATE";
export const XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE = "REFUND_CREDIT_NOTE";
export const XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE = "ACCOUNT_CREDIT_NOTE";
export const XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE =
  "SUPPLEMENTARY_INVOICE";
export const XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE =
  "MODIFICATION_CREDIT_NOTE";
export const XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE =
  "MODIFICATION_ACCOUNT_CREDIT_NOTE";
export const XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE =
  "CREDIT_NOTE_ALLOCATION";
// #1620 — orchestration op: on IB invoice raise, allocate the member's existing
// floating credit notes against the booking's invoice (allocate-existing applied
// credit). The handler does the local lot math + enqueues the per-note
// CREDIT_NOTE_ALLOCATION ops; it is NOT itself a single Xero call.
export const XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE =
  "APPLIED_CREDIT_ALLOCATION";
export const XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE =
  "APPLIED_CREDIT_DEALLOCATION";
export const XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE =
  "MEMBERSHIP_CANCELLATION_CREDIT_NOTE";
export const XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE =
  "MEMBERSHIP_CANCELLATION_CONTACT";
export const XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE =
  "GROUP_SETTLEMENT_INVOICE";
export const XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE =
  "GROUP_SETTLEMENT_INVOICE_VOID";
export const XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE =
  "MEMBERSHIP_SUBSCRIPTION_INVOICE";
// #3635: the invoice, paid from the Stripe account, that records a late card
// capture on a cancelled booking a treasurer KEPT. Anchored on the #3639
// approval task (`xero-kept-late-capture-invoice.ts`).
export const XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE =
  "KEPT_LATE_CAPTURE_INVOICE";

/**
 * The complete set of outbox queue types the pending scan dispatches (#1272,
 * item 4 of #1208). Single source of truth: the pending-outbox scan
 * (`processQueuedXeroOutboxOperations`) filters `queueType IN (...)` on this
 * list, and the canonical per-type parse switch in `readQueuedOutboxPayload`
 * covers exactly these members. Ordered to mirror the historical scan
 * predicate for an obvious 1:1 audit. REQUEUE/BACKFILL/inbound rows carry no
 * queueType and are intentionally excluded.
 */
export const XERO_OUTBOX_QUEUE_TYPES = [
  XERO_OUTBOX_ENTRANCE_FEE_TYPE,
  XERO_OUTBOX_BOOKING_INVOICE_TYPE,
  XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE,
  XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
  XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
  XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE,
  XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE,
  XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE,
  XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE,
  XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE,
] as const;

interface QueuedEntranceFeeOutboxPayload {
  queueType: typeof XERO_OUTBOX_ENTRANCE_FEE_TYPE;
  category: EntranceFeeCategory;
  itemCode: string | null;
  feeAmountCents: number;
  description?: string | null;
}

interface QueuedBookingInvoiceOutboxPayload {
  queueType: typeof XERO_OUTBOX_BOOKING_INVOICE_TYPE;
  bookingId: string;
}

interface QueuedBookingInvoiceUpdateOutboxPayload {
  queueType: typeof XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE;
  bookingId: string;
  xeroInvoiceId?: string;
}

interface QueuedRefundCreditNoteOutboxPayload {
  queueType: typeof XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE;
  refundAmountCents: number;
  // Cumulative refunded-cents watermark this note settles up to (#1162). Absent
  // on payloads queued before per-delta refund notes existed.
  watermarkCents?: number;
  // How the money went back (`INV-PAY-101`, #3529): the wording on the note and
  // the bank account its settling payment posts to. Absent on rows queued
  // before the field existed; the executor then reads the payment's source.
  refundMethod?: RefundMethod;
  // #3635 round-3 R4/R3: the late capture this note answers, and the club day
  // its refund left Stripe. Absent on every other note.
  paymentIntentId?: string;
  documentDate?: string;
}

interface QueuedAccountCreditNoteOutboxPayload {
  queueType: typeof XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE;
  refundAmountCents: number;
}

interface QueuedSupplementaryInvoiceOutboxPayload {
  queueType: typeof XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE;
  bookingId: string;
  priceDiffCents: number;
  changeFeeCents: number;
  bookingModificationId?: string;
  recordPayment?: boolean;
  paymentIntentId?: string;
  waitForConfirmedAdditionalPayment?: boolean;
  /**
   * THE SECOND ASK (#3193, epic #2797): this row is not the booking change's
   * supplementary invoice - it is one settled review share's OWN small invoice,
   * raised because the change's invoice had already left the queue and could not
   * be raised to include it.
   *
   * Present means three things at once, which is why it is ONE field rather than
   * three: the outbox row and the resulting `XeroObjectLink` anchor on this
   * `ManualRefundTask` instead of the `BookingModification`, the Xero
   * idempotency key is scoped to the task, and the invoice tells the member why
   * they are being asked twice. Splitting them would let a caller take the
   * anchor without the wording, or the wording without the anchor - and the
   * anchor is the whole reason a second invoice cannot double-bill.
   */
  shortfallReviewTaskId?: string;
}

// `INV-PAY-101`: the wording on the note (`refundMethod`, absent on rows queued
// before #3529, which the builder renders as the card refund they always were),
// or `INV-PAY-017`'s unpaid-invoice clearing (#3535) — never both.
type QueuedModificationCreditNoteOutboxPayload = {
  queueType: typeof XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE;
  bookingId: string;
  refundAmountCents: number;
  bookingModificationId?: string;
} & ModificationNoteWording;

interface QueuedModificationAccountCreditNoteOutboxPayload {
  queueType: typeof XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE;
  bookingId: string;
  paymentId: string;
  refundAmountCents: number;
  bookingModificationId: string;
}

interface QueuedCreditNoteAllocationOutboxPayload {
  queueType: typeof XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE;
  creditNoteId: string;
  invoiceId: string;
  amountCents: number;
  role?: string;
}

interface QueuedAppliedCreditAllocationOutboxPayload {
  queueType: typeof XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE;
  bookingId: string;
}
interface QueuedAppliedCreditDeallocationOutboxPayload {
  queueType: typeof XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE;
  bookingId: string;
}

interface QueuedMembershipCancellationCreditNoteOutboxPayload {
  queueType: typeof XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE;
  subscriptionId: string;
  requestId: string;
  participantId: string;
}

interface QueuedMembershipCancellationContactOutboxPayload {
  queueType: typeof XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE;
  memberId: string;
  requestId: string;
  participantId: string;
}

interface QueuedGroupSettlementInvoiceOutboxPayload {
  queueType: typeof XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE;
  settlementId: string;
}

interface QueuedGroupSettlementInvoiceVoidOutboxPayload {
  queueType: typeof XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE;
  settlementId: string;
  /**
   * #3642: present on the VOID of an invoice the settlement ABANDONED while the
   * group stayed live (the settlement's own pointer is already cleared). Absent
   * on the cancellation VOID, which reads the invoice off the settlement.
   */
  xeroInvoiceId?: string;
}

interface QueuedSubscriptionInvoiceOutboxPayload {
  queueType: typeof XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE;
  chargeId: string;
}

/**
 * #3635: the GROSS captured cents and the club day Stripe took them, frozen
 * when the treasurer kept them, so a retry sends the same receipt on the same
 * date (orchestrator decision 29 Sep 2026). `paymentIntentId` names the
 * capture whose refunds the refund note answers.
 */
interface QueuedKeptLateCaptureInvoiceOutboxPayload {
  queueType: typeof XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE;
  bookingId: string;
  manualRefundTaskId: string;
  paymentIntentId: string;
  capturedCents: number;
  /** `YYYY-MM-DD`, the club's calendar day of the capture. */
  capturedOn: string;
  /**
   * #3635 round-3 R2: set once `capturedOn` was read from the Stripe charge
   * (`readStripeCaptureDocumentDate`) and stored before the Xero call, so a
   * retry never reads it again or drifts. Absent, `capturedOn` is the task's
   * raise day, the enqueue's estimate.
   */
  capturedOnFromStripe?: boolean;
}

export type QueuedOutboxPayload =
  | QueuedEntranceFeeOutboxPayload
  | QueuedBookingInvoiceOutboxPayload
  | QueuedBookingInvoiceUpdateOutboxPayload
  | QueuedRefundCreditNoteOutboxPayload
  | QueuedAccountCreditNoteOutboxPayload
  | QueuedSupplementaryInvoiceOutboxPayload
  | QueuedModificationCreditNoteOutboxPayload
  | QueuedModificationAccountCreditNoteOutboxPayload
  | QueuedCreditNoteAllocationOutboxPayload
  | QueuedAppliedCreditAllocationOutboxPayload
  | QueuedAppliedCreditDeallocationOutboxPayload
  | QueuedMembershipCancellationCreditNoteOutboxPayload
  | QueuedMembershipCancellationContactOutboxPayload
  | QueuedGroupSettlementInvoiceOutboxPayload
  | QueuedGroupSettlementInvoiceVoidOutboxPayload
  | QueuedSubscriptionInvoiceOutboxPayload
  | QueuedKeptLateCaptureInvoiceOutboxPayload;

export interface QueuedOutboxExpectedOperation {
  entityType: "INVOICE" | "CREDIT_NOTE" | "ALLOCATION" | "CONTACT";
  operationType: "CREATE" | "UPDATE" | "ALLOCATE";
  localModels: ReadonlyArray<
    | "Member"
    | "Payment"
    | "Booking"
    | "BookingModification"
    | "MemberSubscription"
    | "MembershipCancellationRequestParticipant"
    | "GroupBookingSettlement"
    | "MembershipSubscriptionCharge"
    | "MemberCreditNoteAllocation"
    // #3193: a second-ask supplementary invoice anchors on the review task whose
    // settled share it bills, so the claim guard has to accept that model or the
    // row is skipped on every pass and never sent.
    | "ManualRefundTask"
  >;
}

function readEntranceFeeCategory(value: unknown): EntranceFeeCategory | null {
  return value === "ADULT" ||
    value === "FAMILY" ||
    value === "YOUTH" ||
    value === "CHILD"
    ? value
    : null;
}

export function readQueueType(value: unknown): string | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }

  return readString(payload.queueType);
}

export function readQueuedOutboxPayload(
  value: unknown
): QueuedOutboxPayload | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }

  const queueType = readQueueType(value);
  if (!queueType) {
    return null;
  }

  if (queueType === XERO_OUTBOX_BOOKING_INVOICE_TYPE) {
    const bookingId = readString(payload.bookingId);
    if (!bookingId) {
      return null;
    }

    return {
      queueType,
      bookingId,
    };
  }

  if (queueType === XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE) {
    const bookingId = readString(payload.bookingId);
    if (!bookingId) {
      return null;
    }

    return {
      queueType,
      bookingId,
      xeroInvoiceId: readString(payload.xeroInvoiceId) ?? undefined,
    };
  }

  if (queueType === XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE) {
    const refundAmountCents = readNumber(payload.refundAmountCents);
    if (refundAmountCents === null) {
      return null;
    }

    return {
      queueType,
      refundAmountCents,
      watermarkCents: readNumber(payload.watermarkCents) ?? undefined,
      refundMethod: parseRefundMethod(payload.refundMethod) ?? undefined,
      paymentIntentId: readString(payload.paymentIntentId) ?? undefined,
      documentDate: readString(payload.documentDate) ?? undefined,
    };
  }

  if (queueType === XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE) {
    const refundAmountCents = readNumber(payload.refundAmountCents);
    if (refundAmountCents === null) {
      return null;
    }

    return {
      queueType,
      refundAmountCents,
    };
  }

  if (queueType === XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE) {
    const bookingId = readString(payload.bookingId);
    const priceDiffCents = readNumber(payload.priceDiffCents);
    const changeFeeCents = readNumber(payload.changeFeeCents);

    if (!bookingId || priceDiffCents === null || changeFeeCents === null) {
      return null;
    }

    return {
      queueType,
      bookingId,
      priceDiffCents,
      changeFeeCents,
      bookingModificationId:
        readString(payload.bookingModificationId) ?? undefined,
      recordPayment:
        typeof payload.recordPayment === "boolean"
          ? payload.recordPayment
          : undefined,
      paymentIntentId: readString(payload.paymentIntentId) ?? undefined,
      waitForConfirmedAdditionalPayment:
        typeof payload.waitForConfirmedAdditionalPayment === "boolean"
          ? payload.waitForConfirmedAdditionalPayment
          : undefined,
      shortfallReviewTaskId:
        readString(payload.shortfallReviewTaskId) ?? undefined,
    };
  }

  if (queueType === XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE) {
    const bookingId = readString(payload.bookingId);
    const refundAmountCents = readNumber(payload.refundAmountCents);

    if (!bookingId || refundAmountCents === null) {
      return null;
    }

    return {
      queueType,
      bookingId,
      refundAmountCents,
      bookingModificationId:
        readString(payload.bookingModificationId) ?? undefined,
      ...readModificationNoteWording(payload),
    };
  }

  if (queueType === XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE) {
    const bookingId = readString(payload.bookingId);
    const paymentId = readString(payload.paymentId);
    const refundAmountCents = readNumber(payload.refundAmountCents);
    const bookingModificationId = readString(payload.bookingModificationId);

    if (!bookingId || !paymentId || refundAmountCents === null || !bookingModificationId) {
      return null;
    }

    return {
      queueType,
      bookingId,
      paymentId,
      refundAmountCents,
      bookingModificationId,
    };
  }

  if (queueType === XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE) {
    const creditNoteId = readString(payload.creditNoteId);
    const invoiceId = readString(payload.invoiceId);
    const amountCents = readNumber(payload.amountCents);

    if (!creditNoteId || !invoiceId || amountCents === null) {
      return null;
    }

    return {
      queueType,
      creditNoteId,
      invoiceId,
      amountCents,
      role: readString(payload.role) ?? undefined,
    };
  }

  if (queueType === XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE) {
    const bookingId = readString(payload.bookingId);
    if (!bookingId) {
      return null;
    }

    return {
      queueType,
      bookingId,
    };
  }
  if (queueType === XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE) {
    const bookingId = readString(payload.bookingId);
    return bookingId ? { queueType, bookingId } : null;
  }

  if (queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE) {
    const subscriptionId = readString(payload.subscriptionId);
    const requestId = readString(payload.requestId);
    const participantId = readString(payload.participantId);

    if (!subscriptionId || !requestId || !participantId) {
      return null;
    }

    return {
      queueType,
      subscriptionId,
      requestId,
      participantId,
    };
  }

  if (queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE) {
    const memberId = readString(payload.memberId);
    const requestId = readString(payload.requestId);
    const participantId = readString(payload.participantId);

    if (!memberId || !requestId || !participantId) {
      return null;
    }

    return {
      queueType,
      memberId,
      requestId,
      participantId,
    };
  }

  if (queueType === XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE) {
    const settlementId = readString(payload.settlementId);
    if (!settlementId) {
      return null;
    }

    return {
      queueType,
      settlementId,
    };
  }

  if (queueType === XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE) {
    const settlementId = readString(payload.settlementId);
    if (!settlementId) {
      return null;
    }
    // #3642: the abandon VOID names its invoice. A present-but-unreadable id is
    // refused rather than read as the cancellation VOID, which would void
    // whatever the settlement points at now.
    if (payload.xeroInvoiceId === undefined) {
      return { queueType, settlementId };
    }
    const xeroInvoiceId = readString(payload.xeroInvoiceId);
    if (!xeroInvoiceId) {
      return null;
    }
    return { queueType, settlementId, xeroInvoiceId };
  }

  if (queueType === XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE) {
    const chargeId = readString(payload.chargeId);
    if (!chargeId) return null;
    return { queueType, chargeId };
  }

  if (queueType === XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE) {
    const bookingId = readString(payload.bookingId);
    const manualRefundTaskId = readString(payload.manualRefundTaskId);
    const paymentIntentId = readString(payload.paymentIntentId);
    const capturedCents = readNumber(payload.capturedCents);
    const capturedOn = readString(payload.capturedOn);
    if (
      !bookingId ||
      !manualRefundTaskId ||
      !paymentIntentId ||
      capturedCents === null ||
      !Number.isInteger(capturedCents) ||
      capturedCents <= 0 ||
      !capturedOn ||
      !/^\d{4}-\d{2}-\d{2}$/.test(capturedOn)
    ) {
      return null;
    }
    return {
      queueType,
      bookingId,
      manualRefundTaskId,
      paymentIntentId,
      capturedCents,
      capturedOn,
      ...(payload.capturedOnFromStripe === true ? { capturedOnFromStripe: true } : {}),
    };
  }

  if (queueType !== XERO_OUTBOX_ENTRANCE_FEE_TYPE) {
    return null;
  }

  const category = readEntranceFeeCategory(payload.category);
  const feeAmountCents = readNumber(payload.feeAmountCents);

  if (!category || feeAmountCents === null) {
    return null;
  }

  return {
    queueType,
    category,
    itemCode:
      payload.itemCode === null
        ? null
        : typeof payload.itemCode === "string"
          ? payload.itemCode
          : null,
    feeAmountCents,
    description: readString(payload.description) ?? null,
  };
}

/**
 * WHAT A QUEUED SUPPLEMENTARY INVOICE BILLS: `priceDiffCents + changeFeeCents`,
 * the sum `createXeroSupplementaryInvoice` sends, read through the typed parser
 * above (#3641 review round). `null` when the payload is not a readable
 * supplementary invoice. The one reading, so the restate's "never lower" and the
 * late capture's "does the capture cover it" cannot coerce the same row two ways.
 */
export function supplementaryInvoiceBilledCents(
  requestPayload: unknown
): number | null {
  const payload = readQueuedOutboxPayload(requestPayload);
  if (!payload || payload.queueType !== XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE) {
    return null;
  }
  return payload.priceDiffCents + payload.changeFeeCents;
}

export function getQueuedOutboxExpectedOperation(
  queueType: string | null
): QueuedOutboxExpectedOperation {
  if (queueType === XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE) {
    return {
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModels: ["Payment"],
    };
  }

  if (queueType === XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_VOID_TYPE) {
    return {
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModels: ["GroupBookingSettlement"],
    };
  }

  if (queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE) {
    return {
      entityType: "CONTACT",
      operationType: "UPDATE",
      localModels: ["MembershipCancellationRequestParticipant"],
    };
  }

  if (queueType === XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE) {
    return {
      entityType: "ALLOCATION",
      operationType: "ALLOCATE",
      // "MemberCreditNoteAllocation" (#1620): the applied-credit engine anchors
      // each per-note allocation op on its join row so multi-note allocations to
      // one invoice do not collapse the (localModel, localId, role) enqueue dedup.
      localModels: [
        "Payment",
        "Booking",
        "BookingModification",
        "MemberCreditNoteAllocation",
      ],
    };
  }

  if (queueType === XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE) {
    // Orchestration op anchored on the booking's Payment. Reuses the ALLOCATION
    // entity/op shape; dispatch routes by queueType, not by entity.
    return {
      entityType: "ALLOCATION",
      operationType: "ALLOCATE",
      localModels: ["Payment"],
    };
  }
  if (queueType === XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE) {
    return {
      entityType: "ALLOCATION",
      operationType: "UPDATE",
      localModels: ["Payment"],
    };
  }

  if (
    queueType === XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE ||
    queueType === XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE ||
    queueType === XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE ||
    queueType === XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE ||
    queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE
  ) {
    return {
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModels:
        queueType === XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE ||
        queueType === XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE
          ? ["Booking", "BookingModification"]
          : queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE
            ? ["MemberSubscription"]
            : ["Payment"],
    };
  }

  return {
    entityType: "INVOICE",
    operationType: "CREATE",
    localModels:
      queueType === XERO_OUTBOX_BOOKING_INVOICE_TYPE
        ? ["Payment"]
        : queueType === XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE
          ? // "ManualRefundTask" (#3193): a second-ask invoice for a review
            // share the booking change's own invoice could not take anchors on
            // that share's task, so one edit's asks never collide on one key.
            ["Booking", "BookingModification", "ManualRefundTask"]
          : queueType === XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE
            ? ["GroupBookingSettlement"]
            : queueType === XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE
              ? ["MembershipSubscriptionCharge"]
            : queueType === XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE
              ? // #3635: the approval task that owns the kept capture.
                ["ManualRefundTask"]
            : ["Member"],
  };
}
