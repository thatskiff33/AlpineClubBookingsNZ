import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";

const mockTransaction = vi.fn();
const mockPaymentUpdate = vi.fn();
const mockMemberFindUnique = vi.fn();
const mockCreatePaymentIntent = vi.fn();
const mockFindOrCreateCustomer = vi.fn();
const mockCheckCapacity = vi.fn();
const mockCalculateBookingPrice = vi.fn();
const mockCalculatePromoDiscountForGuestRates = vi.fn();
const mockAuth = vi.fn();
const mockRefundPaymentTransactions = vi.fn();
const mockUpsertPaymentIntentTransaction = vi.fn();
const mockPaymentTransactionUpdateMany = vi.fn();
const mockEnqueuePaymentIntentCancellationRecovery = vi.fn();
const mockProcessPaymentRecoveryOperations = vi.fn();
const mockEnqueueBookingModificationRefundRecovery = vi.fn();
const mockAssertLinkedBookingMembersCanBeBooked = vi.fn().mockResolvedValue(undefined);
const mockGetBookingGuestValidationErrorResponse = vi.fn((error: { message: string }) => ({
  error: error.message,
}));
const mockEnqueueXeroBookingInvoiceOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_booking", message: "queued" });
const mockEnqueueXeroBookingInvoiceUpdateOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_booking_update", message: "queued" });
const mockEnqueueXeroSupplementaryInvoiceOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_supplementary", message: "queued" });
const mockEnqueueXeroModificationCreditNoteOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_mod_credit_note", message: "queued" });
const mockKickQueuedXeroOutboxOperationsIfConnected = vi.fn().mockResolvedValue(null);
const mockRecordSkippedXeroBookingInvoiceUpdateOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_skip", message: "skipped" });

const mockBookingGuestValidationError = class BookingGuestValidationError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => {
      const fn = args[0];
      if (typeof fn === "function") return (mockTransaction as (cb: unknown) => unknown)(fn);
      return Promise.resolve();
    },
    payment: {
      update: mockPaymentUpdate,
    },
    paymentTransaction: {
      updateMany: mockPaymentTransactionUpdateMany,
      findMany: vi.fn().mockResolvedValue([]),
    },
    member: {
      findUnique: mockMemberFindUnique,
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacity: mockCheckCapacity,
  checkCapacityForGuestRanges: mockCheckCapacity,
}));

vi.mock("@/lib/pricing", () => ({
  calculateBookingPrice: mockCalculateBookingPrice,
}));

vi.mock("@/lib/change-fee", () => ({
  calculateChangeFee: vi.fn().mockReturnValue({ feeCents: 0 }),
}));

vi.mock("@/lib/cancellation", () => ({
  daysUntilDate: vi.fn().mockReturnValue(30),
  loadCancellationPolicy: vi.fn().mockResolvedValue([]),
  getNonMemberHoldDays: vi.fn().mockResolvedValue(7),
}));

vi.mock("@/lib/promo", () => ({
  calculatePromoDiscountForGuestRates: mockCalculatePromoDiscountForGuestRates,
  validatePromoCodeRules: vi.fn().mockReturnValue(null),
  redeemPromoCode: vi.fn(),
  getMemberFreeNightsUsed: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/lib/stripe", () => ({
  processRefund: vi.fn(),
  createPaymentIntent: mockCreatePaymentIntent,
  findOrCreateCustomer: mockFindOrCreateCustomer,
}));
vi.mock("@/lib/payment-transactions", () => ({
  refundPaymentTransactions: (...args: unknown[]) =>
    mockRefundPaymentTransactions(...args),
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mockUpsertPaymentIntentTransaction(...args),
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueuePaymentIntentCancellationRecovery: (...args: unknown[]) =>
    mockEnqueuePaymentIntentCancellationRecovery(...args),
  processPaymentRecoveryOperations: (...args: unknown[]) =>
    mockProcessPaymentRecoveryOperations(...args),
  enqueueBookingModificationRefundRecovery: (...args: unknown[]) =>
    mockEnqueueBookingModificationRefundRecovery(...args),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendBookingModifiedEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/chore-cleanup", () => ({
  cleanupChoreAssignmentsForDateChange: vi.fn().mockResolvedValue({
    choreWarnings: [],
  }),
  cleanupChoreAssignmentsForGuestStayRanges: vi.fn().mockResolvedValue({
    choreWarnings: [],
  }),
}));

vi.mock("@/lib/xero", () => ({
  createXeroSupplementaryInvoice: vi.fn().mockResolvedValue(undefined),
  createXeroCreditNoteForModification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: mockEnqueueXeroBookingInvoiceOperation,
  enqueueXeroBookingInvoiceUpdateOperation: mockEnqueueXeroBookingInvoiceUpdateOperation,
  enqueueXeroSupplementaryInvoiceOperation: mockEnqueueXeroSupplementaryInvoiceOperation,
  enqueueXeroModificationCreditNoteOperation: mockEnqueueXeroModificationCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected: mockKickQueuedXeroOutboxOperationsIfConnected,
  recordSkippedXeroBookingInvoiceUpdateOperation: mockRecordSkippedXeroBookingInvoiceUpdateOperation,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/age-tier-schema", () => ({
  ageTierEnum: z.enum(["INFANT", "CHILD", "YOUTH", "ADULT"]),
}));

vi.mock("@/lib/booking-guests", () => {
  return {
    assertLinkedBookingMembersCanBeBooked: mockAssertLinkedBookingMembersCanBeBooked,
    BookingGuestValidationError: mockBookingGuestValidationError,
    getBookingGuestValidationErrorResponse: mockGetBookingGuestValidationErrorResponse,
    normalizeBookingGuestInputs: vi.fn((guests: unknown) => guests),
    resolveLinkedBookingMembers: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("@/lib/booking-member-guest-subscriptions", () => ({
  findUnpaidMemberGuestNames: vi.fn().mockResolvedValue([]),
}));

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "bk1",
    memberId: "m1",
    checkIn: new Date("2026-08-20"),
    checkOut: new Date("2026-08-22"),
    status: "PAID",
    totalPriceCents: 5000,
    discountCents: 0,
    finalPriceCents: 5000,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    guests: [
      {
        id: "g1",
        bookingId: "bk1",
        firstName: "Alice",
        lastName: "Member",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        priceCents: 5000,
      },
    ],
    payment: {
      id: "pay_1",
      bookingId: "bk1",
      amountCents: 5000,
      status: "SUCCEEDED",
      stripePaymentIntentId: "pi_original",
      xeroInvoiceId: "inv_primary",
      stripeCustomerId: null,
      refundedAmountCents: 0,
      changeFeeCents: 0,
    },
    member: {
      id: "m1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Member",
    },
    promoRedemption: null,
    ...overrides,
  };
}

function makeTx(booking: ReturnType<typeof makeBooking>) {
  const createdGuests: Array<Record<string, unknown>> = [];

  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    booking: {
      findUnique: vi.fn().mockResolvedValue(booking),
      update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          ...booking,
          ...data,
          guests: [...booking.guests, ...createdGuests],
          payment: booking.payment,
        })
      ),
    },
    bookingGuest: {
      create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        const guest = { id: "g2", ...data };
        createdGuests.push(guest);
        return Promise.resolve(guest);
      }),
      update: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    bookingModification: {
      create: vi.fn().mockResolvedValue({ id: "mod_1" }),
    },
    promoRedemption: {
      delete: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    },
    promoCode: {
      update: vi.fn().mockResolvedValue(undefined),
      findUnique: vi.fn().mockResolvedValue({
        id: "promo_1",
        code: "FREE100",
        type: "PERCENTAGE",
        valueCents: null,
        percentOff: 100,
        freeNights: null,
        active: true,
        validFrom: null,
        validUntil: null,
        maxRedemptions: null,
        currentRedemptions: 0,
        membersOnly: false,
        singleUse: false,
        assignments: [],
      }),
    },
    choreAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    payment: {
      update: vi.fn().mockResolvedValue(undefined),
      upsert: vi.fn().mockResolvedValue({
        id: booking.payment?.id ?? "pay_zero",
        amountCents: 0,
        status: "SUCCEEDED",
      }),
    },
    paymentTransaction: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    season: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "season_1",
          startDate: new Date("2026-04-01"),
          endDate: new Date("2026-10-31"),
          rates: [
            {
              ageTier: "ADULT",
              isMember: true,
              pricePerNightCents: 2500,
            },
            {
              ageTier: "ADULT",
              isMember: false,
              pricePerNightCents: 5000,
            },
          ],
        },
      ]),
    },
  };
}

describe("PUT /api/bookings/[id]/modify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      user: { id: "m1", role: "MEMBER", email: "alice@example.com" },
    });
    mockCheckCapacity.mockResolvedValue({
      available: true,
      minAvailable: 10,
      nightDetails: [],
    });
    mockMemberFindUnique.mockResolvedValue({
      id: "m1",
      email: "alice@example.com",
      firstName: "Alice",
    });
    mockFindOrCreateCustomer.mockResolvedValue({ id: "cus_new" });
    mockCreatePaymentIntent.mockResolvedValue({
      id: "pi_batch",
      client_secret: "pi_batch_secret",
    });
    mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 1 });
    mockEnqueuePaymentIntentCancellationRecovery.mockResolvedValue({
      id: "recovery_1",
    });
    mockEnqueueBookingModificationRefundRecovery.mockResolvedValue({
      id: "recovery_refund",
    });
    mockProcessPaymentRecoveryOperations.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      retried: 0,
      skipped: 0,
    });
    mockRefundPaymentTransactions.mockResolvedValue({
      refunds: [],
      totalRefundedAmountCents: 0,
    });
    mockUpsertPaymentIntentTransaction.mockResolvedValue(undefined);
    mockCalculatePromoDiscountForGuestRates.mockReturnValue({ discountCents: 0, freeNightsUsed: 0 });
    mockAssertLinkedBookingMembersCanBeBooked.mockResolvedValue(undefined);
    mockGetBookingGuestValidationErrorResponse.mockImplementation((error: { message: string }) => ({
      error: error.message,
    }));
  });

  it("returns the shared profile-required shape when added linked member guests are blocked", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );
    mockAssertLinkedBookingMembersCanBeBooked.mockRejectedValueOnce(
      new mockBookingGuestValidationError(
        "Some member guests need their details completed or confirmed before booking.",
        403
      )
    );
    mockGetBookingGuestValidationErrorResponse.mockReturnValueOnce({
      code: "GUEST_PROFILE_REQUIRED",
      error: "Some member guests need their details completed or confirmed before booking.",
      members: [
        {
          memberId: "guest-member-1",
          name: "Bob Jones",
          canCurrentUserResolve: true,
          needsOwnLoginConfirmation: false,
          missingFields: ["Date of Birth"],
          action: "complete_details",
        },
      ],
    });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        addGuests: [
          {
            firstName: "Bob",
            lastName: "Jones",
            ageTier: "ADULT",
            isMember: true,
            memberId: "guest-member-1",
          },
        ],
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data).toMatchObject({
      code: "GUEST_PROFILE_REQUIRED",
      members: [
        expect.objectContaining({
          memberId: "guest-member-1",
          action: "complete_details",
        }),
      ],
    });
    expect(mockAssertLinkedBookingMembersCanBeBooked).toHaveBeenCalledWith(
      tx,
      expect.anything(),
      "m1",
      {
        actorRole: "MEMBER",
        onBehalfOfMemberId: null,
      }
    );
    expect(tx.bookingGuest.create).not.toHaveBeenCalled();
  });

  it("creates an additional PaymentIntent when a paid booking increases in price", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    mockCalculateBookingPrice
      .mockReturnValueOnce({
        totalPriceCents: 15000,
        guests: [
          { priceCents: 5000, perNightCents: [2500, 2500] },
          { priceCents: 10000, perNightCents: [5000, 5000] },
        ],
      })
      .mockReturnValueOnce({
        totalPriceCents: 5000,
        guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
      })
      .mockReturnValueOnce({
        totalPriceCents: 10000,
        guests: [{ priceCents: 10000, perNightCents: [5000, 5000] }],
      });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        addGuests: [
          {
            firstName: "Bob",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
          },
        ],
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.additionalAmountCents).toBe(10000);
    expect(data.additionalPaymentClientSecret).toBe("pi_batch_secret");

    expect(mockFindOrCreateCustomer).toHaveBeenCalledWith({
      email: "alice@example.com",
      name: "Alice Member",
      memberId: "m1",
    });

    expect(mockCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 10000,
        customerId: "cus_new",
        metadata: expect.objectContaining({
          bookingId: "bk1",
          type: "modification_additional",
          reason: "batch_modify_price_increase",
        }),
      })
    );

    expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay_1",
        paymentIntentId: "pi_batch",
        amountCents: 10000,
        stripeCustomerId: "cus_new",
      })
    );

    await Promise.resolve();
    expect(mockEnqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
      {
        bookingId: "bk1",
        priceDiffCents: 10000,
        changeFeeCents: 0,
        bookingModificationId: "mod_1",
      },
      {
        createdByMemberId: "m1",
        paymentIntentId: "pi_batch",
        waitForConfirmedAdditionalPayment: true,
        recordPayment: true,
      }
    );
    expect(mockKickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({ limit: 1 });
  });

  it("marks a payment-pending booking paid when a batch edit promo reduces the total to zero", async () => {
    const booking = makeBooking({
      status: "PAYMENT_PENDING",
      totalPriceCents: 10000,
      finalPriceCents: 10000,
      payment: {
        id: "pay_1",
        bookingId: "bk1",
        amountCents: 6000,
        status: "PROCESSING",
        stripePaymentIntentId: "pi_pending",
        xeroInvoiceId: null,
        stripeCustomerId: "cus_existing",
        refundedAmountCents: 0,
        changeFeeCents: 0,
      },
    });
    const tx = makeTx(booking);
    tx.paymentTransaction.findMany.mockResolvedValue([
      {
        id: "ptx_pending",
        stripePaymentIntentId: "pi_pending",
        amountCents: 6000,
      },
    ]);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    mockCalculateBookingPrice
      .mockReturnValueOnce({
        totalPriceCents: 15000,
        guests: [
          { priceCents: 5000, perNightCents: [2500, 2500] },
          { priceCents: 10000, perNightCents: [5000, 5000] },
        ],
      })
      .mockReturnValueOnce({
        totalPriceCents: 5000,
        guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
      })
      .mockReturnValueOnce({
        totalPriceCents: 10000,
        guests: [{ priceCents: 10000, perNightCents: [5000, 5000] }],
      });
    mockCalculatePromoDiscountForGuestRates.mockReturnValueOnce({
      discountCents: 15000,
      freeNightsUsed: 0,
    });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        addGuests: [
          {
            firstName: "Bob",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
          },
        ],
        promoCode: "FREE100",
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.booking.status).toBe("PAID");
    expect(data.booking.finalPriceCents).toBe(0);

    expect(tx.payment.upsert).toHaveBeenCalledWith({
      where: { bookingId: "bk1" },
      create: {
        bookingId: "bk1",
        amountCents: 0,
        status: "SUCCEEDED",
      },
      update: {
        amountCents: 0,
        status: "SUCCEEDED",
        stripePaymentIntentId: null,
        stripePaymentMethodId: null,
        additionalPaymentIntentId: null,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
      },
    });
    expect(tx.paymentTransaction.findMany).toHaveBeenCalledWith({
      where: {
        paymentId: "pay_1",
        kind: "PRIMARY",
        status: { in: ["PENDING", "PROCESSING"] },
        amountCents: { gt: 0 },
      },
      select: {
        id: true,
        stripePaymentIntentId: true,
        amountCents: true,
      },
    });
    expect(mockEnqueuePaymentIntentCancellationRecovery).toHaveBeenCalledWith({
      bookingId: "bk1",
      paymentId: "pay_1",
      paymentTransactionId: "ptx_pending",
      paymentIntentId: "pi_pending",
      amountCents: 6000,
      store: tx,
    });
    expect(mockProcessPaymentRecoveryOperations).toHaveBeenCalledWith({ limit: 1 });
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PAID",
          finalPriceCents: 0,
        }),
      })
    );
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(mockEnqueueXeroBookingInvoiceOperation).toHaveBeenCalledWith("bk1", {
      createdByMemberId: "m1",
    });
    expect(mockKickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({ limit: 1 });
  });

  it("rolls back the modification when the in-transaction recovery enqueue throws", async () => {
    const booking = makeBooking({
      status: "PAYMENT_PENDING",
      totalPriceCents: 10000,
      finalPriceCents: 10000,
      payment: {
        id: "pay_1",
        bookingId: "bk1",
        amountCents: 6000,
        status: "PROCESSING",
        stripePaymentIntentId: "pi_pending",
        xeroInvoiceId: null,
        stripeCustomerId: "cus_existing",
        refundedAmountCents: 0,
        changeFeeCents: 0,
      },
    });
    const tx = makeTx(booking);
    tx.paymentTransaction.findMany.mockResolvedValue([
      {
        id: "ptx_pending",
        stripePaymentIntentId: "pi_pending",
        amountCents: 6000,
      },
    ]);

    mockTransaction.mockImplementation(async (fn: (innerTx: typeof tx) => unknown) => {
      // A real prisma.$transaction would rethrow the callback error and not
      // commit the transaction. Mirror that here so the route's outer catch
      // returns a 4xx/5xx.
      return await fn(tx);
    });

    mockCalculateBookingPrice
      .mockReturnValueOnce({
        totalPriceCents: 15000,
        guests: [
          { priceCents: 5000, perNightCents: [2500, 2500] },
          { priceCents: 10000, perNightCents: [5000, 5000] },
        ],
      })
      .mockReturnValueOnce({
        totalPriceCents: 5000,
        guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
      })
      .mockReturnValueOnce({
        totalPriceCents: 10000,
        guests: [{ priceCents: 10000, perNightCents: [5000, 5000] }],
      });
    mockCalculatePromoDiscountForGuestRates.mockReturnValueOnce({
      discountCents: 15000,
      freeNightsUsed: 0,
    });
    mockEnqueuePaymentIntentCancellationRecovery.mockRejectedValueOnce(
      new Error("recovery upsert failed inside transaction")
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        addGuests: [
          {
            firstName: "Bob",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
          },
        ],
        promoCode: "FREE100",
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(400);
    expect(tx.booking.update).not.toHaveBeenCalled();
    expect(tx.bookingModification.create).not.toHaveBeenCalled();
    expect(mockProcessPaymentRecoveryOperations).not.toHaveBeenCalled();
  });

  it("still succeeds when immediate queued Stripe recovery processing fails", async () => {
    const booking = makeBooking({
      status: "PAYMENT_PENDING",
      totalPriceCents: 10000,
      finalPriceCents: 10000,
      payment: {
        id: "pay_1",
        bookingId: "bk1",
        amountCents: 6000,
        status: "PROCESSING",
        stripePaymentIntentId: "pi_pending",
        xeroInvoiceId: null,
        stripeCustomerId: "cus_existing",
        refundedAmountCents: 0,
        changeFeeCents: 0,
      },
    });
    const tx = makeTx(booking);
    tx.paymentTransaction.findMany.mockResolvedValue([
      {
        id: "ptx_pending",
        stripePaymentIntentId: "pi_pending",
        amountCents: 6000,
      },
    ]);
    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );
    mockCalculateBookingPrice
      .mockReturnValueOnce({
        totalPriceCents: 15000,
        guests: [
          { priceCents: 5000, perNightCents: [2500, 2500] },
          { priceCents: 10000, perNightCents: [5000, 5000] },
        ],
      })
      .mockReturnValueOnce({
        totalPriceCents: 5000,
        guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
      })
      .mockReturnValueOnce({
        totalPriceCents: 10000,
        guests: [{ priceCents: 10000, perNightCents: [5000, 5000] }],
      });
    mockCalculatePromoDiscountForGuestRates.mockReturnValueOnce({
      discountCents: 15000,
      freeNightsUsed: 0,
    });
    mockProcessPaymentRecoveryOperations.mockRejectedValueOnce(
      new Error("Stripe unavailable")
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        addGuests: [
          {
            firstName: "Bob",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
          },
        ],
        promoCode: "FREE100",
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    expect(mockEnqueuePaymentIntentCancellationRecovery).toHaveBeenCalled();
    expect(mockProcessPaymentRecoveryOperations).toHaveBeenCalledWith({ limit: 1 });
  });

  it("queues a primary Xero invoice update for zero-net batch date changes", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    mockCalculateBookingPrice.mockReturnValue({
      totalPriceCents: 5000,
      guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
    });

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({
        checkIn: "2026-08-24",
        checkOut: "2026-08-26",
      }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.additionalAmountCents).toBe(0);
    expect(data.refundAmountCents).toBe(0);

    await Promise.resolve();
    expect(mockEnqueueXeroSupplementaryInvoiceOperation).not.toHaveBeenCalled();
    expect(mockEnqueueXeroModificationCreditNoteOperation).not.toHaveBeenCalled();
    expect(mockEnqueueXeroBookingInvoiceUpdateOperation).not.toHaveBeenCalled();
    expect(mockRecordSkippedXeroBookingInvoiceUpdateOperation).toHaveBeenCalledWith({
      bookingId: "bk1",
      bookingModificationId: "mod_1",
      reason: expect.stringContaining("Skipped primary Xero invoice update"),
      createdByMemberId: "m1",
    });
  });

  it("shortens an in-progress completed booking from NZ tomorrow without deleting past guest occupancy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));

    try {
      const booking = makeBooking({
        status: "COMPLETED",
        checkIn: new Date("2026-08-20T00:00:00.000Z"),
        checkOut: new Date("2026-08-24T00:00:00.000Z"),
        totalPriceCents: 10000,
        finalPriceCents: 10000,
        guests: [
          {
            id: "g1",
            bookingId: "bk1",
            firstName: "Alice",
            lastName: "Member",
            ageTier: "ADULT",
            isMember: true,
            memberId: "m1",
            stayStart: new Date("2026-08-20T00:00:00.000Z"),
            stayEnd: new Date("2026-08-24T00:00:00.000Z"),
            priceCents: 10000,
          },
        ],
        payment: {
          id: "pay_1",
          bookingId: "bk1",
          amountCents: 10000,
          status: "SUCCEEDED",
          stripePaymentIntentId: "pi_original",
          xeroInvoiceId: "inv_primary",
          stripeCustomerId: null,
          refundedAmountCents: 0,
          changeFeeCents: 0,
        },
      });
      const tx = makeTx(booking);

      mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
        fn(tx)
      );
      mockCalculateBookingPrice.mockReturnValueOnce({
        totalPriceCents: 5000,
        guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
      });

      const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

      const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
        method: "PUT",
        body: JSON.stringify({
          checkOut: "2026-08-22",
          removeGuestIds: ["g1"],
        }),
      });

      const response = await PUT(request, {
        params: Promise.resolve({ id: "bk1" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.refundAmountCents).toBe(5000);
      expect(tx.bookingGuest.delete).not.toHaveBeenCalled();
      expect(tx.bookingGuest.update).toHaveBeenCalledWith({
        where: { id: "g1" },
        data: {
          stayStart: new Date("2026-08-20T00:00:00.000Z"),
          stayEnd: new Date("2026-08-22T00:00:00.000Z"),
          priceCents: 5000,
        },
      });

      await Promise.resolve();
      expect(mockEnqueueXeroModificationCreditNoteOperation).toHaveBeenCalledWith(
        {
          bookingId: "bk1",
          refundAmountCents: 5000,
          bookingModificationId: "mod_1",
        },
        {
          createdByMemberId: "m1",
        }
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds guests to an in-progress completed booking from NZ tomorrow only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));

    try {
      const booking = makeBooking({
        status: "COMPLETED",
        checkIn: new Date("2026-08-20T00:00:00.000Z"),
        checkOut: new Date("2026-08-24T00:00:00.000Z"),
        totalPriceCents: 10000,
        finalPriceCents: 10000,
        guests: [
          {
            id: "g1",
            bookingId: "bk1",
            firstName: "Alice",
            lastName: "Member",
            ageTier: "ADULT",
            isMember: true,
            memberId: "m1",
            stayStart: new Date("2026-08-20T00:00:00.000Z"),
            stayEnd: new Date("2026-08-24T00:00:00.000Z"),
            priceCents: 10000,
          },
        ],
        payment: {
          id: "pay_1",
          bookingId: "bk1",
          amountCents: 10000,
          status: "SUCCEEDED",
          stripePaymentIntentId: "pi_original",
          xeroInvoiceId: "inv_primary",
          stripeCustomerId: null,
          refundedAmountCents: 0,
          changeFeeCents: 0,
        },
      });
      const tx = makeTx(booking);

      mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
        fn(tx)
      );
      mockCalculateBookingPrice
        .mockReturnValueOnce({
          totalPriceCents: 5000,
          guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
        })
        .mockReturnValueOnce({
          totalPriceCents: 5000,
          guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
        })
        .mockReturnValueOnce({
          totalPriceCents: 6000,
          guests: [{ priceCents: 6000, perNightCents: [3000, 3000] }],
        });

      const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

      const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
        method: "PUT",
        body: JSON.stringify({
          addGuests: [
            {
              firstName: "Bob",
              lastName: "Guest",
              ageTier: "ADULT",
              isMember: false,
            },
          ],
        }),
      });

      const response = await PUT(request, {
        params: Promise.resolve({ id: "bk1" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.additionalAmountCents).toBe(6000);
      expect(tx.bookingGuest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bookingId: "bk1",
          firstName: "Bob",
          stayStart: new Date("2026-08-22T00:00:00.000Z"),
          stayEnd: new Date("2026-08-24T00:00:00.000Z"),
          priceCents: 6000,
        }),
      });

      await Promise.resolve();
      expect(mockEnqueueXeroSupplementaryInvoiceOperation).toHaveBeenCalledWith(
        {
          bookingId: "bk1",
          priceDiffCents: 6000,
          changeFeeCents: 0,
          bookingModificationId: "mod_1",
        },
        {
          createdByMemberId: "m1",
          paymentIntentId: "pi_batch",
          waitForConfirmedAdditionalPayment: true,
          recordPayment: true,
        }
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects in-progress member attempts to change check-in", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));

    try {
      const booking = makeBooking({
        status: "COMPLETED",
        checkIn: new Date("2026-08-20T00:00:00.000Z"),
        checkOut: new Date("2026-08-24T00:00:00.000Z"),
      });
      const tx = makeTx(booking);

      mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
        fn(tx)
      );

      const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

      const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
        method: "PUT",
        body: JSON.stringify({
          checkIn: "2026-08-21",
          checkOut: "2026-08-24",
        }),
      });

      const response = await PUT(request, {
        params: Promise.resolve({ id: "bk1" }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Check-in cannot be changed for an in-progress booking");
      expect(tx.booking.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 400 with a structured error envelope when the request body is not valid JSON", async () => {
    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: "{not json",
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Invalid JSON");
    expect(data.details).toEqual({
      body: ["Request body must be valid JSON"],
    });
  });

  it("enqueues refund recovery when the Stripe refund call fails after a price-decrease modification", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);

    mockTransaction.mockImplementation((fn: (innerTx: typeof tx) => unknown) =>
      fn(tx)
    );

    // Two guests at $50 each = $100, dropping to one guest = $50 → refund $50
    booking.guests = [
      ...booking.guests,
      {
        id: "g2",
        bookingId: "bk1",
        firstName: "Bob",
        lastName: "Guest",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        priceCents: 5000,
      },
    ];
    booking.totalPriceCents = 10000;
    booking.finalPriceCents = 10000;
    booking.payment!.amountCents = 10000;

    mockCalculateBookingPrice
      .mockReturnValueOnce({
        totalPriceCents: 5000,
        guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
      })
      .mockReturnValueOnce({
        totalPriceCents: 5000,
        guests: [{ priceCents: 5000, perNightCents: [2500, 2500] }],
      });

    mockRefundPaymentTransactions.mockRejectedValueOnce(
      new Error("Stripe is unavailable")
    );

    const { PUT } = await import("@/app/api/bookings/[id]/modify/route");

    const request = new NextRequest("http://localhost/api/bookings/bk1/modify", {
      method: "PUT",
      body: JSON.stringify({ removeGuestIds: ["g2"] }),
    });

    const response = await PUT(request, {
      params: Promise.resolve({ id: "bk1" }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.refundAmountCents).toBe(5000);
    expect(data.stripeRefundId).toBeNull();

    expect(mockRefundPaymentTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5000 })
    );
    expect(mockEnqueueBookingModificationRefundRecovery).toHaveBeenCalledWith({
      bookingId: "bk1",
      paymentId: "pay_1",
      bookingModificationId: "mod_1",
      amountCents: 5000,
    });
  });
});
