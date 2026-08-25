import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingRequestQuoteStatus,
  BookingRequestStatus,
  BookingStatus,
  PaymentStatus,
} from "@prisma/client";

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
    bookingRequestQuote: {
      updateMany: vi.fn(),
    },
    member: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    // Rate resolver (#1930, E4): approval snapshots each guest's rate
    // membership type at conversion time (linked members via assignments;
    // unlinked guests resolve to the built-in NON_MEMBER type).
    seasonalMembershipAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    membershipType: {
      findMany: vi.fn().mockResolvedValue([
        { id: "type-full", key: "FULL" },
        { id: "type-nonmember", key: "NON_MEMBER" },
      ]),
    },
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
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    // #2739: the held-booking reassign writes the party's night rows in one
    // batched delete + createMany after the guest rows exist.
    bookingGuestNight: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
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
    lodge: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
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
  // #1377: approve now fires an owner-substitution admin alert on the substitute
  // path. The real function is undefined under a partial mock, so stub it here or
  // the approve path calls undefined → the conversion throws (see #1417).
  sendAdminOwnerSubstitutionAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

// #2576 §9 widened this module's import graph: the path under test now reaches the
// hosting coverage drain, which pulls in the incident and email modules. Exports this
// partial mock never had to provide became reachable, so it spreads `importOriginal`
// over the real module and overrides only what it actually stubs — which is the shape
// that cannot break again the next time an edge is added.
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lodge-capacity")>()),
  // getPublicBookingRequestLodges now resolves each lodge's capacity.
  getLodgeCapacity: vi.fn(async (lodgeId: string) =>
    lodgeId === "lodge-2" ? 40 : 20,
  ),
  // #2263: the member whole-lodge door bounds its headcount against the
  // CONFIGURED capacity of the club's default lodge.
  getDefaultLodgeCapacity: vi.fn(async () => 20),
}));
vi.mock("@/lib/lodge-settings", () => ({
  loadSchoolGroupSoftCap: vi.fn(async (_db: unknown, lodgeId: string) =>
    lodgeId === "lodge-2" ? 30 : 25,
  ),
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
  checkCapacityForGuestRanges: vi.fn(),
}));

vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldDays: vi.fn().mockResolvedValue(2),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// #1365: declineBookingRequest now releases a request's capacity hold via the
// shared cancelBooking path. Mock it so the unit test asserts the call shape
// and keeps the heavy real cancel module out of this test's graph.
vi.mock("@/lib/booking-cancel", () => ({
  cancelBooking: vi.fn(),
}));

vi.mock("bcryptjs", () => ({
  hash: vi.fn().mockResolvedValue("hashed-placeholder"),
}));

// MG4 (#2309): the two post-commit dispatchers, imported lazily by the pipeline.
// Stubbed so these tests assert the WIRING — who is told, and in which
// direction — without pulling the whole email/template graph into the suite.
vi.mock("@/lib/member-guest-consent-notifications", () => ({
  sendMemberGuestAddNotifications: vi.fn(),
  sendMemberGuestWithdrawnNotifications: vi.fn(),
}));

// Keep the real BookingMemberNightConflictError so `instanceof` checks and the
// error constructor stay usable; only the assertion is a controllable spy.
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
  sendAdminBookingRequestPendingEmail,
  sendBookingRequestApprovedEmail,
  sendBookingRequestDeclinedEmail,
  sendAdminOwnerSubstitutionAlert,
} from "@/lib/email";
import { logAudit } from "@/lib/audit";
import { cancelBooking } from "@/lib/booking-cancel";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import {
  assertNoBookingMemberNightConflicts,
  BookingMemberNightConflictError,
} from "@/lib/booking-member-night-conflicts";
import { hashActionToken } from "@/lib/action-tokens";
import {
  approveBookingRequest,
  assertMappableOwnerContact,
  assertRequestedLodgeActive,
  BookingRequestError,
  BookingRequestDeclineCommittedError,
  createBookingRequest,
  declineBookingRequest,
  getBookingRequestSettings,
  getPublicBookingRequestLodges,
  priceBookingRequest,
  purgeExpiredBookingRequests,
  resolvePublicRequestLodgeName,
  resolveRequestBookingHoldUntil,
  splitPriceAcrossGuests,
  updateBookingRequestSettings,
  verifyBookingRequest,
} from "@/lib/booking-request";
import { sendMemberGuestWithdrawnNotifications } from "@/lib/member-guest-consent-notifications";
import {
  fenceMemberFindMany,
  recordingBookingDouble,
} from "@/lib/__tests__/support/hosting-participant-fence-double";

const mockedFindUnique = vi.mocked(prisma.bookingRequest.findUnique);
const mockedCreate = vi.mocked(prisma.bookingRequest.create);
const mockedUpdateMany = vi.mocked(prisma.bookingRequest.updateMany);
const mockedDeleteMany = vi.mocked(prisma.bookingRequest.deleteMany);
const mockedSettingsFindUnique = vi.mocked(prisma.bookingRequestSettings.findUnique);
const mockedSettingsUpsert = vi.mocked(prisma.bookingRequestSettings.upsert);
const mockedTransaction = vi.mocked(prisma.$transaction);
const mockedAcquireLodgeCapacityLock = vi.mocked(acquireLodgeCapacityLock);
const mockedCheckCapacity = vi.mocked(checkCapacityForGuestRanges);
const mockedSendVerification = vi.mocked(sendBookingRequestVerificationEmail);
const mockedSendAdminPending = vi.mocked(sendAdminBookingRequestPendingEmail);
const mockedSendApproved = vi.mocked(sendBookingRequestApprovedEmail);
const mockedSendDeclined = vi.mocked(sendBookingRequestDeclinedEmail);
const mockedSendOwnerSubstitution = vi.mocked(sendAdminOwnerSubstitutionAlert);
const mockedLogAudit = vi.mocked(logAudit);
const mockedAssertNoConflicts = vi.mocked(assertNoBookingMemberNightConflicts);
// Captured BEFORE the fence wiring below replaces the delegates on the double:
// these two stay the mocks the tests stub. Re-stubbing the wrappers instead
// would throw the recorder away and the fence would see no source booking.
const mockedBookingFindUnique = vi.mocked(prisma.booking.findUnique);
const mockedMemberFindMany = vi.mocked(prisma.member.findMany);
const mockedCancelBooking = vi.mocked(cancelBooking);
const mockedQuoteUpdateMany = vi.mocked(prisma.bookingRequestQuote.updateMany);
const mockedWithdrawnNotifications = vi.mocked(
  sendMemberGuestWithdrawnNotifications,
);

/*
  #2619: approveBookingRequest reconciles the adult-member hosting review inside
  the approving transaction, and this suite runs that transaction against the
  prisma double itself. So the hosting participant fence locks the source
  booking's owner/actor Member rows FOR KEY SHARE NOWAIT through THESE
  delegates, and then re-reads, under that lock:

    1. the locked Member rows (every id back, in sorted order), and
    2. each source booking's owner and lodge, whose fingerprint must still
       match what the caller planned from its own `booking.findUnique`.

  Both delegates answered `[]` before, which is a database that just lost every
  row — the fence correctly refused. The recorder replays exactly what
  `mockedBookingFindUnique` served the planner, so the no-drift case matches by
  construction rather than by a hand-copied fixture, and drift is still
  expressible (change what findUnique returns) and still refused.
*/
const fenceBooking = recordingBookingDouble((args) =>
  mockedBookingFindUnique(args as never),
);
Object.assign(prisma.booking, {
  findUnique: fenceBooking.findUnique,
  findMany: fenceBooking.findMany,
});
Object.assign(prisma.member, {
  // The suite's own member.findMany answers (the rate resolver's reads) stay
  // exactly as they were; only the fence's id-only re-read is intercepted.
  findMany: fenceMemberFindMany([], (args) => mockedMemberFindMany(args as never)),
});

function memberNightConflictError() {
  return new BookingMemberNightConflictError([
    {
      memberId: "member-42",
      memberName: "Linked Member",
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
    // #2263: the public/school default — no account behind the request and no
    // exclusivity ask. Member whole-lodge tests override both.
    requestedByMemberId: null,
    exclusivityRequested: false,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    version: 0,
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
    expect(settings).toEqual({
      showPricingToNonMembers: false,
      quoteResponseTtlDays: 14,
      quoteReminderLeadDays: 3,
      attendeeConfirmationLeadDays: 14,
      attendeeConfirmationReminderDays: 3,
    });
  });

  it("updates and audits the pricing visibility setting", async () => {
    mockedSettingsUpsert.mockResolvedValue({
      id: "default",
      showPricingToNonMembers: true,
      quoteResponseTtlDays: 10,
      quoteReminderLeadDays: 2,
      attendeeConfirmationLeadDays: 21,
      attendeeConfirmationReminderDays: 4,
    } as never);

    const result = await updateBookingRequestSettings({
      showPricingToNonMembers: true,
      quoteResponseTtlDays: 10,
      quoteReminderLeadDays: 2,
      attendeeConfirmationLeadDays: 14,
      attendeeConfirmationReminderDays: 3,
      adminMemberId: "admin-1",
    });

    // #2162: the echo is the whole stored row, not just the three fields the
    // audit metadata happens to carry — the admin form re-seeds its draft and
    // snapshot from it.
    expect(result).toEqual({
      showPricingToNonMembers: true,
      quoteResponseTtlDays: 10,
      quoteReminderLeadDays: 2,
      attendeeConfirmationLeadDays: 21,
      attendeeConfirmationReminderDays: 4,
    });
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

  it("stores null lodgeId (default-lodge semantics) when no lodge is requested", async () => {
    await createBookingRequest({
      contactFirstName: "Tara",
      contactLastName: "Tester",
      contactEmail: "tara@example.com",
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      guests: GUESTS,
    });

    const createArgs = mockedCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(createArgs.lodgeId).toBeNull();
  });

  it("persists an explicit lodgeId and prices indicatively at that lodge's seasons", async () => {
    mockedSettingsFindUnique.mockResolvedValue({
      id: "default",
      showPricingToNonMembers: true,
      quoteResponseTtlDays: 14,
      quoteReminderLeadDays: 3,
    } as never);
    vi.mocked(prisma.season.findMany).mockResolvedValue([] as never);

    await createBookingRequest({
      contactFirstName: "Tara",
      contactLastName: "Tester",
      contactEmail: "tara@example.com",
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      guests: GUESTS,
      lodgeId: "lodge-2",
    });

    // Season lookup is scoped strictly to the requested lodge, never the
    // default lodge.
    const seasonWhere = vi.mocked(prisma.season.findMany).mock.calls[0][0]!
      .where as Record<string, unknown>;
    expect(seasonWhere.lodgeId).toBe("lodge-2");
    expect(prisma.lodge.findFirst).not.toHaveBeenCalled();

    const createArgs = mockedCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(createArgs.lodgeId).toBe("lodge-2");
  });

  it("never sets exclusivityRequested: the PUBLIC front-door may not ask for the whole lodge (#121, superseded for members by #2263)", async () => {
    /*
      This test replaces the original "the whole-lodge request front-door is
      school-only (#121)" pin, which ADR-001's dated 2026-07-30 entry supersedes:
      a signed-in member may now ask for sole occupancy too (owner decision D11,
      issue #2263).

      What is superseded is the SCHOOL-ONLY part. What is NOT superseded — and is
      what this test now pins — is that the ANONYMOUS public door may never ask.
      An unauthenticated stranger who could set the flag would be asking the club
      to sterilise every bed in the lodge on a date of their choosing, with no
      account behind the request and no cap on how often they did it.

      Asserted on the persisted payload rather than on the input type: the type
      already has no such field (so passing one would not compile), and a
      write-site added later inside the function would slip past a type check but
      not past this. The companion source-scan test
      (exclusivity-request-write-sites.test.ts) proves no THIRD door exists.
    */
    await createBookingRequest({
      contactFirstName: "Tara",
      contactLastName: "Tester",
      contactEmail: "tara@example.com",
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      guests: GUESTS,
    });

    const createArgs = mockedCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(createArgs).not.toHaveProperty("exclusivityRequested");
    // ...and it is not a member request either: nothing on the public door may
    // attribute a row to an account.
    expect(createArgs).not.toHaveProperty("requestedByMemberId");
  });
});

describe("assertRequestedLodgeActive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no lodge is requested", async () => {
    await expect(assertRequestedLodgeActive(null)).resolves.toBeNull();
    await expect(assertRequestedLodgeActive(undefined)).resolves.toBeNull();
    expect(prisma.lodge.findUnique).not.toHaveBeenCalled();
  });

  it("returns the id of an active lodge", async () => {
    vi.mocked(prisma.lodge.findUnique).mockResolvedValue({
      id: "lodge-2",
      active: true,
    } as never);
    await expect(assertRequestedLodgeActive("lodge-2")).resolves.toBe("lodge-2");
  });

  it("throws 400 for an unknown lodge", async () => {
    vi.mocked(prisma.lodge.findUnique).mockResolvedValue(null);
    await expect(assertRequestedLodgeActive("nope")).rejects.toMatchObject({
      status: 400,
      message: "Lodge not found or not active",
    });
  });

  it("throws 400 for an inactive lodge", async () => {
    vi.mocked(prisma.lodge.findUnique).mockResolvedValue({
      id: "lodge-2",
      active: false,
    } as never);
    await expect(assertRequestedLodgeActive("lodge-2")).rejects.toMatchObject({
      status: 400,
      message: "Lodge not found or not active",
    });
  });
});

describe("getPublicBookingRequestLodges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty list for a single-lodge club (ADR-002)", async () => {
    vi.mocked(prisma.lodge.findMany).mockResolvedValue([
      { id: "lodge-1", name: "Ruapehu Lodge" },
    ] as never);
    await expect(getPublicBookingRequestLodges()).resolves.toEqual([]);
  });

  it("returns id and name for each active lodge when two or more are active", async () => {
    vi.mocked(prisma.lodge.findMany).mockResolvedValue([
      { id: "lodge-1", name: "Ruapehu Lodge" },
      { id: "lodge-2", name: "Whakapapa Lodge" },
    ] as never);
    await expect(getPublicBookingRequestLodges()).resolves.toEqual([
      { id: "lodge-1", name: "Ruapehu Lodge", capacity: 20, schoolGroupSoftCap: 25 },
      { id: "lodge-2", name: "Whakapapa Lodge", capacity: 40, schoolGroupSoftCap: 30 },
    ]);
    const args = vi.mocked(prisma.lodge.findMany).mock.calls[0][0]!;
    expect(args.where).toEqual({ active: true });
    expect(args.select).toEqual({ id: true, name: true });
  });
});

describe("resolvePublicRequestLodgeName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for a request without an explicit lodge", async () => {
    await expect(resolvePublicRequestLodgeName(null)).resolves.toBeNull();
    expect(prisma.lodge.count).not.toHaveBeenCalled();
  });

  it("returns null for a single-lodge club (ADR-002)", async () => {
    vi.mocked(prisma.lodge.count).mockResolvedValue(1 as never);
    await expect(resolvePublicRequestLodgeName("lodge-1")).resolves.toBeNull();
    expect(prisma.lodge.findUnique).not.toHaveBeenCalled();
  });

  it("returns the lodge name when the club has two or more active lodges", async () => {
    vi.mocked(prisma.lodge.count).mockResolvedValue(2 as never);
    vi.mocked(prisma.lodge.findUnique).mockResolvedValue({
      name: "Whakapapa Lodge",
    } as never);
    await expect(resolvePublicRequestLodgeName("lodge-2")).resolves.toBe(
      "Whakapapa Lodge"
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
      data: {
        status: BookingRequestStatus.VERIFIED,
        verifiedAt: expect.any(Date),
        version: { increment: 1 },
      },
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
        version: { increment: 1 },
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
    // MG4 (#2309): the hold-release path reads the booking's guest rows to see
    // who it had already told they were on this booking. Empty is the ordinary
    // answer — a request whose guests are all free-text names owes nobody a
    // withdrawal notice.
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([] as never);
    // #1423: the claim + SENT-quote retirement now run in one interactive
    // transaction; run the callback against the same prisma mock so the inner
    // tx.bookingRequest.updateMany / tx.bookingRequestQuote.updateMany are the
    // spied mocks.
    mockedTransaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma)
    );
    mockedQuoteUpdateMany.mockResolvedValue({ count: 1 } as never);
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

  it("keeps a member whole-lodge decline note in the AUDIT LOG ONLY, never on the row and never in the email (#2263)", async () => {
    /*
      The school/public path's `declineReason` is the field the requester is
      SHOWN — it is interpolated into the decline email. An officer writing
      "sorry, we're holding that week for another group" into it would be telling
      a member exactly what ADR-001 decision 6 says they are never told, with a
      keyboard rather than an exploit.

      So on a member-origin whole-lodge request the note is not persisted at all.
      Not persisted rather than persisted-and-filtered: a null column cannot be
      leaked by a surface somebody adds next year.
    */
    const memberRequest = baseRequest({
      status: BookingRequestStatus.VERIFIED,
      requestedByMemberId: "member-9",
      exclusivityRequested: true,
    });
    mockedFindUnique
      .mockResolvedValueOnce(memberRequest as never)
      .mockResolvedValueOnce(
        baseRequest({ status: BookingRequestStatus.DECLINED }) as never,
      );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);

    await declineBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
      reason: "Holding that week for the school group",
    });

    // The row keeps nothing.
    const claimData = mockedUpdateMany.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(claimData.declineReason).toBeNull();

    // The email carries the template's fixed generic body, with no note.
    expect(mockedSendDeclined).toHaveBeenCalledWith(
      expect.objectContaining({ reason: null }),
    );

    // The officer's words survive exactly once: in the audit log.
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.declined",
        metadata: expect.objectContaining({
          reason: "Holding that week for the school group",
          declineNoteAuditOnly: true,
          memberWholeLodgeRequest: true,
        }),
      }),
    );
  });

  it("still persists and emails the decline reason on a NON member-origin request", async () => {
    // The change above must be scoped to the member door. A school or public
    // requester still gets the officer's explanation, exactly as before.
    mockedFindUnique
      .mockResolvedValueOnce(
        baseRequest({ status: BookingRequestStatus.PRICED }) as never,
      )
      .mockResolvedValueOnce(
        baseRequest({ status: BookingRequestStatus.DECLINED }) as never,
      );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);

    await declineBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
      reason: "Fully booked",
    });

    const claimData = mockedUpdateMany.mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(claimData.declineReason).toBe("Fully booked");
    expect(mockedSendDeclined).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "Fully booked" }),
    );
  });

  it("tells the member guests the released hold had told (MG4 #2309)", async () => {
    // THE GAP THIS CLOSES. The hold emailed these members to say the club had
    // put them on a lodge booking. The decline then cancels that booking — and
    // until now did it in silence, leaving them holding an email that had
    // stopped being true and a person-night they did not know they had back.
    mockedFindUnique
      .mockResolvedValueOnce(
        baseRequest({
          status: BookingRequestStatus.QUOTE_SENT,
          heldBookingId: "held-1",
        }) as never,
      )
      .mockResolvedValueOnce(
        baseRequest({
          status: BookingRequestStatus.DECLINED,
          heldBookingId: null,
        }) as never,
      );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedBookingFindUnique.mockResolvedValue({
      id: "held-1",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    mockedCancelBooking.mockResolvedValue({
      status: 200,
      data: { success: true },
    } as never);
    // Only rows carrying a consent record — the query itself excludes the
    // free-text guests and the family-scope ones.
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([
      { memberId: "m-sam" },
      { memberId: "m-priya" },
    ] as never);

    await declineBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
      ipAddress: "203.0.113.11",
    });

    expect(mockedWithdrawnNotifications).toHaveBeenCalledWith({
      bookingId: "held-1",
      targetMemberIds: ["m-sam", "m-priya"],
      // Names nobody: the held booking's owner is a non-login contact the
      // reader has never dealt with.
      context: "BOOKING_REQUEST_REPLACED",
    });
    // Read from the booking that is about to be cancelled, before the cancel.
    expect(vi.mocked(prisma.bookingGuest.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ bookingId: "held-1" }),
      }),
    );
  });

  it("tells nobody when the released hold had no member guests on it", async () => {
    // The ordinary booking request: every guest a free-text name, no consent
    // record anywhere, so the decline owes no member-facing mail at all.
    mockedFindUnique
      .mockResolvedValueOnce(
        baseRequest({
          status: BookingRequestStatus.QUOTE_SENT,
          heldBookingId: "held-1",
        }) as never,
      )
      .mockResolvedValueOnce(
        baseRequest({
          status: BookingRequestStatus.DECLINED,
          heldBookingId: null,
        }) as never,
      );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedBookingFindUnique.mockResolvedValue({
      id: "held-1",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    mockedCancelBooking.mockResolvedValue({
      status: 200,
      data: { success: true },
    } as never);

    await declineBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });

    expect(mockedWithdrawnNotifications).not.toHaveBeenCalled();
  });

  it("declining a request WITHOUT a hold never touches the cancel path (#1365)", async () => {
    mockedFindUnique
      .mockResolvedValueOnce(baseRequest({ status: BookingRequestStatus.PRICED }) as never)
      .mockResolvedValueOnce(
        baseRequest({ status: BookingRequestStatus.DECLINED }) as never
      );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);

    const updated = await declineBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });

    expect(updated?.status).toBe(BookingRequestStatus.DECLINED);
    expect(mockedCancelBooking).not.toHaveBeenCalled();
    // No held-booking re-read either, since there is no hold to release.
    expect(mockedBookingFindUnique).not.toHaveBeenCalled();
  });

  it("declines a QUOTE_SENT held request and releases its AWAITING_REVIEW hold (#1423)", async () => {
    // #1423 broadened decline to the six held/editor states, including a generic
    // QUOTE_SENT request (auto-hold-on-send #1280). It must now claim DECLINED
    // and release the held booking via the shared cancel path (requireRequestHold
    // so a racing requester accept that already converted the hold is not
    // clobbered).
    mockedFindUnique
      .mockResolvedValueOnce(
        baseRequest({
          status: BookingRequestStatus.QUOTE_SENT,
          heldBookingId: "held-1",
        }) as never
      )
      .mockResolvedValueOnce(
        baseRequest({
          status: BookingRequestStatus.DECLINED,
          heldBookingId: null,
        }) as never
      );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedBookingFindUnique.mockResolvedValue({
      id: "held-1",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    mockedCancelBooking.mockResolvedValue({
      status: 200,
      data: { success: true },
    } as never);

    const updated = await declineBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
      reason: "No longer available",
      ipAddress: "203.0.113.9",
    });

    expect(updated?.status).toBe(BookingRequestStatus.DECLINED);
    // The decline claim ran, then the hold was released (cancelBooking detaches
    // heldBookingId + frees the beds — asserted in booking-cancel's own tests).
    expect(mockedUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: BookingRequestStatus.DECLINED }),
      })
    );
    expect(mockedCancelBooking).toHaveBeenCalledWith(
      "held-1",
      "admin-1",
      "ADMIN",
      "203.0.113.9",
      "card",
      { suppressCustomerNotification: true, requireRequestHold: true }
    );
    // #1423: the outstanding SENT quote is retired (SENT -> SUPERSEDED) in the
    // same transaction as the claim, so no requester quote action or reminder
    // cron can act on the declined request.
    expect(mockedQuoteUpdateMany).toHaveBeenCalledWith({
      where: {
        bookingRequestId: "req-1",
        status: BookingRequestQuoteStatus.SENT,
      },
      data: expect.objectContaining({
        status: BookingRequestQuoteStatus.SUPERSEDED,
      }),
    });
  });

  it.each([
    BookingRequestStatus.QUERY_PENDING,
    BookingRequestStatus.MODIFICATION_REQUESTED,
  ])(
    "declines a %s held request and releases its AWAITING_REVIEW hold (#1423)",
    async (status) => {
      mockedFindUnique
        .mockResolvedValueOnce(
          baseRequest({ status, heldBookingId: "held-1" }) as never
        )
        .mockResolvedValueOnce(
          baseRequest({
            status: BookingRequestStatus.DECLINED,
            heldBookingId: null,
          }) as never
        );
      mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
      mockedBookingFindUnique.mockResolvedValue({
        id: "held-1",
        status: BookingStatus.AWAITING_REVIEW,
      } as never);
      mockedCancelBooking.mockResolvedValue({
        status: 200,
        data: { success: true },
      } as never);

      const updated = await declineBookingRequest({
        requestId: "req-1",
        adminMemberId: "admin-1",
        ipAddress: "203.0.113.10",
      });

      expect(updated?.status).toBe(BookingRequestStatus.DECLINED);
      expect(mockedCancelBooking).toHaveBeenCalledWith(
        "held-1",
        "admin-1",
        "ADMIN",
        "203.0.113.10",
        "card",
        { suppressCustomerNotification: true, requireRequestHold: true }
      );
    }
  );

  it.each([
    BookingRequestStatus.APPROVED,
    BookingRequestStatus.CONVERTED,
    BookingRequestStatus.DECLINED,
    BookingRequestStatus.CANCELLED,
  ])(
    "409s a terminal %s request and never touches its hold (#1423)",
    async (status) => {
      // The updateMany claim finds nothing (status not in the declinable set),
      // so it 409s claim-first: no held-booking read, no cancel, no detach.
      mockedFindUnique.mockResolvedValue(
        baseRequest({ status, heldBookingId: "held-1" }) as never
      );
      mockedUpdateMany.mockResolvedValue({ count: 0 } as never);

      await expect(
        declineBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" })
      ).rejects.toMatchObject({ status: 409 });

      expect(mockedCancelBooking).not.toHaveBeenCalled();
      expect(mockedBookingFindUnique).not.toHaveBeenCalled();
      expect(mockedUpdateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { heldBookingId: null } })
      );
      // A failed (wrong-state) decline retires NO quote — claim-first, the tx
      // returns before the quote retirement.
      expect(mockedQuoteUpdateMany).not.toHaveBeenCalled();
    }
  );

  it("releases an AWAITING_REVIEW hold via the shared cancel path AFTER the decline claim (#1365)", async () => {
    // A PRICED request carrying a SCHOOL-style manual hold: claim DECLINED
    // first, then release the held booking via the shared cancel path.
    mockedFindUnique
      .mockResolvedValueOnce(
        baseRequest({
          status: BookingRequestStatus.PRICED,
          heldBookingId: "held-1",
        }) as never
      )
      .mockResolvedValueOnce(
        baseRequest({
          status: BookingRequestStatus.DECLINED,
          heldBookingId: null,
        }) as never
      );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedBookingFindUnique.mockResolvedValue({
      id: "held-1",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    mockedCancelBooking.mockResolvedValue({
      status: 200,
      data: { success: true },
    } as never);

    const updated = await declineBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
      reason: "Fully booked",
      ipAddress: "203.0.113.7",
    });

    // The status-guarded decline claim ran (flip to DECLINED)...
    expect(mockedUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: BookingRequestStatus.DECLINED }),
      })
    );
    // ...then the hold was released via the shared cancel path (which detaches
    // heldBookingId + frees the held beds — verified in booking-cancel's own
    // tests) with the admin identity + client IP and a suppressed cancellation
    // email.
    expect(mockedCancelBooking).toHaveBeenCalledWith(
      "held-1",
      "admin-1",
      "ADMIN",
      "203.0.113.7",
      "card",
      // #1406: opt-in guard (defense-in-depth) so the shared cancel path refuses
      // (409, no side effect) if the hold ever leaves AWAITING_REVIEW.
      { suppressCustomerNotification: true, requireRequestHold: true }
    );
    expect(updated?.status).toBe(BookingRequestStatus.DECLINED);
  });

  it("releases the hold for a SCHOOL request too (same path, no type branch) (#1365)", async () => {
    mockedFindUnique
      .mockResolvedValueOnce(
        baseRequest({
          type: "SCHOOL",
          status: BookingRequestStatus.PRICED,
          heldBookingId: "held-school-1",
        }) as never
      )
      .mockResolvedValueOnce(
        baseRequest({
          type: "SCHOOL",
          status: BookingRequestStatus.DECLINED,
          heldBookingId: null,
        }) as never
      );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedBookingFindUnique.mockResolvedValue({
      id: "held-school-1",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    mockedCancelBooking.mockResolvedValue({
      status: 200,
      data: { success: true },
    } as never);

    const updated = await declineBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
      ipAddress: "203.0.113.8",
    });

    expect(mockedCancelBooking).toHaveBeenCalledWith(
      "held-school-1",
      "admin-1",
      "ADMIN",
      "203.0.113.8",
      "card",
      // #1406: opt-in guard (defense-in-depth), see above.
      { suppressCustomerNotification: true, requireRequestHold: true }
    );
    expect(updated?.status).toBe(BookingRequestStatus.DECLINED);
  });

  it("forwards a 409 from the cancel path after a successful decline claim (concurrent release race) (#1365)", async () => {
    // For VERIFIED/PRICED there is no requester quote-accept to race (no sent
    // quote), so a cancel-path 409 can only be a concurrent cancel of the SAME
    // held booking (double-submit / simultaneous Release hold). The decline
    // claim succeeds; cancelBooking's single-flight returns 409 and we forward
    // it — the hold is released either way.
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        heldBookingId: "held-1",
      }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedBookingFindUnique.mockResolvedValue({
      id: "held-1",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    mockedCancelBooking.mockResolvedValue({
      status: 409,
      error: "This booking was concurrently accepted or cancelled and can no longer be cancelled",
    } as never);

    await expect(
      declineBookingRequest({
        requestId: "req-1",
        adminMemberId: "admin-1",
        ipAddress: "203.0.113.7",
      })
    ).rejects.toMatchObject({
      status: 409,
      holdReleasePending: false,
      holdReleaseStatusUnconfirmed: true,
    });

    // Claim-first: the decline flip DID run and the shared cancel path was
    // invoked before the 409 surfaced.
    expect(mockedUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: BookingRequestStatus.DECLINED }),
      })
    );
    expect(mockedCancelBooking).toHaveBeenCalled();
  });

  it("preserves the committed decline when an ordinary hold-release error leaves status unconfirmed", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        heldBookingId: "held-1",
      }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedBookingFindUnique.mockResolvedValue({
      id: "held-1",
      status: BookingStatus.AWAITING_REVIEW,
    } as never);
    mockedCancelBooking.mockRejectedValue(new Error("private database detail"));

    const failure = declineBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });

    await expect(failure).rejects.toBeInstanceOf(
      BookingRequestDeclineCommittedError,
    );
    await expect(failure).rejects.toMatchObject({
      status: 500,
      holdReleasePending: false,
      holdReleaseStatusUnconfirmed: true,
      cause: expect.objectContaining({ message: "private database detail" }),
    });
  });

  it("does not claim hold uncertainty when a committed decline had no hold", async () => {
    mockedFindUnique
      .mockResolvedValueOnce(
        baseRequest({
          status: BookingRequestStatus.PRICED,
          heldBookingId: null,
        }) as never
      )
      .mockRejectedValueOnce(new Error("private reload failure"));
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);

    await expect(
      declineBookingRequest({
        requestId: "req-1",
        adminMemberId: "admin-1",
      })
    ).rejects.toMatchObject({
      status: 500,
      message:
        "The request was declined, but the updated request could not be loaded. Reload the request queue before continuing.",
      holdReleasePending: false,
      holdReleaseStatusUnconfirmed: false,
    });
    expect(mockedCancelBooking).not.toHaveBeenCalled();
  });

  it("detaches a non-live held booking (already CANCELLED) on a successful decline and proceeds (#1365)", async () => {
    mockedFindUnique
      .mockResolvedValueOnce(
        baseRequest({
          status: BookingRequestStatus.PRICED,
          heldBookingId: "held-1",
        }) as never
      )
      .mockResolvedValueOnce(
        baseRequest({
          status: BookingRequestStatus.DECLINED,
          heldBookingId: null,
        }) as never
      );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    // The held booking is no longer a live hold (already cancelled elsewhere).
    mockedBookingFindUnique.mockResolvedValue({
      id: "held-1",
      status: BookingStatus.CANCELLED,
    } as never);

    const updated = await declineBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });

    // Nothing live to cancel: detach the pointer, no cancelBooking, no abort.
    expect(mockedCancelBooking).not.toHaveBeenCalled();
    expect(mockedUpdateMany).toHaveBeenCalledWith({
      where: { id: "req-1", heldBookingId: "held-1" },
      data: { heldBookingId: null, version: { increment: 1 } },
    });
    expect(updated?.status).toBe(BookingRequestStatus.DECLINED);
  });

  it("detaches a stale held pointer (held booking gone) on a successful decline and proceeds (#1365)", async () => {
    mockedFindUnique
      .mockResolvedValueOnce(
        baseRequest({
          status: BookingRequestStatus.PRICED,
          heldBookingId: "held-gone",
        }) as never
      )
      .mockResolvedValueOnce(
        baseRequest({
          status: BookingRequestStatus.DECLINED,
          heldBookingId: null,
        }) as never
      );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    // The held booking no longer exists.
    mockedBookingFindUnique.mockResolvedValue(null as never);

    const updated = await declineBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });

    // Nothing to cancel; the stale pointer is detached, then the decline lands.
    expect(mockedCancelBooking).not.toHaveBeenCalled();
    expect(mockedUpdateMany).toHaveBeenCalledWith({
      where: { id: "req-1", heldBookingId: "held-gone" },
      data: { heldBookingId: null, version: { increment: 1 } },
    });
    expect(updated?.status).toBe(BookingRequestStatus.DECLINED);
  });

  // #1791: admin per-decline requester-email choice — absent = notify (default),
  // false = suppress (recorded in the audit), true = notify (no audit field).
  describe("notify choice (#1791)", () => {
    function primeDecline() {
      mockedFindUnique
        .mockResolvedValueOnce(baseRequest({ status: BookingRequestStatus.PRICED }) as never)
        .mockResolvedValueOnce(baseRequest({ status: BookingRequestStatus.DECLINED }) as never);
      mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    }

    function declinedAuditCall() {
      return mockedLogAudit.mock.calls.find(
        ([arg]) => arg.action === "booking_request.declined"
      );
    }

    it("emails the requester and records no notify field when the choice is omitted (default)", async () => {
      primeDecline();

      await declineBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });

      expect(mockedSendDeclined).toHaveBeenCalledTimes(1);
      const auditCall = declinedAuditCall();
      expect(auditCall).toBeDefined();
      expect(auditCall![0].metadata).not.toHaveProperty("notifyMember");
    });

    it("suppresses the requester email when notifyMember is false, still declines, and audits the choice", async () => {
      primeDecline();

      const updated = await declineBookingRequest({
        requestId: "req-1",
        adminMemberId: "admin-1",
        notifyMember: false,
      });

      expect(updated?.status).toBe(BookingRequestStatus.DECLINED);
      expect(mockedSendDeclined).not.toHaveBeenCalled();
      expect(mockedLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "booking_request.declined",
          metadata: expect.objectContaining({ notifyMember: false }),
        })
      );
    });

    it("emails the requester and records no notify field when notifyMember is true", async () => {
      primeDecline();

      await declineBookingRequest({
        requestId: "req-1",
        adminMemberId: "admin-1",
        notifyMember: true,
      });

      expect(mockedSendDeclined).toHaveBeenCalledTimes(1);
      const auditCall = declinedAuditCall();
      expect(auditCall).toBeDefined();
      expect(auditCall![0].metadata).not.toHaveProperty("notifyMember");
    });
  });
});

describe("approveBookingRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTransaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma)
    );
    vi.mocked(prisma.lodge.findFirst).mockResolvedValue({ id: "lodge-1" } as never);
    // Default to no member-night conflict; individual tests override to reject.
    mockedAssertNoConflicts.mockResolvedValue(undefined);
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
    // General booking-request contacts are non-members, not paying members.
    expect(memberArgs.role).toBe("NON_MEMBER");

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

  it("gives every converted guest their canonical night set (#2739)", async () => {
    // Before this, an approved request produced guests with NO BookingGuestNight
    // rows, so the bed board did not list them, the planner did not place them
    // and nothing counted them as awaiting a bed — real people on a confirmed
    // booking (INV-CAP-032).
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

    await approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });

    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    const guestCreates = (bookingArgs.guests as { create: Record<string, unknown>[] })
      .create;
    expect(guestCreates).toHaveLength(1);
    // Two nights for a 1 Aug → 3 Aug stay. NOT three: the check-out morning is a
    // departure, not a night anybody holds a bed for (INV-DATE-003), and a
    // phantom night there is a double booking.
    expect(guestCreates[0].nights).toEqual({
      create: [
        { stayDate: new Date("2026-08-01T00:00:00.000Z"), priceCents: 6000 },
        { stayDate: new Date("2026-08-02T00:00:00.000Z"), priceCents: 6000 },
      ],
    });
    // Money does not move: the nights sum to the guest's stored price.
    expect(guestCreates[0].priceCents).toBe(12000);
  });

  it("records the adult-member hosting review on the approved booking, in the approving transaction (#2364)", async () => {
    // The purest form of the party this rule exists for: every guest a
    // non-member, the owner a non-login contact, nobody who can host. Before
    // this the booking committed with all five hosting columns NULL and the
    // hazard only materialised months later, on the first unrelated edit.
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
    mockedBookingFindUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      parentBookingId: null,
      lodgeId: "lodge-1",
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-02T00:00:00.000Z"),
      adultMemberHostingReview: null,
      adultMemberHostingReviewStatus: null,
      guests: [
        {
          id: "guest-1",
          firstName: "Non",
          lastName: "Member",
          stayStart: new Date("2026-08-01T00:00:00.000Z"),
          stayEnd: new Date("2026-08-02T00:00:00.000Z"),
          consentStatus: null,
          nights: [{ stayDate: new Date("2026-08-01T00:00:00.000Z") }],
          member: null,
        },
      ],
    } as never);

    await approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });

    const hostingWrite = vi
      .mocked(prisma.booking.update)
      .mock.calls.find(
        (call) =>
          (call[0].data as Record<string, unknown>)
            .adultMemberHostingReviewStatus !== undefined,
      );
    expect(hostingWrite).toBeDefined();
    const data = hostingWrite![0].data as Record<string, unknown>;
    // PENDING, never APPROVED: approving the REQUEST is not the explicit,
    // reasoned acceptance of a hosting exception that D-R4 requires.
    expect(data.adultMemberHostingReviewStatus).toBe("PENDING");
    expect(data.adultMemberHostingReviewReason).toBeNull();
    expect(data.adultMemberHostingReviewedById).toBeNull();
    expect(
      (data.adultMemberHostingReview as Record<string, unknown>).affectedNights,
    ).toEqual(["2026-08-01"]);
  });

  it("creates the booking at the request's lodge instead of the default lodge", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        lodgeId: "lodge-2",
      }) as never
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

    const result = await approveBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });

    expect(result).toMatchObject({ type: "approved", bookingId: "booking-1" });
    // The default-lodge resolver must not run when the request names a lodge.
    expect(prisma.lodge.findFirst).not.toHaveBeenCalled();
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
  });

  it("locks and reuses a held booking's concrete lodge when the default changed", async () => {
    const heldRequest = baseRequest({
      status: BookingRequestStatus.PRICED,
      priceCents: 12000,
      lodgeId: null,
      heldBookingId: "held-1",
    });
    mockedFindUnique.mockResolvedValue(heldRequest as never);
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedBookingFindUnique
      .mockResolvedValueOnce({ lodgeId: "held-lodge" } as never)
      .mockResolvedValueOnce({
        id: "held-1",
        lodgeId: "held-lodge",
        memberId: "held-member",
        status: BookingStatus.AWAITING_REVIEW,
      } as never);
    // The club default changed after the null-lodge request created its hold.
    vi.mocked(prisma.lodge.findFirst).mockResolvedValue({ id: "new-default" } as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-member",
      canLogin: false,
      role: "NON_MEMBER",
      archivedAt: null,
      active: true,
    } as never);
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([{ id: "g1" }] as never);
    vi.mocked(prisma.bookingGuest.update).mockResolvedValue({} as never);
    vi.mocked(prisma.booking.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);

    const result = await approveBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });

    expect(result).toMatchObject({ type: "approved", bookingId: "held-1" });
    expect(prisma.lodge.findFirst).not.toHaveBeenCalled();
    expect(mockedAcquireLodgeCapacityLock).toHaveBeenCalledWith(
      prisma,
      "held-lodge"
    );
    // Two raw statements run inside the approving transaction, and the FIRST is
    // still the request-wide advisory lock this test is about — pinned by name
    // rather than by a bare count, so the claim survives the second statement
    // and cannot be satisfied by the wrong one. That second statement is the
    // hosting participant fence's FOR KEY SHARE NOWAIT over the source
    // booking's Member rows: real production behaviour on this path that was
    // invisible here until #2619, because the double carries no `$queryRaw` and
    // the fence used to hand back an UNLOCKED proof rather than take the lock.
    const rawStatements = vi.mocked(prisma.$executeRaw).mock.calls;
    expect(rawStatements).toHaveLength(2);
    expect(JSON.stringify(rawStatements[0][0])).toContain(
      "pg_advisory_xact_lock"
    );
    // Pin the fence's own statement too. This is the one assertion across the
    // widened suites that would FAIL if the lock were deleted from
    // acquireHostingCoverageQueueParticipantProof — the rest model what the
    // fence reads without asserting that it locked, so without this the seam
    // could be gutted and stay green.
    expect(JSON.stringify(rawStatements[1][0])).toContain(
      "FOR KEY SHARE NOWAIT"
    );
    expect(
      vi.mocked(prisma.$executeRaw).mock.invocationCallOrder[0]
    ).toBeLessThan(mockedAcquireLodgeCapacityLock.mock.invocationCallOrder[0]);
    expect(mockedCheckCapacity).not.toHaveBeenCalled();
    expect(mockedSendApproved).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "held-lodge" })
    );
    expect(mockedBookingFindUnique).toHaveBeenNthCalledWith(1, {
      where: { id: "held-1" },
      select: { lodgeId: true },
    });
    expect(mockedBookingFindUnique).toHaveBeenNthCalledWith(2, {
      where: { id: "held-1" },
      select: { id: true, lodgeId: true, memberId: true, status: true },
    });
  });

  it("rejects a held booking whose concrete lodge differs from an explicit request lodge", async () => {
    const heldRequest = baseRequest({
      status: BookingRequestStatus.PRICED,
      priceCents: 12000,
      lodgeId: "request-lodge",
      heldBookingId: "held-1",
    });
    mockedFindUnique.mockResolvedValue(heldRequest as never);
    mockedBookingFindUnique
      .mockResolvedValueOnce({ lodgeId: "held-lodge" } as never)
      .mockResolvedValueOnce({
        id: "held-1",
        lodgeId: "held-lodge",
        memberId: "held-member",
        status: BookingStatus.AWAITING_REVIEW,
      } as never);

    await expect(
      approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 409 });

    expect(mockedAcquireLodgeCapacityLock).toHaveBeenCalledWith(
      prisma,
      "held-lodge"
    );
    expect(mockedUpdateMany).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it("rejects an approval snapshot changed before the under-lock request reread", async () => {
    const initial = baseRequest({
      status: BookingRequestStatus.PRICED,
      priceCents: 12000,
      version: 3,
    });
    mockedFindUnique
      .mockResolvedValueOnce(initial as never)
      .mockResolvedValueOnce(
        baseRequest({
          status: BookingRequestStatus.PRICED,
          priceCents: 13000,
          // A concurrent write advanced version after the pre-read snapshot
          // (#1923); the under-lock fence must reject on the version drift.
          version: 4,
        }) as never
      );

    await expect(
      approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" })
    ).rejects.toMatchObject({ status: 409 });

    expect(mockedUpdateMany).not.toHaveBeenCalled();
    expect(prisma.booking.create).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it("maps to an existing non-login contact instead of creating a new member (#1255)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({ status: BookingRequestStatus.PRICED, priceCents: 12000 }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedCheckCapacity.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    } as never);
    // The chosen contact is a valid non-login NON_MEMBER organisation contact.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "contact-9",
      canLogin: false,
      role: "NON_MEMBER",
      archivedAt: null,
      active: true,
    } as never);
    vi.mocked(prisma.booking.create).mockResolvedValue({ id: "booking-1" } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);

    const result = await approveBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
      ownerContactMemberId: "contact-9",
    });

    expect(result).toMatchObject({
      type: "approved",
      memberId: "contact-9",
      bookingId: "booking-1",
    });
    // No new member (and therefore no new Xero contact) is minted on the map path.
    expect(prisma.member.create).not.toHaveBeenCalled();
    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(bookingArgs.memberId).toBe("contact-9");
  });

  it("rejects mapping a request onto a login-capable member (#1255 guard)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({ status: BookingRequestStatus.PRICED, priceCents: 12000 }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedCheckCapacity.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    } as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "real-member",
      canLogin: true,
      role: "USER",
      archivedAt: null,
    } as never);

    await expect(
      approveBookingRequest({
        requestId: "req-1",
        adminMemberId: "admin-1",
        ownerContactMemberId: "real-member",
      })
    ).rejects.toMatchObject({ status: 422 });
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it("is idempotent on a re-armed convertedBookingId: a replayed accept returns the existing booking and fires no second side effect (#1232)", async () => {
    // First accept: a clean PRICED request converts exactly once.
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

    const first = await approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });
    expect(first).toMatchObject({ type: "approved", bookingId: "booking-1", memberId: "member-1" });
    expect(prisma.member.create).toHaveBeenCalledTimes(1);
    expect(prisma.booking.create).toHaveBeenCalledTimes(1);
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(prisma.paymentLink.create).toHaveBeenCalledTimes(1);
    expect(mockedSendApproved).toHaveBeenCalledTimes(1);

    // Simulate the caller's line-~729 re-arm: the request is set back to PRICED
    // WITHOUT clearing convertedBookingId/convertedMemberId. Deliberately do NOT
    // reset mock history here — the whole money proof is that these counts stay
    // at one across the replay.
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        convertedBookingId: "booking-1",
        convertedMemberId: "member-1",
      }) as never
    );

    const replay = await approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });

    // Returns the SAME booking; nothing new is created; no second email.
    expect(replay).toMatchObject({
      type: "approved",
      bookingId: "booking-1",
      memberId: "member-1",
    });
    expect(prisma.member.create).toHaveBeenCalledTimes(1);
    expect(prisma.booking.create).toHaveBeenCalledTimes(1);
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(prisma.paymentLink.create).toHaveBeenCalledTimes(1);
    expect(mockedSendApproved).toHaveBeenCalledTimes(1);
    // The claim updateMany ran for the first accept only, never the replay.
    expect(mockedUpdateMany).toHaveBeenCalledTimes(1);
    // Under the lock the replay re-asserts the terminal status to CONVERTED.
    const lastUpdate = vi.mocked(prisma.bookingRequest.update).mock.calls.at(-1)?.[0]
      .data as Record<string, unknown>;
    expect(lastUpdate.status).toBe(BookingRequestStatus.CONVERTED);
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.approve_idempotent_replay" })
    );
  });

  it("runs the member-night conflict guard with linked guests before creating anything (issue #1158)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        linkedGuestMembers: [{ guestIndex: 0, memberId: "member-42" }],
      }) as never
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

    await approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });

    expect(mockedAssertNoConflicts).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        actorMemberId: "admin-1",
        actorRole: "ADMIN",
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        excludeBookingId: undefined,
      })
    );
    const guardGuests = mockedAssertNoConflicts.mock.calls[0][1].guests;
    expect(guardGuests).toHaveLength(1);
    expect(guardGuests[0]).toMatchObject({
      memberId: "member-42",
      stayStart: new Date("2026-08-01T00:00:00.000Z"),
      stayEnd: new Date("2026-08-03T00:00:00.000Z"),
    });
  });

  it("persists the linked custom-type member's rate snapshot at conversion (#1930, E4)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        guests: [
          { firstName: "Linked", lastName: "Member", ageTier: "ADULT" as const },
          { firstName: "Uma", lastName: "Unlinked", ageTier: "ADULT" as const },
        ],
        linkedGuestMembers: [{ guestIndex: 0, memberId: "member-42" }],
      }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedCheckCapacity.mockResolvedValue({
      available: true,
      minAvailable: 5,
      nightDetails: [],
    } as never);
    // The admin-linked member carries a CUSTOM MEMBER_RATE type via its
    // seasonal assignment; its snapshot must record that type's id.
    mockedMemberFindMany.mockResolvedValue([
      {
        id: "member-42",
        firstName: "Linked",
        lastName: "Member",
        email: "linked@example.test",
        role: "MEMBER",
        ageTier: "ADULT",
      },
    ] as never);
    vi.mocked(prisma.seasonalMembershipAssignment.findMany).mockResolvedValue([
      {
        memberId: "member-42",
        seasonYear: 2026,
        membershipType: {
          id: "type-club",
          key: "CLUB",
          name: "Club",
          isActive: true,
          isBuiltIn: false,
          bookingBehavior: "MEMBER_RATE",
          subscriptionBehavior: "REQUIRED",
        },
      },
    ] as never);
    vi.mocked(prisma.member.create).mockResolvedValue({ id: "member-1" } as never);
    vi.mocked(prisma.booking.create).mockResolvedValue({ id: "booking-1" } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);

    await approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });

    const bookingArgs = vi.mocked(prisma.booking.create).mock.calls[0][0]
      .data as Record<string, unknown>;
    const created = (bookingArgs.guests as { create: Array<Record<string, unknown>> })
      .create;
    // Snapshot-only: the admin-set price split stays exactly as stored.
    expect(created[0]).toMatchObject({
      memberId: "member-42",
      isMember: true,
      rateMembershipTypeId: "type-club",
      priceCents: 6000,
    });
    expect(created[1]).toMatchObject({
      isMember: false,
      rateMembershipTypeId: "type-nonmember",
      priceCents: 6000,
    });

    // Restore the suite defaults (clearAllMocks does not reset implementations).
    mockedMemberFindMany.mockResolvedValue([] as never);
    vi.mocked(prisma.seasonalMembershipAssignment.findMany).mockResolvedValue([] as never);
  });

  it("overwrites the hold-time snapshot when the reuse path swaps guest rows in place (#1930, E4)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        heldBookingId: "held-1",
      }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedBookingFindUnique.mockResolvedValue({
      id: "held-1",
      lodgeId: "lodge-1",
      memberId: "held-member",
      status: BookingStatus.AWAITING_REVIEW,
      // CT-4 group F1 (#2870): the reconcile judges the hosting party in the
      // BOOKING's season, and the real query selects `checkIn`/`checkOut`. These
      // doubles omitted them, and the retired `getSeasonYear(date = new Date())`
      // quietly substituted "now" for the missing value — so this reconcile was
      // being judged in whatever season the process was in rather than the
      // booking's. `seasonYearOfStoredDate` refuses instead of guessing, which is
      // what surfaced the gap.
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      // #2364: the accept reconciles the held booking's hosting review from
      // the guest rows it just rewrote. This double models the CONVERSION, not
      // the guest list, so an empty party is the honest answer here — the
      // review-writing behaviour is pinned by its own test above.
      guests: [],
      adultMemberHostingReview: null,
      adultMemberHostingReviewStatus: null,
    } as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-member",
      canLogin: false,
      role: "NON_MEMBER",
      archivedAt: null,
      active: true,
    } as never);
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([{ id: "g1" }] as never);
    vi.mocked(prisma.bookingGuest.update).mockResolvedValue({} as never);
    vi.mocked(prisma.booking.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);

    await approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });

    // The in-place guest swap writes the approval-time snapshot: the unlinked
    // guest resolves to the built-in NON_MEMBER type.
    const updateData = vi.mocked(prisma.bookingGuest.update).mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(updateData.rateMembershipTypeId).toBe("type-nonmember");
  });

  it("blocks approval and creates nothing when a linked member double-books (issue #1158)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        linkedGuestMembers: [{ guestIndex: 0, memberId: "member-42" }],
      }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedAssertNoConflicts.mockRejectedValueOnce(memberNightConflictError());

    await expect(
      approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" })
    ).rejects.toBeInstanceOf(BookingMemberNightConflictError);

    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(prisma.booking.create).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(mockedSendApproved).not.toHaveBeenCalled();
  });

  it("passes the held booking id as excludeBookingId on the reuse path (issue #1158)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        heldBookingId: "held-1",
        linkedGuestMembers: [{ guestIndex: 0, memberId: "member-42" }],
      }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedBookingFindUnique.mockResolvedValue({
      id: "held-1",
      lodgeId: "lodge-1",
      memberId: "held-member",
      status: BookingStatus.AWAITING_REVIEW,
      // CT-4 group F1 (#2870): the reconcile judges the hosting party in the
      // BOOKING's season, and the real query selects `checkIn`/`checkOut`. These
      // doubles omitted them, and the retired `getSeasonYear(date = new Date())`
      // quietly substituted "now" for the missing value — so this reconcile was
      // being judged in whatever season the process was in rather than the
      // booking's. `seasonYearOfStoredDate` refuses instead of guessing, which is
      // what surfaced the gap.
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      // #2364: the accept reconciles the held booking's hosting review from
      // the guest rows it just rewrote. This double models the CONVERSION, not
      // the guest list, so an empty party is the honest answer here — the
      // review-writing behaviour is pinned by its own test above.
      guests: [],
      adultMemberHostingReview: null,
      adultMemberHostingReviewStatus: null,
    } as never);
    // Held owner is re-validated at conversion (#1255 decision 1); still valid,
    // so it is reused unchanged.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-member",
      canLogin: false,
      role: "NON_MEMBER",
      archivedAt: null,
      active: true,
    } as never);
    // Held booking already has the request's guest rows; the reuse path updates
    // them in place (issue #1254) rather than deleteMany+recreate.
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([{ id: "g1" }] as never);
    vi.mocked(prisma.bookingGuest.update).mockResolvedValue({} as never);
    vi.mocked(prisma.booking.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);

    await approveBookingRequest({ requestId: "req-1", adminMemberId: "admin-1" });

    expect(mockedAssertNoConflicts).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ excludeBookingId: "held-1" })
    );
    // Reuse path preserves the held booking's guest rows (updates in place) and
    // does not destroy them, so bed allocations survive the accept (issue #1254).
    expect(prisma.bookingGuest.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "g1" } })
    );
    expect(prisma.bookingGuest.deleteMany).not.toHaveBeenCalled();
    // Reuse path updates the held booking (status-guarded updateMany, #1881)
    // rather than creating a fresh one.
    expect(prisma.booking.updateMany).toHaveBeenCalled();
    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it("ignores ownerContactMemberId on a held request and reuses a still-valid held owner (#1255/#1280)", async () => {
    // Once beds are held, the owner was materialised earlier (at hold/quote-send)
    // and persisted on the held booking. Approval reuses held.memberId and does
    // NOT re-run the map-or-create decision — the passed contact id is a no-op.
    // Decision 1 (#1255): the held owner IS re-validated at conversion; a
    // still-valid owner is reused unchanged (no substitution, no new member).
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        heldBookingId: "held-1",
      }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedBookingFindUnique.mockResolvedValue({
      id: "held-1",
      lodgeId: "lodge-1",
      memberId: "held-member",
      status: BookingStatus.AWAITING_REVIEW,
      // CT-4 group F1 (#2870): the reconcile judges the hosting party in the
      // BOOKING's season, and the real query selects `checkIn`/`checkOut`. These
      // doubles omitted them, and the retired `getSeasonYear(date = new Date())`
      // quietly substituted "now" for the missing value — so this reconcile was
      // being judged in whatever season the process was in rather than the
      // booking's. `seasonYearOfStoredDate` refuses instead of guessing, which is
      // what surfaced the gap.
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      // #2364: the accept reconciles the held booking's hosting review from
      // the guest rows it just rewrote. This double models the CONVERSION, not
      // the guest list, so an empty party is the honest answer here — the
      // review-writing behaviour is pinned by its own test above.
      guests: [],
      adultMemberHostingReview: null,
      adultMemberHostingReviewStatus: null,
    } as never);
    // Re-validation of the held owner: still a valid non-login contact.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-member",
      canLogin: false,
      role: "NON_MEMBER",
      archivedAt: null,
      active: true,
    } as never);
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([{ id: "g1" }] as never);
    vi.mocked(prisma.bookingGuest.update).mockResolvedValue({} as never);
    vi.mocked(prisma.booking.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);

    const result = await approveBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
      ownerContactMemberId: "some-other-contact",
    });

    // Owner stays the held booking's owner, not the passed contact.
    expect(result).toMatchObject({ type: "approved", memberId: "held-member" });
    // The guard re-validated the HELD owner (not the passed param); still valid,
    // so no fresh member was minted and no substitution was recorded.
    expect(prisma.member.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "held-member" } })
    );
    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(mockedLogAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.owner_substituted" })
    );
    // No substitution → no owner-substitution admin alert (#1377).
    expect(mockedSendOwnerSubstitution).not.toHaveBeenCalled();
  });

  it("substitutes a fresh contact when the held owner is no longer valid at conversion, and the accept still succeeds (#1255 decision 1)", async () => {
    // A mapped pre-existing contact was login-enabled/archived during the
    // quote→accept window. Re-validation fails, so instead of failing the
    // requester's accept the held booking is re-owned by a fresh non-login
    // contact and an admin-attention audit row is written.
    mockedFindUnique.mockResolvedValue(
      baseRequest({
        status: BookingRequestStatus.PRICED,
        priceCents: 12000,
        heldBookingId: "held-1",
      }) as never
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    mockedBookingFindUnique.mockResolvedValue({
      id: "held-1",
      lodgeId: "lodge-1",
      memberId: "held-invalid",
      status: BookingStatus.AWAITING_REVIEW,
      // CT-4 group F1 (#2870): the reconcile judges the hosting party in the
      // BOOKING's season, and the real query selects `checkIn`/`checkOut`. These
      // doubles omitted them, and the retired `getSeasonYear(date = new Date())`
      // quietly substituted "now" for the missing value — so this reconcile was
      // being judged in whatever season the process was in rather than the
      // booking's. `seasonYearOfStoredDate` refuses instead of guessing, which is
      // what surfaced the gap.
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      // #2364: the accept reconciles the held booking's hosting review from
      // the guest rows it just rewrote. This double models the CONVERSION, not
      // the guest list, so an empty party is the honest answer here — the
      // review-writing behaviour is pinned by its own test above.
      guests: [],
      adultMemberHostingReview: null,
      adultMemberHostingReviewStatus: null,
    } as never);
    // The held owner became login-capable → guard rejects it.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "held-invalid",
      canLogin: true,
      role: "USER",
      archivedAt: null,
      active: true,
    } as never);
    vi.mocked(prisma.member.create).mockResolvedValue({ id: "fresh-owner" } as never);
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([{ id: "g1" }] as never);
    vi.mocked(prisma.bookingGuest.update).mockResolvedValue({} as never);
    vi.mocked(prisma.booking.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
    vi.mocked(prisma.bookingRequest.update).mockResolvedValue({} as never);

    const result = await approveBookingRequest({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });

    // Accept succeeds; the booking is now owned by the fresh substitute.
    expect(result).toMatchObject({ type: "approved", memberId: "fresh-owner" });
    const freshArgs = vi.mocked(prisma.member.create).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(freshArgs.canLogin).toBe(false);
    expect(freshArgs.role).toBe("NON_MEMBER");
    // The held booking is repointed at the substitute owner (#1881 updateMany).
    const updateArgs = vi.mocked(prisma.booking.updateMany).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(updateArgs.memberId).toBe("fresh-owner");
    // Admin-attention audit row recording the substitution.
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.owner_substituted",
        metadata: expect.objectContaining({
          invalidMemberId: "held-invalid",
          substituteMemberId: "fresh-owner",
        }),
      })
    );
    // #1377: an active admin email alert also fires post-commit (fire-and-forget,
    // outside the tx) so the finance/Xero admin reconciles the invoice's contact.
    expect(mockedSendOwnerSubstitution).toHaveBeenCalledTimes(1);
    expect(mockedSendOwnerSubstitution).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-1",
        bookingId: "held-1",
        intendedMemberId: "held-invalid",
        substituteMemberId: "fresh-owner",
      })
    );
  });
});

describe("assertMappableOwnerContact (real #1255 guard)", () => {
  function txWith(contact: Record<string, unknown> | null) {
    return {
      member: { findUnique: vi.fn().mockResolvedValue(contact) },
    } as never;
  }

  it("returns the id for a valid non-login NON_MEMBER contact", async () => {
    await expect(
      assertMappableOwnerContact(
        txWith({
          id: "c1",
          canLogin: false,
          role: "NON_MEMBER",
          archivedAt: null,
          active: true,
        }),
        "c1"
      )
    ).resolves.toBe("c1");
  });

  it("returns the id for a valid non-login SCHOOL contact (cross-type allowed, #1255 decision 2)", async () => {
    await expect(
      assertMappableOwnerContact(
        txWith({
          id: "s1",
          canLogin: false,
          role: "SCHOOL",
          archivedAt: null,
          active: true,
        }),
        "s1"
      )
    ).resolves.toBe("s1");
  });

  it("throws 404 when the contact does not exist", async () => {
    await expect(
      assertMappableOwnerContact(txWith(null), "missing")
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a login-capable member (422)", async () => {
    await expect(
      assertMappableOwnerContact(
        txWith({ id: "m1", canLogin: true, role: "USER", archivedAt: null, active: true }),
        "m1"
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects a role that is neither NON_MEMBER nor SCHOOL (422)", async () => {
    await expect(
      assertMappableOwnerContact(
        txWith({ id: "m1", canLogin: false, role: "USER", archivedAt: null, active: true }),
        "m1"
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects an archived contact (422)", async () => {
    await expect(
      assertMappableOwnerContact(
        txWith({
          id: "c1",
          canLogin: false,
          role: "NON_MEMBER",
          archivedAt: new Date("2026-01-01T00:00:00.000Z"),
          active: true,
        }),
        "c1"
      )
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects an inactive contact (422)", async () => {
    await expect(
      assertMappableOwnerContact(
        txWith({
          id: "c1",
          canLogin: false,
          role: "NON_MEMBER",
          archivedAt: null,
          active: false,
        }),
        "c1"
      )
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("purgeExpiredBookingRequests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("purges declined, never-verified and member-withdrawn requests past the retention window and audits the result", async () => {
    mockedDeleteMany
      .mockResolvedValueOnce({ count: 2 } as never)
      .mockResolvedValueOnce({ count: 3 } as never)
      .mockResolvedValueOnce({ count: 4 } as never);

    const now = new Date("2026-09-01T00:00:00.000Z");
    const result = await purgeExpiredBookingRequests(now);

    expect(result).toEqual({
      declinedPurged: 2,
      neverVerifiedPurged: 3,
      memberWithdrawnPurged: 4,
    });

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
    // #2263 / owner decision OD-B: a member-WITHDRAWN whole-lodge request
    // (CANCELLED) now purges on the same 90-day clock as a declined one, so
    // "My requests" is a bounded history rather than a permanent record. Scoped
    // to member-origin rows: a PUBLIC request also reaches CANCELLED (the
    // requester cancelling their own quote) and OD-B did not decide retention
    // for that flow, so widening the sweep would silently change it.
    expect(mockedDeleteMany).toHaveBeenNthCalledWith(3, {
      where: {
        status: BookingRequestStatus.CANCELLED,
        requestedByMemberId: { not: null },
        updatedAt: { lte: cutoff },
      },
    });
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking_request.retention_purge",
        metadata: expect.objectContaining({
          declinedPurged: 2,
          neverVerifiedPurged: 3,
          memberWithdrawnPurged: 4,
        }),
      })
    );
  });

  it("does not write an audit log when nothing was purged", async () => {
    mockedDeleteMany.mockResolvedValue({ count: 0 } as never);

    const result = await purgeExpiredBookingRequests(new Date("2026-09-01T00:00:00.000Z"));

    expect(result).toEqual({
      declinedPurged: 0,
      neverVerifiedPurged: 0,
      memberWithdrawnPurged: 0,
    });
    expect(mockedLogAudit).not.toHaveBeenCalled();
  });
});
