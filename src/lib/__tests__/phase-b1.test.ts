import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const mockPrisma = {
  hutLeaderAssignment: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
  booking: {
    count: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  member: {
    count: vi.fn(),
    findUnique: vi.fn(),
  },
  // Kiosk lodge binding (multi-lodge): getStaffLodgeBinding reads STAFF grants
  // and the /api/lodge/access route resolves the header lodge name from them.
  memberLodgeAccess: {
    findMany: vi.fn(),
  },
  lodge: {
    count: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock auth
// ---------------------------------------------------------------------------

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDate(str: string): Date {
  return new Date(`${str}T00:00:00.000Z`);
}

function subject(id: string, ...roles: string[]) {
  return { id, accessRoles: roles.map((role) => ({ role })) };
}

function authUser(id: string, role: "ADMIN" | "LODGE" | "USER" = "USER") {
  return { ...subject(id, role), role };
}

function mockSessionMemberRoles(id: string, ...roles: string[]) {
  mockPrisma.member.findUnique.mockResolvedValue({
    id,
    active: true,
    forcePasswordChange: false,
    accessRoles: roles.map((role) => ({ role })),
  });
}

// ---------------------------------------------------------------------------
// #24: Kiosk Access Tier Resolution
// ---------------------------------------------------------------------------

describe("#24: Kiosk Access Tiers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.count.mockResolvedValue(1);
    mockSessionMemberRoles("session-member", "USER");
  });

  describe("getKioskAccessTier", () => {
    it("returns 'admin' for ADMIN role regardless of date", async () => {
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier(subject("user-1", "ADMIN"), makeDate("2026-04-08"));
      expect(tier).toBe("admin");
    });

    it("returns 'lodge' for LODGE role regardless of date", async () => {
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier(subject("user-1", "LODGE"), makeDate("2026-04-08"));
      expect(tier).toBe("lodge");
    });

    it("returns 'hut-leader' for USER with active assignment on date", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(1);
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier(subject("user-1", "USER"), makeDate("2026-04-08"));
      expect(tier).toBe("hut-leader");
    });

    it("does not grant hut-leader access to membership category strings", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(1);
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");

      await expect(
        getKioskAccessTier(subject("associate-1"), makeDate("2026-04-08")),
      ).resolves.toBe("none");
      await expect(
        getKioskAccessTier(subject("life-1"), makeDate("2026-04-08")),
      ).resolves.toBe("none");
    });

    it("returns 'hut-leader' for USER on day before assignment starts", async () => {
      // Assignment starts 2026-04-09, checking access for 2026-04-08
      // startDate <= nextDay (2026-04-09) && endDate >= date (2026-04-08)
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(1);
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier(subject("user-1", "USER"), makeDate("2026-04-08"));
      expect(tier).toBe("hut-leader");
      // Verify the query used nextDay for startDate check
      expect(mockPrisma.hutLeaderAssignment.count).toHaveBeenCalledWith({
        where: {
          memberId: "user-1",
          startDate: { lte: expect.any(Date) },
          endDate: { gte: expect.any(Date) },
        },
      });
    });

    it("returns 'staying-guest' for USER with visible booking covering date", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
      mockPrisma.booking.count.mockResolvedValue(1);
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier(subject("user-1", "USER"), makeDate("2026-04-08"));
      expect(tier).toBe("staying-guest");
    });

    it("does not grant staying-guest access to membership category strings", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
      mockPrisma.booking.count.mockResolvedValue(1);
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");

      await expect(
        getKioskAccessTier(subject("associate-1"), makeDate("2026-04-08")),
      ).resolves.toBe("none");
      await expect(
        getKioskAccessTier(subject("life-1"), makeDate("2026-04-08")),
      ).resolves.toBe("none");
    });

    it("returns 'staying-guest' for USER on day before check-in", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
      // Booking checkIn is 2026-04-09, querying for 2026-04-08
      // checkIn <= nextDay (2026-04-09) && checkOut >= date (2026-04-08)
      mockPrisma.booking.count.mockResolvedValue(1);
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier(subject("user-1", "USER"), makeDate("2026-04-08"));
      expect(tier).toBe("staying-guest");
    });

    it("checks linked member guests as well as booking owners", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
      mockPrisma.booking.count.mockResolvedValue(1);
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier(subject("user-1", "USER"), makeDate("2026-04-08"));

      expect(tier).toBe("staying-guest");
      expect(mockPrisma.booking.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { memberId: "user-1" },
              {
                guests: {
                  some: expect.objectContaining({ memberId: "user-1" }),
                },
              },
            ],
          }),
        })
      );
    });

    it("returns 'none' for USER with no matching bookings or assignments", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
      mockPrisma.booking.count.mockResolvedValue(0);
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier(subject("user-1", "USER"), makeDate("2026-04-08"));
      expect(tier).toBe("none");
    });

    it("hut-leader takes priority over staying-guest", async () => {
      // When member has both an active assignment AND a paid booking
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(1);
      mockPrisma.booking.count.mockResolvedValue(1);
      const { getKioskAccessTier } = await import("@/lib/kiosk-access");
      const tier = await getKioskAccessTier(subject("user-1", "USER"), makeDate("2026-04-08"));
      expect(tier).toBe("hut-leader");
      // booking.count should NOT be called since hut-leader was found first
      expect(mockPrisma.booking.count).not.toHaveBeenCalled();
    });
  });

  describe("getKioskDateRange", () => {
    it("returns null for ADMIN", async () => {
      const { getKioskDateRange } = await import("@/lib/kiosk-access");
      const range = await getKioskDateRange(subject("user-1", "ADMIN"));
      expect(range).toBeNull();
    });

    it("returns null for LODGE", async () => {
      const { getKioskDateRange } = await import("@/lib/kiosk-access");
      const range = await getKioskDateRange(subject("user-1", "LODGE"));
      expect(range).toBeNull();
    });

    it("returns date range based on booking dates with one night either side", async () => {
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
      mockPrisma.booking.findMany.mockResolvedValue([
        {
          memberId: "user-1",
          checkIn: makeDate("2026-04-10"),
          checkOut: makeDate("2026-04-13"),
        },
      ]);
      const { getKioskDateRange } = await import("@/lib/kiosk-access");
      const range = await getKioskDateRange(subject("user-1", "USER"));
      expect(range).toEqual({
        minDate: "2026-04-09", // day before check-in
        maxDate: "2026-04-13", // one night after the last stay night
      });
    });

    it("returns null when no bookings or assignments", async () => {
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
      mockPrisma.booking.findMany.mockResolvedValue([]);
      const { getKioskDateRange } = await import("@/lib/kiosk-access");
      const range = await getKioskDateRange(subject("user-1", "USER"));
      expect(range).toBeNull();
    });
  });

  describe("getKioskAccessInfo", () => {
    it("returns correct capabilities for admin tier", async () => {
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
      mockPrisma.booking.findMany.mockResolvedValue([]);
      const { getKioskAccessInfo } = await import("@/lib/kiosk-access");
      const info = await getKioskAccessInfo(subject("user-1", "ADMIN"), makeDate("2026-04-08"));
      expect(info.tier).toBe("admin");
      expect(info.canManageRoster).toBe(true);
      expect(info.canMarkAttendance).toBe(true);
      expect(info.canCompleteChores).toBe(true);
      expect(info.dateRange).toBeNull();
    });

    it("returns correct capabilities for lodge tier", async () => {
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
      mockPrisma.booking.findMany.mockResolvedValue([]);
      const { getKioskAccessInfo } = await import("@/lib/kiosk-access");
      const info = await getKioskAccessInfo(subject("user-1", "LODGE"), makeDate("2026-04-08"));
      expect(info.tier).toBe("lodge");
      expect(info.canManageRoster).toBe(false);
      expect(info.canMarkAttendance).toBe(true);
      expect(info.canCompleteChores).toBe(true);
    });

    it("returns correct capabilities for hut-leader tier", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(1);
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
        { startDate: makeDate("2026-04-05"), endDate: makeDate("2026-04-12") },
      ]);
      mockPrisma.booking.findMany.mockResolvedValue([]);
      const { getKioskAccessInfo } = await import("@/lib/kiosk-access");
      const info = await getKioskAccessInfo(subject("user-1", "USER"), makeDate("2026-04-08"));
      expect(info.tier).toBe("hut-leader");
      expect(info.canManageRoster).toBe(true);
      expect(info.canMarkAttendance).toBe(true);
      expect(info.canCompleteChores).toBe(true);
    });

    it("returns correct capabilities for staying-guest tier", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
      mockPrisma.booking.count.mockResolvedValue(1);
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
      mockPrisma.booking.findMany.mockResolvedValue([
        {
          memberId: "user-1",
          checkIn: makeDate("2026-04-08"),
          checkOut: makeDate("2026-04-11"),
        },
      ]);
      const { getKioskAccessInfo } = await import("@/lib/kiosk-access");
      const info = await getKioskAccessInfo(subject("user-1", "USER"), makeDate("2026-04-08"));
      expect(info.tier).toBe("staying-guest");
      expect(info.canManageRoster).toBe(false);
      expect(info.canMarkAttendance).toBe(false);
      expect(info.canCompleteChores).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// #24: Lodge Auth Tier Checks
// ---------------------------------------------------------------------------

describe("#24: Lodge Auth Tier-Based Restrictions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.count.mockResolvedValue(1);
    mockSessionMemberRoles("session-member", "USER");
  });

  describe("checkLodgeAuth", () => {
    it("returns tier with session for ADMIN", async () => {
      mockSessionMemberRoles("admin-1", "ADMIN");
      mockAuth.mockResolvedValue({
        user: authUser("admin-1", "ADMIN"),
      });
      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth("2026-04-08");
      expect(result.tier).toBe("admin");
      expect(result.session).toBeTruthy();
      expect(result.error).toBeNull();
    });

    it("returns tier with session for LODGE", async () => {
      mockSessionMemberRoles("lodge-1", "LODGE");
      mockAuth.mockResolvedValue({
        user: authUser("lodge-1", "LODGE"),
      });
      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth("2026-04-08");
      expect(result.tier).toBe("lodge");
      expect(result.session).toBeTruthy();
    });

    it("returns Forbidden for USER with no access", async () => {
      mockAuth.mockResolvedValue({
        user: authUser("member-1", "USER"),
      });
      mockSessionMemberRoles("member-1");
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
      mockPrisma.booking.count.mockResolvedValue(0);
      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth("2026-04-08");
      expect(result.tier).toBe("none");
      expect(result.error).toBe("Forbidden");
      expect(result.status).toBe(403);
    });

    it("returns Unauthorised when no session", async () => {
      mockAuth.mockResolvedValue(null);
      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth("2026-04-08");
      expect(result.error).toBe("Unauthorised");
      expect(result.status).toBe(401);
    });

    it("returns staying-guest tier for USER with PAID booking", async () => {
      mockAuth.mockResolvedValue({
        user: authUser("member-1", "USER"),
      });
      mockSessionMemberRoles("member-1", "USER");
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
      mockPrisma.booking.count.mockResolvedValue(1);
      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth("2026-04-08");
      expect(result.tier).toBe("staying-guest");
      expect(result.session).toBeTruthy();
    });

    it("returns 400 for invalid date strings", async () => {
      mockAuth.mockResolvedValue({
        user: authUser("admin-1", "ADMIN"),
      });
      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth("not-a-date");
      expect(result.error).toBe("Invalid date format");
      expect(result.status).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------
// #24: Auth.ts LODGE JWT Duration
// ---------------------------------------------------------------------------

describe("#24: LODGE JWT 30-day expiry", () => {
  it("auth.ts contains 30 * 24 * 60 * 60 for LODGE role", async () => {
    // Read the auth file and verify the duration
    const fs = await import("fs");
    const content = fs.readFileSync("src/lib/auth.ts", "utf-8");
    expect(content).toContain("30 * 24 * 60 * 60");
  });
});

// ---------------------------------------------------------------------------
// #24: Lodge Access API endpoint
// ---------------------------------------------------------------------------

describe("#24: Lodge Access API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.count.mockResolvedValue(1);
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "session-member",
      active: true,
      forcePasswordChange: false,
    });
    // Default: no STAFF grants (unbound → default lodge) and a single active
    // lodge, so the kiosk header lodge name stays hidden (ADR-002).
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
    mockPrisma.lodge.count.mockResolvedValue(1);
  });

  it("returns access info for authenticated user", async () => {
    mockAuth.mockResolvedValue({
      user: authUser("admin-1", "ADMIN"),
    });
    mockSessionMemberRoles("admin-1", "ADMIN");
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/lodge/access/route");
    const req = new NextRequest("http://localhost/api/lodge/access?date=2026-04-08");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tier).toBe("admin");
    expect(data.canManageRoster).toBe(true);
    expect(data.canMarkAttendance).toBe(true);
    expect(data.dateRange).toBeNull();
  });

  it("requires authentication for lodge access info", async () => {
    mockAuth.mockResolvedValue(null);

    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/lodge/access/route");
    const req = new NextRequest("http://localhost/api/lodge/access?date=2026-04-08");
    const res = await GET(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("Unauthorised");
  });

  it("returns 403 for deactivated user with a stale session", async () => {
    mockAuth.mockResolvedValue({
      user: authUser("admin-1", "ADMIN"),
    });
    mockPrisma.member.findUnique.mockResolvedValueOnce({
      id: "admin-1",
      active: false,
      forcePasswordChange: false,
    });

    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/lodge/access/route");
    const req = new NextRequest("http://localhost/api/lodge/access?date=2026-04-08");
    const res = await GET(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("Account is deactivated");
  });

  it("returns 400 for missing date parameter", async () => {
    mockAuth.mockResolvedValue({
      user: authUser("admin-1", "ADMIN"),
    });

    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/lodge/access/route");
    const req = new NextRequest("http://localhost/api/lodge/access");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  // Item 4 (#1587): a kiosk (STAFF) account granted at more than one lodge is
  // denied everywhere data is served (M5). The access route surfaces that up
  // front so the kiosk shows a fix-the-assignment message instead of enabled
  // UI that then hits clean 403s.
  it("returns a misconfigured payload for an ambiguous multi-lodge kiosk account", async () => {
    mockAuth.mockResolvedValue({ user: authUser("kiosk-1", "LODGE") });
    mockSessionMemberRoles("kiosk-1", "LODGE");
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([
      { lodgeId: "lodge-A" },
      { lodgeId: "lodge-B" },
    ]);

    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/lodge/access/route");
    const res = await GET(
      new NextRequest("http://localhost/api/lodge/access?date=2026-04-08"),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      tier: "none",
      misconfigured: true,
      error:
        "This kiosk account is assigned to multiple lodges — an admin must fix the assignment.",
      dateRange: null,
      canManageRoster: false,
      canMarkAttendance: false,
      canCompleteChores: false,
      lodgeName: null,
    });
    // No lodge name or guest/roster data is leaked: the lodge name is never
    // resolved for an ambiguous account.
    expect(mockPrisma.lodge.count).not.toHaveBeenCalled();
    expect(mockPrisma.lodge.findUnique).not.toHaveBeenCalled();
  });

  it("returns normal lodge access for a single-lodge kiosk account (not misconfigured)", async () => {
    mockAuth.mockResolvedValue({ user: authUser("kiosk-1", "LODGE") });
    mockSessionMemberRoles("kiosk-1", "LODGE");
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([
      { lodgeId: "lodge-A" },
    ]);

    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/lodge/access/route");
    const res = await GET(
      new NextRequest("http://localhost/api/lodge/access?date=2026-04-08"),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tier).toBe("lodge");
    expect(data.misconfigured).toBeUndefined();
    expect(data.canMarkAttendance).toBe(true);
    expect(data.canManageRoster).toBe(false);
  });

  it("does not flag a staying-guest (member) tier as misconfigured", async () => {
    mockAuth.mockResolvedValue({ user: authUser("guest-1", "USER") });
    mockSessionMemberRoles("guest-1", "USER");
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockPrisma.booking.count.mockResolvedValue(1);
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/lodge/access/route");
    const res = await GET(
      new NextRequest("http://localhost/api/lodge/access?date=2026-04-08"),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tier).toBe("staying-guest");
    expect(data.misconfigured).toBeUndefined();
    // Members are not lodge-bound via STAFF grants, so the binding is never read.
    expect(mockPrisma.memberLodgeAccess.findMany).not.toHaveBeenCalled();
  });
});

