import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
  PaymentStatus,
} from "@prisma/client";

/*
 * #3672 (`INV-PAY-108`, owner option B): once an organiser-pays group's
 * settlement is paid, a member who joins gets an ordinary member-pays booking
 * and is sent to pay; the organiser is never billed for them. Per-member-pays
 * groups are unchanged. The in-lock half (the booking create re-deciding the
 * payer) is pinned in `booking-split.test.ts`; the paid apply's release of a
 * joiner the paid bill missed is pinned in `group-settlement.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  groupFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  joinFindFirst: vi.fn(),
  joinCount: vi.fn(),
  getLodgeCapacity: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  resolveLinkedBookingMembers: vi.fn(),
  assertLinkedBookingMembersCanBeBooked: vi.fn(),
  normalizeBookingGuestInputs: vi.fn(),
  validateMinimumStay: vi.fn(),
  assertMembershipTypeBookingAllowed: vi.fn(),
  requiresPaidSubscriptionForMemberForBooking: vi.fn(),
  findUnpaidMemberGuests: vi.fn(),
  createConfirmedBooking: vi.fn(),
  evaluateProposedAdultMemberHosting: vi.fn(),
  loadInternetBankingPaymentSettings: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    groupBooking: { findUnique: mocks.groupFindUnique },
    groupDiscountSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    groupBookingJoin: {
      findFirst: mocks.joinFindFirst,
      count: mocks.joinCount,
    },
    member: {
      findUnique: mocks.memberFindUnique,
      findFirst: mocks.memberFindFirst,
    },
  },
}));

// Partial mock: only override getLodgeCapacity; keep FALLBACK_LODGE_CAPACITY
// et al so other importers (email registry) still resolve.
vi.mock("@/lib/lodge-capacity", async () => {
  const actual = (await vi.importActual("@/lib/lodge-capacity")) as typeof import("@/lib/lodge-capacity");
  return { ...actual, getLodgeCapacity: mocks.getLodgeCapacity };
});

// Partial mock: keep lodgeNullTolerantScope et al intact; only spy on the
// default-lodge fallback so we can assert the group's lodge is used instead.
vi.mock("@/lib/lodges", async () => {
  const actual = (await vi.importActual("@/lib/lodges")) as typeof import("@/lib/lodges");
  return { ...actual, getDefaultLodgeId: mocks.getDefaultLodgeId };
});

vi.mock("@/lib/booking-guests", async () => {
  const actual = (await vi.importActual("@/lib/booking-guests")) as typeof import("@/lib/booking-guests");
  return {
    ...actual,
    resolveLinkedBookingMembers: mocks.resolveLinkedBookingMembers,
    assertLinkedBookingMembersCanBeBooked:
      mocks.assertLinkedBookingMembersCanBeBooked,
    normalizeBookingGuestInputs: mocks.normalizeBookingGuestInputs,
  };
});

vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: mocks.validateMinimumStay,
  formatViolationsDetail: () => "Lodge B weekends: minimum 2 nights",
}));

vi.mock("@/lib/membership-type-policy", () => ({
  assertMembershipTypeBookingAllowed:
    mocks.assertMembershipTypeBookingAllowed,
  requiresPaidSubscriptionForMemberForBooking:
    mocks.requiresPaidSubscriptionForMemberForBooking,
  priceBookingGuestsWithMembershipTypePolicy: vi.fn(),
}));

vi.mock("@/lib/booking-member-guest-subscriptions", () => ({
  findUnpaidMemberGuests: mocks.findUnpaidMemberGuests,
}));

vi.mock("@/lib/booking-create", async () => {
  const actual = (await vi.importActual("@/lib/booking-create")) as typeof import("@/lib/booking-create");
  return { ...actual, createConfirmedBooking: mocks.createConfirmedBooking };
});
// #3128 moved `evaluateProposedAdultMemberHosting` to its own module; the
// partial mock follows it there so it still intercepts.
vi.mock("@/lib/adult-member-hosting-proposed", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/lib/adult-member-hosting-proposed");
  return {
    ...actual,
    evaluateProposedAdultMemberHosting:
      mocks.evaluateProposedAdultMemberHosting,
  };
});

// Settings the join reads that this suite does not vary, answered directly so
// the run does not log a fail-soft read of an unmocked delegate per test.
vi.mock("@/lib/member-subscription-eligibility", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveSubscriptionLockoutMode: vi.fn(async () => "HARD_BLOCK"),
}));
vi.mock("@/lib/member-dietary-booking-writes", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  resolveBookingGuestDietarySeeding: vi.fn(async () => undefined),
}));
vi.mock("@/lib/internet-banking-settings", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/lib/internet-banking-settings");
  return {
    ...actual,
    loadInternetBankingPaymentSettings: mocks.loadInternetBankingPaymentSettings,
    checkInternetBankingLeadTime: () => ({ allowed: true }),
  };
});

import { joinGroupBookingAsMember } from "@/lib/group-booking";
import {
  organiserPaysForJoinerInTx,
  organiserPaysForNewJoiner,
  releaseUnpaidJoinersToMemberPaysInTx,
} from "@/lib/group-late-joiner";
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";

const CLUB_ZONE = "Pacific/Auckland";
/** The club's today, in the `@db.Date` encoding check-ins are stored in. */
const CLUB_TODAY = new Date("2026-10-01T00:00:00.000Z");
const checkIn = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 30);
const checkOut = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 32);

function group(
  paymentMode: GroupBookingPaymentMode,
  settlementStatus: PaymentStatus | null
) {
  return {
    id: "group-1",
    status: GroupBookingStatus.OPEN,
    joinDeadline: null,
    paymentMode,
    maxJoiners: null,
    organiserMemberId: "organiser-1",
    settlement: settlementStatus ? { status: settlementStatus } : null,
    organiserBooking: {
      id: "booking-1",
      lodgeId: "lodge-1",
      checkIn,
      checkOut,
      status: BookingStatus.CONFIRMED,
      deletedAt: null,
    },
  };
}

/** What createConfirmedBooking wrote: a priced PAYMENT_PENDING child. */
function created(organiserSettled: boolean) {
  return {
    type: "created",
    isZeroDollarConfirmed: false,
    booking: {
      id: "child-1",
      status: BookingStatus.PAYMENT_PENDING,
      finalPriceCents: 9000,
      organiserSettled,
      guests: [],
    },
  };
}

function join(paymentMethod?: "stripe" | "internet_banking") {
  return joinGroupBookingAsMember(
    {
      code: "ABCD2345",
      guests: [
        {
          firstName: "Jo",
          lastName: "Member",
          ageTier: "ADULT",
          memberId: "joiner-1",
          isMember: true,
        },
      ],
      paymentMethod,
    },
    "joiner-1",
    "MEMBER"
  );
}

describe("joinGroupBookingAsMember after the organiser has paid (#3672)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLodgeCapacity.mockResolvedValue(10);
    mocks.joinFindFirst.mockResolvedValue(null);
    mocks.memberFindUnique.mockResolvedValue({ ageTier: "ADULT" });
    mocks.resolveLinkedBookingMembers.mockResolvedValue([]);
    mocks.assertLinkedBookingMembersCanBeBooked.mockResolvedValue(undefined);
    mocks.normalizeBookingGuestInputs.mockImplementation((guests: unknown[]) =>
      guests.map((g) => ({ ...(g as object), isMember: true }))
    );
    mocks.assertMembershipTypeBookingAllowed.mockResolvedValue(undefined);
    mocks.requiresPaidSubscriptionForMemberForBooking.mockResolvedValue(false);
    mocks.findUnpaidMemberGuests.mockResolvedValue([]);
    mocks.validateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
    mocks.evaluateProposedAdultMemberHosting.mockResolvedValue(null);
    mocks.loadInternetBankingPaymentSettings.mockResolvedValue({ enabled: true });
  });

  it("creates a member-pays booking the joiner is sent to pay, never on the organiser's bill", async () => {
    mocks.groupFindUnique.mockResolvedValue(
      group(GroupBookingPaymentMode.ORGANISER_PAYS, PaymentStatus.SUCCEEDED)
    );
    mocks.createConfirmedBooking.mockResolvedValue(created(false));

    const result = await join();

    expect(mocks.createConfirmedBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        organiserSettled: false,
        parentBookingId: "booking-1",
        groupJoin: { groupBookingId: "group-1", joinerMemberId: "joiner-1" },
      })
    );
    expect(result).toMatchObject({ requiresPayment: true, organiserSettled: false });
  });

  it("lets a joiner after payment choose Internet Banking like any member-pays joiner", async () => {
    mocks.groupFindUnique.mockResolvedValue(
      group(GroupBookingPaymentMode.ORGANISER_PAYS, PaymentStatus.SUCCEEDED)
    );
    mocks.createConfirmedBooking.mockResolvedValue(created(false));

    await join("internet_banking");

    expect(mocks.createConfirmedBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        organiserSettled: false,
        paymentMethod: "internet_banking",
      })
    );
  });

  it("keeps a joiner organiser-settled while the settlement is still open", async () => {
    mocks.groupFindUnique.mockResolvedValue(
      group(GroupBookingPaymentMode.ORGANISER_PAYS, PaymentStatus.PENDING)
    );
    mocks.createConfirmedBooking.mockResolvedValue(created(true));

    const result = await join("internet_banking");

    // The organiser pays: the joiner's method is forced to the default and no
    // invoice is ever raised to them.
    expect(mocks.createConfirmedBooking).toHaveBeenCalledWith(
      expect.objectContaining({ organiserSettled: true, paymentMethod: "stripe" })
    );
    expect(result).toMatchObject({ requiresPayment: false, organiserSettled: true });
  });

  it("reports the payer the booking was written with when the lock moved it to member-pays", async () => {
    // Read before the lock: still open. Written under it: the settlement had
    // been paid in between, so the booking is member-pays.
    mocks.groupFindUnique.mockResolvedValue(
      group(GroupBookingPaymentMode.ORGANISER_PAYS, PaymentStatus.PENDING)
    );
    mocks.createConfirmedBooking.mockResolvedValue(created(false));

    const result = await join();

    expect(result).toMatchObject({ requiresPayment: true, organiserSettled: false });
  });

  it("leaves a per-member-pays group unchanged", async () => {
    mocks.groupFindUnique.mockResolvedValue(
      group(GroupBookingPaymentMode.EACH_PAYS_OWN, null)
    );
    mocks.createConfirmedBooking.mockResolvedValue(created(false));

    const result = await join("internet_banking");

    expect(mocks.createConfirmedBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        organiserSettled: false,
        paymentMethod: "internet_banking",
      })
    );
    expect(result).toMatchObject({ requiresPayment: true, organiserSettled: false });
  });
});

describe("group-late-joiner helpers (#3672)", () => {
  it.each([
    [GroupBookingPaymentMode.ORGANISER_PAYS, null, true],
    [GroupBookingPaymentMode.ORGANISER_PAYS, PaymentStatus.PENDING, true],
    [GroupBookingPaymentMode.ORGANISER_PAYS, PaymentStatus.FAILED, true],
    // Partly refunded: money is still held, so the organiser paid.
    [GroupBookingPaymentMode.ORGANISER_PAYS, PaymentStatus.PARTIALLY_REFUNDED, false],
    // Fully refunded: on a live group the capture was handed back before it
    // settled anyone, so the organiser has not paid.
    [GroupBookingPaymentMode.ORGANISER_PAYS, PaymentStatus.REFUNDED, true],
    [GroupBookingPaymentMode.ORGANISER_PAYS, PaymentStatus.SUCCEEDED, false],
    [GroupBookingPaymentMode.EACH_PAYS_OWN, null, false],
    [GroupBookingPaymentMode.EACH_PAYS_OWN, PaymentStatus.SUCCEEDED, false],
  ])(
    "a %s group with a %s settlement: organiser pays = %s",
    (paymentMode, status, expected) => {
      expect(
        organiserPaysForNewJoiner({
          paymentMode,
          settlement: status ? { status } : null,
        })
      ).toBe(expected);
    }
  );

  it("answers member-pays for a group that no longer exists", async () => {
    const tx = { groupBooking: { findUnique: vi.fn().mockResolvedValue(null) } };
    await expect(organiserPaysForJoinerInTx(tx as never, "group-x")).resolves.toBe(
      false
    );
  });

  // #3672: the started-stay rule (`INV-PAY-016`'s): a joiner whose check-in
  // is on or before the club's today is left for the treasurer.
  it("moves a joiner yet to arrive and leaves one whose stay started yesterday or today", async () => {
    const tx = {
      booking: {
        findMany: vi.fn().mockResolvedValue([
          { id: "past", checkIn: new Date("2026-09-30T00:00:00.000Z") },
          { id: "today", checkIn: CLUB_TODAY },
          { id: "future", checkIn: new Date("2026-10-02T00:00:00.000Z") },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    await expect(
      releaseUnpaidJoinersToMemberPaysInTx(tx as never, "booking-1", CLUB_TODAY)
    ).resolves.toEqual({ released: ["future"], skippedStarted: ["past", "today"] });
    expect(tx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["future"] } }),
        data: { organiserSettled: false },
      })
    );
  });

  it("writes nothing when the paid bill left nobody behind", async () => {
    const tx = {
      booking: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn(),
      },
    };
    await expect(
      releaseUnpaidJoinersToMemberPaysInTx(tx as never, "booking-1", CLUB_TODAY)
    ).resolves.toEqual({ released: [], skippedStarted: [] });
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });
});
