import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Low 1: the read-side availability/pricing surfaces must enforce the same
// BOOKING_RESTRICTION eligibility as the booking create path, so a restricted
// member cannot discover a forbidden lodge's availability/rooms. lodge-access
// and lodges are left un-mocked so the real eligibility + default-lodge
// resolution run against the mocked prisma.
const {
  mockAuth,
  mockRequireActiveSessionUser,
  mockGetMonthAvailability,
  mockCheckCapacity,
  mockLoadEffectiveModuleFlags,
  mockLodgeFindFirst,
  mockLodgeFindUnique,
  mockSeasonFindMany,
  mockMemberLodgeAccessFindMany,
  mockLodgeRoomFindMany,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireActiveSessionUser: vi.fn(),
  mockGetMonthAvailability: vi.fn(),
  mockCheckCapacity: vi.fn(),
  mockLoadEffectiveModuleFlags: vi.fn(),
  mockLodgeFindFirst: vi.fn(),
  mockLodgeFindUnique: vi.fn(),
  mockSeasonFindMany: vi.fn(),
  mockMemberLodgeAccessFindMany: vi.fn(),
  mockLodgeRoomFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) =>
    mockRequireActiveSessionUser(...args),
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
  rateLimiters: { bookingQuery: {} },
}));
vi.mock("@/lib/capacity", () => ({
  getMonthAvailability: (...args: unknown[]) => mockGetMonthAvailability(...args),
  checkCapacity: (...args: unknown[]) => mockCheckCapacity(...args),
  // #2930: the route now resolves the SELECTED lodge's capacity through the one
  // resolver (`INV-CAP-003`) instead of leaving the client to divide by a
  // club-wide figure, so the mock has to carry it or the module throws at import.
  getLodgeCapacity: async () => 20,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: () => mockLoadEffectiveModuleFlags(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: { findFirst: mockLodgeFindFirst, findUnique: mockLodgeFindUnique },
    season: { findMany: mockSeasonFindMany },
    memberLodgeAccess: { findMany: mockMemberLodgeAccessFindMany },
    lodgeRoom: { findMany: mockLodgeRoomFindMany },
  },
}));

const memberSession = {
  user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(memberSession);
  mockRequireActiveSessionUser.mockResolvedValue(null);
  // No lodgeId in the query resolves to the club's default lodge ("lodge-1").
  mockLodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
  mockGetMonthAvailability.mockResolvedValue(new Map());
  mockCheckCapacity.mockResolvedValue({ minAvailable: 5, nightDetails: [] });
  mockSeasonFindMany.mockResolvedValue([]);
  mockLoadEffectiveModuleFlags.mockResolvedValue({ bedAllocation: true });
  mockLodgeRoomFindMany.mockResolvedValue([]);
});

// A BOOKING_RESTRICTION list that excludes the resolved lodge => forbidden.
function restrictTo(lodgeIds: string[]) {
  mockMemberLodgeAccessFindMany.mockResolvedValue(
    lodgeIds.map((lodgeId) => ({ lodgeId })),
  );
}

describe("GET /api/availability BOOKING_RESTRICTION gate (Low 1)", () => {
  it("returns 403 for a member restricted away from the resolved lodge", async () => {
    restrictTo(["other-lodge"]);
    const { GET } = await import("@/app/api/availability/route");
    const res = await GET(
      new NextRequest("http://localhost/api/availability?year=2026&month=6"),
    );
    expect(res.status).toBe(403);
    expect(mockGetMonthAvailability).not.toHaveBeenCalled();
  });

  it("returns 200 for an unrestricted member", async () => {
    restrictTo([]);
    const { GET } = await import("@/app/api/availability/route");
    const res = await GET(
      new NextRequest("http://localhost/api/availability?year=2026&month=6"),
    );
    expect(res.status).toBe(200);
    expect(mockGetMonthAvailability).toHaveBeenCalled();
  });
});

describe("GET /api/availability/check BOOKING_RESTRICTION gate (Low 1)", () => {
  it("returns 403 for a member restricted away from the resolved lodge", async () => {
    restrictTo(["other-lodge"]);
    const { GET } = await import("@/app/api/availability/check/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/availability/check?checkIn=2026-07-10&checkOut=2026-07-12",
      ),
    );
    expect(res.status).toBe(403);
    expect(mockCheckCapacity).not.toHaveBeenCalled();
  });

  it("returns 200 for an unrestricted member", async () => {
    restrictTo([]);
    const { GET } = await import("@/app/api/availability/check/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/availability/check?checkIn=2026-07-10&checkOut=2026-07-12",
      ),
    );
    expect(res.status).toBe(200);
    expect(mockCheckCapacity).toHaveBeenCalled();
  });
});

describe("GET /api/bookings/rooms BOOKING_RESTRICTION gate (Low 1)", () => {
  it("returns 403 for a member restricted away from an explicit lodge", async () => {
    restrictTo(["other-lodge"]);
    const { GET } = await import("@/app/api/bookings/rooms/route");
    const res = await GET(
      new NextRequest("http://localhost/api/bookings/rooms?lodgeId=lodge-1"),
    );
    expect(res.status).toBe(403);
    expect(mockLodgeRoomFindMany).not.toHaveBeenCalled();
  });

  it("returns 200 for an unrestricted member on an explicit lodge", async () => {
    restrictTo([]);
    const { GET } = await import("@/app/api/bookings/rooms/route");
    const res = await GET(
      new NextRequest("http://localhost/api/bookings/rooms?lodgeId=lodge-1"),
    );
    expect(res.status).toBe(200);
    expect(mockLodgeRoomFindMany).toHaveBeenCalled();
  });

  it("filters the no-lodgeId listing to a restricted member's eligible lodges", async () => {
    // #1587 item 6: the cross-lodge listing must apply the same eligibility
    // rule as the named-lodge branch, so a member restricted to lodge-a only
    // sees lodge-a's rooms (never 403 — a listing filters, it does not deny).
    restrictTo(["lodge-a"]);
    const { GET } = await import("@/app/api/bookings/rooms/route");
    const res = await GET(new NextRequest("http://localhost/api/bookings/rooms"));
    expect(res.status).toBe(200);
    expect(mockMemberLodgeAccessFindMany).toHaveBeenCalled();
    expect(mockLodgeRoomFindMany).toHaveBeenCalled();
    expect(mockLodgeRoomFindMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ active: true, lodgeId: { in: ["lodge-a"] } }),
    );
  });

  it("lists every ACTIVE lodge's rooms, unnarrowed, for an unrestricted member", async () => {
    // Default-open: no BOOKING_RESTRICTION rows means no eligibility narrowing
    // by lodge id. The listing is still not club-wide without limit — #2727
    // added the lodge's own `active` flag, so an archived lodge's rooms are
    // never offered in a discovery listing (INV-INT-016). The two filters are
    // different questions: "may this member book here?" and "is this lodge
    // still in service?".
    restrictTo([]);
    const { GET } = await import("@/app/api/bookings/rooms/route");
    const res = await GET(new NextRequest("http://localhost/api/bookings/rooms"));
    expect(res.status).toBe(200);
    expect(mockLodgeRoomFindMany).toHaveBeenCalled();
    const whereArg = mockLodgeRoomFindMany.mock.calls[0][0].where;
    expect(whereArg).toEqual({ active: true, lodge: { active: true } });
    expect(whereArg).not.toHaveProperty("lodgeId");
  });
});
