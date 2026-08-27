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
import {
  OverCapacityConfirmationRequiredError,
  WholeLodgeHoldBlockedError,
} from "@/lib/over-capacity-confirmation";
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
  lodgeFindUnique: vi.fn().mockResolvedValue({ id: "lodge-1", active: true }),
  memberLodgeAccessFindMany: vi.fn(),
  bookingGuestFindMany: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  logAudit: vi.fn(),
  sendBookingConfirmedEmail: vi.fn(),
  sendBookingPendingEmail: vi.fn(),
  sendAdminNewBookingAlert: vi.fn(),
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
  getMemberCreditBalance: vi.fn().mockResolvedValue(0),
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
  reconcileBedAllocationsForBookingWithGlobalLockHeld: (...a: unknown[]) =>
    h.reconcileBedAllocationsForBooking(...a),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createConfirmedBooking,
  type BookingGuestInput,
} from "@/lib/booking-create";
import { requireCalendarDate } from "@/lib/club-time";

// #3123 (`INV-LOCK-004`) — `createConfirmedBooking` is transaction-aware, so its
// caller resolves the CLUB's day and threads it in. Pinned to the frozen clock's
// club day, which is what the service used to read for itself.
const FIXTURE_CLUB_DAY = requireCalendarDate("2026-07-01");

/**
 * The club's zone, named rather than left to `getTodayDateOnly`'s `APP_TIME_ZONE`
 * default, which #3123 deletes. `createConfirmedBooking` resolves its own "today"
 * through `readClubTimeZoneOutsideRequest()`; prisma is mocked here with no
 * `clubTimeSettings` delegate, so that read fails soft to the environment seed
 * and then to `Pacific/Auckland`. Naming it keeps this file's fixtures anchored
 * to the same day the service is measuring from.
 */
const CLUB_ZONE = "Pacific/Auckland";

// Relative dates so the scenarios never rot with the wall clock. The plain
// on-behalf / email tests use a future window; the retroactive scenarios use a
// past window, because the service applies the retroactive semantics (capacity
// warn-and-confirm) only when the resolved envelope starts in the past.
const checkIn = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 30);
const checkOut = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 32);
const pastCheckIn = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), -10);
const pastCheckOut = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), -8);

function seasonWithRate(rateCents: number) {
  return [
    {
      id: "season-1",
      startDate: addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), -400),
      endDate: addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 60),
      // Membership-type-keyed rates (#1930, E4): both FULL and NON_MEMBER
      // priced at the same rate here, matching the old member/non-member pair.
      membershipTypeRates: [
        { membershipTypeId: "type-full", ageTier: AgeTier.ADULT, pricePerNightCents: rateCents },
        { membershipTypeId: "type-nonmember", ageTier: AgeTier.ADULT, pricePerNightCents: rateCents },
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
  // Rate resolver (#1930, E4): FULL and NON_MEMBER share the rate here, so the
  // NON_MEMBER_DEFAULT fallback prices identically to the old member path.
  member: { findMany: async () => [] },
  seasonalMembershipAssignment: { findMany: async () => [] },
  membershipType: {
    findMany: async () => [
      { id: "type-nonmember", key: "NON_MEMBER" },
      { id: "type-full", key: "FULL" },
    ],
  },
  // #2364: the hosting review is reconciled inside the booking write, so
  // every prisma/tx double a booking path runs against needs this client.
  adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
  booking: {
    create: (...a: unknown[]) => h.bookingCreate(...a),
    update: (...a: unknown[]) => h.bookingUpdate(...a),
    findFirst: vi.fn().mockResolvedValue(null),
    // #2364: the create transaction reconciles the hosting review from the rows
    // it just wrote. Answering undefined is the "booking not found" branch,
    // which writes nothing — right for a double that models the create alone.
    findUnique: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
  },
  payment: { create: (...a: unknown[]) => h.paymentCreate(...a) },
  lodge: {
    findFirst: (...a: unknown[]) => h.lodgeFindFirst(...a),
    findUnique: (...a: unknown[]) => h.lodgeFindUnique(...a),
  },
  bookingGuest: { findMany: (...a: unknown[]) => h.bookingGuestFindMany(...a) },
  memberLodgeAccess: {
    findMany: (...a: unknown[]) => h.memberLodgeAccessFindMany(...a),
  },
};

function baseInput(
  guests: BookingGuestInput[],
  overrides: Partial<
    Omit<Parameters<typeof createConfirmedBooking>[0], "lodgeId">
  > = {},
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
    lodgeId: "lodge-1",
    todayAtClub: FIXTURE_CLUB_DAY,
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
      await createConfirmedBooking(retroInput());
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
      retroInput({ confirmOverCapacity: true }),
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

  it("override NON-BYPASS: a confirmed on-behalf over-capacity create onto a whole-lodge-held night throws WholeLodgeHoldBlockedError and never creates the booking (ADR-001 decision 5, issue #118)", async () => {
    // Numeric beds are irrelevant: the night is held (availableBeds pinned to 0,
    // never negative) so it is not confirmable. Even with confirmOverCapacity
    // the admin is refused.
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      nightDetails: [
        { date: pastCheckIn, occupiedBeds: 2, availableBeds: 0, wholeLodgeHeld: true },
      ],
    });

    let thrown: unknown;
    try {
      await createConfirmedBooking(retroInput({ confirmOverCapacity: true }));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(WholeLodgeHoldBlockedError);
    expect((thrown as WholeLodgeHoldBlockedError).blockedNights).toEqual([
      formatDateOnly(pastCheckIn),
    ]);
    // The whole point: no booking is written onto a held lodge.
    expect(h.bookingCreate).not.toHaveBeenCalled();
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
    // #1771: an in-capacity create never persists the override columns.
    const createData = h.bookingCreate.mock.calls[0][0].data;
    expect(createData).not.toHaveProperty("capacityOverriddenAt");
    expect(createData).not.toHaveProperty("capacityOverriddenByMemberId");
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

  it("records no retroactive allowPastDates for a future-dated on-behalf override (audit shape pin)", async () => {
    // Was: hard capacity block for a future-dated create carrying
    // allowPastDates. #1767 makes every on-behalf create warn-and-confirm;
    // this now pins that the audit distinguishes a forward override
    // (allowPastDates false) from the retroactive one (allowPastDates true).
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

    expect(outcome.type).toBe("created");
    expect(auditMetadata("booking.created")).toMatchObject({
      allowPastDates: false,
      confirmOverCapacity: true,
      capacityOverridden: true,
    });
  });

});

describe("createConfirmedBooking forward-dated on-behalf over-capacity (#1767)", () => {
  const overCapacity = () =>
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      nightDetails: [
        { date: checkIn, availableBeds: -2 },
        { date: checkOut, availableBeds: 3 },
      ],
    });

  it("throws OverCapacityConfirmationRequiredError with the over-capacity nights when unconfirmed", async () => {
    overCapacity();

    let thrown: unknown;
    try {
      await createConfirmedBooking(baseInput([guest(true, "Alice")]));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(OverCapacityConfirmationRequiredError);
    expect((thrown as OverCapacityConfirmationRequiredError).nightDetails).toEqual([
      { date: formatDateOnly(checkIn), availableBeds: -2 },
    ]);
    expect(h.bookingCreate).not.toHaveBeenCalled();
  });

  it("creates over capacity when confirmed, auditing capacityOverridden with allowPastDates false", async () => {
    overCapacity();

    const outcome = await createConfirmedBooking(
      baseInput([guest(true, "Alice")], { confirmOverCapacity: true }),
    );

    expect(outcome.type).toBe("created");
    expect(h.bookingCreate).toHaveBeenCalledTimes(1);
    expect(auditMetadata("booking.created")).toMatchObject({
      allowPastDates: false,
      confirmOverCapacity: true,
      capacityOverridden: true,
    });
    expect(auditMetadata("booking.created_on_behalf")).toMatchObject({
      capacityOverridden: true,
    });
    // #1771: the override is also persisted on the booking with the acting admin.
    const createData = h.bookingCreate.mock.calls[0][0].data;
    expect(createData.capacityOverriddenAt).toBeInstanceOf(Date);
    expect(createData.capacityOverriddenByMemberId).toBe("admin-1");
  });

  it("keeps the hard capacity block for a member self-create even when the flag is smuggled in (members can never overbook)", async () => {
    // Group join and cross-lodge waitlist confirm also pass isOnBehalf false,
    // so this pin covers those internal callers too.
    overCapacity();

    const outcome = await createConfirmedBooking(
      baseInput([guest(true, "Alice")], {
        isOnBehalf: false,
        sessionUserId: "member-1",
        confirmOverCapacity: true,
      }),
    );

    expect(outcome.type).toBe("capacityExceeded");
    expect(h.bookingCreate).not.toHaveBeenCalled();
  });

  it("warn-and-confirms a non-member hold-eligible (PENDING) party over capacity and stamps the persisted override — #1771 retired the v1 carve-out", async () => {
    // The v1 carve-out (#1767) hard-blocked this because cron-confirm-pending
    // would silently bump the confirmed overbook at the hold window. #1771
    // persists the override on the booking and teaches that cron to honour it,
    // so the hold-eligible PENDING overbook is now admitted and marked.
    overCapacity();

    const outcome = await createConfirmedBooking(
      baseInput([guest(false, "Bob")], {
        status: BookingStatus.PENDING,
        shouldBePending: true,
        confirmOverCapacity: true,
      }),
    );

    expect(outcome.type).toBe("created");
    expect(h.bookingCreate).toHaveBeenCalledTimes(1);
    // The persisted override is stamped on the create with the acting admin.
    const createData = h.bookingCreate.mock.calls[0][0].data;
    expect(createData.capacityOverriddenAt).toBeInstanceOf(Date);
    expect(createData.capacityOverriddenByMemberId).toBe("admin-1");
  });

  it("returns the capacityExceeded outcome under waitlistIntent so the route's waitlist fallback still runs", async () => {
    overCapacity();

    const outcome = await createConfirmedBooking(
      baseInput([guest(true, "Alice")], { waitlistIntent: true }),
    );

    expect(outcome.type).toBe("capacityExceeded");
    expect(h.bookingCreate).not.toHaveBeenCalled();
  });

  it("warn-and-confirms the $0/credit-covered final capacity claim too", async () => {
    // A $0 booking skips the first capacity gate and re-checks at the
    // final-claim site; both sites share the on-behalf override.
    h.seasonFindMany.mockResolvedValue(seasonWithRate(0));
    overCapacity();

    let thrown: unknown;
    try {
      await createConfirmedBooking(baseInput([guest(true, "Alice")]));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OverCapacityConfirmationRequiredError);

    vi.clearAllMocks();
    armMocks();
    h.seasonFindMany.mockResolvedValue(seasonWithRate(0));
    overCapacity();

    const outcome = await createConfirmedBooking(
      baseInput([guest(true, "Alice")], { confirmOverCapacity: true }),
    );
    expect(outcome.type).toBe("created");
    expect(auditMetadata("booking.created")).toMatchObject({
      capacityOverridden: true,
      allowPastDates: false,
    });
  });
});
