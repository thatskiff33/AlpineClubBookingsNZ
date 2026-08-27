// Route-level wiring tests for issue #1756: member deactivation (member edit,
// bulk update, account-deletion anonymisation) and an ADULT→minor tier
// correction must sweep the member's FUTURE shared double-bed second-occupant
// allocations back to the awaiting-allocation queue and alert admins. The
// REAL sweep helper (bed-allocation-lifecycle.ts) runs here against a mocked
// Prisma so the query/delete wiring is exercised end-to-end; the helper's own
// edge cases live in bed-allocation-lifecycle.test.ts and the dissolve paths
// in member-partner-link.test.ts. Mock harness mirrors
// admin-account-guards-routes.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seasonalMembershipAssignment: { findUnique: vi.fn().mockResolvedValue(null) },
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      // Read inside the mutation transactions below (deletion anonymisation's
      // family-link orphan sweep, and since #2716 the email-inheritance
      // re-resolution every member write runs). Defaulted to no rows — and
      // re-defaulted per test, since `clearAllMocks` keeps implementations —
      // so a fixture that names nobody means exactly that.
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    deletionRequest: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    booking: { findMany: vi.fn().mockResolvedValue([]) },
    bookingGuest: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      // #2106: the N/A-flip linked-guest block queries future linked-guest
      // bookings; default to none.
      findMany: vi.fn().mockResolvedValue([]),
    },
    accessRoleDefinition: { findMany: vi.fn().mockResolvedValue([]) },
    memberAccessRole: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    familyGroupMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    bedAllocation: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    xeroContactCache: { findUnique: vi.fn().mockResolvedValue(null) },
    xeroSyncOperation: { findFirst: vi.fn().mockResolvedValue(null) },
    xeroObjectLink: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    // CT-4 (#2870): both routes driven here resolve a "future" cut-off from the
    // club's PERSISTED timezone. Without this delegate
    // `loadPersistedClubTimeSettings()` returns null -- fail-soft by design --
    // and they fall back to the container's `TZ` in silence.
    clubTimeSettings: { findUnique: vi.fn() },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
  },
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// #2576 §8: the lifecycle change records the coverage re-evaluation it owes.
const hostingMocks = vi.hoisted(() => ({
  fanout: vi.fn(async (...args: unknown[]) => {
    void args;
    return 1;
  }),
  drain: vi.fn(async (...args: unknown[]) => {
    void args;
  }),
}));

// #2576 §8. "Membership becoming inactive, lapsed, cancelled or archived" is the FIRST
// change class the owner's decision names, and only the evaluator half of it was
// automatic — an archived or cancelled member correctly stops qualifying as an adult
// host, while nothing told the club to go and look at the bookings that had been relying
// on them. The lifecycle paths now record that obligation inside their own transaction,
// which means they read the bookings this person ATTENDS through the caller's `tx` — and
// this suite drives that transaction with a fake carrying only the lifecycle delegates.
//
// Mocked at the module boundary so the assertion here can be about the thing that
// belongs here: that the change RECORDS the re-evaluation and is never refused by it.
// What the re-evaluation then concludes is the hosting suites' subject.
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueHostingCoverageReevaluationForMember: (...args: unknown[]) =>
    hostingMocks.fanout(...args),
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: (...args: unknown[]) =>
    hostingMocks.drain(...args),
}));

vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
  syncManagedXeroContactGroupForMember: vi.fn(),
  updateXeroContact: vi.fn(),
}));
vi.mock("@/lib/booking-cancel", () => ({
  cancelBooking: vi.fn().mockResolvedValue({ status: 200 }),
}));
vi.mock("@/lib/email", () => ({
  sendAccountDeletionApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendAccountDeletionRejectedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminPartnerShareSweptAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditEmailDomain: vi.fn(() => null),
  getAuditRequestContext: vi.fn(() => ({ ipAddress: "127.0.0.1" })),
  createAuditLog: vi.fn(),
  createStructuredAuditLog: vi.fn(),
  logAudit: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/audit";
import { sendAdminPartnerShareSweptAlert } from "@/lib/email";
import { PUT as updateMember } from "@/app/api/admin/members/[id]/route";
import { POST as bulkUpdate } from "@/app/api/admin/members/bulk-update/route";
import { POST as reviewDeletion } from "@/app/api/admin/deletion-requests/[id]/route";
import { APP_TIME_ZONE } from "@/config/operational";
import { getTodayDateOnly } from "@/lib/date-only";

const fullAdminGuard = {
  ok: true,
  session: { user: { id: "actor1", role: "ADMIN", accessRoles: ["ADMIN"] } },
};

const userTarget = {
  id: "user2",
  firstName: "Uma",
  lastName: "User",
  email: "uma@test.com",
  phoneCountryCode: null,
  phoneAreaCode: null,
  phoneNumber: null,
  dateOfBirth: null,
  role: "USER",
  financeAccessLevel: "NONE",
  accessRoles: [{ role: "USER" }],
  ageTier: "ADULT",
  active: true,
  forcePasswordChange: false,
  canLogin: true,
  cancelledAt: null,
  archivedAt: null,
  xeroContactId: null,
  joinedDate: null,
  createdAt: new Date("2025-01-01"),
};

const FUTURE_NIGHT = new Date("2026-08-01T00:00:00.000Z");

// Uma is the second occupant of a double whose primary is her (now ex-)
// partner Piotr, on another booking.
const umaSecondOccupantRow = {
  id: "alloc-uma-2nd",
  bookingId: "booking-uma",
  bookingGuestId: "guest-uma",
  bedId: "bed-double",
  roomId: "room-1",
  stayDate: FUTURE_NIGHT,
  bookingGuest: { memberId: "user2", firstName: "Uma", lastName: "User" },
};
const piotrPrimaryRow = {
  id: "alloc-piotr-primary",
  bookingId: "booking-piotr",
  bookingGuestId: "guest-piotr",
  bedId: "bed-double",
  roomId: "room-1",
  stayDate: FUTURE_NIGHT,
  bookingGuest: { memberId: "member-p", firstName: "Piotr", lastName: "Pine" },
};

/** Serve the sweep's queries: Uma is a second occupant; Piotr her primary. */
function mockSharedDoubleForUser2() {
  vi.mocked(prisma.bedAllocation.findMany).mockImplementation((async (args: {
    where?: {
      isSecondOccupant?: boolean;
      OR?: unknown;
      bookingGuest?: { memberId?: { in?: string[] } };
    };
  }) => {
    const where = args?.where ?? {};
    if (where.isSecondOccupant === true) return [umaSecondOccupantRow];
    if (where.isSecondOccupant === false && where.OR) return [piotrPrimaryRow];
    if (where.bookingGuest?.memberId?.in) {
      return [{ room: { lodgeId: "lodge-1" } }];
    }
    return [];
  }) as never);
  vi.mocked(prisma.bedAllocation.deleteMany).mockResolvedValue({ count: 1 } as never);
}

function jsonRequest(url: string, body: Record<string, unknown>, method = "POST") {
  return new NextRequest(url, {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function putMember(id: string, body: Record<string, unknown>) {
  return updateMember(
    jsonRequest(`http://localhost/api/admin/members/${id}`, body, "PUT"),
    { params: Promise.resolve({ id }) },
  );
}

function mockTransaction() {
  vi.mocked(prisma.$transaction).mockImplementation((async (op: any) =>
    op({
      $executeRaw: prisma.$executeRaw,
      member: {
        findUnique: prisma.member.findUnique,
        update: prisma.member.update,
        updateMany: prisma.member.updateMany,
        count: prisma.member.count,
        // #2255: deletion anonymisation now reads who it is about to detach
        // (before nulling their pointers) and sweeps the inheritance aimed at
        // the anonymised member, so it would otherwise keep hard-bouncing club
        // email off the @deleted.invalid address forever.
        // #2716: the member edit reads through the same delegate, re-resolving
        // its own pointer and its dependants' inside the write's transaction.
        findMany: prisma.member.findMany,
      },
      memberAccessRole: {
        createMany: prisma.memberAccessRole.createMany,
        deleteMany: prisma.memberAccessRole.deleteMany,
      },
      familyGroupMember: { deleteMany: prisma.familyGroupMember.deleteMany },
      bookingGuest: { updateMany: prisma.bookingGuest.updateMany },
      // #2620: anonymisation revokes every outstanding credential artefact in
      // the same commit — each authenticates on its own, and deletion used to
      // leave them all live.
      magicLinkToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      passwordResetToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      emailChangeToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      twoFactorEmailCode: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      twoFactorRecoveryCode: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      twoFactorSessionChallenge: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      bedAllocation: prisma.bedAllocation,
      deletionRequest: {
        update: prisma.deletionRequest.update,
        updateMany: prisma.deletionRequest.updateMany,
      },
      xeroSyncOperation: prisma.xeroSyncOperation,
      xeroObjectLink: prisma.xeroObjectLink,
      auditLog: { create: prisma.auditLog.create },
    })) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(fullAdminGuard);
  vi.mocked(prisma.member.count).mockResolvedValue(0);
  vi.mocked(prisma.member.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.deletionRequest.updateMany).mockResolvedValue({ count: 1 });
  vi.mocked(prisma.booking.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.bedAllocation.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.bedAllocation.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.member.update).mockResolvedValue({
    ...userTarget,
    active: false,
  } as never);
  mockTransaction();
});

describe("#1756 member edit deactivate — PUT /api/admin/members/[id]", () => {
  it("sweeps the member's future shared-double placement and alerts admins", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue(userTarget as never);
    mockSharedDoubleForUser2();

    const res = await putMember("user2", { active: false });

    expect(res.status).toBe(200);
    expect(prisma.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["alloc-uma-2nd"] }, isSecondOccupant: true },
    });
    // Both bookings audited by the sweep.
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BED_ALLOCATION_PARTNER_SHARE_SWEPT",
        entityId: "booking-uma",
      }),
      expect.anything(),
    );
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BED_ALLOCATION_PARTNER_SHARE_SWEPT",
        entityId: "booking-piotr",
      }),
      expect.anything(),
    );
    expect(sendAdminPartnerShareSweptAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Uma User",
        partnerName: "Piotr Pine",
        reason: "Member deactivated",
        nights: [FUTURE_NIGHT],
      }),
    );
  });

  it("sweeps on an ADULT → minor tier correction (same defect class)", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue(userTarget as never);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...userTarget,
      ageTier: "YOUTH",
    } as never);
    mockSharedDoubleForUser2();

    const res = await putMember("user2", { ageTier: "YOUTH" });

    expect(res.status).toBe(200);
    expect(prisma.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["alloc-uma-2nd"] }, isSecondOccupant: true },
    });
    expect(sendAdminPartnerShareSweptAlert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "Member is no longer an adult" }),
    );
  });

  it("does not touch allocations on an edit that neither deactivates nor re-tiers", async () => {
    vi.mocked(prisma.member.findUnique).mockResolvedValue(userTarget as never);
    vi.mocked(prisma.member.update).mockResolvedValue(userTarget as never);

    const res = await putMember("user2", { firstName: "Uma", active: true });

    expect(res.status).toBe(200);
    expect(prisma.bedAllocation.findMany).not.toHaveBeenCalled();
    expect(prisma.bedAllocation.deleteMany).not.toHaveBeenCalled();
    expect(sendAdminPartnerShareSweptAlert).not.toHaveBeenCalled();
  });
});

describe("#1756 bulk deactivate — POST /api/admin/members/bulk-update", () => {
  it("sweeps each deactivated member's shared placements and alerts admins", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([userTarget] as never);
    // Another Full Admin survives the set.
    vi.mocked(prisma.member.count).mockResolvedValue(2 as never);
    vi.mocked(prisma.member.updateMany).mockResolvedValue({ count: 1 } as never);
    mockSharedDoubleForUser2();

    const res = await bulkUpdate(
      jsonRequest("http://localhost/api/admin/members/bulk-update", {
        ids: ["user2"],
        action: "deactivate",
      }),
    );

    expect(res.status).toBe(200);
    expect(prisma.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["alloc-uma-2nd"] }, isSecondOccupant: true },
    });
    expect(sendAdminPartnerShareSweptAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Uma User",
        partnerName: "Piotr Pine",
        reason: "Member deactivated",
      }),
    );
  });

  it("does not sweep on reactivate", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      { ...userTarget, active: false },
    ] as never);
    vi.mocked(prisma.member.updateMany).mockResolvedValue({ count: 1 } as never);

    const res = await bulkUpdate(
      jsonRequest("http://localhost/api/admin/members/bulk-update", {
        ids: ["user2"],
        action: "reactivate",
      }),
    );

    expect(res.status).toBe(200);
    expect(prisma.bedAllocation.findMany).not.toHaveBeenCalled();
    expect(sendAdminPartnerShareSweptAlert).not.toHaveBeenCalled();
  });
});

// #2106 (MAJOR-5b): a bulk set-role ORG grant that would flip a non-N/A member
// TO N/A is blocked while they hold future linked-guest bookings on someone
// else's booking. The member is reported as a per-member failure (like
// notFound) and the rest of the batch still applies.
describe("#2106 bulk set-role ORG grant — linked-guest N/A block", () => {
  const futureLinkedGuestRow = {
    id: "bg-uma",
    bookingId: "booking-other",
    stayStart: FUTURE_NIGHT,
    stayEnd: FUTURE_NIGHT,
    booking: {
      id: "booking-other",
      memberId: "member-owner",
      checkIn: FUTURE_NIGHT,
      checkOut: FUTURE_NIGHT,
    },
  };

  it("blocks the ORG grant and reports the member without touching their role", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([userTarget] as never);
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([
      futureLinkedGuestRow,
    ] as never);

    const res = await bulkUpdate(
      jsonRequest("http://localhost/api/admin/members/bulk-update", {
        ids: ["user2"],
        action: "set-role",
        role: "SCHOOL",
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(0);
    expect(body.blockedLinkedGuests).toEqual([
      expect.objectContaining({
        memberId: "user2",
        memberName: "Uma User",
        linkedGuestCount: 1,
      }),
    ]);
    // The blocked member's role/tier was never written.
    expect(prisma.member.update).not.toHaveBeenCalled();
    expect(prisma.bedAllocation.deleteMany).not.toHaveBeenCalled();
    expect(sendAdminPartnerShareSweptAlert).not.toHaveBeenCalled();
  });

  it("proceeds with the ORG grant (forcing N/A) when there are no linked-guest bookings", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([userTarget] as never);
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...userTarget,
      role: "SCHOOL",
      ageTier: "NOT_APPLICABLE",
    } as never);
    mockSharedDoubleForUser2();

    const res = await bulkUpdate(
      jsonRequest("http://localhost/api/admin/members/bulk-update", {
        ids: ["user2"],
        action: "set-role",
        role: "SCHOOL",
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);
    expect(body.blockedLinkedGuests).toEqual([]);
    // ORG grant forces N/A; leaving ADULT sweeps the future shared-double.
    expect(prisma.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ageTier: "NOT_APPLICABLE" }),
      }),
    );
    expect(prisma.bedAllocation.deleteMany).toHaveBeenCalled();
  });
});

/*
  CT-4 (#2870), epic #2988 -- WHICH day the linked-guest block measures "future"
  from.

  The block above decides whether an ORG grant is refused, and it is refused
  exactly when the member still holds a future linked-guest booking on someone
  else's stay. `BookingGuest.stayEnd` is `@db.Date`, so the cut-off has to be a
  calendar day, and `INV-CONFIG-002` says the day comes from the persisted
  `ClubTimeSettings.timeZone` rather than the container's `TZ`. A day either way
  moves a real stay across the line and changes who the batch refuses.

  The two cases above cannot see this: they stub `bookingGuest.findMany` to a
  fixed answer, so the cut-off they were queried with never enters the result.
  This one reads the bound itself.
*/
describe("bulk set-role linked-guest cut-off comes from the persisted club zone (CT-4, #2870)", () => {
  it("bounds the linked-guest query by the club's day, not the container's", async () => {
    vi.mocked(prisma.clubTimeSettings.findUnique).mockResolvedValue({
      timeZone: "America/Denver",
      updatedByMemberId: null,
      updatedAt: new Date(0),
    } as never);

    // The premise, measured as an ANSWER rather than a zone identifier: two
    // zone names can still name the same day, and then this proves nothing.
    /*
     * `APP_TIME_ZONE` PASSED ON PURPOSE (#3123). Everywhere else an explicit
     * zone exists to get OFF the environment; here the environment IS the
     * subject of the assertion — the line measures what the environment
     * authority answers so it can prove the persisted zone answers differently.
     * A literal zone name here would assert something about that name instead,
     * and the premise would stop tracking the environment it is guarding.
     */
    expect(
      getTodayDateOnly(APP_TIME_ZONE).toISOString(),
      "INV-CONFIG-002: the environment authority now names the same day as the " +
        "persisted club zone, so this bound cannot tell the two apart.",
    ).not.toBe("2026-06-30T00:00:00.000Z");

    vi.mocked(prisma.member.findMany).mockResolvedValue([userTarget] as never);
    vi.mocked(prisma.bookingGuest.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...userTarget,
      role: "SCHOOL",
      ageTier: "NOT_APPLICABLE",
    } as never);

    const res = await bulkUpdate(
      jsonRequest("http://localhost/api/admin/members/bulk-update", {
        ids: ["user2"],
        action: "set-role",
        role: "SCHOOL",
      }),
    );
    expect(res.status).toBe(200);

    // The frozen clock is 2026-07-01T00:00:00Z -- midday on 1 July in New
    // Zealand, still the evening of 30 JUNE in Denver -- so the club's day is
    // the 30th, encoded as UTC midnight for the `@db.Date` bound. The
    // environment would have said 1 July, and a stay ending on 30 June would
    // have stopped counting a day early.
    const guestQuery = vi.mocked(prisma.bookingGuest.findMany).mock
      .calls[0][0] as unknown as { where: { stayEnd: { gt: Date } } };
    expect(guestQuery.where.stayEnd.gt.toISOString()).toBe(
      "2026-06-30T00:00:00.000Z",
    );
  });
});

describe("#1756 deletion approval — POST /api/admin/deletion-requests/[id]", () => {
  it("sweeps BEFORE the guest rows are anonymised, and alerts with the pre-anonymisation name", async () => {
    vi.mocked(prisma.deletionRequest.findUnique).mockResolvedValue({
      id: "dr1",
      status: "PENDING",
      member: userTarget,
    } as never);
    mockSharedDoubleForUser2();

    const res = await reviewDeletion(
      jsonRequest("http://localhost/api/admin/deletion-requests/dr1", {
        action: "approve",
      }),
      { params: Promise.resolve({ id: "dr1" }) },
    );

    expect(res.status).toBe(200);
    expect(prisma.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["alloc-uma-2nd"] }, isSecondOccupant: true },
    });
    // The sweep must read bookingGuest.memberId before step 5 nulls it.
    const sweepOrder =
      vi.mocked(prisma.bedAllocation.deleteMany).mock.invocationCallOrder[0];
    const anonymiseOrder =
      vi.mocked(prisma.bookingGuest.updateMany).mock.invocationCallOrder[0];
    expect(sweepOrder).toBeLessThan(anonymiseOrder);
    expect(sendAdminPartnerShareSweptAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Uma User",
        partnerName: "Piotr Pine",
        reason: "Member deactivated",
      }),
    );
  });
});
