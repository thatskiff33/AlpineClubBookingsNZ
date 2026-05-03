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
      createdAt: new Date("2026-05-01T00:00:00Z"),
      updatedAt: new Date("2026-05-01T00:00:00Z"),
    },
    modifications: [],
    creditsFromCancellation: [],
    ...overrides,
  };
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
    processRefund: vi.fn().mockResolvedValue({ id: "re_123" }),
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
          modificationType: "DATE_CHANGE",
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
});
