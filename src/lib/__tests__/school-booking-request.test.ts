import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingRequestStatus,
  BookingRequestType,
  BookingStatus,
  type BookingGuestNightPriceSource,
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
    // #2364: the hosting review is reconciled inside the approving/holding
    // transaction, so every prisma/tx double a booking-writing path runs
    // against needs this client. `findUnique` answering undefined is the
    // "booking not found" branch, which writes nothing.
    adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    booking: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    // MG4 (#2309): the pipeline computes the family boundary for its linked
    // members against the converted booking's owner. That owner is a non-login
    // contact in no family group, so both reads legitimately come back empty and
    // every linked member classifies BEYOND_FAMILY — the real production shape.
    familyGroupMember: { findMany: vi.fn().mockResolvedValue([]) },
    bookingGuest: {
      findMany: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      // #2739: the reassign recreate branch creates one guest at a time, so the
      // ids its BookingGuestNight rows need come back in hand.
      create: vi.fn(),
    },
    // #2739: both reassign branches write the party's night rows in one batched
    // delete + createMany, once the guest ids exist.
    bookingGuestNight: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    payment: { create: vi.fn() },
    // #2263: stubbed so "no PaymentLink is created" is a REAL assertion. Left
    // off the mock it was vacuous — `expect(prisma.paymentLink).toBeUndefined()`
    // passes because the mock lacks the delegate, not because the code declines
    // to use it, and it would keep passing if the code started minting tokens.
    paymentLink: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
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
  // #2263: the member whole-lodge sibling of the school manual-invoice alert,
  // fired when the Xero module is off so the receivable is still invoiced.
  sendAdminWholeLodgeManualInvoiceEmail: vi.fn().mockResolvedValue(undefined),
  // #2263: the member whole-lodge approval sends the ordinary booking
  // confirmation. Stub it under the partial mock or the approve path calls
  // undefined → throw (mock-safety, see #1417).
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
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
  // #2263: the #1620 floating-credit parity op the member whole-lodge approval
  // enqueues alongside the invoice (the school path's non-login contact never
  // carries account credit, so the school block omits it).
  enqueueXeroAppliedCreditAllocationOperation: vi
    .fn()
    .mockResolvedValue({ queueOperationId: "op-2" }),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: vi.fn().mockResolvedValue(true),
}));

// MG4 (#2309): the two post-commit dispatchers, imported lazily by the school
// pipeline. Stubbed so the test below asserts the WIRING — that a teacher an
// officer linked to a real member account is actually told — without pulling
// the email/template graph into this suite.
vi.mock("@/lib/member-guest-consent-notifications", () => ({
  sendMemberGuestAddNotifications: vi.fn(),
  sendMemberGuestWithdrawnNotifications: vi.fn(),
}));
vi.mock("@/lib/member-guest-settings", () => ({
  loadMemberGuestSettings: vi.fn().mockResolvedValue({
    approvalRequired: true,
    pendingHoldExpiryDays: 7,
    openMemberSearchEnabled: false,
    openMemberSearchIncludesMinors: false,
  }),
}));

// #2285 (ADR-001 bed-allocation short-circuit): an exclusivity approval prunes
// the booking's per-bed rows via the flag-keyed lifecycle reconcile — a held
// conversion preserves pre-assigned beds (#1254), which is wrong once the
// booking is whole-lodge-held. Mocked here; the prune semantics themselves are
// covered by bed-allocation-lifecycle.test.ts.
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: vi.fn().mockResolvedValue({
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
  sendAdminWholeLodgeManualInvoiceEmail,
  sendAdminOwnerSubstitutionAlert,
  sendBookingConfirmedEmail,
} from "@/lib/email";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
  findOverlappingCapacityHoldingBookings,
} from "@/lib/capacity";
import { createAuditLog, logAudit } from "@/lib/audit";
import {
  reconcileBedAllocationsForBookingWithLodgeLockHeld as reconcileBedAllocationsForBooking,
} from "@/lib/bed-allocation-lifecycle";
import { getDefaultLodgeCapacity, getLodgeCapacity } from "@/lib/lodge-capacity";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import {
  enqueueXeroAppliedCreditAllocationOperation,
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { requiresAdultSupervisionReview } from "@/lib/booking-review";
import { BookingRequestError } from "@/lib/booking-request";
import {
  assertNoBookingMemberNightConflicts,
  BookingMemberNightConflictError,
} from "@/lib/booking-member-night-conflicts";
import {
  approveMemberWholeLodgeRequest,
  approveSchoolBookingRequest,
  createSchoolBookingRequest,
  generateSchoolGuests,
} from "@/lib/school-booking-request";
// #2739: the night rows this pipeline writes are the #1036 locked prices the
// #2337 member link then prices against, so the join is asserted here with the
// real reader and the real engine rather than described in a comment.
import { lockedNightPricesForGuest } from "@/lib/booking-modify-plan";
import { calculateBookingPrice } from "@/lib/policies/pricing";

import { sendMemberGuestAddNotifications } from "@/lib/member-guest-consent-notifications";
import {
  fenceMemberFindMany,
  recordingBookingDouble,
} from "@/lib/__tests__/support/hosting-participant-fence-double";

const mockedMemberGuestAddNotifications = vi.mocked(
  sendMemberGuestAddNotifications,
);
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
const mockedSendWholeLodgeManualInvoice = vi.mocked(
  sendAdminWholeLodgeManualInvoiceEmail,
);
const mockedEnqueueCreditAllocation = vi.mocked(
  enqueueXeroAppliedCreditAllocationOperation,
);
const mockedKickOutbox = vi.mocked(kickQueuedXeroOutboxOperationsIfConnected);
const mockedSendOwnerSubstitution = vi.mocked(sendAdminOwnerSubstitutionAlert);
const mockedAssertNoConflicts = vi.mocked(assertNoBookingMemberNightConflicts);
const mockedLogAudit = vi.mocked(logAudit);

/*
 * The #2619 hosting participant fence.
 *
 * Every approval path reconciles the hosting review inside its own transaction,
 * and that reconciliation locks the source booking's owner Member row
 * `FOR KEY SHARE NOWAIT` before re-reading, UNDER the lock, both the Member rows
 * and each source booking's owner and lodge. The approval PLANS its participants
 * from `booking.findUnique`, so the same transaction's `booking.findMany` has to
 * replay exactly what that read served or the fence sees drift that never
 * happened. `recordingBookingDouble` does the replay, which is why a test states
 * the booking a transaction serves through `serveBooking` instead of re-stubbing
 * `prisma.booking.findUnique`: re-stubbing would replace the recording wrapper
 * and the fence would find no source booking at all.
 *
 * The default is `null` — the "booking not found" branch the mocked client
 * documents above, which writes nothing. It is re-armed per test, because
 * `vi.clearAllMocks()` clears CALLS but not implementations and a booking row
 * left behind by an earlier test is a database state that never existed.
 */
let servedBooking: (args: unknown) => unknown = async () => null;

/** State the booking row this test's transaction serves, or a per-query function. */
function serveBooking(row: unknown | ((args: unknown) => unknown)): void {
  servedBooking =
    typeof row === "function"
      ? (row as (args: unknown) => unknown)
      : async () => row;
}

/**
 * A `member.findMany` that answers the fence's ids-only re-read itself and hands
 * every other query to `existing`, so adding it cannot change what a test that
 * stubs the delegate for its own reasons already asserts.
 */
function armMemberFindMany(existing?: (args: unknown) => unknown): void {
  const findMany = fenceMemberFindMany([], existing);
  vi.mocked(prisma.member.findMany).mockImplementation((async (args: unknown) =>
    findMany(args as never)) as never);
}

/** Wire both fence reads onto the shared prisma double for one test. */
function armParticipantFence(): void {
  servedBooking = async () => null;
  const fenceBooking = recordingBookingDouble((args) => servedBooking(args));
  vi.mocked(prisma.booking.findUnique).mockImplementation((async (
    args: unknown,
  ) => fenceBooking.findUnique(args)) as never);
  vi.mocked(prisma.booking.findMany).mockImplementation((async (args: unknown) =>
    fenceBooking.findMany(args)) as never);
  armMemberFindMany();
}

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

// #2338: a season carrying BOTH the per-guest rate rows (so priceSchoolGuests,
// which always runs, does not throw) AND the flat whole-lodge night rate. The
// mocked prisma.season.findMany serves both the per-guest lookup and the
// flat-rate lookup inside approveMemberWholeLodgeRequest.
function seasonWithFlatRate(flatWholeLodgeNightCents: number | null) {
  return [
    {
      id: "season-1",
      startDate: new Date("2026-07-01T00:00:00.000Z"),
      endDate: new Date("2026-09-01T00:00:00.000Z"),
      type: "WINTER",
      flatWholeLodgeNightCents,
      membershipTypeRates: [
        { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 5000 },
        { membershipTypeId: "type-nonmember", ageTier: "CHILD", pricePerNightCents: 2500 },
      ],
    },
  ];
}

/**
 * Arm the doubles the #2364 hosting reconciliation reads: a club-wide
 * ADMIN_REVIEW_REQUIRED policy, and the created booking read back with the
 * all-non-member party it just wrote.
 */
function armHostingPolicy(bookingId: string, memberId: string) {
  vi.mocked(prisma.adultMemberHostingPolicy.findMany).mockResolvedValue([
    {
      id: "policy-club",
      scopeKey: "club-wide",
      lodgeId: null,
      mode: "ADMIN_REVIEW_REQUIRED",
      capacityMode: "NO_HOLD",
      version: 2,
    },
  ] as never);
  serveBooking({
    id: bookingId,
    memberId,
    parentBookingId: null,
    lodgeId: "lodge-1",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
    adultMemberHostingReview: null,
    adultMemberHostingReviewStatus: null,
    guests: [
      {
        id: "guest-1",
        firstName: "School",
        lastName: "Child 1",
        stayStart: new Date("2026-08-01T00:00:00.000Z"),
        stayEnd: new Date("2026-08-03T00:00:00.000Z"),
        consentStatus: null,
        nights: [
          { stayDate: new Date("2026-08-01T00:00:00.000Z") },
          { stayDate: new Date("2026-08-02T00:00:00.000Z") },
        ],
        member: null,
      },
    ],
  });
}

/** The `booking.update` this reconciliation wrote, or a failure if it did not. */
function hostingWriteData(): Record<string, unknown> {
  const call = vi
    .mocked(prisma.booking.update)
    .mock.calls.find(
      (entry) =>
        (entry[0].data as Record<string, unknown>)
          .adultMemberHostingReviewStatus !== undefined,
    );
  expect(call).toBeDefined();
  return call![0].data as Record<string, unknown>;
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
    armParticipantFence();
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

  it("tells a teacher linked to a real member account that they are on the booking (MG4-D-b)", async () => {
    // THE NO-HOLD CREATE, which is the school pipeline's own third write point
    // and the one the issue body never listed. A school request routinely
    // carries teacher rows an officer linked to real member accounts at pricing
    // time; before MG4 they landed on the converted booking with no consent
    // record and no word to the member, who then held a person-night on a
    // stranger's booking without knowing it.
    mockedFindUnique.mockResolvedValue(
      schoolRequest({
        // The officer linked the FIRST guest row — the teacher — to a member.
        linkedGuestMembers: [{ guestIndex: 0, memberId: "m-tana" }],
      }) as never,
    );
    armMemberFindMany(async () => [
      {
        id: "m-tana",
        firstName: "Tana",
        lastName: "Teacher",
        ageTier: "ADULT",
        active: true,
        canLogin: true,
        archivedAt: null,
      },
    ]);
    // The create selects its guest rows back, which is how the pipeline matches
    // its notification plan to ids that only exist after the write.
    vi.mocked(prisma.booking.create).mockResolvedValue({
      id: "booking-1",
      guests: [
        { id: "bg-1", memberId: "m-tana" },
        { id: "bg-2", memberId: null },
        { id: "bg-3", memberId: null },
      ],
    } as never);

    await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    // The row carries a consent record naming the approving officer...
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0]
      .data as { guests: { create: Array<Record<string, unknown>> } };
    expect(
      bookingArgs.guests.create.find((row) => row.memberId === "m-tana"),
    ).toMatchObject({
      consentStatus: "CONFIRMED",
      consentRespondedByMemberId: "admin-1",
    });
    // ...and the member is actually told, with the pipeline's own wording.
    expect(mockedMemberGuestAddNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        actor: { kind: "BOOKING_REQUEST", adminMemberId: "admin-1" },
      }),
    );
    const [call] = mockedMemberGuestAddNotifications.mock.calls;
    expect(call[0].rows).toEqual([
      expect.objectContaining({
        bookingGuestId: "bg-1",
        targetMemberId: "m-tana",
        notification: "ADDED_NOTICE",
      }),
    ]);
  });

  it("gives every school guest their canonical night set (#2739)", async () => {
    // A school party is the sharpest form of the defect: thirty children on a
    // confirmed booking, none of them on the bed-allocation board, discovered
    // when the bus arrives.
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);

    await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as {
      guests: { create: Array<Record<string, unknown>> };
    };
    const guestCreates = bookingArgs.guests.create;
    expect(guestCreates).toHaveLength(3);
    for (const guest of guestCreates) {
      const nights = (guest.nights as { create: Array<{ stayDate: Date; priceCents: number }> })
        .create;
      // Two nights for 1 Aug → 3 Aug. Not three — the check-out morning is a
      // departure, not a night (INV-DATE-003).
      expect(nights.map((night) => night.stayDate)).toEqual([CHECK_IN, new Date("2026-08-02T00:00:00.000Z")]);
      // Money does not move: the split is exact against the guest's own share of
      // the officer's total.
      expect(nights.reduce((sum, night) => sum + night.priceCents, 0)).toBe(
        guest.priceCents,
      );
    }
  });

  it("stores the engine's REAL per-night rates across a season boundary, not a flat re-split (#2739)", async () => {
    /*
      The night rows are what the finance revenue reconciliation sums inside a
      DATE WINDOW, and what a later edit re-uses as #1036 locked prices. So when
      the engine priced this guest — which is every school approval an officer
      did not hand a flat total — the rows must carry the rates it really
      resolved, exactly as the canonical direct-create writer stores
      `priced.perNightCents[k]`.

      Two seasons, one boundary inside a two-night stay: 1 Aug at $50, 2 Aug at
      $80. An even split of the guest's $130 would write 6500/6500 — the right
      TOTAL against the wrong nights, which misattributes revenue between the
      two periods by $15 a guest and would lock a later edit to prices nobody
      ever charged.
    */
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);
    mockedSeasonFindMany.mockResolvedValue([
      {
        id: "season-early",
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        endDate: new Date("2026-08-01T00:00:00.000Z"),
        type: "WINTER",
        membershipTypeRates: [
          { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 5000 },
          { membershipTypeId: "type-nonmember", ageTier: "CHILD", pricePerNightCents: 2500 },
        ],
      },
      {
        id: "season-late",
        startDate: new Date("2026-08-02T00:00:00.000Z"),
        endDate: new Date("2026-09-01T00:00:00.000Z"),
        type: "WINTER",
        membershipTypeRates: [
          { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 8000 },
          { membershipTypeId: "type-nonmember", ageTier: "CHILD", pricePerNightCents: 4000 },
        ],
      },
    ] as never);

    await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as {
      guests: { create: Array<Record<string, unknown>> };
    };
    const nightsFor = (index: number) =>
      (
        bookingArgs.guests.create[index].nights as {
          create: Array<{ stayDate: Date; priceCents: number }>;
        }
      ).create.map((night) => night.priceCents);

    // The ADULT teacher, then the two CHILD students — each at their own tier's
    // rate for each night's own season.
    expect(nightsFor(0)).toEqual([5000, 8000]);
    expect(nightsFor(1)).toEqual([2500, 4000]);
    expect(nightsFor(2)).toEqual([2500, 4000]);
    // And each guest's rows still reconcile to their stored price exactly.
    for (let index = 0; index < 3; index += 1) {
      expect(nightsFor(index).reduce((sum, cents) => sum + cents, 0)).toBe(
        bookingArgs.guests.create[index].priceCents,
      );
    }
  });

  it("falls back to the even split when the officer set the total, which has no per-night truth (#2739)", async () => {
    // An officer's negotiated figure is a total, not a rate — #1098's own reason
    // for skipping these bookings. There is nothing per-night to store, so the
    // share is divided evenly, which is deliberately the vector
    // `evenlySplitCents` already synthesises for a night-less guest in Xero line
    // building. Season rates vary underneath and are deliberately ignored.
    mockedFindUnique.mockResolvedValue(
      schoolRequest({ priceCents: 30003 }) as never,
    );
    mockedSeasonFindMany.mockResolvedValue([
      {
        id: "season-early",
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        endDate: new Date("2026-08-01T00:00:00.000Z"),
        type: "WINTER",
        membershipTypeRates: [
          { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 5000 },
          { membershipTypeId: "type-nonmember", ageTier: "CHILD", pricePerNightCents: 2500 },
        ],
      },
      {
        id: "season-late",
        startDate: new Date("2026-08-02T00:00:00.000Z"),
        endDate: new Date("2026-09-01T00:00:00.000Z"),
        type: "WINTER",
        membershipTypeRates: [
          { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 8000 },
          { membershipTypeId: "type-nonmember", ageTier: "CHILD", pricePerNightCents: 4000 },
        ],
      },
    ] as never);

    await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as {
      guests: { create: Array<Record<string, unknown>> };
    };
    // 30003c over three guests is 10001/10001/10001; each guest's 10001 over two
    // nights is 5001/5000 — the extra cent on the EARLIEST night.
    for (const guest of bookingArgs.guests.create) {
      const nights = (guest.nights as { create: Array<{ priceCents: number }> }).create;
      expect(nights.map((night) => night.priceCents)).toEqual([5001, 5000]);
      expect(guest.priceCents).toBe(10001);
    }
  });

  it("tells nobody on an ordinary school request with no linked members", async () => {
    // Every guest a free-text name. Nothing is planned, so the dispatcher is
    // never even imported — the state of nearly every school approval.
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);

    await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(mockedMemberGuestAddNotifications).not.toHaveBeenCalled();
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

  it("records the adult-member hosting review on the approved school booking (#2364)", async () => {
    // A school party is every non-member guest and no member participant, so at
    // a club running the rule it always carries uncovered guest-nights. It used
    // to commit with all five hosting columns NULL, invisible to the policy at
    // approval time and then flagged out of nowhere by an unrelated later edit.
    mockedFindUnique.mockResolvedValue(schoolRequest() as never);
    armHostingPolicy("booking-1", "school-member");

    await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    const data = hostingWriteData();
    expect(data.adultMemberHostingReviewStatus).toBe("PENDING");
    // Approving the REQUEST is not the reasoned acceptance D-R4 demands.
    expect(data.adultMemberHostingReviewReason).toBeNull();
    expect(data.adultMemberHostingReviewedById).toBeNull();
  });

  it("takes global then lodge locks for a fresh-create approval and re-reads the request under the locks (#1881)", async () => {
    const order: string[] = [];
    let requestReads = 0;
    mockedFindUnique.mockImplementation((async () => {
      requestReads += 1;
      order.push(requestReads === 1 ? "outer-request" : `locked-request-${requestReads}`);
      return schoolRequest() as never;
    }) as never);
    vi.mocked(prisma.$executeRaw).mockImplementation((async () => {
      order.push("global-lock");
      return 1 as never;
    }) as never);
    mockedAcquireLodgeLock.mockImplementation(async () => {
      order.push("lodge-lock");
    });

    await approveSchoolBookingRequest({
      requestId: "req-school",
      adminMemberId: "admin-1",
    });

    expect(order.indexOf("global-lock")).toBeGreaterThan(
      order.indexOf("outer-request")
    );
    expect(order.indexOf("lodge-lock")).toBeGreaterThan(
      order.indexOf("global-lock")
    );
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
    serveBooking(async () => {
      heldReads += 1;
      if (heldReads === 1) {
        order.push("held-lodge-locator");
        return { lodgeId: "lodge-1" };
      }
      order.push("held-reread");
      return {
        id: "held-1",
        lodgeId: "lodge-1",
        memberId: "school-owner",
        status: BookingStatus.AWAITING_REVIEW,
      };
    });
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
    serveBooking({ lodgeId: "lodge-1" });

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
    // #2926: the row carries its own provenance, and this is the ONLY writer
    // that stamps SCHOOL_BOOKING. It is what takes teacher rows out of the
    // hut-leader overlap predicate, so losing it here silently restores the
    // asymmetry where a school group blocks every later manual assignment for
    // those nights. Nothing derives this from the teacher Member, deliberately:
    // `Member.role` is admin-writable and a membership edit must never move a
    // live assignment out of the predicate.
    expect(hutLeaderArgs.source).toBe("SCHOOL_BOOKING");
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
    serveBooking({ lodgeId: "lodge-1" });

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
    serveBooking({
      id: "held-1",
      lodgeId: "lodge-1",
      memberId: "held-invalid-school",
      status: BookingStatus.AWAITING_REVIEW,
    });
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
    vi.mocked(prisma.bookingGuest.create).mockResolvedValue({
      id: "recreated-guest",
      memberId: null,
    } as never);
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
    serveBooking({
      id: "held-1",
      lodgeId: "lodge-1",
      memberId: "held-school-owner",
      status: BookingStatus.AWAITING_REVIEW,
    });
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
    serveBooking({
      id: "held-1",
      lodgeId: "lodge-1",
      memberId: "held-school-owner",
      status: BookingStatus.AWAITING_REVIEW,
    });
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-school-owner",
      canLogin: false,
      role: "SCHOOL",
      archivedAt: null,
      active: true,
    } as never);
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.bookingGuest.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.bookingGuest.create).mockResolvedValue({
      id: "recreated-guest",
      memberId: null,
    } as never);
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
    serveBooking({
      id: "held-1",
      lodgeId: "lodge-old",
      memberId: "held-school-owner",
      status: BookingStatus.AWAITING_REVIEW,
    });
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-school-owner",
      canLogin: false,
      role: "SCHOOL",
      archivedAt: null,
      active: true,
    } as never);
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.bookingGuest.deleteMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.bookingGuest.create).mockResolvedValue({
      id: "recreated-guest",
      memberId: null,
    } as never);
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

// ---------------------------------------------------------------------------
// Member whole-lodge approval (#2263, epic #2245)
// ---------------------------------------------------------------------------

function memberWholeLodgeRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "req-member",
    // A member request is type GENERAL — the discriminator is the member id,
    // NOT the type. Everything downstream has to key on the right column.
    type: BookingRequestType.GENERAL,
    status: BookingRequestStatus.VERIFIED,
    exclusivityRequested: true,
    requestedByMemberId: "member-9",
    schoolName: null,
    teachers: null,
    contactFirstName: "Ada",
    contactLastName: "Lovelace",
    contactEmail: "ada@example.com",
    contactPhone: null,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    guests: [
      { firstName: "Guest", lastName: "1", ageTier: "ADULT" },
      { firstName: "Guest", lastName: "2", ageTier: "ADULT" },
      { firstName: "Guest", lastName: "3", ageTier: "ADULT" },
    ],
    message: "Club alpine skills course",
    indicativePriceCents: null,
    priceCents: null,
    lodgeId: null,
    heldBookingId: null,
    convertedBookingId: null,
    convertedMemberId: null,
    linkedGuestMembers: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    version: 0,
    ...overrides,
  };
}

describe("approveMemberWholeLodgeRequest (#2263)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armParticipantFence();
    mockedTransaction.mockImplementation(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)
    );
    mockedFindUnique.mockResolvedValue(memberWholeLodgeRequest() as never);
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedCheckCapacity.mockResolvedValue({
      available: true,
      minAvailable: 30,
      nightDetails: [],
    } as never);
    mockedSeasonFindMany.mockResolvedValue(seasonWithRates() as never);
    mockedGroupDiscount.mockResolvedValue(null as never);
    // clearAllMocks clears CALLS but keeps implementations, so the
    // capacity-refusal case below would otherwise leak its capacity-of-4 stub
    // into every test declared after it.
    vi.mocked(getLodgeCapacity).mockResolvedValue(40 as never);
    vi.mocked(getDefaultLodgeCapacity).mockResolvedValue(40 as never);
    mockedModuleEnabled.mockResolvedValue(true as never);
    serveBooking(null);
    vi.mocked(prisma.lodge.findFirst).mockResolvedValue({ id: "lodge-1" } as never);
    // The owner is the requesting LOGIN member — looked up, never created. The
    // post-commit confirmation also reads their LIVE email/first name here, so
    // the stub carries both and they deliberately DIFFER from the request-time
    // snapshot (see the "live account email" test).
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "member-9",
      active: true,
      email: "member.new@example.test",
      firstName: "Mina",
    } as never);
    vi.mocked(prisma.booking.create).mockResolvedValue({ id: "booking-wl" } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);
    mockedAssertNoConflicts.mockResolvedValue(undefined as never);
    vi.mocked(findOverlappingCapacityHoldingBookings).mockResolvedValue([] as never);
  });

  it("creates a CONFIRMED booking owned by the requesting member, holding the whole lodge", async () => {
    const result = await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    expect(result.type).toBe("approved");

    const data = vi.mocked(prisma.booking.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    // CONFIRMED is capacity-holding in its own right, so the hold does not
    // depend on the PENDING originBookingRequest clause (school parity).
    expect(data.status).toBe(BookingStatus.CONFIRMED);
    // The owner is the member's OWN login account. No non-login member is
    // minted — doing so would split a real person's booking history in two.
    expect(data.memberId).toBe("member-9");
    expect(prisma.member.create).not.toHaveBeenCalled();
    // ADR-001: granting exclusivity is the ADMIN's capacity action, stamped
    // with the approving admin, not the requester.
    expect(data.wholeLodgeHold).toBe(true);
    expect(data.wholeLodgeHoldByMemberId).toBe("admin-1");
    expect(data.wholeLodgeHoldAt).toBeInstanceOf(Date);
  });

  it("records the adult-member hosting review, because ownership never proves attendance (#2364)", async () => {
    // The requesting member OWNS this booking but is not a guest row on it, and
    // its placeholder guests are NON_MEMBER-rated (OD-A) — so at a club running
    // the rule nobody on the party can host, which is a real thing for an admin
    // to look at. It never blocks the approval, and it clears itself the moment
    // the member puts themselves or another adult member on the guest list.
    armHostingPolicy("booking-wl", "member-9");

    await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    const data = hostingWriteData();
    expect(data.adultMemberHostingReviewStatus).toBe("PENDING");
    expect(data.adultMemberHostingReviewedById).toBeNull();
  });

  it("prices the placeholder guests at NON-MEMBER rates and marks the booking hasNonMembers (OD-A)", async () => {
    await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    const data = vi.mocked(prisma.booking.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    // Owner decision OD-A: unnamed, unlinked placeholder guests are the
    // conservative revenue default — 3 ADULTs x 2 nights x $50 non-member.
    expect(data.totalPriceCents).toBe(30000);
    expect(data.finalPriceCents).toBe(30000);
    expect(data.hasNonMembers).toBe(true);
  });

  it("gives every placeholder their canonical night set, at the engine's own rates (#2739)", async () => {
    /*
      The FOURTH write point, and the one the issue did not name. This create
      handed `guestCreates` to Prisma raw, so a member whole-lodge booking's
      placeholders were created with no BookingGuestNight rows at all — a
      CONFIRMED booking holding the entire lodge with nobody on the bed board
      (INV-CAP-032). Revert the `.map(toPipelineGuestCreateData)` at
      `school-booking-request.ts` and this test is the one that goes red;
      everything else in this block passes either way.
    */
    await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    const data = vi.mocked(prisma.booking.create).mock.calls[0][0].data as {
      guests: { create: Array<Record<string, unknown>> };
    };
    expect(data.guests.create).toHaveLength(3);
    for (const guest of data.guests.create) {
      const nights = (
        guest.nights as { create: Array<{ stayDate: Date; priceCents: number }> }
      ).create;
      // Two nights for 1 Aug → 3 Aug; the check-out morning is a departure, not
      // a night anybody holds a bed for (INV-DATE-003).
      expect(nights.map((night) => night.stayDate)).toEqual([
        CHECK_IN,
        new Date("2026-08-02T00:00:00.000Z"),
      ]);
      // The engine priced these placeholders, so the rows carry its resolved
      // non-member rate per night — and still reconcile to the stored price.
      expect(nights.map((night) => night.priceCents)).toEqual([5000, 5000]);
      expect(nights.reduce((sum, night) => sum + night.priceCents, 0)).toBe(
        guest.priceCents,
      );
    }
  });

  it("keeps an unlinked placeholder's negotiated price when another is linked to a member (#2739, #2337)", async () => {
    /*
      A DECLARED CONSEQUENCE, pinned so it cannot drift back silently.

      The #2337 placeholder→member link is the ONE edit path exempt from the
      quote-priced block, and it reprices the whole booking. `prepareGuestPlan`
      passes `link ? [] : lockedNightPricesForGuest(guest)`, so an UNLINKED
      placeholder is protected only by its stored night rows. While this pipeline
      wrote none, those rows were empty, every unlinked placeholder repriced at
      whatever the season rate is on the day of the link, and the negotiated
      whole-lodge basis the block exists to protect was silently replaced —
      exactly the #1032 harm, leaking through the exemption.

      Now the approval writes them, so the negotiated price holds.

      BOTH SIDES OF THE CHANGE ARE ASSERTED HERE, not just the new one, because
      this is a money behaviour change put to the owner and the size and the
      DIRECTION of it are what they are being asked about. The same unlinked
      placeholder is priced twice against the same moved season rate: once with
      the empty lock set the pipeline used to leave behind (the old total), and
      once with the rows it now writes (the new total). The rate is moved UP in
      one case and DOWN in the other, because the old behaviour did not always
      overcharge — when rates had fallen it undercharged, and the change takes
      that back too.
    */
    await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    const data = vi.mocked(prisma.booking.create).mock.calls[0][0].data as {
      guests: { create: Array<Record<string, unknown>> };
    };
    const storedNights = (
      data.guests.create[0].nights as {
        create: Array<{
          stayDate: Date;
          priceCents: number;
          priceSource: BookingGuestNightPriceSource;
        }>;
      }
    ).create;

    // AFTER: the rows this pipeline now writes, read by the real lock reader.
    const locks = lockedNightPricesForGuest({ nights: storedNights });
    expect(locks).toHaveLength(2);
    // BEFORE: what the same reader returned while the pipeline wrote no rows at
    // all. Not a stand-in — a night-less guest is exactly what it was handed.
    const noLocks = lockedNightPricesForGuest({ nights: [] });
    expect(noLocks).toEqual([]);

    /** What the #2337 link charges this untouched placeholder, at `rateCents`. */
    const priceUnlinkedPlaceholderAt = (
      rateCents: number,
      lockedNightPrices: Array<{
        stayDate: Date;
        priceCents: number;
        priceSource: BookingGuestNightPriceSource;
      }>,
    ) =>
      calculateBookingPrice(
        CHECK_IN,
        CHECK_OUT,
        [
          {
            ageTier: "ADULT",
            isMember: false,
            rateMembershipTypeId: "type-nonmember",
            rateSource: "NON_MEMBER_DEFAULT" as const,
            lockedNightPrices,
          },
        ],
        [
          {
            seasonId: "season-1",
            startDate: new Date("2026-07-01T00:00:00.000Z"),
            endDate: new Date("2026-09-01T00:00:00.000Z"),
            rates: [
              {
                ageTier: "ADULT",
                membershipTypeId: "type-nonmember",
                pricePerNightCents: rateCents,
              },
            ],
          },
        ],
      ).guests[0].priceCents;

    // The club put its rates UP to $99 a night after the quote was agreed.
    // Old: the placeholder nobody touched was re-priced to $198. New: the
    // negotiated $100 stands, so this member is charged $98 LESS than before.
    expect(priceUnlinkedPlaceholderAt(9900, noLocks)).toBe(19800);
    expect(priceUnlinkedPlaceholderAt(9900, locks)).toBe(10000);

    // And the other direction, which is the half a reader assumes away: rates
    // fell to $30. Old: the same untouched placeholder dropped to $60. New: the
    // negotiated $100 stands, so this member is charged $40 MORE than before.
    // The change protects the price that was AGREED, not the cheaper one.
    expect(priceUnlinkedPlaceholderAt(3000, noLocks)).toBe(6000);
    expect(priceUnlinkedPlaceholderAt(3000, locks)).toBe(10000);
  });

  it("stamps NO nonMemberHoldUntil on the confirmed whole-lodge booking", async () => {
    await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    const data = vi.mocked(prisma.booking.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    /*
      The hold clock belongs to the PENDING non-member path — it is what the
      confirm-pending bump cron reads. Stamping a deadline onto a CONFIRMED
      booking that holds the WHOLE LODGE would arm a bump clock against the one
      booking that must never be bumped, and would be the first regression to
      appear if that cron's PENDING guard were ever relaxed. School parity: a
      school booking is hasNonMembers with no hold clock either.
    */
    expect(data).not.toHaveProperty("nonMemberHoldUntil");
  });

  it("creates a PENDING internet-banking payment and NO payment link or token email", async () => {
    await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    const payment = vi.mocked(prisma.payment.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(payment.status).toBe(PaymentStatus.PENDING);
    expect(payment.source).toBe(PaymentSource.INTERNET_BANKING);
    expect(payment.amountCents).toBe(30000);

    // The tokenised payment-link flow is the GENERAL NON-LOGIN approval path.
    // Emailing a signed-in member an anonymous payment token would be handing
    // out a bearer credential to somebody who already has an account. The
    // delegate IS mocked, so this fails the day the code starts minting one.
    expect(prisma.paymentLink.create).not.toHaveBeenCalled();
  });

  it("prices from the admin override when one is given, split in integer cents", async () => {
    await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
      override: { priceOverrideCents: 100_001 },
    });

    const data = vi.mocked(prisma.booking.create).mock.calls[0][0].data as {
      totalPriceCents: number;
      guests: { create: Array<{ priceCents: number }> };
    };
    expect(data.totalPriceCents).toBe(100_001);
    // splitPriceAcrossGuests puts the remainder on the first guest so the rows
    // sum EXACTLY to the total — no cent is invented or lost.
    const perGuest = data.guests.create.map((guest) => guest.priceCents);
    expect(perGuest.reduce((sum, cents) => sum + cents, 0)).toBe(100_001);
    expect(perGuest).toEqual([33335, 33333, 33333]);
  });

  it("books and prices the officer-confirmed headcount, not the member's estimate", async () => {
    await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
      override: { pricedHeadcount: 5 },
    });

    const data = vi.mocked(prisma.booking.create).mock.calls[0][0].data as {
      totalPriceCents: number;
      guests: { create: unknown[] };
    };
    expect(data.guests.create).toHaveLength(5);
    expect(data.totalPriceCents).toBe(50000);

    // The request snapshot is rewritten to match what was actually booked, so
    // the queue and the booking cannot disagree about the party size.
    const requestUpdate = vi.mocked(prisma.bookingRequest.update).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(requestUpdate.status).toBe(BookingRequestStatus.CONVERTED);
    expect((requestUpdate.guests as unknown[]).length).toBe(5);
  });

  it("refuses a headcount above the lodge capacity before any write", async () => {
    vi.mocked(getLodgeCapacity).mockResolvedValue(4 as never);
    vi.mocked(getDefaultLodgeCapacity).mockResolvedValue(4 as never);

    await expect(
      approveMemberWholeLodgeRequest({
        requestId: "req-member",
        adminMemberId: "admin-1",
        override: { pricedHeadcount: 5 },
      })
    ).rejects.toMatchObject({ status: 422 });

    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it("409s with the set-a-price message when no season covers the dates and no override is given", async () => {
    mockedSeasonFindMany.mockResolvedValue([] as never);

    await expect(
      approveMemberWholeLodgeRequest({
        requestId: "req-member",
        adminMemberId: "admin-1",
      })
    ).rejects.toMatchObject({ status: 409 });

    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it("approves out-of-season dates when the officer supplies the price override", async () => {
    // The mandatory fallback: there is no quote or officer-price op on this
    // path (both are service-refused), so without the override an out-of-season
    // whole-lodge request would be a dead end.
    mockedSeasonFindMany.mockResolvedValue([] as never);

    const result = await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
      override: { priceOverrideCents: 75000 },
    });

    expect(result).toMatchObject({ type: "approved", priceCents: 75000 });
  });

  it("returns capacityExceeded rather than admitting the booking over capacity", async () => {
    mockedCheckCapacity.mockResolvedValue({
      available: false,
      minAvailable: -2,
      nightDetails: [
        { date: new Date("2026-08-01T00:00:00.000Z"), availableBeds: -2 },
      ],
    } as never);

    const result = await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    // ADR-001 decision 1 governs what happens to OTHER bookings on the held
    // nights (nothing). It does not license admitting THIS one over capacity.
    expect(result).toEqual({
      type: "capacityExceeded",
      fullNights: ["2026-08-01"],
    });
  });

  it("takes the per-lodge capacity lock before creating the booking", async () => {
    await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    expect(mockedAcquireLodgeLock).toHaveBeenCalled();
    expect(mockedAcquireLodgeLock.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(prisma.booking.create).mock.invocationCallOrder[0]
    );
  });

  it("runs the ADR-001 bed-allocation reconcile so a held booking can own no per-bed rows (#2285 parity)", async () => {
    await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    expect(reconcileBedAllocationsForBooking).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-wl" })
    );
  });

  it("audits the prune with its removed allocations when the reconcile actually deleted rows", async () => {
    vi.mocked(prisma.bedAllocation.findMany).mockResolvedValue([
      {
        bookingGuestId: "guest-1",
        roomId: "room-1",
        bedId: "bed-1",
        stayDate: new Date("2026-08-01T00:00:00.000Z"),
        source: "ADMIN",
        approvedAt: null,
      },
    ] as never);
    vi.mocked(reconcileBedAllocationsForBooking).mockResolvedValue({
      enabled: true,
      deletedCount: 1,
      createdCount: 0,
      promotedCount: 0,
    } as never);

    await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BED_ALLOCATION_HELD_BOOKING_PRUNED",
        metadata: expect.objectContaining({ issue: 2263, deletedCount: 1 }),
      }),
      expect.anything()
    );
  });

  it("surfaces overlapping bookings to the ADMIN caller after the commit, and never refuses", async () => {
    vi.mocked(findOverlappingCapacityHoldingBookings).mockResolvedValue([
      {
        id: "booking-other",
        memberName: "Someone Else",
        checkIn: "2026-08-01",
        checkOut: "2026-08-02",
        guestCount: 2,
        status: "CONFIRMED",
      },
    ] as never);

    const result = await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    // Informational, never a refusal (decision 1): the approval still succeeded.
    expect(result).toMatchObject({ type: "approved" });
    expect(
      result.type === "approved" ? result.exclusiveHoldConflicts : []
    ).toHaveLength(1);

    // Computed AFTER the commit, outside the advisory lock.
    expect(
      vi.mocked(findOverlappingCapacityHoldingBookings).mock
        .invocationCallOrder[0]
    ).toBeGreaterThan(
      vi.mocked(prisma.booking.create).mock.invocationCallOrder[0]
    );

    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.exclusiveHold.set",
        metadata: expect.objectContaining({
          source: "member_request_approval",
          overlappingConflictCount: 1,
        }),
      })
    );
  });

  it("emails the member a plain booking confirmation carrying nothing about occupancy", async () => {
    vi.mocked(findOverlappingCapacityHoldingBookings).mockResolvedValue([
      {
        id: "booking-other",
        memberName: "Someone Else",
        checkIn: "2026-08-01",
        checkOut: "2026-08-02",
        guestCount: 2,
        status: "CONFIRMED",
      },
    ] as never);

    await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    expect(sendBookingConfirmedEmail).toHaveBeenCalled();
    const args = vi.mocked(sendBookingConfirmedEmail).mock.calls[0];
    // Booking-scoped, so the per-booking "No emails" switch can withhold it;
    // the durable recipient identity also authorizes the booking detail link.
    expect(args[0]).toEqual({
      bookingId: "booking-wl",
      recipientMemberId: "member-9",
    });
    // A member is never told the lodge is exclusively held, and never told
    // whose booking overlaps (ADR-001 decision 6). Nothing in the serialised
    // arguments may mention either.
    const serialised = JSON.stringify(args);
    expect(serialised).not.toContain("booking-other");
    expect(serialised).not.toContain("Someone Else");
    expect(serialised.toLowerCase()).not.toContain("exclusiv");
    expect(serialised.toLowerCase()).not.toContain("wholelodge");
  });

  it("replays idempotently: a second approve returns the first booking and re-emails nobody", async () => {
    mockedFindUnique
      .mockResolvedValueOnce(memberWholeLodgeRequest() as never)
      // The locked re-read inside the transaction already shows the conversion.
      .mockResolvedValueOnce(
        memberWholeLodgeRequest({
          status: BookingRequestStatus.CONVERTED,
          convertedBookingId: "booking-wl",
          convertedMemberId: "member-9",
        }) as never
      )
      // claimAlreadyConvertedBookingRequest's own read.
      .mockResolvedValueOnce({
        convertedBookingId: "booking-wl",
        convertedMemberId: "member-9",
        status: BookingRequestStatus.CONVERTED,
      } as never);

    const result = await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    expect(result).toMatchObject({ type: "approved", bookingId: "booking-wl" });
    // No second booking, no second payment, and above all no second email.
    expect(prisma.booking.create).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(sendBookingConfirmedEmail).not.toHaveBeenCalled();
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.member_whole_lodge_approve_idempotent_replay",
      })
    );
  });

  it("refuses a request that is not member-origin", async () => {
    mockedFindUnique.mockResolvedValue(
      memberWholeLodgeRequest({ requestedByMemberId: null }) as never
    );

    await expect(
      approveMemberWholeLodgeRequest({
        requestId: "req-member",
        adminMemberId: "admin-1",
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a member request that somehow holds beds rather than silently taking an unimplemented branch", async () => {
    mockedFindUnique.mockResolvedValue(
      memberWholeLodgeRequest({ heldBookingId: "booking-held" }) as never
    );

    await expect(
      approveMemberWholeLodgeRequest({
        requestId: "req-member",
        adminMemberId: "admin-1",
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses to book for a member whose account is no longer active", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "member-9",
      active: false,
    } as never);

    await expect(
      approveMemberWholeLodgeRequest({
        requestId: "req-member",
        adminMemberId: "admin-1",
      })
    ).rejects.toMatchObject({ status: 409 });

    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it("409s a stale approval whose snapshot changed under it", async () => {
    mockedFindUnique
      .mockResolvedValueOnce(memberWholeLodgeRequest({ version: 0 }) as never)
      .mockResolvedValueOnce(memberWholeLodgeRequest({ version: 1 }) as never)
      .mockResolvedValueOnce(null as never);

    await expect(
      approveMemberWholeLodgeRequest({
        requestId: "req-member",
        adminMemberId: "admin-1",
      })
    ).rejects.toMatchObject({ status: 409 });

    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it("409s when a concurrent admin already claimed the request", async () => {
    mockedUpdateMany.mockResolvedValue({ count: 0 } as never);

    await expect(
      approveMemberWholeLodgeRequest({
        requestId: "req-member",
        adminMemberId: "admin-1",
      })
    ).rejects.toMatchObject({ status: 409 });

    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // The receivable is actually invoiced (#2263 review finding H4)
  // -------------------------------------------------------------------------
  // The approval mints a PENDING INTERNET_BANKING Payment. Before this, nothing
  // was ever raised against it: no Xero invoice, no admin nudge. A confirmed
  // booking with an uninvoiced receivable is money the club silently never
  // collects, and the member had been emailed "Payment has been processed".

  it("enqueues the Xero booking invoice AND the #1620 applied-credit allocation when the module is on", async () => {
    mockedModuleEnabled.mockResolvedValue(true as never);

    const result = await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    expect(mockedEnqueueInvoice).toHaveBeenCalledWith("booking-wl", {
      createdByMemberId: "admin-1",
    });
    // #1620 parity with the Internet Banking create path: the owner here is a
    // real member who may be carrying floating credit notes, so they must be
    // allocated against this invoice or the member is asked for the gross
    // amount while holding a credit balance.
    expect(mockedEnqueueCreditAllocation).toHaveBeenCalledWith("booking-wl", {
      createdByMemberId: "admin-1",
    });
    // Ordering matters: the allocation op must be enqueued AFTER the invoice op
    // so its older createdAt puts the invoice first through the outbox.
    expect(mockedEnqueueInvoice.mock.invocationCallOrder[0]).toBeLessThan(
      mockedEnqueueCreditAllocation.mock.invocationCallOrder[0],
    );
    expect(mockedKickOutbox).toHaveBeenCalledWith({ limit: 2 });
    // No manual-invoice nudge when Xero has it.
    expect(mockedSendWholeLodgeManualInvoice).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: "approved", invoiceMode: "xero" });
  });

  it("everything about the invoice happens AFTER the commit, never inside the transaction", async () => {
    mockedModuleEnabled.mockResolvedValue(true as never);

    await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    // A provider call inside a database transaction holds the capacity lock for
    // the length of a network round trip (docs/CONCURRENCY_AND_LOCKING.md).
    expect(mockedEnqueueInvoice.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(prisma.bookingRequest.update).mock.invocationCallOrder[0],
    );
  });

  it("fires the delivery-locked manual-invoice admin alert when the Xero module is off", async () => {
    mockedModuleEnabled.mockResolvedValue(false as never);

    const result = await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    expect(mockedEnqueueInvoice).not.toHaveBeenCalled();
    expect(mockedEnqueueCreditAllocation).not.toHaveBeenCalled();
    expect(mockedSendWholeLodgeManualInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        contactEmail: "ada@example.com",
        totalCents: 30000,
        guestCount: 3,
        // The officer must be told the SAME reference the member was given, or
        // the hand-written invoice cannot be reconciled against their payment.
        paymentReference: expect.any(String),
      }),
    );
    const alert = mockedSendWholeLodgeManualInvoice.mock.calls[0][0];
    const payment = vi.mocked(prisma.payment.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(alert.paymentReference).toBe(payment.reference);
    // It is the SCHOOL wording that must not be reused — the owner is a real
    // signed-in member, not a non-login school contact.
    expect(mockedSendManualInvoice).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: "approved", invoiceMode: "manual" });
  });

  it("raises no second invoice and no second alert on an idempotent replay", async () => {
    mockedModuleEnabled.mockResolvedValue(true as never);
    mockedFindUnique
      .mockResolvedValueOnce(memberWholeLodgeRequest() as never)
      .mockResolvedValueOnce(
        memberWholeLodgeRequest({
          status: BookingRequestStatus.CONVERTED,
          convertedBookingId: "booking-wl",
          convertedMemberId: "member-9",
        }) as never
      )
      .mockResolvedValueOnce({
        convertedBookingId: "booking-wl",
        convertedMemberId: "member-9",
        status: BookingRequestStatus.CONVERTED,
      } as never);

    const result = await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    // The double-charge guard (#1232) has to cover the INVOICE too, not just the
    // booking and payment rows: a second Xero invoice is a second demand for
    // money against one stay.
    expect(mockedEnqueueInvoice).not.toHaveBeenCalled();
    expect(mockedEnqueueCreditAllocation).not.toHaveBeenCalled();
    expect(mockedSendWholeLodgeManualInvoice).not.toHaveBeenCalled();
    // And it reports no mode rather than fabricating one it did not use.
    expect(result).toMatchObject({ type: "approved", invoiceMode: null });
  });

  // -------------------------------------------------------------------------
  // The member-facing copy is true (#2263 review finding H4b)
  // -------------------------------------------------------------------------

  it("tells the member the amount is OWING with the internet-banking reference, never that it was paid", async () => {
    mockedModuleEnabled.mockResolvedValue(true as never);

    await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    const args = vi.mocked(sendBookingConfirmedEmail).mock.calls[0];
    const options = args[7] as {
      paymentDue?: { reference: string; invoiceEmailed: boolean };
    };
    // Nothing has been paid: the confirmation MUST carry the payment-due shape,
    // which is what turns "Total Paid" into "Total Due" and replaces "Payment
    // has been processed successfully" with the amount owing.
    expect(options.paymentDue).toBeDefined();
    const payment = vi.mocked(prisma.payment.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    // There is no PaymentLink on this path, so the reference is the ONLY way the
    // member can pay — and it must be the reference on their own Payment row.
    expect(options.paymentDue!.reference).toBe(payment.reference);
    expect(options.paymentDue!.reference).toBeTruthy();
    // The Xero module is on, so an invoice really is being emailed.
    expect(options.paymentDue!.invoiceEmailed).toBe(true);
    // The total is still passed as the money figure.
    expect(args[6]).toBe(30000);
  });

  it("does not claim an invoice was emailed when the Xero module is off", async () => {
    mockedModuleEnabled.mockResolvedValue(false as never);

    await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    const options = vi.mocked(sendBookingConfirmedEmail).mock.calls[0][7] as {
      paymentDue?: { invoiceEmailed: boolean };
    };
    // With nothing raising invoices, promising one has been emailed is a lie the
    // member cannot act on. The copy says the club will send one instead — which
    // is exactly what the admin alert above asks an officer to do.
    expect(options.paymentDue?.invoiceEmailed).toBe(false);
  });

  it("emails the OWNER's live account address, not the request-time snapshot", async () => {
    await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    const args = vi.mocked(sendBookingConfirmedEmail).mock.calls[0];
    // The booking belongs to a live account. A snapshot taken when the request
    // was submitted can be months stale, and this message carries the payment
    // reference — sending it to an address the member no longer reads is the
    // same as not sending it.
    expect(args[1]).toBe("member.new@example.test");
    expect(args[1]).not.toBe("ada@example.com");
    expect(args[2]).toBe("Mina");
  });

  // -------------------------------------------------------------------------
  // The replay reports COMMITTED figures (#2263 review finding M4)
  // -------------------------------------------------------------------------

  it("replays a SECOND approve of an already-CONVERTED row instead of 409ing it (the real HTTP shape)", async () => {
    /*
      This is what an officer double-clicking Approve actually sends: by the time
      the second request arrives the row is CONVERTED, so the FIRST read the
      service does already sees CONVERTED. The other replay tests in this file
      stub the first read as VERIFIED and therefore only exercise the under-lock
      idempotency claim — which a Playwright run proved was unreachable, because
      the pre-lock status guard rejected CONVERTED before the transaction and the
      route answered 409 "Only open member whole-lodge requests can be approved".
      No second booking was ever created either way, but the documented replay was
      dead code. This test is the one that fails if that regresses.
    */
    mockedFindUnique.mockResolvedValue(
      memberWholeLodgeRequest({
        status: BookingRequestStatus.CONVERTED,
        convertedBookingId: "booking-wl",
        convertedMemberId: "member-9",
      }) as never
    );
    serveBooking({
      finalPriceCents: 30000,
      _count: { guests: 6 },
    });

    const result = await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
    });

    expect(result).toMatchObject({
      type: "approved",
      bookingId: "booking-wl",
      memberId: "member-9",
      priceCents: 30000,
      guestCount: 6,
      invoiceMode: null,
    });
    // Nothing was written, priced, locked, invoiced or emailed a second time.
    expect(mockedTransaction).not.toHaveBeenCalled();
    expect(mockedAcquireLodgeLock).not.toHaveBeenCalled();
    expect(prisma.booking.create).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(mockedEnqueueInvoice).not.toHaveBeenCalled();
    expect(sendBookingConfirmedEmail).not.toHaveBeenCalled();
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.member_whole_lodge_approve_idempotent_replay",
      })
    );
  });

  it("refuses a CONVERTED row that has no booking rather than replaying a phantom", async () => {
    mockedFindUnique.mockResolvedValue(
      memberWholeLodgeRequest({
        status: BookingRequestStatus.CONVERTED,
        convertedBookingId: null,
      }) as never
    );

    await expect(
      approveMemberWholeLodgeRequest({
        requestId: "req-member",
        adminMemberId: "admin-1",
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("still refuses a DECLINED or CANCELLED row", async () => {
    for (const status of [
      BookingRequestStatus.DECLINED,
      BookingRequestStatus.CANCELLED,
    ]) {
      mockedFindUnique.mockResolvedValue(
        memberWholeLodgeRequest({ status }) as never
      );
      await expect(
        approveMemberWholeLodgeRequest({
          requestId: "req-member",
          adminMemberId: "admin-1",
        }),
        `${status} must not be approvable`
      ).rejects.toMatchObject({ status: 409 });
    }
  });

  it("a replay reports the committed booking's total and guest count, not this call's recomputation", async () => {
    mockedFindUnique
      .mockResolvedValueOnce(memberWholeLodgeRequest() as never)
      .mockResolvedValueOnce(
        memberWholeLodgeRequest({
          status: BookingRequestStatus.CONVERTED,
          convertedBookingId: "booking-wl",
          convertedMemberId: "member-9",
        }) as never
      )
      .mockResolvedValueOnce({
        convertedBookingId: "booking-wl",
        convertedMemberId: "member-9",
        status: BookingRequestStatus.CONVERTED,
      } as never);
    // What the FIRST approval actually wrote: 4 guests at $123.45 total.
    serveBooking({
      finalPriceCents: 12345,
      payment: { reference: "IB-COMMITTED" },
      _count: { guests: 4 },
    });

    const result = await approveMemberWholeLodgeRequest({
      requestId: "req-member",
      adminMemberId: "admin-1",
      // A replay carrying DIFFERENT instructions. Echoing these back would show
      // the officer a total and a party size that exist nowhere in the database.
      override: { pricedHeadcount: 5, priceOverrideCents: 999_999 },
    });

    expect(result).toMatchObject({
      type: "approved",
      bookingId: "booking-wl",
      priceCents: 12345,
      guestCount: 4,
    });
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  // #2338: the officer's per-approval flat whole-lodge pricing choice. The
  // precedence pinned here is BINDING (owner decision 1 Aug 2026): manual total
  // override > officer's whole-lodge toggle (when a flat rate covers the stay) >
  // per-guest. The default is per-guest, so nothing changes silently.
  describe("flat whole-lodge pricing (#2338)", () => {
    function bookingData() {
      return vi.mocked(prisma.booking.create).mock.calls[0][0].data as {
        totalPriceCents: number;
        finalPriceCents: number;
        guests: { create: Array<{ priceCents: number }> };
      };
    }

    it("charges nights x the season flat rate and ignores headcount when the officer prices as whole lodge", async () => {
      // $600/night flat; the stay is 2 nights (CHECK_IN..CHECK_OUT) => $1200,
      // regardless of how many guests. Deliberately different from the per-guest
      // total (3 ADULT x 2 nights x $50 = $300) so the branch is unambiguous.
      mockedSeasonFindMany.mockResolvedValue(seasonWithFlatRate(60000) as never);

      await approveMemberWholeLodgeRequest({
        requestId: "req-member",
        adminMemberId: "admin-1",
        // A headcount that WOULD change the per-guest total (6 x 2 x $50 = $600)
        // but must not touch the flat total — proving headcount is ignored.
        override: { priceAsWholeLodge: true, pricedHeadcount: 6 },
      });

      const data = bookingData();
      expect(data.totalPriceCents).toBe(120000);
      expect(data.finalPriceCents).toBe(120000);
      // Headcount still drives the guest ROWS and capacity; only PRICE ignores it.
      expect(data.guests.create).toHaveLength(6);
      // Split across the rows sums EXACTLY to the flat total (no cent invented).
      const perGuest = data.guests.create.map((guest) => guest.priceCents);
      expect(perGuest.reduce((sum, cents) => sum + cents, 0)).toBe(120000);

      // The audit trail names the flat branch, distinct from ordinary per-guest
      // season pricing, so a money decision is legible after the fact.
      const approveAudit = mockedLogAudit.mock.calls
        .map((call) => call[0])
        .find((entry) => entry.action === "booking_request.member_whole_lodge_approved");
      expect(approveAudit?.metadata).toMatchObject({ priceSource: "whole_lodge_flat" });
    });

    it("prices per guest when the officer does NOT tick the toggle, even though a flat rate exists", async () => {
      mockedSeasonFindMany.mockResolvedValue(seasonWithFlatRate(60000) as never);

      await approveMemberWholeLodgeRequest({
        requestId: "req-member",
        adminMemberId: "admin-1",
        // No priceAsWholeLodge => the default per-guest path (3 ADULT x 2 x $50).
      });

      expect(bookingData().totalPriceCents).toBe(30000);
    });

    it("falls back to per-guest when the officer ticks the toggle but the season has no flat rate", async () => {
      // The safety net: an officer who ticks "price as whole lodge" on a season
      // with no flat rate set is never charged zero — it prices per guest.
      mockedSeasonFindMany.mockResolvedValue(seasonWithFlatRate(null) as never);

      await approveMemberWholeLodgeRequest({
        requestId: "req-member",
        adminMemberId: "admin-1",
        override: { priceAsWholeLodge: true },
      });

      expect(bookingData().totalPriceCents).toBe(30000);
    });

    it("lets the manual total override beat the whole-lodge flat rate", async () => {
      mockedSeasonFindMany.mockResolvedValue(seasonWithFlatRate(60000) as never);

      await approveMemberWholeLodgeRequest({
        requestId: "req-member",
        adminMemberId: "admin-1",
        // Both signals present: the manual override must win over the flat rate.
        override: { priceAsWholeLodge: true, priceOverrideCents: 77_777 },
      });

      expect(bookingData().totalPriceCents).toBe(77_777);
    });

    it("charges each night at ITS covering season's flat rate across a season boundary", async () => {
      // Winter covers 1 Aug (flat $600), summer covers 2 Aug (flat $400); the
      // 2-night stay must sum $600 + $400 = $1000, not one rate x 2 nights.
      mockedSeasonFindMany.mockResolvedValue([
        {
          id: "season-winter",
          startDate: new Date("2026-07-01T00:00:00.000Z"),
          endDate: new Date("2026-08-01T00:00:00.000Z"),
          type: "WINTER",
          flatWholeLodgeNightCents: 60000,
          membershipTypeRates: [
            { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 5000 },
          ],
        },
        {
          id: "season-summer",
          startDate: new Date("2026-08-02T00:00:00.000Z"),
          endDate: new Date("2026-09-01T00:00:00.000Z"),
          type: "SUMMER",
          flatWholeLodgeNightCents: 40000,
          membershipTypeRates: [
            { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 5000 },
          ],
        },
      ] as never);

      await approveMemberWholeLodgeRequest({
        requestId: "req-member",
        adminMemberId: "admin-1",
        override: { priceAsWholeLodge: true },
      });

      expect(bookingData().totalPriceCents).toBe(100000);
    });
  });
});
