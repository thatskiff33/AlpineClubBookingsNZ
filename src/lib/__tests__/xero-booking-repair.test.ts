import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatBookingXeroRepairHumanSummary,
  runBookingXeroRepair,
} from "@/lib/xero-booking-repair";
import { PartialRefundError } from "@/lib/payment-transactions";
import { withTimeZoneAsync } from "@/lib/__tests__/helpers/timezone";

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
}) {
  const links = state.links ?? [];
  const operations = state.operations ?? [];

  const enqueueXeroSupplementaryInvoiceOperation = vi.fn().mockImplementation(async (params: any) => {
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
    }: {
      paymentId: string;
      amountCents: number;
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

      for (const transaction of refundableTransactions) {
        if (remainingAmountCents <= 0) {
          break;
        }

        const refundableAmountCents =
          transaction.amountCents - transaction.refundedAmountCents;
        const refundAmountForTransaction = Math.min(
          remainingAmountCents,
          refundableAmountCents
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
        findMany: vi.fn().mockResolvedValue(state.cancellationRefundRecoveryOperations ?? []),
      },
      // #3187: the settled charge shares a parked booking edit's money lives on.
      manualRefundTask: {
        findMany: vi.fn().mockResolvedValue(state.editReviewChargeShares ?? []),
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
    enqueueXeroCreditNoteAllocationOperation: vi.fn().mockResolvedValue({
      queueOperationId: "queue_allocation",
      message: "queued",
    }),
    enqueueXeroSyncOperationRetry: vi.fn().mockResolvedValue({
      queueOperationId: "queue_retry",
      message: "queued retry",
    }),
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
  };
}

describe("runBookingXeroRepair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    const report = await runBookingXeroRepair({
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
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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
    const finding = bookingReport.findings.find(
      (candidate) => candidate.code === "MISSING_MODIFICATION_CREDIT_NOTE"
    );
    expect(finding).toMatchObject({
      severity: "critical",
      safeToAutoApply: true,
      details: { refundAmountSource: "net-amount" },
    });
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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
      operations: [] as any[],
    };
    const deps = createDependencies(state);

    const firstRun = await runBookingXeroRepair({
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });

    expect(firstRun.passes.length).toBeGreaterThan(1);
    expect(firstRun.summary.bookingsWithFindings).toBe(0);
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledTimes(1);

    const secondRun = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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
            refundPercentage: 0,
            settledAmountCents: 0,
            retainedAmountCents: 10000,
          },
          occurredAt: new Date("2026-05-03T00:00:00Z"),
        },
      ],
    };
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    const bookingReport = report.passes[0].bookings[0];
    expect(bookingReport.findings.map((finding) => finding.code)).not.toContain(
      "LATE_CAPTURE_AFTER_CANCELLATION"
    );
  });

  it("reports --apply-action keys that matched no planned action (#1491)", async () => {
    const booking = makeBooking();
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

  it("refunds cancelled late captures through the shared multi-intent refund helper", async () => {
    const booking = makeBooking({
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
    const deps = createDependencies({ bookings: [booking] });

    // #1491: the late-capture refund is never auto-applied — a plain --apply
    // run must leave the money untouched...
    const untouchedReport = await runBookingXeroRepair({
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });
    expect(deps.refundPaymentTransactions).not.toHaveBeenCalled();
    expect(untouchedReport.summary.bookingsWithFindings).toBe(1);

    // ...and executes only when the operator confirms the EXACT action key
    // from the dry-run report (--apply-action).
    const report = await runBookingXeroRepair({
      apply: true,
      applyActionKeys: ["late-capture-refund:booking_1:payment_1:13000"],
      dependencies: deps,
      scope: { all: true },
    });

    expect(deps.refundPaymentTransactions).toHaveBeenCalledWith({
      paymentId: "payment_1",
      amountCents: 13000,
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
    // fails, so the action fails — but the 6000 that refunded and recorded must
    // still get its Xero refund credit note.
    const firstReport = await runBookingXeroRepair({
      apply: true,
      applyActionKeys: ["late-capture-refund:booking_1:payment_1:13000"],
      dependencies: deps,
      scope: { all: true },
    });

    expect(deps.refundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "payment_1", amountCents: 13000 })
    );
    expect(deps.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "payment_1",
      6000
    );

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
    const secondReport = await runBookingXeroRepair({
      apply: true,
      applyActionKeys: ["late-capture-refund:booking_1:payment_1:7000"],
      dependencies: deps,
      scope: { all: true },
    });

    expect(deps.refundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "payment_1", amountCents: 7000 })
    );
    expect(deps.enqueueXeroRefundCreditNoteOperation).toHaveBeenCalledWith(
      "payment_1",
      7000
    );

    // No double-noting: exactly the completed 6000 then the 7000 remainder,
    // and never the full 13000.
    const refundNoteAmounts = (
      deps.enqueueXeroRefundCreditNoteOperation as ReturnType<typeof vi.fn>
    ).mock.calls
      .filter((call) => call[0] === "payment_1")
      .map((call) => call[1]);
    expect(refundNoteAmounts).toEqual([6000, 7000]);
    expect(refundNoteAmounts).not.toContain(13000);

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
      runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    await runBookingXeroRepair({
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
    const basePayment = makeBooking().payment;
    const booking = makeBooking({
      modifications: [parkedModification()],
      payment: {
        ...basePayment,
        transactions: [
          {
            id: "txn_review",
            paymentId: "payment_1",
            kind: "ADDITIONAL",
            source: "STRIPE",
            stripePaymentIntentId: "pi_review",
            amountCents: 4000,
            refundedAmountCents: 0,
            status: "SUCCEEDED",
            paymentMethodId: "pm_123",
            reason: "edit_financial_review_charge_mod_parked",
            createdAt: new Date("2026-05-02T01:00:00Z"),
            updatedAt: new Date("2026-05-02T01:00:00Z"),
          },
        ],
      },
    });
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [settledShare()],
    });

    await runBookingXeroRepair({
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
    const basePayment = makeBooking().payment;
    const booking = makeBooking({
      modifications: [parkedModification()],
      payment: {
        ...basePayment,
        transactions: [
          {
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
          },
        ],
      },
    });
    const deps = createDependencies({
      bookings: [booking],
      editReviewChargeShares: [settledShare()],
    });

    await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    expect(supplementaryFindingCodes(report)).toEqual([]);
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();
  });

  it("CONTROL: a parked edit with no settled review share raises no finding", async () => {
    const booking = makeBooking({ modifications: [parkedModification()] });
    const deps = createDependencies({ bookings: [booking] });

    const report = await runBookingXeroRepair({
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

    const report = await runBookingXeroRepair({
      dependencies: deps,
      scope: { all: true },
    });

    expect(supplementaryFindingCodes(report)).toEqual([]);
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

    const firstRun = await runBookingXeroRepair({
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });
    expect(firstRun.summary.bookingsWithFindings).toBe(0);
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledTimes(1);

    const secondRun = await runBookingXeroRepair({
      apply: true,
      dependencies: deps,
      scope: { all: true },
    });
    expect(secondRun.summary.bookingsWithFindings).toBe(0);
    expect(deps.enqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledTimes(1);
  });
});
