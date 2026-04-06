import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const mockPrisma = {
  hutLeaderAssignment: {
    count: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
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
    findUnique: vi.fn(),
    findMany: vi.fn(),
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

function makeRequest(body: unknown, method = "POST") {
  return new Request("http://localhost/api/admin/hut-leaders", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeParams(id = "assign-1") {
  return { params: Promise.resolve({ id }) };
}

function makeTokenParams(token = "test-token-abc") {
  return { params: Promise.resolve({ token }) };
}

// ---------------------------------------------------------------------------
// F8: Hut Leader Assignment
// ---------------------------------------------------------------------------

describe("F8: Hut Leader Role Assignment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        user: { id: "m1", role: "MEMBER", email: "a@b.com" },
      });

      const { GET } = await import(
        "@/app/api/admin/hut-leaders/route"
      );
      const res = await GET();
      expect(res.status).toBe(403);
    });

    it("returns assignments for admin", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", email: "admin@tac.org.nz" },
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
      const res = await GET();
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.assignments).toHaveLength(1);
      expect(data.assignments[0].memberName).toBe("Alice Smith");
      expect(data.assignments[0].startDate).toBe("2026-07-10");
    });
  });

  describe("POST /api/admin/hut-leaders", () => {
    it("returns 403 for non-admin", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "m1", role: "MEMBER", email: "a@b.com" },
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
        user: { id: "admin1", role: "ADMIN", email: "admin@tac.org.nz" },
      });

      mockPrisma.member.findUnique.mockResolvedValue({ id: "m1", active: true });
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

    it("rejects when endDate before startDate", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", email: "admin@tac.org.nz" },
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
        user: { id: "admin1", role: "ADMIN", email: "admin@tac.org.nz" },
      });

      mockPrisma.member.findUnique.mockResolvedValue({ id: "m1", active: false });

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
        user: { id: "m1", role: "MEMBER", email: "a@b.com" },
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
        user: { id: "admin1", role: "ADMIN", email: "admin@tac.org.nz" },
      });

      mockPrisma.hutLeaderAssignment.findUnique.mockResolvedValue({ id: "assign-1" });
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
        user: { id: "admin1", role: "ADMIN", email: "admin@tac.org.nz" },
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
        user: { id: "admin1", role: "ADMIN", email: "admin@tac.org.nz" },
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
        user: { id: "admin1", role: "ADMIN", email: "admin@tac.org.nz" },
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

  describe("Lodge auth with hut leader", () => {
    it("allows MEMBER with active hut leader assignment", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "m1", role: "MEMBER", email: "m@test.com" },
      });
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(1);

      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth();
      expect(result.error).toBeNull();
    });

    it("rejects MEMBER without hut leader assignment", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "m2", role: "MEMBER", email: "m2@test.com" },
      });
      mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);

      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth();
      expect(result.error).toBe("Forbidden");
      expect(result.status).toBe(403);
    });

    it("allows LODGE role without hut leader check", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "lodge1", role: "LODGE", email: "lodge@tac.org.nz" },
      });

      const { checkLodgeAuth } = await import("@/lib/lodge-auth");
      const result = await checkLodgeAuth();
      expect(result.error).toBeNull();
      expect(mockPrisma.hutLeaderAssignment.count).not.toHaveBeenCalled();
    });

    it("allows ADMIN role without hut leader check", async () => {
      mockAuth.mockResolvedValue({
        user: { id: "admin1", role: "ADMIN", email: "admin@tac.org.nz" },
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
    it("returns 404 for invalid token", async () => {
      mockPrisma.guestChoreToken.findUnique.mockResolvedValue(null);

      const { PUT } = await import("@/app/api/chores/[token]/route");
      const req = new Request("http://localhost", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId: "ca1", action: "complete" }),
      });
      const res = await PUT(req as any, makeTokenParams("invalid"));
      expect(res.status).toBe(404);
    });

    it("completes a valid assignment via guest link", async () => {
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
                description: null,
                timeOfDay: "ANYTIME",
                sortOrder: 7,
              },
            },
          ],
        },
      });

      mockPrisma.choreAssignment.update.mockResolvedValue({});

      const { PUT } = await import("@/app/api/chores/[token]/route");
      const req = new Request("http://localhost", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId: "ca1", action: "complete" }),
      });
      const res = await PUT(req as any, makeTokenParams());
      expect(res.status).toBe(200);

      expect(mockPrisma.choreAssignment.update).toHaveBeenCalledWith({
        where: { id: "ca1" },
        data: {
          status: "COMPLETED",
          completedAt: expect.any(Date),
          completedVia: "GUEST_LINK",
        },
      });
    });

    it("uncompletes a valid assignment via guest link", async () => {
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
              status: "COMPLETED",
              completedAt: new Date(),
              completedVia: "GUEST_LINK",
              choreTemplate: {
                name: "Firewood",
                description: null,
                timeOfDay: "ANYTIME",
                sortOrder: 7,
              },
            },
          ],
        },
      });

      mockPrisma.choreAssignment.update.mockResolvedValue({});

      const { PUT } = await import("@/app/api/chores/[token]/route");
      const req = new Request("http://localhost", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId: "ca1", action: "uncomplete" }),
      });
      const res = await PUT(req as any, makeTokenParams());
      expect(res.status).toBe(200);

      expect(mockPrisma.choreAssignment.update).toHaveBeenCalledWith({
        where: { id: "ca1" },
        data: {
          status: "CONFIRMED",
          completedAt: null,
          completedVia: null,
        },
      });
    });

    it("rejects assignment not belonging to this guest", async () => {
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
                description: null,
                timeOfDay: "ANYTIME",
                sortOrder: 7,
              },
            },
          ],
        },
      });

      const { PUT } = await import("@/app/api/chores/[token]/route");
      const req = new Request("http://localhost", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId: "ca-OTHER", action: "complete" }),
      });
      const res = await PUT(req as any, makeTokenParams());
      expect(res.status).toBe(403);
    });

    it("rejects invalid action", async () => {
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
          choreAssignments: [],
        },
      });

      const { PUT } = await import("@/app/api/chores/[token]/route");
      const req = new Request("http://localhost", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId: "ca1", action: "delete" }),
      });
      const res = await PUT(req as any, makeTokenParams());
      expect(res.status).toBe(400);
    });
  });

  describe("choreRosterTemplate with link", () => {
    it("includes chore link when provided", async () => {
      const { choreRosterTemplate } = await import("@/lib/email-templates");
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
      const { choreRosterTemplate } = await import("@/lib/email-templates");
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
