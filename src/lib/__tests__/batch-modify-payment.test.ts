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
const mockAuth = vi.fn();
const mockRefundPaymentTransactions = vi.fn();
const mockUpsertPaymentIntentTransaction = vi.fn();
const mockAssertLinkedBookingMembersCanBeBooked = vi.fn().mockResolvedValue(undefined);
const mockGetBookingGuestValidationErrorResponse = vi.fn((error: { message: string }) => ({
  error: error.message,
}));
const mockEnqueueXeroSupplementaryInvoiceOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_supplementary", message: "queued" });
const mockEnqueueXeroModificationCreditNoteOperation = vi.fn().mockResolvedValue({ queueOperationId: "op_mod_credit_note", message: "queued" });
const mockKickQueuedXeroOutboxOperationsIfConnected = vi.fn().mockResolvedValue(null);

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
  calculatePromoDiscountForGuestRates: vi.fn().mockReturnValue({ discountCents: 0, freeNightsUsed: 0 }),
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
}));

vi.mock("@/lib/xero", () => ({
  createXeroSupplementaryInvoice: vi.fn().mockResolvedValue(undefined),
  createXeroCreditNoteForModification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroSupplementaryInvoiceOperation: mockEnqueueXeroSupplementaryInvoiceOperation,
  enqueueXeroModificationCreditNoteOperation: mockEnqueueXeroModificationCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected: mockKickQueuedXeroOutboxOperationsIfConnected,
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

vi.mock("@/lib/booking-modify-permissions", () => ({
  canModifyBookingStatus: vi.fn().mockReturnValue(true),
  usesActiveBookingLifecycle: vi.fn().mockReturnValue(true),
}));

function makeBooking() {
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
    },
    choreAssignment: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    payment: {
      update: vi.fn().mockResolvedValue(undefined),
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
    mockRefundPaymentTransactions.mockResolvedValue({
      refunds: [],
      totalRefundedAmountCents: 0,
    });
    mockUpsertPaymentIntentTransaction.mockResolvedValue(undefined);
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
      }
    );
    expect(mockKickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledWith({ limit: 1 });
  });
});
