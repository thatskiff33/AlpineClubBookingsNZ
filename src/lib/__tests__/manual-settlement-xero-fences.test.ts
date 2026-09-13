import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus, PaymentSource } from "@prisma/client";

/**
 * B5 (#2262) HIGH #2 — the outbound invoice-mint fence, and the reciprocal
 * inbound fence.
 *
 * A manually settled booking is PAID with source INTERNET_BANKING and no
 * invoice, which is exactly the shape every outbound surface reads as "missing
 * invoice, mint one". Unfenced they would raise a real AWAITING-PAYMENT invoice
 * in Xero and EMAIL IT TO THE MEMBER for money already collected in cash.
 *
 * The fence is closed on three levels, two of which are asserted here (the
 * third — mark-paid refusing while a CREATE-INVOICE operation is in flight —
 * lives in manual-booking-payment.test.ts):
 *  1. the enqueueXeroBookingInvoiceOperation CHOKE POINT, which every enqueuer
 *     funnels through;
 *  3. the HANDLER, createXeroInvoiceForBooking, which re-reads provenance at
 *     execution time and abandons an operation queued microseconds before the
 *     settle committed.
 */

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  paymentFindUnique: vi.fn(),
  seasonFindFirst: vi.fn(),
  xeroObjectLinkFindFirst: vi.fn(),
  xeroSyncOperationFindFirst: vi.fn(),
  xeroSyncOperationUpdate: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  callXeroApi: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: (...a: unknown[]) => mocks.bookingFindUnique(...a) },
    payment: { findUnique: (...a: unknown[]) => mocks.paymentFindUnique(...a) },
    season: { findFirst: (...a: unknown[]) => mocks.seasonFindFirst(...a) },
    xeroObjectLink: {
      findFirst: (...a: unknown[]) => mocks.xeroObjectLinkFindFirst(...a),
    },
    xeroSyncOperation: {
      findFirst: (...a: unknown[]) => mocks.xeroSyncOperationFindFirst(...a),
      update: (...a: unknown[]) => mocks.xeroSyncOperationUpdate(...a),
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: {
    warn: (...a: unknown[]) => mocks.warn(...a),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("level 1 — the enqueueXeroBookingInvoiceOperation choke point", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function enqueue() {
    vi.doMock("@/lib/xero-sync", async (importOriginal) => ({
      ...((await importOriginal()) as typeof import("@/lib/xero-sync")),
      startXeroSyncOperation: mocks.startXeroSyncOperation,
      upsertXeroObjectLink: mocks.upsertXeroObjectLink,
    }));
    const { enqueueXeroBookingInvoiceOperation } = await import(
      "@/lib/xero-operation-outbox"
    );
    return enqueueXeroBookingInvoiceOperation("booking-1");
  }

  it("refuses to queue an invoice for a manually settled booking, and says so", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "booking-1",
      payment: {
        id: "payment-1",
        xeroInvoiceId: null,
        manuallyMarkedPaidAt: new Date("2026-07-20T00:00:00Z"),
      },
    });

    const result = await enqueue();

    expect(result).toEqual({
      queueOperationId: null,
      message:
        "Booking was manually marked paid (cash / off-Xero) — no Xero invoice is expected.",
    });
    // No invoice operation is started at all — this is the choke point every
    // enqueuer funnels through, so nothing downstream can mint.
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    // …and the skip is AUDIBLE, so a repeated attempt is visible.
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1", paymentId: "payment-1" }),
      expect.stringContaining("manually marked-paid"),
    );
  });

  it("still queues normally for a booking with no manual provenance", async () => {
    mocks.bookingFindUnique.mockResolvedValue({
      id: "booking-1",
      payment: {
        id: "payment-1",
        xeroInvoiceId: null,
        manuallyMarkedPaidAt: null,
      },
    });
    mocks.xeroObjectLinkFindFirst.mockResolvedValue(null);
    mocks.xeroSyncOperationFindFirst.mockResolvedValue(null);
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op-1" });

    const result = await enqueue();

    expect(result.queueOperationId).toBe("op-1");
  });
});

describe("level 3 — the createXeroInvoiceForBooking handler re-check", () => {
  it("abandons a queued mint loudly for a manually settled payment: no Xero client, no invoice, no email", async () => {
    vi.resetModules();
    vi.clearAllMocks();

    vi.doMock("@/lib/xero-sync", async (importOriginal) => ({
      ...((await importOriginal()) as typeof import("@/lib/xero-sync")),
      startXeroSyncOperation: mocks.startXeroSyncOperation,
      completeXeroSyncOperation: mocks.completeXeroSyncOperation,
      upsertXeroObjectLink: mocks.upsertXeroObjectLink,
    }));
    vi.doMock("@/lib/xero-client", () => ({
      getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
    }));

    mocks.bookingFindUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: BookingStatus.PAID,
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      guests: [],
      member: { email: "ada@example.org" },
      promoRedemption: null,
      payment: {
        id: "payment-1",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        source: PaymentSource.INTERNET_BANKING,
        manuallyMarkedPaidAt: new Date("2026-07-20T00:00:00Z"),
      },
    });

    const { createXeroInvoiceForBooking } = await import(
      "@/lib/xero-booking-invoices"
    );

    const result = await createXeroInvoiceForBooking("booking-1", {
      syncOperationId: "op-queued-before-the-settle",
    });

    expect(result).toBeNull();
    // The residual race is closed BEFORE any provider work: the Xero client is
    // never even authenticated, so no invoice is created and none is emailed.
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    // The operation is closed with a NON-SUCCEEDED terminal status carrying a
    // populated reason, so it is visible to an operator and never replayed.
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op-queued-before-the-settle",
      expect.objectContaining({
        status: "CANCELLED",
        responsePayload: expect.objectContaining({ skipped: true }),
      }),
    );
    expect(mocks.warn).toHaveBeenCalled();
  });

  it("H3 — re-asserts provenance AFTER the operation exists: a settle that committed during the contact/mapping reads still abandons the mint", async () => {
    vi.resetModules();
    vi.clearAllMocks();

    vi.doMock("@/lib/xero-sync", async (importOriginal) => ({
      ...((await importOriginal()) as typeof import("@/lib/xero-sync")),
      startXeroSyncOperation: mocks.startXeroSyncOperation,
      completeXeroSyncOperation: mocks.completeXeroSyncOperation,
      upsertXeroObjectLink: mocks.upsertXeroObjectLink,
    }));
    vi.doMock("@/lib/xero-api-client", () => ({
      getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
      callXeroApi: mocks.callXeroApi,
    }));
    vi.doMock("@/lib/xero-contacts", () => ({
      findOrCreateXeroContact: mocks.findOrCreateXeroContact,
      retryXeroWriteWithContactRepair: vi.fn(),
    }));
    vi.doMock("@/lib/xero-mappings", () => ({
      getResolvedAccountMapping: vi
        .fn()
        .mockResolvedValue({ code: "200", itemCode: null, codeExplicitlyConfigured: false }),
      getAccountMapping: vi.fn().mockResolvedValue("606"),
      getHutFeeItemCodeMap: vi.fn().mockResolvedValue({}),
      isHutFeeResolverConfigured: vi.fn().mockReturnValue(false),
      resolveHutFeeItemCode: vi.fn().mockReturnValue(null),
    }));

    // The TOP-of-function snapshot carries NO provenance: the manual settle
    // commits only after this read, while the mint is deep in its contact and
    // account-mapping round-trips.
    mocks.bookingFindUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: BookingStatus.PAYMENT_PENDING,
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      createdAt: new Date("2026-07-01"),
      promoAdjustmentCents: 0,
      guests: [],
      member: { email: "ada@example.org" },
      promoRedemption: null,
      payment: {
        id: "payment-1",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        source: PaymentSource.INTERNET_BANKING,
        manuallyMarkedPaidAt: null,
      },
    });
    mocks.getAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: {} },
      tenantId: "tenant-1",
    });
    mocks.findOrCreateXeroContact.mockResolvedValue("contact-1");
    mocks.seasonFindFirst.mockResolvedValue(null);
    mocks.xeroSyncOperationUpdate.mockResolvedValue({});
    // The FRESH re-read — strictly after the operation exists and is therefore
    // visible to the settle-time fence — sees the settle's provenance.
    mocks.paymentFindUnique.mockResolvedValue({
      manuallyMarkedPaidAt: new Date("2026-07-29T00:00:00Z"),
    });

    const { createXeroInvoiceForBooking } = await import(
      "@/lib/xero-booking-invoices"
    );

    const result = await createXeroInvoiceForBooking("booking-1", {
      syncOperationId: "op-retry-claimed",
    });

    expect(result).toBeNull();
    // Nothing reached Xero: no create call, no email.
    expect(mocks.callXeroApi).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op-retry-claimed",
      expect.objectContaining({
        status: "CANCELLED",
        responsePayload: expect.objectContaining({ skipped: true }),
      }),
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        paymentId: "payment-1",
        syncOperationId: "op-retry-claimed",
      }),
      expect.stringContaining("manually marked paid"),
    );
  });

  it("H3 — a claimed operation whose invoice already exists is closed SUCCEEDED, never stranded RUNNING", async () => {
    vi.resetModules();
    vi.clearAllMocks();

    vi.doMock("@/lib/xero-sync", async (importOriginal) => ({
      ...((await importOriginal()) as typeof import("@/lib/xero-sync")),
      startXeroSyncOperation: mocks.startXeroSyncOperation,
      completeXeroSyncOperation: mocks.completeXeroSyncOperation,
      upsertXeroObjectLink: mocks.upsertXeroObjectLink,
    }));

    mocks.bookingFindUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: BookingStatus.PAID,
      guests: [],
      member: { email: "ada@example.org" },
      promoRedemption: null,
      payment: {
        id: "payment-1",
        xeroInvoiceId: "inv-already",
        xeroInvoiceNumber: "INV-1",
        source: PaymentSource.STRIPE,
        status: "SUCCEEDED",
        amountCents: 10000,
        refundedAmountCents: 0,
        creditAppliedCents: 0,
        manuallyMarkedPaidAt: null,
      },
    });

    const { createXeroInvoiceForBooking } = await import(
      "@/lib/xero-booking-invoices"
    );

    const result = await createXeroInvoiceForBooking("booking-1", {
      syncOperationId: "op-retry-claimed",
    });

    expect(result).toBe("inv-already");
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op-retry-claimed",
      expect.objectContaining({
        status: "SUCCEEDED",
        xeroObjectId: "inv-already",
      }),
    );
  });
});
