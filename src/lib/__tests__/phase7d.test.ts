import { describe, it, expect, vi, beforeEach } from "vitest";
import { hashActionToken } from "@/lib/action-tokens";

// This legacy file imports several Next route modules inside individual cases;
// Node 24 cold transformation on Windows can exceed Vitest's 5 s default.
vi.setConfig({ testTimeout: 15_000 });

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const mockPrisma = {
  hutLeaderAssignment: {
    count: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  guestChoreToken: {
    create: vi.fn(),
    findUnique: vi.fn(),
  },
  choreAssignment: {
    update: vi.fn(),
  },
  member: {
    count: vi.fn(),
findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  bookingGuest: {
    findMany: vi.fn(),
  },
  booking: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  lodge: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
  // #2698: the three hut-leader write routes audit themselves now (category
  // `lodge` — the roster row of docs/guides/audit-log.md), and the real
  // `createAuditLog` runs against this double, so the table has to exist here
  // or every create, edit and delete 500s.
  auditLog: { create: vi.fn(async () => ({ id: "audit-1" })) },
  // #2887: creating a hut-leader assignment is now ALWAYS a locked write —
  // the role-only path shares the per-lodge capacity key with the bed-holding
  // path so both serialize the same overlap predicate. The interactive
  // transaction therefore has to exist on the double, and the advisory lock
  // has to be observable, or every create in this file 500s on a TypeError.
  $executeRaw: vi.fn(async () => 0),
  $transaction: vi.fn(async (arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: typeof mockPrisma) => unknown)(mockPrisma)
      : arg,
  ),
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
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  requireAdmin: async () => {
    const session = await mockAuth();
    if (!session?.user?.id) {
      return {
        ok: false,
        response: Response.json({ error: "Unauthorized" }, { status: 401 }),
      };
    }
    if (!session.user.accessRoles?.some(({ role }: { role: string }) => role === "ADMIN")) {
      return {
        ok: false,
        response: Response.json({ error: "Forbidden" }, { status: 403 }),
      };
    }
    return { ok: true, session };
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown, method = "POST") {
  return new Request("http://localhost/api/admin/hut-leaders", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      body && typeof body === "object" ? { lodgeId: "lodge-1", ...body } : body,
    ),
  });
}

function makeListRequest(lodgeId = "lodge-1") {
  return new Request(`http://localhost/api/admin/hut-leaders?lodgeId=${lodgeId}`);
}

function makeParams(id = "assign-1") {
  return { params: Promise.resolve({ id }) };
}

const validActionToken = "a".repeat(64);

function makeTokenParams(token = validActionToken) {
  return { params: Promise.resolve({ token }) };
}

// ---------------------------------------------------------------------------
// F8: Hut Leader Assignment
// ---------------------------------------------------------------------------

describe("F8: Hut Leader Role Assignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "session-member",
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "ADMIN" }],
    });
    mockPrisma.lodge.findFirst.mockResolvedValue({ id: "lodge-1" });
    mockPrisma.lodge.findUnique.mockImplementation(async (args: { where: { id: string } }) => ({
      id: args.where.id,
      active: true,
    }));
  });

  describe("isHutLeader helper", () => {
    it("returns true when member has active assignment for date", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(1);

      const { isHutLeader } = await import("@/lib/hut-leader");
      const result = await isHutLeader("member-1", new Date("2026-07-15"));

      expect(result).toBe(true);
      expect(mockPrisma.hutLeaderAssignment.count).toHaveBeenCalledWith({
        where: {
          memberId: "member-1",
          startDate: { lte: new Date("2026-07-15") },
          endDate: { gte: new Date("2026-07-15") },
        },
      });
    });

    it("returns false when no assignment exists", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);

      const { isHutLeader } = await import("@/lib/hut-leader");
      const result = await isHutLeader("member-2", new Date("2026-07-15"));

      expect(result).toBe(false);
    });
  });

  describe("hasActiveHutLeaderAssignment helper", () => {
    it("returns true when member has current or future assignment", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(1);

      const { hasActiveHutLeaderAssignment } = await import("@/lib/hut-leader");
      const result = await hasActiveHutLeaderAssignment("member-1");

      expect(result).toBe(true);
    });

    it("returns false when no active assignment", async () => {
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);

      const { hasActiveHutLeaderAssignment } = await import("@/lib/hut-leader");
      const result = await hasActiveHutLeaderAssignment("member-2");

      expect(result).toBe(false);
    });
  });

  describe("GET /api/admin/hut-leaders", () => {
    it("returns 403 for non-admin users", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "m1", role: "USER", accessRoles: [{ role: "USER" }], email: "a@b.com" },
      });

      const { GET } = await import(
        "@/app/api/admin/hut-leaders/route"
      );
      const res = await GET(makeListRequest() as any);
      expect(res.status).toBe(403);
    });

    it("returns assignments for admin", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
        {
          id: "a1",
          memberId: "m1",
          startDate: new Date("2026-07-10"),
          endDate: new Date("2026-07-17"),
          createdAt: new Date("2026-07-01"),
          member: { id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com" },
        },
      ]);

      const { GET } = await import(
        "@/app/api/admin/hut-leaders/route"
      );
      const res = await GET(makeListRequest() as any);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.assignments).toHaveLength(1);
      expect(data.assignments[0].memberName).toBe("Alice Smith");
      expect(data.assignments[0].startDate).toBe("2026-07-10");
    });

    it("returns each assignment's lodge for the admin lodge column", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
        {
          id: "a1",
          memberId: "m1",
          startDate: new Date("2026-07-10"),
          endDate: new Date("2026-07-17"),
          createdAt: new Date("2026-07-01"),
          lodgeId: "lodge-2",
          member: { id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com" },
          lodge: { id: "lodge-2", name: "River Lodge" },
        },
      ]);

      const { GET } = await import(
        "@/app/api/admin/hut-leaders/route"
      );
      const res = await GET(makeListRequest("lodge-2") as any);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.assignments[0].lodgeId).toBe("lodge-2");
      expect(data.assignments[0].lodgeName).toBe("River Lodge");
      expect(mockPrisma.hutLeaderAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { lodgeId: "lodge-2" } }),
      );
    });
  });

  describe("POST /api/admin/hut-leaders", () => {
    it("returns 403 for non-admin", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "m1", role: "USER", accessRoles: [{ role: "USER" }], email: "a@b.com" },
      });

      const { POST } = await import(
        "@/app/api/admin/hut-leaders/route"
      );
      const res = await POST(
        makeRequest({ memberId: "m1", startDate: "2026-07-10", endDate: "2026-07-17" }) as any
      );
      expect(res.status).toBe(403);
    });

    it("creates assignment for valid input", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.member.findUnique.mockResolvedValue({
        id: "m1",
        active: true,
        role: "USER",
        accessRoles: [{ role: "USER" }],
      });
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
      mockPrisma.hutLeaderAssignment.create.mockResolvedValue({ id: "new-assign" });

      const { POST } = await import(
        "@/app/api/admin/hut-leaders/route"
      );
      const res = await POST(
        makeRequest({ memberId: "m1", startDate: "2026-07-10", endDate: "2026-07-17" }) as any
      );
      expect(res.status).toBe(201);

      const data = await res.json();
      expect(data.id).toBe("new-assign");
    });

    it("rejects overlapping assignment (2+ days)", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.member.findUnique.mockResolvedValue({
        id: "m1",
        active: true,
        role: "USER",
        accessRoles: [{ role: "USER" }],
      });
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([{
        id: "existing",
        startDate: new Date("2026-07-08"),
        endDate: new Date("2026-07-12"),
        member: { firstName: "Bob", lastName: "Smith" },
      }]);

      const { POST } = await import(
        "@/app/api/admin/hut-leaders/route"
      );
      const res = await POST(
        makeRequest({ memberId: "m1", startDate: "2026-07-10", endDate: "2026-07-17" }) as any
      );
      expect(res.status).toBe(409);

      const data = await res.json();
      expect(data.error).toContain("overlaps");
      expect(data.error).toContain("Bob Smith");
    });

    it("allows same-day boundary (1-day overlap for handover)", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.member.findUnique.mockResolvedValue({
        id: "m1",
        active: true,
        role: "USER",
        accessRoles: [{ role: "USER" }],
      });
      // 1-day overlap is allowed for handover
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
      mockPrisma.hutLeaderAssignment.create.mockResolvedValue({ id: "new-assign" });

      const { POST } = await import(
        "@/app/api/admin/hut-leaders/route"
      );
      const res = await POST(
        makeRequest({ memberId: "m1", startDate: "2026-07-10", endDate: "2026-07-17" }) as any
      );
      expect(res.status).toBe(201);
    });

    it("scopes the overlap check to the requested lodge", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.member.findUnique.mockResolvedValue({
        id: "m1",
        active: true,
        role: "USER",
        accessRoles: [{ role: "USER" }],
      });
      mockPrisma.lodge.findUnique.mockResolvedValue({ id: "lodge-2", active: true });
      // The other lodge's leader for the same week is not returned by a
      // lodge-scoped query, so the assignment is allowed.
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
      mockPrisma.hutLeaderAssignment.create.mockResolvedValue({ id: "new-assign" });

      const { POST } = await import(
        "@/app/api/admin/hut-leaders/route"
      );
      const res = await POST(
        makeRequest({ memberId: "m1", startDate: "2026-07-10", endDate: "2026-07-17", lodgeId: "lodge-2" }) as any
      );
      expect(res.status).toBe(201);

      expect(mockPrisma.hutLeaderAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            lodgeId: "lodge-2",
          }),
        })
      );
      expect(mockPrisma.hutLeaderAssignment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lodgeId: "lodge-2",
            // #2926: an officer put this leader here. MANUAL is also the column
            // default, so this assertion is what keeps the stamp at the call
            // site rather than letting it drift into an implicit value.
            source: "MANUAL",
          }),
        })
      );
    });

    it("rejects an assignment at an unknown or inactive lodge", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.member.findUnique.mockResolvedValue({
        id: "m1",
        active: true,
        role: "USER",
        accessRoles: [{ role: "USER" }],
      });
      mockPrisma.lodge.findUnique.mockResolvedValue(null);

      const { POST } = await import(
        "@/app/api/admin/hut-leaders/route"
      );
      const res = await POST(
        makeRequest({ memberId: "m1", startDate: "2026-07-10", endDate: "2026-07-17", lodgeId: "lodge-missing" }) as any
      );
      expect(res.status).toBe(400);
      expect(mockPrisma.hutLeaderAssignment.create).not.toHaveBeenCalled();
    });

    it("rejects operational accounts for hut leader assignments", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.member.findUnique.mockResolvedValue({
        id: "lodge1",
        active: true,
        role: "LODGE",
        accessRoles: [{ role: "LODGE" }],
      });

      const { POST } = await import(
        "@/app/api/admin/hut-leaders/route"
      );
      const res = await POST(
        makeRequest({ memberId: "lodge1", startDate: "2026-07-10", endDate: "2026-07-17" }) as any
      );
      expect(res.status).toBe(404);
    });

    it("rejects when endDate before startDate", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      const { POST } = await import(
        "@/app/api/admin/hut-leaders/route"
      );
      const res = await POST(
        makeRequest({ memberId: "m1", startDate: "2026-07-20", endDate: "2026-07-10" }) as any
      );
      expect(res.status).toBe(400);
    });

    it("returns 404 for inactive member", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.member.findUnique
        .mockResolvedValueOnce({
          id: "admin1",
          active: true,
          forcePasswordChange: false,
        })
        .mockResolvedValueOnce({ id: "m1", active: false });

      const { POST } = await import(
        "@/app/api/admin/hut-leaders/route"
      );
      const res = await POST(
        makeRequest({ memberId: "m1", startDate: "2026-07-10", endDate: "2026-07-17" }) as any
      );
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/admin/hut-leaders/[id]", () => {
    it("returns 403 for non-admin", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "m1", role: "USER", accessRoles: [{ role: "USER" }], email: "a@b.com" },
      });

      const { DELETE } = await import(
        "@/app/api/admin/hut-leaders/[id]/route"
      );
      const res = await DELETE(
        new Request("http://localhost") as any,
        makeParams()
      );
      expect(res.status).toBe(403);
    });

    it("deletes existing assignment", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      // #2698: the delete runs under the lodge capacity key, so the row has to
      // name the lodge it belongs to — that id IS the key.
      mockPrisma.hutLeaderAssignment.findUnique.mockResolvedValue({
        id: "assign-1",
        memberId: "member-1",
        lodgeId: "lodge-1",
        bedId: null,
        startDate: new Date("2026-07-10"),
        endDate: new Date("2026-07-17"),
      });
      mockPrisma.hutLeaderAssignment.delete.mockResolvedValue({});

      const { DELETE } = await import(
        "@/app/api/admin/hut-leaders/[id]/route"
      );
      const res = await DELETE(
        new Request("http://localhost") as any,
        makeParams()
      );
      expect(res.status).toBe(200);
    });

    it("returns 404 for non-existent assignment", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.hutLeaderAssignment.findUnique.mockResolvedValue(null);

      const { DELETE } = await import(
        "@/app/api/admin/hut-leaders/[id]/route"
      );
      const res = await DELETE(
        new Request("http://localhost") as any,
        makeParams()
      );
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/admin/hut-leaders/[id]", () => {
    it("updates assignment dates", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.hutLeaderAssignment.findUnique.mockResolvedValue({
        id: "assign-1",
        startDate: new Date("2026-07-10"),
        endDate: new Date("2026-07-17"),
      });
      mockPrisma.hutLeaderAssignment.update.mockResolvedValue({});

      const { PUT } = await import(
        "@/app/api/admin/hut-leaders/[id]/route"
      );
      const req = new Request("http://localhost", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endDate: "2026-07-20" }),
      });
      const res = await PUT(req as any, makeParams());
      expect(res.status).toBe(200);
    });

    it("rejects update that makes start > end", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.hutLeaderAssignment.findUnique.mockResolvedValue({
        id: "assign-1",
        startDate: new Date("2026-07-10"),
        endDate: new Date("2026-07-17"),
      });

      const { PUT } = await import(
        "@/app/api/admin/hut-leaders/[id]/route"
      );
      const req = new Request("http://localhost", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: "2026-07-25" }),
      });
      const res = await PUT(req as any, makeParams());
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/admin/hut-leaders/eligible-members", () => {
    it("returns 403 for non-admin", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "m1", role: "USER", accessRoles: [{ role: "USER" }], email: "a@b.com" },
      });

      const { GET } = await import(
        "@/app/api/admin/hut-leaders/eligible-members/route"
      );
      const req = new Request("http://localhost/api/admin/hut-leaders/eligible-members?startDate=2026-07-10&endDate=2026-07-17&lodgeId=lodge-1");
      const res = await GET(req as any);
      expect(res.status).toBe(403);
    });

    it("returns 400 when dates missing", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      const { GET } = await import(
        "@/app/api/admin/hut-leaders/eligible-members/route"
      );
      const req = new Request("http://localhost/api/admin/hut-leaders/eligible-members?lodgeId=lodge-1");
      const res = await GET(req as any);
      expect(res.status).toBe(400);
    });

    it("returns eligible adult members for date range", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.bookingGuest.findMany.mockResolvedValue([
        {
          memberId: "m1",
          member: { id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com", active: true },
          booking: { checkIn: new Date("2026-07-10"), checkOut: new Date("2026-07-17") },
        },
      ]);
      mockPrisma.booking.findMany.mockResolvedValue([]);
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);

      const { GET } = await import(
        "@/app/api/admin/hut-leaders/eligible-members/route"
      );
      const req = new Request("http://localhost/api/admin/hut-leaders/eligible-members?startDate=2026-07-10&endDate=2026-07-17&lodgeId=lodge-1");
      const res = await GET(req as any);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.members).toHaveLength(1);
      expect(data.members[0].firstName).toBe("Alice");
      // No assignments exist, so an at-lodge adult is surfaced as not-yet-covered.
      expect(data.members[0].fullyCovered).toBe(false);
    });

    it("deduplicates members across bookings", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.bookingGuest.findMany.mockResolvedValue([
        {
          memberId: "m1",
          member: { id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com", active: true },
          booking: { checkIn: new Date("2026-07-10"), checkOut: new Date("2026-07-14") },
        },
        {
          memberId: "m1",
          member: { id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com", active: true },
          booking: { checkIn: new Date("2026-07-14"), checkOut: new Date("2026-07-17") },
        },
      ]);
      mockPrisma.booking.findMany.mockResolvedValue([
        {
          checkIn: new Date("2026-07-10"),
          checkOut: new Date("2026-07-17"),
          // #2887: the owner's own bed nights are now read off their guest row
          // (sparse per-guest nights), so the route's select includes `guests`
          // and it is always an array. The fixture has to say so.
          guests: [],
          member: { id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com", active: true, ageTier: "ADULT" },
        },
      ]);
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);

      const { GET } = await import(
        "@/app/api/admin/hut-leaders/eligible-members/route"
      );
      const req = new Request("http://localhost/api/admin/hut-leaders/eligible-members?startDate=2026-07-10&endDate=2026-07-17&lodgeId=lodge-1");
      const res = await GET(req as any);
      const data = await res.json();
      expect(data.members).toHaveLength(1);
      expect(data.members[0].fullyCovered).toBe(false);
    });

    it("clamps suggestion to the uncovered contiguous run", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.bookingGuest.findMany.mockResolvedValue([
        {
          memberId: "m1",
          member: {
            id: "m1",
            firstName: "Alice",
            lastName: "Smith",
            email: "alice@test.com",
            active: true,
            hutLeaderEligible: true,
          },
          booking: { checkIn: new Date("2026-07-10"), checkOut: new Date("2026-07-17") },
        },
      ]);
      mockPrisma.booking.findMany.mockResolvedValue([]);
      // An existing leader already covers Jul 10–12 (inclusive).
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
        { startDate: new Date("2026-07-10"), endDate: new Date("2026-07-12") },
      ]);

      const { GET } = await import(
        "@/app/api/admin/hut-leaders/eligible-members/route"
      );
      const req = new Request("http://localhost/api/admin/hut-leaders/eligible-members?startDate=2026-07-10&endDate=2026-07-17&lodgeId=lodge-1");
      const res = await GET(req as any);
      const data = await res.json();

      expect(data.members).toHaveLength(1);
      const m = data.members[0];
      expect(m.fullyCovered).toBe(false);
      // Stay nights Jul10–16 (checkout Jul17 is the departure morning, not a
      // night); Jul10–12 covered → first uncovered night is Jul13, last is Jul16.
      expect(m.suggestedStartDate).toBe("2026-07-13");
      expect(m.suggestedEndDate).toBe("2026-07-16");
      expect(m.uncoveredNightCount).toBe(4); // Jul 13,14,15,16
    });

    it("flags a fully-covered member and sorts them last", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.bookingGuest.findMany.mockResolvedValue([
        {
          memberId: "covered",
          member: {
            id: "covered",
            firstName: "Cara",
            lastName: "Covered",
            email: "cara@test.com",
            active: true,
            hutLeaderEligible: true,
          },
          booking: { checkIn: new Date("2026-07-11"), checkOut: new Date("2026-07-13") },
        },
        {
          memberId: "open",
          member: {
            id: "open",
            firstName: "Owen",
            lastName: "Open",
            email: "owen@test.com",
            active: true,
            hutLeaderEligible: true,
          },
          booking: { checkIn: new Date("2026-07-20"), checkOut: new Date("2026-07-23") },
        },
      ]);
      mockPrisma.booking.findMany.mockResolvedValue([]);
      // Assignment fully wraps Cara's stay (Jul11–13) but not Owen's (Jul20–23).
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
        { startDate: new Date("2026-07-10"), endDate: new Date("2026-07-14") },
      ]);

      const { GET } = await import(
        "@/app/api/admin/hut-leaders/eligible-members/route"
      );
      const req = new Request("http://localhost/api/admin/hut-leaders/eligible-members?startDate=2026-07-11&endDate=2026-07-23&lodgeId=lodge-1");
      const res = await GET(req as any);
      const data = await res.json();

      expect(data.members).toHaveLength(2);
      const covered = data.members.find((x: { id: string }) => x.id === "covered");
      const open = data.members.find((x: { id: string }) => x.id === "open");
      expect(covered.fullyCovered).toBe(true);
      expect(covered.uncoveredNightCount).toBe(0);
      expect(open.fullyCovered).toBe(false);
      // Fully-covered members sort last.
      expect(data.members[0].id).toBe("open");
      expect(data.members[1].id).toBe("covered");
    });

    it("handover boundary is not over-clamped", async () => {
      // The existing assignment shares only the Jul12 boundary night with the
      // member's stay. POST would still allow a Jul12 handover start
      // (overlapDays == 1), but the suggestion is deliberately conservative and
      // always safely POST-able — it starts at the first fully-uncovered night.
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.bookingGuest.findMany.mockResolvedValue([
        {
          memberId: "m1",
          member: {
            id: "m1",
            firstName: "Alice",
            lastName: "Smith",
            email: "alice@test.com",
            active: true,
            hutLeaderEligible: true,
          },
          booking: { checkIn: new Date("2026-07-12"), checkOut: new Date("2026-07-15") },
        },
      ]);
      mockPrisma.booking.findMany.mockResolvedValue([]);
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
        { startDate: new Date("2026-07-10"), endDate: new Date("2026-07-12") },
      ]);

      const { GET } = await import(
        "@/app/api/admin/hut-leaders/eligible-members/route"
      );
      const req = new Request("http://localhost/api/admin/hut-leaders/eligible-members?startDate=2026-07-12&endDate=2026-07-15&lodgeId=lodge-1");
      const res = await GET(req as any);
      const data = await res.json();

      expect(data.members).toHaveLength(1);
      const m = data.members[0];
      expect(m.fullyCovered).toBe(false);
      // Stay nights Jul12–14 (checkout Jul15 is not a night). Jul12 is covered
      // by the existing assignment (inclusive), so the suggestion starts at Jul13.
      expect(m.suggestedStartDate).toBe("2026-07-13");
      expect(m.uncoveredNightCount).toBe(2); // Jul 13,14
    });
  });

  describe("PUT overlap validation", () => {
    it("rejects update that creates 2+ day overlap", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });

      mockPrisma.hutLeaderAssignment.findUnique.mockResolvedValue({
        id: "assign-1",
        startDate: new Date("2026-07-10"),
        endDate: new Date("2026-07-17"),
      });
      // Extending end to Jul 20 overlaps with assign-2 (Jul 18-25) by 3 days
      mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([{
        id: "assign-2",
        startDate: new Date("2026-07-18"),
        endDate: new Date("2026-07-25"),
        member: { firstName: "Bob", lastName: "Jones" },
      }]);

      const { PUT } = await import(
        "@/app/api/admin/hut-leaders/[id]/route"
      );
      const req = new Request("http://localhost", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endDate: "2026-07-20" }),
      });
      const res = await PUT(req as any, makeParams());
      expect(res.status).toBe(409);

      const data = await res.json();
      expect(data.error).toContain("overlaps");
    });
  });

  describe("Lodge auth with hut leader", () => {
    it("allows USER with active hut leader assignment", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "m1", role: "USER", accessRoles: [{ role: "USER" }], email: "m@test.com" },
      });
      mockPrisma.member.findUnique.mockReset();
      mockPrisma.hutLeaderAssignment.count.mockReset();
      mockPrisma.member.findUnique.mockResolvedValue({
        id: "m1",
        accessRoles: [{ role: "USER" }],
      });
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(1);

      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth();
      expect(result.error).toBeNull();
    });

    it("rejects USER without hut leader assignment", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "m2", role: "USER", accessRoles: [{ role: "USER" }], email: "m2@test.com" },
      });
      mockPrisma.member.findUnique.mockResolvedValue({
        id: "m2",
        accessRoles: [{ role: "USER" }],
      });
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
      mockPrisma.booking.count.mockResolvedValue(0);

      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth();
      expect(result.error).toBe("Forbidden");
      expect(result.status).toBe(403);
    });

    it("allows LODGE role without hut leader check", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "lodge1", role: "LODGE", accessRoles: [{ role: "LODGE" }], email: "lodge@tac.org.nz" },
      });
      mockPrisma.member.findUnique.mockResolvedValue({
        id: "lodge1",
        accessRoles: [{ role: "LODGE" }],
      });

      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth();
      expect(result.error).toBeNull();
      expect(mockPrisma.hutLeaderAssignment.count).not.toHaveBeenCalled();
    });

    it("allows ADMIN role without hut leader check", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
      });
      mockPrisma.member.findUnique.mockResolvedValue({
        id: "admin1",
        accessRoles: [{ role: "ADMIN" }],
      });

      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth();
      expect(result.error).toBeNull();
    });

    it("returns 401 for unauthenticated", async () => {
      mockAuth.mockResolvedValue(null);

      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth();
      expect(result.error).toBe("Unauthorised");
      expect(result.status).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// F10: Per-Guest Chore Token
// ---------------------------------------------------------------------------

describe("F10: Per-Guest Email Link for Chore Access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateChoreToken", () => {
    it("generates a 64-char hex token", async () => {
      const { generateChoreToken } = await import("@/lib/guest-chore-token");
      const token = generateChoreToken();
      expect(token).toMatch(/^[a-f0-9]{64}$/);
    });

    it("generates unique tokens", async () => {
      const { generateChoreToken } = await import("@/lib/guest-chore-token");
      const t1 = generateChoreToken();
      const t2 = generateChoreToken();
      expect(t1).not.toBe(t2);
    });
  });

  describe("createGuestChoreToken", () => {
    it("creates token with 48h expiry", async () => {
      mockPrisma.guestChoreToken.create.mockResolvedValue({ token: "abc123" });

      const { createGuestChoreToken } = await import("@/lib/guest-chore-token");
      const token = await createGuestChoreToken("guest-1", new Date("2026-07-15"));

      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(mockPrisma.guestChoreToken.create).toHaveBeenCalledTimes(1);

      const call = mockPrisma.guestChoreToken.create.mock.calls[0][0];
      expect(call.data.bookingGuestId).toBe("guest-1");
      expect(call.data.tokenHash).toMatch(/^[a-f0-9]{64}$/);

      // Check expiry is ~48h from now
      const expiresAt = call.data.expiresAt as Date;
      const now = new Date();
      const diffHours = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);
      expect(diffHours).toBeGreaterThan(47);
      expect(diffHours).toBeLessThan(49);
    });
  });

  describe("validateGuestChoreToken", () => {
    it("returns null for non-existent token", async () => {
      mockPrisma.guestChoreToken.findUnique.mockResolvedValue(null);

      const { validateGuestChoreToken } = await import("@/lib/guest-chore-token");
      const result = await validateGuestChoreToken("bad-token");
      expect(mockPrisma.guestChoreToken.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tokenHash: hashActionToken("bad-token") },
        })
      );
      expect(result).toBeNull();
    });

    it("returns null for expired token", async () => {
      mockPrisma.guestChoreToken.findUnique.mockResolvedValue({
        id: "t1",
        token: "test-token",
        date: new Date("2026-07-15"),
        expiresAt: new Date("2026-01-01"), // past
        bookingGuest: {
          id: "g1",
          firstName: "Bob",
          lastName: "Jones",
          choreAssignments: [],
        },
      });

      const { validateGuestChoreToken } = await import("@/lib/guest-chore-token");
      const result = await validateGuestChoreToken("test-token");
      expect(result).toBeNull();
    });

    it("returns guest data and date-filtered assignments for valid token", async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 1);

      mockPrisma.guestChoreToken.findUnique.mockResolvedValue({
        id: "t1",
        token: "test-token",
        date: new Date("2026-07-15"),
        expiresAt: futureDate,
        bookingGuest: {
          id: "g1",
          firstName: "Bob",
          lastName: "Jones",
          choreAssignments: [
            {
              id: "ca1",
              date: new Date("2026-07-15"),
              status: "CONFIRMED",
              completedAt: null,
              completedVia: null,
              choreTemplate: {
                name: "Breakfast",
                description: "Cook breakfast",
                timeOfDay: "MORNING",
                sortOrder: 1,
              },
            },
            {
              id: "ca2",
              date: new Date("2026-07-16"), // different date, should be filtered
              status: "CONFIRMED",
              completedAt: null,
              completedVia: null,
              choreTemplate: {
                name: "Dinner",
                description: null,
                timeOfDay: "EVENING",
                sortOrder: 9,
              },
            },
          ],
        },
      });

      const { validateGuestChoreToken } = await import("@/lib/guest-chore-token");
      const result = await validateGuestChoreToken("test-token");

      expect(result).not.toBeNull();
      expect(result!.guest.firstName).toBe("Bob");
      expect(result!.assignments).toHaveLength(1);
      expect(result!.assignments[0].choreTemplateName).toBe("Breakfast");
    });
  });

  describe("GET /api/chores/[token]", () => {
    it("returns 404 for invalid token", async () => {
      mockPrisma.guestChoreToken.findUnique.mockResolvedValue(null);

      const { GET } = await import("@/app/api/chores/[token]/route");
      const res = await GET(
        new Request("http://localhost") as any,
        makeTokenParams("invalid")
      );
      expect(res.status).toBe(404);
    });

    it("returns guest chores for valid token", async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 1);

      mockPrisma.guestChoreToken.findUnique.mockResolvedValue({
        id: "t1",
        token: "test-token-abc",
        date: new Date("2026-07-15"),
        expiresAt: futureDate,
        bookingGuest: {
          id: "g1",
          firstName: "Alice",
          lastName: "Smith",
          choreAssignments: [
            {
              id: "ca1",
              date: new Date("2026-07-15"),
              status: "CONFIRMED",
              completedAt: null,
              completedVia: null,
              choreTemplate: {
                name: "Firewood",
                description: "Chop and stack",
                timeOfDay: "ANYTIME",
                sortOrder: 7,
              },
            },
          ],
        },
      });

      const { GET } = await import("@/app/api/chores/[token]/route");
      const res = await GET(
        new Request("http://localhost") as any,
        makeTokenParams()
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.guest.firstName).toBe("Alice");
      expect(data.assignments).toHaveLength(1);
      expect(data.assignments[0].choreTemplateName).toBe("Firewood");
    });
  });

  describe("PUT /api/chores/[token]", () => {
    it("keeps guest chore token links read-only", async () => {
      const { PUT } = await import("@/app/api/chores/[token]/route");
      const req = new Request("http://localhost", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId: "ca1", action: "complete" }),
      });
      const res = await (PUT as unknown as (req: Request, ctx: unknown) => ReturnType<typeof PUT>)(req, makeTokenParams());
      const data = await res.json();

      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
      expect(data.error).toContain("read-only");
      expect(mockPrisma.guestChoreToken.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.choreAssignment.update).not.toHaveBeenCalled();
    });
  });

  describe("choreRosterTemplate with link", () => {
    it("includes chore link when provided", async () => {
      const { choreRosterTemplate } = await import("@/lib/email-templates/chores");
      const html = choreRosterTemplate(
        "Bob Jones",
        "2026-07-15",
        [{ name: "Breakfast", description: "Cook it" }],
        "https://example.com/chores/abc123"
      );

      expect(html).toContain("Mark Chores Complete");
      expect(html).toContain("https://example.com/chores/abc123");
      expect(html).toContain("expires in 48 hours");
    });

    it("omits chore link section when not provided", async () => {
      const { choreRosterTemplate } = await import("@/lib/email-templates/chores");
      const html = choreRosterTemplate(
        "Bob Jones",
        "2026-07-15",
        [{ name: "Breakfast", description: null }]
      );

      expect(html).not.toContain("Mark Chores Complete");
      expect(html).toContain("Chore Roster");
    });
  });
});
