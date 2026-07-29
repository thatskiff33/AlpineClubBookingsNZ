import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingRequestStatus,
  BookingRequestType,
  BookingStatus,
  PaymentSource,
  PaymentStatus,
} from "@prisma/client";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingRequest: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    member: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    booking: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    bookingGuest: {
      findMany: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    payment: { create: vi.fn() },
    hutLeaderAssignment: { create: vi.fn() },
    // #2285 review: an exclusivity approval reads the booking's per-bed rows
    // BEFORE pruning them, so the prune audit can list what it destroyed.
    bedAllocation: { findMany: vi.fn().mockResolvedValue([]) },
    season: { findMany: vi.fn() },
    groupDiscountSetting: { findUnique: vi.fn() },
    lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }) },
    // Rate resolver (#1930, E4): school guests are non-members, so no members
    // or assignments are needed — every guest resolves to NON_MEMBER.
    seasonalMembershipAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    membershipType: {
      findMany: vi.fn().mockResolvedValue([
        { id: "type-nonmember", key: "NON_MEMBER" },
        { id: "type-full", key: "FULL" },
      ]),
    },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("@/lib/email", () => ({
  sendBookingRequestVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendHutLeaderAssignmentEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminSchoolManualInvoiceEmail: vi.fn().mockResolvedValue(undefined),
  // #1377: the school approve path now fires an owner-substitution admin alert
  // on the substitute path. Stub it under the partial mock or the real approve
  // path calls undefined → throw (mock-safety, see #1417).
  sendAdminOwnerSubstitutionAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  // #2285 review: the held-conversion prune writes its own audit row on the
  // approval transaction (createAuditLog, not the post-commit logAudit).
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
  checkCapacityForGuestRanges: vi.fn(),
  // Read-only conflict surfacing (issue #119); defaults to no conflicts.
  findOverlappingCapacityHoldingBookings: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: vi.fn().mockResolvedValue(40),
  getDefaultLodgeCapacity: vi.fn().mockResolvedValue(40),
  // club-identity.ts (in this suite's module graph since #1985's bootstrap
  // rewiring) reads this display-only constant at module init.
  FALLBACK_LODGE_CAPACITY: 20,
}));

vi.mock("@/lib/lodge-pin-session", () => ({
  generateHutLeaderPin: vi.fn(() => "246810"),
  hashHutLeaderPin: vi.fn().mockResolvedValue("hashed-pin"),
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: vi
    .fn()
    .mockResolvedValue({ queueOperationId: "op-1" }),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: vi.fn().mockResolvedValue(true),
}));

// #2285 (ADR-001 bed-allocation short-circuit): an exclusivity approval prunes
// the booking's per-bed rows via the flag-keyed lifecycle reconcile — a held
// conversion preserves pre-assigned beds (#1254), which is wrong once the
// booking is whole-lodge-held. Mocked here; the prune semantics themselves are
// covered by bed-allocation-lifecycle.test.ts.
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: vi.fn().mockResolvedValue({
    enabled: true,
    deletedCount: 0,
    createdCount: 0,
    promotedCount: 0,
  }),
  MAX_AUDITED_PRUNED_ALLOCATIONS: 50,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("bcryptjs", () => ({
  hash: vi.fn().mockResolvedValue("hashed-placeholder"),
}));

// Keep the real BookingMemberNightConflictError; only the assertion is a spy.
vi.mock("@/lib/booking-member-night-conflicts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/booking-member-night-conflicts")>();
  return {
    ...actual,
    assertNoBookingMemberNightConflicts: vi.fn().mockResolvedValue(undefined),
  };
});

import { prisma } from "@/lib/prisma";
import {
  sendBookingRequestVerificationEmail,
  sendHutLeaderAssignmentEmail,
  sendAdminSchoolManualInvoiceEmail,
  sendAdminOwnerSubstitutionAlert,
} from "@/lib/email";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
  findOverlappingCapacityHoldingBookings,
} from "@/lib/capacity";
import { createAuditLog, logAudit } from "@/lib/audit";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import {
  enqueueXeroBookingInvoiceOperation,
} from "@/lib/xero-operation-outbox";
import { requiresAdultSupervisionReview } from "@/lib/booking-review";
import { BookingRequestError } from "@/lib/booking-request";
import {
  assertNoBookingMemberNightConflicts,
  BookingMemberNightConflictError,
} from "@/lib/booking-member-night-conflicts";
import {
  approveSchoolBookingRequest,
  createSchoolBookingRequest,
  generateSchoolGuests,
} from "@/lib/school-booking-request";

const mockedFindUnique = vi.mocked(prisma.bookingRequest.findUnique);
const mockedCreate = vi.mocked(prisma.bookingRequest.create);
const mockedUpdateMany = vi.mocked(prisma.bookingRequest.updateMany);
const mockedTransaction = vi.mocked(prisma.$transaction);
const mockedCheckCapacity = vi.mocked(checkCapacityForGuestRanges);
const mockedAcquireLodgeLock = vi.mocked(acquireLodgeCapacityLock);
const mockedSeasonFindMany = vi.mocked(prisma.season.findMany);
const mockedGroupDiscount = vi.mocked(prisma.groupDiscountSetting.findUnique);
const mockedModuleEnabled = vi.mocked(isEffectiveModuleEnabled);
const mockedEnqueueInvoice = vi.mocked(enqueueXeroBookingInvoiceOperation);
const mockedSendVerification = vi.mocked(sendBookingRequestVerificationEmail);
const mockedSendPin = vi.mocked(sendHutLeaderAssignmentEmail);
const mockedSendManualInvoice = vi.mocked(sendAdminSchoolManualInvoiceEmail);
const mockedSendOwnerSubstitution = vi.mocked(sendAdminOwnerSubstitutionAlert);
const mockedAssertNoConflicts = vi.mocked(assertNoBookingMemberNightConflicts);
const mockedLogAudit = vi.mocked(logAudit);

function memberNightConflictError() {
  return new BookingMemberNightConflictError([
    {
      memberId: "teacher-member-42",
      memberName: "Linked Teacher",
      bookingId: "existing-booking",
      bookingStatus: BookingStatus.CONFIRMED,
      bookingOwnerName: "Other Owner",
      bookingCheckIn: "2026-08-01",
      bookingCheckOut: "2026-08-03",
      guestId: "existing-guest",
      conflictingNights: ["2026-08-01"],
      isOwnBooking: false,
      // The admin guard passes actorRole "ADMIN", so the row is entitled and
      // carries the booking half above (#2250).
      canOpenBooking: true,
      canSelfRemove: false,
      isSelfGuest: false,
    },
  ]);
}

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z"); // 2 nights

function schoolRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "req-school",
    type: BookingRequestType.SCHOOL,
    status: BookingRequestStatus.VERIFIED,
    schoolName: "New Plymouth Primary School",
    teachers: [{ firstName: "Tana", lastName: "Teacher", email: "tana@school.test" }],
    contactFirstName: "Carol",
    contactLastName: "Contact",
    contactEmail: "office@school.test",
    contactPhone: null,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    guests: [
      { firstName: "Tana", lastName: "Teacher", ageTier: "ADULT" },
      { firstName: "School Child", lastName: "1", ageTier: "CHILD" },
      { firstName: "School Child", lastName: "2", ageTier: "CHILD" },
    ],
    message: null,
    indicativePriceCents: 20000,
    priceCents: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    version: 0,
    ...overrides,
  };
}

function seasonWithRates() {
  return [
    {
      id: "season-1",
      startDate: new Date("2026-07-01T00:00:00.000Z"),
      endDate: new Date("2026-09-01T00:00:00.000Z"),
      type: "WINTER",
      // School guests are non-members -> NON_MEMBER type rate rows (#1930, E4).
      membershipTypeRates: [
        { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 5000 },
        { membershipTypeId: "type-nonmember", ageTier: "CHILD", pricePerNightCents: 2500 },
      ],
    },
  ];
}

describe("generateSchoolGuests", () => {
  it("builds named ADULT teachers and numbered School Child rows by tier", () => {
    const guests = generateSchoolGuests({
      teachers: [{ firstName: "Tana", lastName: "Teacher" }],
      childCounts: { CHILD: 2, YOUTH: 1 },
    });

    expect(guests).toEqual([
      { firstName: "Tana", lastName: "Teacher", ageTier: "ADULT" },
      { firstName: "School Child", lastName: "1", ageTier: "CHILD" },
      { firstName: "School Child", lastName: "2", ageTier: "CHILD" },
      { firstName: "School Child", lastName: "3", ageTier: "YOUTH" },
    ]);
  });
});

describe("adult supervision rule with a teacher (issue #709 requirement 7)", () => {
  it("accepts a school booking when a teacher (ADULT) is present", () => {
    const guests = generateSchoolGuests({
      teachers: [{ firstName: "Tana", lastName: "Teacher" }],
      childCounts: { CHILD: 5 },
    });
    expect(requiresAdultSupervisionReview(guests)).toBe(false);
  });

  it("still flags a children-only group with no adult", () => {
    const guests = generateSchoolGuests({
      teachers: [],
      childCounts: { CHILD: 5 },
    });
    expect(requiresAdultSupervisionReview(guests)).toBe(true);
  });
});

describe("createSchoolBookingRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSeasonFindMany.mockResolvedValue([] as never); // no indicative price
    mockedCreate.mockResolvedValue(schoolRequest({ id: "req-new" }) as never);
  });

  it("requires a school name", async () => {
    await expect(
      createSchoolBookingRequest({
        schoolName: "  ",
        contactFirstName: "Carol",
        contactLastName: "Contact",
        contactEmail: "office@school.test",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        teachers: [{ firstName: "Tana", lastName: "Teacher" }],
        childCounts: { CHILD: 2 },
        cateringPreference: "NON_CATERED" as const,
      })
    ).rejects.toThrow(BookingRequestError);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("requires at least one teacher", async () => {
    await expect(
      createSchoolBookingRequest({
        schoolName: "New Plymouth Primary School",
        contactFirstName: "Carol",
        contactLastName: "Contact",
        contactEmail: "office@school.test",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        teachers: [],
        childCounts: { CHILD: 2 },
        cateringPreference: "NON_CATERED" as const,
      })
    ).rejects.toThrow(BookingRequestError);
  });

  it("creates a SCHOOL request with generated guests and emails verification", async () => {
    await createSchoolBookingRequest({
      schoolName: "New Plymouth Primary School",
      contactFirstName: "Carol",
      contactLastName: "Contact",
      contactEmail: "Office@School.test",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      teachers: [{ firstName: "Tana", lastName: "Teacher", email: "Tana@School.test" }],
      childCounts: { CHILD: 2, YOUTH: 1 },
      cateringPreference: "NON_CATERED" as const,
    });

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    const data = mockedCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.type).toBe(BookingRequestType.SCHOOL);
    expect(data.schoolName).toBe("New Plymouth Primary School");
    expect(data.contactEmail).toBe("office@school.test");
    const guests = data.guests as Array<{ ageTier: string }>;
    expect(guests).toHaveLength(4); // 1 teacher + 3 children
    expect(guests.filter((g) => g.ageTier === "ADULT")).toHaveLength(1);
    const teachers = data.teachers as Array<{ email: string | null }>;
    expect(teachers[0].email).toBe("tana@school.test");

    expect(mockedSendVerification).toHaveBeenCalledTimes(1);
  });

  it("rejects a group larger than lodge capacity", async () => {
    await expect(
      createSchoolBookingRequest({
        schoolName: "Big School",
        contactFirstName: "Carol",
        contactLastName: "Contact",
        contactEmail: "office@school.test",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        teachers: [{ firstName: "Tana", lastName: "Teacher" }],
        childCounts: { CHILD: 200 },
        cateringPreference: "NON_CATERED" as const,
      })
    ).rejects.toThrow(/lodge capacity/);
  });

  it("stores null lodgeId (default-lodge semantics) when no lodge is requested", async () => {
    await createSchoolBookingRequest({
      schoolName: "New Plymouth Primary School",
      contactFirstName: "Carol",
      contactLastName: "Contact",
      contactEmail: "office@school.test",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      teachers: [{ firstName: "Tana", lastName: "Teacher" }],
      childCounts: { CHILD: 2 },
      cateringPreference: "NON_CATERED" as const,
    });

    const data = mockedCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.lodgeId).toBeNull();
  });

  it("persists an explicit lodgeId, checks that lodge's capacity, and prices at its seasons", async () => {
    await createSchoolBookingRequest({
      schoolName: "New Plymouth Primary School",
      contactFirstName: "Carol",
      contactLastName: "Contact",
      contactEmail: "office@school.test",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      teachers: [{ firstName: "Tana", lastName: "Teacher" }],
      childCounts: { CHILD: 2 },
      cateringPreference: "NON_CATERED" as const,
      lodgeId: "lodge-2",
    });

    expect(vi.mocked(getLodgeCapacity)).toHaveBeenCalledWith("lodge-2");
    // Season lookup is scoped strictly to the requested lodge, never the
    // default lodge.
    const seasonWhere = mockedSeasonFindMany.mock.calls[0][0]!.where as Record<
      string,
      unknown
    >;
    expect(seasonWhere.lodgeId).toBe("lodge-2");
    expect(vi.mocked(prisma.lodge.findFirst)).not.toHaveBeenCalled();

    const data = mockedCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.lodgeId).toBe("lodge-2");
  });

  it("persists exclusivityRequested=true when the requester asked for sole occupancy (#121)", async () => {
    await createSchoolBookingRequest({
      schoolName: "New Plymouth Primary School",
      contactFirstName: "Carol",
      contactLastName: "Contact",
      contactEmail: "office@school.test",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      teachers: [{ firstName: "Tana", lastName: "Teacher" }],
      childCounts: { CHILD: 2 },
      cateringPreference: "NON_CATERED" as const,
      exclusivityRequested: true,
    });

    const data = mockedCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.exclusivityRequested).toBe(true);
  });

  it("defaults exclusivityRequested to false when the checkbox is not set", async () => {
    await createSchoolBookingRequest({
      schoolName: "New Plymouth Primary School",
      contactFirstName: "Carol",
      contactLastName: "Contact",
      contactEmail: "office@school.test",
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      teachers: [{ firstName: "Tana", lastName: "Teacher" }],
      childCounts: { CHILD: 2 },
      cateringPreference: "NON_CATERED" as const,
    });

    const data = mockedCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.exclusivityRequested).toBe(false);
  });
});

describe("approveSchoolBookingRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTransaction.mockImplementation(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedCheckCapacity.mockResolvedValue({
      available: true,
      minAvailable: 30,
      nightDetails: [],
    } as never);
    mockedModuleEnabled.mockResolvedValue(true);
    mockedSeasonFindMany.mockResolvedValue(seasonWithRates() as never);
    mockedGroupDiscount.mockResolvedValue(null as never);
    vi.mocked(prisma.lodge.findFirst).mockResolvedValue({ id: "lodge-1" } as never);

    let memberCalls = 0;
    vi.mocked(prisma.member.create).mockImplementation((async () => {
      memberCalls += 1;
      return memberCalls === 1
        ? ({ id: "school-member" } as never)
        : ({
            id: `teacher-member-${memberCalls}`,
            firstName: "Tana",
            email: "tana@school.test",
          } as never);
    }) as never);
    vi.mocked(prisma.booking.create).mockResolvedValue({ id: "booking-1" } as never);
    vi.mocked(prisma.booking.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.hutLeaderAssignment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);
    // Default to no member-night conflict; individual tests override to reject.
    mockedAssertNoConflicts.mockResolvedValue(undefined);
  });

  it("rejects a non-school request", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ type: BookingRequestType.GENERAL }) as never
    );
    await expect(
      approveSchoolBookingRequest({ requestId: "req-school", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a request that is not verified or priced", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ status: BookingRequestStatus.NEW }) as never
    );
    await expect(
      approveSchoolBookingRequest({ requestId: "req-school", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("returns capacityExceeded without converting when no beds remain", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);
    mockedCheckCapacity.mockResolvedValue({
      available: false,
      minAvailable: -2,
      nightDetails: [
        { date: new Date("2026-08-01T00:00:00.000Z"), availableBeds: -2 },
        { date: new Date("2026-08-02T00:00:00.000Z"), availableBeds: 1 },
      ],
    } as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(result).toEqual({ type: "capacityExceeded", fullNights: ["2026-08-01"] });
    expect(prisma.member.create).not.toHaveBeenCalled();
  });

  it("confirms the booking, prices from group rates, raises the Xero invoice, and assigns the teacher", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(result).toMatchObject({
      type: "approved",
      bookingId: "booking-1",
      schoolMemberId: "school-member",
      invoiceMode: "xero",
      teacherCount: 1,
    });
    // 1 adult @ 5000 x2 nights + 2 children @ 2500 x2 nights = 20000.
    expect(result).toMatchObject({ priceCents: 20000 });

    // School is the non-login Xero contact: name = school, email = contact.
    const schoolMemberArgs = vi.mocked(prisma.member.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(schoolMemberArgs.firstName).toBe("New Plymouth Primary School");
    expect(schoolMemberArgs.email).toBe("office@school.test");
    expect(schoolMemberArgs.canLogin).toBe(false);
    // Non-member category so the school contact is not counted as a paying member.
    expect(schoolMemberArgs.role).toBe("SCHOOL");

    // Booking is CONFIRMED (capacity held) and pays on account via Xero invoice.
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(bookingArgs.status).toBe(BookingStatus.CONFIRMED);
    expect(bookingArgs.finalPriceCents).toBe(20000);

    const paymentArgs = vi.mocked(prisma.payment.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(paymentArgs.source).toBe(PaymentSource.INTERNET_BANKING);
    expect(paymentArgs.status).toBe(PaymentStatus.PENDING);

    // Teacher becomes a non-login member with a hut leader assignment + PIN email.
    const teacherMemberArgs = vi.mocked(prisma.member.create).mock.calls[1][0].data as Record<
      string,
      unknown
    >;
    expect(teacherMemberArgs.canLogin).toBe(false);
    // Teachers carry the same non-member SCHOOL role as the school contact.
    expect(teacherMemberArgs.role).toBe("SCHOOL");
    expect(vi.mocked(prisma.hutLeaderAssignment.create)).toHaveBeenCalledTimes(1);
    expect(mockedSendPin).toHaveBeenCalledWith(
      expect.objectContaining({ email: "tana@school.test", pin: "246810" })
    );

    expect(mockedEnqueueInvoice).toHaveBeenCalledWith(
      "booking-1",
      expect.objectContaining({ createdByMemberId: "admin-1" })
    );
    expect(mockedSendManualInvoice).not.toHaveBeenCalled();
    // No substitution on a normal conversion → no owner-substitution alert (#1377).
    expect(mockedSendOwnerSubstitution).not.toHaveBeenCalled();
  });

  it("keeps a fresh-create approval lodge-only while re-reading the request under the lodge lock (#1881)", async () => {
    const order: string[] = [];
    let requestReads = 0;
    mockedFindUnique.mockImplementation((async () => {
      requestReads += 1;
      order.push(requestReads === 1 ? "outer-request" : `locked-request-${requestReads}`);
      return schoolRequest() as never;
    }) as never);
    mockedAcquireLodgeLock.mockImplementation(async () => {
      order.push("lodge-lock");
    });

    await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(order.indexOf("lodge-lock")).toBeGreaterThan(order.indexOf("outer-request"));
    expect(order.indexOf("locked-request-2")).toBeGreaterThan(
      order.indexOf("lodge-lock")
    );
    expect(mockedUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // The approval claim fences on the observed integer version (#1923),
        // not the millisecond-collidable updatedAt.
        where: expect.objectContaining({ version: schoolRequest().version }),
        data: expect.objectContaining({ version: { increment: 1 } }),
      })
    );
  });

  it("takes global then lodge locks and loses cleanly when cancellation wins the held-booking CAS (#1881)", async () => {
    const order: string[] = [];
    const heldRequest = schoolRequest({ heldBookingId: "held-1" });
    let requestReads = 0;
    mockedFindUnique.mockImplementation((async () => {
      requestReads += 1;
      order.push(requestReads === 1 ? "outer-request" : `locked-request-${requestReads}`);
      return heldRequest as never;
    }) as never);
    vi.mocked(prisma.$executeRaw).mockImplementation((async () => {
      order.push("global-lock");
      return 1 as never;
    }) as never);
    mockedAcquireLodgeLock.mockImplementation(async () => {
      order.push("lodge-lock");
    });
    let heldReads = 0;
    vi.mocked(prisma.booking.findUnique).mockImplementation((async () => {
      heldReads += 1;
      if (heldReads === 1) {
        order.push("held-lodge-locator");
        return { lodgeId: "lodge-1" } as never;
      }
      order.push("held-reread");
      return {
        id: "held-1",
        lodgeId: "lodge-1",
        memberId: "school-owner",
        status: BookingStatus.AWAITING_REVIEW,
      } as never;
    }) as never);
    // Model cancellation committing after the approval's fresh read but before
    // its guarded transition. The CAS sees count=0 and approval must abort.
    vi.mocked(prisma.booking.updateMany).mockImplementation((async () => {
      order.push("held-cas-lost");
      return { count: 0 } as never;
    }) as never);

    await expect(
      approveSchoolBookingRequest({
        requestId: "req-school",
        adminMemberId: "admin-1",
      })
    ).rejects.toMatchObject({ status: 409 });

    expect(order.indexOf("global-lock")).toBeGreaterThan(
      order.indexOf("outer-request")
    );
    expect(order.indexOf("global-lock")).toBeGreaterThan(
      order.indexOf("held-lodge-locator")
    );
    expect(order.indexOf("lodge-lock")).toBeGreaterThan(
      order.indexOf("global-lock")
    );
    expect(order.indexOf("locked-request-2")).toBeGreaterThan(
      order.indexOf("lodge-lock")
    );
    expect(order.indexOf("held-reread")).toBeGreaterThan(
      order.indexOf("locked-request-2")
    );
    expect(order.indexOf("held-cas-lost")).toBeGreaterThan(
      order.indexOf("held-reread")
    );

    // The losing transaction reaches no guest/capacity/member/payment work,
    // and every external post-commit effect remains gated off.
    expect(mockedCheckCapacity).not.toHaveBeenCalled();
    expect(prisma.bookingGuest.findMany).not.toHaveBeenCalled();
    expect(prisma.bookingGuest.update).not.toHaveBeenCalled();
    expect(prisma.bookingGuest.deleteMany).not.toHaveBeenCalled();
    expect(prisma.bookingGuest.createMany).not.toHaveBeenCalled();
    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.hutLeaderAssignment.create).not.toHaveBeenCalled();
    expect(mockedEnqueueInvoice).not.toHaveBeenCalled();
    expect(mockedSendPin).not.toHaveBeenCalled();
    expect(mockedSendManualInvoice).not.toHaveBeenCalled();
    expect(mockedLogAudit).not.toHaveBeenCalled();
  });

  it("aborts with 409 before any write when the held pointer is detached (lock-set decision flips) while the conversion waits for its locks (#1923)", async () => {
    // Pre-read: the request carries a hold, so the approval decides on the
    // global -> lodge lock set and takes the global lock. While it waits for the
    // locks, a concurrent release detaches the hold and bumps version. The
    // under-lock re-read must see the flipped lock-set decision and abort on the
    // integer version fence (and the explicit held-pointer comparison) BEFORE
    // any claim, held CAS, or side effect runs. Without the version bump two
    // same-millisecond writes could share updatedAt and slip the old fence.
    const order: string[] = [];
    const outer = schoolRequest({
      status: BookingRequestStatus.PRICED,
      heldBookingId: "held-1",
      version: 1,
    });
    // Detached under the locks: hold gone, version advanced, still unconverted.
    const detached = schoolRequest({
      status: BookingRequestStatus.PRICED,
      heldBookingId: null,
      version: 2,
    });
    let requestReads = 0;
    mockedFindUnique.mockImplementation((async () => {
      requestReads += 1;
      order.push(requestReads === 1 ? "outer-request" : `locked-request-${requestReads}`);
      return (requestReads === 1 ? outer : detached) as never;
    }) as never);
    vi.mocked(prisma.$executeRaw).mockImplementation((async () => {
      order.push("global-lock");
      return 1 as never;
    }) as never);
    mockedAcquireLodgeLock.mockImplementation(async () => {
      order.push("lodge-lock");
    });
    // Only the pre-transaction held-lodge locator read happens; the post-lock
    // held re-read must never be reached because the fence throws first.
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      lodgeId: "lodge-1",
    } as never);

    await expect(
      approveSchoolBookingRequest({
        requestId: "req-school",
        adminMemberId: "admin-1",
      })
    ).rejects.toMatchObject({ status: 409 });

    // The pre-read lock-set decision still took the global lock first.
    expect(order.indexOf("global-lock")).toBeGreaterThan(
      order.indexOf("outer-request")
    );
    expect(order.indexOf("lodge-lock")).toBeGreaterThan(
      order.indexOf("global-lock")
    );
    expect(order.indexOf("locked-request-2")).toBeGreaterThan(
      order.indexOf("lodge-lock")
    );

    // No claim, no held CAS, no held re-read, and no side effect ran.
    expect(mockedUpdateMany).not.toHaveBeenCalled();
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    expect(prisma.booking.findUnique).toHaveBeenCalledTimes(1);
    expect(mockedCheckCapacity).not.toHaveBeenCalled();
    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(mockedEnqueueInvoice).not.toHaveBeenCalled();
    expect(mockedSendPin).not.toHaveBeenCalled();
  });

  it("sets the exclusive whole-lodge hold on the booking when the request asked for exclusivity (#121)", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ exclusivityRequested: true }) as never,
    );

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(result).toMatchObject({ type: "approved", bookingId: "booking-1" });
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    // The hold flag + who/when audit fields are stamped by the approving admin.
    expect(bookingArgs.wholeLodgeHold).toBe(true);
    expect(bookingArgs.wholeLodgeHoldAt).toBeInstanceOf(Date);
    expect(bookingArgs.wholeLodgeHoldByMemberId).toBe("admin-1");

    // Dedicated audit row for the capacity-affecting flag.
    const setAudit = mockedLogAudit.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.action === "booking.exclusiveHold.set");
    expect(setAudit).toMatchObject({
      actorMemberId: "admin-1",
      entityType: "Booking",
      entityId: "booking-1",
    });

    // #2285 (ADR-001 short-circuit): granting exclusivity prunes any per-bed
    // rows the booking carries (a held conversion preserves pre-assigned beds,
    // #1254, which is wrong once whole-lodge-held). With the flag freshly
    // stamped, the flag-keyed reconcile is a pure whole-booking prune.
    expect(reconcileBedAllocationsForBooking).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1" }),
    );
  });

  // #2285 review: the prune on this path used to audit NOTHING, so a school
  // approval could silently destroy pre-assigned (and approved) beds with no
  // record of what they were. It now records the same compact list the admin
  // toggle route records, on the approval transaction.
  it("audits WHAT the exclusivity prune destroyed, read before the prune", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ exclusivityRequested: true }) as never,
    );
    // ...Once: the suite's beforeEach clears CALLS but not implementations, so a
    // sticky override here would leak into the "destroyed nothing" case below.
    vi.mocked(prisma.bedAllocation.findMany).mockResolvedValueOnce([
      {
        bookingGuestId: "guest-1",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: new Date("2026-08-01T00:00:00.000Z"),
        source: "MANUAL",
        approvedAt: new Date("2026-07-20T04:05:06.000Z"),
      },
    ] as never);
    vi.mocked(reconcileBedAllocationsForBooking).mockResolvedValueOnce({
      enabled: true,
      deletedCount: 1,
      createdCount: 0,
      promotedCount: 0,
    });

    await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    // Read BEFORE the prune — afterwards the rows are gone.
    expect(
      vi.mocked(prisma.bedAllocation.findMany).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(reconcileBedAllocationsForBooking).mock.invocationCallOrder[0],
    );

    const pruneAudit = vi
      .mocked(createAuditLog)
      .mock.calls.map((call) => call[0])
      .find((entry) => entry.action === "BED_ALLOCATION_HELD_BOOKING_PRUNED");
    expect(pruneAudit).toMatchObject({
      entityType: "Booking",
      entityId: "booking-1",
      actorMemberId: "admin-1",
      category: "lodge",
      outcome: "success",
      metadata: expect.objectContaining({
        deletedCount: 1,
        removedAllocationsTruncated: false,
        removedAllocations: [
          {
            bookingGuestId: "guest-1",
            roomId: "room-a",
            bedId: "bed-a1",
            stayDate: "2026-08-01",
            source: "MANUAL",
            approvedAt: "2026-07-20T04:05:06.000Z",
          },
        ],
      }),
    });
  });

  it("writes no prune audit when the exclusivity approval destroyed nothing", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ exclusivityRequested: true }) as never,
    );

    await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(
      vi
        .mocked(createAuditLog)
        .mock.calls.map((call) => call[0])
        .find((entry) => entry.action === "BED_ALLOCATION_HELD_BOOKING_PRUNED"),
    ).toBeUndefined();
  });

  it("surfaces overlapping conflicts when a hold is set at approval, without refusing (issue #119)", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ exclusivityRequested: true }) as never,
    );
    const conflicts = [
      {
        id: "booking-2",
        memberName: "Jane Doe",
        checkIn: "2026-07-01",
        checkOut: "2026-07-03",
        guestCount: 2,
        status: "CONFIRMED",
      },
    ];
    vi.mocked(findOverlappingCapacityHoldingBookings).mockResolvedValueOnce(
      conflicts,
    );

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(result).toMatchObject({
      type: "approved",
      exclusiveHoldConflicts: conflicts,
    });
    // Excludes the just-approved booking; still succeeded (decision 1).
    expect(findOverlappingCapacityHoldingBookings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ excludeBookingId: "booking-1" }),
    );
    const setAudit = mockedLogAudit.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.action === "booking.exclusiveHold.set");
    expect(setAudit?.metadata).toMatchObject({ overlappingConflictCount: 1 });
  });

  it("leaves the booking non-exclusive when the request did not ask for exclusivity", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ exclusivityRequested: false }) as never,
    );

    await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(bookingArgs.wholeLodgeHold).toBeUndefined();
    expect(bookingArgs.wholeLodgeHoldByMemberId).toBeUndefined();

    const setAudit = mockedLogAudit.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.action === "booking.exclusiveHold.set");
    expect(setAudit).toBeUndefined();

    // #2285: no exclusivity → no allocation prune. The #1254 bed-preservation
    // behaviour of an ordinary approval is untouched.
    expect(reconcileBedAllocationsForBooking).not.toHaveBeenCalled();
  });

  it("creates the booking at the request's lodge instead of the default lodge", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ lodgeId: "lodge-2" }) as never
    );

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(result).toMatchObject({ type: "approved", bookingId: "booking-1" });
    // The default-lodge resolver must not run when the request names a lodge.
    expect(vi.mocked(prisma.lodge.findFirst)).not.toHaveBeenCalled();
    expect(mockedCheckCapacity).toHaveBeenCalledWith(
      "lodge-2",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
      expect.anything()
    );
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(bookingArgs.lodgeId).toBe("lodge-2");
    // The teacher's hut-leader assignment inherits the booking's lodge, so a
    // multi-lodge club never gets a lodge-less hut leader from a school booking.
    const hutLeaderArgs = vi.mocked(prisma.hutLeaderAssignment.create).mock
      .calls[0][0].data as Record<string, unknown>;
    expect(hutLeaderArgs.lodgeId).toBe("lodge-2");
    // Approval repricing is scoped strictly to the request's lodge too.
    const seasonWhere = mockedSeasonFindMany.mock.calls[0][0]!.where as Record<
      string,
      unknown
    >;
    expect(seasonWhere.lodgeId).toBe("lodge-2");
  });

  it("maps the school owner to an existing non-login SCHOOL contact instead of creating one (#1255)", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);
    // The chosen contact is a valid non-login SCHOOL organisation contact.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "existing-school",
      canLogin: false,
      role: "SCHOOL",
      archivedAt: null,
      active: true,
    } as never);
    // On the map path member.create is only called for the teacher(s).
    vi.mocked(prisma.member.create).mockResolvedValue({
      id: "teacher-member",
      firstName: "Tana",
      email: "tana@school.test",
    } as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
      ownerContactMemberId: "existing-school",
    });

    expect(result).toMatchObject({
      type: "approved",
      schoolMemberId: "existing-school",
      invoiceMode: "xero",
      teacherCount: 1,
    });
    // The booking is owned by the mapped contact, reusing its Xero contact.
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(bookingArgs.memberId).toBe("existing-school");
    // member.create ran ONLY for the teacher, never for the school owner.
    expect(prisma.member.create).toHaveBeenCalledTimes(1);
    const onlyMemberArgs = vi.mocked(prisma.member.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(onlyMemberArgs.firstName).toBe("Tana");
  });

  it("rejects mapping a school request onto a login-capable member (#1255 guard)", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "real-member",
      canLogin: true,
      role: "USER",
      archivedAt: null,
    } as never);

    await expect(
      approveSchoolBookingRequest({
        requestId: "req-school",
        adminMemberId: "admin-1",
        ownerContactMemberId: "real-member",
      })
    ).rejects.toMatchObject({ status: 422 });
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it("is idempotent on a re-armed convertedBookingId: a replayed accept returns the existing booking and raises no second Xero invoice or PIN (#1232)", async () => {
    // First accept: a clean VERIFIED request confirms once and queues one invoice.
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);

    const first = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });
    expect(first).toMatchObject({
      type: "approved",
      bookingId: "booking-1",
      schoolMemberId: "school-member",
      invoiceMode: "xero",
    });
    expect(prisma.booking.create).toHaveBeenCalledTimes(1);
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(mockedEnqueueInvoice).toHaveBeenCalledTimes(1);
    expect(mockedSendPin).toHaveBeenCalledTimes(1);

    // Simulate the caller's line-~729 re-arm: PRICED (with priceCents, as the
    // real caller writes) WITHOUT clearing convertedBookingId/convertedMemberId.
    // Do NOT reset mock history — the money proof is that the counts stay at one.
    mockedFindUnique.mockResolvedValue(
      schoolRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 20000,
        convertedBookingId: "booking-1",
        convertedMemberId: "school-member",
      }) as never
    );

    const replay = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    // Returns the SAME booking; no second booking/payment; and — money-critical —
    // no second Xero invoice and no re-sent teacher PIN.
    expect(replay).toMatchObject({
      type: "approved",
      bookingId: "booking-1",
      schoolMemberId: "school-member",
    });
    expect(prisma.booking.create).toHaveBeenCalledTimes(1);
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(mockedEnqueueInvoice).toHaveBeenCalledTimes(1);
    expect(mockedSendPin).toHaveBeenCalledTimes(1);
    // The claim updateMany ran for the first accept only, never the replay.
    expect(mockedUpdateMany).toHaveBeenCalledTimes(1);
    // Under the lock the replay re-asserts the terminal status to CONVERTED.
    const lastUpdate = vi.mocked(prisma.bookingRequest.update).mock.calls.at(-1)?.[0]
      .data as Record<string, unknown>;
    expect(lastUpdate.status).toBe(BookingRequestStatus.CONVERTED);
  });

  it("returns a committed held conversion before rejecting version or held-pointer drift (#1881)", async () => {
    const outer = schoolRequest({
      status: BookingRequestStatus.PRICED,
      heldBookingId: "held-1",
      version: 1,
    });
    const committed = schoolRequest({
      status: BookingRequestStatus.PRICED,
      heldBookingId: "held-2",
      version: 2,
      convertedBookingId: "booking-existing",
      convertedMemberId: "school-existing",
    });
    let requestReads = 0;
    mockedFindUnique.mockImplementation((async () => {
      requestReads += 1;
      return (requestReads === 1 ? outer : committed) as never;
    }) as never);
    // The old held pointer supplies the immutable lock key. Because the full
    // locked request exposes durable converted ids, replay returns before the
    // stale version/pointer fence or a mutable held-booking re-read.
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      lodgeId: "lodge-1",
    } as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(result).toMatchObject({
      type: "approved",
      bookingId: "booking-existing",
      schoolMemberId: "school-existing",
      teacherCount: 0,
    });
    expect(mockedAcquireLodgeLock).toHaveBeenCalledWith(prisma, "lodge-1");
    expect(prisma.booking.findUnique).toHaveBeenCalledTimes(1);
    expect(mockedUpdateMany).not.toHaveBeenCalled();
    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(mockedEnqueueInvoice).not.toHaveBeenCalled();
    const terminalUpdate = vi.mocked(prisma.bookingRequest.update).mock.calls[0]?.[0]
      .data as Record<string, unknown>;
    expect(terminalUpdate.status).toBe(BookingRequestStatus.CONVERTED);
  });

  it("falls back to a manual-invoice admin alert when the Xero module is off", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);
    mockedModuleEnabled.mockResolvedValue(false);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(result).toMatchObject({ type: "approved", invoiceMode: "manual" });
    expect(mockedEnqueueInvoice).not.toHaveBeenCalled();
    expect(mockedSendManualInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        schoolName: "New Plymouth Primary School",
        contactEmail: "office@school.test",
        totalCents: 20000,
      })
    );
  });

  it("names the mapped contact (not the raw request) on the manual-invoice notification (#1255 decision 3)", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);
    mockedModuleEnabled.mockResolvedValue(false); // Xero off → manual invoice
    // Map to an existing SCHOOL contact whose name/email differ from the request.
    // A single findUnique mock serves both the guard and the Decision-3 resolve.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "mapped-school",
      canLogin: false,
      role: "SCHOOL",
      archivedAt: null,
      active: true,
      firstName: "Mapped College",
      lastName: "",
      email: "accounts@mappedcollege.test",
    } as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
      ownerContactMemberId: "mapped-school",
    });

    expect(result).toMatchObject({
      type: "approved",
      invoiceMode: "manual",
      schoolMemberId: "mapped-school",
    });
    // The notification names the party actually being invoiced (the mapped
    // contact), not request.schoolName / request.contactEmail.
    expect(mockedSendManualInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        schoolName: "Mapped College",
        contactEmail: "accounts@mappedcollege.test",
      })
    );
  });

  it("substitutes a fresh SCHOOL contact when the held owner is invalid at conversion, and the accept still succeeds (#1255 decision 1)", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ heldBookingId: "held-1" }) as never
    );
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      id: "held-1",
      lodgeId: "lodge-1",
      memberId: "held-invalid-school",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    // The held school owner became login-capable → re-validation rejects it.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-invalid-school",
      canLogin: true,
      role: "USER",
      archivedAt: null,
      active: true,
    } as never);
    // Guest counts differ → reassign uses delete+recreate (both mocked).
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.bookingGuest.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.bookingGuest.createMany).mockResolvedValue({ count: 3 } as never);
    vi.mocked(prisma.booking.update).mockResolvedValue({ id: "held-1" } as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    // Accept succeeds; the confirmed booking is re-owned by the fresh substitute
    // (first member.create → "school-member" per the beforeEach impl).
    expect(result).toMatchObject({
      type: "approved",
      schoolMemberId: "school-member",
    });
    const substituteArgs = vi.mocked(prisma.member.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(substituteArgs.role).toBe("SCHOOL");
    expect(substituteArgs.canLogin).toBe(false);
    // The held booking is repointed at the substitute owner.
    const updateArgs = vi.mocked(prisma.booking.update).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(updateArgs.memberId).toBe("school-member");
    // The #1352 capacity re-check runs on the held-reuse path even WITHOUT a
    // guestOverride (submitted snapshot), excluding the hold's own beds —
    // guards against a future regression gating the check behind the
    // override. (Adopted from the independent implementation in PR #1402.)
    expect(mockedCheckCapacity).toHaveBeenCalledWith(
      "lodge-1",
      CHECK_IN,
      CHECK_OUT,
      expect.any(Array),
      "held-1",
      expect.anything()
    );
    expect(mockedCheckCapacity.mock.calls[0][3]).toHaveLength(3);
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.owner_substituted",
        metadata: expect.objectContaining({
          invalidMemberId: "held-invalid-school",
          substituteMemberId: "school-member",
        }),
      })
    );
    // #1377 parity: the school path also fires the active admin email alert
    // post-commit (fire-and-forget) so finance/Xero admins reconcile the invoice.
    expect(mockedSendOwnerSubstitution).toHaveBeenCalledTimes(1);
    expect(mockedSendOwnerSubstitution).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-school",
        bookingId: "held-1",
        intendedMemberId: "held-invalid-school",
        substituteMemberId: "school-member",
      })
    );
  });

  it("re-checks per-night capacity on the held-reuse branch and rejects with capacityExceeded (#1352)", async () => {
    // F6: PRICED request -> admin held slots for 3 guests -> approve with a
    // larger override. The hold reserved only the ORIGINAL guest count, so
    // the new list must clear the same per-night capacity gate as the
    // fresh-create branch — previously this branch skipped it entirely and
    // silently oversold the lodge.
    mockedFindUnique.mockResolvedValue(
      schoolRequest({
        status: BookingRequestStatus.PRICED,
        heldBookingId: "held-1",
      }) as never
    );
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      id: "held-1",
      lodgeId: "lodge-1",
      memberId: "held-school-owner",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    // Owner re-validation passes: a valid non-login SCHOOL contact.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-school-owner",
      canLogin: false,
      role: "SCHOOL",
      archivedAt: null,
      active: true,
    } as never);
    mockedCheckCapacity.mockResolvedValue({
      available: false,
      minAvailable: -3,
      nightDetails: [
        { date: new Date("2026-08-01T00:00:00.000Z"), availableBeds: -3 },
        { date: new Date("2026-08-02T00:00:00.000Z"), availableBeds: 2 },
      ],
    } as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
      guestOverride: { childCounts: { CHILD: 6 } },
    });

    expect(result).toEqual({
      type: "capacityExceeded",
      fullNights: ["2026-08-01"],
    });
    // The re-check runs against the NEW (regenerated) guest list, excludes
    // the held booking's own guests, and uses the locked transaction client.
    expect(mockedCheckCapacity).toHaveBeenCalledWith(
      "lodge-1",
      CHECK_IN,
      CHECK_OUT,
      expect.any(Array),
      "held-1",
      prisma
    );
    expect(mockedCheckCapacity.mock.calls[0][3]).toHaveLength(7); // 1 teacher + 6 children
    // Nothing was swapped or confirmed: the guest swap, the CONFIRMED flip,
    // and the payment row must all be absent (the tx rolled back).
    expect(prisma.bookingGuest.deleteMany).not.toHaveBeenCalled();
    expect(prisma.bookingGuest.createMany).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it("approves the held-reuse branch when the per-night re-check passes (#1352)", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({
        status: BookingRequestStatus.PRICED,
        heldBookingId: "held-1",
      }) as never
    );
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      id: "held-1",
      lodgeId: "lodge-1",
      memberId: "held-school-owner",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-school-owner",
      canLogin: false,
      role: "SCHOOL",
      archivedAt: null,
      active: true,
    } as never);
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.bookingGuest.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.bookingGuest.createMany).mockResolvedValue({ count: 5 } as never);
    vi.mocked(prisma.booking.update).mockResolvedValue({ id: "held-1" } as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
      guestOverride: { childCounts: { CHILD: 4 } },
    });

    expect(result).toMatchObject({ type: "approved", bookingId: "held-1" });
    expect(mockedCheckCapacity).toHaveBeenCalledWith(
      "lodge-1",
      CHECK_IN,
      CHECK_OUT,
      expect.any(Array),
      "held-1",
      prisma
    );
  });

  it("keeps a null-lodge request on the held booking's concrete lodge after the default changes (#1881)", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({
        status: BookingRequestStatus.PRICED,
        heldBookingId: "held-1",
        lodgeId: null,
      }) as never
    );
    // The hold was created at lodge-old. The club default now resolves to
    // lodge-1 in beforeEach, but held reuse must never consult that default.
    vi.mocked(prisma.booking.findUnique).mockResolvedValue({
      id: "held-1",
      lodgeId: "lodge-old",
      memberId: "held-school-owner",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-school-owner",
      canLogin: false,
      role: "SCHOOL",
      archivedAt: null,
      active: true,
    } as never);
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.bookingGuest.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.bookingGuest.createMany).mockResolvedValue({ count: 3 } as never);
    vi.mocked(prisma.booking.update).mockResolvedValue({ id: "held-1" } as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(result).toMatchObject({ type: "approved", bookingId: "held-1" });
    expect(mockedAcquireLodgeLock).toHaveBeenCalledWith(prisma, "lodge-old");
    expect(mockedCheckCapacity).toHaveBeenCalledWith(
      "lodge-old",
      CHECK_IN,
      CHECK_OUT,
      expect.any(Array),
      "held-1",
      prisma
    );
    const seasonWhere = mockedSeasonFindMany.mock.calls[0][0]!.where as Record<
      string,
      unknown
    >;
    expect(seasonWhere.lodgeId).toBe("lodge-old");
    const assignmentData = vi.mocked(prisma.hutLeaderAssignment.create).mock
      .calls[0][0].data as Record<string, unknown>;
    expect(assignmentData.lodgeId).toBe("lodge-old");
    expect(prisma.lodge.findFirst).not.toHaveBeenCalled();
  });

  it("uses an officer-set price override when present", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ status: BookingRequestStatus.PRICED, priceCents: 33000 }) as never
    );

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(result).toMatchObject({ priceCents: 33000 });
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(bookingArgs.finalPriceCents).toBe(33000);
  });

  it("refuses to approve when no season covers the dates and no price is set", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);
    mockedSeasonFindMany.mockResolvedValue([] as never);

    await expect(
      approveSchoolBookingRequest({ requestId: "req-school", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("regenerates guests, reprices, and snapshots the request when the admin varies the quantity", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
      guestOverride: { childCounts: { CHILD: 4 } },
    });

    // 1 adult @ 5000 x2 + 4 children @ 2500 x2 = 10000 + 20000 = 30000.
    expect(result).toMatchObject({ type: "approved", priceCents: 30000 });

    // Booking holds the regenerated guest list (1 teacher + 4 children).
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as {
      guests: { create: unknown[] };
      finalPriceCents: number;
    };
    expect(bookingArgs.guests.create).toHaveLength(5);
    expect(bookingArgs.finalPriceCents).toBe(30000);

    // The request snapshot is updated to match what was booked.
    const updateArgs = vi.mocked(prisma.bookingRequest.update).mock.calls.at(-1)?.[0]
      .data as { guests?: unknown[] };
    expect(updateArgs.guests).toHaveLength(5);
  });

  it("re-splits an officer-set price across the varied guest count", async () => {
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ status: BookingRequestStatus.PRICED, priceCents: 30000 }) as never
    );

    const result = await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
      guestOverride: { childCounts: { CHILD: 4 } },
    });

    // The negotiated total is preserved and split across the new 5 guests.
    expect(result).toMatchObject({ priceCents: 30000 });
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as {
      guests: { create: unknown[] };
    };
    expect(bookingArgs.guests.create).toHaveLength(5);
  });

  it("rejects a quantity override that exceeds the lodge capacity", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);

    await expect(
      approveSchoolBookingRequest({
        requestId: "req-school",
        adminMemberId: "admin-1",
        guestOverride: { childCounts: { CHILD: 50 } },
      })
    ).rejects.toMatchObject({ status: 422 });
    expect(prisma.member.create).not.toHaveBeenCalled();
  });

  it("runs the member-night conflict guard with the requested guests and range before creating anything (issue #1158)", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);

    await approveSchoolBookingRequest({ requestId: "req-school", adminMemberId: "admin-1" });

    expect(mockedAssertNoConflicts).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        actorMemberId: "admin-1",
        actorRole: "ADMIN",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        excludeBookingId: undefined,
      })
    );
    const guardGuests = mockedAssertNoConflicts.mock.calls[0][1].guests;
    expect(guardGuests).toHaveLength(3);
    expect(guardGuests[0]).toMatchObject({ stayStart: CHECK_IN, stayEnd: CHECK_OUT });
  });

  it("blocks approval and creates nothing when a linked member double-books (issue #1158)", async () => {
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);
    mockedAssertNoConflicts.mockRejectedValueOnce(memberNightConflictError());

    await expect(
      approveSchoolBookingRequest({ requestId: "req-school", adminMemberId: "admin-1" })
    ).rejects.toBeInstanceOf(BookingMemberNightConflictError);

    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(prisma.booking.create).not.toHaveBeenCalled();
    expect(mockedEnqueueInvoice).not.toHaveBeenCalled();
  });
});
