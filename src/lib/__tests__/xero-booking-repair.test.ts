import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatBookingXeroRepairHumanSummary,
  runBookingXeroRepair,
} from "@/lib/xero-booking-repair";
import { PartialRefundError } from "@/lib/payment-transactions";
import { withTimeZoneAsync } from "@/lib/__tests__/helpers/timezone";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND } from "@/lib/manual-settlement-reversal-event";
import { unsettledRefundNoteRows } from "@/lib/xero-refund-note-unsettled";
import { modificationNoteWording, readModificationNoteWording } from "@/lib/xero-refund-method";

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking_1",
    memberId: "member_1",
    status: "CONFIRMED",
    checkIn: new Date("2026-06-10T00:00:00Z"),
    checkOut: new Date("2026-06-12T00:00:00Z"),
    totalPriceCents: 10000,
    discountCents: 0,
    finalPriceCents: 10000,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
    member: {
      id: "member_1",
      firstName: "Alice",
      lastName: "Tester",
      email: "alice@example.com",
    },
    payment: {
      id: "payment_1",
      amountCents: 10000,
      stripePaymentIntentId: "pi_123",
      stripePaymentMethodId: "pm_123",
      stripeCustomerId: "cus_123",
      xeroInvoiceId: "inv_primary",
      xeroInvoiceNumber: "INV-001",
      status: "SUCCEEDED",
      refundedAmountCents: 0,
      changeFeeCents: 0,
      additionalPaymentIntentId: null,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
      xeroRefundCreditNoteId: null,
      creditAppliedCents: 0,
      transactions: [],
      createdAt: new Date("2026-05-01T00:00:00Z"),
      updatedAt: new Date("2026-05-01T00:00:00Z"),
    },
    modifications: [],
    creditsFromCancellation: [],
    ...overrides,
  };
}

function makeOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: "operation_1",
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "BookingModification",
    localId: "mod_1",
    status: "SUCCEEDED",
    idempotencyKey: null,
    correlationKey: null,
    queueType: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    requestPayload: null,
    responsePayload: null,
    xeroObjectType: "INVOICE",
    xeroObjectId: "inv_1",
    xeroObjectNumber: null,
    xeroObjectUrl: null,
    createdByMemberId: null,
    startedAt: new Date("2026-05-02T00:00:00Z"),
    completedAt: new Date("2026-05-02T00:00:00Z"),
    createdAt: new Date("2026-05-02T00:00:00Z"),
    updatedAt: new Date("2026-05-02T00:00:00Z"),
    replayable: true,
    manuallyResolvedAt: null,
    ...overrides,
  };
}

/**
 * THE PRIMARY INVOICE'S OWN OUTBOX ROW, COMPLETED BEFORE THE EDIT (#3199).
 *
 * Production's ordinary shape, and since #3199 the evidence the supplementary-
 * invoice arm needs before it will offer a one-click fix: the primary invoice
 * is enqueued at confirmation, so it is minted from the booking as it stood
 * BEFORE any later edit and the edit's difference really does need its own
 * invoice. `makeBooking` puts `inv_primary` on the payment, so this row carries
 * the same `xeroObjectId` - that is what joins the two - and completes on
 * 1 May, a day before every modification fixture in this file.
 *
 * Tests that leave it out are asserting the OTHER half of #3199: with no
 * operation history the tool cannot tell which came first, and it reports for
 * manual review rather than billing.
 */
function makePrimaryInvoiceCreateOperation(overrides: Record<string, unknown> = {}) {
  return makeOperation({
    id: "operation_primary_invoice",
    localModel: "Payment",
    localId: "payment_1",
    entityType: "INVOICE",
    operationType: "CREATE",
    status: "SUCCEEDED",
    xeroObjectType: "INVOICE",
    xeroObjectId: "inv_primary",
    startedAt: new Date("2026-05-01T00:00:00Z"),
    completedAt: new Date("2026-05-01T00:00:00Z"),
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  });
}

/**
 * #3643: a cancelled booking whose cancel recognised Xero's part payment as
 * the payment's receipt (`PART_PAYMENT_RECOGNISED_REASON`), after the paid
 * path applied the cancellation policy to it.
 */
function recognisedPartPaymentBooking(receiptCents = 5000) {
  return makeBooking({
    status: "CANCELLED",
    payment: {
      ...makeBooking().payment,
      status: "PARTIALLY_REFUNDED",
      stripePaymentIntentId: null,
      transactions: [
        {
          id: "ptx_receipt",
          paymentId: "payment_1",
          kind: "PRIMARY",
          source: "INTERNET_BANKING",
          stripePaymentIntentId: null,
          amountCents: receiptCents,
          refundedAmountCents: receiptCents / 2,
          status: "PARTIALLY_REFUNDED",
          paymentMethodId: null,
          reason: "xero_part_payment_recognised_at_cancel",
          withdrawnAt: null,
          createdAt: new Date("2026-05-03T00:00:00Z"),
          updatedAt: new Date("2026-05-03T00:00:00Z"),
        },
      ],
    },
  });
}

/** #3643: the unpaid-rest clearing note the cancel queued, FAILED by default. */
function restNoteOperation(overrides: Record<string, unknown> = {}) {
  return makeOperation({
    id: "op_rest_note",
    localModel: "Booking",
    localId: "booking_1",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    queueType: "MODIFICATION_CREDIT_NOTE",
    status: "FAILED",
    xeroObjectType: null,
    xeroObjectId: null,
    requestPayload: {
      queueType: "MODIFICATION_CREDIT_NOTE",
      bookingId: "booking_1",
      refundAmountCents: 5000,
      clearsUnpaidInvoice: true,
      clearsUnpaidBalance: true,
    },
    ...overrides,
  });
}

/** A payment-anchored link, active, dated after the cancel. */
function paymentLink(overrides: Record<string, unknown>) {
  return {
    id: "link_payment",
    localModel: "Payment",
    localId: "payment_1",
    xeroObjectNumber: null,
    xeroObjectUrl: null,
    active: true,
    metadata: null,
    createdAt: new Date("2026-05-03T00:00:00Z"),
    updatedAt: new Date("2026-05-03T00:00:00Z"),
    ...overrides,
  };
}

function isCapturedTransactionStatus(status: string) {
  return ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(status);
}

function mapAdditionalSummaryStatus(status: string | null | undefined) {
  if (!status) {
    return null;
  }

  if (status === "FAILED") {
    return "FAILED";
  }

  if (isCapturedTransactionStatus(status)) {
    return "SUCCEEDED";
  }

  return "PENDING";
}

function recomputePaymentSummary(payment: any) {
  const transactions = [...(payment.transactions ?? [])].sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  );

  if (transactions.length === 0) {
    return;
  }

  const capturedAmountCents = transactions.reduce((sum, transaction) => {
    return sum + (isCapturedTransactionStatus(transaction.status) ? transaction.amountCents : 0);
  }, 0);
  const refundedAmountCents = transactions.reduce(
    (sum, transaction) => sum + (transaction.refundedAmountCents ?? 0),
    0
  );
  const latestPrimary = [...transactions]
    .reverse()
    .find((transaction) => transaction.kind === "PRIMARY");
  const latestAdditional = [...transactions]
    .reverse()
    .find((transaction) => transaction.kind === "ADDITIONAL");

  payment.refundedAmountCents = refundedAmountCents;
  payment.amountCents = capturedAmountCents > 0 ? capturedAmountCents : payment.amountCents;

  if (capturedAmountCents > 0) {
    if (refundedAmountCents >= capturedAmountCents) {
      payment.status = "REFUNDED";
    } else if (refundedAmountCents > 0) {
      payment.status = "PARTIALLY_REFUNDED";
    } else {
      payment.status = "SUCCEEDED";
    }
  } else if (latestPrimary) {
    payment.status = latestPrimary.status;
  }

  payment.stripePaymentIntentId = latestPrimary?.stripePaymentIntentId ?? null;
  payment.stripePaymentMethodId =
    latestPrimary?.paymentMethodId ?? payment.stripePaymentMethodId;
  payment.additionalPaymentIntentId = latestAdditional?.stripePaymentIntentId ?? null;
  payment.additionalAmountCents = latestAdditional?.amountCents ?? 0;
  payment.additionalPaymentStatus = mapAdditionalSummaryStatus(
    latestAdditional?.status ?? null
  );
}

function createDependencies(state: {
  bookings: any[];
  links?: any[];
  operations?: any[];
  cancellationRefundRecoveryOperations?: any[];
  // #3187: COMPLETED EDIT_FINANCIAL_REVIEW tasks settled as money owed to the
  // club. Empty for every pre-existing test, which is what makes those tests
  // the control for this change.
  editReviewChargeShares?: any[];
  // #3187 fix round: CREATE_ADDITIONAL_PAYMENT_INTENT recovery rows, whatever
  // their status. The loader asks for the open ones only, and the mock below
  // applies that filter itself so a test can prove a terminally FAILED row does
  // NOT hold the repair off.
  editReviewChargeIntentRecoveries?: any[];
  // #3187 fix round: the member paying WHILE the sweep runs. Called from inside
  // the supplementary-invoice enqueue, which is exactly where the real window
  // is - the plan was decided from the loader's snapshot minutes earlier, and
  // the webhook's release finds no operation to release because none exists
  // yet.
  onSupplementaryInvoiceEnqueue?: () => void;
  // #3639 review F3: treasurer-approval tasks, by the capture they own.
  lateCaptureApprovalTasks?: {
    bookingId: string;
    lateCaptureApprovalIntentId: string;
    // #3635: which were kept, the id their invoice anchors on, the capture day.
    id?: string;
    status?: string;
    createdAt?: Date;
  }[];
  // #3643 F2: the organisation late-cash arm's CANCELLED_BOOKING_HAND_BACK tasks.
  handBackTasks?: { bookingId: string; paymentId: string }[];
  // #3643 (owner decision 28 Sep 2026): DECISION 2 part-payment review tasks.
  partPaymentReviewTasks?: {
    bookingId: string;
    partPaymentReviewPaymentId: string;
    status: "OPEN" | "COMPLETED" | "DISMISSED";
  }[];
  // #3535: MemberCreditNoteAllocation totals per booking (INV-PAY-017's
  // allocation term). Empty for every pre-existing test.
  allocatedAppliedCreditByBookingId?: Record<string, number>;
  // #3836: applied credit with no Xero note stamped, per booking.
  unallocatedAppliedCreditByBookingId?: Record<string, number>;
}) {
  const links = state.links ?? [];
  const operations = state.operations ?? [];

  const enqueueXeroSupplementaryInvoiceOperation = vi.fn().mockImplementation(async (params: any) => {
    state.onSupplementaryInvoiceEnqueue?.();
    // #3187: the real enqueue's NET GUARD, reproduced here on purpose. A
    // supplementary invoice exists only to bill a positive net
    // (`xero-operation-outbox.ts`), so an action queued with a net of 0 does
    // NOTHING - and a critical finding whose action silently does nothing is
    // the exact failure #3187 exists to avoid. Without this branch the harness
    // would return a queue id for any amount and every test here would pass on
    // an action that could never run in production.
    if (params.priceDiffCents + params.changeFeeCents <= 0) {
      return {
        queueOperationId: null,
        outcome: "none",
        message: "No supplementary invoice is required for this modification.",
      };
    }
    links.push({
      id: `link_${params.bookingModificationId}`,
      localModel: "BookingModification",
      localId: params.bookingModificationId,
      xeroObjectType: "INVOICE",
      xeroObjectId: `inv_${params.bookingModificationId}`,
      xeroObjectNumber: `INV-${params.bookingModificationId}`,
      xeroObjectUrl: null,
      role: "SUPPLEMENTARY_INVOICE",
      active: true,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return {
      queueOperationId: `queue_${params.bookingModificationId}`,
      message: "queued",
    };
  });

  const markPaymentIntentTransactionFailed = vi.fn().mockImplementation(
    async ({ paymentIntentId }: { paymentIntentId: string }) => {
      const booking = state.bookings.find((item) =>
        item.payment?.transactions?.some(
          (transaction: any) =>
            transaction.stripePaymentIntentId === paymentIntentId
        )
      );
      const transaction = booking?.payment?.transactions?.find(
        (item: any) => item.stripePaymentIntentId === paymentIntentId
      );

      if (!transaction || isCapturedTransactionStatus(transaction.status)) {
        return booking?.payment ?? null;
      }

      transaction.status = "FAILED";
      recomputePaymentSummary(booking.payment);
      return booking.payment;
    }
  );

  const refundPaymentTransactions = vi.fn().mockImplementation(
    async ({
      paymentId,
      amountCents,
      allocation,
    }: {
      paymentId: string;
      amountCents: number;
      allocation?: { paymentTransactionId: string; amountCents: number }[];
    }) => {
      const booking = state.bookings.find((item) => item.payment?.id === paymentId);
      if (!booking?.payment) {
        throw new Error("Payment not found");
      }

      let remainingAmountCents = amountCents;
      const refunds: Array<{
        paymentIntentId: string;
        refundId: string;
        amountCents: number;
      }> = [];
      const refundableTransactions = [...(booking.payment.transactions ?? [])]
        .filter((transaction: any) => isCapturedTransactionStatus(transaction.status))
        .filter(
          (transaction: any) =>
            transaction.amountCents - transaction.refundedAmountCents > 0
        )
        .sort(
          (left: any, right: any) =>
            new Date(right.createdAt).getTime() -
            new Date(left.createdAt).getTime()
        );

      // #3639 delta D1: an explicit allocation is executed slice by slice, as
      // the real helper does; only without one is it derived newest-first.
      const plan = allocation
        ? allocation.map((slice) => ({
            transaction: (booking.payment.transactions ?? []).find(
              (t: any) => t.id === slice.paymentTransactionId
            ),
            cap: slice.amountCents,
          }))
        : refundableTransactions.map((transaction: any) => ({ transaction, cap: Infinity }));
      for (const { transaction, cap } of plan) {
        if (remainingAmountCents <= 0) {
          break;
        }
        if (!transaction) throw new Error("allocation names an unknown transaction");

        const refundableAmountCents =
          transaction.amountCents - transaction.refundedAmountCents;
        const refundAmountForTransaction = Math.min(
          remainingAmountCents,
          refundableAmountCents,
          cap
        );

        transaction.refundedAmountCents += refundAmountForTransaction;
        if (transaction.refundedAmountCents >= transaction.amountCents) {
          transaction.status = "REFUNDED";
        } else if (transaction.refundedAmountCents > 0) {
          transaction.status = "PARTIALLY_REFUNDED";
        }

        refunds.push({
          paymentIntentId: transaction.stripePaymentIntentId,
          refundId: `re_${transaction.stripePaymentIntentId}`,
          amountCents: refundAmountForTransaction,
        });
        remainingAmountCents -= refundAmountForTransaction;
      }

      if (remainingAmountCents > 0) {
        throw new Error("Refund amount exceeds captured Stripe payments");
      }

      recomputePaymentSummary(booking.payment);

      return {
        refunds,
        totalRefundedAmountCents: amountCents,
      };
    }
  );

  return {
    prisma: {
      // #3635: the kept-capture enqueue runs on a transaction of its own.
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
      booking: {
        findMany: vi.fn().mockResolvedValue(state.bookings),
      },
      xeroObjectLink: {
        findMany: vi.fn().mockResolvedValue(links),
      },
      xeroSyncOperation: {
        findMany: vi.fn().mockResolvedValue(operations),
      },
      // #1491: booking-cancel card-path refund decisions (matched by exact
      // booking_cancel_refund_recovery_<id> keys in the loader).
      paymentRecoveryOperation: {
        // Two callers now, and they must not answer each other's question: the
        // #1491 cancellation arm matches exact booking_cancel_refund_recovery_
        // keys, the #3187 arm matches exact edit-review intent-recovery keys and
        // open statuses only. The mock discriminates the way the real table
        // would rather than returning one list to both.
        findMany: vi.fn().mockImplementation(async ({ where }: any) => {
          if (where?.type !== "CREATE_ADDITIONAL_PAYMENT_INTENT") {
            return state.cancellationRefundRecoveryOperations ?? [];
          }

          const keys: string[] = where.idempotencyKey?.in ?? [];
          const statuses: string[] = where.status?.in ?? [];
          return (state.editReviewChargeIntentRecoveries ?? []).filter(
            (operation: any) =>
              keys.includes(operation.idempotencyKey) &&
              statuses.includes(operation.status)
          );
        }),
      },
      memberCreditNoteAllocation: {
        groupBy: vi.fn().mockImplementation(async ({ where }: any) =>
          (where?.appliedToBookingId?.in ?? [])
            .filter((bookingId: string) =>
              bookingId in (state.allocatedAppliedCreditByBookingId ?? {})
            )
            .map((bookingId: string) => ({
              appliedToBookingId: bookingId,
              _sum: { amountCents: state.allocatedAppliedCreditByBookingId![bookingId] },
            }))
        ),
      },
      memberCredit: {
        groupBy: vi.fn().mockImplementation(async ({ where }: any) =>
          (where?.appliedToBookingId?.in ?? [])
            .filter((bookingId: string) => bookingId in (state.unallocatedAppliedCreditByBookingId ?? {}))
            .map((bookingId: string) => ({
              appliedToBookingId: bookingId,
              _sum: { amountCents: -state.unallocatedAppliedCreditByBookingId![bookingId]! },
            })),
        ),
      },
      // #3187: the settled charge shares a parked booking edit's money lives on.
      manualRefundTask: {
        findMany: vi.fn().mockImplementation(async ({ where }: any) =>
          where?.kind === "CANCELLED_BOOKING_HAND_BACK"
            ? (state.handBackTasks ?? [])
            : where?.partPaymentReviewPaymentId
              ? (state.partPaymentReviewTasks ?? [])
            : where?.lateCaptureApprovalIntentId
              ? (state.lateCaptureApprovalTasks ?? [])
              : (state.editReviewChargeShares ?? []),
        ),
      },
      // #3187 fix round: the FRESH read the apply step takes after queueing a
      // supplementary invoice parked on a PaymentIntent. It answers from the
      // booking's transactions AS THEY STAND NOW rather than from a canned row,
      // which is what lets a test flip a capture mid-sweep and see the tool
      // notice; and it applies the same three criteria plus the intent id the
      // real query does, so a test cannot pass on a row the real read would
      // never have returned.
      paymentTransaction: {
        findFirst: vi.fn().mockImplementation(async ({ where }: any) => {
          const booking = state.bookings.find(
            (item) => item.id === where?.payment?.bookingId
          );
          const [row] = (booking?.payment?.transactions ?? [])
            .filter(
              (transaction: any) =>
                transaction.kind === where.kind &&
                transaction.source === where.source &&
                transaction.reason === where.reason &&
                (where.stripePaymentIntentId === undefined ||
                  transaction.stripePaymentIntentId ===
                    where.stripePaymentIntentId)
            )
            .sort(
              (left: any, right: any) =>
                new Date(right.createdAt).getTime() -
                new Date(left.createdAt).getTime()
            );
          return row
            ? { status: row.status, amountCents: row.amountCents }
            : null;
        }),
      },
      payment: {
        update: vi.fn().mockImplementation(async ({ where, data }: any) => {
          const booking = state.bookings.find((item) => item.payment?.id === where.id);
          if (booking?.payment) {
            booking.payment = {
              ...booking.payment,
              ...data,
            };
          }
          return booking?.payment ?? null;
        }),
      },
    } as unknown as (typeof import("@/lib/prisma"))["prisma"],
    enqueueXeroBookingInvoiceOperation: vi.fn().mockResolvedValue({
      queueOperationId: "queue_booking",
      message: "queued",
    }),
    enqueueXeroBookingInvoiceUpdateOperation: vi.fn().mockResolvedValue({
      queueOperationId: "queue_booking_update",
      message: "queued",
    }),
    enqueueXeroKeptLateCaptureInvoiceOperation: vi.fn().mockResolvedValue({
      queueOperationId: "queue_kept_late_capture",
      message: "queued",
    }),
    enqueueXeroSupplementaryInvoiceOperation,
    enqueueXeroModificationCreditNoteOperation: vi.fn().mockResolvedValue({
      queueOperationId: "queue_credit_note",
      message: "queued",
    }),
    enqueueXeroAccountCreditNoteOperation: vi.fn().mockResolvedValue({
      queueOperationId: "queue_account_credit",
      message: "queued",
    }),
    enqueueXeroRefundCreditNoteOperation: vi.fn().mockResolvedValue({
      queueOperationId: "queue_refund_credit",
      message: "queued",
    }),
    enqueueXeroAppliedCreditAllocationOperation: vi.fn().mockResolvedValue({
      queueOperationId: "queue_applied_credit_allocation",
      message: "queued",
    }),
    enqueueXeroCreditNoteAllocationOperation: vi.fn().mockResolvedValue({
      queueOperationId: "queue_allocation",
      message: "queued",
    }),
    enqueueXeroSyncOperationRetry: vi.fn().mockResolvedValue({
      queueOperationId: "queue_retry",
      message: "queued retry",
    }),
    // #3187 fix round: the live settlement's own release, injected so a test can
    // see whether the repair pass freed an invoice it parked on an intent that
    // had already been captured.
    releaseXeroSupplementaryInvoiceOperationsForPaymentIntent: vi
      .fn()
      .mockResolvedValue({ released: 1, queueOperationIds: ["queue_released"] }),
    processQueuedXeroOutboxOperations: vi.fn().mockResolvedValue({
      found: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    }),
    processQueuedXeroOperationRetries: vi.fn().mockResolvedValue({
      found: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    }),
    upsertXeroObjectLink: vi.fn().mockImplementation(async (link: any) => {
      links.push({
        id: `upsert_${link.localModel}_${link.localId}_${link.role}`,
        active: true,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        xeroObjectNumber: null,
        xeroObjectUrl: null,
        ...link,
      });
      return link;
    }),
    isXeroConnected: vi.fn().mockResolvedValue(false),
    cancelPaymentIntentIfCancellable: vi.fn().mockResolvedValue(null),
    getPaymentIntent: vi.fn().mockResolvedValue({ status: "canceled" }),
    markPaymentIntentTransactionFailed,
    refundPaymentTransactions,
    // #3635 C2: the repaired late-capture refund's record and per-capture note.
    recordAndNoteRepairedLateCaptureRefunds: vi
      .fn()
      .mockResolvedValue({
        recordFailed: [],
        doubleRefundSuspected: [],
        noted: [],
        alreadyNoted: [],
        noteFailed: [],
        byHand: [],
        notInXero: [],
      }),
    // #3635: the refund-note gap reader. By default every refunded cent is a
    // gap, which is what the missing-refund-note arm assumed before.
    readRefundCreditNoteGap: vi.fn().mockImplementation(
      async (payment: { refundedAmountCents: number }) => ({
        cashRefundCents: payment.refundedAmountCents,
        coveredCents: 0,
        resolvedInXeroCents: 0,
        uncoveredCents: payment.refundedAmountCents,
      })
    ),
  };
}

describe("runBookingXeroRepair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads a refund note's deactivated payment link, as the hardening report does, so it raises no unsettled finding (#3548 round 3 R2-3)", async () => {
    // Note A's row completed with only its link recording the payment; a later
    // delta's payment link deactivated it (single-active per payment).
    const noteLink = (id: string, creditNoteId: string, active: boolean) => ({
      id,
      localModel: "Payment",
      localId: "payment_1",
      xeroObjectType: "PAYMENT",
      xeroObjectId: id,
      xeroObjectNumber: null,
      xeroObjectUrl: null,
      role: "REFUND_PAYMENT",
      active,
      metadata: { creditNoteId, amountCents: 3000 },
      createdAt: new Date("2026-05-03T00:00:00Z"),
      updatedAt: new Date("2026-05-03T00:00:00Z"),
    });
    const noteRow = (id: string, creditNoteId: string) =>
      makeOperation({
        id,
        entityType: "CREDIT_NOTE",
        localModel: "Payment",
        localId: "payment_1",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: creditNoteId,
        requestPayload: { allocation: { invoiceId: "inv_primary", amount: 30 }, refundMethod: "card" },
        responsePayload: { refundPayment: null },
      });
    const links = [noteLink("pay_a", "cn_a", false), noteLink("pay_b", "cn_b", true)];
    const operations = [noteRow("op_a", "cn_a"), noteRow("op_b", "cn_b")];
    const deps = createDependencies({ bookings: [makeBooking()], links, operations });
    // The real table honours `active`, which is what separates the two reads.
    vi.mocked(deps.prisma.xeroObjectLink.findMany).mockImplementation((async ({ where }: any) =>
      links.filter((link) => where?.active === undefined || link.active === where.active)) as never);

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const codes = report.passes[0].bookings[0].findings.map((finding) => finding.code);
    expect(codes).not.toContain("REFUND_CREDIT_NOTE_UNSETTLED");
    // The report's pure half over the same fixture: the same verdict.
    expect(unsettledRefundNoteRows(operations as never, links)).toEqual([]);
  });

  it("MUTATION (#3880 F1): a bank payment holding only per-refund notes is offered no backfill of its canonical field", async () => {
    // Empty by design: a review's per-refund note is never the payment's one note.
    const reviewNote = (id: string, creditNoteId: string) =>
      paymentLink({ id, xeroObjectType: "CREDIT_NOTE", xeroObjectId: creditNoteId, role: "REFUND_CREDIT_NOTE", metadata: { amountCents: 1000, perDelta: true } });
    const reviewRow = (id: string, creditNoteId: string) =>
      makeOperation({
        id, entityType: "CREDIT_NOTE", localModel: "Payment", localId: "payment_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: creditNoteId,
        requestPayload: { allocation: { invoiceId: "inv_primary", amount: 10 }, refundMethod: "internet-banking", perDelta: true, reviewTaskId: "task_1" },
        responsePayload: { refundPayment: { paymentID: `pay_${id}` } },
      });
    const links = [reviewNote("link_a", "cn_a"), reviewNote("link_b", "cn_b")];
    const deps = createDependencies({ bookings: [makeBooking()], links, operations: [reviewRow("op_a", "cn_a"), reviewRow("op_b", "cn_b")] });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    const booking = report.passes[0].bookings[0];
    expect(booking.actions.map((action) => action.type)).not.toContain("SYNC_PAYMENT_REFUND_CREDIT_NOTE_FIELD");
    expect(booking.findings.map((finding) => finding.summary)).not.toContain(
      "Refund credit note references conflict across local fields, links, or past operations.",
    );
  });

  describe("#3880 round 3: a CANCELLED bank booking whose refund notes are all per-refund", () => {
    // $30 handed back by bank transfer on the cancelled booking, documented by
    // the review's per-refund note cn_a - never the payment's canonical note.
    const cancelledBank = () =>
      makeBooking({
        status: "CANCELLED",
        payment: { ...makeBooking().payment, source: "INTERNET_BANKING", refundedAmountCents: 3000, status: "PARTIALLY_REFUNDED" },
      });
    const classify = async (uncoveredCents: number) => {
      const links = [
        paymentLink({ id: "link_a", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_a", role: "REFUND_CREDIT_NOTE", metadata: { amountCents: 3000 - uncoveredCents, perDelta: true } }),
      ];
      const deps = createDependencies({ bookings: [cancelledBank()], links });
      // What the one gap reader answers: the per-refund note counts as cover.
      deps.readRefundCreditNoteGap = vi.fn().mockResolvedValue({ cashRefundCents: 3000, coveredCents: 3000 - uncoveredCents, resolvedInXeroCents: 0, uncoveredCents });
      const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });
      return { deps, booking: report.passes[0].bookings[0] };
    };

    it("MUTATION: fully covered - no queued note and no critical finding, and the gap is read for a bank payment", async () => {
      const { deps, booking } = await classify(0);
      expect(deps.readRefundCreditNoteGap).toHaveBeenCalledWith({ id: "payment_1", bookingId: "booking_1", refundedAmountCents: 3000 });
      expect(booking.actions.map((action) => action.type)).not.toContain("QUEUE_REFUND_CREDIT_NOTE");
      expect(booking.findings.map((finding) => finding.code)).not.toContain("CANCELLED_BOOKING_OPEN_INVOICE");
      expect(booking.findings.map((finding) => finding.code)).not.toContain("MANUAL_REVIEW_REQUIRED");
    });

    it("MUTATION: partially covered - asks for the gap only", async () => {
      const { booking } = await classify(1000);
      const queued = booking.actions.filter((action) => action.type === "QUEUE_REFUND_CREDIT_NOTE");
      expect(queued).toEqual([expect.objectContaining({ key: "queue:refund-credit-note:payment_1:1000", payload: { paymentId: "payment_1", refundAmountCents: 1000 } })]);
    });

    it("MUTATION: fully covered with cancellation credit beside it - no 'ambiguous' manual review", async () => {
      const links = [
        paymentLink({ id: "link_a", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_a", role: "REFUND_CREDIT_NOTE", metadata: { amountCents: 3000, perDelta: true } }),
      ];
      // A cancellation that also gave $50 of account credit (its own note
      // recorded): the cash share cannot be derived from local history alone.
      const withCredit = {
        ...cancelledBank(),
        creditsFromCancellation: [
          { id: "credit_cancel", amountCents: 5000, type: "CANCELLATION_REFUND", description: "Cancellation refund for booking booking_", xeroCreditNoteId: "cn_account", createdAt: new Date("2026-05-03T00:00:00Z") },
        ],
      };
      const deps = createDependencies({ bookings: [withCredit], links });
      deps.readRefundCreditNoteGap = vi.fn().mockResolvedValue({ cashRefundCents: 3000, coveredCents: 3000, resolvedInXeroCents: 0, uncoveredCents: 0 });
      const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });
      expect(report.passes[0].bookings[0].findings.map((finding) => finding.summary)).not.toContain(
        "The booking appears to have a cash cancellation refund, but the missing Xero refund note amount cannot be derived safely from local history.",
      );
    });
  });

  it("classifies cancelled unpaid bookings with an open invoice", async () => {
    const booking = makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        status: "FAILED",
      },
    });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "CANCELLED_BOOKING_OPEN_INVOICE"
    );
    expect(bookingReport.actions.map((action) => action.type)).toContain(
      "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
  });

  /**
   * #3639: the cancelled-open-invoice arm clears an invoice NOBODY PAID, with a
   * full-price credit note it marks safe to auto-apply. Before it does, it asks
   * what the cancellation already settled: whether money was captured from ANY
   * source, and whether the cancellation already answered the invoice with a
   * credit note on the PAYMENT. The first test above is the control: a genuinely
   * never-paid cancelled booking is still repaired.
   */
  describe("cancelled-open-invoice arm asks what the cancellation settled (#3639)", () => {
    function internetBankingTransaction(overrides: Record<string, unknown> = {}) {
      return {
        id: "txn_ib_primary",
        paymentId: "payment_1",
        kind: "PRIMARY",
        source: "INTERNET_BANKING",
        stripePaymentIntentId: null,
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        paymentMethodId: null,
        reason: null,
        withdrawnAt: null,
        createdAt: new Date("2026-05-01T00:00:00Z"),
        updatedAt: new Date("2026-05-01T00:00:00Z"),
        ...overrides,
      };
    }

    function cancelledInternetBankingBooking(
      paymentOverrides: Record<string, unknown>
    ) {
      return makeBooking({
        status: "CANCELLED",
        payment: {
          ...makeBooking().payment,
          stripePaymentIntentId: null,
          stripePaymentMethodId: null,
          stripeCustomerId: null,
          ...paymentOverrides,
        },
      });
    }

    async function clearingWork(booking: any, extra: Record<string, unknown> = {}) {
      const deps = createDependencies({ bookings: [booking], ...extra });
      const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
        dependencies: deps,
        scope: { all: true },
      });
      const bookingReport = report.passes[0].bookings[0];
      return {
        actions: bookingReport.actions.filter(
          (action) =>
            action.type === "QUEUE_MODIFICATION_CREDIT_NOTE" ||
            action.key.startsWith("queue:cancelled-allocation:")
        ),
        findings: bookingReport.findings.filter((finding) =>
          finding.summary.includes("cancelled before payment succeeded")
        ),
      };
    }

    it("raises no clearing note for a cancelled booking paid by internet banking", async () => {
      // Paid by bank transfer, then cancelled on the credit path: half came back
      // as account credit. No Stripe capture exists, which used to read as
      // "never paid" and queue a full clearing note against the paid invoice.
      const booking = cancelledInternetBankingBooking({
        status: "PARTIALLY_REFUNDED",
        refundedAmountCents: 5000,
        transactions: [
          internetBankingTransaction({
            status: "PARTIALLY_REFUNDED",
            refundedAmountCents: 5000,
          }),
        ],
      });

      const { actions, findings } = await clearingWork(booking);

      expect(actions).toEqual([]);
      expect(findings).toEqual([]);
    });

    it("reads the ledger too, so a captured bank-transfer row under a flattened aggregate still counts as paid", async () => {
      // The pre-#1473 cancel flattened captured aggregates to FAILED
      // (`INV-PAY-018`); the ledger row still says the money arrived.
      const booking = cancelledInternetBankingBooking({
        status: "FAILED",
        transactions: [internetBankingTransaction()],
      });

      const { actions, findings } = await clearingWork(booking);

      expect(actions).toEqual([]);
      expect(findings).toEqual([]);
    });

    it("raises no clearing note when a refund note on the payment already answered the invoice — an internet-banking hold released before #3535", async () => {
      // Never paid: the hold expired and the release answered the unpaid invoice
      // with a refund credit note recorded against the PAYMENT. Applying the
      // repair would clear the same invoice a second time.
      const booking = cancelledInternetBankingBooking({
        status: "FAILED",
        xeroRefundCreditNoteId: "cn_hold_release",
        transactions: [internetBankingTransaction({ status: "FAILED" })],
      });

      const { actions, findings } = await clearingWork(booking);

      expect(actions).toEqual([]);
      expect(findings).toEqual([]);
    });

    it("raises no clearing note when an account-credit note is linked on the payment", async () => {
      const booking = cancelledInternetBankingBooking({
        status: "FAILED",
        transactions: [internetBankingTransaction({ status: "FAILED" })],
      });

      const { actions, findings } = await clearingWork(booking, {
        links: [
          {
            id: "link_account_credit_note",
            localModel: "Payment",
            localId: "payment_1",
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: "cn_account_credit",
            xeroObjectNumber: "CN-ACCOUNT",
            xeroObjectUrl: null,
            role: "ACCOUNT_CREDIT_NOTE",
            active: true,
            metadata: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });

      expect(actions).toEqual([]);
      expect(findings).toEqual([]);
    });

    it("raises no clearing note while the payment's own credit-note operation is still queued", async () => {
      // The note has not reached Xero yet, but it will when the worker runs; a
      // second clearing note queued now would land beside it.
      const booking = cancelledInternetBankingBooking({
        status: "FAILED",
        transactions: [internetBankingTransaction({ status: "FAILED" })],
      });

      const { actions, findings } = await clearingWork(booking, {
        operations: [
          makeOperation({
            id: "operation_payment_refund_note",
            localModel: "Payment",
            localId: "payment_1",
            entityType: "CREDIT_NOTE",
            operationType: "CREATE",
            status: "PENDING",
            xeroObjectType: null,
            xeroObjectId: null,
            completedAt: null,
          }),
        ],
      });

      expect(actions).toEqual([]);
      expect(findings).toEqual([]);
    });

    it("tells the operator a clearing note was retired because cash arrived, rather than saying nothing (#3639 review F6, composing with #3535)", async () => {
      // #3535's late-cash arm settles the payment and CANCELS the clearing
      // note's queued create. This arm skips the booking (money was captured),
      // so the reason no note exists has to be reported here.
      const booking = cancelledInternetBankingBooking({
        status: "SUCCEEDED",
        transactions: [internetBankingTransaction()],
      });
      const deps = createDependencies({
        bookings: [booking],
        operations: [
          makeOperation({
            id: "operation_clearing_retired",
            localModel: "Booking",
            localId: booking.id,
            entityType: "CREDIT_NOTE",
            operationType: "CREATE",
            queueType: "MODIFICATION_CREDIT_NOTE",
            status: "CANCELLED",
            xeroObjectType: null,
            xeroObjectId: null,
            completedAt: null,
          }),
        ],
      });

      const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
        dependencies: deps,
        scope: { all: true },
      });

      const findings = report.passes[0].bookings[0].findings;
      expect(findings).toContainEqual(
        expect.objectContaining({
          code: "MANUAL_REVIEW_REQUIRED",
          severity: "info",
          summary: expect.stringContaining("Cash arrived for this booking after its hold was released"),
          actions: [],
        }),
      );
      expect(
        report.passes[0].bookings[0].actions.some(
          (a) => a.type === "QUEUE_MODIFICATION_CREDIT_NOTE",
        ),
      ).toBe(false);

      // Only the RETIRED CLEARING note says that: a cancelled create of any
      // other credit note on the booking is not evidence cash arrived.
      const otherNote = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
        dependencies: createDependencies({
          bookings: [booking],
          operations: [
            makeOperation({
              id: "operation_other_note",
              localModel: "Booking",
              localId: booking.id,
              entityType: "CREDIT_NOTE",
              operationType: "CREATE",
              queueType: "REFUND_CREDIT_NOTE",
              status: "CANCELLED",
              xeroObjectType: null,
              xeroObjectId: null,
              completedAt: null,
            }),
          ],
        }),
        scope: { all: true },
      });
      expect(
        otherNote.passes[0].bookings[0].findings.some((f) =>
          f.summary.startsWith("Cash arrived"),
        ),
      ).toBe(false);
    });

    it("still repairs a never-paid cancelled internet-banking booking with nothing on its payment", async () => {
      const booking = cancelledInternetBankingBooking({
        status: "FAILED",
        transactions: [internetBankingTransaction({ status: "FAILED" })],
      });

      const { actions, findings } = await clearingWork(booking);

      expect(actions.map((action) => action.type)).toEqual([
        "QUEUE_MODIFICATION_CREDIT_NOTE",
      ]);
      expect(findings).toHaveLength(1);
    });
  });

  // #3535 (`INV-PAY-017`): the note that clears a cancelled booking's unpaid
  // invoice says so; it never carries the card-refund wording.
  it("re-queues a cancelled unpaid booking's clearing note with the unpaid-invoice wording (#3535)", async () => {
    const booking = makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        status: "FAILED",
      },
    });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    const action = report.passes[0].bookings[0].actions.find(
      (candidate) => candidate.type === "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
    expect(action?.payload).toMatchObject({ clearsUnpaidInvoice: true });
    expect(deps.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: booking.id,
        bookingModificationId: undefined,
        clearsUnpaidInvoice: true,
      })
    );
    const [params] = (deps.enqueueXeroModificationCreditNoteOperation as ReturnType<typeof vi.fn>)
      .mock.calls[0]!;
    expect(params).not.toHaveProperty("refundMethod");
  });

  // #3535: a FAILED clearing note is replayed, never skipped; a blocking one
  // the retry helper cannot replay is at least reported.
  it("retries a failed booking-anchored clearing note and reports one it cannot retry (#3535)", async () => {
    const cancelledUnpaid = () =>
      makeBooking({
        status: "CANCELLED",
        payment: { ...makeBooking().payment, status: "FAILED" },
      });
    const failedClearing = (requestPayload: Record<string, unknown>) =>
      makeOperation({
        id: "operation_clearing",
        localModel: "Booking",
        localId: "booking_1",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        status: "FAILED",
        queueType: "MODIFICATION_CREDIT_NOTE",
        xeroObjectType: null,
        xeroObjectId: null,
        requestPayload,
      });

    const retryable = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: createDependencies({
        bookings: [cancelledUnpaid()],
        operations: [
          failedClearing({
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            refundAmountCents: 10000,
            clearsUnpaidInvoice: true,
          }),
        ],
      }),
      scope: { all: true },
    });
    const retryableBooking = retryable.passes[0].bookings[0];
    expect(retryableBooking.findings).toContainEqual(
      expect.objectContaining({ code: "BLOCKED_BY_XERO_OPERATION", safeToAutoApply: true })
    );
    expect(retryableBooking.actions.map((action) => action.type)).not.toContain(
      "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
    expect(retryableBooking.actions.length).toBeGreaterThan(0);

    const unreadable = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: createDependencies({
        bookings: [cancelledUnpaid()],
        operations: [failedClearing({ queueType: "MODIFICATION_CREDIT_NOTE", bookingId: "booking_1" })],
      }),
      scope: { all: true },
    });
    const unreadableBooking = unreadable.passes[0].bookings[0];
    expect(unreadableBooking.findings).toContainEqual(
      expect.objectContaining({
        code: "BLOCKED_BY_XERO_OPERATION",
        safeToAutoApply: false,
        actions: [],
      })
    );
  });

  // #3535: a clearing note that went PARTIAL replays its recorded allocation
  // plan through the retry; the arm no longer queues a fresh full-size
  // allocation against the primary invoice alone.
  it("retries a partial clearing note's recorded allocations instead of queueing a full one (#3535)", async () => {
    const booking = makeBooking({
      status: "CANCELLED",
      payment: { ...makeBooking().payment, status: "FAILED" },
    });
    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: createDependencies({
        bookings: [booking],
        links: [
          {
            id: "link_clearing_note",
            localModel: "Booking",
            localId: "booking_1",
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: "cn_clear",
            xeroObjectNumber: "CN-9",
            xeroObjectUrl: null,
            role: "MODIFICATION_CREDIT_NOTE",
            active: true,
            metadata: null,
            createdAt: new Date("2026-05-03T00:00:00Z"),
            updatedAt: new Date("2026-05-03T00:00:00Z"),
          },
        ],
        operations: [
          makeOperation({
            id: "operation_partial_clearing",
            localModel: "Booking",
            localId: "booking_1",
            entityType: "CREDIT_NOTE",
            operationType: "CREATE",
            status: "PARTIAL",
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: "cn_clear",
            requestPayload: {
              invoiceId: "inv_primary",
              refundAmountCents: 10000,
              clearsUnpaidInvoice: true,
              allocations: [{ invoiceId: "inv_primary", amountCents: 10000 }],
            },
          }),
        ],
      }),
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.actions.map((action) => action.type)).not.toContain(
      "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    expect(bookingReport.findings).toContainEqual(
      expect.objectContaining({ code: "MISSING_CREDIT_NOTE_ALLOCATION", safeToAutoApply: true })
    );
    expect(
      bookingReport.actions.some((action) =>
        JSON.stringify(action.payload).includes("operation_partial_clearing")
      )
    ).toBe(true);
  });

  // #3535 delta D1: a PARTIAL clearing row stays PARTIAL after its repair, so
  // the arm must stop once every planned invoice has an allocation link.
  it("stands down on a partial clearing note whose planned allocations have all landed (#3535)", async () => {
    const booking = makeBooking({
      status: "CANCELLED",
      payment: { ...makeBooking().payment, status: "FAILED" },
    });
    const link = (overrides: Record<string, unknown>) => ({
      localModel: "Booking",
      localId: "booking_1",
      xeroObjectNumber: null,
      xeroObjectUrl: null,
      active: true,
      metadata: null,
      createdAt: new Date("2026-05-03T00:00:00Z"),
      updatedAt: new Date("2026-05-03T00:00:00Z"),
      ...overrides,
    });
    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: createDependencies({
        bookings: [booking],
        links: [
          link({ id: "l_note", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_clear", role: "MODIFICATION_CREDIT_NOTE" }),
          link({
            id: "l_a1",
            xeroObjectType: "ALLOCATION",
            xeroObjectId: "alloc_1",
            role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
            metadata: { creditNoteId: "cn_clear", invoiceId: "inv_primary", amountCents: 6000 },
          }),
          link({
            id: "l_a2",
            xeroObjectType: "ALLOCATION",
            xeroObjectId: "alloc_2",
            role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
            metadata: { creditNoteId: "cn_clear", invoiceId: "inv_supp", amountCents: 4000 },
          }),
        ],
        operations: [
          makeOperation({
            id: "operation_partial_clearing",
            localModel: "Booking",
            localId: "booking_1",
            entityType: "CREDIT_NOTE",
            operationType: "CREATE",
            status: "PARTIAL",
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: "cn_clear",
            requestPayload: {
              invoiceId: "inv_primary",
              refundAmountCents: 10000,
              clearsUnpaidInvoice: true,
              allocations: [
                { invoiceId: "inv_primary", amountCents: 6000 },
                { invoiceId: "inv_supp", amountCents: 4000 },
              ],
            },
          }),
        ],
      }),
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).not.toContain(
      "MISSING_CREDIT_NOTE_ALLOCATION"
    );
    expect(
      bookingReport.actions.some((action) =>
        JSON.stringify(action.payload).includes("operation_partial_clearing")
      )
    ).toBe(false);
  });

  // #3535 delta D4: a note the late-cash arm retired means the member paid; and
  // a note refused for a shortfall is a person's to look at, never auto-retried.
  it("proposes no clearing note after cash retired one, and never auto-retries a shortfall (#3535)", async () => {
    const cancelledUnpaid = () =>
      makeBooking({
        status: "CANCELLED",
        payment: { ...makeBooking().payment, status: "FAILED" },
      });
    // #3639 delta D2: the late-cash arm that retires the note also SETTLES the
    // payment, so the retired case is a captured payment, as in production.
    const cancelledPaidLate = () =>
      makeBooking({
        status: "CANCELLED",
        payment: { ...makeBooking().payment, status: "SUCCEEDED" },
      });
    const clearingOp = (overrides: Record<string, unknown>) =>
      makeOperation({
        localModel: "Booking",
        localId: "booking_1",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        queueType: "MODIFICATION_CREDIT_NOTE",
        xeroObjectType: null,
        xeroObjectId: null,
        requestPayload: { queueType: "MODIFICATION_CREDIT_NOTE", bookingId: "booking_1", refundAmountCents: 10000 },
        ...overrides,
      });

    const retired = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: createDependencies({
        bookings: [cancelledPaidLate()],
        operations: [clearingOp({ id: "op_retired", status: "CANCELLED" })],
      }),
      scope: { all: true },
    });
    const retiredBooking = retired.passes[0].bookings[0];
    expect(retiredBooking.actions.map((action) => action.type)).not.toContain(
      "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
    expect(retiredBooking.findings.map((finding) => finding.code)).not.toContain(
      "CANCELLED_BOOKING_OPEN_INVOICE"
    );
    expect(retiredBooking.findings).toContainEqual(
      expect.objectContaining({
        severity: "info",
        safeToAutoApply: false,
        summary: expect.stringContaining("Cash arrived for this booking after its hold was released"),
      })
    );
    // One home for the sentence (delta D2): it appears once.
    expect(
      retiredBooking.findings.filter((f) => f.summary.startsWith("Cash arrived")),
    ).toHaveLength(1);

    const shortfall = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: createDependencies({
        bookings: [cancelledUnpaid()],
        operations: [
          clearingOp({
            id: "op_shortfall",
            status: "FAILED",
            lastErrorMessage:
              "The booking's open Xero invoices owe $0.00, less than this $100.00 invoice-clearing credit note; nothing was created.",
          }),
        ],
      }),
      scope: { all: true },
    });
    const shortfallBooking = shortfall.passes[0].bookings[0];
    expect(shortfallBooking.findings).toContainEqual(
      expect.objectContaining({ code: "MANUAL_REVIEW_REQUIRED", safeToAutoApply: false })
    );
    expect(shortfallBooking.actions.map((action) => action.type)).not.toContain(
      "REQUEUE_XERO_OPERATION"
    );
    expect(shortfallBooking.actions.some((action) => action.safeToAutoApply && action.type !== "SYNC_PAYMENT_PRIMARY_INVOICE_LINK")).toBe(false);
  });

  // #3643 (`INV-PAY-107`): a part payment leaves only a PAYMENT link locally.
  // A cancelled booking whose invoice carries one is owed less than a full
  // clearing note, so the tool neither queues nor retries one - manual review.
  it("never auto-queues or auto-retries a full clearing note over a recorded part payment (#3643)", async () => {
    const cancelledUnpaid = () =>
      makeBooking({
        status: "CANCELLED",
        payment: { ...makeBooking().payment, status: "FAILED" },
      });
    const partPayment = (overrides: Record<string, unknown> = {}) => ({
      id: "link_part_payment",
      localModel: "Payment",
      localId: "payment_1",
      xeroObjectType: "PAYMENT",
      xeroObjectId: "xero_payment_1",
      xeroObjectNumber: null,
      xeroObjectUrl: null,
      role: "INVOICE_PAYMENT",
      active: true,
      metadata: { invoiceId: "invoice_1", amount: 50, status: "AUTHORISED" },
      createdAt: new Date("2026-05-03T00:00:00Z"),
      updatedAt: new Date("2026-05-03T00:00:00Z"),
      ...overrides,
    });
    const expectManualReviewOnly = (report: Awaited<ReturnType<typeof runBookingXeroRepair>>) => {
      const bookingReport = report.passes[0].bookings[0];
      const types = bookingReport.actions.map((action) => action.type);
      expect(types).not.toContain("QUEUE_MODIFICATION_CREDIT_NOTE");
      expect(types).not.toContain("REQUEUE_XERO_OPERATION");
      expect(bookingReport.findings.map((finding) => finding.code)).not.toContain(
        "CANCELLED_BOOKING_OPEN_INVOICE"
      );
      expect(bookingReport.findings).toContainEqual(
        expect.objectContaining({
          code: "MANUAL_REVIEW_REQUIRED",
          severity: "manual_review",
          safeToAutoApply: false,
        })
      );
    };

    // No clearing operation yet: without the link this is the queue arm.
    expectManualReviewOnly(
      await runBookingXeroRepair(CLUB_FORMAT_TEST, {
        dependencies: createDependencies({ bookings: [cancelledUnpaid()], links: [partPayment()] }),
        scope: { all: true },
      })
    );

    // A replayable FAILED clearing operation: without the link, the retry arm.
    expectManualReviewOnly(
      await runBookingXeroRepair(CLUB_FORMAT_TEST, {
        dependencies: createDependencies({
          bookings: [cancelledUnpaid()],
          links: [partPayment()],
          operations: [
            makeOperation({
              id: "op_failed_clearing",
              localModel: "Booking",
              localId: "booking_1",
              entityType: "CREDIT_NOTE",
              operationType: "CREATE",
              queueType: "MODIFICATION_CREDIT_NOTE",
              status: "FAILED",
              xeroObjectType: null,
              xeroObjectId: null,
              lastErrorMessage: "Xero timed out",
              requestPayload: {
                queueType: "MODIFICATION_CREDIT_NOTE",
                bookingId: "booking_1",
                refundAmountCents: 10000,
              },
            }),
          ],
        }),
        scope: { all: true },
      })
    );

    // The part payment on an edit's SUPPLEMENTARY invoice counts the same way.
    expectManualReviewOnly(
      await runBookingXeroRepair(CLUB_FORMAT_TEST, {
        dependencies: createDependencies({
          bookings: [
            makeBooking({
              status: "CANCELLED",
              payment: { ...makeBooking().payment, status: "FAILED" },
              modifications: [
                {
                  id: "mod_1",
                  bookingId: "booking_1",
                  modificationType: "DATE_CHANGE",
                  priceDiffCents: 0,
                  changeFeeCents: 0,
                  createdAt: new Date("2026-05-02T00:00:00Z"),
                },
              ],
            }),
          ],
          links: [
            partPayment({
              id: "link_supp_payment",
              localModel: "BookingModification",
              localId: "mod_1",
              role: "SUPPLEMENTARY_INVOICE_PAYMENT",
            }),
          ],
        }),
        scope: { all: true },
      })
    );

    // #3643 D2: the cancel path recorded the part payment as the receipt and
    // its unpaid-rest note failed - no note link has been recorded yet. Still
    // manual review, never a full-size re-queue or an auto-retry.
    expectManualReviewOnly(
      await runBookingXeroRepair(CLUB_FORMAT_TEST, {
        dependencies: createDependencies({
          bookings: [recognisedPartPaymentBooking()],
          operations: [restNoteOperation({ lastErrorMessage: "Xero timed out" })],
        }),
        scope: { all: true },
      })
    );

    // A reversed (DELETED) payment is not money held: the queue arm is back.
    const reversed = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: createDependencies({
        bookings: [cancelledUnpaid()],
        links: [partPayment({ metadata: { amount: 50, status: "DELETED" } })],
      }),
      scope: { all: true },
    });
    expect(reversed.passes[0].bookings[0].actions.map((action) => action.type)).toContain(
      "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
  });

  // #3643 F1: a recognised booking enters the arm only while the rest its
  // cancel queued a note for is still owed. Paid in full at the cancel (no rest
  // note) or a rest an officer cleared by hand and marked resolved in Xero is
  // nothing owed, and the booking must not be flagged forever.
  it("stops flagging a recognised part payment once nothing is owed (#3643 F1)", async () => {
    const invoicePayment = paymentLink({
      id: "link_invoice_payment",
      xeroObjectType: "PAYMENT",
      xeroObjectId: "xero_payment_1",
      role: "INVOICE_PAYMENT",
      metadata: { invoiceId: "inv_primary", amount: 50, status: "AUTHORISED" },
    });
    const accountCreditNote = paymentLink({
      id: "link_account_credit_note",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_account_credit",
      role: "ACCOUNT_CREDIT_NOTE",
      metadata: { status: "AUTHORISED" },
    });
    const shortfall =
      "The booking's open Xero invoices owe $0.00, less than this $50.00 invoice-clearing credit note; nothing was created.";
    const classify = async (receiptCents: number, operations: any[]) =>
      (
        await runBookingXeroRepair(CLUB_FORMAT_TEST, {
          dependencies: createDependencies({
            bookings: [recognisedPartPaymentBooking(receiptCents)],
            links: [invoicePayment, accountCreditNote],
            operations,
          }),
          scope: { all: true },
        })
      ).passes[0].bookings[0];
    const expectQuiet = (bookingReport: Awaited<ReturnType<typeof classify>>) => {
      expect(
        bookingReport.findings.filter((finding) => finding.severity === "manual_review")
      ).toEqual([]);
      const types = bookingReport.actions.map((action) => action.type);
      expect(types).not.toContain("QUEUE_MODIFICATION_CREDIT_NOTE");
      expect(types).not.toContain("REQUEUE_XERO_OPERATION");
      expect(bookingReport.findings.map((finding) => finding.code)).not.toContain(
        "CANCELLED_BOOKING_OPEN_INVOICE"
      );
    };

    // Paid in full at the cancel: the whole amount became account credit and
    // the cancel queued no rest note.
    expectQuiet(await classify(10000, []));

    // The rest cleared by hand in Xero: its refused note is marked resolved.
    expectQuiet(
      await classify(5000, [
        restNoteOperation({
          lastErrorMessage: shortfall,
          manuallyResolvedAt: new Date("2026-05-05T00:00:00Z"),
        }),
      ])
    );

    // The rest still owed: the same refused note, unresolved, is manual review.
    const owed = await classify(5000, [restNoteOperation({ lastErrorMessage: shortfall })]);
    expect(owed.findings).toContainEqual(
      expect.objectContaining({
        code: "MANUAL_REVIEW_REQUIRED",
        severity: "manual_review",
        safeToAutoApply: false,
      })
    );
    expect(owed.actions.map((action) => action.type)).not.toContain("REQUEUE_XERO_OPERATION");

    // Still owed and still queued: reported as pending, never re-queued.
    const pending = await classify(5000, [restNoteOperation({ status: "PENDING" })]);
    expect(pending.findings.map((finding) => finding.code)).toContain(
      "BLOCKED_BY_XERO_OPERATION"
    );
    expect(pending.actions.map((action) => action.type)).not.toContain(
      "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
  });

  // #3643 (owner decision 28 Sep 2026, `INV-PAY-107`): a DECISION 2 cancel
  // raised a hand-back task for the payment. The manual-review finding stays
  // while the task is open and goes quiet once a treasurer has closed it (a
  // review closes only as DISMISSED; COMPLETED is kept here as the loader's
  // status test covers it) - and a quiet booking never falls through to a full
  // note.
  it("quiets the part-payment finding once its hand-back task is closed (#3643)", async () => {
    const report = async (status?: "OPEN" | "COMPLETED" | "DISMISSED") =>
      (
        await runBookingXeroRepair(CLUB_FORMAT_TEST, {
          dependencies: createDependencies({
            bookings: [
              makeBooking({
                status: "CANCELLED",
                payment: { ...makeBooking().payment, status: "FAILED" },
              }),
            ],
            links: [
              paymentLink({
                id: "link_part_payment",
                xeroObjectType: "PAYMENT",
                xeroObjectId: "xero_payment_1",
                role: "INVOICE_PAYMENT",
                metadata: { invoiceId: "inv_primary", amount: 50, status: "AUTHORISED" },
              }),
            ],
            partPaymentReviewTasks: status
              ? [{ bookingId: "booking_1", partPaymentReviewPaymentId: "payment_1", status }]
              : [],
          }),
          scope: { all: true },
        })
      ).passes[0].bookings[0];
    const partPaymentFinding = expect.objectContaining({
      code: "MANUAL_REVIEW_REQUIRED",
      severity: "manual_review",
      summary: expect.stringContaining("has a payment recorded against it"),
    });

    for (const status of [undefined, "OPEN"] as const) {
      expect((await report(status)).findings).toContainEqual(partPaymentFinding);
    }
    for (const status of ["COMPLETED", "DISMISSED"] as const) {
      const closed = await report(status);
      expect(closed.findings).not.toContainEqual(partPaymentFinding);
      expect(
        closed.findings.filter((finding) =>
          ["manual_review", "critical"].includes(finding.severity),
        ),
      ).toEqual([]);
      expect(closed.actions.map((action) => action.type)).not.toContain(
        "QUEUE_MODIFICATION_CREDIT_NOTE",
      );
    }
  });

  // #3643 (task-queue review F2): an OPEN review is the cancel's own proof
  // that money was recorded against the invoice. With NO local PAYMENT link (an
  // over/prepayment allocation, or a link the inbound sync has not written yet)
  // the booking must still be manual review, never the critical full-size
  // clearing note offered for auto-apply.
  it("treats an open part-payment review as a recorded payment when the local link is absent (#3643)", async () => {
    const report = async (reviewOpen: boolean) =>
      (
        await runBookingXeroRepair(CLUB_FORMAT_TEST, {
          dependencies: createDependencies({
            bookings: [
              makeBooking({
                status: "CANCELLED",
                payment: { ...makeBooking().payment, status: "FAILED" },
              }),
            ],
            partPaymentReviewTasks: reviewOpen
              ? [{ bookingId: "booking_1", partPaymentReviewPaymentId: "payment_1", status: "OPEN" }]
              : [],
          }),
          scope: { all: true },
        })
      ).passes[0].bookings[0];

    const open = await report(true);
    expect(open.findings).toContainEqual(
      expect.objectContaining({
        code: "MANUAL_REVIEW_REQUIRED",
        severity: "manual_review",
        safeToAutoApply: false,
        summary: expect.stringContaining("has a payment recorded against it"),
      }),
    );
    expect(open.findings.filter((finding) => finding.severity === "critical")).toEqual([]);
    expect(open.actions.map((action) => action.type)).not.toContain(
      "QUEUE_MODIFICATION_CREDIT_NOTE",
    );

    // The control: with no review and no link, the ordinary full-size note is
    // what the tool offers, so the review is what changed the answer.
    const none = await report(false);
    expect(none.actions.map((action) => action.type)).toContain(
      "QUEUE_MODIFICATION_CREDIT_NOTE",
    );
  });

  // #3643 F2: the ORGANISATION late-cash arm retires the pending clearing note
  // and raises a hand-back task; it settles no payment and writes no account
  // credit note. That retired note beside the hand-back is still "cash arrived,
  // none owed" - never a manual review, and never a full clearing note.
  it("reads a retired clearing note beside an organisation hand-back as cash arrived (#3643 F2)", async () => {
    const orgBooking = () =>
      makeBooking({
        status: "CANCELLED",
        memberId: null,
        organisationId: "org_1",
        payment: { ...makeBooking().payment, status: "PENDING", stripePaymentIntentId: null },
      });
    const retiredNote = restNoteOperation({
      id: "op_retired",
      status: "CANCELLED",
      requestPayload: {
        queueType: "MODIFICATION_CREDIT_NOTE",
        bookingId: "booking_1",
        refundAmountCents: 10000,
        clearsUnpaidInvoice: true,
      },
    });
    const invoicePayment = paymentLink({
      id: "link_invoice_payment",
      xeroObjectType: "PAYMENT",
      xeroObjectId: "xero_payment_1",
      role: "INVOICE_PAYMENT",
      metadata: { invoiceId: "inv_primary", amount: 100, status: "AUTHORISED" },
    });
    const handBackTasks = [{ bookingId: "booking_1", paymentId: "payment_1" }];

    // With the inbound payment link, and without it (the queue arm's shape).
    for (const links of [[invoicePayment], []]) {
      const bookingReport = (
        await runBookingXeroRepair(CLUB_FORMAT_TEST, {
          dependencies: createDependencies({
            bookings: [orgBooking()],
            links,
            operations: [retiredNote],
            handBackTasks,
          }),
          scope: { all: true },
        })
      ).passes[0].bookings[0];
      expect(bookingReport.findings).toContainEqual(
        expect.objectContaining({
          severity: "info",
          summary: expect.stringContaining("Cash arrived for this booking after its hold was released"),
        })
      );
      expect(
        bookingReport.findings.filter((finding) => finding.severity === "manual_review")
      ).toEqual([]);
      expect(bookingReport.findings.map((finding) => finding.code)).not.toContain(
        "CANCELLED_BOOKING_OPEN_INVOICE"
      );
      expect(bookingReport.actions.map((action) => action.type)).not.toContain(
        "QUEUE_MODIFICATION_CREDIT_NOTE"
      );
    }
  });

  // #3643: an officer's "resolved in Xero" mark on a refused clearing note
  // counts for an ordinary (unrecognised) cancelled unpaid booking too - the
  // same rule the recognised rest note follows. #3535's shortfall finding goes
  // quiet, and the booking never falls through to a retry or a re-queue.
  it("honours the resolved-in-Xero mark on a shortfall-refused clearing note (#3643)", async () => {
    const shortfallNote = (overrides: Record<string, unknown> = {}) =>
      restNoteOperation({
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "booking_1",
          refundAmountCents: 10000,
          clearsUnpaidInvoice: true,
        },
        lastErrorMessage:
          "The booking's open Xero invoices owe $0.00, less than this $100.00 invoice-clearing credit note; nothing was created.",
        ...overrides,
      });
    const classify = async (operations: any[]) =>
      (
        await runBookingXeroRepair(CLUB_FORMAT_TEST, {
          dependencies: createDependencies({
            bookings: [
              makeBooking({
                status: "CANCELLED",
                payment: { ...makeBooking().payment, status: "FAILED" },
              }),
            ],
            operations,
          }),
          scope: { all: true },
        })
      ).passes[0].bookings[0];

    const resolved = await classify([
      shortfallNote({ manuallyResolvedAt: new Date("2026-05-05T00:00:00Z") }),
    ]);
    expect(
      resolved.findings.filter((finding) => finding.severity === "manual_review")
    ).toEqual([]);
    expect(resolved.findings.map((finding) => finding.code)).not.toContain(
      "BLOCKED_BY_XERO_OPERATION"
    );
    expect(resolved.findings.map((finding) => finding.code)).not.toContain(
      "CANCELLED_BOOKING_OPEN_INVOICE"
    );
    const resolvedTypes = resolved.actions.map((action) => action.type);
    expect(resolvedTypes).not.toContain("REQUEUE_XERO_OPERATION");
    expect(resolvedTypes).not.toContain("QUEUE_MODIFICATION_CREDIT_NOTE");

    // Control: the same refused note, unmarked, is still #3535's manual review.
    const unresolved = await classify([shortfallNote()]);
    expect(unresolved.findings).toContainEqual(
      expect.objectContaining({
        code: "MANUAL_REVIEW_REQUIRED",
        severity: "manual_review",
        summary: expect.stringContaining("owe less than it"),
      })
    );
  });

  // #3643: a recognised booking's clearing note covers only the unpaid rest,
  // so its missing allocation is sized from the note's own recorded amount -
  // the figure the cancel queued - never the booking's full clearing amount.
  it("sizes a recognised rest note's missing allocation from the note itself (#3643)", async () => {
    const createdRestNote = (requestPayload: unknown) =>
      restNoteOperation({
        status: "SUCCEEDED",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "cn_rest",
        requestPayload,
        responsePayload: null,
      });
    const classify = async (operations: any[]) =>
      (
        await runBookingXeroRepair(CLUB_FORMAT_TEST, {
          dependencies: createDependencies({
            bookings: [recognisedPartPaymentBooking()],
            operations,
          }),
          scope: { all: true },
        })
      ).passes[0].bookings[0];

    const sized = await classify([
      createdRestNote({
        queueType: "MODIFICATION_CREDIT_NOTE",
        bookingId: "booking_1",
        refundAmountCents: 4000,
        clearsUnpaidInvoice: true,
        clearsUnpaidBalance: true,
      }),
    ]);
    const allocation = sized.actions.find(
      (action) => action.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    expect(allocation?.payload).toMatchObject({ creditNoteId: "cn_rest", amountCents: 4000 });
    expect(sized.findings).toContainEqual(
      expect.objectContaining({
        code: "MISSING_CREDIT_NOTE_ALLOCATION",
        details: expect.objectContaining({ amountCents: 4000 }),
      })
    );

    // No recorded amount at all: a person allocates it, never a full-size guess.
    const unsized = await classify([createdRestNote(null)]);
    expect(unsized.actions.map((action) => action.type)).not.toContain(
      "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    expect(unsized.findings).toContainEqual(
      expect.objectContaining({
        code: "MANUAL_REVIEW_REQUIRED",
        severity: "manual_review",
        safeToAutoApply: false,
      })
    );
  });

  // #3535 (`INV-PAY-017`): the arm sizes the note with the release's and the
  // cancel path's own helper — applied credit already allocated to the invoice
  // is not cleared twice, and a fully allocated invoice needs no note at all.
  it("sizes a cancelled unpaid booking's clearing note net of applied credit already allocated (#3535)", async () => {
    const cancelledUnpaid = () =>
      makeBooking({
        status: "CANCELLED",
        payment: { ...makeBooking().payment, status: "FAILED", changeFeeCents: 500 },
      });

    const partly = cancelledUnpaid();
    const partlyReport = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: createDependencies({
        bookings: [partly],
        allocatedAppliedCreditByBookingId: { [partly.id]: 4000 },
      }),
      scope: { all: true },
    });
    expect(
      partlyReport.passes[0].bookings[0].actions.find(
        (candidate) => candidate.type === "QUEUE_MODIFICATION_CREDIT_NOTE"
      )?.payload
    ).toMatchObject({ refundAmountCents: 10000 + 500 - 4000 });

    const fully = cancelledUnpaid();
    const fullyReport = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: createDependencies({
        bookings: [fully],
        allocatedAppliedCreditByBookingId: { [fully.id]: 10500 },
      }),
      scope: { all: true },
    });
    const fullyBooking = fullyReport.passes[0].bookings[0];
    expect(fullyBooking.actions.map((action) => action.type)).not.toContain(
      "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
    expect(fullyBooking.findings.map((finding) => finding.code)).not.toContain(
      "CANCELLED_BOOKING_OPEN_INVOICE"
    );
  });

  it("classifies missing supplementary invoices for positive booking modifications", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_1",
          bookingId: "booking_1",
          modificationType: "DATE_CHANGE",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      // #3199: the primary invoice went out on 1 May, the edit landed on 2 May.
      // Invoice first, so this edit's difference is genuinely unbilled.
      operations: [makePrimaryInvoiceCreateOperation()],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "MISSING_SUPPLEMENTARY_INVOICE"
    );
    expect(bookingReport.actions.map((action) => action.type)).toContain(
      "QUEUE_SUPPLEMENTARY_INVOICE"
    );

    /**
     * #3187 CONTROL, and the boundary that change turns on.
     *
     * A modification with no financial review contributes NO payment plan, so
     * the queued payload must carry none of the payment keys and the enqueue
     * keeps its own `recordPayment: true` default - correct here, because this
     * arm was built for a price increase whose card was captured BEFORE the
     * invoice was queued. Read by eye that boundary held; nothing guarded it,
     * and deleting the `editReviewChargeCents > 0` gate in the classifier left
     * all 46 tests passing while turning this booking's invoice UNPAID - a late
     * change fee sitting outstanding in Xero against money already banked.
     */
    const queueAction = bookingReport.actions.find(
      (action) => action.type === "QUEUE_SUPPLEMENTARY_INVOICE"
    );
    expect(queueAction?.payload).not.toHaveProperty("recordPayment");
    expect(queueAction?.payload).not.toHaveProperty(
      "waitForConfirmedAdditionalPayment"
    );
    expect(queueAction?.payload).not.toHaveProperty("paymentIntentId");
  });

  it("CONTROL: applying an ordinary price increase passes the enqueue no payment overrides (#3187)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_1",
          bookingId: "booking_1",
          modificationType: "DATE_CHANGE",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      // #3199: invoice first, edit second - the arm this control guards.
      operations: [makePrimaryInvoiceCreateOperation()],
    });

    await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    // Every override undefined, so `enqueueXeroSupplementaryInvoiceOperation`
    // falls through to the defaults it has always applied here. The payload
    // assertion above proves the classifier put nothing there; this proves the
    // apply path does not invent anything either.
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      expect.objectContaining({ bookingModificationId: "mod_1" }),
      {
        recordPayment: undefined,
        waitForConfirmedAdditionalPayment: undefined,
        paymentIntentId: undefined,
      }
    );
  });

  // #1356: a supplementary invoice legitimately parked in WAITING_PAYMENT is
  // not "missing" — re-queueing it would mint a duplicate operation whose
  // default recordPayment books money before any capture exists.
  it("treats a WAITING_PAYMENT supplementary op as blocking, not missing (#1356)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_waiting",
          bookingId: "booking_1",
          modificationType: "DATE_CHANGE",
          priceDiffCents: -500,
          changeFeeCents: 1000,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "op_waiting",
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: "BookingModification",
          localId: "mod_waiting",
          status: "WAITING_PAYMENT",
          xeroObjectType: null,
          xeroObjectId: null,
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).not.toContain(
      "MISSING_SUPPLEMENTARY_INVOICE"
    );
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "BLOCKED_BY_XERO_OPERATION"
    );
    expect(bookingReport.actions.map((action) => action.type)).not.toContain(
      "QUEUE_SUPPLEMENTARY_INVOICE"
    );
  });

  // #1356 (F16): the repair pass verifies supplementary invoices against the
  // modification NET, so the invoice it queues must carry the signed price
  // reduction — a clamped component would immediately fail its own
  // amount-evidence check.
  it("queues mixed-sign supplementary invoices with the signed price reduction (#1356)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_mixed",
          bookingId: "booking_1",
          modificationType: "DATE_CHANGE",
          priceDiffCents: -500,
          changeFeeCents: 1000,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      // #3199: invoice first, edit second.
      operations: [makePrimaryInvoiceCreateOperation()],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "MISSING_SUPPLEMENTARY_INVOICE"
    );
    const queueAction = bookingReport.actions.find(
      (action) => action.type === "QUEUE_SUPPLEMENTARY_INVOICE"
    );
    expect(queueAction?.payload).toMatchObject({
      bookingModificationId: "mod_mixed",
      priceDiffCents: -500,
      changeFeeCents: 1000,
    });
  });

  it("flags supplementary invoice amount evidence mismatches for manual review", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_amount_invoice",
          bookingId: "booking_1",
          modificationType: "GUEST_ADD",
          priceDiffCents: 2500,
          changeFeeCents: 500,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_supplementary_amount",
          localModel: "BookingModification",
          localId: "mod_amount_invoice",
          xeroObjectType: "INVOICE",
          xeroObjectId: "inv_mod_amount",
          xeroObjectNumber: "INV-AMOUNT",
          xeroObjectUrl: null,
          role: "SUPPLEMENTARY_INVOICE",
          active: true,
          metadata: { amountCents: 2500 },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const amountFinding = report.passes[0].bookings[0].findings.find(
      (finding) => finding.code === "XERO_AMOUNT_MISMATCH"
    );
    expect(amountFinding).toMatchObject({
      severity: "manual_review",
      safeToAutoApply: false,
      details: {
        modificationId: "mod_amount_invoice",
        expectedAmountCents: 3000,
        xeroObjectId: "inv_mod_amount",
      },
    });
    expect(amountFinding?.actions[0]?.type).toBe("MARK_MANUAL_REVIEW");
  });

  it("classifies stale primary invoice details after a zero-net date change", async () => {
    const booking = makeBooking({
      checkIn: new Date("2026-05-30T00:00:00Z"),
      checkOut: new Date("2026-05-31T00:00:00Z"),
      modifications: [
        {
          id: "mod_date_1",
          bookingId: "booking_1",
          modificationType: "DATE_CHANGE",
          previousData: {
            checkIn: "2026-05-29",
            checkOut: "2026-05-30",
          },
          newData: {
            checkIn: "2026-05-30",
            checkOut: "2026-05-31",
          },
          priceDiffCents: 0,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "STALE_PRIMARY_INVOICE_DETAILS"
    );
    expect(bookingReport.actions.map((action) => action.type)).toContain(
      "QUEUE_PRIMARY_INVOICE_UPDATE"
    );
  });

  // #1427: with a CAPTURED payment and no stored evidence, the settlement a
  // missing credit note should carry may have been policy-limited below
  // abs(net) — auto-queueing abs(net) would over-credit Xero income by the
  // policy-retained share, so a human sizes it.
  it("routes a missing modification credit note to manual review when the payment captured money and no stored evidence exists (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_2",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -3000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    const finding = bookingReport.findings.find(
      (candidate) => candidate.code === "MISSING_MODIFICATION_CREDIT_NOTE"
    );
    expect(finding).toMatchObject({
      severity: "manual_review",
      safeToAutoApply: false,
    });
    expect(bookingReport.actions.map((action) => action.type)).not.toContain(
      "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
    expect(bookingReport.actions.map((action) => action.type)).toContain(
      "MARK_MANUAL_REVIEW"
    );
  });

  // #1427: no captured payment means no cancellation-policy tier can have
  // applied — the full delta is the correct bookkeeping correction (#1015),
  // and it stays auto-applyable.
  it("queues a missing modification credit note at abs(net) when the payment never captured money", async () => {
    const booking = makeBooking({
      payment: {
        ...makeBooking().payment,
        status: "PENDING",
      },
      modifications: [
        {
          id: "mod_2",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -3000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    const action = bookingReport.actions.find(
      (candidate) => candidate.type === "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
    expect(action).toMatchObject({
      safeToAutoApply: true,
      payload: {
        bookingModificationId: "mod_2",
        refundAmountCents: 3000,
      },
    });
    // #3535: an edit's reduction is not an unpaid-invoice clearing.
    expect(action?.payload).not.toHaveProperty("clearsUnpaidInvoice");
    const finding = bookingReport.findings.find(
      (candidate) => candidate.code === "MISSING_MODIFICATION_CREDIT_NOTE"
    );
    expect(finding).toMatchObject({
      severity: "critical",
      safeToAutoApply: true,
      details: { refundAmountSource: "net-amount" },
    });
  });

  // #3836: a booking paid entirely by credit on the card path, invoiced before
  // #3836 with its applied credit never allocated, so Xero shows it owing.
  function creditOnlyCardBooking(overrides: Record<string, unknown> = {}) {
    return makeBooking({
      status: "PAID",
      payment: { ...makeBooking().payment, amountCents: 0, creditAppliedCents: 10000, stripePaymentIntentId: null, stripePaymentMethodId: null, source: "STRIPE" },
      ...overrides,
    });
  }
  const unallocated = { unallocatedAppliedCreditByBookingId: { booking_1: 10000 } };
  const appliedCreditAllocationOp = (overrides: Record<string, unknown>) =>
    makeOperation({
      id: "op_applied_allocation", localModel: "Payment", localId: "payment_1", entityType: "ALLOCATION", operationType: "ALLOCATE",
      xeroObjectType: null, xeroObjectId: null, requestPayload: { queueType: "APPLIED_CREDIT_ALLOCATION", bookingId: "booking_1" }, ...overrides,
    });

  it("MUTATION (#3836): queues the applied-credit allocation for a credit-only card invoice, and --apply queues it once", async () => {
    const deps = createDependencies({ bookings: [creditOnlyCardBooking()], operations: [makePrimaryInvoiceCreateOperation()], ...unallocated });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.find((finding) => finding.code === "UNALLOCATED_APPLIED_CREDIT")).toMatchObject({
      severity: "critical",
      safeToAutoApply: true,
      details: { paymentId: "payment_1", xeroInvoiceId: "inv_primary", unallocatedAppliedCreditCents: 10000 },
    });
    expect(bookingReport.actions.find((action) => action.type === "QUEUE_APPLIED_CREDIT_ALLOCATION")).toMatchObject({
      key: "queue:applied-credit-allocation:booking_1",
      payload: { bookingId: "booking_1" },
    });

    await runBookingXeroRepair(CLUB_FORMAT_TEST, { apply: true, dependencies: deps, scope: { all: true } });
    expect(deps.enqueueXeroAppliedCreditAllocationOperation).toHaveBeenCalledWith("booking_1");
  });

  it.each([
    { shape: "the credit is already allocated", state: {}, booking: {} },
    { shape: "the booking is cancelled (its cancel cleared the invoice)", state: unallocated, booking: { status: "CANCELLED" } },
    { shape: "the booking has no invoice yet", state: unallocated, booking: { payment: { ...creditOnlyCardBooking().payment, xeroInvoiceId: null } } },
    { shape: "the card captured cash", state: unallocated, booking: { payment: { ...creditOnlyCardBooking().payment, amountCents: 5000 } } },
    { shape: "it was a bank transfer (#1620 allocates those)", state: unallocated, booking: { payment: { ...creditOnlyCardBooking().payment, source: "INTERNET_BANKING" } } },
  ])("MUTATION (#3836): no allocation is queued where $shape", async ({ state, booking }) => {
    const deps = createDependencies({ bookings: [creditOnlyCardBooking(booking)], operations: [makePrimaryInvoiceCreateOperation()], ...state });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).not.toContain("UNALLOCATED_APPLIED_CREDIT");
    expect(bookingReport.actions.map((action) => action.type)).not.toContain("QUEUE_APPLIED_CREDIT_ALLOCATION");
  });

  it.each([
    { shape: "a pending allocation", operation: appliedCreditAllocationOp({ status: "PENDING", completedAt: null }), retried: false },
    { shape: "a failed allocation", operation: appliedCreditAllocationOp({ status: "FAILED" }), retried: true },
    { shape: "the invoice operation, failed after its raise", operation: makePrimaryInvoiceCreateOperation({ id: "op_invoice_failed", status: "FAILED", requestPayload: { queueType: "BOOKING_INVOICE", bookingId: "booking_1" } }), retried: true },
  ])("MUTATION (#3836): never queues a second allocation beside $shape", async ({ operation, retried }) => {
    const deps = createDependencies({ bookings: [creditOnlyCardBooking()], operations: [makePrimaryInvoiceCreateOperation(), operation], ...unallocated });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.actions.map((action) => action.type)).not.toContain("QUEUE_APPLIED_CREDIT_ALLOCATION");
    expect(bookingReport.actions.some((action) => action.key === `retry:${operation.id}`)).toBe(retried);
  });

  it("MUTATION (#3836 M2): a failed allocation Xero REFUSED (4xx) offers its retry as a manual action only", async () => {
    const deps = createDependencies({
      bookings: [creditOnlyCardBooking()],
      operations: [makePrimaryInvoiceCreateOperation(), appliedCreditAllocationOp({ status: "FAILED", lastErrorCode: "400" })],
      ...unallocated,
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    const retry = report.passes[0].bookings[0].actions.find((action) => action.key === "retry:op_applied_allocation");
    expect(retry).toMatchObject({ type: "REQUEUE_XERO_OPERATION", safeToAutoApply: false });
    await runBookingXeroRepair(CLUB_FORMAT_TEST, { apply: true, dependencies: deps, scope: { all: true } });
    expect(deps.enqueueXeroSyncOperationRetry).not.toHaveBeenCalled();
  });

  it.each(["408", "429", "500", null])("MUTATION (#3836 L-2): a failed allocation with code %s is transient, not a refusal - its retry stays auto-applied", async (lastErrorCode) => {
    const deps = createDependencies({
      bookings: [creditOnlyCardBooking()],
      operations: [makePrimaryInvoiceCreateOperation(), appliedCreditAllocationOp({ status: "FAILED", lastErrorCode })],
      ...unallocated,
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    expect(report.passes[0].bookings[0].actions.find((action) => action.key === "retry:op_applied_allocation")).toMatchObject({ safeToAutoApply: true });
  });

  it.each([
    { shape: "a pending allocation", operation: appliedCreditAllocationOp({ status: "PENDING", completedAt: null }) },
    { shape: "a failed invoice operation", operation: makePrimaryInvoiceCreateOperation({ id: "op_invoice_failed", status: "FAILED", requestPayload: { queueType: "BOOKING_INVOICE", bookingId: "booking_1" } }) },
  ])("MUTATION (#3836 H1): a cancelled credit-only booking's clearing note waits beside $shape", async ({ operation }) => {
    const deps = createDependencies({ bookings: [creditOnlyCardBooking({ status: "CANCELLED" })], operations: [makePrimaryInvoiceCreateOperation(), operation], ...unallocated });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.actions.map((action) => action.key)).not.toContain("queue:cancelled-open-invoice:booking_1");
    expect(bookingReport.findings.map((finding) => finding.code)).toContain("BLOCKED_BY_XERO_OPERATION");
  });

  it("MUTATION (#3836 H1): a partial invoice operation nothing can retry (its email failed) will not run again, so the clearing note does not wait for it", async () => {
    const partialEmail = makePrimaryInvoiceCreateOperation({ id: "op_invoice_partial", status: "PARTIAL", requestPayload: { queueType: "BOOKING_INVOICE", bookingId: "booking_1" } });
    const deps = createDependencies({ bookings: [creditOnlyCardBooking({ status: "CANCELLED" })], operations: [partialEmail], ...unallocated });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    expect(report.passes[0].bookings[0].actions.map((action) => action.key)).toContain("queue:cancelled-open-invoice:booking_1");
  });

  it("MUTATION (#3836 H1): with nothing unfinished, the cancelled credit-only booking's invoice is cleared as before", async () => {
    const deps = createDependencies({ bookings: [creditOnlyCardBooking({ status: "CANCELLED" })], operations: [makePrimaryInvoiceCreateOperation()], ...unallocated });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    expect(report.passes[0].bookings[0].actions.map((action) => action.key)).toContain("queue:cancelled-open-invoice:booking_1");
  });

  // #3809: a credit-paid booking's reduction settled as applied credit given
  // back, as the edit's history row records. Its note is the give-back - none
  // where the tier gave nothing back - so a note whose post-commit queue failed
  // after the deallocation committed is recovered at that figure, never at the
  // whole reduction the policy partly kept.
  function creditPaidReduction(givenBackCents: number) {
    return makeBooking({
      // Paid by credit: nothing captured, no card intent.
      payment: { ...makeBooking().payment, status: "SUCCEEDED", amountCents: 0, stripePaymentIntentId: null, stripePaymentMethodId: null },
      modifications: [
        {
          id: "mod_give_back",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -5000,
          changeFeeCents: 0,
          newData: { appliedCreditGiveBack: { basisCents: 5000, givenBackCents } },
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
  }

  it("MUTATION (#3809): queues a lost give-back note at the recorded give-back, worded as account credit", async () => {
    const deps = createDependencies({ bookings: [creditPaidReduction(500)] });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.actions.find((candidate) => candidate.type === "QUEUE_MODIFICATION_CREDIT_NOTE")).toMatchObject({
      safeToAutoApply: true,
      payload: { bookingModificationId: "mod_give_back", refundAmountCents: 500, refundMethod: "account-credit", reviewTaskId: "applied-credit-give-back" },
    });
    expect(bookingReport.findings.find((candidate) => candidate.code === "MISSING_MODIFICATION_CREDIT_NOTE")).toMatchObject({
      details: { refundAmountSource: "recorded-give-back" },
    });
  });

  it("MUTATION (#3809): expects no note where the give-back was nothing", async () => {
    const deps = createDependencies({ bookings: [creditPaidReduction(0)] });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.actions.map((action) => action.type)).not.toContain("QUEUE_MODIFICATION_CREDIT_NOTE");
    expect(bookingReport.findings.map((finding) => finding.code)).not.toContain("MISSING_MODIFICATION_CREDIT_NOTE");
  });

  // #3809 (review M1): $100 by card and $100 by credit, $150 removed at 100%:
  // the card refund's note AND the give-back's own note, scoped. Whichever
  // exists must not hide the other.
  function cardAndCreditReduction() {
    return makeBooking({
      modifications: [
        {
          id: "mod_mixed",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -15000,
          changeFeeCents: 0,
          newData: { appliedCreditGiveBack: { basisCents: 5000, givenBackCents: 5000 } },
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
  }
  const editNote = (overrides: Record<string, unknown>) =>
    makeOperation({
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localId: "mod_mixed",
      xeroObjectType: "CREDIT_NOTE",
      ...overrides,
    });
  const giveBackScoped = { reviewTaskId: "applied-credit-give-back" };

  it.each([
    {
      shape: "the card refund's note exists",
      operations: [editNote({ id: "op_card", xeroObjectId: "cn_card", requestPayload: { queueType: "MODIFICATION_CREDIT_NOTE", bookingModificationId: "mod_mixed", refundAmountCents: 10000, refundMethod: "card" } })],
    },
    {
      shape: "a credit election's unallocated note exists",
      operations: [editNote({ id: "op_account", queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE", xeroObjectId: "cn_account", requestPayload: { queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE", bookingModificationId: "mod_mixed", refundAmountCents: 10000 } })],
    },
  ])("MUTATION (#3809 M1): re-queues a lost give-back note under its own scope where $shape", async ({ operations }) => {
    const deps = createDependencies({ bookings: [cardAndCreditReduction()], operations });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.actions.find((candidate) => candidate.key === "queue:give-back-note:mod_mixed")).toMatchObject({
      type: "QUEUE_MODIFICATION_CREDIT_NOTE",
      safeToAutoApply: true,
      payload: { bookingModificationId: "mod_mixed", refundAmountCents: 5000, refundMethod: "account-credit", ...giveBackScoped },
    });
  });

  it("MUTATION (#3809 M1): applying the re-queue keeps the give-back's own scope and wording", async () => {
    const deps = createDependencies({
      bookings: [cardAndCreditReduction()],
      operations: [editNote({ id: "op_card", xeroObjectId: "cn_card", requestPayload: { queueType: "MODIFICATION_CREDIT_NOTE", bookingModificationId: "mod_mixed", refundAmountCents: 10000, refundMethod: "card" } })],
    });

    await runBookingXeroRepair(CLUB_FORMAT_TEST, { apply: true, dependencies: deps, scope: { all: true } });

    expect(deps.enqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
      expect.objectContaining({ bookingModificationId: "mod_mixed", refundAmountCents: 5000, refundMethod: "account-credit", ...giveBackScoped }),
    );
  });

  it("MUTATION (#3809 delta H1): where the fee absorbed the card's share, the one $40 give-back note already raised is found under its scope - no second is queued", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_fee",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -5000,
          changeFeeCents: 0,
          newData: { appliedCreditGiveBack: { basisCents: 4500, givenBackCents: 4000 } },
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({ id: "op_give_back", entityType: "CREDIT_NOTE", operationType: "CREATE", localId: "mod_fee", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_give_back", requestPayload: { queueType: "MODIFICATION_CREDIT_NOTE", bookingModificationId: "mod_fee", refundAmountCents: 4000, refundMethod: "account-credit", ...giveBackScoped } }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { apply: true, dependencies: deps, scope: { all: true } });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.actions.map((action) => action.key)).not.toContain("queue:give-back-note:mod_fee");
    expect(deps.enqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalledWith(expect.objectContaining({ refundAmountCents: 4000 }));
  });

  it("MUTATION (#3809 M1): retries a FAILED give-back note rather than queueing a second", async () => {
    const deps = createDependencies({
      bookings: [cardAndCreditReduction()],
      operations: [
        editNote({ id: "op_card", xeroObjectId: "cn_card", requestPayload: { queueType: "MODIFICATION_CREDIT_NOTE", bookingModificationId: "mod_mixed", refundAmountCents: 10000, refundMethod: "card" } }),
        editNote({ id: "op_give_back", status: "FAILED", xeroObjectId: null, requestPayload: { queueType: "MODIFICATION_CREDIT_NOTE", bookingModificationId: "mod_mixed", refundAmountCents: 5000, refundMethod: "account-credit", ...giveBackScoped } }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.actions.map((action) => action.key)).not.toContain("queue:give-back-note:mod_mixed");
    expect(bookingReport.findings.find((finding) => finding.details?.operationId === "op_give_back")).toMatchObject({ code: "BLOCKED_BY_XERO_OPERATION" });
  });

  it("(#3809 M1) a raised give-back note is not queued again, and does not stand in for the edit's own", async () => {
    const deps = createDependencies({
      bookings: [cardAndCreditReduction()],
      operations: [
        editNote({ id: "op_give_back", xeroObjectId: "cn_give_back", requestPayload: { queueType: "MODIFICATION_CREDIT_NOTE", bookingModificationId: "mod_mixed", refundAmountCents: 5000, refundMethod: "account-credit", ...giveBackScoped } }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.actions.map((action) => action.key)).not.toContain("queue:give-back-note:mod_mixed");
    // The card refund's note is still missing, and is still reported.
    expect(bookingReport.findings.map((finding) => finding.code)).toContain("MISSING_MODIFICATION_CREDIT_NOTE");
  });

  // #1427 failure scenario 1: the lost note was enqueued at the
  // policy-limited settlement (5000 of a 10000 reduction). The requeue must
  // replay the STORED amount — abs(net) would over-credit Xero by the
  // policy-retained half and mint a different amount-embedding correlation
  // key (duplicate-note risk if the original attempt reached Xero).
  it("sizes a missing modification credit note from the stored operation payload, not abs(net) (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_stored",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "operation_cancelled_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_stored",
          // CANCELLED: not blocking, not resolvable as an existing note —
          // but its enqueue-time payload still records the settlement.
          status: "CANCELLED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: null,
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_stored",
            refundAmountCents: 5000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    const action = bookingReport.actions.find(
      (candidate) => candidate.type === "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
    expect(action).toMatchObject({
      safeToAutoApply: true,
      payload: {
        bookingModificationId: "mod_stored",
        refundAmountCents: 5000,
      },
    });
    const finding = bookingReport.findings.find(
      (candidate) => candidate.code === "MISSING_MODIFICATION_CREDIT_NOTE"
    );
    expect(finding).toMatchObject({
      severity: "critical",
      safeToAutoApply: true,
      details: {
        refundAmountCents: 5000,
        refundAmountSource: "operation-request",
      },
    });
  });

  // #3536: the repair re-queues the note the original attempt queued, so it
  // must say what that attempt said - the officer's "Refunded in cash", or an
  // unpaid invoice's "Invoice correction" - not fall back to the card default.
  it.each(["cash", "invoice-correction"] as const)(
    "re-queues a missing modification credit note with the wording the original attempt recorded (%s, #3536)",
    async (noteWording) => {
      const booking = makeBooking({
        modifications: [
          {
            id: "mod_worded",
            bookingId: "booking_1",
            modificationType: "GUEST_REMOVE",
            priceDiffCents: -7300,
            changeFeeCents: 0,
            createdAt: new Date("2026-05-02T00:00:00Z"),
          },
        ],
      });
      const original = {
        queueType: "MODIFICATION_CREDIT_NOTE",
        bookingId: "booking_1",
        bookingModificationId: "mod_worded",
        refundAmountCents: 7300,
        ...(noteWording === "cash" ? { refundMethod: "internet-banking" } : {}),
        noteWording,
      };
      const deps = createDependencies({
        bookings: [booking],
        operations: [
          makeOperation({
            id: "operation_cancelled_worded_note",
            entityType: "CREDIT_NOTE",
            operationType: "CREATE",
            localId: "mod_worded",
            status: "CANCELLED",
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: null,
            requestPayload: original,
          }),
        ],
      });

      await runBookingXeroRepair(CLUB_FORMAT_TEST, {
        apply: true,
        dependencies: deps,
        scope: { all: true },
      });

      const [params] = (deps.enqueueXeroModificationCreditNoteOperation as ReturnType<typeof vi.fn>)
        .mock.calls[0]!;
      expect(params).toMatchObject({ bookingModificationId: "mod_worded", refundAmountCents: 7300 });
      // The same reading the note builder applies, on both records.
      expect(modificationNoteWording(readModificationNoteWording(params))).toBe(noteWording);
      expect(modificationNoteWording(readModificationNoteWording(params))).toBe(
        modificationNoteWording(readModificationNoteWording(original)),
      );
    },
  );

  // #1427: an ACCOUNT-credit-note op shares entityType/operationType with
  // the invoice-applied note op on the same modification — its amount must
  // never size the invoice-applied note. With no usable evidence and a
  // captured payment, the safe route is manual review.
  it("ignores account-credit-note operation payloads when sizing the invoice-applied note (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_account_credit",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "operation_account_credit",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_account_credit",
          status: "CANCELLED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: null,
          requestPayload: {
            queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_account_credit",
            refundAmountCents: 2000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.actions.map((action) => action.type)).not.toContain(
      "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
    const finding = bookingReport.findings.find(
      (candidate) => candidate.code === "MISSING_MODIFICATION_CREDIT_NOTE"
    );
    expect(finding).toMatchObject({
      severity: "manual_review",
      safeToAutoApply: false,
    });
  });

  // #1427: executors overwrite requestPayload at dispatch — the executed
  // account-credit op's payload becomes a bare document with NO queueType.
  // The immutable queueType COLUMN must still keep it out of the
  // invoice-applied note's resolution and evidence.
  it("discriminates an EXECUTED account-credit note by its queueType column despite the overwritten payload (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_exec_account",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "operation_exec_account",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_exec_account",
          status: "SUCCEEDED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_exec_account",
          queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
          // The executor replaced the enqueue payload with the raw Xero
          // document — no queueType, no refundAmountCents.
          requestPayload: {
            creditNotes: [{ type: "ACCRECCREDIT", total: 20.0 }],
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(
      bookingReport.actions.filter(
        (candidate) => candidate.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
      )
    ).toEqual([]);
    // The executed account note IS the settlement — no missing-note nag.
    expect(
      bookingReport.findings.filter((candidate) =>
        [
          "MISSING_MODIFICATION_CREDIT_NOTE",
          "XERO_AMOUNT_MISMATCH",
        ].includes(candidate.code)
      )
    ).toEqual([]);
  });

  // #1427: the executed invoice-applied note's overwritten payload keeps
  // refundAmountCents — the column-vetted loose read must still recover it.
  it("recovers the settlement from an EXECUTED invoice-applied note's overwritten payload (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_exec_note",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_exec_note",
          localModel: "BookingModification",
          localId: "mod_exec_note",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_exec_note",
          xeroObjectNumber: "CN-EXEC",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      operations: [
        makeOperation({
          id: "operation_exec_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_exec_note",
          status: "SUCCEEDED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_exec_note",
          queueType: "MODIFICATION_CREDIT_NOTE",
          // Executor-overwritten shape: document + invoiceId +
          // refundAmountCents, queueType key gone.
          requestPayload: {
            creditNotes: [{ type: "ACCRECCREDIT", total: 50.0 }],
            invoiceId: "inv_primary",
            refundAmountCents: 5000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(
      bookingReport.findings.filter(
        (finding) =>
          finding.code === "XERO_AMOUNT_MISMATCH" &&
          finding.details.xeroObjectId === "cn_exec_note"
      )
    ).toEqual([]);
    const action = bookingReport.actions.find(
      (candidate) => candidate.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    expect(action).toMatchObject({
      payload: { creditNoteId: "cn_exec_note", amountCents: 5000 },
    });
  });

  // #1427 (the #1356 third-arm rule): a pending/running credit-note
  // operation must surface as blocked instead of silence.
  it("surfaces a pending modification credit-note operation as blocked instead of staying silent (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_pending",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -3000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "operation_pending_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_pending",
          status: "PENDING",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: null,
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_pending",
            refundAmountCents: 3000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    const blocked = bookingReport.findings.find(
      (candidate) => candidate.code === "BLOCKED_BY_XERO_OPERATION"
    );
    expect(blocked).toMatchObject({
      severity: "warning",
      safeToAutoApply: false,
      details: { operationId: "operation_pending_note" },
    });
    expect(bookingReport.actions.map((action) => action.type)).not.toContain(
      "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
  });

  // #1427: the expected amount is now the STORED settlement (op request
  // 3000), so the policy-limited note itself is clean — but the allocation
  // evidence (4000) exceeds the note's settlement and must surface.
  it("flags allocation evidence that disagrees with the stored note settlement (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_amount_credit",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -4000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_credit_amount",
          localModel: "BookingModification",
          localId: "mod_amount_credit",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_amount",
          xeroObjectNumber: "CN-AMOUNT",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "link_allocation_amount",
          localModel: "BookingModification",
          localId: "mod_amount_credit",
          xeroObjectType: "ALLOCATION",
          xeroObjectId: "alloc_amount",
          xeroObjectNumber: null,
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
          active: true,
          metadata: {
            creditNoteId: "cn_amount",
            invoiceId: "inv_primary",
            amountCents: 4000,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      operations: [
        makeOperation({
          id: "operation_credit_amount",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_amount_credit",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_amount",
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_amount_credit",
            refundAmountCents: 3000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    const amountFindings = bookingReport.findings.filter(
      (finding) => finding.code === "XERO_AMOUNT_MISMATCH"
    );
    // The note itself matches its stored settlement — no note mismatch.
    expect(
      amountFindings.find(
        (finding) => finding.details.xeroObjectId === "cn_amount"
      )
    ).toBeUndefined();
    const allocationFinding = amountFindings.find(
      (finding) => finding.details.xeroObjectId === "alloc_amount"
    );
    expect(allocationFinding).toMatchObject({
      severity: "manual_review",
      safeToAutoApply: false,
      details: {
        modificationId: "mod_amount_credit",
        expectedAmountCents: 3000,
        xeroObjectId: "alloc_amount",
      },
    });
    expect(allocationFinding?.details.mismatches).toEqual([
      {
        source: "link",
        amountCents: 4000,
        linkId: "link_allocation_amount",
      },
    ]);
  });

  // #1427 failure scenario 2 regression: a correct policy-limited note
  // (5000 of a 10000 reduction) with consistent stored evidence must NOT be
  // flagged against abs(net).
  it("does not flag a policy-limited credit note whose stored evidence agrees (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_policy",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_policy_note",
          localModel: "BookingModification",
          localId: "mod_policy",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_policy",
          xeroObjectNumber: "CN-POLICY",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "link_policy_allocation",
          localModel: "BookingModification",
          localId: "mod_policy",
          xeroObjectType: "ALLOCATION",
          xeroObjectId: "alloc_policy",
          xeroObjectNumber: null,
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
          active: true,
          metadata: {
            creditNoteId: "cn_policy",
            invoiceId: "inv_primary",
            amountCents: 5000,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      operations: [
        makeOperation({
          id: "operation_policy_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_policy",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_policy",
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_policy",
            refundAmountCents: 5000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(
      bookingReport.findings.filter(
        (finding) => finding.code === "XERO_AMOUNT_MISMATCH"
      )
    ).toEqual([]);
    expect(bookingReport.actions.map((action) => action.type)).not.toContain(
      "MARK_MANUAL_REVIEW"
    );
  });

  // Genuine drift still surfaces: the note Xero actually holds disagrees
  // with the settlement it was enqueued with.
  it("still flags a note whose executed total drifted from its stored settlement (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_drift",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "operation_drift_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_drift",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_drift",
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_drift",
            refundAmountCents: 5000,
          },
          responsePayload: {
            creditNotes: [{ creditNoteID: "cn_drift", total: 65.0 }],
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const amountFinding = report.passes[0].bookings[0].findings.find(
      (finding) =>
        finding.code === "XERO_AMOUNT_MISMATCH" &&
        finding.details.xeroObjectId === "cn_drift"
    );
    expect(amountFinding).toMatchObject({
      severity: "manual_review",
      safeToAutoApply: false,
      details: { expectedAmountCents: 5000 },
    });
    expect(amountFinding?.details.mismatches).toEqual([
      {
        source: "operation-response",
        amountCents: 6500,
        operationId: "operation_drift_note",
      },
    ]);
  });

  // #1427: the note exists but nothing records its settlement and the
  // payment captured money — allocating abs(net) against a possibly
  // policy-limited note over-repairs the books, so a human confirms first.
  it("routes a missing allocation to manual review when the note's settlement is unknown and money was captured (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_3",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -4000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_credit_note",
          localModel: "BookingModification",
          localId: "mod_3",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_mod_3",
          xeroObjectNumber: "CN-003",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    const finding = bookingReport.findings.find(
      (candidate) => candidate.code === "MISSING_CREDIT_NOTE_ALLOCATION"
    );
    expect(finding).toMatchObject({
      severity: "manual_review",
      safeToAutoApply: false,
    });
    expect(bookingReport.actions.map((action) => action.type)).not.toContain(
      "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
  });

  it("queues a missing allocation at abs(net) when the payment never captured money", async () => {
    const booking = makeBooking({
      payment: {
        ...makeBooking().payment,
        status: "PENDING",
      },
      modifications: [
        {
          id: "mod_3",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -4000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_credit_note",
          localModel: "BookingModification",
          localId: "mod_3",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_mod_3",
          xeroObjectNumber: "CN-003",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    const action = bookingReport.actions.find(
      (candidate) => candidate.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    expect(action).toMatchObject({
      safeToAutoApply: true,
      payload: {
        creditNoteId: "cn_mod_3",
        amountCents: 4000,
      },
    });
  });

  // #1427 (B1): the resolved note's own enqueue payload outranks a later
  // CANCELLED null-id attempt at a different amount — a retired mis-sized
  // re-queue must neither flag the healthy note nor size its allocation.
  it("prefers the resolved note's own payload over a newer cancelled attempt (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_order",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_order_note",
          localModel: "BookingModification",
          localId: "mod_order",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_order",
          xeroObjectNumber: "CN-ORDER",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      operations: [
        makeOperation({
          id: "operation_order_original",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_order",
          status: "SUCCEEDED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_order",
          createdAt: new Date("2026-05-02T10:00:00Z"),
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_order",
            refundAmountCents: 5000,
          },
        }),
        makeOperation({
          id: "operation_order_cancelled",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_order",
          status: "CANCELLED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: null,
          createdAt: new Date("2026-05-02T10:05:00Z"),
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_order",
            refundAmountCents: 8000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    // The 5000 note reads clean against its own payload.
    expect(
      bookingReport.findings.filter(
        (finding) =>
          finding.code === "XERO_AMOUNT_MISMATCH" &&
          finding.details.xeroObjectId === "cn_order"
      )
    ).toEqual([]);
    // And the missing allocation is sized from the note's payload, not the
    // cancelled attempt and not abs(net).
    const action = bookingReport.actions.find(
      (candidate) => candidate.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    expect(action).toMatchObject({
      payload: { creditNoteId: "cn_order", amountCents: 5000 },
    });
  });

  // #1427: a bare legacy payload (no queueType) still sizes the expectation
  // as a last resort — it must not fall back to abs(net) and flag the note
  // it itself describes.
  it("sizes from a bare legacy payload instead of flagging the note against abs(net) (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_legacy",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -4000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_legacy_note",
          localModel: "BookingModification",
          localId: "mod_legacy",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_legacy",
          xeroObjectNumber: "CN-LEGACY",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      operations: [
        makeOperation({
          id: "operation_legacy_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_legacy",
          status: "SUCCEEDED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_legacy",
          requestPayload: { refundAmountCents: 3000 },
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(
      bookingReport.findings.filter(
        (finding) =>
          finding.code === "XERO_AMOUNT_MISMATCH" &&
          finding.details.xeroObjectId === "cn_legacy"
      )
    ).toEqual([]);
    const action = bookingReport.actions.find(
      (candidate) => candidate.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    expect(action).toMatchObject({
      payload: { creditNoteId: "cn_legacy", amountCents: 3000 },
    });
  });

  // #1427: a PARTIAL account-credit-note op with no object id must not
  // pollute the invoice-applied note's mismatch evidence.
  it("keeps account-credit operation payloads out of the note's mismatch evidence (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_pollute",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_pollute_note",
          localModel: "BookingModification",
          localId: "mod_pollute",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_pollute",
          xeroObjectNumber: "CN-POLLUTE",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "link_pollute_allocation",
          localModel: "BookingModification",
          localId: "mod_pollute",
          xeroObjectType: "ALLOCATION",
          xeroObjectId: "alloc_pollute",
          xeroObjectNumber: null,
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
          active: true,
          metadata: {
            creditNoteId: "cn_pollute",
            invoiceId: "inv_primary",
            amountCents: 5000,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      operations: [
        makeOperation({
          id: "operation_pollute_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_pollute",
          status: "SUCCEEDED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_pollute",
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_pollute",
            refundAmountCents: 5000,
          },
        }),
        makeOperation({
          id: "operation_pollute_account",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_pollute",
          status: "PARTIAL",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: null,
          requestPayload: {
            queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
            bookingId: "booking_1",
            paymentId: "payment_1",
            bookingModificationId: "mod_pollute",
            refundAmountCents: 2000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    expect(
      report.passes[0].bookings[0].findings.filter(
        (finding) => finding.code === "XERO_AMOUNT_MISMATCH"
      )
    ).toEqual([]);
  });

  // #1427 (C4): a SUCCEEDED account-credit-note op must not resolve as the
  // invoice-applied note (its allocation against the primary invoice would
  // double-count the credit) nor block the missing-note classification.
  it("does not resolve or block on an account-credit note when the invoice-applied note is missing (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_misresolve",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "operation_account_success",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_misresolve",
          status: "SUCCEEDED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_account_note",
          requestPayload: {
            queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
            bookingId: "booking_1",
            paymentId: "payment_1",
            bookingModificationId: "mod_misresolve",
            refundAmountCents: 2000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    // No allocation of the account note against the primary invoice, no
    // wrong link, no blocked finding — and no "missing note" nag either:
    // the account credit IS this modification's legitimate settlement.
    const allocationActions = bookingReport.actions.filter(
      (candidate) => candidate.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    expect(allocationActions).toEqual([]);
    expect(
      bookingReport.findings.filter((candidate) =>
        [
          "MISSING_MODIFICATION_CREDIT_NOTE",
          "MISSING_CREDIT_NOTE_ALLOCATION",
          "BLOCKED_BY_XERO_OPERATION",
          "XERO_AMOUNT_MISMATCH",
        ].includes(candidate.code)
      )
    ).toEqual([]);
  });

  // #1427 BLOCKER regression (review, empirically reproduced): the
  // pre-column executed ledger has queueType NULL in BOTH the column (the
  // #1347 backfill copied from already-overwritten payloads) and the
  // payload (the account-credit executor leaves a bare document). The
  // correlation-key segment is the only surviving discriminator — without
  // it, the member's unapplied account-credit note resolves as the
  // invoice-applied note and gets allocated against the PAID primary
  // invoice, sized to its own total so Xero silently accepts.
  it("discriminates a PRE-COLUMN executed account-credit note by its correlation key (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_precol_account",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "operation_precol_account",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_precol_account",
          status: "SUCCEEDED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_precol_account",
          queueType: null,
          correlationKey:
            "booking-mod:mod_precol_account:mod-unapplied-credit-note:5000:v1",
          idempotencyKey:
            "booking-mod:mod_precol_account:mod-unapplied-credit-note:5000:v1",
          requestPayload: {
            creditNotes: [{ type: "ACCRECCREDIT", total: 50.0 }],
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(
      bookingReport.actions.filter(
        (candidate) => candidate.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
      )
    ).toEqual([]);
    // Settled by account credit: nothing to repair, nothing to nag.
    expect(
      bookingReport.findings.filter((candidate) =>
        [
          "MISSING_MODIFICATION_CREDIT_NOTE",
          "MISSING_CREDIT_NOTE_ALLOCATION",
          "XERO_AMOUNT_MISMATCH",
        ].includes(candidate.code)
      )
    ).toEqual([]);
  });

  // The pre-column executed INVOICE-APPLIED note keeps working through the
  // same correlation-key hint: overwritten payload, null column.
  it("recovers a PRE-COLUMN executed invoice-applied note via its correlation key (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_precol_note",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -10000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_precol_note",
          localModel: "BookingModification",
          localId: "mod_precol_note",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_precol_note",
          xeroObjectNumber: "CN-PRECOL",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      operations: [
        makeOperation({
          id: "operation_precol_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_precol_note",
          status: "SUCCEEDED",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_precol_note",
          queueType: null,
          correlationKey:
            "booking-mod:mod_precol_note:mod-credit-note:5000:v1",
          idempotencyKey:
            "booking-mod:mod_precol_note:mod-credit-note:5000:v1",
          requestPayload: {
            creditNotes: [{ type: "ACCRECCREDIT", total: 50.0 }],
            invoiceId: "inv_primary",
            refundAmountCents: 5000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(
      bookingReport.findings.filter(
        (finding) =>
          finding.code === "XERO_AMOUNT_MISMATCH" &&
          finding.details.xeroObjectId === "cn_precol_note"
      )
    ).toEqual([]);
    const action = bookingReport.actions.find(
      (candidate) => candidate.type === "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    expect(action).toMatchObject({
      payload: { creditNoteId: "cn_precol_note", amountCents: 5000 },
    });
  });

  // #1427 third arm for allocations: a live-but-not-retryable allocation op
  // blocks instead of minting a differently-sized sibling.
  it("surfaces a pending allocation operation as blocked instead of re-queueing beside it (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_alloc_pending",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -4000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      links: [
        {
          id: "link_alloc_pending_note",
          localModel: "BookingModification",
          localId: "mod_alloc_pending",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_alloc_pending",
          xeroObjectNumber: "CN-AP",
          xeroObjectUrl: null,
          role: "MODIFICATION_CREDIT_NOTE",
          active: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      operations: [
        makeOperation({
          id: "operation_alloc_pending",
          entityType: "ALLOCATION",
          operationType: "ALLOCATE",
          localId: "mod_alloc_pending",
          status: "PENDING",
          xeroObjectType: "ALLOCATION",
          xeroObjectId: null,
          requestPayload: {
            queueType: "CREDIT_NOTE_ALLOCATION",
            creditNoteId: "cn_alloc_pending",
            invoiceId: "inv_primary",
            amountCents: 4000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.actions.map((action) => action.type)).not.toContain(
      "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
    const blocked = bookingReport.findings.find(
      (candidate) =>
        candidate.code === "BLOCKED_BY_XERO_OPERATION" &&
        candidate.details.operationId === "operation_alloc_pending"
    );
    expect(blocked).toMatchObject({
      severity: "warning",
      safeToAutoApply: false,
    });
  });

  // #1427: a FAILED-unretryable blocking op must say so — not claim to be
  // "pending or running".
  it("labels a failed unretryable credit-note operation accurately in the blocked finding (#1427)", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_failed_note",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents: -3000,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makeOperation({
          id: "operation_failed_note",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localId: "mod_failed_note",
          status: "FAILED",
          replayable: false,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: null,
          requestPayload: {
            queueType: "MODIFICATION_CREDIT_NOTE",
            bookingId: "booking_1",
            bookingModificationId: "mod_failed_note",
            refundAmountCents: 3000,
          },
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const blocked = report.passes[0].bookings[0].findings.find(
      (candidate) =>
        candidate.code === "BLOCKED_BY_XERO_OPERATION" &&
        candidate.details.operationId === "operation_failed_note"
    );
    expect(blocked).toMatchObject({ safeToAutoApply: false });
    expect(blocked?.summary).toContain("cannot be auto-retried");
  });

  it("is idempotent on reruns once a missing supplementary invoice has been repaired", async () => {
    const booking = makeBooking({
      modifications: [
        {
          id: "mod_4",
          bookingId: "booking_1",
          modificationType: "GUEST_ADD",
          priceDiffCents: 1500,
          changeFeeCents: 0,
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    });
    const state = {
      bookings: [booking],
      links: [] as any[],
      // #3199: invoice first, edit second - so the repair is offered at all.
      operations: [makePrimaryInvoiceCreateOperation()] as any[],
    };
    const deps = createDependencies(state);

    const firstRun = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    expect(firstRun.passes.length).toBeGreaterThan(1);
    expect(firstRun.summary.bookingsWithFindings).toBe(0);
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledTimes(1);

    const secondRun = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    expect(secondRun.summary.bookingsWithFindings).toBe(0);
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledTimes(1);
  });

  it("classifies cancelled bookings using per-intent transaction state instead of aggregate payment status", async () => {
    const booking = makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        additionalPaymentIntentId: "pi_additional_pending",
        additionalAmountCents: 3000,
        additionalPaymentStatus: "PENDING",
        transactions: [
          {
            id: "txn_primary",
            paymentId: "payment_1",
            kind: "PRIMARY",
            source: "STRIPE",
            stripePaymentIntentId: "pi_primary_captured",
            amountCents: 10000,
            refundedAmountCents: 0,
            status: "SUCCEEDED",
            paymentMethodId: "pm_123",
            reason: null,
            createdAt: new Date("2026-05-01T00:00:00Z"),
            updatedAt: new Date("2026-05-01T00:00:00Z"),
          },
          {
            id: "txn_additional",
            paymentId: "payment_1",
            kind: "ADDITIONAL",
            source: "STRIPE",
            stripePaymentIntentId: "pi_additional_pending",
            amountCents: 3000,
            refundedAmountCents: 0,
            status: "PENDING",
            paymentMethodId: null,
            reason: "date_change",
            createdAt: new Date("2026-05-02T00:00:00Z"),
            updatedAt: new Date("2026-05-02T00:00:00Z"),
          },
        ],
      },
    });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "CANCELLED_IN_FLIGHT_PAYMENT"
    );
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "LATE_CAPTURE_AFTER_CANCELLATION"
    );
    expect(bookingReport.findings.map((finding) => finding.code)).not.toContain(
      "CANCELLED_BOOKING_OPEN_INVOICE"
    );

    const inFlightAction = bookingReport.actions.find(
      (action) => action.type === "REPAIR_CANCELLED_IN_FLIGHT_PAYMENT"
    );
    expect(inFlightAction?.payload).toMatchObject({
      paymentIntentIds: ["pi_additional_pending"],
    });

    const lateCaptureAction = bookingReport.actions.find(
      (action) => action.type === "AUTO_REFUND_LATE_CAPTURED_PAYMENT"
    );
    expect(lateCaptureAction?.payload).toMatchObject({
      paymentId: "payment_1",
      refundAmountCents: 10000,
    });
    // #1491: with no recorded cancellation-refund decision, the finding
    // surfaces but the refund is NEVER auto-applied — an operator confirms
    // late capture vs a deliberate 0%-tier policy retention first.
    expect(lateCaptureAction?.safeToAutoApply).toBe(false);
    const lateCaptureFinding = bookingReport.findings.find(
      (finding) => finding.code === "LATE_CAPTURE_AFTER_CANCELLATION"
    );
    expect(lateCaptureFinding?.safeToAutoApply).toBe(false);
  });

  it("offers no refund of a late capture a treasurer-approval task owns, open or kept (#3639 review F3)", async () => {
    const booking = makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        transactions: [
          {
            id: "txn_primary",
            paymentId: "payment_1",
            kind: "PRIMARY",
            source: "STRIPE",
            stripePaymentIntentId: "pi_held",
            amountCents: 10000,
            refundedAmountCents: 0,
            status: "SUCCEEDED",
            paymentMethodId: "pm_123",
            reason: "cancelled_booking_late_capture",
            createdAt: new Date("2026-05-01T00:00:00Z"),
            updatedAt: new Date("2026-05-01T00:00:00Z"),
          },
        ],
      },
    });
    // The loader asks for every approval task on the booking, any status: an
    // OPEN one is waiting for a treasurer, a DISMISSED one was kept.
    const deps = createDependencies({
      bookings: [booking],
      lateCaptureApprovalTasks: [
        { bookingId: booking.id, lateCaptureApprovalIntentId: "pi_held" },
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((f) => f.code)).not.toContain(
      "LATE_CAPTURE_AFTER_CANCELLATION"
    );
    expect(
      bookingReport.actions.some((a) => a.type === "AUTO_REFUND_LATE_CAPTURED_PAYMENT")
    ).toBe(false);

    // CONTROL: the same booking with no approval task still reports it.
    const control = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: createDependencies({ bookings: [booking] }),
      scope: { all: true },
    });
    expect(control.passes[0].bookings[0].findings.map((f) => f.code)).toContain(
      "LATE_CAPTURE_AFTER_CANCELLATION"
    );
  });

  /**
   * #3635 (owner and orchestrator decisions 29 Sep 2026, `INV-PAY-110`): a late
   * capture a treasurer KEPT - the booking's own payment, or a change payment on
   * a booking Xero never invoiced - is recorded by its own kept-capture invoice
   * for the GROSS capture, anchored on the approval task, dated the capture day.
   * The dismissal queues it; this queues one nobody queued, automatically, and
   * the pass re-reads the task under its row lock before it does.
   */
  describe("a kept late capture recorded by its own invoice (#3635)", () => {
    const RAISED_AT = new Date("2026-05-01T00:05:00Z");
    const keptBooking = (
      payment: Record<string, unknown> = {},
      capture: Record<string, unknown> = {},
    ) =>
      makeBooking({
        status: "CANCELLED",
        payment: {
          ...makeBooking().payment,
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          amountCents: 10000,
          refundedAmountCents: 0,
          status: "SUCCEEDED",
          transactions: [
            {
              id: "txn_primary",
              paymentId: "payment_1",
              kind: "PRIMARY",
              source: "STRIPE",
              stripePaymentIntentId: "pi_kept",
              amountCents: 10000,
              refundedAmountCents: 0,
              status: "SUCCEEDED",
              paymentMethodId: "pm_123",
              reason: "cancelled_booking_late_capture",
              createdAt: new Date("2026-05-01T00:00:00Z"),
              updatedAt: new Date("2026-05-01T00:00:00Z"),
              ...capture,
            },
          ],
          ...payment,
        },
      });
    const keptOperation = (status: string) => ({
      id: "op_kept_invoice",
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "ManualRefundTask",
      localId: "task_kept",
      status,
      queueType: "KEPT_LATE_CAPTURE_INVOICE",
      requestPayload: {
        queueType: "KEPT_LATE_CAPTURE_INVOICE",
        bookingId: "booking_1",
        manualRefundTaskId: "task_kept",
        paymentIntentId: "pi_kept",
        capturedCents: 10000,
        capturedOn: "2026-05-01",
      },
      replayable: true,
      manuallyResolvedAt: null,
      createdAt: new Date("2026-05-02T00:00:00Z"),
      updatedAt: new Date("2026-05-02T00:00:00Z"),
    });
    const run = async (
      booking: ReturnType<typeof makeBooking>,
      status: string,
      operations: unknown[] = [],
    ) => {
      const deps = createDependencies({
        bookings: [booking],
        operations,
        lateCaptureApprovalTasks: [
          {
            id: "task_kept",
            bookingId: booking.id,
            lateCaptureApprovalIntentId: "pi_kept",
            status,
            createdAt: RAISED_AT,
          },
        ],
      });
      const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
        dependencies: deps,
        scope: { all: true },
      });
      return { bookingReport: report.passes[0].bookings[0], deps };
    };
    const keptFinding = (bookingReport: { findings: { code: string }[] }) =>
      bookingReport.findings.find(
        (finding) => finding.code === "KEPT_LATE_CAPTURE_WITHOUT_XERO_INVOICE",
      );

    it("queues the kept invoice automatically, for the gross capture, anchored on the task, dated from its raise", async () => {
      const { bookingReport } = await run(keptBooking(), "DISMISSED");

      expect(keptFinding(bookingReport)).toMatchObject({
        safeToAutoApply: true,
        details: expect.objectContaining({
          manualRefundTaskId: "task_kept",
          paymentIntentId: "pi_kept",
          capturedCents: 10000,
        }),
      });
      expect(
        bookingReport.actions.find((a) => a.type === "QUEUE_KEPT_LATE_CAPTURE_INVOICE"),
      ).toMatchObject({
        safeToAutoApply: true,
        payload: {
          manualRefundTaskId: "task_kept",
          bookingId: "booking_1",
          paymentIntentId: "pi_kept",
          capturedCents: 10000,
          capturedAt: RAISED_AT.toISOString(),
        },
      });
    });

    it("records the gross even when the capture was refunded in the dashboard since (its refund is its own note)", async () => {
      const refunded = keptBooking(
        { refundedAmountCents: 10000, status: "REFUNDED" },
        { refundedAmountCents: 10000, status: "REFUNDED" },
      );
      expect(keptFinding((await run(refunded, "DISMISSED")).bookingReport)).toMatchObject({
        details: expect.objectContaining({ capturedCents: 10000 }),
      });
    });

    it("covers a kept change payment on a booking Xero never invoiced (review F3), not one on an invoiced booking", async () => {
      const change = keptBooking({}, { kind: "ADDITIONAL", amountCents: 2500 });
      expect(keptFinding((await run(change, "DISMISSED")).bookingReport)).toMatchObject({
        details: expect.objectContaining({ captureKind: "ADDITIONAL", capturedCents: 2500 }),
      });
      const invoiced = keptBooking(
        { xeroInvoiceId: "inv_primary" },
        { kind: "ADDITIONAL", amountCents: 2500 },
      );
      expect(keptFinding((await run(invoiced, "DISMISSED")).bookingReport)).toBeUndefined();
    });

    it("reports nothing while the treasurer decides, after an approved refund, or once queued", async () => {
      for (const status of ["OPEN", "COMPLETED"]) {
        expect(keptFinding((await run(keptBooking(), status)).bookingReport)).toBeUndefined();
      }
      for (const status of ["PENDING", "RUNNING", "SUCCEEDED"]) {
        const { bookingReport } = await run(keptBooking(), "DISMISSED", [keptOperation(status)]);
        expect(keptFinding(bookingReport)).toBeUndefined();
      }
    });

    it("asks again once a row was withdrawn (CANCELLED), and offers a failed one for retry instead", async () => {
      const withdrawn = await run(keptBooking(), "DISMISSED", [keptOperation("CANCELLED")]);
      expect(keptFinding(withdrawn.bookingReport)).toBeDefined();

      const failed = await run(keptBooking(), "DISMISSED", [keptOperation("FAILED")]);
      expect(keptFinding(failed.bookingReport)).toBeUndefined();
      expect(
        failed.bookingReport.actions.find((a) => a.type === "REQUEUE_XERO_OPERATION"),
      ).toBeDefined();
    });

    // #3635 composition (`INV-INT-025`): an officer recorded the kept payment by
    // hand in Xero and resolved the failed row. Done: never re-run, never queued
    // again, and still reported at info level.
    it("gives the info finding for a kept invoice resolved in Xero, and neither retries nor re-queues it", async () => {
      for (const status of ["FAILED", "PARTIAL"]) {
        const resolved = {
          ...keptOperation(status),
          manuallyResolvedAt: new Date("2026-05-03T00:00:00Z"),
          manuallyResolvedReason: "Invoice raised by hand in Xero",
        };
        const { bookingReport } = await run(keptBooking(), "DISMISSED", [resolved]);
        expect(keptFinding(bookingReport)).toBeUndefined();
        expect(bookingReport.actions.find((a) => a.type === "REQUEUE_XERO_OPERATION")).toBeUndefined();
        expect(
          bookingReport.actions.find((a) => a.type === "QUEUE_KEPT_LATE_CAPTURE_INVOICE"),
        ).toBeUndefined();
        expect(
          bookingReport.findings.find((finding) => finding.code === "RESOLVED_IN_XERO_BY_OFFICER"),
        ).toMatchObject({
          severity: "info",
          safeToAutoApply: false,
          details: expect.objectContaining({ operationId: "op_kept_invoice", paymentIntentId: "pi_kept" }),
        });
      }
    });

    // #3635 round-3 N1: an invoice raised before a reopen and approval whose
    // Stripe payment never recorded is still offered its payment retry.
    it("offers the payment retry of a raised kept invoice even once the task was reopened and approved", async () => {
      const partial = { ...keptOperation("PARTIAL"), xeroObjectId: "inv_kept" };
      const { bookingReport } = await run(keptBooking(), "COMPLETED", [partial]);
      expect(bookingReport.actions.find((a) => a.type === "REQUEUE_XERO_OPERATION")).toBeDefined();
      expect(
        bookingReport.findings.find(
          (finding) =>
            finding.code === "BLOCKED_BY_XERO_OPERATION" &&
            (finding.details as { operationId?: string }).operationId === "op_kept_invoice",
        ),
      ).toBeDefined();
      // A FAILED one before its invoice was raised is not: the approval withdrew it.
      const failed = await run(keptBooking(), "COMPLETED", [keptOperation("FAILED")]);
      expect(failed.bookingReport.actions.find((a) => a.type === "REQUEUE_XERO_OPERATION")).toBeUndefined();
    });

    // #3635 round-3 R5: the app raises no refund note for a receipt an officer
    // recorded by hand, so once it is refunded an officer is told to record
    // that refund by hand too. Report-only.
    it("asks for the refund to be recorded by hand once a kept invoice resolved by hand is refunded", async () => {
      const resolved = {
        ...keptOperation("FAILED"),
        manuallyResolvedAt: new Date("2026-05-03T00:00:00Z"),
        manuallyResolvedReason: "Raised by hand in Xero",
      };
      const byHand = (report: { findings: { code: string }[] }) =>
        report.findings.find((finding) => finding.code === "KEPT_LATE_CAPTURE_REFUND_RECORD_BY_HAND");

      const refunded = keptBooking(
        { refundedAmountCents: 10000, status: "REFUNDED" },
        { refundedAmountCents: 10000, status: "REFUNDED" },
      );
      const { bookingReport } = await run(refunded, "COMPLETED", [resolved]);
      expect(byHand(bookingReport)).toMatchObject({
        severity: "warning",
        safeToAutoApply: false,
        details: expect.objectContaining({ paymentIntentId: "pi_kept", refundedCents: 10000 }),
      });
      expect(bookingReport.actions).toEqual([]);

      expect(byHand((await run(keptBooking(), "DISMISSED", [resolved])).bookingReport)).toBeUndefined();
    });

    it("applies it on a transaction of its own, where the enqueue re-reads the task under its lock", async () => {
      const booking = keptBooking();
      const deps = createDependencies({
        bookings: [booking],
        lateCaptureApprovalTasks: [
          {
            id: "task_kept",
            bookingId: booking.id,
            lateCaptureApprovalIntentId: "pi_kept",
            status: "DISMISSED",
            createdAt: RAISED_AT,
          },
        ],
      });
      await runBookingXeroRepair(CLUB_FORMAT_TEST, {
        dependencies: deps,
        scope: { all: true },
        apply: true,
      });
      expect(deps.prisma.$transaction).toHaveBeenCalled();
      expect(deps.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          manualRefundTaskId: "task_kept",
          capturedCents: 10000,
          capturedOn: "2026-05-01",
          store: expect.anything(),
        }),
      );
    });
  });

  it("raises no late-capture finding when the cancel recorded a credit-path refund decision (#1491)", async () => {
    // Tiered credit-method cancel: 50% of the captured value went back as a
    // cancellation credit; the remainder is the deliberate policy penalty.
    const base = makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        transactions: [
          {
            id: "txn_primary",
            paymentId: "payment_1",
            kind: "PRIMARY",
            source: "STRIPE",
            stripePaymentIntentId: "pi_primary_captured",
            amountCents: 10000,
            refundedAmountCents: 0,
            status: "SUCCEEDED",
            paymentMethodId: "pm_123",
            reason: null,
            createdAt: new Date("2026-05-01T00:00:00Z"),
            updatedAt: new Date("2026-05-01T00:00:00Z"),
          },
        ],
      },
    });
    const booking = {
      ...base,
      creditsFromCancellation: [
        {
          id: "credit_cancel",
          amountCents: 5000,
          type: "CANCELLATION_REFUND",
          description: `Cancellation refund for booking ${base.id.slice(0, 8)}`,
          xeroCreditNoteId: null,
          createdAt: new Date("2026-05-03T00:00:00Z"),
        },
      ],
    };
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).not.toContain(
      "LATE_CAPTURE_AFTER_CANCELLATION"
    );
    expect(
      bookingReport.actions.some(
        (action) => action.type === "AUTO_REFUND_LATE_CAPTURED_PAYMENT"
      )
    ).toBe(false);
  });

  it("raises no late-capture finding when the cancel recorded a card-path refund recovery operation (#1491)", async () => {
    const booking = makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        amountCents: 10000,
        refundedAmountCents: 5000,
        status: "PARTIALLY_REFUNDED",
        transactions: [
          {
            id: "txn_primary",
            paymentId: "payment_1",
            kind: "PRIMARY",
            source: "STRIPE",
            stripePaymentIntentId: "pi_primary_captured",
            amountCents: 10000,
            refundedAmountCents: 5000,
            status: "PARTIALLY_REFUNDED",
            paymentMethodId: "pm_123",
            reason: null,
            createdAt: new Date("2026-05-01T00:00:00Z"),
            updatedAt: new Date("2026-05-03T00:00:00Z"),
          },
        ],
      },
    });
    const deps = createDependencies({
      bookings: [booking],
      cancellationRefundRecoveryOperations: [
        {
          id: "recovery_cancel",
          bookingId: booking.id,
          status: "SUCCEEDED",
          amountCents: 5000,
          createdAt: new Date("2026-05-03T00:00:00Z"),
        },
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).not.toContain(
      "LATE_CAPTURE_AFTER_CANCELLATION"
    );
    // The loader queries by the EXACT booking-cancel idempotency key, so
    // modification/refund-request recovery ops can never alias in as evidence.
    expect(deps.prisma.paymentRecoveryOperation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          idempotencyKey: {
            in: [`booking_cancel_refund_recovery_${booking.id}`],
          },
        },
      })
    );
  });

  it("keeps the late-capture finding when the only recovery operation is terminally FAILED (#1491)", async () => {
    // A FAILED (retry-exhausted) recovery op is a decision whose money never
    // moved — it must NOT suppress the finding.
    const booking = makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        transactions: [
          {
            id: "txn_primary",
            paymentId: "payment_1",
            kind: "PRIMARY",
            source: "STRIPE",
            stripePaymentIntentId: "pi_primary_captured",
            amountCents: 10000,
            refundedAmountCents: 0,
            status: "SUCCEEDED",
            paymentMethodId: "pm_123",
            reason: null,
            createdAt: new Date("2026-05-01T00:00:00Z"),
            updatedAt: new Date("2026-05-01T00:00:00Z"),
          },
        ],
      },
    });
    const deps = createDependencies({
      bookings: [booking],
      cancellationRefundRecoveryOperations: [
        {
          id: "recovery_failed",
          bookingId: booking.id,
          status: "FAILED",
          amountCents: 10000,
          createdAt: new Date("2026-05-03T00:00:00Z"),
        },
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    const finding = bookingReport.findings.find(
      (item) => item.code === "LATE_CAPTURE_AFTER_CANCELLATION"
    );
    expect(finding).toBeDefined();
    expect(finding?.safeToAutoApply).toBe(false);
  });

  it("raises no late-capture finding when the CANCELLED event carries a policy snapshot (#1491)", async () => {
    // The one artifact every paid-path cancel writes — including 0%-tier
    // retentions, which mint no credit and enqueue no recovery op.
    const booking = {
      ...makeBooking({
        status: "CANCELLED",
        payment: {
          ...makeBooking().payment,
          amountCents: 10000,
          refundedAmountCents: 0,
          status: "SUCCEEDED",
          transactions: [
            {
              id: "txn_primary",
              paymentId: "payment_1",
              kind: "PRIMARY",
              source: "STRIPE",
              stripePaymentIntentId: "pi_primary_captured",
              amountCents: 10000,
              refundedAmountCents: 0,
              status: "SUCCEEDED",
              paymentMethodId: "pm_123",
              reason: null,
              createdAt: new Date("2026-05-01T00:00:00Z"),
              updatedAt: new Date("2026-05-01T00:00:00Z"),
            },
          ],
        },
      }),
      events: [
        {
          id: "evt_cancelled",
          type: "CANCELLED",
          snapshot: {
            policySummary: "Cancelled 2 day(s) before check-in: no refund was due.",
            refundMethod: "card",
            refundPercentage: 0,
            settledAmountCents: 0,
            retainedAmountCents: 10000,
          },
          occurredAt: new Date("2026-05-03T00:00:00Z"),
        },
      ],
    };
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).not.toContain(
      "LATE_CAPTURE_AFTER_CANCELLATION"
    );
  });

  it("still raises the late-capture finding when the only snapshot is a settlement marker (#3638)", async () => {
    // A settlement-conflict marker is a CANCELLED event WITH a snapshot, but it
    // records no refund decision, so it must not pass for one.
    const booking = {
      ...makeBooking({
        status: "CANCELLED",
        payment: {
          ...makeBooking().payment,
          amountCents: 10000,
          refundedAmountCents: 0,
          status: "SUCCEEDED",
          transactions: [
            {
              id: "txn_primary",
              paymentId: "payment_1",
              kind: "PRIMARY",
              source: "STRIPE",
              stripePaymentIntentId: "pi_primary_captured",
              amountCents: 10000,
              refundedAmountCents: 0,
              status: "SUCCEEDED",
              paymentMethodId: "pm_123",
              reason: null,
              createdAt: new Date("2026-05-01T00:00:00Z"),
              updatedAt: new Date("2026-05-01T00:00:00Z"),
            },
          ],
        },
      }),
      events: [
        {
          id: "evt_marker",
          type: "CANCELLED",
          snapshot: {
            kind: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
            invoiceId: "inv_1",
            invoiceNumber: "INV-1",
            bookingStatus: "PAID",
            settledBySource: "STRIPE",
            settledByPaymentIntentId: "pi_primary_captured",
          },
          occurredAt: new Date("2026-05-02T00:00:00Z"),
        },
      ],
    };
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "LATE_CAPTURE_AFTER_CANCELLATION"
    );
  });

  it("reports --apply-action keys that matched no planned action (#1491)", async () => {
    const booking = makeBooking();
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      applyActionKeys: ["late-capture-refund:booking_1:payment_1:99999"],
      dependencies: deps,
      scope: { all: true },
    });

    expect(report.summary.unmatchedForcedActionKeys).toEqual([
      "late-capture-refund:booking_1:payment_1:99999",
    ]);
  });

  it("marks only the outstanding cancelled transaction failed during apply mode", async () => {
    const booking = makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        amountCents: 10000,
        refundedAmountCents: 10000,
        status: "REFUNDED",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        additionalPaymentIntentId: "pi_additional_pending",
        additionalAmountCents: 3000,
        additionalPaymentStatus: "PENDING",
        transactions: [
          {
            id: "txn_primary",
            paymentId: "payment_1",
            kind: "PRIMARY",
            source: "STRIPE",
            stripePaymentIntentId: "pi_primary_refunded",
            amountCents: 10000,
            refundedAmountCents: 10000,
            status: "REFUNDED",
            paymentMethodId: "pm_123",
            reason: null,
            createdAt: new Date("2026-05-01T00:00:00Z"),
            updatedAt: new Date("2026-05-01T00:00:00Z"),
          },
          {
            id: "txn_additional",
            paymentId: "payment_1",
            kind: "ADDITIONAL",
            source: "STRIPE",
            stripePaymentIntentId: "pi_additional_pending",
            amountCents: 3000,
            refundedAmountCents: 0,
            status: "PENDING",
            paymentMethodId: null,
            reason: "guest_add",
            createdAt: new Date("2026-05-02T00:00:00Z"),
            updatedAt: new Date("2026-05-02T00:00:00Z"),
          },
        ],
      },
    });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    expect(deps.markPaymentIntentTransactionFailed).toHaveBeenCalledWith({
      paymentIntentId: "pi_additional_pending",
    });
    expect(booking.payment.status).toBe("REFUNDED");
    expect(booking.payment.additionalPaymentStatus).toBe("FAILED");
    expect(report.summary.bookingsWithFindings).toBe(0);
  });

  // The cancelled booking with two late captures the repair refunds.
  const lateCaptureRefundBooking = () =>
    makeBooking({
        status: "CANCELLED",
        payment: {
          ...makeBooking().payment,
          amountCents: 13000,
          refundedAmountCents: 0,
          status: "SUCCEEDED",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          additionalPaymentIntentId: "pi_additional_captured",
          additionalAmountCents: 3000,
          additionalPaymentStatus: "SUCCEEDED",
          transactions: [
            {
              id: "txn_primary",
              paymentId: "payment_1",
              kind: "PRIMARY",
              source: "STRIPE",
              stripePaymentIntentId: "pi_primary_captured",
              amountCents: 10000,
              refundedAmountCents: 0,
              status: "SUCCEEDED",
              paymentMethodId: "pm_123",
              reason: null,
              createdAt: new Date("2026-05-01T00:00:00Z"),
              updatedAt: new Date("2026-05-01T00:00:00Z"),
            },
            {
              id: "txn_additional",
              paymentId: "payment_1",
              kind: "ADDITIONAL",
              source: "STRIPE",
              stripePaymentIntentId: "pi_additional_captured",
              amountCents: 3000,
              refundedAmountCents: 0,
              status: "SUCCEEDED",
              paymentMethodId: null,
              reason: "date_change",
              createdAt: new Date("2026-05-02T00:00:00Z"),
              updatedAt: new Date("2026-05-02T00:00:00Z"),
            },
          ],
        },
    });

  it("refunds cancelled late captures through the shared multi-intent refund helper", async () => {
    const booking = lateCaptureRefundBooking();
    const deps = createDependencies({ bookings: [booking] });

    // #1491: the late-capture refund is never auto-applied — a plain --apply
    // run must leave the money untouched...
    const untouchedReport = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });
    expect(deps.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(untouchedReport.summary.bookingsWithFindings).toBe(1);

    // ...and executes only when the operator confirms the EXACT action key
    // from the dry-run report (--apply-action).
    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      applyActionKeys: ["late-capture-refund:booking_1:payment_1:13000"],
      dependencies: deps,
      scope: { all: true },
    });

    expect(deps.refundPaymentTransactions).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST,
      paymentId: "payment_1",
      amountCents: 13000,
      // #3639 delta D1: pinned, newest first, to the captures it names.
      allocation: [
        { paymentTransactionId: "txn_additional", amountCents: 3000 },
        { paymentTransactionId: "txn_primary", amountCents: 10000 },
      ],
      reason: "requested_by_customer",
      metadata: {
        bookingId: "booking_1",
        reason: "cancelled_booking_late_capture_repair",
      },
      idempotencyKeyPrefix: "late_cancel_refund_repair_booking_1",
    });
    expect(booking.payment.status).toBe("REFUNDED");
    expect(report.summary.bookingsWithFindings).toBe(0);
  });

  it("says it recorded the refund only for the intents whose record was written, and queued only a note that was queued (#3635 N4)", async () => {
    const booking = lateCaptureRefundBooking();
    const deps = createDependencies({ bookings: [booking] });
    (deps.recordAndNoteRepairedLateCaptureRefunds as ReturnType<typeof vi.fn>).mockResolvedValue({
      recordFailed: ["pi_primary_captured"],
      doubleRefundSuspected: [],
      noted: [],
      alreadyNoted: ["pi_additional_captured"],
      noteFailed: [],
      byHand: [],
      notInXero: [],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      applyActionKeys: ["late-capture-refund:booking_1:payment_1:13000"],
      dependencies: deps,
      scope: { all: true },
    });
    const action = report.passes
      .flatMap((pass) => pass.bookings.flatMap((bookingReport) => bookingReport.actions))
      .find((item) => item.key === "late-capture-refund:booking_1:payment_1:13000");

    // No note was queued, so the action is not "queued".
    expect(action?.status).toBe("applied");
    expect(action?.resultMessage).toContain(
      "Recorded the refund of pi_additional_captured as the webhook does."
    );
    expect(action?.resultMessage).not.toContain("pi_primary_captured as the webhook does");
    expect(action?.resultMessage).toContain("Could not record the refund of pi_primary_captured");
    expect(action?.resultMessage).toContain(
      "The Xero refund credit note for pi_additional_captured was already raised, so none was queued."
    );
    expect(action?.resultMessage).not.toContain("Queued the Xero refund credit note");
  });

  it("names a suspected double payment the record found, and reports queued only for a queued note (#3635 N4)", async () => {
    const booking = lateCaptureRefundBooking();
    const deps = createDependencies({ bookings: [booking] });
    (deps.recordAndNoteRepairedLateCaptureRefunds as ReturnType<typeof vi.fn>).mockResolvedValue({
      recordFailed: [],
      doubleRefundSuspected: ["pi_primary_captured"],
      noted: ["pi_additional_captured"],
      alreadyNoted: [],
      noteFailed: ["pi_primary_captured"],
      byHand: [],
      notInXero: [],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      applyActionKeys: ["late-capture-refund:booking_1:payment_1:13000"],
      dependencies: deps,
      scope: { all: true },
    });
    const action = report.passes
      .flatMap((pass) => pass.bookings.flatMap((bookingReport) => bookingReport.actions))
      .find((item) => item.key === "late-capture-refund:booking_1:payment_1:13000");

    expect(action?.status).toBe("queued");
    expect(action?.resultMessage).toContain(
      "hand-completed the refund task for pi_primary_captured while this refund ran, so the member may have been paid twice"
    );
    expect(action?.resultMessage).toContain(
      "Queued the Xero refund credit note against the payment's own Xero receipt for pi_additional_captured."
    );
    expect(action?.resultMessage).toContain(
      "Could not queue the Xero refund credit note for pi_primary_captured: raise it by hand in Xero."
    );
  });

  it("never refunds a HELD capture's money through the partial path: the refund is pinned to the unheld one (#3639 delta D1)", async () => {
    // X: an older outstanding capture, 40.00, no task. Y: a newer late capture,
    // 60.00, held by a treasurer-approval task. Newest-first would send the
    // 40.00 against Y.
    const capture = (id: string, pi: string, amountCents: number, day: string) => ({
      id,
      paymentId: "payment_1",
      kind: "PRIMARY",
      source: "STRIPE",
      stripePaymentIntentId: pi,
      amountCents,
      refundedAmountCents: 0,
      status: "SUCCEEDED",
      paymentMethodId: "pm_123",
      reason: null,
      createdAt: new Date(`2026-05-0${day}T00:00:00Z`),
      updatedAt: new Date(`2026-05-0${day}T00:00:00Z`),
    });
    const booking = makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        amountCents: 10000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        transactions: [
          capture("txn_x", "pi_x", 4000, "1"),
          capture("txn_y", "pi_y_held", 6000, "2"),
        ],
      },
    });
    const deps = createDependencies({
      bookings: [booking],
      lateCaptureApprovalTasks: [
        { bookingId: booking.id, lateCaptureApprovalIntentId: "pi_y_held" },
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      applyActionKeys: ["late-capture-refund:booking_1:payment_1:4000"],
      dependencies: deps,
      scope: { all: true },
    });

    expect(deps.refundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 4000,
        allocation: [{ paymentTransactionId: "txn_x", amountCents: 4000 }],
      })
    );
    const [x, y] = booking.payment.transactions as any[];
    expect(x.refundedAmountCents).toBe(4000);
    // The held capture is untouched, so the treasurer's decision still stands.
    expect(y.refundedAmountCents).toBe(0);
    expect(report.passes[0].bookings[0].actions).toContainEqual(
      expect.objectContaining({ type: "AUTO_REFUND_LATE_CAPTURED_PAYMENT", status: "applied" })
    );
    // And the next scan offers nothing more: the rest is the held capture's.
    const rescan = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });
    expect(
      rescan.passes[0].bookings[0].actions.some(
        (a: any) => a.type === "AUTO_REFUND_LATE_CAPTURED_PAYMENT"
      )
    ).toBe(false);
  });

  it("keeps Xero consistent when a multi-slice late-capture refund fails partway, then notes only the remainder on re-run (#1495)", async () => {
    // Two captured Stripe slices on a cancelled booking with a linked invoice:
    // the newer 6000c slice refunds and records first; the older 7000c slice
    // fails at Stripe on the first attempt. The refund credit note MUST cover
    // the 6000 that actually moved even though the overall action fails, and a
    // later re-run for the 7000 remainder must add a note for exactly 7000 —
    // never re-noting the 6000 and never noting the full 13000.
    // Loosely typed like the rest of this harness: makeBooking's base literal
    // widens transactions to never[] and xeroRefundCreditNoteId to null, which
    // this fixture deliberately populates/mutates.
    const booking: any = makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        amountCents: 13000,
        refundedAmountCents: 0,
        status: "SUCCEEDED",
        additionalPaymentIntentId: "pi_newer_slice",
        additionalAmountCents: 6000,
        additionalPaymentStatus: "SUCCEEDED",
        transactions: [
          {
            id: "txn_older",
            paymentId: "payment_1",
            kind: "PRIMARY",
            source: "STRIPE",
            stripePaymentIntentId: "pi_older_slice",
            amountCents: 7000,
            refundedAmountCents: 0,
            status: "SUCCEEDED",
            paymentMethodId: "pm_123",
            reason: null,
            createdAt: new Date("2026-05-01T00:00:00Z"),
            updatedAt: new Date("2026-05-01T00:00:00Z"),
          },
          {
            id: "txn_newer",
            paymentId: "payment_1",
            kind: "ADDITIONAL",
            source: "STRIPE",
            stripePaymentIntentId: "pi_newer_slice",
            amountCents: 6000,
            refundedAmountCents: 0,
            status: "SUCCEEDED",
            paymentMethodId: null,
            reason: "date_change",
            createdAt: new Date("2026-05-02T00:00:00Z"),
            updatedAt: new Date("2026-05-02T00:00:00Z"),
          },
        ],
      },
    });
    // Provide the PRIMARY_INVOICE link so no field/link backfill action fires;
    // the only forced action this run is the late-capture refund.
    const primaryInvoiceLink = {
      id: "link_primary_invoice",
      localModel: "Payment",
      localId: "payment_1",
      xeroObjectType: "INVOICE",
      xeroObjectId: "inv_primary",
      xeroObjectNumber: "INV-001",
      xeroObjectUrl: null,
      role: "PRIMARY_INVOICE",
      active: true,
      metadata: null,
      createdAt: new Date("2026-05-01T00:00:00Z"),
      updatedAt: new Date("2026-05-01T00:00:00Z"),
    };
    const deps = createDependencies({
      bookings: [booking],
      links: [primaryInvoiceLink],
    });

    // Mirror the real system: once a refund credit note is queued for a
    // payment it becomes a resolvable REFUND_CREDIT_NOTE, so the classifier's
    // separate "missing refund credit note" arm stops re-detecting it. Without
    // this the spy would leave the payment note-less forever and that safe arm
    // would re-fire every pass, obscuring the late-capture behavior under test.
    deps.enqueueXeroRefundCreditNoteOperation = vi
      .fn()
      .mockImplementation(async () => {
        booking.payment.xeroRefundCreditNoteId = "cn_refund";
        return { queueOperationId: "queue_refund_credit", message: "queued" };
      });

    // Fail the older slice at Stripe on the first attempt (after the newer
    // slice has refunded and recorded); succeed on the re-run.
    let failOlderSlice = true;
    deps.refundPaymentTransactions = vi
      .fn()
      .mockImplementation(async ({ amountCents }: { amountCents: number }) => {
        const refundable = [...(booking.payment.transactions ?? [])]
          .filter((transaction: any) =>
            isCapturedTransactionStatus(transaction.status)
          )
          .filter(
            (transaction: any) =>
              transaction.amountCents - transaction.refundedAmountCents > 0
          )
          .sort(
            (left: any, right: any) =>
              new Date(right.createdAt).getTime() -
              new Date(left.createdAt).getTime()
          );

        const refunds: Array<{
          paymentIntentId: string;
          refundId: string;
          amountCents: number;
        }> = [];
        let completedRefundCents = 0;
        let remainingAmountCents = amountCents;

        for (const transaction of refundable) {
          if (remainingAmountCents <= 0) {
            break;
          }
          if (transaction.id === "txn_older" && failOlderSlice) {
            // The already-refunded newer slice is carried on the error so the
            // repair can note exactly what moved (#1097 PartialRefundError).
            throw new PartialRefundError({
              format: CLUB_FORMAT_TEST,
              completedRefundCents,
              refunds,
              cause: new Error("card_declined"),
            });
          }
          const sliceAmountCents = Math.min(
            remainingAmountCents,
            transaction.amountCents - transaction.refundedAmountCents
          );
          transaction.refundedAmountCents += sliceAmountCents;
          transaction.status =
            transaction.refundedAmountCents >= transaction.amountCents
              ? "REFUNDED"
              : "PARTIALLY_REFUNDED";
          refunds.push({
            paymentIntentId: transaction.stripePaymentIntentId,
            refundId: `re_${transaction.stripePaymentIntentId}`,
            amountCents: sliceAmountCents,
          });
          completedRefundCents += sliceAmountCents;
          remainingAmountCents -= sliceAmountCents;
        }

        if (remainingAmountCents > 0) {
          throw new Error("Refund amount exceeds captured Stripe payments");
        }
        recomputePaymentSummary(booking.payment);
        return { refunds, totalRefundedAmountCents: amountCents };
      });

    // First run: force the full 13000 late-capture refund. The older slice
    // fails, so the action fails — but the 6000 that refunded must still be
    // recorded and noted (#3635 C2: per capture, never payment-wide).
    const firstReport = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      applyActionKeys: ["late-capture-refund:booking_1:payment_1:13000"],
      dependencies: deps,
      scope: { all: true },
    });

    expect(deps.refundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "payment_1", amountCents: 13000 })
    );
    expect(deps.recordAndNoteRepairedLateCaptureRefunds).toHaveBeenCalledWith({
      bookingId: "booking_1",
      paymentId: "payment_1",
      refunds: [
        { paymentIntentId: "pi_newer_slice", refundId: "re_pi_newer_slice", amountCents: 6000 },
      ],
      format: CLUB_FORMAT_TEST,
    });

    const firstRunActions = firstReport.passes.flatMap((pass) =>
      pass.bookings.flatMap((bookingReport) => bookingReport.actions)
    );
    const failedLateCapture = firstRunActions.find(
      (action) => action.key === "late-capture-refund:booking_1:payment_1:13000"
    );
    expect(failedLateCapture?.status).toBe("failed");

    // Re-run after the older slice recovers: the outstanding amount is now only
    // 7000, so the operator forces the remainder key.
    failOlderSlice = false;
    const secondReport = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      applyActionKeys: ["late-capture-refund:booking_1:payment_1:7000"],
      dependencies: deps,
      scope: { all: true },
    });

    expect(deps.refundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "payment_1", amountCents: 7000 })
    );
    // Each capture is recorded and noted once: the completed 6000 slice, then
    // the 7000 remainder, and never the full 13000 (#3635 C2).
    const recorded = (
      deps.recordAndNoteRepairedLateCaptureRefunds as ReturnType<typeof vi.fn>
    ).mock.calls.map(([args]) =>
      (args as { refunds: { paymentIntentId: string; amountCents: number }[] }).refunds.map(
        (refund) => [refund.paymentIntentId, refund.amountCents]
      )
    );
    expect(recorded).toEqual([[["pi_newer_slice", 6000]], [["pi_older_slice", 7000]]]);
    // The late-capture arm's payment-wide note, which named the cleared
    // invoice, is never raised for either slice. (The classifier's separate
    // missing-refund-note arm may still ask for the payment's whole refunded
    // total; the real enqueue caps that at the note-eligible cash, which
    // leaves a recorded late capture out.)
    expect(
      (deps.enqueueXeroRefundCreditNoteOperation as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[0] === "payment_1" && (call[1] === 6000 || call[1] === 7000)
      )
    ).toEqual([]);

    // The remainder refund succeeded and the payment is fully refunded.
    expect(booking.payment.status).toBe("REFUNDED");
    expect(secondReport.summary.bookingsWithFindings).toBe(0);
  });

  // #2868. The report header is how an operator checks they swept what they
  // meant to, so it has to echo their answer, not a re-derivation of it. It
  // used to run the scope's local-midnight `Date` back through
  // `formatDateOnly` — the canonical DATE-ONLY encoder, which its own docblock
  // says is not for an instant — so under the `TZ=Pacific/Auckland` server pin
  // a sweep asked for 1-31 July printed `from=2026-06-30, to=2026-07-30`,
  // agreeing with the equally wrong window it was actually running.
  it("echoes the operator's own --from/--to days in the report scope", async () => {
    const deps = createDependencies({ bookings: [] });

    const report = await withTimeZoneAsync("Pacific/Auckland", () =>
      runBookingXeroRepair(CLUB_FORMAT_TEST, {
        dependencies: deps,
        scope: { from: "2026-07-01", to: "2026-07-31" },
      })
    );

    expect(report.scope.from).toBe("2026-07-01");
    expect(report.scope.to).toBe("2026-07-31");
    expect(report.scope.all).toBe(false);
    expect(formatBookingXeroRepairHumanSummary(report)).toContain(
      "Scope: booking=all, from=2026-07-01, to=2026-07-31"
    );
  });
});

/**
 * #3187 (epic #2797): THE REPAIR TOOL AND A BOOKING EDIT PRICED BY A FINANCIAL
 * REVIEW.
 *
 * A parked edit commits its structural change and leaves the money unresolved,
 * so the `BookingModification` row it writes carries `priceDiffCents: 0` and
 * `changeFeeCents: 0` BY CONSTRUCTION. The settled amount lives on the review
 * tasks. The supplementary-invoice arm gated on the modification row's net, so
 * for exactly the bookings this epic creates the arm never ran.
 *
 * Widening the gate alone would have been worse than the silence, and the
 * harness above is what proves it: the queued action is built from the same
 * numbers the gate reads, so an action carrying a net of 0 is refused by the
 * enqueue's net guard. That is a CRITICAL finding, marked safe to auto-apply,
 * whose action does nothing.
 */
describe("runBookingXeroRepair - booking edits priced by a financial review (#3187)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** The `BookingModification` a parked edit writes: zero on both components. */
  function parkedModification(overrides: Record<string, unknown> = {}) {
    return {
      id: "mod_parked",
      bookingId: "booking_1",
      modificationType: "GUEST_REMOVE",
      priceDiffCents: 0,
      changeFeeCents: 0,
      createdAt: new Date("2026-05-02T00:00:00Z"),
      ...overrides,
    };
  }

  /** A stored `reviewContext`, as `parseEditFinancialReviewContext` requires it. */
  function reviewContext(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      occurrence: {
        bookingId: "booking_1",
        bookingGuestId: "guest_1",
        cause: "NO_STORED_NIGHT_PRICES",
        surrenderedNightDates: ["2026-06-10"],
        addedNightDates: [],
        storedEvidence: { guestTotalCents: null, nightPrices: [] },
      },
      guestMemberId: "member_1",
      bookingCheckIn: "2026-06-10",
      bookingCheckOut: "2026-06-12",
      bookingModificationId: "mod_parked",
      ...overrides,
    };
  }

  /** One COMPLETED review task settled as money owed to the club. */
  function settledShare(overrides: Record<string, unknown> = {}) {
    return {
      id: "task_1",
      bookingId: "booking_1",
      amountCents: 4000,
      reviewContext: reviewContext(),
      ...overrides,
    };
  }

  /**
   * The combined `ADDITIONAL` charge request an edit's settled review shares
   * mint - one row per EDIT, never one per share (#3170), which is why the
   * repair tool can read this edit's payment state off a single row.
   */
  function reviewChargeTransaction(overrides: Record<string, unknown> = {}) {
    return {
      id: "txn_review",
      paymentId: "payment_1",
      kind: "ADDITIONAL",
      source: "STRIPE",
      stripePaymentIntentId: "pi_review",
      amountCents: 4000,
      refundedAmountCents: 0,
      status: "PENDING",
      paymentMethodId: "pm_123",
      reason: "edit_financial_review_charge_mod_parked",
      createdAt: new Date("2026-05-02T01:00:00Z"),
      updatedAt: new Date("2026-05-02T01:00:00Z"),
      ...overrides,
    };
  }

  /** A parked edit whose payment carries exactly that one charge request. */
  function bookingWithReviewCharge(overrides: Record<string, unknown> = {}) {
    const basePayment = makeBooking().payment;
    return makeBooking({
      modifications: [parkedModification()],
      payment: {
        ...basePayment,
        transactions: [reviewChargeTransaction(overrides)],
      },
    });
  }

  /** The recovery row a FAILED intent mint leaves behind (#3170). */
  function intentMintRecovery(overrides: Record<string, unknown> = {}) {
    return {
      bookingId: "booking_1",
      idempotencyKey:
        "edit_financial_review_additional_intent_recovery_mod_parked",
      status: "PENDING",
      ...overrides,
    };
  }

  function supplementaryLink(amountCents: number | null) {
    return {
      id: "link_supp",
      localModel: "BookingModification",
      localId: "mod_parked",
      xeroObjectType: "INVOICE",
      xeroObjectId: "inv_supp",
      xeroObjectNumber: "INV-SUPP",
      xeroObjectUrl: null,
      role: "SUPPLEMENTARY_INVOICE",
      active: true,
      metadata: amountCents === null ? null : { amountCents },
      createdAt: new Date("2026-05-03T00:00:00Z"),
      updatedAt: new Date("2026-05-03T00:00:00Z"),
    };
  }

  /**
   * Every code this arm can raise about an edit's supplementary invoice.
   *
   * The controls assert on THIS set rather than on "no findings at all": the
   * shared `makeBooking` fixture leaves the payment's PRIMARY_INVOICE link
   * unbacked, so an unrelated `XERO_LINK_MISMATCH` is always present and
   * asserting emptiness would make a control pass or fail for the wrong reason.
   */
  const SUPPLEMENTARY_INVOICE_FINDING_CODES = [
    "MISSING_SUPPLEMENTARY_INVOICE",
    "XERO_AMOUNT_MISMATCH",
    "BLOCKED_BY_XERO_OPERATION",
  ];

  function supplementaryFindingCodes(report: {
    passes: { bookings: { findings: { code: string }[] }[] }[];
  }) {
    return report.passes[0].bookings[0].findings
      .map((finding) => finding.code)
      .filter((code) => SUPPLEMENTARY_INVOICE_FINDING_CODES.includes(code));
  }

  it("finds a review-priced edit whose supplementary invoice is missing, and QUEUES it for the settled total", async () => {
    const booking = makeBooking({ modifications: [parkedModification()] });
    const deps = createDependencies({
      bookings: [booking],
      // Two shares on ONE edit, which is the shape #3170's owner decision
      // created: they contribute to a single request for the combined total.
      editReviewChargeShares: [
        settledShare({ id: "task_1", amountCents: 4000 }),
        settledShare({ id: "task_2", amountCents: 2000 }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    const finding = report.passes[0].bookings[0].findings.find(
      (candidate) => candidate.code === "MISSING_SUPPLEMENTARY_INVOICE"
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("critical");
    expect(finding?.details).toMatchObject({
      modificationId: "mod_parked",
      netAmountCents: 6000,
      editReviewChargeCents: 6000,
    });

    // THE POINT OF THE ISSUE: the action must actually run. The harness
    // reproduces the enqueue's net guard, so a payload built from the
    // modification row's own zeros would come back `skipped` with "No
    // supplementary invoice is required".
    const action = report.passes[0].bookings[0].actions.find(
      (candidate) => candidate.type === "QUEUE_SUPPLEMENTARY_INVOICE"
    );
    expect(action?.status).toBe("queued");
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingModificationId: "mod_parked",
        priceDiffCents: 6000,
        changeFeeCents: 0,
      }),
      expect.anything()
    );
  });

  it("raises the repaired invoice UNPAID when the review is collected by internet banking", async () => {
    const booking = makeBooking({ modifications: [parkedModification()] });
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [settledShare()],
    });

    await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    // No `ADDITIONAL` charge request exists, so the invoice IS the ask and
    // nothing has been paid. Recording a Stripe payment against it would assert
    // money the club does not hold.
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recordPayment: false,
        waitForConfirmedAdditionalPayment: false,
      })
    );
  });

  it("records payment on the repaired invoice once the review's card charge has been captured", async () => {
    const booking = bookingWithReviewCharge({ status: "SUCCEEDED" });
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [settledShare()],
    });

    await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recordPayment: true,
        // Already captured, so there is nothing left to wait for. A
        // WAITING_PAYMENT operation queued after its own release has run would
        // never be released.
        waitForConfirmedAdditionalPayment: false,
        paymentIntentId: "pi_review",
      })
    );
  });

  it("parks the repaired invoice on an outstanding review card request instead of pre-recording it", async () => {
    const booking = bookingWithReviewCharge({ status: "PENDING" });
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [settledShare()],
    });

    await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        waitForConfirmedAdditionalPayment: true,
        paymentIntentId: "pi_review",
      })
    );
  });

  it("reports a sent supplementary invoice that is SHORT of the settled total, and does not auto-apply it", async () => {
    const booking = makeBooking({ modifications: [parkedModification()] });
    const deps = createDependencies({
      bookings: [booking],
      // The invoice went out billing the FIRST share only - #3170's documented
      // residual, where a share settles after the ask has left the building.
      links: [supplementaryLink(4000)],
      editReviewChargeShares: [
        settledShare({ id: "task_1", amountCents: 4000 }),
        settledShare({ id: "task_2", amountCents: 2000 }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const finding = report.passes[0].bookings[0].findings.find(
      (candidate) => candidate.code === "XERO_AMOUNT_MISMATCH"
    );
    expect(finding).toBeDefined();
    expect(finding?.safeToAutoApply).toBe(false);
    expect(finding?.details).toMatchObject({
      expectedAmountCents: 6000,
      editReviewChargeCents: 6000,
    });
    expect(finding?.details.mismatches).toEqual([
      expect.objectContaining({ amountCents: 4000 }),
    ]);
  });

  it("does NOT record payment when the card took LESS than the settled total - it routes the shortfall to a person", async () => {
    /**
     * The failure this closes, end to end. Two shares, $40 and $20. The first
     * settles and mints a $40 request; the member pays it in the window before
     * the second share syncs, so that sync returns `already-paid` and records
     * the uncollected $20 as an audit row. Both tasks are COMPLETED, so the ask
     * derives to $60 while the ledger row is SUCCEEDED at $40.
     *
     * Deciding `recordPayment` from the row's STATUS alone queued a $60 invoice
     * AND booked a $60 Stripe receipt for it. The club holds $40: the clearing
     * account overstates by $20, the invoice reads paid in full, and the member
     * still owes $20 that nothing chases.
     */
    const booking = bookingWithReviewCharge({
      status: "SUCCEEDED",
      amountCents: 4000,
    });
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [
        settledShare({ id: "task_1", amountCents: 4000 }),
        settledShare({ id: "task_2", amountCents: 2000 }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    const finding = report.passes[0].bookings[0].findings.find(
      (candidate) => candidate.code === "MISSING_SUPPLEMENTARY_INVOICE"
    );
    expect(finding?.severity).toBe("manual_review");
    expect(finding?.safeToAutoApply).toBe(false);
    expect(finding?.details).toMatchObject({
      netAmountCents: 6000,
      editReviewChargeCents: 6000,
      capturedAmountCents: 4000,
      editReviewPaymentReason: "capture-short-of-ask",
    });
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();
  });

  it("raises NOTHING for a review charge an officer WITHDREW (#3528, INV-ADDPAY-040)", async () => {
    /**
     * The withdrawal cancelled the intent, failed the row and stamped it. Read
     * as an ordinary FAILED request with an intent, the plan would queue a
     * fresh supplementary invoice parked WAITING_PAYMENT on a cancelled intent
     * - a held document for a debt that was withdrawn, until the reaper
     * retired it. The withdrawal is the record; the repair pass says nothing.
     */
    const booking = bookingWithReviewCharge({
      status: "FAILED",
      withdrawnAt: new Date("2026-05-04T00:00:00Z"),
    });
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [settledShare()],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    expect(supplementaryFindingCodes(report)).toEqual([]);
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();
  });

  it("CONTROL: the same FAILED request NOT withdrawn still parks an invoice on its intent", async () => {
    const booking = bookingWithReviewCharge({ status: "FAILED", withdrawnAt: null });
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [settledShare()],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    expect(supplementaryFindingCodes(report)).toEqual(["MISSING_SUPPLEMENTARY_INVOICE"]);
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      expect.objectContaining({ bookingModificationId: "mod_parked" }),
      expect.objectContaining({
        waitForConfirmedAdditionalPayment: true,
        paymentIntentId: "pi_review",
      }),
    );
  });

  it("defers when the review's card request was never minted and its recovery is still owed", async () => {
    /**
     * "No charge request row" has TWO causes that look identical in the ledger
     * and need opposite handling: the internet-banking route (raise it unpaid,
     * covered above) and a PaymentIntent mint that failed at the provider. The
     * live settlement queues NOTHING in the second case and leaves it to the
     * recovery replay; a repair run that raised an unpaid invoice there would
     * claim the anchor the replay needs, and nothing would ever mark that
     * invoice paid once the card cleared - the release only touches
     * WAITING_PAYMENT operations, and this one would be COMPLETED.
     */
    const booking = makeBooking({ modifications: [parkedModification()] });
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [settledShare()],
      editReviewChargeIntentRecoveries: [intentMintRecovery()],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    const finding = report.passes[0].bookings[0].findings.find(
      (candidate) => candidate.code === "MISSING_SUPPLEMENTARY_INVOICE"
    );
    expect(finding?.severity).toBe("manual_review");
    expect(finding?.safeToAutoApply).toBe(false);
    expect(finding?.details).toMatchObject({
      editReviewPaymentReason: "intent-mint-awaiting-recovery",
    });
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();
  });

  it("CONTROL: a TERMINALLY FAILED intent recovery does not defer the repair forever", async () => {
    // Nothing will replay a FAILED row, so holding the invoice off it would be
    // permanent silence. The #1491 cancellation arm treats FAILED the same way.
    const booking = makeBooking({ modifications: [parkedModification()] });
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [settledShare()],
      editReviewChargeIntentRecoveries: [intentMintRecovery({ status: "FAILED" })],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    const finding = report.passes[0].bookings[0].findings.find(
      (candidate) => candidate.code === "MISSING_SUPPLEMENTARY_INVOICE"
    );
    expect(finding?.severity).toBe("critical");
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recordPayment: false })
    );
  });

  it("CONTROL: a share raised on one booking cannot price ANOTHER booking's edit", async () => {
    /**
     * The anchor is read out of a stored JSON context, and a context naming a
     * modification on a different booking must contribute to nothing. Summing
     * the sweep's shares globally instead of per booking would let this one row
     * conjure a $50 invoice against booking two, which nobody settled.
     */
    const basePayment = makeBooking().payment;
    const bookingOne = makeBooking({
      modifications: [parkedModification({ id: "mod_parked_1" })],
    });
    const bookingTwo = makeBooking({
      id: "booking_2",
      payment: {
        ...basePayment,
        id: "payment_2",
        xeroInvoiceId: "inv_primary_2",
        xeroInvoiceNumber: "INV-002",
      },
      modifications: [
        parkedModification({ id: "mod_parked_2", bookingId: "booking_2" }),
      ],
    });
    const deps = createDependencies({
      bookings: [bookingOne, bookingTwo],
      editReviewChargeShares: [
        settledShare({
          id: "task_cross",
          bookingId: "booking_1",
          amountCents: 5000,
          reviewContext: reviewContext({
            bookingModificationId: "mod_parked_2",
          }),
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    for (const bookingReport of report.passes[0].bookings) {
      expect(bookingReport.findings.map((finding) => finding.code)).not.toContain(
        "MISSING_SUPPLEMENTARY_INVOICE"
      );
    }
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();
  });

  it("CONTROL: a review that is fully invoiced raises no finding", async () => {
    const booking = makeBooking({ modifications: [parkedModification()] });
    const deps = createDependencies({
      bookings: [booking],
      links: [supplementaryLink(6000)],
      editReviewChargeShares: [
        settledShare({ id: "task_1", amountCents: 4000 }),
        settledShare({ id: "task_2", amountCents: 2000 }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    expect(supplementaryFindingCodes(report)).toEqual([]);
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();
  });

  it("CONTROL: a parked edit with no settled review share raises no finding", async () => {
    const booking = makeBooking({ modifications: [parkedModification()] });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    expect(supplementaryFindingCodes(report)).toEqual([]);
  });

  it("CONTROL: a share whose stored context names no edit contributes to nothing", async () => {
    const booking = makeBooking({ modifications: [parkedModification()] });
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [
        // A raise that had no modification row to point at, and a context
        // written by a shape this parser refuses. Neither may be attributed to
        // some edit anyway - guessing which one is the failure this epic exists
        // to refuse.
        settledShare({
          id: "task_anchorless",
          reviewContext: reviewContext({ bookingModificationId: null }),
        }),
        settledShare({ id: "task_unreadable", reviewContext: { version: 2 } }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    expect(supplementaryFindingCodes(report)).toEqual([]);
  });

  it("releases a repaired invoice it parked on a card the member paid WHILE the sweep was running", async () => {
    /**
     * The window this closes. The plan is decided from the snapshot the loader
     * took when the pass started; the enqueue happens minutes later. A member
     * paying in between fires the webhook's release, which finds no
     * WAITING_PAYMENT operation because none exists yet and does nothing - and
     * then the sweep parks one on a confirmation that has already been and
     * gone. Nothing else ever looks at it: the release runs only from the
     * webhook and the confirm route, and the stale reaper matches only a failed
     * transaction or a 14-day-old row, neither of which a succeeded intent is.
     *
     * The cost of leaving it: the club holds the money with no Xero invoice,
     * and the NEXT run reads the anchor as BLOCKED_BY_XERO_OPERATION at warning
     * severity, "waiting for its additional Stripe payment" - the tool
     * concealing the finding it exists to raise, for a fortnight.
     */
    const booking = bookingWithReviewCharge({ status: "PENDING" });
    // `makeBooking`'s literal leaves `transactions` an empty array, so the
    // element type widens to `never`; the row itself is the fixture above.
    const request: any = booking.payment.transactions[0];
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [settledShare()],
      onSupplementaryInvoiceEnqueue: () => {
        request.status = "SUCCEEDED";
      },
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    // Parked, correctly, on what the snapshot said...
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        waitForConfirmedAdditionalPayment: true,
        paymentIntentId: "pi_review",
      })
    );
    // ...and then freed, because by the time it was queued the card had paid.
    expect(
      deps.releaseXeroSupplementaryInvoiceOperationsForPaymentIntent
    ).toHaveBeenCalledWith("pi_review");

    const action = report.passes[0].bookings[0].actions.find(
      (candidate) => candidate.type === "QUEUE_SUPPLEMENTARY_INVOICE"
    );
    expect(action?.status).toBe("queued");
    expect(action?.resultMessage).toContain("released for sending");
  });

  it("CONTROL: an outstanding card request that is STILL outstanding is left parked, not released", async () => {
    // The ordinary arrangement, and the one the release must never touch: the
    // member has not paid, so the invoice waits for the webhook exactly as the
    // live edit path's own does.
    const booking = bookingWithReviewCharge({ status: "PENDING" });
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [settledShare()],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ waitForConfirmedAdditionalPayment: true })
    );
    expect(
      deps.releaseXeroSupplementaryInvoiceOperationsForPaymentIntent
    ).not.toHaveBeenCalled();
    const action = report.passes[0].bookings[0].actions.find(
      (candidate) => candidate.type === "QUEUE_SUPPLEMENTARY_INVOICE"
    );
    expect(action?.status).toBe("queued");
  });

  it("does NOT release a mid-sweep capture that came up SHORT of the settled total", async () => {
    /**
     * The same race, with the shortfall behind it: the card took $40 against an
     * ask of $60. Releasing would send the $60 invoice AND book a $60 Stripe
     * receipt for it - the overstatement the classify-time arm already refuses,
     * arriving by a different door. It stays parked and goes to a person.
     */
    const booking = bookingWithReviewCharge({
      status: "PENDING",
      amountCents: 4000,
    });
    // `makeBooking`'s literal leaves `transactions` an empty array, so the
    // element type widens to `never`; the row itself is the fixture above.
    const request: any = booking.payment.transactions[0];
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [
        settledShare({ id: "task_1", amountCents: 4000 }),
        settledShare({ id: "task_2", amountCents: 2000 }),
      ],
      onSupplementaryInvoiceEnqueue: () => {
        request.status = "SUCCEEDED";
      },
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    expect(
      deps.releaseXeroSupplementaryInvoiceOperationsForPaymentIntent
    ).not.toHaveBeenCalled();
    const action = report.passes[0].bookings[0].actions.find(
      (candidate) => candidate.type === "QUEUE_SUPPLEMENTARY_INVOICE"
    );
    expect(action?.status).toBe("manual_review");
    // #3533: the sweep's sentence states amounts, not the storage form.
    expect(action?.resultMessage).toContain("$40.00 against an ask of $60.00");
  });

  it("is idempotent: a second run over a repaired review-priced edit finds nothing", async () => {
    const booking = makeBooking({ modifications: [parkedModification()] });
    const state = {
      bookings: [booking],
      links: [] as any[],
      operations: [] as any[],
      editReviewChargeShares: [settledShare({ amountCents: 6000 })],
    };
    const deps = createDependencies(state);

    const firstRun = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });
    expect(firstRun.summary.bookingsWithFindings).toBe(0);
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledTimes(1);

    const secondRun = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });
    expect(secondRun.summary.bookingsWithFindings).toBe(0);
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledTimes(1);
  });
});

/**
 * #3199 (epic #2797): WHICH CAME FIRST, THE PRIMARY INVOICE OR THE EDIT?
 *
 * The supplementary-invoice arm used to ask only "is there a primary invoice
 * now, and is this edit's net positive". A booking whose card cleared but whose
 * primary invoice had not been minted yet - a Xero outage, or the ordinary
 * window between confirmation and the outbox running - gets its edit folded
 * into the primary invoice when that invoice is finally minted, because the
 * mint reads the booking as it then stands. The tool would still offer a
 * one-click supplementary invoice on top: $600 of income and a $50 receivable
 * nobody owes, on a $550 booking.
 *
 * The answer comes from the operation history, and only from there. Both
 * directions are pinned below, along with the two shapes that cannot be
 * answered at all - no successful create row, and a create row with no
 * completion instant - which report for manual review rather than billing.
 */
describe("runBookingXeroRepair - primary invoice vs edit timing (#3199)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A price increase of +3000 cents, committed on 2 May. */
  function priceIncreaseModification(overrides: Record<string, unknown> = {}) {
    return {
      id: "mod_timing",
      bookingId: "booking_1",
      modificationType: "GUEST_ADD",
      priceDiffCents: 2500,
      changeFeeCents: 500,
      createdAt: new Date("2026-05-02T00:00:00Z"),
      ...overrides,
    };
  }

  function supplementaryInvoiceFinding(report: {
    passes: {
      bookings: {
        findings: {
          code: string;
          severity: string;
          summary: string;
          safeToAutoApply: boolean;
          details: Record<string, unknown>;
        }[];
      }[];
    }[];
  }) {
    return report.passes[0].bookings[0].findings.find(
      (finding) => finding.code === "MISSING_SUPPLEMENTARY_INVOICE"
    );
  }

  it("offers the one-click fix when the primary invoice was raised BEFORE the edit", async () => {
    const booking = makeBooking({ modifications: [priceIncreaseModification()] });
    const deps = createDependencies({
      bookings: [booking],
      operations: [makePrimaryInvoiceCreateOperation()],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const finding = supplementaryInvoiceFinding(report);
    expect(finding?.severity).toBe("critical");
    expect(finding?.safeToAutoApply).toBe(true);
    expect(
      report.passes[0].bookings[0].actions.map((action) => action.type)
    ).toContain("QUEUE_SUPPLEMENTARY_INVOICE");
  });

  it("reports instead of billing when the primary invoice was raised AFTER the edit", async () => {
    const booking = makeBooking({ modifications: [priceIncreaseModification()] });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        // Minted on 3 May, a day AFTER the edit - so it billed the new total.
        makePrimaryInvoiceCreateOperation({
          startedAt: new Date("2026-05-03T00:00:00Z"),
          completedAt: new Date("2026-05-03T00:00:00Z"),
          createdAt: new Date("2026-05-03T00:00:00Z"),
          updatedAt: new Date("2026-05-03T00:00:00Z"),
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    const finding = supplementaryInvoiceFinding(report);
    expect(finding?.severity).toBe("manual_review");
    expect(finding?.safeToAutoApply).toBe(false);
    expect(finding?.summary).toContain("bill the same money twice");
    expect(finding?.details).toMatchObject({
      modificationId: "mod_timing",
      netAmountCents: 3000,
      primaryInvoiceTiming: "invoice-followed-edit",
      primaryInvoiceRaisedAt: "2026-05-03T00:00:00.000Z",
      primaryInvoiceOperationId: "operation_primary_invoice",
    });

    const actionTypes = report.passes[0].bookings[0].actions.map(
      (action) => action.type
    );
    expect(actionTypes).not.toContain("QUEUE_SUPPLEMENTARY_INVOICE");
    expect(actionTypes).toContain("MARK_MANUAL_REVIEW");
    // `--apply` was on. Reported is not the same as skipped, and neither is the
    // same as billed: nothing was queued at Xero.
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();
  });

  it("reports when NO operation row says the primary invoice was ever raised", async () => {
    const booking = makeBooking({ modifications: [priceIncreaseModification()] });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    const finding = supplementaryInvoiceFinding(report);
    expect(finding?.severity).toBe("manual_review");
    expect(finding?.details).toMatchObject({
      primaryInvoiceTiming: "unknown",
      primaryInvoiceTimingReason: "no-successful-create-operation",
    });
    expect(
      report.passes[0].bookings[0].actions.map((action) => action.type)
    ).not.toContain("QUEUE_SUPPLEMENTARY_INVOICE");
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();
  });

  it("reports when the create row carries no completion instant", async () => {
    const booking = makeBooking({ modifications: [priceIncreaseModification()] });
    const deps = createDependencies({
      bookings: [booking],
      operations: [makePrimaryInvoiceCreateOperation({ completedAt: null })],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    expect(supplementaryInvoiceFinding(report)?.details).toMatchObject({
      primaryInvoiceTiming: "unknown",
      primaryInvoiceTimingReason: "no-completion-timestamp",
    });
  });

  it("does not read ANOTHER invoice's create row as this one's", async () => {
    const booking = makeBooking({ modifications: [priceIncreaseModification()] });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        // A different Xero invoice on the same payment - an entrance fee, say.
        // It says nothing about when THIS booking's invoice was raised.
        makePrimaryInvoiceCreateOperation({
          id: "operation_other_invoice",
          xeroObjectId: "inv_other",
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    expect(supplementaryInvoiceFinding(report)?.details).toMatchObject({
      primaryInvoiceTiming: "unknown",
      primaryInvoiceTimingReason: "no-successful-create-operation",
    });
  });

  it("treats a same-instant raise as unproven rather than as invoice-first", async () => {
    const booking = makeBooking({ modifications: [priceIncreaseModification()] });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        makePrimaryInvoiceCreateOperation({
          completedAt: new Date("2026-05-02T00:00:00Z"),
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    expect(supplementaryInvoiceFinding(report)?.details).toMatchObject({
      primaryInvoiceTiming: "invoice-followed-edit",
    });
  });

  it("takes the EARLIEST completion, so a later re-assert cannot flip the answer", async () => {
    const booking = makeBooking({ modifications: [priceIncreaseModification()] });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        // `createXeroInvoiceForBooking` closes a re-driven operation SUCCEEDED
        // against the invoice that already exists, so a booking can carry a
        // SECOND successful create row for one invoice whenever the re-drive
        // was enqueued as a fresh operation. The mint is the earlier one.
        // (When the re-drive instead claims the ORIGINAL row - an operator
        // retry - there is no second row and no earlier instant left; that
        // case is pinned separately below.)
        makePrimaryInvoiceCreateOperation({
          id: "operation_primary_invoice_reassert",
          responsePayload: {
            skipped: true,
            reason: "Invoice already exists for this payment; link re-asserted.",
          },
          startedAt: new Date("2026-06-01T00:00:00Z"),
          completedAt: new Date("2026-06-01T00:00:00Z"),
          createdAt: new Date("2026-06-01T00:00:00Z"),
          updatedAt: new Date("2026-06-01T00:00:00Z"),
        }),
        makePrimaryInvoiceCreateOperation(),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    expect(supplementaryInvoiceFinding(report)?.severity).toBe("critical");
    expect(
      report.passes[0].bookings[0].actions.map((action) => action.type)
    ).toContain("QUEUE_SUPPLEMENTARY_INVOICE");
  });

  /**
   * THE BOUNDARY THIS GATE TURNS ON, guarded from the other side.
   *
   * A parked edit THAT ADDED NO GUEST leaves nothing on the booking for a later
   * primary invoice to bill: its money is on the review tasks, its stored
   * totals do not move, and the primary invoice bills guest-night lines and a
   * promo adjustment - nothing else. Note the qualifier, which the first
   * version of this test did not have: an added guest IS written onto the
   * booking at a real price even on a parked edit, so that shape is at risk and
   * is pinned by the two tests below. This one is the other side of the same
   * boundary.
   *
   * If the gate is ever widened to read the expected ask instead, this test
   * fails: every review-priced finding on a booking with no operation history
   * would become manual review, and #3187's whole point - that these bookings
   * get a one-click repair - would be undone silently.
   */
  it("CONTROL: a review-priced ask that added no guest is unaffected, even with no operation history at all", async () => {
    const booking = makeBooking({
      modifications: [
        priceIncreaseModification({
          id: "mod_parked_timing",
          priceDiffCents: 0,
          changeFeeCents: 0,
        }),
      ],
    });
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [
        {
          id: "task_timing",
          bookingId: "booking_1",
          amountCents: 6000,
          reviewContext: {
            version: 1,
            occurrence: {
              bookingId: "booking_1",
              bookingGuestId: "guest_1",
              cause: "NO_STORED_NIGHT_PRICES",
              surrenderedNightDates: ["2026-06-10"],
              addedNightDates: [],
              storedEvidence: { guestTotalCents: null, nightPrices: [] },
            },
            guestMemberId: "member_1",
            bookingCheckIn: "2026-06-10",
            bookingCheckOut: "2026-06-12",
            bookingModificationId: "mod_parked_timing",
          },
        },
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const finding = supplementaryInvoiceFinding(report);
    expect(finding?.severity).toBe("critical");
    expect(finding?.details).not.toHaveProperty("primaryInvoiceTiming");
    expect(
      report.passes[0].bookings[0].actions.map((action) => action.type)
    ).toContain("QUEUE_SUPPLEMENTARY_INVOICE");
  });

  /**
   * A PARKED EDIT THAT ADDED A GUEST - the live double-bill this gate missed
   * on its first pass (#3199 fix round).
   *
   * The edit's own row nets ZERO, because parking puts the money on the review
   * tasks. But an added guest is still written onto the booking with a real
   * `priceCents` and real priced nights - a guest who did not exist before can
   * always be priced at the current rate - and the primary invoice bills
   * `booking.guests[]`, not `booking.finalPriceCents`. So a primary invoice
   * minted AFTER this edit bills the added guest; the officer pricing the
   * review is told that amount "has not been charged" and includes it; and the
   * supplementary invoice then bills it a second time.
   *
   * Gating on the modification row's net alone read this as "nothing at risk"
   * and handed it a critical, auto-appliable one-click fix.
   */
  function parkedGuestAddModification(overrides: Record<string, unknown> = {}) {
    return priceIncreaseModification({
      id: "mod_parked_guest_add",
      modificationType: "BATCH_MODIFY",
      priceDiffCents: 0,
      changeFeeCents: 0,
      newData: {
        checkIn: "2026-06-10",
        checkOut: "2026-06-12",
        guestCount: 2,
        addedGuests: [{ firstName: "Bob", lastName: "Newcomer" }],
      },
      ...overrides,
    });
  }

  function parkedGuestAddShare() {
    return {
      id: "task_parked_guest_add",
      bookingId: "booking_1",
      amountCents: 15000,
      reviewContext: {
        version: 1,
        occurrence: {
          bookingId: "booking_1",
          bookingGuestId: "guest_1",
          cause: "NO_STORED_NIGHT_PRICES",
          surrenderedNightDates: ["2026-06-10"],
          addedNightDates: [],
          storedEvidence: { guestTotalCents: null, nightPrices: [] },
        },
        guestMemberId: "member_1",
        bookingCheckIn: "2026-06-10",
        bookingCheckOut: "2026-06-12",
        bookingModificationId: "mod_parked_guest_add",
      },
    };
  }

  it("reports instead of billing when a PARKED edit added a guest and the primary invoice was raised after it", async () => {
    const booking = makeBooking({
      modifications: [parkedGuestAddModification()],
    });
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [parkedGuestAddShare()],
      operations: [
        // Minted on 3 May, a day AFTER the edit - so it already billed the
        // added guest at their real price.
        makePrimaryInvoiceCreateOperation({
          startedAt: new Date("2026-05-03T00:00:00Z"),
          completedAt: new Date("2026-05-03T00:00:00Z"),
          createdAt: new Date("2026-05-03T00:00:00Z"),
          updatedAt: new Date("2026-05-03T00:00:00Z"),
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    const finding = supplementaryInvoiceFinding(report);
    expect(finding?.severity).toBe("manual_review");
    expect(finding?.safeToAutoApply).toBe(false);
    expect(finding?.details).toMatchObject({
      modificationId: "mod_parked_guest_add",
      primaryInvoiceTiming: "invoice-followed-edit",
      addedGuestCount: 1,
    });

    const actionTypes = report.passes[0].bookings[0].actions.map(
      (action) => action.type
    );
    expect(actionTypes).not.toContain("QUEUE_SUPPLEMENTARY_INVOICE");
    expect(actionTypes).toContain("MARK_MANUAL_REVIEW");
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();
  });

  it("still offers the one-click fix when a PARKED edit added a guest AFTER the primary invoice went out", async () => {
    const booking = makeBooking({
      modifications: [parkedGuestAddModification()],
    });
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [parkedGuestAddShare()],
      // Invoice on 1 May, edit on 2 May: the added guest is genuinely unbilled.
      operations: [makePrimaryInvoiceCreateOperation()],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    const finding = supplementaryInvoiceFinding(report);
    expect(finding?.severity).toBe("critical");
    expect(finding?.details).not.toHaveProperty("primaryInvoiceTiming");
    expect(
      report.passes[0].bookings[0].actions.map((action) => action.type)
    ).toContain("QUEUE_SUPPLEMENTARY_INVOICE");
  });

  it("reports a parked guest-adding edit with no operation history rather than billing it", async () => {
    const booking = makeBooking({
      modifications: [parkedGuestAddModification()],
    });
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [parkedGuestAddShare()],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    expect(supplementaryInvoiceFinding(report)?.details).toMatchObject({
      primaryInvoiceTiming: "unknown",
      primaryInvoiceTimingReason: "no-successful-create-operation",
      addedGuestCount: 1,
    });
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();
  });

  /**
   * A RE-ASSERT IS NOT A MINT (#3199 fix round).
   *
   * An operator retry claims the operation row ITSELF (`FAILED|PARTIAL ->
   * RUNNING`) - a retry this very tool offers as `RETRY_XERO_OPERATION` - and
   * when `createXeroInvoiceForBooking` finds the invoice already there it
   * closes that SAME row SUCCEEDED with `{ skipped: true }`, rewriting
   * `completedAt`. There is no earlier row left for "earliest wins" to find.
   *
   * The tool must not then state POSITIVELY that a supplementary invoice would
   * double-bill: the invoice really was raised first and the money really is
   * owed. "Cannot be established" is the honest answer, and it is the one that
   * sends an officer to look.
   */
  function reAssertedCompletion(overrides: Record<string, unknown> = {}) {
    return makePrimaryInvoiceCreateOperation({
      status: "SUCCEEDED",
      responsePayload: {
        skipped: true,
        reason: "Invoice already exists for this payment; link re-asserted.",
      },
      ...overrides,
    });
  }

  it("will not claim the invoice followed the edit when the only completion is a later re-assert", async () => {
    const booking = makeBooking({ modifications: [priceIncreaseModification()] });
    const deps = createDependencies({
      bookings: [booking],
      operations: [
        // Minted 1 May, retried 10 May: the retry rewrote completedAt on the
        // one and only row this invoice has.
        reAssertedCompletion({
          startedAt: new Date("2026-05-10T00:00:00Z"),
          completedAt: new Date("2026-05-10T00:00:00Z"),
          updatedAt: new Date("2026-05-10T00:00:00Z"),
        }),
      ],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    const finding = supplementaryInvoiceFinding(report);
    expect(finding?.severity).toBe("manual_review");
    expect(finding?.details).toMatchObject({
      primaryInvoiceTiming: "unknown",
      primaryInvoiceTimingReason: "only-re-asserted-completion",
    });
    // The false statement this replaces.
    expect(finding?.summary).not.toContain("bill the same money twice");
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();
  });

  it("still reads a re-assert that lands BEFORE the edit as proof the invoice came first", async () => {
    const booking = makeBooking({ modifications: [priceIncreaseModification()] });
    const deps = createDependencies({
      bookings: [booking],
      // An upper bound before the edit still bounds the mint before the edit.
      operations: [reAssertedCompletion()],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });

    expect(supplementaryInvoiceFinding(report)?.severity).toBe("critical");
    expect(
      report.passes[0].bookings[0].actions.map((action) => action.type)
    ).toContain("QUEUE_SUPPLEMENTARY_INVOICE");
  });
});

/**
 * #3635 (owner decision 28 Sep 2026, `INV-INT-025`): "Every repair path treats
 * a manually resolved operation as done and never offers to re-run it."
 *
 * Every arm that offers `REQUEUE_XERO_OPERATION` (auto-applied) is driven here
 * twice from ONE fixture: unresolved, the control, which must offer the retry;
 * and resolved in Xero, which must offer no retry, queue no rival document,
 * and report the officer's operation only as the info-level, action-free
 * RESOLVED_IN_XERO_BY_OFFICER finding (orchestrator decision 2) - or nothing,
 * where the document itself exists (the PARTIAL clearing note).
 */
describe("the missing-refund-note arm asks only for what a note may answer (#3635)", () => {
  const cancelledRefunded = () =>
    makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        source: "STRIPE",
        refundedAmountCents: 10000,
        status: "REFUNDED",
        transactions: [
          {
            id: "txn_late",
            paymentId: "payment_1",
            kind: "PRIMARY",
            source: "STRIPE",
            stripePaymentIntentId: "pi_late",
            amountCents: 10000,
            refundedAmountCents: 10000,
            status: "REFUNDED",
            paymentMethodId: "pm_123",
            reason: null,
            createdAt: new Date("2026-05-01T00:00:00Z"),
            updatedAt: new Date("2026-05-01T00:00:00Z"),
          },
        ],
      },
    });
  const classify = async (uncoveredCents: number) => {
    const deps = createDependencies({ bookings: [cancelledRefunded()] });
    deps.readRefundCreditNoteGap = vi.fn().mockResolvedValue({
      cashRefundCents: uncoveredCents,
      coveredCents: 0,
      resolvedInXeroCents: 0,
      uncoveredCents,
    });
    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: deps,
      scope: { all: true },
    });
    return { deps, booking: report.passes[0].bookings[0] };
  };

  it("raises no recurring critical finding for a refund of a late capture Xero never received", async () => {
    // The gap reader leaves that refund out of the note-eligible cash.
    const { deps, booking } = await classify(0);
    expect(deps.readRefundCreditNoteGap).toHaveBeenCalledWith({
      id: "payment_1",
      bookingId: "booking_1",
      refundedAmountCents: 10000,
    });
    expect(booking.findings.map((finding) => finding.code)).not.toContain(
      "CANCELLED_BOOKING_OPEN_INVOICE"
    );
    expect(booking.actions.map((action) => action.type)).not.toContain(
      "QUEUE_REFUND_CREDIT_NOTE"
    );
  });

  it("asks for exactly the uncovered note-eligible cash, never the raw refunded total", async () => {
    const { booking } = await classify(4000);
    expect(booking.actions).toContainEqual(
      expect.objectContaining({
        type: "QUEUE_REFUND_CREDIT_NOTE",
        key: "queue:refund-credit-note:payment_1:4000",
        payload: { paymentId: "payment_1", refundAmountCents: 4000 },
      })
    );
  });
});

describe("resolved in Xero is done on every repair retry arm (#3635)", () => {
  const RESOLVED_AT = new Date("2026-05-06T00:00:00Z");
  const cancelledCaptured = (paymentOverrides: Record<string, unknown>) =>
    makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        ...paymentOverrides,
        transactions: [
          {
            id: "txn_primary",
            paymentId: "payment_1",
            kind: "PRIMARY",
            source: "STRIPE",
            stripePaymentIntentId: "pi_123",
            amountCents: 10000,
            refundedAmountCents: (paymentOverrides.refundedAmountCents as number) ?? 0,
            status: (paymentOverrides.status as string) ?? "SUCCEEDED",
            paymentMethodId: "pm_123",
            reason: null,
            createdAt: new Date("2026-05-01T00:00:00Z"),
            updatedAt: new Date("2026-05-01T00:00:00Z"),
          },
        ],
      },
    });
  const clearingNoteLink = {
    id: "link_clearing_note",
    localModel: "Booking",
    localId: "booking_1",
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: "cn_clear",
    xeroObjectNumber: "CN-9",
    xeroObjectUrl: null,
    role: "MODIFICATION_CREDIT_NOTE",
    active: true,
    metadata: null,
    createdAt: new Date("2026-05-03T00:00:00Z"),
    updatedAt: new Date("2026-05-03T00:00:00Z"),
  };
  const modificationCreditNoteLink = {
    ...clearingNoteLink,
    id: "link_mod_note",
    localModel: "BookingModification",
    localId: "mod_down",
    xeroObjectId: "cn_mod",
    metadata: { amountCents: 3000 },
  };
  const priceDown = {
    id: "mod_down",
    bookingId: "booking_1",
    modificationType: "GUEST_REMOVE",
    priceDiffCents: -3000,
    changeFeeCents: 0,
    createdAt: new Date("2026-05-02T00:00:00Z"),
  };
  const cancelledUnpaid = () =>
    makeBooking({ status: "CANCELLED", payment: { ...makeBooking().payment, status: "FAILED" } });

  const scenarios: Array<{
    arm: string;
    booking: () => any;
    links?: any[];
    extraOperations?: any[];
    failed: Record<string, unknown>;
    rivalActionTypes: string[];
  }> = [
    {
      arm: "primary invoice",
      booking: () =>
        makeBooking({
          status: "PAID",
          payment: { ...makeBooking().payment, xeroInvoiceId: null, xeroInvoiceNumber: null },
        }),
      failed: { localModel: "Payment", localId: "payment_1", entityType: "INVOICE", operationType: "CREATE" },
      rivalActionTypes: ["QUEUE_PRIMARY_INVOICE"],
    },
    {
      arm: "primary invoice date update",
      booking: () =>
        makeBooking({
          checkIn: new Date("2026-05-30T00:00:00Z"),
          checkOut: new Date("2026-05-31T00:00:00Z"),
          modifications: [
            {
              id: "mod_date",
              bookingId: "booking_1",
              modificationType: "DATE_CHANGE",
              previousData: { checkIn: "2026-05-29", checkOut: "2026-05-30" },
              newData: { checkIn: "2026-05-30", checkOut: "2026-05-31" },
              priceDiffCents: 0,
              changeFeeCents: 0,
              createdAt: new Date("2026-05-02T00:00:00Z"),
            },
          ],
        }),
      failed: {
        localModel: "Payment",
        localId: "payment_1",
        entityType: "INVOICE",
        operationType: "UPDATE",
        createdAt: new Date("2026-05-03T00:00:00Z"),
      },
      rivalActionTypes: ["QUEUE_PRIMARY_INVOICE_UPDATE"],
    },
    {
      arm: "supplementary invoice",
      booking: () =>
        makeBooking({
          modifications: [
            {
              id: "mod_up",
              bookingId: "booking_1",
              modificationType: "DATE_CHANGE",
              priceDiffCents: 2500,
              changeFeeCents: 0,
              createdAt: new Date("2026-05-02T00:00:00Z"),
            },
          ],
        }),
      extraOperations: [makePrimaryInvoiceCreateOperation()],
      failed: {
        localModel: "BookingModification",
        localId: "mod_up",
        entityType: "INVOICE",
        operationType: "CREATE",
        requestPayload: {
          queueType: "SUPPLEMENTARY_INVOICE",
          bookingId: "booking_1",
          bookingModificationId: "mod_up",
          priceDiffCents: 2500,
          changeFeeCents: 0,
        },
      },
      rivalActionTypes: ["QUEUE_SUPPLEMENTARY_INVOICE"],
    },
    {
      arm: "modification credit note",
      booking: () => makeBooking({ modifications: [priceDown] }),
      failed: {
        localModel: "BookingModification",
        localId: "mod_down",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "booking_1",
          bookingModificationId: "mod_down",
          refundAmountCents: 3000,
        },
      },
      rivalActionTypes: ["QUEUE_MODIFICATION_CREDIT_NOTE"],
    },
    {
      arm: "modification credit note allocation",
      booking: () => makeBooking({ modifications: [priceDown] }),
      links: [modificationCreditNoteLink],
      failed: {
        localModel: "BookingModification",
        localId: "mod_down",
        entityType: "ALLOCATION",
        operationType: "ALLOCATE",
        requestPayload: {
          queueType: "CREDIT_NOTE_ALLOCATION",
          creditNoteId: "cn_mod",
          invoiceId: "inv_primary",
          amountCents: 3000,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        },
      },
      rivalActionTypes: ["QUEUE_CREDIT_NOTE_ALLOCATION"],
    },
    {
      arm: "cancelled open-invoice clearing note",
      booking: cancelledUnpaid,
      failed: {
        localModel: "Booking",
        localId: "booking_1",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        queueType: "MODIFICATION_CREDIT_NOTE",
        requestPayload: {
          queueType: "MODIFICATION_CREDIT_NOTE",
          bookingId: "booking_1",
          refundAmountCents: 10000,
          clearsUnpaidInvoice: true,
        },
      },
      rivalActionTypes: ["QUEUE_MODIFICATION_CREDIT_NOTE"],
    },
    {
      arm: "cancelled open-invoice PARTIAL clearing note",
      booking: cancelledUnpaid,
      links: [clearingNoteLink],
      failed: {
        localModel: "Booking",
        localId: "booking_1",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        status: "PARTIAL",
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "cn_clear",
        requestPayload: {
          invoiceId: "inv_primary",
          refundAmountCents: 10000,
          clearsUnpaidInvoice: true,
          allocations: [{ invoiceId: "inv_primary", amountCents: 10000 }],
        },
      },
      rivalActionTypes: ["QUEUE_CREDIT_NOTE_ALLOCATION"],
    },
    {
      arm: "cancelled open-invoice clearing allocation",
      booking: cancelledUnpaid,
      links: [clearingNoteLink],
      failed: {
        localModel: "Booking",
        localId: "booking_1",
        entityType: "ALLOCATION",
        operationType: "ALLOCATE",
        requestPayload: {
          queueType: "CREDIT_NOTE_ALLOCATION",
          creditNoteId: "cn_clear",
          invoiceId: "inv_primary",
          amountCents: 10000,
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        },
      },
      rivalActionTypes: ["QUEUE_CREDIT_NOTE_ALLOCATION"],
    },
    {
      arm: "cancelled booking account-credit note",
      booking: () => ({
        ...cancelledCaptured({}),
        creditsFromCancellation: [
          {
            id: "credit_cancel",
            amountCents: 5000,
            type: "CANCELLATION_REFUND",
            description: "Cancellation refund for booking booking_",
            xeroCreditNoteId: null,
            createdAt: new Date("2026-05-03T00:00:00Z"),
          },
        ],
      }),
      failed: {
        localModel: "Payment",
        localId: "payment_1",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        requestPayload: {
          queueType: "ACCOUNT_CREDIT_NOTE",
          paymentId: "payment_1",
          refundAmountCents: 5000,
        },
      },
      rivalActionTypes: ["QUEUE_ACCOUNT_CREDIT_NOTE"],
    },
    {
      arm: "cancelled booking cash-refund credit note",
      booking: () => cancelledCaptured({ refundedAmountCents: 10000, status: "REFUNDED" }),
      failed: {
        localModel: "Payment",
        localId: "payment_1",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          paymentId: "payment_1",
          refundAmountCents: 10000,
        },
      },
      rivalActionTypes: ["QUEUE_REFUND_CREDIT_NOTE"],
    },
  ];

  it.each(scenarios)("$arm", async (scenario) => {
    const failedOperation = (manuallyResolvedAt: Date | null) =>
      makeOperation({
        id: "operation_officer",
        status: "FAILED",
        xeroObjectType: null,
        xeroObjectId: null,
        lastErrorMessage: "Xero said no",
        ...scenario.failed,
        manuallyResolvedAt,
      });
    const classify = async (manuallyResolvedAt: Date | null) =>
      (
        await runBookingXeroRepair(CLUB_FORMAT_TEST, {
          dependencies: createDependencies({
            bookings: [scenario.booking()],
            links: [...(scenario.links ?? [])],
            operations: [...(scenario.extraOperations ?? []), failedOperation(manuallyResolvedAt)],
          }),
          scope: { all: true },
        })
      ).passes[0].bookings[0];

    // CONTROL: unresolved, the arm offers the auto-applied retry.
    const control = await classify(null);
    expect(control.actions).toContainEqual(
      expect.objectContaining({
        type: "REQUEUE_XERO_OPERATION",
        key: "retry:operation_officer",
        safeToAutoApply: true,
      })
    );

    const resolved = await classify(RESOLVED_AT);
    const types = resolved.actions.map((action) => action.type);
    expect(types).not.toContain("REQUEUE_XERO_OPERATION");
    for (const rival of scenario.rivalActionTypes) {
      expect(types).not.toContain(rival);
    }
    const aboutTheOfficersOperation = resolved.findings.filter(
      (finding) =>
        (finding.details as Record<string, unknown>)?.operationId === "operation_officer"
    );
    const documentExists = scenario.arm === "cancelled open-invoice PARTIAL clearing note";
    expect(aboutTheOfficersOperation).toEqual(
      documentExists
        ? []
        : [
            expect.objectContaining({
              code: "RESOLVED_IN_XERO_BY_OFFICER",
              severity: "info",
              safeToAutoApply: false,
              actions: [],
              details: expect.objectContaining({ manuallyResolvedAt: RESOLVED_AT }),
            }),
          ]
    );
  });

  it.each(["PENDING", "RUNNING"])(
    "a %s clearing allocation is reported as blocked, never queued beside",
    async (status) => {
      const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
        dependencies: createDependencies({
          bookings: [cancelledUnpaid()],
          links: [clearingNoteLink],
          operations: [
            makeOperation({
              id: "operation_live_allocation",
              localModel: "Booking",
              localId: "booking_1",
              entityType: "ALLOCATION",
              operationType: "ALLOCATE",
              status,
              xeroObjectType: null,
              xeroObjectId: null,
              requestPayload: {
                queueType: "CREDIT_NOTE_ALLOCATION",
                creditNoteId: "cn_clear",
                invoiceId: "inv_primary",
                amountCents: 10000,
                role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
              },
            }),
          ],
        }),
        scope: { all: true },
      });
      const bookingReport = report.passes[0].bookings[0];
      expect(bookingReport.actions.map((action) => action.type)).not.toContain(
        "QUEUE_CREDIT_NOTE_ALLOCATION"
      );
      expect(bookingReport.findings).toContainEqual(
        expect.objectContaining({
          code: "BLOCKED_BY_XERO_OPERATION",
          safeToAutoApply: false,
          actions: [],
          details: expect.objectContaining({ operationId: "operation_live_allocation" }),
        })
      );
    }
  );

  it("a resolved account-credit note does not answer for a missing refund note (#3635, claims F8)", async () => {
    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: createDependencies({
        bookings: [cancelledCaptured({ refundedAmountCents: 10000, status: "REFUNDED" })],
        operations: [
          makeOperation({
            id: "operation_account_credit_note",
            localModel: "Payment",
            localId: "payment_1",
            entityType: "CREDIT_NOTE",
            operationType: "CREATE",
            status: "FAILED",
            queueType: "ACCOUNT_CREDIT_NOTE",
            xeroObjectType: null,
            xeroObjectId: null,
            requestPayload: { queueType: "ACCOUNT_CREDIT_NOTE", paymentId: "payment_1" },
            manuallyResolvedAt: RESOLVED_AT,
          }),
        ],
      }),
      scope: { all: true },
    });
    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.actions.map((action) => action.type)).toContain(
      "QUEUE_REFUND_CREDIT_NOTE"
    );
    expect(bookingReport.findings.map((finding) => finding.code)).not.toContain(
      "RESOLVED_IN_XERO_BY_OFFICER"
    );
  });

  it("a resolved PARTIAL clearing note does not hide a separate live allocation failure (#3635, Xero F8)", async () => {
    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: createDependencies({
        bookings: [cancelledUnpaid()],
        links: [clearingNoteLink],
        operations: [
          makeOperation({
            id: "operation_resolved_partial_note",
            localModel: "Booking",
            localId: "booking_1",
            entityType: "CREDIT_NOTE",
            operationType: "CREATE",
            status: "PARTIAL",
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: "cn_clear",
            requestPayload: {
              invoiceId: "inv_primary",
              refundAmountCents: 10000,
              clearsUnpaidInvoice: true,
              allocations: [{ invoiceId: "inv_primary", amountCents: 10000 }],
            },
            manuallyResolvedAt: RESOLVED_AT,
          }),
          makeOperation({
            id: "operation_live_allocation",
            localModel: "Booking",
            localId: "booking_1",
            entityType: "ALLOCATION",
            operationType: "ALLOCATE",
            status: "FAILED",
            xeroObjectType: null,
            xeroObjectId: null,
            requestPayload: {
              queueType: "CREDIT_NOTE_ALLOCATION",
              creditNoteId: "cn_clear",
              invoiceId: "inv_primary",
              amountCents: 10000,
              role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
            },
          }),
        ],
      }),
      scope: { all: true },
    });
    const bookingReport = report.passes[0].bookings[0];
    // Seen, but report-only: the officer allocated by hand, so no retry.
    expect(bookingReport.findings).toContainEqual(
      expect.objectContaining({
        code: "BLOCKED_BY_XERO_OPERATION",
        safeToAutoApply: false,
        actions: [],
        details: expect.objectContaining({ operationId: "operation_live_allocation" }),
      })
    );
    const types = bookingReport.actions.map((action) => action.type);
    expect(types).not.toContain("REQUEUE_XERO_OPERATION");
    expect(types).not.toContain("QUEUE_CREDIT_NOTE_ALLOCATION");
  });

  it("a newer live failure is not hidden behind an older resolved one", async () => {
    const booking = makeBooking({
      status: "PAID",
      payment: { ...makeBooking().payment, xeroInvoiceId: null, xeroInvoiceNumber: null },
    });
    const invoiceCreate = (id: string, createdAt: string, manuallyResolvedAt: Date | null) =>
      makeOperation({
        id,
        localModel: "Payment",
        localId: "payment_1",
        entityType: "INVOICE",
        operationType: "CREATE",
        status: "FAILED",
        xeroObjectType: null,
        xeroObjectId: null,
        createdAt: new Date(createdAt),
        manuallyResolvedAt,
      });
    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: createDependencies({
        bookings: [booking],
        // The resolved row first: the pick used to take the first FAILED row
        // it met, so the live failure behind it was never offered.
        operations: [
          invoiceCreate("operation_old_resolved", "2026-05-02T00:00:00Z", RESOLVED_AT),
          invoiceCreate("operation_new_live", "2026-05-07T00:00:00Z", null),
        ],
      }),
      scope: { all: true },
    });
    const keys = report.passes[0].bookings[0].actions.map((action) => action.key);
    expect(keys).toContain("retry:operation_new_live");
    expect(keys).not.toContain("retry:operation_old_resolved");
  });
});

/**
 * #3827 review F1 (`INV-PAY-118`): a refund request's OWN note is never "the"
 * payment's refund note. Before the fix its succeeded create was a candidate,
 * so the tool proposed (auto-apply) pointing `xeroRefundCreditNoteId` at it -
 * after which the cancellation's note was absorbed as "already linked" - read
 * it as a conflict beside the real note, and hid a missing cancellation note.
 */
describe("a refund request's own note never answers for the payment's refund note (#3827)", () => {
  const cancelledInternetBanking = () =>
    makeBooking({
      status: "CANCELLED",
      payment: {
        ...makeBooking().payment,
        source: "INTERNET_BANKING",
        stripePaymentIntentId: null,
        stripePaymentMethodId: null,
        stripeCustomerId: null,
        refundedAmountCents: 10000,
        status: "REFUNDED",
      },
    });
  const requestNote = (overrides: Record<string, unknown> = {}) =>
    makeOperation({
      id: "operation_request_note",
      localModel: "Payment",
      localId: "payment_1",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      status: "SUCCEEDED",
      queueType: "REFUND_CREDIT_NOTE",
      correlationKey: "payment:payment_1:refund-request-credit-note:rr_1:v1",
      idempotencyKey: "payment:payment_1:refund-request-credit-note:rr_1:v1",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn_request",
      requestPayload: {
        queueType: "REFUND_CREDIT_NOTE",
        refundAmountCents: 3000,
        refundMethod: "internet-banking",
        refundRequestId: "rr_1",
      },
      ...overrides,
    });
  const requestLink = paymentLink({
    id: "link_request_note",
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: "cn_request",
    role: "REFUND_REQUEST_CREDIT_NOTE",
    metadata: { amountCents: 3000, refundRequestId: "rr_1" },
  });
  // The request's note may still be read back and settled as itself
  // (`unsettledRefundNoteRows`); no OTHER action may name it.
  const actionsNamingRequestNote = (actions: Array<{ type: string }>) =>
    actions.filter(
      (action) => action.type !== "SETTLE_REFUND_CREDIT_NOTE" && JSON.stringify(action).includes("cn_request")
    );
  const run = async (state: { operations: any[]; links?: any[]; payment?: Record<string, unknown> }) => {
    const booking = cancelledInternetBanking();
    Object.assign(booking.payment, state.payment ?? {});
    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, {
      dependencies: createDependencies({
        bookings: [booking],
        links: state.links ?? [requestLink],
        operations: [makePrimaryInvoiceCreateOperation(), ...state.operations],
      }),
      scope: { all: true },
    });
    return report.passes[0].bookings[0];
  };

  it("proposes nothing for the request's note, and reports the cancellation's note missing for review", async () => {
    const booking = await run({ operations: [requestNote()] });
    expect(booking.actions.map((action) => action.type)).not.toContain(
      "SYNC_PAYMENT_REFUND_CREDIT_NOTE_FIELD"
    );
    expect(actionsNamingRequestNote(booking.actions)).toEqual([]);
    expect(booking.findings.map((finding) => finding.summary)).not.toContain(
      "Refund credit note references conflict across local fields, links, or past operations."
    );
    // Not hidden, and not auto-sized: the refunded total holds the request's
    // refund too, so the cancellation note's amount goes to a person.
    expect(booking.findings).toContainEqual(
      expect.objectContaining({
        code: "MANUAL_REVIEW_REQUIRED",
        summary: expect.stringContaining("missing Xero refund note amount cannot be derived"),
      })
    );
    expect(booking.actions.map((action) => action.type)).not.toContain("QUEUE_REFUND_CREDIT_NOTE");
  });

  it("is no conflict beside the payment's real refund note", async () => {
    const booking = await run({
      operations: [requestNote()],
      payment: { xeroRefundCreditNoteId: "cn_cancel" },
      links: [
        requestLink,
        paymentLink({
          id: "link_cancel_note",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn_cancel",
          role: "REFUND_CREDIT_NOTE",
        }),
      ],
    });
    expect(booking.findings.map((finding) => finding.summary)).not.toContain(
      "Refund credit note references conflict across local fields, links, or past operations."
    );
    expect(booking.actions.map((action) => action.type)).not.toContain(
      "SYNC_PAYMENT_REFUND_CREDIT_NOTE_FIELD"
    );
  });

  it("names a request's row from its key alone when the payload is gone", async () => {
    const booking = await run({ operations: [requestNote({ requestPayload: null })] });
    expect(actionsNamingRequestNote(booking.actions)).toEqual([]);
  });

  // Review F1 at a19beb492: the refunded total net of each request's own note
  // is what the cancellation's note answers, so an appeal-only refund is no gap.
  const ambiguousNote = expect.objectContaining({
    code: "MANUAL_REVIEW_REQUIRED",
    summary: expect.stringContaining("missing Xero refund note amount cannot be derived"),
  });

  it("raises nothing when the request's note answers the whole refunded total", async () => {
    const booking = await run({ operations: [requestNote()], payment: { refundedAmountCents: 3000 } });
    expect(booking.findings).not.toContainEqual(ambiguousNote);
    expect(booking.actions.map((action) => action.type)).not.toContain("QUEUE_REFUND_CREDIT_NOTE");
  });

  it("recovers the request's amount from its link when the payload is gone", async () => {
    const booking = await run({
      operations: [requestNote({ requestPayload: null })],
      payment: { refundedAmountCents: 3000 },
    });
    expect(booking.findings).not.toContainEqual(ambiguousNote);
  });

  it("sends it to review when a request's amount cannot be recovered", async () => {
    const booking = await run({
      operations: [requestNote({ requestPayload: { refundRequestId: "rr_1" } })],
      links: [{ ...requestLink, metadata: { refundRequestId: "rr_1" } }],
      payment: { refundedAmountCents: 3000 },
    });
    expect(booking.findings).toContainEqual(ambiguousNote);
  });

  // Review F2 at a19beb492: no other arm reads a request's note, so its own
  // failed create is reported here, with its Retry and its own wording.
  it("reports a request's failed note with its Retry", async () => {
    const booking = await run({
      operations: [requestNote({ status: "FAILED", xeroObjectId: null, xeroObjectType: null })],
      links: [],
      payment: { refundedAmountCents: 3000 },
    });
    expect(booking.findings).toContainEqual(
      expect.objectContaining({
        code: "BLOCKED_BY_XERO_OPERATION",
        summary: expect.stringContaining("A refund request's Xero refund credit note failed"),
        actions: [expect.objectContaining({ key: "retry:operation_request_note" })],
      })
    );
    expect(booking.actions.map((action) => action.key)).toContain("retry:operation_request_note");
    expect(booking.findings.map((finding) => finding.summary)).not.toContainEqual(
      expect.stringContaining("cancelled booking cash refund")
    );
  });
});

/**
 * #3954: a price reduction first cancels or shrinks an earlier increase's
 * unpaid card ask. The ask never reached Xero (its supplementary invoice waits
 * on the card payment), so the reduction's own note covers only what it
 * returned of money paid, and the increase's retired invoice must not be
 * offered back as a one-click bill for money nobody owes.
 */
describe("#3954: a reduction set against an unpaid ask", () => {
  function reducedAfterUnpaidAsk(priceDiffCents: number, unpaidAskOffsetCents: number) {
    return makeBooking({
      modifications: [
        {
          id: "mod_increase",
          bookingId: "booking_1",
          modificationType: "GUEST_ADD",
          priceDiffCents: 5000,
          changeFeeCents: 0,
          newData: {},
          createdAt: new Date("2026-05-02T00:00:00Z"),
        },
        {
          id: "mod_reduction",
          bookingId: "booking_1",
          modificationType: "GUEST_REMOVE",
          priceDiffCents,
          changeFeeCents: 0,
          newData: { unpaidAskOffsetCents },
          createdAt: new Date("2026-05-03T00:00:00Z"),
        },
      ],
    });
  }
  const retiredSupplementary = () =>
    makeOperation({
      id: "operation_retired_supplementary",
      localModel: "BookingModification",
      localId: "mod_increase",
      status: "CANCELLED",
      queueType: "SUPPLEMENTARY_INVOICE",
      lastErrorCode: "ADDITIONAL_ASK_RETIRED_BY_REDUCTION",
      xeroObjectType: null,
      xeroObjectId: null,
      requestPayload: { queueType: "SUPPLEMENTARY_INVOICE", paymentIntentId: "pi_ask" },
    });

  it("MUTATION: expects no note for a reduction the unpaid ask absorbed whole", async () => {
    const deps = createDependencies({
      bookings: [reducedAfterUnpaidAsk(-5000, 5000)],
      operations: [makePrimaryInvoiceCreateOperation(), retiredSupplementary()],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).not.toContain("MISSING_MODIFICATION_CREDIT_NOTE");
    expect(bookingReport.actions.map((action) => action.type)).not.toContain("QUEUE_MODIFICATION_CREDIT_NOTE");
  });

  it("sizes a partly absorbed reduction's note on what the ask left", async () => {
    const deps = createDependencies({
      bookings: [reducedAfterUnpaidAsk(-8000, 5000)],
      operations: [makePrimaryInvoiceCreateOperation(), retiredSupplementary()],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    const finding = report.passes[0].bookings[0].findings.find(
      (candidate) => candidate.code === "MISSING_MODIFICATION_CREDIT_NOTE",
    );
    expect(finding?.details).toMatchObject({ modificationId: "mod_reduction", refundDueCents: 3000 });
  });

  it("MUTATION: reports the increase's retired invoice for a person, never as a one-click bill", async () => {
    const deps = createDependencies({
      bookings: [reducedAfterUnpaidAsk(-5000, 5000)],
      operations: [makePrimaryInvoiceCreateOperation(), retiredSupplementary()],
    });

    const report = await runBookingXeroRepair(CLUB_FORMAT_TEST, { dependencies: deps, scope: { all: true } });

    const bookingReport = report.passes[0].bookings[0];
    const finding = bookingReport.findings.find((candidate) => candidate.code === "MISSING_SUPPLEMENTARY_INVOICE");
    expect(finding).toMatchObject({
      severity: "manual_review",
      safeToAutoApply: false,
      details: { modificationId: "mod_increase", retiredBy: "ADDITIONAL_ASK_RETIRED_BY_REDUCTION" },
    });
    expect(bookingReport.actions.map((action) => action.type)).not.toContain("QUEUE_SUPPLEMENTARY_INVOICE");
  });
});
