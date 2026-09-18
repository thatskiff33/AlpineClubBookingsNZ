import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  seasonFindMany: vi.fn(),
  bookingCreate: vi.fn(),
  bookingCount: vi.fn(),
  bookingUpdate: vi.fn(),
  memberFindUnique: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  sendWaitlistConfirmationEmail: vi.fn(),
  sendAdminNewBookingAlert: vi.fn(),
  order: [] as string[],
}))

const tx = {
  booking: {
    create: (...args: unknown[]) => mocks.bookingCreate(...args),
    count: (...args: unknown[]) => mocks.bookingCount(...args),
    update: (...args: unknown[]) => mocks.bookingUpdate(...args),
    findUnique: vi.fn(),
  },
  adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
  // #3276: the night adjustment build-up writer reads and rewrites these.
  bookingGuestNightAdjustment: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    findMany: vi.fn().mockResolvedValue([]),
  },
  bookingGuestNight: {
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  promoRedemption: { findUnique: vi.fn().mockResolvedValue(null) },
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (callback: (client: typeof tx) => Promise<unknown>) =>
      mocks.transaction(callback),
    season: { findMany: (...args: unknown[]) => mocks.seasonFindMany(...args) },
    member: { findUnique: (...args: unknown[]) => mocks.memberFindUnique(...args) },
  },
}))

vi.mock("@/lib/lodges", () => ({
  resolveOptionalActiveLodgeId: vi.fn().mockResolvedValue("lodge-b"),
  lodgeNullTolerantScope: (lodgeId: string) => ({ lodgeId }),
}))

vi.mock("@/lib/lodge-access", () => ({
  assertMemberMayBookLodge: vi.fn().mockResolvedValue(undefined),
  LodgeBookingEligibilityError: class extends Error {},
}))

vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: async (_tx: unknown, lodgeId: string) => {
    mocks.order.push(`lock:${lodgeId}`)
    await mocks.acquireLodgeCapacityLock(_tx, lodgeId)
  },
  checkCapacityForGuestRanges: vi.fn(),
}))

vi.mock("@/lib/booking-member-night-conflicts", () => ({
  assertNoBookingMemberNightConflicts: vi.fn().mockResolvedValue(undefined),
  BookingMemberNightConflictError: class extends Error {},
  DUPLICATE_STAY_BOOKING_STATUSES: [],
}))

vi.mock("@/lib/membership-type-policy", () => ({
  priceBookingGuestsWithMembershipTypePolicy: vi.fn().mockResolvedValue({
    totalPriceCents: 10_000,
    guests: [
      {
        priceCents: 10_000,
        perNightCents: [5_000, 5_000],
        nightDates: [new Date("2026-08-10"), new Date("2026-08-11")],
      },
    ],
  }),
  assertMembershipTypeBookingAllowed: vi.fn(),
  MembershipTypeBookingPolicyError: class extends Error {},
}))

vi.mock("@/lib/booking-create-promo", () => ({
  resolveEffectivePromoSource: vi.fn().mockResolvedValue(null),
  resolvePromoInTransaction: vi.fn(),
  getPromoTargetBookingGuestIds: vi.fn().mockReturnValue([]),
  remapPromoIndexesToSubset: vi.fn().mockReturnValue([]),
}))

vi.mock("@/lib/adult-member-hosting-review", () => ({
  recordAdultMemberHostingReviewForNewBooking: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/email", () => ({
  sendWaitlistConfirmationEmail: (...args: unknown[]) =>
    mocks.sendWaitlistConfirmationEmail(...args),
  sendAdminNewBookingAlert: (...args: unknown[]) =>
    mocks.sendAdminNewBookingAlert(...args),
  sendBookingConfirmedEmail: vi.fn(),
  sendBookingPendingEmail: vi.fn(),
}))
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import {
  createWaitlistedBooking,
  type WaitlistedBookingInput,
} from "@/lib/booking-create"

describe("createWaitlistedBooking per-lodge position", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.order.length = 0
    mocks.transaction.mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    )
    mocks.seasonFindMany.mockResolvedValue([])
    mocks.acquireLodgeCapacityLock.mockResolvedValue(undefined)
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-b",
      email: "member-b@example.test",
      firstName: "Bea",
      lastName: "Member",
    })
    const created = {
      id: "booking-b",
      memberId: "member-b",
      lodgeId: "lodge-b",
      checkIn: new Date("2026-08-10"),
      checkOut: new Date("2026-08-12"),
      createdAt: new Date("2026-07-10"),
      status: "WAITLISTED",
      finalPriceCents: 10_000,
      requiresAdminReview: false,
      adminReviewReason: null,
      memberReviewJustification: null,
      guests: [{ id: "guest-b" }],
    }
    mocks.bookingCreate.mockResolvedValue(created)
    mocks.bookingUpdate.mockImplementation(
      async ({ data }: { data: { waitlistPosition: number } }) => ({
        ...created,
        waitlistPosition: data.waitlistPosition,
      }),
    )
    // Model one older overlapping Lodge A entry and no Lodge B entries. If the
    // production count omits lodgeId, this deliberately returns 1 and the
    // service/email report position 2.
    mocks.bookingCount.mockImplementation(
      async ({ where }: { where: { lodgeId?: string } }) => {
        mocks.order.push("count")
        return where.lodgeId === "lodge-b" ? 0 : 1
      },
    )
    mocks.sendWaitlistConfirmationEmail.mockResolvedValue(undefined)
    mocks.sendAdminNewBookingAlert.mockResolvedValue(undefined)
  })

  it("does not let Lodge A's queue make the first Lodge B entry position 2", async () => {
    const result = await createWaitlistedBooking({
      effectiveMemberId: "member-b",
      isOnBehalf: false,
      sessionUserId: "member-b",
      checkIn: new Date("2026-08-10"),
      checkOut: new Date("2026-08-12"),
      lodgeId: "lodge-b",
      guests: [
        {
          firstName: "Bea",
          lastName: "Member",
          ageTier: "ADULT",
          isMember: true,
          memberId: "member-b",
        },
      ],
    } as WaitlistedBookingInput)

    expect(result.position).toBe(1)
    expect(mocks.bookingCount).toHaveBeenCalledWith({
      where: expect.objectContaining({ lodgeId: "lodge-b" }),
    })
    expect(mocks.order).toEqual(["lock:lodge-b", "count"])
    expect(mocks.sendWaitlistConfirmationEmail).toHaveBeenCalledWith(
      { bookingId: "booking-b", recipientMemberId: "member-b" },
      "member-b@example.test",
      "Bea",
      expect.any(Date),
      expect.any(Date),
      1,
      1,
      "lodge-b",
    )
  })
})
