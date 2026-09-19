/**
 * Issue #1376 (F15) — bookings-scoped on-behalf family pickers.
 *
 * These endpoints decouple on-behalf family selection from `membership:view`:
 * they are gated on `bookings:edit` and serve exactly one member's family group
 * via the shared resolveMemberFamily() helper, so a Booking Officer whose
 * customised role dropped membership:view can still attach the correct member
 * identity (→ correct member pricing) instead of re-adding the member as a
 * mispriced non-member.
 *
 * Covered here:
 *   - a bookings:edit actor WITHOUT membership:view gets the family (200, shape)
 *   - a membership-only viewer (no bookings:edit) is rejected (403)
 *   - a bookings VIEWER (not editor) is rejected (explicit edit gate)
 *   - EDIT flow resolves the member id SERVER-SIDE from the booking
 *   - CREATE flow resolves the member id from forMemberId (validated)
 *   - a single member's family group is returned (no directory enumeration)
 *   - #2721: the payload also carries THAT member's own recorded dependants,
 *     read by the same loader the create route re-runs, so the admin booking
 *     screen can draw the own-dependant question an officer is now asked
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // #2721: `findMany` is `loadBookerDependants`'s seam — the parent-link
    // query that answers "who are THIS member's dependants?". It is part of the
    // payload now, so a suite that left it undefined would fail at import of the
    // widened module graph rather than on an assertion.
    member: { findUnique: vi.fn(), findMany: vi.fn() },
    familyGroupMember: { findMany: vi.fn() },
    booking: { findUnique: vi.fn() },
    // #1746: the eligible-family payload also lists partner-sharer candidates.
    bookingGuest: { findMany: vi.fn().mockResolvedValue([]) },
    memberPartnerLink: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

// A requireAdmin mock that HONORS the explicit permission option (unlike the
// generic portal-only mock helper), so the bookings:edit gate is exercised for
// real via the shared hasAdminAreaAccess matrix logic.
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async (options?: {
    permission?: { area: string; level: "view" | "edit" };
  }) => {
    const { auth } = await import("@/lib/auth");
    const { hasAdminAreaAccess, hasAdminPortalAccess } = await import(
      "@/lib/admin-permissions"
    );
    const session = await auth();
    if (!session?.user?.id) {
      return {
        ok: false as const,
        response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      };
    }
    const allowed = options?.permission
      ? hasAdminAreaAccess(
          session.user,
          options.permission as { area: never; level: "view" | "edit" },
        )
      : hasAdminPortalAccess(session.user);
    if (!allowed) {
      return {
        ok: false as const,
        response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      };
    }
    return { ok: true as const, session };
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { GET as getEditFamily } from "@/app/api/admin/bookings/[id]/eligible-family/route";
import { GET as getCreateFamily } from "@/app/api/admin/bookings/eligible-family/route";

const mockPrisma = prisma as unknown as {
  member: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  familyGroupMember: { findMany: ReturnType<typeof vi.fn> };
  booking: { findUnique: ReturnType<typeof vi.fn> };
};
const mockAuth = auth as ReturnType<typeof vi.fn>;

function matrix(overrides: Record<string, "none" | "view" | "edit">) {
  return {
    overview: "view",
    bookings: "none",
    membership: "none",
    finance: "none",
    lodge: "none",
    content: "none",
    support: "none",
    ...overrides,
  };
}

// A Booking Officer whose customised role has membership:view removed.
const bookingOfficerNoMembershipView = {
  user: {
    id: "officer1",
    accessRoles: [],
    adminPermissionMatrix: matrix({ bookings: "edit", membership: "none" }),
  },
};
// A membership viewer with NO bookings access.
const membershipViewerNoBookings = {
  user: {
    id: "mv1",
    accessRoles: [],
    adminPermissionMatrix: matrix({ membership: "edit", bookings: "none" }),
  },
};
// A bookings VIEWER (view, not edit).
const bookingsViewerOnly = {
  user: {
    id: "bv1",
    accessRoles: [],
    adminPermissionMatrix: matrix({ bookings: "view" }),
  },
};

const OWNER = {
  id: "owner1",
  firstName: "Olivia",
  lastName: "Owner",
  ageTier: "ADULT",
  active: true,
  archivedAt: null,
  familyGroupMemberships: [
    { familyGroupId: "g1", familyGroup: { id: "g1", name: "Owner Family" } },
  ],
};

/** One member recorded as the owner's dependant by a parent link (#2721). */
const OWN_DEPENDANT = { id: "d1", firstName: "Sam", lastName: "Owner" };

function mockOwnerFamily() {
  mockPrisma.member.findUnique.mockResolvedValue(OWNER);
  mockPrisma.member.findMany.mockResolvedValue([OWN_DEPENDANT]);
  mockPrisma.familyGroupMember.findMany.mockResolvedValue([
    { member: { id: "p1", firstName: "Pat", lastName: "Owner", ageTier: "ADULT" } },
    { member: { id: "c1", firstName: "Casey", lastName: "Owner", ageTier: "CHILD" } },
  ]);
}

function editReq() {
  return new NextRequest(
    "http://localhost/api/admin/bookings/bk1/eligible-family",
  );
}
function editParams(id = "bk1") {
  return { params: Promise.resolve({ id }) };
}
function createReq(forMemberId?: string) {
  const url = new URL("http://localhost/api/admin/bookings/eligible-family");
  if (forMemberId !== undefined) url.searchParams.set("forMemberId", forMemberId);
  return new NextRequest(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default for the cases that do not set up a family: no recorded dependants.
  mockPrisma.member.findMany.mockResolvedValue([]);
});

// ─── EDIT flow: GET /api/admin/bookings/[id]/eligible-family ──────────────────

describe("GET /api/admin/bookings/[id]/eligible-family", () => {
  it("serves the booking owner's family to a bookings:edit actor WITHOUT membership:view", async () => {
    mockAuth.mockResolvedValue(bookingOfficerNoMembershipView);
    mockPrisma.booking.findUnique.mockResolvedValue({ memberId: "owner1" });
    mockOwnerFamily();

    const res = await getEditFamily(editReq(), editParams("bk1"));
    const data = await res.json();

    expect(res.status).toBe(200);
    // Shape parity with the existing picker.
    expect(data.familyGroupId).toBe("g1");
    expect(data.familyGroupName).toBe("Owner Family");
    expect(data.familyGroupIds).toEqual(["g1"]);
    // self + 1 partner + 1 dependent = 3, single member's family group only.
    expect(data.familyMembers).toHaveLength(3);
    expect(data.familyMembers[0]).toMatchObject({
      id: "owner1",
      relationship: "self",
    });
    expect(
      data.familyMembers.map((m: { relationship: string }) => m.relationship),
    ).toEqual(["self", "partner", "dependent"]);
  });

  it("resolves the member id SERVER-SIDE from the booking (not from the client)", async () => {
    mockAuth.mockResolvedValue(bookingOfficerNoMembershipView);
    mockPrisma.booking.findUnique.mockResolvedValue({ memberId: "owner1" });
    mockOwnerFamily();

    await getEditFamily(editReq(), editParams("bk1"));

    // The booking was looked up by its route id, and the family was resolved
    // for the booking's own memberId — never a client-supplied member id.
    expect(mockPrisma.booking.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "bk1" } }),
    );
    expect(mockPrisma.member.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "owner1" } }),
    );
  });

  it("returns 404 when the booking does not exist", async () => {
    mockAuth.mockResolvedValue(bookingOfficerNoMembershipView);
    mockPrisma.booking.findUnique.mockResolvedValue(null);

    const res = await getEditFamily(editReq(), editParams("missing"));
    expect(res.status).toBe(404);
    expect(mockPrisma.member.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a membership viewer with no bookings:edit (403)", async () => {
    mockAuth.mockResolvedValue(membershipViewerNoBookings);

    const res = await getEditFamily(editReq(), editParams("bk1"));
    expect(res.status).toBe(403);
    expect(mockPrisma.booking.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a bookings VIEWER (view, not edit) (403)", async () => {
    mockAuth.mockResolvedValue(bookingsViewerOnly);

    const res = await getEditFamily(editReq(), editParams("bk1"));
    expect(res.status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await getEditFamily(editReq(), editParams("bk1"));
    expect(res.status).toBe(401);
  });
});

// ─── CREATE flow: GET /api/admin/bookings/eligible-family?forMemberId= ────────

describe("GET /api/admin/bookings/eligible-family", () => {
  it("serves the target member's family from forMemberId to a bookings:edit actor WITHOUT membership:view", async () => {
    mockAuth.mockResolvedValue(bookingOfficerNoMembershipView);
    mockOwnerFamily();

    const res = await getCreateFamily(createReq("owner1"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.familyGroupIds).toEqual(["g1"]);
    expect(data.familyMembers).toHaveLength(3);
    // The single member named by forMemberId — no directory enumeration.
    expect(mockPrisma.member.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "owner1" } }),
    );
  });

  /*
    #2721 — the own-dependant question on the admin booking screen.

    An officer booking on a member's behalf is now asked the same question the
    member is asked in their own wizard (owner decision, D1 option A,
    15 Sep 2026). A question the screen cannot draw is a refusal with no way
    through, so the candidate set has to reach the screen — and it has to be the
    RIGHT one.
  */
  it("carries the target member's own recorded dependants, for the question the officer is now asked", async () => {
    mockAuth.mockResolvedValue(bookingOfficerNoMembershipView);
    mockOwnerFamily();

    const res = await getCreateFamily(createReq("owner1"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ownDependants).toEqual([OWN_DEPENDANT]);
  });

  it("reads the dependants of the member named by forMemberId, never of the signed-in officer", async () => {
    // The disclosure half of `INV-GUEST-019`. Asking the officer's own parent
    // links would both miss every real collision on this booking and put the
    // officer's own children on somebody else's screen.
    mockAuth.mockResolvedValue(bookingOfficerNoMembershipView);
    mockOwnerFamily();

    await getCreateFamily(createReq("owner1"));

    expect(mockPrisma.member.findMany).toHaveBeenCalledTimes(1);
    const where = mockPrisma.member.findMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      active: true,
      OR: [{ parentMemberId: "owner1" }, { secondaryParentId: "owner1" }],
    });
    expect(JSON.stringify(where)).not.toContain("officer1");
  });

  it("treats a memberless family group as invisible — a group-less member resolves to self only (#1681)", async () => {
    mockAuth.mockResolvedValue(bookingOfficerNoMembershipView);
    // A pending GROUP_CREATE leaves a memberless FamilyGroup row behind; it
    // has no FamilyGroupMember rows, so it can never surface through
    // familyGroupMemberships and booking eligibility is untouched.
    mockPrisma.member.findUnique.mockResolvedValue({
      ...OWNER,
      familyGroupMemberships: [],
    });

    const res = await getCreateFamily(createReq("owner1"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.familyGroupId).toBeNull();
    expect(data.familyGroupIds).toEqual([]);
    expect(data.familyMembers).toHaveLength(1);
    expect(data.familyMembers[0]).toMatchObject({
      id: "owner1",
      relationship: "self",
    });
    expect(mockPrisma.familyGroupMember.findMany).not.toHaveBeenCalled();
  });

  it("returns 400 when forMemberId is missing", async () => {
    mockAuth.mockResolvedValue(bookingOfficerNoMembershipView);

    const res = await getCreateFamily(createReq());
    expect(res.status).toBe(400);
    expect(mockPrisma.member.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 when the target member does not exist / is inactive", async () => {
    mockAuth.mockResolvedValue(bookingOfficerNoMembershipView);
    mockPrisma.member.findUnique.mockResolvedValue(null);

    const res = await getCreateFamily(createReq("ghost"));
    expect(res.status).toBe(404);
  });

  it("rejects a membership viewer with no bookings:edit (403)", async () => {
    mockAuth.mockResolvedValue(membershipViewerNoBookings);

    const res = await getCreateFamily(createReq("owner1"));
    expect(res.status).toBe(403);
    expect(mockPrisma.member.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a bookings VIEWER (view, not edit) (403)", async () => {
    mockAuth.mockResolvedValue(bookingsViewerOnly);

    const res = await getCreateFamily(createReq("owner1"));
    expect(res.status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await getCreateFamily(createReq("owner1"));
    expect(res.status).toBe(401);
  });
});
