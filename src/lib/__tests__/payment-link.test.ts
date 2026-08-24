import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus, PaymentStatus } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentLink: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    payment: {
      upsert: vi.fn(),
    },
    booking: {
      findUnique: vi.fn(),
    },
    // #2258: the withheld-send audit row (written at most once per booking).
    emailLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "emaillog-1" }),
    },
    bookingEvent: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
    },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  getPaymentIntent: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  // #2265 (#2319 door 1): the operator alert raised when a link refuses a
  // booking that still carries an unconsumed credit election.
  sendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
  sendBookingRequestApprovedEmail: vi
    .fn()
    .mockResolvedValue({ status: "sent", emailLogId: "log-1", messageId: null }),
  sendSplitGuestPaymentLinkEmail: vi
    .fn()
    .mockResolvedValue({ status: "sent", emailLogId: "log-2", messageId: null }),
}));

vi.mock("@/lib/payment-reconciliation", () => ({
  markBookingPaymentSucceeded: vi.fn(),
}));

vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/payment-transactions", () => ({
  findPaymentTransactionByIntentId: vi.fn().mockResolvedValue(null),
  upsertPaymentIntentTransaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: vi.fn(),
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
}));

const { loadEffectiveModuleFlagsMock, queueXeroInvoiceForPaidBookingMock } = vi.hoisted(() => ({
  loadEffectiveModuleFlagsMock: vi.fn(),
  queueXeroInvoiceForPaidBookingMock: vi.fn(),
}));
// Partial-mock so the module's other exports stay intact for transitive imports.
vi.mock("@/lib/module-settings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/module-settings")>(
    "@/lib/module-settings"
  );
  return { ...actual, loadEffectiveModuleFlags: loadEffectiveModuleFlagsMock };
});

vi.mock("@/lib/xero-booking-invoice-queue", () => ({
  queueXeroInvoiceForPaidBooking: queueXeroInvoiceForPaidBookingMock,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { createPaymentIntent, findOrCreateCustomer, getPaymentIntent } from "@/lib/stripe";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import {
  findPaymentTransactionByIntentId,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { hashActionToken, issueActionToken } from "@/lib/action-tokens";
import {
  sendAdminPaymentFailureAlert,
  sendBookingRequestApprovedEmail,
  sendSplitGuestPaymentLinkEmail,
} from "@/lib/email";
import {
  createPaymentIntentForPaymentLink,
  getPaymentLinkContext,
  issueSplitGuestPaymentLink,
  mintSplitGuestPaymentLinkIfAbsent,
  reissuePaymentLinkForToken,
  resolvePaymentLink,
  revokePaymentLinkById,
  revokePaymentLinksForBooking,
} from "@/lib/payment-link";

const mockedFindUnique = vi.mocked(prisma.paymentLink.findUnique);
const mockedUpdate = vi.mocked(prisma.paymentLink.update);
const mockedUpdateMany = vi.mocked(prisma.paymentLink.updateMany);
const mockedBookingEventFindMany = vi.mocked(prisma.bookingEvent.findMany);
const mockedTransaction = vi.mocked(prisma.$transaction);
const mockedGetPaymentIntent = vi.mocked(getPaymentIntent);
const mockedCreatePaymentIntent = vi.mocked(createPaymentIntent);
const mockedFindOrCreateCustomer = vi.mocked(findOrCreateCustomer);
const mockedMarkSucceeded = vi.mocked(markBookingPaymentSucceeded);
const mockedFindPaymentTransaction = vi.mocked(
  findPaymentTransactionByIntentId,
);
const mockedUpsertPaymentIntentTransaction = vi.mocked(
  upsertPaymentIntentTransaction,
);
const mockedCheckCapacity = vi.mocked(checkCapacityForGuestRanges);

const RAW_TOKEN = issueActionToken().token;

function baseLink(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "link-1",
    bookingId: "booking-1",
    bookingRequestId: "req-1",
    tokenHash: hashActionToken(RAW_TOKEN),
    revokedAt: null,
    usedAt: null,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    booking: baseBooking(),
    ...overrides,
  };
}

/**
 * This suite's bookings check in on 2026-08-01, and `reissuePaymentLinkForToken`
 * refuses a stay whose dates have already passed — read from the REAL clock. Left
 * unpinned the whole file went red on 2 August 2026 with nothing in any diff to
 * blame, which is the signature that gets written off as an environment flake
 * (#2426, #2401, #2443 are the same class; this is the fourth instance).
 *
 * Pin the clock a comfortable distance before the fixtures so "these dates are
 * still in the future" stays the intended scenario for good. Only `Date` is
 * faked, so real timers still drive any awaited promise. 2026-07-01T00:00:00Z
 * reads as 1 July in NZ (12:00 NZST) and in UTC alike, so the pinned "today"
 * does not depend on the runner's own zone.
 */
const FIXED_NOW = new Date("2026-07-01T00:00:00.000Z");

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

function baseBooking(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: BookingStatus.PENDING,
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
    finalPriceCents: 12000,
    deletedAt: null,
    member: { id: "member-1", email: "tara@example.com", firstName: "Tara", lastName: "Tester" },
    guests: [{ id: "guest-1" }],
    payment: null,
    parentBookingId: null,
    groupBookingJoin: null,
    // #2919: the pay page names the booking's own lodge, so the record the
    // narrative context is built from carries it.
    lodgeId: "lodge-1",
    lodge: { name: "Default Lodge" },
    ...overrides,
  };
}

describe("resolvePaymentLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects tokens that are not 64-char hex without a DB lookup", async () => {
    await expect(resolvePaymentLink("not-a-token")).rejects.toMatchObject({ status: 404 });
    expect(mockedFindUnique).not.toHaveBeenCalled();
  });

  it("returns a generic 404 for an unknown token", async () => {
    mockedFindUnique.mockResolvedValue(null);
    await expect(resolvePaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 404 });
  });

  it("returns a generic 404 when the booking has been soft-deleted", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ booking: baseBooking({ deletedAt: new Date() }) }) as never
    );
    await expect(resolvePaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 404 });
  });

  it("returns 410 for a revoked link", async () => {
    mockedFindUnique.mockResolvedValue(baseLink({ revokedAt: new Date() }) as never);
    await expect(resolvePaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 410 });
  });

  it("returns 410 for a used link on a booking that isn't PAID", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ usedAt: new Date(), booking: baseBooking({ status: BookingStatus.PENDING }) }) as never
    );
    await expect(resolvePaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 410 });
  });

  it("returns 410 for an expired link on a booking that isn't PAID", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ expiresAt: new Date("2000-01-01T00:00:00.000Z") }) as never
    );
    await expect(resolvePaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 410 });
  });

  it("allows a used/expired link through when the booking is already PAID (idempotent paid view)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({
        usedAt: new Date(),
        expiresAt: new Date("2000-01-01T00:00:00.000Z"),
        booking: baseBooking({ status: BookingStatus.PAID }),
      }) as never
    );
    const link = await resolvePaymentLink(RAW_TOKEN);
    expect(link.booking.status).toBe(BookingStatus.PAID);
  });

  it("looks up the link by the hash of the supplied token, not the raw token", async () => {
    mockedFindUnique.mockResolvedValue(baseLink() as never);
    await resolvePaymentLink(RAW_TOKEN);
    expect(mockedFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashActionToken(RAW_TOKEN) } })
    );
  });
});

describe("getPaymentLinkContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedBookingEventFindMany.mockResolvedValue([] as never);
    // Internet Banking module on by default.
    loadEffectiveModuleFlagsMock.mockResolvedValue({
      xeroIntegration: true,
      internetBankingPayments: true,
    });
  });

  it("returns a payable context for a PENDING booking without marking the link used", async () => {
    mockedFindUnique.mockResolvedValue(baseLink() as never);

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.state).toBe("payable");
    expect(context.payable?.amountCents).toBe(12000);
    expect(context.payable?.status).toBe(BookingStatus.PENDING);
    // Internet Banking is on, so the bank-transfer reference is offered.
    expect(context.payable?.internetBankingReference).toBe("BOOKING-BOOKING-");
    expect(context.narrative.message).toContain("$120.00");
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  // #2919: the public pay page's confirmation copy used to name the club's
  // DEFAULT lodge because the context carried no lodge at all. A booking at a
  // non-default lodge must come back naming that lodge.
  it("carries the booking's own lodge name, not the club default", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({
        booking: baseBooking({
          lodgeId: "lodge-2",
          lodge: { name: "Second Lodge" },
        }),
      }) as never
    );

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.lodgeName).toBe("Second Lodge");
  });

  it("asks the database for the booking's lodge name and nothing else about the lodge", async () => {
    mockedFindUnique.mockResolvedValue(baseLink() as never);

    await getPaymentLinkContext(RAW_TOKEN);

    const include = mockedFindUnique.mock.calls[0]?.[0] as unknown as {
      include: { booking: { include: Record<string, unknown> } };
    };
    // Name only — a token-authenticated public surface must never pull the
    // lodge's door code or travel note along with it.
    expect(include.include.booking.include.lodge).toEqual({
      select: { name: true },
    });
  });

  it("omits the internet banking reference when the module is off", async () => {
    loadEffectiveModuleFlagsMock.mockResolvedValue({
      xeroIntegration: false,
      internetBankingPayments: false,
    });
    mockedFindUnique.mockResolvedValue(baseLink() as never);

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.state).toBe("payable");
    expect(context.payable?.internetBankingReference).toBeUndefined();
  });

  it("returns a paid context and marks the link as used for a PAID booking", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ booking: baseBooking({ status: BookingStatus.PAID }) }) as never
    );
    mockedUpdate.mockResolvedValue({} as never);

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.state).toBe("paid");
    expect(context.payable).toBeNull();
    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: { usedAt: expect.any(Date) },
    });
  });

  it("treats a COMPLETED booking like PAID (no 'already used' error) and marks the link used", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({
        usedAt: new Date(),
        expiresAt: new Date("2000-01-01T00:00:00.000Z"),
        booking: baseBooking({ status: BookingStatus.COMPLETED }),
      }) as never
    );

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.state).toBe("paid");
    // Link already marked used — not re-marked.
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("does not re-mark a PAID booking's link as used if already marked", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({
        usedAt: new Date(),
        booking: baseBooking({ status: BookingStatus.PAID }),
      }) as never
    );

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.state).toBe("paid");
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("shows an expired-but-payable narrative (not an error) when the link has expired", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ expiresAt: new Date("2000-01-01T00:00:00.000Z") }) as never
    );

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.state).toBe("expired_payable");
    expect(context.canRequestFreshLink).toBe(true);
    expect(context.payable).toBeNull();
  });

  it("shows a bumped narrative (not an error) once the booking was bumped", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ booking: baseBooking({ status: BookingStatus.CANCELLED }) }) as never
    );
    mockedBookingEventFindMany.mockResolvedValue([
      {
        type: "BUMPED",
        occurredAt: new Date("2026-07-01T00:00:00.000Z"),
        amountCents: null,
        reason: null,
        snapshot: { flagged: false },
      },
    ] as never);

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.state).toBe("bumped");
    expect(context.narrative.message).toMatch(/filled up/i);
  });

  it("shows a clear cancelled narrative (not an error) once the booking is CANCELLED", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ booking: baseBooking({ status: BookingStatus.CANCELLED }) }) as never
    );

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.state).toBe("cancelled_pre_payment");
    expect(context.narrative.message).toMatch(/cancelled/i);
  });
});

describe("reissuePaymentLinkForToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTransaction.mockImplementation(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
  });

  it("issues a fresh link and emails it for an expired-but-payable booking", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ expiresAt: new Date("2000-01-01T00:00:00.000Z") }) as never
    );

    const result = await reissuePaymentLinkForToken(RAW_TOKEN);

    expect(result.emailed).toBe(true);
    expect(vi.mocked(prisma.paymentLink.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bookingId: "booking-1" }),
      })
    );
    expect(sendBookingRequestApprovedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "tara@example.com" })
    );
  });

  it("returns emailed:false when the requester's address is actively suppressed (F25, #1885)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ expiresAt: new Date("2000-01-01T00:00:00.000Z") }) as never
    );
    // sendEmail suppressed the delivery (prior SES bounce/complaint): nothing
    // was sent, so the caller must not be told an email is on the way.
    vi.mocked(sendBookingRequestApprovedEmail).mockResolvedValueOnce({
      status: "suppressed",
      emailLogId: "log-1",
      emailSuppressionId: "sup-1",
      reason: "BOUNCE",
    } as never);

    const result = await reissuePaymentLinkForToken(RAW_TOKEN);

    expect(result.emailed).toBe(false);
    // The fresh link itself is still minted; only the email claim changes.
    expect(vi.mocked(prisma.paymentLink.create)).toHaveBeenCalled();
  });

  it("refuses to re-issue a link for a booking that can no longer be paid", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ booking: baseBooking({ status: BookingStatus.CANCELLED }) }) as never
    );

    await expect(reissuePaymentLinkForToken(RAW_TOKEN)).rejects.toMatchObject({
      status: 410,
    });
    expect(sendBookingRequestApprovedEmail).not.toHaveBeenCalled();
  });

  it("re-issues a split child's expired link with the split-guest template, never the booking-request one (#1967 FIX-7)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({
        // A split-child link has no originating booking request...
        bookingRequestId: null,
        expiresAt: new Date("2000-01-01T00:00:00.000Z"),
        booking: baseBooking({
          // ...and its booking is a genuine split child (parent-linked, no
          // #796 group-join row).
          parentBookingId: "parent-1",
          groupBookingJoin: null,
        }),
      }) as never
    );

    const result = await reissuePaymentLinkForToken(RAW_TOKEN);

    expect(result.emailed).toBe(true);
    expect(sendSplitGuestPaymentLinkEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "tara@example.com", bookingReference: "booking-1" })
    );
    expect(sendBookingRequestApprovedEmail).not.toHaveBeenCalled();
  });

  it("keeps the booking-request template for a #796 group joiner's link (pre-existing behaviour)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({
        bookingRequestId: null,
        expiresAt: new Date("2000-01-01T00:00:00.000Z"),
        booking: baseBooking({
          parentBookingId: "organiser-1",
          groupBookingJoin: { id: "join-1" },
        }),
      }) as never
    );

    await reissuePaymentLinkForToken(RAW_TOKEN);

    expect(sendBookingRequestApprovedEmail).toHaveBeenCalled();
    expect(sendSplitGuestPaymentLinkEmail).not.toHaveBeenCalled();
  });
});

describe("revokePaymentLinksForBooking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("revokes only active, unused links for the booking", async () => {
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);

    const count = await revokePaymentLinksForBooking("booking-1");

    expect(count).toBe(1);
    expect(mockedUpdateMany).toHaveBeenCalledWith({
      where: { bookingId: "booking-1", revokedAt: null, usedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

describe("createPaymentIntentForPaymentLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueXeroInvoiceForPaidBookingMock.mockResolvedValue({
      queueOperationId: "xero-op-1",
      message: "queued",
    });
    mockedTransaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma)
    );
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] } as never);
  });

  it("throws USED_LINK_MESSAGE when the booking is already PAID", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ booking: baseBooking({ status: BookingStatus.PAID }) }) as never
    );

    await expect(createPaymentIntentForPaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 410 });
    expect(mockedFindOrCreateCustomer).not.toHaveBeenCalled();
  });

  it("throws NOT_PAYABLE_MESSAGE for a CANCELLED booking", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ booking: baseBooking({ status: BookingStatus.CANCELLED }) }) as never
    );

    await expect(createPaymentIntentForPaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 410 });
    expect(mockedFindOrCreateCustomer).not.toHaveBeenCalled();
  });

  it("reuses an existing PaymentIntent's client secret instead of creating a new one", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({
        booking: baseBooking({
          payment: { id: "pay-1", stripePaymentIntentId: "pi_existing", status: PaymentStatus.PENDING },
        }),
      }) as never
    );
    mockedGetPaymentIntent.mockResolvedValue({
      id: "pi_existing",
      status: "requires_payment_method",
      client_secret: "secret_existing",
      amount: 12000,
      payment_method: null,
    } as never);

    const result = await createPaymentIntentForPaymentLink(RAW_TOKEN);

    expect(result).toEqual({ type: "clientSecret", clientSecret: "secret_existing", paymentIntentId: "pi_existing" });
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("supersedes a stale-amount intent and mints a fresh one at the current price (#1161)", async () => {
    const { queueSupersededPrimaryIntentCancellations } = await import(
      "@/lib/booking-payment-cleanup"
    );
    mockedFindUnique.mockResolvedValue(
      baseLink({
        booking: baseBooking({
          payment: { id: "pay-1", stripePaymentIntentId: "pi_stale", status: PaymentStatus.PENDING },
        }),
      }) as never
    );
    // Minted at $100 before the unpaid booking was edited to $120.
    mockedGetPaymentIntent.mockResolvedValue({
      id: "pi_stale",
      status: "requires_payment_method",
      client_secret: "secret_stale",
      amount: 10000,
      payment_method: null,
    } as never);
    vi.mocked(prisma.booking.findUnique).mockResolvedValue(
      baseBooking({ guests: [{ id: "guest-1" }] }) as never
    );
    mockedFindOrCreateCustomer.mockResolvedValue({ id: "cus_123" } as never);
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_new",
      client_secret: "secret_new",
      amount: 12000,
    } as never);
    vi.mocked(prisma.payment.upsert).mockResolvedValue({ id: "pay-1" } as never);

    const result = await createPaymentIntentForPaymentLink(RAW_TOKEN);

    // The stale secret is never disclosed; a fresh intent carries the
    // current price and the stale one is queued for cancellation.
    expect(result).toEqual({
      type: "clientSecret",
      clientSecret: "secret_new",
      paymentIntentId: "pi_new",
    });
    expect(vi.mocked(queueSupersededPrimaryIntentCancellations)).toHaveBeenCalledWith(
      expect.anything(),
      {
        bookingId: "booking-1",
        paymentId: "pay-1",
        newFinalPriceCents: 12000,
      },
    );
    expect(mockedCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 12000 }),
    );
  });

  it("reports alreadyPaid and reconciles when the existing PaymentIntent already succeeded", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({
        booking: baseBooking({
          payment: { id: "pay-1", stripePaymentIntentId: "pi_existing", status: PaymentStatus.PENDING },
        }),
      }) as never
    );
    mockedGetPaymentIntent.mockResolvedValue({
      id: "pi_existing",
      status: "succeeded",
      client_secret: "secret_existing",
      amount: 12000,
      payment_method: "pm_123",
    } as never);
    mockedMarkSucceeded.mockResolvedValue({ outcome: "confirmed" } as never);

    const result = await createPaymentIntentForPaymentLink(RAW_TOKEN);

    expect(result).toEqual({ type: "alreadyPaid" });
    expect(mockedMarkSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1", paymentIntentId: "pi_existing" })
    );
    expect(queueXeroInvoiceForPaidBookingMock).toHaveBeenCalledWith({
      bookingId: "booking-1",
    });
  });

  it.each([PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED])(
    "never reuses an equal-amount succeeded intent's client secret when its transaction is %s",
    async (refundedStatus) => {
      mockedFindUnique.mockResolvedValue(
        baseLink({
          booking: baseBooking({
            payment: {
              id: "pay-1",
              stripePaymentIntentId: "pi_refunded",
              status: PaymentStatus.SUCCEEDED,
            },
          }),
        }) as never,
      );
      mockedGetPaymentIntent.mockResolvedValue({
        id: "pi_refunded",
        status: "succeeded",
        // Stripe retains the client secret after success/refund. Keeping this
        // production-shaped is the mutation proof: removing the explicit repay
        // bypass would return this old secret before the fresh mint below.
        client_secret: "secret_refunded_must_not_be_reused",
        amount: 12000,
        payment_method: "pm_old",
      } as never);
      mockedFindPaymentTransaction.mockResolvedValueOnce({
        status: refundedStatus,
      } as never);
      vi.mocked(prisma.booking.findUnique).mockResolvedValue(
        baseBooking({ guests: [{ id: "guest-1" }] }) as never,
      );
      mockedFindOrCreateCustomer.mockResolvedValue({ id: "cus_123" } as never);
      mockedCreatePaymentIntent.mockResolvedValue({
        id: "pi_repay",
        client_secret: "secret_repay",
      } as never);
      vi.mocked(prisma.payment.upsert).mockResolvedValue({ id: "pay-1" } as never);

      await expect(
        createPaymentIntentForPaymentLink(RAW_TOKEN),
      ).resolves.toEqual({
        type: "clientSecret",
        clientSecret: "secret_repay",
        paymentIntentId: "pi_repay",
      });
      expect(mockedMarkSucceeded).not.toHaveBeenCalled();
      expect(mockedCreatePaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 12000,
          idempotencyKey: "pl_pi_booking-1_repay_pi_refunded",
        }),
      );
      expect(mockedUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentIntentId: "pi_repay",
          reason: "payment_link_repay_after_refund",
        }),
      );
    },
  );

  it("does not claim receipt when the succeeded prior intent cannot be classified", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({
        booking: baseBooking({
          payment: {
            id: "pay-1",
            stripePaymentIntentId: "pi_unknown",
            status: PaymentStatus.PENDING,
          },
        }),
      }) as never,
    );
    mockedGetPaymentIntent.mockResolvedValue({
      id: "pi_unknown",
      status: "succeeded",
      amount: 12000,
      payment_method: "pm_old",
    } as never);
    mockedFindPaymentTransaction.mockRejectedValueOnce(
      new Error("database detail must stay private"),
    );

    await expect(
      createPaymentIntentForPaymentLink(RAW_TOKEN),
    ).rejects.toMatchObject({ kind: "existing_card_status_unconfirmed" });
    expect(mockedMarkSucceeded).not.toHaveBeenCalled();
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("classifies an ordinary post-capture failure without exposing provider detail", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({
        booking: baseBooking({
          payment: {
            id: "pay-1",
            stripePaymentIntentId: "pi_captured",
            status: PaymentStatus.PENDING,
          },
        }),
      }) as never,
    );
    mockedGetPaymentIntent.mockResolvedValue({
      id: "pi_captured",
      status: "succeeded",
      amount: 12000,
      payment_method: "pm_old",
    } as never);
    mockedMarkSucceeded.mockRejectedValueOnce(
      new Error("sk_test_private provider detail"),
    );

    await expect(
      createPaymentIntentForPaymentLink(RAW_TOKEN),
    ).rejects.toMatchObject({ kind: "payment_received_status_unconfirmed" });
  });

  it("classifies participant contention after capture as finalisation pending", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({
        booking: baseBooking({
          payment: {
            id: "pay-1",
            stripePaymentIntentId: "pi_captured",
            status: PaymentStatus.PENDING,
          },
        }),
      }) as never,
    );
    mockedGetPaymentIntent.mockResolvedValue({
      id: "pi_captured",
      status: "succeeded",
      amount: 12000,
      payment_method: "pm_old",
    } as never);
    mockedMarkSucceeded.mockRejectedValueOnce({
      code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
      message: "private contention detail",
    });

    await expect(
      createPaymentIntentForPaymentLink(RAW_TOKEN),
    ).rejects.toMatchObject({
      kind: "payment_received_finalisation_pending",
      message: "Payment-link card status requires recovery",
    });
  });

  /**
   * #2265 (#2319 door 1). A stored credit election is a member's standing request
   * to spend their own account-credit balance. This route is authenticated by a
   * bearer token routinely held by SOMEONE ELSE — a booking requester, a group
   * joiner, a non-member guest — with no member session and no surface on which
   * to show the member that their election was clamped. So it refuses, rather
   * than either charging the pre-credit price (which would ignore the choice) or
   * consuming the credit (which would spend a member's balance on a third
   * party's token). Refusing loses nothing: the member's own pay step still
   * honours the election.
   *
   * No mint path in the app attaches a link to a booking that can carry an
   * election, so this is an assertion of that invariant rather than a routine
   * branch — which is exactly why it must alert loudly instead of failing quietly.
   */
  it("refuses to mint an intent for a booking carrying an unconsumed credit election (#2265)", async () => {
    mockedFindUnique.mockResolvedValue(baseLink() as never);
    vi.mocked(prisma.booking.findUnique).mockResolvedValue(
      baseBooking({ guests: [{ id: "guest-1" }], creditElectionCents: 4500 }) as never
    );

    await expect(createPaymentIntentForPaymentLink(RAW_TOKEN)).rejects.toMatchObject({
      status: 409,
    });

    // Nothing was charged and no Stripe object was even created.
    expect(mockedFindOrCreateCustomer).not.toHaveBeenCalled();
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.payment.upsert)).not.toHaveBeenCalled();
    // The election is left exactly where it was: this route never writes the
    // Booking row, so the member can still pay from their own bookings page and
    // have the credit applied there. (The prisma double has no booking.update at
    // all, so any attempt to clear it would have thrown.)
    expect(prisma.booking).not.toHaveProperty("update");
    // Loud: an officer is told, with the figure, because this state is not
    // supposed to be reachable.
    expect(vi.mocked(sendAdminPaymentFailureAlert)).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 4500,
        paymentIntentId: "booking-1",
        errorMessage: expect.stringContaining("$45.00"),
      })
    );
  });

  it("mints normally for a booking whose election is explicitly NULL (#2265)", async () => {
    mockedFindUnique.mockResolvedValue(baseLink() as never);
    vi.mocked(prisma.booking.findUnique).mockResolvedValue(
      baseBooking({ guests: [{ id: "guest-1" }], creditElectionCents: null }) as never
    );
    mockedFindOrCreateCustomer.mockResolvedValue({ id: "cus_1" } as never);
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_new",
      client_secret: "secret_new",
    } as never);
    vi.mocked(prisma.payment.upsert).mockResolvedValue({ id: "pay-1" } as never);

    const result = await createPaymentIntentForPaymentLink(RAW_TOKEN);

    // NULL is the column's "nothing outstanding" state, which every pre-#2265
    // row is already in — so the guard must be a no-op here, with the full price
    // charged exactly as before.
    expect(result).toEqual({
      type: "clientSecret",
      clientSecret: "secret_new",
      paymentIntentId: "pi_new",
    });
    expect(mockedCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 12000 })
    );
    expect(vi.mocked(sendAdminPaymentFailureAlert)).not.toHaveBeenCalled();
  });

  it("revalidates capacity under the advisory lock and refuses when beds are gone", async () => {
    mockedFindUnique.mockResolvedValue(baseLink() as never);
    vi.mocked(prisma.booking.findUnique).mockResolvedValue(
      baseBooking({ guests: [{ id: "guest-1" }] }) as never
    );
    mockedCheckCapacity.mockResolvedValue({ available: false, minAvailable: -1, nightDetails: [] } as never);

    await expect(createPaymentIntentForPaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 409 });
    expect(mockedFindOrCreateCustomer).not.toHaveBeenCalled();
  });

  // #1771 — a booking deliberately admitted over the ceiling by an admin carries
  // a persisted capacityOverriddenAt marker. The payment-link capacity re-check
  // must NOT 409 it: the payment proceeds and a fresh intent is minted.
  it("pays an over-capacity booking with a persisted capacity override instead of 409ing (#1771)", async () => {
    mockedFindUnique.mockResolvedValue(baseLink() as never);
    vi.mocked(prisma.booking.findUnique).mockResolvedValue(
      baseBooking({
        guests: [{ id: "guest-1" }],
        capacityOverriddenAt: new Date("2026-06-01T00:00:00.000Z"),
        capacityOverriddenByMemberId: "admin-1",
      }) as never
    );
    mockedCheckCapacity.mockResolvedValue({ available: false, minAvailable: -1, nightDetails: [] } as never);
    mockedFindOrCreateCustomer.mockResolvedValue({ id: "cus_123" } as never);
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_new",
      client_secret: "secret_new",
      amount: 12000,
    } as never);
    vi.mocked(prisma.payment.upsert).mockResolvedValue({ id: "pay-1" } as never);

    const result = await createPaymentIntentForPaymentLink(RAW_TOKEN);

    expect(result).toMatchObject({ type: "clientSecret", paymentIntentId: "pi_new" });
    // The payment proceeded rather than 409ing.
    expect(mockedFindOrCreateCustomer).toHaveBeenCalled();
    expect(mockedCreatePaymentIntent).toHaveBeenCalled();
  });

  it("consumes the POST-lock re-read (not the pre-lock read) for the capacity check (H3)", async () => {
    // Pre-lock read is a lodgeId-only key select; the buggy order consumed its
    // stale dates/guests. Make the two in-transaction reads differ and prove
    // the capacity check ran against the POST-lock snapshot.
    mockedFindUnique.mockResolvedValue(baseLink() as never);
    let readCount = 0;
    vi.mocked(prisma.booking.findUnique).mockImplementation((async () =>
      readCount++ === 0
        ? {
            lodgeId: "lodge-1",
            checkIn: new Date("2026-01-01T00:00:00.000Z"),
            checkOut: new Date("2026-01-03T00:00:00.000Z"),
          }
        : baseBooking({
            checkIn: new Date("2026-05-20T00:00:00.000Z"),
            checkOut: new Date("2026-05-22T00:00:00.000Z"),
            guests: [{ id: "g-post" }],
          })) as never);
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] } as never);
    mockedFindOrCreateCustomer.mockResolvedValue({ id: "cus_123" } as never);
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_new",
      client_secret: "secret_new",
      amount: 12000,
    } as never);
    vi.mocked(prisma.payment.upsert).mockResolvedValue({ id: "pay-1" } as never);

    await createPaymentIntentForPaymentLink(RAW_TOKEN);

    // Pre-lock read selects only the lock key.
    expect(vi.mocked(prisma.booking.findUnique)).toHaveBeenNthCalledWith(1, {
      where: { id: "booking-1" },
      select: { lodgeId: true },
    });
    // The capacity check ran against the POST-lock (May) dates + guest set.
    expect(mockedCheckCapacity).toHaveBeenCalledWith(
      "lodge-1",
      new Date("2026-05-20T00:00:00.000Z"),
      new Date("2026-05-22T00:00:00.000Z"),
      [{ id: "g-post" }],
      "booking-1",
      expect.anything()
    );
  });

  it("creates a new PaymentIntent for a fresh payable booking", async () => {
    mockedFindUnique.mockResolvedValue(baseLink() as never);
    vi.mocked(prisma.booking.findUnique).mockResolvedValue(
      baseBooking({ guests: [{ id: "guest-1" }] }) as never
    );
    mockedFindOrCreateCustomer.mockResolvedValue({ id: "cus_123" } as never);
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_new",
      client_secret: "secret_new",
      amount: 12000,
    } as never);
    vi.mocked(prisma.payment.upsert).mockResolvedValue({ id: "pay-1" } as never);

    const result = await createPaymentIntentForPaymentLink(RAW_TOKEN);

    expect(result).toEqual({ type: "clientSecret", clientSecret: "secret_new", paymentIntentId: "pi_new" });
    expect(mockedFindOrCreateCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ email: "tara@example.com", memberId: "member-1" })
    );
    expect(mockedCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 12000,
        metadata: expect.objectContaining({ bookingId: "booking-1", paymentLinkId: "link-1" }),
      })
    );
  });

  it("throws when the booking has no client secret available", async () => {
    mockedFindUnique.mockResolvedValue(baseLink() as never);
    vi.mocked(prisma.booking.findUnique).mockResolvedValue(
      baseBooking({ guests: [{ id: "guest-1" }] }) as never
    );
    mockedFindOrCreateCustomer.mockResolvedValue({ id: "cus_123" } as never);
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_new",
      client_secret: null,
      amount: 12000,
    } as never);
    vi.mocked(prisma.payment.upsert).mockResolvedValue({ id: "pay-1" } as never);

    await expect(createPaymentIntentForPaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 500 });
  });

  it("refuses with 410 when the link was revoked between resolution and the under-lock re-read (#1967 FIX-6)", async () => {
    // The cron's auto-charge claim revokes links under the lodge lock just
    // before charging a saved card; a /pay request that resolved the link a
    // moment earlier must see the revocation in its own locked re-read and
    // never mint a competing PaymentIntent.
    mockedFindUnique.mockImplementation((async ({
      where,
    }: {
      where: { tokenHash?: string; id?: string };
    }) =>
      where.tokenHash
        ? baseLink() // initial token resolution: still active
        : { revokedAt: new Date() }) as never); // under-lock re-read: revoked
    vi.mocked(prisma.booking.findUnique).mockResolvedValue(
      baseBooking({ guests: [{ id: "guest-1" }] }) as never
    );

    await expect(createPaymentIntentForPaymentLink(RAW_TOKEN)).rejects.toMatchObject({
      status: 410,
    });
    expect(mockedFindOrCreateCustomer).not.toHaveBeenCalled();
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
  });
});

describe("issueSplitGuestPaymentLink (#1967)", () => {
  const mockedBookingFindUnique = vi.mocked(prisma.booking.findUnique);
  const mockedPaymentLinkFindFirst = vi.mocked(prisma.paymentLink.findFirst);
  const mockedPaymentLinkCreate = vi.mocked(prisma.paymentLink.create);

  function splitChild(overrides: Record<string, unknown> = {}) {
    return {
      id: "child-1",
      memberId: "member-1",
      status: BookingStatus.PENDING,
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      finalPriceCents: 12000,
      deletedAt: null,
      parentBookingId: "parent-1",
      hasNonMembers: true,
      lodgeId: "lodge-1",
      member: {
        id: "member-1",
        email: "tara@example.com",
        firstName: "Tara",
        lastName: "Tester",
      },
      guests: [{ id: "g1" }, { id: "g2" }],
      // No saved card anywhere (FIX-5) and not a #796 group joiner (FIX-2).
      payment: null,
      parentBooking: { id: "parent-1", payment: null },
      groupBookingJoin: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.emailLog.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.emailLog.create).mockResolvedValue({ id: "emaillog-1" } as never);
    // The helper mints under the shared booking advisory lock: invoke the
    // transaction callback with a tx exposing only what it touches.
    mockedTransaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") {
        return (arg as (tx: unknown) => unknown)({
          booking: { findUnique: mockedBookingFindUnique },
          paymentLink: {
            findFirst: mockedPaymentLinkFindFirst,
            create: mockedPaymentLinkCreate,
            updateMany: mockedUpdateMany,
          },
        });
      }
      return arg;
    });
    mockedUpdateMany.mockResolvedValue({ count: 0 } as never);
  });

  it("returns not_payable for a non-child booking without minting or emailing", async () => {
    mockedBookingFindUnique.mockResolvedValue(
      splitChild({ parentBookingId: null }) as never
    );

    const result = await issueSplitGuestPaymentLink("child-1");

    expect(result).toEqual({ outcome: "not_payable" });
    expect(mockedPaymentLinkCreate).not.toHaveBeenCalled();
    expect(sendSplitGuestPaymentLinkEmail).not.toHaveBeenCalled();
  });

  it("returns not_payable for a #796 group joiner, which must never enter the split-guest flow (#1967 FIX-2)", async () => {
    mockedBookingFindUnique.mockResolvedValue(
      splitChild({ groupBookingJoin: { id: "join-1" } }) as never
    );

    const result = await issueSplitGuestPaymentLink("child-1");

    expect(result).toEqual({ outcome: "not_payable" });
    expect(mockedPaymentLinkCreate).not.toHaveBeenCalled();
    expect(sendSplitGuestPaymentLinkEmail).not.toHaveBeenCalled();
  });

  it("returns not_payable when the parent payment carries a saved card — the cron will auto-charge (#1967 FIX-5)", async () => {
    mockedBookingFindUnique.mockResolvedValue(
      splitChild({
        parentBooking: {
          id: "parent-1",
          payment: {
            id: "pay-parent",
            stripeCustomerId: "cus_parent",
            stripePaymentMethodId: "pm_parent",
          },
        },
      }) as never
    );

    const result = await issueSplitGuestPaymentLink("child-1");

    expect(result).toEqual({ outcome: "not_payable" });
    expect(mockedPaymentLinkCreate).not.toHaveBeenCalled();
    expect(sendSplitGuestPaymentLinkEmail).not.toHaveBeenCalled();
  });

  it("returns not_payable when the child's own payment carries a saved card (#1967 FIX-5)", async () => {
    mockedBookingFindUnique.mockResolvedValue(
      splitChild({
        payment: {
          id: "pay-child",
          stripeCustomerId: "cus_child",
          stripePaymentMethodId: "pm_child",
        },
      }) as never
    );

    const result = await issueSplitGuestPaymentLink("child-1");

    expect(result).toEqual({ outcome: "not_payable" });
    expect(mockedPaymentLinkCreate).not.toHaveBeenCalled();
    expect(sendSplitGuestPaymentLinkEmail).not.toHaveBeenCalled();
  });

  it("returns not_payable when the under-lock re-read finds the booking has left PENDING (#1967)", async () => {
    mockedBookingFindUnique
      .mockResolvedValueOnce(splitChild() as never) // outer load
      .mockResolvedValueOnce({ status: BookingStatus.CANCELLED } as never); // under-lock re-read

    const result = await issueSplitGuestPaymentLink("child-1");

    expect(result).toEqual({ outcome: "not_payable" });
    expect(mockedPaymentLinkFindFirst).not.toHaveBeenCalled();
    expect(mockedPaymentLinkCreate).not.toHaveBeenCalled();
    expect(sendSplitGuestPaymentLinkEmail).not.toHaveBeenCalled();
  });

  // #2258 review finding: discovering the withhold only at SEND time meant the
  // link was minted, the send withheld, and the link revoked — every single run.
  it("mints nothing at all when the booking has No emails on, and records the withhold once", async () => {
    mockedBookingFindUnique.mockResolvedValue(
      splitChild({ noEmails: true }) as never
    );

    const result = await issueSplitGuestPaymentLink("child-1");

    expect(result).toEqual({ outcome: "withheld" });
    // The whole point: no mint, so no revoke, so no churn.
    expect(mockedPaymentLinkCreate).not.toHaveBeenCalled();
    expect(mockedPaymentLinkFindFirst).not.toHaveBeenCalled();
    expect(sendSplitGuestPaymentLinkEmail).not.toHaveBeenCalled();
    // Recorded idempotently, so repeat attempts do not flood the withheld list.
    expect(vi.mocked(prisma.emailLog.findFirst)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bookingId: "child-1",
          templateName: "split-guest-payment-link",
        }),
      })
    );
  });

  it("writes no second withheld row when one already exists", async () => {
    mockedBookingFindUnique.mockResolvedValue(
      splitChild({ noEmails: true }) as never
    );
    vi.mocked(prisma.emailLog.findFirst).mockResolvedValue({
      id: "log-existing",
    } as never);

    await issueSplitGuestPaymentLink("child-1");

    expect(vi.mocked(prisma.emailLog.create)).not.toHaveBeenCalled();
  });

  it("mints a link and emails the member's guest portion on the first request", async () => {
    mockedBookingFindUnique
      .mockResolvedValueOnce(splitChild() as never) // outer load
      .mockResolvedValueOnce({ status: BookingStatus.PENDING } as never); // under-lock re-read
    mockedPaymentLinkFindFirst.mockResolvedValue(null);
    mockedPaymentLinkCreate.mockResolvedValue({ id: "pl-1" } as never);

    const result = await issueSplitGuestPaymentLink("child-1");

    expect(result).toEqual({ outcome: "sent" });
    expect(mockedPaymentLinkCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bookingId: "child-1" }),
      })
    );
    expect(sendSplitGuestPaymentLinkEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "tara@example.com",
        priceCents: 12000,
        guestCount: 2,
        bookingReference: "child-1",
      })
    );
  });

  it("short-circuits to just_sent when an active link was minted moments ago (double-click guard)", async () => {
    mockedBookingFindUnique
      .mockResolvedValueOnce(splitChild() as never)
      .mockResolvedValueOnce({ status: BookingStatus.PENDING } as never);
    mockedPaymentLinkFindFirst.mockResolvedValue({
      id: "pl-existing",
      createdAt: new Date(Date.now() - 10_000), // 10s old — inside cooldown
    } as never);

    const result = await issueSplitGuestPaymentLink("child-1");

    expect(result).toEqual({ outcome: "just_sent" });
    expect(mockedPaymentLinkCreate).not.toHaveBeenCalled();
    expect(mockedUpdateMany).not.toHaveBeenCalled();
    expect(sendSplitGuestPaymentLinkEmail).not.toHaveBeenCalled();
  });

  it("revokes and re-mints past the cooldown: a true re-send replaces the unrecoverable token (#1967 FIX-3b)", async () => {
    mockedBookingFindUnique
      .mockResolvedValueOnce(splitChild() as never)
      .mockResolvedValueOnce({ status: BookingStatus.PENDING } as never);
    mockedPaymentLinkFindFirst.mockResolvedValue({
      id: "pl-existing",
      createdAt: new Date(Date.now() - 10 * 60_000), // 10 min old
    } as never);
    mockedPaymentLinkCreate.mockResolvedValue({ id: "pl-fresh" } as never);

    const result = await issueSplitGuestPaymentLink("child-1");

    expect(result).toEqual({ outcome: "sent" });
    // Revocation and mint are one atomic step under the lodge lock:
    // exactly-one-active-link is preserved.
    expect(mockedUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bookingId: "child-1",
          revokedAt: null,
          usedAt: null,
        }),
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      })
    );
    expect(mockedPaymentLinkCreate).toHaveBeenCalled();
    expect(sendSplitGuestPaymentLinkEmail).toHaveBeenCalled();
  });

  it("revokes the just-minted link when the email is suppressed, so nothing unreachable stays active (#1967 FIX-3)", async () => {
    mockedBookingFindUnique
      .mockResolvedValueOnce(splitChild() as never)
      .mockResolvedValueOnce({ status: BookingStatus.PENDING } as never);
    mockedPaymentLinkFindFirst.mockResolvedValue(null);
    mockedPaymentLinkCreate.mockResolvedValue({ id: "pl-fresh" } as never);
    vi.mocked(sendSplitGuestPaymentLinkEmail).mockResolvedValueOnce({
      status: "suppressed",
      emailLogId: null,
      emailSuppressionId: "sup-1",
      reason: "BOUNCE",
    } as never);

    const result = await issueSplitGuestPaymentLink("child-1");

    expect(result).toEqual({ outcome: "suppressed" });
    // Post-commit revocation targets exactly the minted row by id.
    expect(mockedUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "pl-fresh",
          revokedAt: null,
          usedAt: null,
        }),
      })
    );
  });

  /*
    #3035 review: AN ENVIRONMENT WITHHOLD IS NOT AN UNDELIVERABLE ADDRESS.

    Every non-sent outcome used to fall into `suppressed`, and the route turns
    that into a 502 reading "your email address is undeliverable" — shown to a
    MEMBER. On the epic's headline case (a live club upgraded without the
    declaration) the member's mailbox is perfectly fine and the club has simply
    not told the software what the installation is. The same file already states
    that rule for the unreadable-switch case: telling somebody their address is
    undeliverable when it is not is misinformation, and it points an officer at
    the wrong diagnosis.
  */
  it("reports an undeclared installation as a TRANSIENT failure, not an undeliverable address", async () => {
    mockedBookingFindUnique
      .mockResolvedValueOnce(splitChild() as never)
      .mockResolvedValueOnce({ status: BookingStatus.PENDING } as never);
    mockedPaymentLinkFindFirst.mockResolvedValue(null);
    mockedPaymentLinkCreate.mockResolvedValue({ id: "pl-fresh" } as never);
    vi.mocked(sendSplitGuestPaymentLinkEmail).mockResolvedValueOnce({
      status: "withheld_for_environment",
      emailLogId: "log-1",
      reason: "environment_unknown",
    } as never);

    const result = await issueSplitGuestPaymentLink("child-1");

    // 503 "try again shortly" rather than 502 "your address is undeliverable".
    expect(result).toEqual({ outcome: "transient_failure" });
    // The unreachable link is still revoked, exactly as for every other
    // non-send: nothing minted may stay active.
    expect(mockedUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "pl-fresh", revokedAt: null }),
      })
    );
  });

  it("reports a live site wrongly declaring a capture mailbox as transient too", async () => {
    mockedBookingFindUnique
      .mockResolvedValueOnce(splitChild() as never)
      .mockResolvedValueOnce({ status: BookingStatus.PENDING } as never);
    mockedPaymentLinkFindFirst.mockResolvedValue(null);
    mockedPaymentLinkCreate.mockResolvedValue({ id: "pl-fresh" } as never);
    vi.mocked(sendSplitGuestPaymentLinkEmail).mockResolvedValueOnce({
      status: "withheld_for_environment",
      emailLogId: "log-1",
      reason: "capture_transport_in_production",
    } as never);

    expect(await issueSplitGuestPaymentLink("child-1")).toEqual({
      outcome: "transient_failure",
    });
  });

  it("reports a confirmed COPY as withheld, which is the deliberate bucket", async () => {
    /*
      Not transient: a copy is a copy until somebody re-declares it, so "try again
      shortly" would be false. `withheld` is the non-transient, no-cause-disclosed
      bucket the per-booking "No emails" switch already uses.
    */
    mockedBookingFindUnique
      .mockResolvedValueOnce(splitChild() as never)
      .mockResolvedValueOnce({ status: BookingStatus.PENDING } as never);
    mockedPaymentLinkFindFirst.mockResolvedValue(null);
    mockedPaymentLinkCreate.mockResolvedValue({ id: "pl-fresh" } as never);
    vi.mocked(sendSplitGuestPaymentLinkEmail).mockResolvedValueOnce({
      status: "withheld_for_environment",
      emailLogId: "log-1",
      reason: "environment_non_production",
    } as never);

    expect(await issueSplitGuestPaymentLink("child-1")).toEqual({
      outcome: "withheld",
    });
  });

  it("revokes the just-minted link and rethrows when the email send throws (#1967 FIX-3)", async () => {
    mockedBookingFindUnique
      .mockResolvedValueOnce(splitChild() as never)
      .mockResolvedValueOnce({ status: BookingStatus.PENDING } as never);
    mockedPaymentLinkFindFirst.mockResolvedValue(null);
    mockedPaymentLinkCreate.mockResolvedValue({ id: "pl-fresh" } as never);
    vi.mocked(sendSplitGuestPaymentLinkEmail).mockRejectedValueOnce(
      new Error("SES unavailable")
    );

    await expect(issueSplitGuestPaymentLink("child-1")).rejects.toThrow(
      "SES unavailable"
    );
    expect(mockedUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "pl-fresh" }),
      })
    );
  });
});

describe("mintSplitGuestPaymentLinkIfAbsent (#1967) — real helper against a stateful store", () => {
  type StoredLink = {
    id: string;
    bookingId: string;
    tokenHash: string;
    expiresAt: Date;
    usedAt: Date | null;
    revokedAt: Date | null;
  };

  // A minimal in-memory PaymentLink table honouring exactly the query shapes
  // the helper issues, so consecutive calls exercise the REAL cross-run
  // idempotency sentinel rather than a mocked return value.
  function makeStatefulTx(seed: StoredLink[] = []) {
    const links: StoredLink[] = [...seed];
    let nextId = seed.length + 1;
    const tx = {
      paymentLink: {
        findFirst: async ({
          where,
        }: {
          where: { bookingId: string; expiresAt: { gt: Date } };
        }) =>
          links.find(
            (l) =>
              l.bookingId === where.bookingId &&
              l.revokedAt === null &&
              l.usedAt === null &&
              l.expiresAt.getTime() > where.expiresAt.gt.getTime()
          ) ?? null,
        updateMany: async ({
          where,
          data,
        }: {
          where: { bookingId: string };
          data: { revokedAt: Date };
        }) => {
          let count = 0;
          for (const l of links) {
            if (
              l.bookingId === where.bookingId &&
              l.revokedAt === null &&
              l.usedAt === null
            ) {
              l.revokedAt = data.revokedAt;
              count += 1;
            }
          }
          return { count };
        },
        create: async ({
          data,
        }: {
          data: { bookingId: string; tokenHash: string; expiresAt: Date };
        }) => {
          const row: StoredLink = {
            id: `pl-${nextId++}`,
            usedAt: null,
            revokedAt: null,
            ...data,
          };
          links.push(row);
          return row;
        },
      },
    };
    return { tx: tx as never, links };
  }

  const FUTURE_CHECK_IN = new Date("2026-08-01T00:00:00.000Z");

  it("mints on the first run and returns null on every later run while the link stays active (real cross-run idempotency)", async () => {
    const { tx, links } = makeStatefulTx();

    const first = await mintSplitGuestPaymentLinkIfAbsent(tx, {
      id: "child-1",
      checkIn: FUTURE_CHECK_IN,
    });
    const second = await mintSplitGuestPaymentLinkIfAbsent(tx, {
      id: "child-1",
      checkIn: FUTURE_CHECK_IN,
    });
    const third = await mintSplitGuestPaymentLinkIfAbsent(tx, {
      id: "child-1",
      checkIn: FUTURE_CHECK_IN,
    });

    expect(first).toEqual({
      token: expect.any(String),
      paymentLinkId: "pl-1",
    });
    expect(second).toBeNull();
    expect(third).toBeNull();
    // Exactly one live link exists.
    expect(links.filter((l) => l.revokedAt === null)).toHaveLength(1);
  });

  it("treats an expired unused link as NOT active: revokes it and mints a fresh one (#1967 FIX-3c)", async () => {
    // e.g. the booking's dates were pushed out after the first link lapsed.
    const { tx, links } = makeStatefulTx([
      {
        id: "pl-stale",
        bookingId: "child-1",
        tokenHash: "stale-hash",
        expiresAt: new Date("2026-01-01T00:00:00.000Z"), // long past
        usedAt: null,
        revokedAt: null,
      },
    ]);

    const minted = await mintSplitGuestPaymentLinkIfAbsent(tx, {
      id: "child-1",
      checkIn: FUTURE_CHECK_IN,
    });

    expect(minted).toEqual({
      token: expect.any(String),
      paymentLinkId: expect.any(String),
    });
    // The stale link was revoked in the same locked step, so at most one
    // usable token exists.
    expect(links.find((l) => l.id === "pl-stale")?.revokedAt).toBeInstanceOf(
      Date
    );
    expect(links.filter((l) => l.revokedAt === null)).toHaveLength(1);
  });

  it("never mints a link that would be born expired (check-in day already over)", async () => {
    const { tx, links } = makeStatefulTx();

    const minted = await mintSplitGuestPaymentLinkIfAbsent(tx, {
      id: "child-1",
      checkIn: new Date("2020-01-01T00:00:00.000Z"),
    });

    expect(minted).toBeNull();
    expect(links).toHaveLength(0);
  });
});

describe("revokePaymentLinkById (#1967)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("revokes exactly the given link, only while unused and unrevoked", async () => {
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);

    const count = await revokePaymentLinkById("pl-1");

    expect(count).toBe(1);
    expect(mockedUpdateMany).toHaveBeenCalledWith({
      where: { id: "pl-1", revokedAt: null, usedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
