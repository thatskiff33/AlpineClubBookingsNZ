import { beforeEach, describe, expect, it, vi } from "vitest";
import { runBookingXeroRepair } from "@/lib/xero-booking-repair";

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
}) {
  const links = state.links ?? [];
  const operations = state.operations ?? [];

  const enqueueXeroSupplementaryInvoiceOperation = vi.fn().mockImplementation(async (params: any) => {
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
    },
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

  it("classifies missing modification credit notes for negative booking modifications", async () => {
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
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "MISSING_MODIFICATION_CREDIT_NOTE"
    );
    expect(bookingReport.actions.map((action) => action.type)).toContain(
      "QUEUE_MODIFICATION_CREDIT_NOTE"
    );
  });

  it("classifies missing allocations when a modification credit note exists without one", async () => {
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
    expect(bookingReport.findings.map((finding) => finding.code)).toContain(
      "MISSING_CREDIT_NOTE_ALLOCATION"
    );
    expect(bookingReport.actions.map((action) => action.type)).toContain(
      "QUEUE_CREDIT_NOTE_ALLOCATION"
    );
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

    const report = await runBookingXeroRepair({
      apply: true,
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
});
