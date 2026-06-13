import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingRequestStatus, BookingStatus, PaymentStatus } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingRequest: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
    },
    bookingRequestSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    member: {
      create: vi.fn(),
    },
    booking: {
      create: vi.fn(),
    },
    payment: {
      create: vi.fn(),
    },
    paymentLink: {
      create: vi.fn(),
    },
    season: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("@/lib/email", () => ({
  sendBookingRequestVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminBookingRequestPendingEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingRequestApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingRequestDeclinedEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: vi.fn(),
}));

vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldDays: vi.fn().mockResolvedValue(2),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("bcryptjs", () => ({
  hash: vi.fn().mockResolvedValue("hashed-placeholder"),
}));

import { prisma } from "@/lib/prisma";
import {
  sendBookingRequestVerificationEmail,
  sendAdminBookingRequestPendingEmail,
  sendBookingRequestApprovedEmail,
  sendBookingRequestDeclinedEmail,
} from "@/lib/email";
import { logAudit } from "@/lib/audit";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { hashActionToken } from "@/lib/action-tokens";
import {
  approveBookingRequest,
  BookingRequestError,
  createBookingRequest,
  declineBookingRequest,
  getBookingRequestSettings,
  priceBookingRequest,
  purgeExpiredBookingRequests,
  resolveRequestBookingHoldUntil,
  splitPriceAcrossGuests,
  updateBookingRequestSettings,
  verifyBookingRequest,
} from "@/lib/booking-request";

const mockedFindUnique = vi.mocked(prisma.bookingRequest.findUnique);
const mockedCreate = vi.mocked(prisma.bookingRequest.create);
const mockedUpdateMany = vi.mocked(prisma.bookingRequest.updateMany);
const mockedDeleteMany = vi.mocked(prisma.bookingRequest.deleteMany);
const mockedSettingsFindUnique = vi.mocked(prisma.bookingRequestSettings.findUnique);
const mockedSettingsUpsert = vi.mocked(prisma.bookingRequestSettings.upsert);
const mockedTransaction = vi.mocked(prisma.$transaction);
const mockedCheckCapacity = vi.mocked(checkCapacityForGuestRanges);
const mockedSendVerification = vi.mocked(sendBookingRequestVerificationEmail);
const mockedSendAdminPending = vi.mocked(sendAdminBookingRequestPendingEmail);
const mockedSendApproved = vi.mocked(sendBookingRequestApprovedEmail);
const mockedSendDeclined = vi.mocked(sendBookingRequestDeclinedEmail);
const mockedLogAudit = vi.mocked(logAudit);

const GUESTS = [{ firstName: "Tara", lastName: "Tester", ageTier: "ADULT" as const }];

function baseRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "req-1",
    type: "GENERAL",
    status: BookingRequestStatus.NEW,
    contactFirstName: "Tara",
    contactLastName: "Tester",
    contactEmail: "tara@example.com",
    contactPhone: null,
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
    guests: GUESTS,
    message: null,
    indicativePriceCents: null,
    priceCents: null,
    verificationTokenHash: null,
    verificationTokenExpiresAt: null,
    verifiedAt: null,
    pricedByMemberId: null,
    pricedAt: null,
    reviewedByMemberId: null,
    reviewedAt: null,
    declineReason: null,
    convertedBookingId: null,
    convertedMemberId: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("splitPriceAcrossGuests", () => {
  it("puts the remainder on the first guest", () => {
    expect(splitPriceAcrossGuests(1000, 3)).toEqual([334, 333, 333]);
  });

  it("returns an empty array for zero guests", () => {
    expect(splitPriceAcrossGuests(1000, 0)).toEqual([]);
  });

  it("handles an exact split", () => {
    expect(splitPriceAcrossGuests(900, 3)).toEqual([300, 300, 300]);
  });
});

describe("resolveRequestBookingHoldUntil", () => {
  const now = new Date("2026-07-01T00:00:00.000Z");

  it("uses the standard hold when it leaves more than the minimum", () => {
    const checkIn = new Date("2026-08-01T00:00:00.000Z");
    const hold = resolveRequestBookingHoldUntil(checkIn, 7, now);
    expect(hold).toEqual(new Date("2026-07-25T00:00:00.000Z"));
  });

  it("guarantees at least 48 hours even for late approvals", () => {
    const checkIn = new Date("2026-07-02T00:00:00.000Z");
    const hold = resolveRequestBookingHoldUntil(checkIn, 7, now);
    // standardHold (2026-06-25) < minimumHold (2026-07-03), but never beyond check-in
    expect(hold).toEqual(checkIn);
  });

  it("never returns a hold after check-in", () => {
    const checkIn = new Date("2026-07-02T12:00:00.000Z");
    const hold = resolveRequestBookingHoldUntil(checkIn, 0, now);
    expect(hold.getTime()).toBeLessThanOrEqual(checkIn.getTime());
  });
});

describe("booking request settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to hidden pricing when no settings row exists", async () => {
    mockedSettingsFindUnique.mockResolvedValue(null);
    const settings = await getBookingRequestSettings();
    expect(settings).toEqual({ showPricingToNonMembers: false });
  });

  it("updates and audits the pricing visibility setting", async () => {
    mockedSettingsUpsert.mockResolvedValue({
      id: "default",
      showPricingToNonMembers: true,
    } as never);

    const result = await updateBookingRequestSettings({
      showPricingToNonMembers: true,
      adminMemberId: "admin-1",
    });

    expect(result).toEqual({ showPricingToNonMembers: true });
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.settings_updated",
        actorMemberId: "admin-1",
      })
    );
  });
});

describe("createBookingRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSettingsFindUnique.mockResolvedValue(null); // pricing hidden by default
    mockedCreate.mockResolvedValue(baseRequest({ id: "req-new" }) as never);
  });

  it("rejects an empty guest list", async () => {
    await expect(
      createBookingRequest({
        contactFirstName: "Tara",
        contactLastName: "Tester",
        contactEmail: "tara@example.com",
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        guests: [],
      })
    ).rejects.toThrow(BookingRequestError);

    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("rejects missing contact details", async () => {
    await expect(
      createBookingRequest({
        contactFirstName: "  ",
        contactLastName: "Tester",
        contactEmail: "tara@example.com",
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        guests: GUESTS,
      })
    ).rejects.toThrow(BookingRequestError);

    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("creates a NEW request, stores only the token hash, and emails the raw token", async () => {
    await createBookingRequest({
      contactFirstName: "Tara",
      contactLastName: "Tester",
      contactEmail: "Tara@Example.com",
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      guests: GUESTS,
    });

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockedCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(createArgs.contactEmail).toBe("tara@example.com");
    expect(createArgs.indicativePriceCents).toBeNull();
    expect(createArgs.verificationTokenHash).toMatch(/^[a-f0-9]{64}$/);

    expect(mockedSendVerification).toHaveBeenCalledTimes(1);
    const emailArgs = mockedSendVerification.mock.calls[0][0];
    expect(emailArgs.email).toBe("tara@example.com");
    // The raw token emailed to the requester must hash to the stored value,
    // and must never equal the stored hash itself.
    expect(hashActionToken(emailArgs.token)).toBe(createArgs.verificationTokenHash);
    expect(emailArgs.token).not.toBe(createArgs.verificationTokenHash);

    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.submitted" })
    );
  });
});

describe("verifyBookingRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns invalid for an unknown token hash", async () => {
    mockedFindUnique.mockResolvedValue(null);
    const result = await verifyBookingRequest("a".repeat(64));
    expect(result).toEqual({ outcome: "invalid" });
    expect(mockedUpdateMany).not.toHaveBeenCalled();
  });

  it("returns expired when the verification window has passed", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.NEW,
        verificationTokenExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
      }) as never
    );

    const result = await verifyBookingRequest("a".repeat(64));
    expect(result).toEqual({ outcome: "expired" });
    expect(mockedUpdateMany).not.toHaveBeenCalled();
  });

  it("returns already_verified without re-claiming when status is no longer NEW", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({ status: BookingRequestStatus.PRICED }) as never
    );

    const result = await verifyBookingRequest("a".repeat(64));
    expect(result.outcome).toBe("already_verified");
    expect(mockedUpdateMany).not.toHaveBeenCalled();
  });

  it("claims NEW -> VERIFIED exactly once and notifies admins", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.NEW,
        verificationTokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);

    const result = await verifyBookingRequest("a".repeat(64));

    expect(result.outcome).toBe("verified");
    expect(mockedUpdateMany).toHaveBeenCalledWith({
      where: { id: "req-1", status: BookingRequestStatus.NEW },
      data: { status: BookingRequestStatus.VERIFIED, verifiedAt: expect.any(Date) },
    });
    expect(mockedSendAdminPending).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.verified" })
    );
  });

  it("falls back to already_verified when a concurrent verification wins the claim", async () => {
    mockedFindUnique
      .mockResolvedValueOnce(
        baseRequest({
          status: BookingRequestStatus.NEW,
          verificationTokenExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
        }) as never
      )
      .mockResolvedValueOnce(baseRequest({ status: BookingRequestStatus.VERIFIED }) as never);
    mockedUpdateMany.mockResolvedValue({ count: 0 } as never);

    const result = await verifyBookingRequest("a".repeat(64));

    expect(result.outcome).toBe("already_verified");
    expect(mockedSendAdminPending).not.toHaveBeenCalled();
  });
});

describe("priceBookingRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects negative or non-integer prices", async () => {
    await expect(
      priceBookingRequest({ requestId: "req-1", adminMemberId: "admin-1", priceCents: -1 })
    ).rejects.toThrow(BookingRequestError);
    await expect(
      priceBookingRequest({ requestId: "req-1", adminMemberId: "admin-1", priceCents: 1.5 })
    ).rejects.toThrow(BookingRequestError);
    expect(mockedUpdateMany).not.toHaveBeenCalled();
  });

  it("throws 404 when the request does not exist", async () => {
    mockedFindUnique.mockResolvedValue(null);
    await expect(
      priceBookingRequest({ requestId: "missing", adminMemberId: "admin-1", priceCents: 1000 })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("sets PRICED on a VERIFIED request and audits the officer", async () => {
    mockedFindUnique
      .mockResolvedValueOnce(baseRequest({ status: BookingRequestStatus.VERIFIED }) as never)
      .mockResolvedValueOnce(
        baseRequest({ status: BookingRequestStatus.PRICED, priceCents: 12000 }) as never
      );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);

    const updated = await priceBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
      priceCents: 12000,
    });

    expect(updated?.priceCents).toBe(12000);
    expect(mockedUpdateMany).toHaveBeenCalledWith({
      where: { id: "req-1", status: { in: [BookingRequestStatus.VERIFIED, BookingRequestStatus.PRICED] } },
      data: {
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        pricedByMemberId: "admin-1",
        pricedAt: expect.any(Date),
      },
    });
  });

  it("rejects pricing a request that has already moved past PRICED", async () => {
    mockedFindUnique.mockResolvedValue(baseRequest({ status: BookingRequestStatus.APPROVED }) as never);
    mockedUpdateMany.mockResolvedValue({ count: 0 } as never);

    await expect(
      priceBookingRequest({ requestId: "req-1", adminMemberId: "admin-1", priceCents: 1000 })
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("declineBookingRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws 404 when the request does not exist", async () => {
    mockedFindUnique.mockResolvedValue(null);
    await expect(
      declineBookingRequest({ requestId: "missing", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("declines a PRICED request, emails the requester, and audits the reviewer", async () => {
    mockedFindUnique
      .mockResolvedValueOnce(baseRequest({ status: BookingRequestStatus.PRICED }) as never)
      .mockResolvedValueOnce(
        baseRequest({ status: BookingRequestStatus.DECLINED, declineReason: "Fully booked" }) as never
      );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);

    const updated = await declineBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
      reason: "Fully booked",
    });

    expect(updated?.status).toBe(BookingRequestStatus.DECLINED);
    expect(mockedSendDeclined).toHaveBeenCalledWith(
      expect.objectContaining({ email: "tara@example.com", reason: "Fully booked" })
    );
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.declined" })
    );
  });

  it("rejects declining a request that is not VERIFIED or PRICED", async () => {
    mockedFindUnique.mockResolvedValue(baseRequest({ status: BookingRequestStatus.CONVERTED }) as never);
    mockedUpdateMany.mockResolvedValue({ count: 0 } as never);

    await expect(
      declineBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("approveBookingRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTransaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma)
    );
  });

  it("throws 404 when the request does not exist", async () => {
    mockedFindUnique.mockResolvedValue(null);
    await expect(
      approveBookingRequest({ requestId: "missing", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects approving a request that is not PRICED", async () => {
    mockedFindUnique.mockResolvedValue(baseRequest({ status: BookingRequestStatus.VERIFIED }) as never);
    await expect(
      approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects approving a PRICED request with no price set", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({ status: BookingRequestStatus.PRICED, priceCents: null }) as never
    );
    await expect(
      approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("returns capacityExceeded without converting when no beds remain", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({ status: BookingRequestStatus.PRICED, priceCents: 12000 }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedCheckCapacity.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [
        { date: new Date("2026-08-01T00:00:00.000Z"), availableBeds: -1 },
        { date: new Date("2026-08-02T00:00:00.000Z"), availableBeds: 2 },
      ],
    } as never);

    const result = await approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });

    expect(result).toEqual({ type: "capacityExceeded", fullNights: ["2026-08-01"] });
    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(mockedSendApproved).not.toHaveBeenCalled();
  });

  it("converts a PRICED request into a non-login member, PENDING booking, payment and payment link", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({ status: BookingRequestStatus.PRICED, priceCents: 12000 }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedCheckCapacity.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    } as never);
    vi.mocked(prisma.member.create).mockResolvedValue({ id: "member-1" } as never);
    vi.mocked(prisma.booking.create).mockResolvedValue({ id: "booking-1" } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);

    const result = await approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });

    expect(result).toMatchObject({
      type: "approved",
      requestId: "req-1",
      bookingId: "booking-1",
      memberId: "member-1",
      priceCents: 12000,
    });

    const memberArgs = vi.mocked(prisma.member.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(memberArgs.canLogin).toBe(false);
    expect(memberArgs.emailVerified).toBe(true);

    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(bookingArgs.memberId).toBe("member-1");
    expect(bookingArgs.status).toBe(BookingStatus.PENDING);
    expect(bookingArgs.finalPriceCents).toBe(12000);

    const paymentArgs = vi.mocked(prisma.payment.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(paymentArgs.status).toBe(PaymentStatus.PENDING);
    expect(paymentArgs.bookingId).toBe("booking-1");

    const linkArgs = vi.mocked(prisma.paymentLink.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(linkArgs.bookingId).toBe("booking-1");
    expect(linkArgs.tokenHash).toMatch(/^[a-f0-9]{64}$/);

    // The raw token emailed to the requester must not be the stored hash.
    const emailArgs = mockedSendApproved.mock.calls[0][0];
    expect(hashActionToken(emailArgs.token)).toBe(linkArgs.tokenHash);
    expect(emailArgs.token).not.toBe(linkArgs.tokenHash);

    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.approved" })
    );
  });
});

describe("purgeExpiredBookingRequests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("purges declined and never-verified requests past the retention window and audits the result", async () => {
    mockedDeleteMany.mockResolvedValueOnce({ count: 2 } as never).mockResolvedValueOnce({ count: 3 } as never);

    const now = new Date("2026-09-01T00:00:00.000Z");
    const result = await purgeExpiredBookingRequests(now);

    expect(result).toEqual({ declinedPurged: 2, neverVerifiedPurged: 3 });

    const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    expect(mockedDeleteMany).toHaveBeenNthCalledWith(1, {
      where: { status: BookingRequestStatus.DECLINED, updatedAt: { lte: cutoff } },
    });
    expect(mockedDeleteMany).toHaveBeenNthCalledWith(2, {
      where: {
        status: BookingRequestStatus.NEW,
        verifiedAt: null,
        createdAt: { lte: cutoff },
      },
    });
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.retention_purge",
        metadata: expect.objectContaining({ declinedPurged: 2, neverVerifiedPurged: 3 }),
      })
    );
  });

  it("does not write an audit log when nothing was purged", async () => {
    mockedDeleteMany.mockResolvedValue({ count: 0 } as never);

    const result = await purgeExpiredBookingRequests(new Date("2026-09-01T00:00:00.000Z"));

    expect(result).toEqual({ declinedPurged: 0, neverVerifiedPurged: 0 });
    expect(mockedLogAudit).not.toHaveBeenCalled();
  });
});
