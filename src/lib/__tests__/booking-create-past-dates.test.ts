/**
 * Retroactive-create service behaviour (#1695) for createConfirmedBooking:
 * defence-in-depth past-date re-check, over-capacity warn-and-confirm, the
 * per-create member-email choice, and the audit metadata.
 *
 * The over-capacity error class lives in its own module, so only
 * checkCapacityForGuestRanges is stubbed (importOriginal spread) — the real
 * OverCapacityConfirmationRequiredError keeps working with `instanceof`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgeTier, BookingStatus } from "@prisma/client";
import { OverCapacityConfirmationRequiredError } from "@/lib/over-capacity-confirmation";
import { addDaysDateOnly, getTodayDateOnly, formatDateOnly } from "@/lib/date-only";

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  seasonFindMany: vi.fn(),
  bookingCreate: vi.fn(),
  bookingUpdate: vi.fn(),
  paymentCreate: vi.fn(),
  bookingFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  lodgeFindFirst: vi.fn(),
  memberLodgeAccessFindMany: vi.fn(),
  bookingGuestFindMany: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  logAudit: vi.fn(),
  sendBookingConfirmedEmail: vi.fn(),
  sendBookingPendingEmail: vi.fn(),
  sendAdminNewBookingAlert: vi.fn(),
  getMemberCreditBalance: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => h.transaction(fn),
    member: { findUnique: (...a: unknown[]) => h.memberFindUnique(...a) },
    booking: { findUnique: (...a: unknown[]) => h.bookingFindUnique(...a) },
  },
}));

vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return {
    ...actual,
    checkCapacityForGuestRanges: (...a: unknown[]) =>
      h.checkCapacityForGuestRanges(...a),
  };
});

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn().mockResolvedValue({ xeroIntegration: false }),
}));

vi.mock("@/lib/promo", () => ({
  redeemPromoCode: vi.fn(),
  shouldPersistPromoRedemption: vi.fn().mockReturnValue(false),
  validateAndCalculatePromoDiscount: vi.fn(),
}));

vi.mock("@/lib/work-party", () => ({
  resolveWorkPartyEventPromoForBooking: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendAdminNewBookingAlert: (...a: unknown[]) => h.sendAdminNewBookingAlert(...a),
  sendBookingConfirmedEmail: (...a: unknown[]) => h.sendBookingConfirmedEmail(...a),
  sendBookingPendingEmail: (...a: unknown[]) => h.sendBookingPendingEmail(...a),
  sendWaitlistConfirmationEmail: vi.fn(),
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: vi.fn().mockResolvedValue({ queueOperationId: null }),
  enqueueXeroAppliedCreditAllocationOperation: vi.fn().mockResolvedValue({ queueOperationId: null }),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/member-credit", () => ({
  applyCreditToBooking: vi.fn(),
  getMemberCreditBalance: (...a: unknown[]) => h.getMemberCreditBalance(...a),
}));

vi.mock("@/lib/payment-transactions", () => ({
  recordInternetBankingPaymentTransaction: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));

vi.mock("@/lib/booking-review", () => ({
  ADULT_SUPERVISION_REVIEW_REASON: "no-adult",
  requiresAdultSupervisionReview: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: (...a: unknown[]) =>
    h.reconcileBedAllocationsForBooking(...a),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createConfirmedBooking,
  RetroactiveCardPaymentError,
  type BookingGuestInput,
} from "@/lib/booking-create";

// Relative dates so the scenarios never rot with the wall clock. The plain
// on-behalf / email tests use a future window; the retroactive scenarios use a
// past window, because the service applies the retroactive semantics (capacity
// warn-and-confirm) only when the resolved envelope starts in the past.
const checkIn = addDaysDateOnly(getTodayDateOnly(), 30);
const checkOut = addDaysDateOnly(getTodayDateOnly(), 32);
const pastCheckIn = addDaysDateOnly(getTodayDateOnly(), -10);
const pastCheckOut = addDaysDateOnly(getTodayDateOnly(), -8);

function seasonWithRate(rateCents: number) {
  return [
    {
      id: "season-1",
      startDate: addDaysDateOnly(getTodayDateOnly(), -400),
      endDate: addDaysDateOnly(getTodayDateOnly(), 60),
      rates: [
        { ageTier: AgeTier.ADULT, isMember: true, pricePerNightCents: rateCents },
        { ageTier: AgeTier.ADULT, isMember: false, pricePerNightCents: rateCents },
      ],
    },
  ];
}

function guest(isMember: boolean, firstName: string): BookingGuestInput {
  return {
    firstName,
    lastName: "Test",
    ageTier: AgeTier.ADULT,
    isMember,
    stayStart: checkIn,
    stayEnd: checkOut,
  };
}

function pastGuest(isMember: boolean, firstName: string): BookingGuestInput {
  return { ...guest(isMember, firstName), stayStart: pastCheckIn, stayEnd: pastCheckOut };
}

// A retroactive on-behalf create: past envelope + the admin flag.
function retroInput(
  overrides: Partial<Parameters<typeof createConfirmedBooking>[0]> = {},
) {
  return baseInput([pastGuest(true, "Alice")], {
    checkIn: pastCheckIn,
    checkOut: pastCheckOut,
    allowPastDates: true,
    ...overrides,
  });
}

let createdCount = 0;
const tx = {
  $executeRaw: (...a: unknown[]) => h.executeRaw(...a),
  season: { findMany: (...a: unknown[]) => h.seasonFindMany(...a) },
  booking: {
    create: (...a: unknown[]) => h.bookingCreate(...a),
    update: (...a: unknown[]) => h.bookingUpdate(...a),
    findFirst: vi.fn().mockResolvedValue(null),
  },
  payment: { create: (...a: unknown[]) => h.paymentCreate(...a) },
  lodge: { findFirst: (...a: unknown[]) => h.lodgeFindFirst(...a) },
  bookingGuest: { findMany: (...a: unknown[]) => h.bookingGuestFindMany(...a) },
  memberLodgeAccess: {
    findMany: (...a: unknown[]) => h.memberLodgeAccessFindMany(...a),
  },
};

function baseInput(
  guests: BookingGuestInput[],
  overrides: Partial<Parameters<typeof createConfirmedBooking>[0]> = {},
) {
  const hasNonMembers = guests.some((g) => !g.isMember);
  return {
    effectiveMemberId: "member-1",
    isOnBehalf: true,
    sessionUserId: "admin-1",
    checkIn,
    checkOut,
    guests,
    status: hasNonMembers ? BookingStatus.PENDING : BookingStatus.PAYMENT_PENDING,
    shouldBePending: hasNonMembers,
    holdDays: 7,
    ...overrides,
  };
}

function auditMetadata(action: string): Record<string, unknown> | undefined {
  const call = h.logAudit.mock.calls.find(
    (c) => (c[0] as { action: string }).action === action,
  );
  return call ? (call[0] as { metadata: Record<string, unknown> }).metadata : undefined;
}

function armMocks() {
  createdCount = 0;
  h.transaction.mockImplementation(async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx));
  h.executeRaw.mockResolvedValue(undefined);
  h.seasonFindMany.mockResolvedValue(seasonWithRate(2500));
  h.checkCapacityForGuestRanges.mockResolvedValue({ available: true, nightDetails: [] });
  h.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
  h.bookingUpdate.mockResolvedValue({});
  h.paymentCreate.mockResolvedValue({ id: "pay-1" });
  h.sendBookingConfirmedEmail.mockResolvedValue(undefined);
  h.sendBookingPendingEmail.mockResolvedValue(undefined);
  h.sendAdminNewBookingAlert.mockResolvedValue(undefined);
  h.memberFindUnique.mockResolvedValue({
    id: "member-1",
    firstName: "Mem",
    lastName: "Ber",
    email: "m@example.com",
  });
  h.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
  h.memberLodgeAccessFindMany.mockResolvedValue([]);
  h.bookingGuestFindMany.mockResolvedValue([]);
  h.getMemberCreditBalance.mockResolvedValue(0);
  h.bookingCreate.mockImplementation((args: { data: Record<string, unknown> }) => {
    createdCount += 1;
    const id = `booking-${createdCount}`;
    const guestRows = (args.data.guests as { create: Array<Record<string, unknown>> }).create.map(
      (g, i) => ({ ...g, id: `${id}-g${i}` }),
    );
    return Promise.resolve({ ...args.data, id, guests: guestRows });
  });
  h.bookingFindUnique.mockResolvedValue({
    id: "booking-1",
    lodgeId: "lodge-1",
    checkIn,
    checkOut,
    finalPriceCents: 0,
    discountCents: 0,
    promoAdjustmentCents: 0,
    member: { email: "m@example.com", firstName: "Mem" },
    guests: [{ id: "g1" }],
    promoRedemption: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  armMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createConfirmedBooking retroactive behaviour (#1695)", () => {
  it("rejects a past check-in when allowPastDates is set but the create is not on-behalf", async () => {
    await expect(
      createConfirmedBooking(
        baseInput([{ ...guest(true, "Alice"), stayStart: pastCheckIn, stayEnd: pastCheckOut }], {
          isOnBehalf: false,
          effectiveMemberId: "member-1",
          sessionUserId: "member-1",
          checkIn: pastCheckIn,
          checkOut: pastCheckOut,
          allowPastDates: true,
        }),
      ),
    ).rejects.toThrow("Cannot book in the past");

    expect(h.bookingCreate).not.toHaveBeenCalled();
  });

  it("throws OverCapacityConfirmationRequiredError with the over-capacity nights when unconfirmed", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      nightDetails: [
        { date: checkIn, availableBeds: -2 },
        { date: checkOut, availableBeds: 3 },
      ],
    });

    let thrown: unknown;
    try {
      // Internet Banking: a positive-balance retroactive card create is now
      // rejected before the capacity check (#1709), so over-capacity
      // warn-and-confirm is exercised on the valid IB settlement path.
      await createConfirmedBooking(retroInput({ paymentMethod: "internet_banking" }));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(OverCapacityConfirmationRequiredError);
    expect((thrown as OverCapacityConfirmationRequiredError).nightDetails).toEqual([
      { date: formatDateOnly(checkIn), availableBeds: -2 },
    ]);
    expect(h.bookingCreate).not.toHaveBeenCalled();
  });

  it("creates over capacity when confirmed and records capacityOverridden in the audit", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      nightDetails: [{ date: checkIn, availableBeds: -2 }],
    });

    const outcome = await createConfirmedBooking(
      // Internet Banking is the valid retroactive settlement for a positive
      // balance (#1709); over-capacity confirm is orthogonal to it.
      retroInput({ confirmOverCapacity: true, paymentMethod: "internet_banking" }),
    );

    expect(outcome.type).toBe("created");
    expect(h.bookingCreate).toHaveBeenCalledTimes(1);
    expect(auditMetadata("booking.created")).toMatchObject({
      allowPastDates: true,
      confirmOverCapacity: true,
      capacityOverridden: true,
    });
    expect(auditMetadata("booking.created_on_behalf")).toMatchObject({
      capacityOverridden: true,
      notifyMember: true,
    });
  });

  it("suppresses the $0 confirmation email when notifyMember is false", async () => {
    h.seasonFindMany.mockResolvedValue(seasonWithRate(0));

    await createConfirmedBooking(
      baseInput([guest(true, "Alice")], { notifyMember: false }),
    );

    expect(h.sendBookingConfirmedEmail).not.toHaveBeenCalled();
  });

  it("sends the $0 confirmation email when notifyMember is not suppressed (member pin)", async () => {
    h.seasonFindMany.mockResolvedValue(seasonWithRate(0));

    await createConfirmedBooking(baseInput([guest(true, "Alice")]));

    expect(h.sendBookingConfirmedEmail).toHaveBeenCalledTimes(1);
  });

  const pendingInput = () =>
    baseInput([guest(false, "Bob")], {
      status: BookingStatus.PENDING,
      shouldBePending: true,
      cancelIfGuestsBumped: true,
      holdDays: 7,
    });

  it("suppresses the pending-hold email when notifyMember is false", async () => {
    await createConfirmedBooking({ ...pendingInput(), notifyMember: false });
    expect(h.sendBookingPendingEmail).not.toHaveBeenCalled();
  });

  it("sends the pending-hold email when notifyMember is not suppressed (member pin)", async () => {
    await createConfirmedBooking(pendingInput());
    expect(h.sendBookingPendingEmail).toHaveBeenCalledTimes(1);
  });

  it("records no retroactive audit fields for a normal on-behalf create", async () => {
    await createConfirmedBooking(baseInput([guest(true, "Alice")]));

    const created = auditMetadata("booking.created");
    expect(created).not.toHaveProperty("allowPastDates");
    expect(created).not.toHaveProperty("capacityOverridden");
    // notifyMember is always recorded on the on-behalf entry.
    expect(auditMetadata("booking.created_on_behalf")).toMatchObject({
      notifyMember: true,
    });
  });

  it("allows a past check-in for the internal inherited-stay marker without retroactive semantics (group-join / waitlist-confirm pin)", async () => {
    const outcome = await createConfirmedBooking(
      baseInput([pastGuest(true, "Alice")], {
        isOnBehalf: false,
        effectiveMemberId: "member-1",
        sessionUserId: "member-1",
        checkIn: pastCheckIn,
        checkOut: pastCheckOut,
        allowPastCheckIn: true,
      }),
    );

    expect(outcome.type).toBe("created");
    // No retroactive audit fields: the marker skips only the past-date throw.
    const created = auditMetadata("booking.created");
    expect(created).not.toHaveProperty("allowPastDates");
  });

  it("keeps the hard capacity block for a future-dated create carrying allowPastDates (retroactive semantics need a past envelope)", async () => {
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      nightDetails: [{ date: checkIn, availableBeds: -2 }],
    });

    const outcome = await createConfirmedBooking(
      baseInput([guest(true, "Alice")], {
        allowPastDates: true,
        confirmOverCapacity: true,
      }),
    );

    expect(outcome.type).toBe("capacityExceeded");
    expect(h.bookingCreate).not.toHaveBeenCalled();
  });

});

describe("createConfirmedBooking retroactive card-path restriction (#1709)", () => {
  it("rejects a positive-balance retroactive card create with RetroactiveCardPaymentError (no booking written)", async () => {
    // Default paymentMethod is card (stripe) and the seeded rate makes the
    // price positive, so the card PAYMENT_PENDING path is barred for a past stay.
    let thrown: unknown;
    try {
      await createConfirmedBooking(retroInput());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RetroactiveCardPaymentError);
    expect((thrown as Error).message).toContain("can't be paid by card");
    expect(h.bookingCreate).not.toHaveBeenCalled();
  });

  it("rejects the card path before the capacity check — an over-capacity retroactive card create is a card rejection, not an over-capacity prompt (ordering pin)", async () => {
    // Lodge is over capacity and confirmOverCapacity is not set: if the card
    // guard were placed after the capacity check this would surface
    // OverCapacityConfirmationRequiredError instead of the card rejection.
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      nightDetails: [{ date: pastCheckIn, availableBeds: -2 }],
    });

    let thrown: unknown;
    try {
      await createConfirmedBooking(retroInput());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RetroactiveCardPaymentError);
    expect(thrown).not.toBeInstanceOf(OverCapacityConfirmationRequiredError);
    expect(h.bookingCreate).not.toHaveBeenCalled();
  });

  it("allows a retroactive card create when the effective price is $0 (genuinely free) — settles to PAID", async () => {
    h.seasonFindMany.mockResolvedValue(seasonWithRate(0));

    const outcome = await createConfirmedBooking(retroInput());

    expect(outcome.type).toBe("created");
    expect(h.bookingCreate).toHaveBeenCalledTimes(1);
    // Zero-dollar path auto-pays: a $0 SUCCEEDED payment is written and PAID set.
    expect(h.paymentCreate).toHaveBeenCalledTimes(1);
    expect(h.bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: BookingStatus.PAID } }),
    );
  });

  it("allows a retroactive card create fully covered by account credit — settles to PAID", async () => {
    // Price 5000 (rate 2500 x 2 nights); 5000 credit applied and available →
    // effective $0, so the card guard does not fire and the booking auto-pays.
    h.getMemberCreditBalance.mockResolvedValue(5000);

    const outcome = await createConfirmedBooking(
      retroInput({ applyCreditCents: 5000 }),
    );

    expect(outcome.type).toBe("created");
    expect(h.bookingCreate).toHaveBeenCalledTimes(1);
    expect(h.bookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: BookingStatus.PAID } }),
    );
  });

  it("allows a positive-balance retroactive Internet Banking create", async () => {
    const outcome = await createConfirmedBooking(
      retroInput({ paymentMethod: "internet_banking" }),
    );

    expect(outcome.type).toBe("created");
    expect(h.bookingCreate).toHaveBeenCalledTimes(1);
  });

  it("leaves the future-dated card path unchanged — a normal card create is not blocked (regression pin)", async () => {
    // Future window, default card payment, positive price: retroactiveOverride
    // is false so the #1709 guard never fires and the booking lands
    // PAYMENT_PENDING exactly as before.
    const outcome = await createConfirmedBooking(baseInput([guest(true, "Alice")]));

    expect(outcome.type).toBe("created");
    expect(h.bookingCreate).toHaveBeenCalledTimes(1);
    const created = h.bookingCreate.mock.calls[0][0] as {
      data: { status: string };
    };
    expect(created.data.status).toBe(BookingStatus.PAYMENT_PENDING);
  });
});
