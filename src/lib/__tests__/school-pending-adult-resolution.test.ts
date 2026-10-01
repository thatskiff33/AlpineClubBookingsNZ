import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingRequestStatus, BookingStatus } from "@prisma/client";

const h = vi.hoisted(() => ({
  bookingRequestFindUnique: vi.fn(),
  bookingFindUnique: vi.fn(),
  requestUpdateMany: vi.fn(),
  guestCreate: vi.fn(),
  guestUpdate: vi.fn(),
  nightUpdate: vi.fn(),
  bookingUpdate: vi.fn(),
  reservationFindMany: vi.fn(),
  reservationDeleteMany: vi.fn(),
  reservationCreateMany: vi.fn(),
  memberFindMany: vi.fn(),
  resolvePolicies: vi.fn(),
  parseQuoteOptions: vi.fn(),
  resolveRates: vi.fn(),
  lockOrder: [] as string[],
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingRequest: { findUnique: h.bookingRequestFindUnique, updateMany: h.requestUpdateMany },
    booking: { findUnique: h.bookingFindUnique, update: h.bookingUpdate },
    bookingGuest: { create: h.guestCreate, update: h.guestUpdate },
    bookingGuestNight: { update: h.nightUpdate },
    bookingRequestPendingAdultReservationNight: {
      findMany: h.reservationFindMany,
      deleteMany: h.reservationDeleteMany,
      createMany: h.reservationCreateMany,
    },
    member: { findMany: h.memberFindMany },
    $executeRaw: vi.fn(async () => { h.lockOrder.push("global"); }),
    $transaction: vi.fn(async (callback) => callback((await import("@/lib/prisma")).prisma)),
  },
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn(async () => { h.lockOrder.push("lodge"); }),
}));
vi.mock("@/lib/booking-request-quotes", () => ({
  parseBookingRequestQuoteOptions: h.parseQuoteOptions,
}));
vi.mock("@/lib/booking-request", () => ({
  BookingRequestError: class BookingRequestError extends Error {
    constructor(message: string, public status: number) { super(message); }
  },
  parseBookingRequestGuests: (value: unknown) => value,
  linkedGuestMemberMap: () => new Map(),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/membership-type-policy", () => ({ resolveGuestRateMembershipTypes: h.resolveRates, resolveMembershipTypePoliciesForMembers: h.resolvePolicies }));
vi.mock("@/lib/member-dietary-booking-writes", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("@/lib/member-dietary-booking-writes");
  return {
    ...actual,
    resolveBookingGuestDietarySeeding: vi.fn(async () => actual.bookingGuestDietarySeeding(true)),
  };
});

import { resolveAcceptedSchoolPendingAdults } from "@/lib/school-pending-adult-resolution";

const inDay = new Date("2026-08-01T00:00:00.000Z");
const outDay = new Date("2026-08-02T00:00:00.000Z");
const originalGuests = [
  { firstName: "Ann", lastName: "Teacher", ageTier: "ADULT" },
  { firstName: "School Child", lastName: "1", ageTier: "CHILD" },
];
const acceptedRequest = {
  id: "request-1",
  type: "SCHOOL",
  status: BookingRequestStatus.ACCEPTED,
  version: 4,
  heldBookingId: "hold-1",
  convertedBookingId: null,
  pendingAdultCount: 1,
  teachers: [{ firstName: "Ann", lastName: "Teacher", email: null }],
  guests: originalGuests,
  linkedGuestMembers: [],
  acceptedQuoteSnapshot: { id: "option-1" },
  acceptedPriceCents: 300,
  acceptedQuoteOptionId: null,
  checkIn: inDay,
  checkOut: outDay,
};
const hold = {
  id: "hold-1",
  lodgeId: "lodge-1",
  status: BookingStatus.AWAITING_REVIEW,
  checkIn: inDay,
  checkOut: outDay,
  totalPriceCents: 300,
  discountCents: 0,
  promoAdjustmentCents: 0,
  guests: originalGuests.map((guest, index) => ({ ...guest, id: `guest-${index}`, memberId: null, nights: [{ id: `night-${index}`, stayDate: inDay }], stayStart: inDay, stayEnd: outDay, priceCents: 100 })),
};

function quoteBreakdown(pendingTotals: number[]) {
  return [
    ...originalGuests.map((guest, guestIndex) => ({ kind: "NAMED", ...guest, guestIndex, totalCents: 100 })),
    ...pendingTotals.map((totalCents, index) => ({ kind: "PENDING_ADULT", ageTier: "ADULT", guestIndex: originalGuests.length + index, totalCents })),
  ].map((entry) => ({ ...entry, memberId: null, isMember: false, nightCount: 1 }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.lockOrder.length = 0;
  h.bookingRequestFindUnique.mockResolvedValueOnce({ heldBookingId: "hold-1" }).mockResolvedValueOnce(acceptedRequest);
  h.bookingFindUnique.mockResolvedValueOnce({ lodgeId: "lodge-1" }).mockResolvedValueOnce(hold);
  h.memberFindMany.mockResolvedValue([]);
  h.resolvePolicies.mockResolvedValue(new Map());
  h.parseQuoteOptions.mockReturnValue([{
    totalCents: 300,
    guestBreakdown: quoteBreakdown([100]),
  }]);
  h.reservationFindMany.mockResolvedValue([{ bookingId: "hold-1", night: inDay, adultCount: 1, lodgeId: "lodge-1" }]);
  h.requestUpdateMany.mockResolvedValue({ count: 1 });
  h.guestCreate.mockResolvedValue({ id: "new-guest" });
  h.reservationDeleteMany.mockResolvedValue({ count: 1 });
  h.resolveRates.mockImplementation(async (_db, { guests }) =>
    guests.map((guest: object) => ({ ...guest, rateMembershipTypeId: "non-member-type", rateSource: "NON_MEMBER_DEFAULT" })),
  );
});
afterEach(() => vi.unstubAllEnvs());

describe("accepted school pending-adult identity resolution", () => {
  const command = () => resolveAcceptedSchoolPendingAdults({
    requestId: "request-1",
    adminMemberId: "officer-1",
    expectedVersion: 4,
    teachers: [{ firstName: "Beth", lastName: "Teacher", email: null }],
  });

  it("claims under global then lodge lock and swaps one anonymous bed for a named guest", async () => {
    await expect(command()).resolves.toEqual({ pendingAdultCount: 0, version: 5 });
    expect(h.lockOrder).toEqual(["global", "lodge"]);
    expect(h.requestUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ version: 4, status: BookingRequestStatus.ACCEPTED, pendingAdultCount: 1 }),
      data: expect.objectContaining({ pendingAdultCount: 0, teachers: expect.arrayContaining([{ firstName: "Beth", lastName: "Teacher", email: null }]) }),
    }));
    expect(h.guestCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ firstName: "Beth", lastName: "Teacher", priceCents: 100, rateMembershipTypeId: "non-member-type" }),
    }));
    expect(h.reservationDeleteMany).toHaveBeenCalledOnce();
    expect(h.reservationCreateMany).not.toHaveBeenCalled();
  });

  it("has no guest or reservation side effects when the version claim loses", async () => {
    h.requestUpdateMany.mockResolvedValue({ count: 0 });
    await expect(command()).rejects.toMatchObject({ status: 409 });
    expect(h.guestCreate).not.toHaveBeenCalled();
    expect(h.guestUpdate).not.toHaveBeenCalled();
    expect(h.nightUpdate).not.toHaveBeenCalled();
    expect(h.bookingUpdate).not.toHaveBeenCalled();
    expect(h.reservationDeleteMany).not.toHaveBeenCalled();
  });

  it("keeps the second anonymous bed and the accepted total after naming only one of two adults", async () => {
    // Rollback cleanup can shrink a reservation with new admissions disabled,
    // provided every old runtime is still stopped.
    vi.stubEnv("PENDING_SCHOOL_ADULTS_ENABLED", "0");
    vi.stubEnv("BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED", "1");
    h.bookingRequestFindUnique.mockReset()
      .mockResolvedValueOnce({ heldBookingId: "hold-1" })
      .mockResolvedValueOnce({ ...acceptedRequest, pendingAdultCount: 2, acceptedPriceCents: 500 });
    h.bookingFindUnique.mockReset()
      .mockResolvedValueOnce({ lodgeId: "lodge-1" })
      .mockResolvedValueOnce({ ...hold, totalPriceCents: 500 });
    h.parseQuoteOptions.mockReturnValue([{
      totalCents: 500,
      guestBreakdown: quoteBreakdown([100, 200]),
    }]);
    h.reservationFindMany.mockResolvedValue([{ bookingId: "hold-1", night: inDay, adultCount: 2, lodgeId: "lodge-1" }]);

    await expect(command()).resolves.toEqual({ pendingAdultCount: 1, version: 5 });
    expect(h.guestCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ firstName: "Beth", priceCents: 100 }),
    }));
    expect(h.reservationCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ bookingId: "hold-1", adultCount: 1, lodgeId: "lodge-1" })],
    });
    expect(h.requestUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ pendingAdultCount: 1 }),
    }));
  });

  it("refuses partial reservation rewrites while old web or workers may run", async () => {
    h.bookingRequestFindUnique.mockReset()
      .mockResolvedValueOnce({ heldBookingId: "hold-1" })
      .mockResolvedValueOnce({ ...acceptedRequest, pendingAdultCount: 2, acceptedPriceCents: 500 });
    h.bookingFindUnique.mockReset()
      .mockResolvedValueOnce({ lodgeId: "lodge-1" })
      .mockResolvedValueOnce({ ...hold, totalPriceCents: 500 });
    h.parseQuoteOptions.mockReturnValue([{
      totalCents: 500,
      guestBreakdown: quoteBreakdown([100, 200]),
    }]);
    h.reservationFindMany.mockResolvedValue([{ bookingId: "hold-1", night: inDay, adultCount: 2, lodgeId: "lodge-1" }]);

    await expect(command()).rejects.toThrow(/old web or workers are running/);
    expect(h.requestUpdateMany).not.toHaveBeenCalled();
    expect(h.guestCreate).not.toHaveBeenCalled();
    expect(h.reservationDeleteMany).not.toHaveBeenCalled();
  });

  it("stops when the real name may belong to a club member", async () => {
    h.memberFindMany.mockResolvedValue([{ id: "member-1", canLogin: true }]);
    await expect(command()).rejects.toThrow(/rate and consent/);
    expect(h.requestUpdateMany).not.toHaveBeenCalled();
    expect(h.guestCreate).not.toHaveBeenCalled();
  });
});
