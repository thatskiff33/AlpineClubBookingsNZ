import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const mockPrisma = {
  booking: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
  member: { count: vi.fn(), findUnique: vi.fn() },
  bookingGuest: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  choreAssignment: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    groupBy: vi.fn(),
  },
  choreTemplate: { findMany: vi.fn(), count: vi.fn() },
  hutLeaderAssignment: { count: vi.fn(), findUnique: vi.fn() },
  memberLodgeAccess: { findMany: vi.fn() },
  lodge: { findFirst: vi.fn() },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  getAuditRequestContext: vi.fn(() => ({
    id: null,
    ipAddress: "127.0.0.1",
    userAgent: null,
  })),
}));

// ---------------------------------------------------------------------------
// Mock auth
// ---------------------------------------------------------------------------

/** The club's zone, named rather than taken from a helper default (#3123). */
const CLUB_ZONE = "Pacific/Auckland";

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown, method = "PUT") {
  return new Request("http://localhost/api/lodge/roster/2026-07-10", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeParams(date = "2026-07-10") {
  return { params: Promise.resolve({ date }) };
}

// ---------------------------------------------------------------------------
// F9: Chore completion with completedAt/completedVia
// ---------------------------------------------------------------------------

describe("F9: PUT /api/lodge/roster/[date] - chore completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.count.mockResolvedValue(1);
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "session-member",
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "LODGE" }],
    });
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockPrisma.booking.count.mockResolvedValue(0);
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
    mockPrisma.lodge.findFirst.mockResolvedValue({ id: "default-lodge" });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    mockAuth.mockResolvedValue({ user: { id: "lodge1", role: "LODGE", accessRoles: [{ role: "LODGE" }] } });
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockPrisma.booking.count.mockResolvedValue(0);
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
    mockPrisma.lodge.findFirst.mockResolvedValue({ id: "default-lodge" });
  });

  it("sets completedAt and completedVia on complete action", async () => {
    const { logAudit } = await import("@/lib/audit");
    mockPrisma.choreAssignment.findFirst.mockResolvedValue({
      id: "assign-1",
      choreTemplateId: "ct1",
      bookingId: "booking-1",
      bookingGuestId: "guest-1",
      bookingGuest: {
        memberId: "member-1",
        firstName: "Alice",
        lastName: "Smith",
      },
    });
    mockPrisma.choreAssignment.update.mockResolvedValue({});

    const { PUT } = await import("@/app/api/lodge/roster/[date]/route");
    const req = makeRequest({
      action: "complete",
      assignmentId: "assign-1",
    }) as any;

    const res = await PUT(req, makeParams());
    expect(res.status).toBe(200);

    expect(mockPrisma.choreAssignment.update).toHaveBeenCalledWith({
      where: { id: "assign-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
        completedAt: expect.any(Date),
        completedVia: "KIOSK",
      }),
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "lodge.chore.completed",
        subjectMemberId: "member-1",
        entityType: "ChoreAssignment",
        entityId: "assign-1",
        category: "lodge",
      })
    );
  });

  it("clears completedAt and completedVia on uncomplete action", async () => {
    const { logAudit } = await import("@/lib/audit");
    mockPrisma.choreAssignment.findFirst.mockResolvedValue({
      id: "assign-1",
      choreTemplateId: "ct1",
      bookingId: "booking-1",
      bookingGuestId: "guest-1",
      bookingGuest: null,
    });
    mockPrisma.choreAssignment.update.mockResolvedValue({});

    const { PUT } = await import("@/app/api/lodge/roster/[date]/route");
    const req = makeRequest({
      action: "uncomplete",
      assignmentId: "assign-1",
    }) as any;

    const res = await PUT(req, makeParams());
    expect(res.status).toBe(200);

    expect(mockPrisma.choreAssignment.update).toHaveBeenCalledWith({
      where: { id: "assign-1" },
      data: {
        status: "CONFIRMED",
        completedAt: null,
        completedVia: null,
      },
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "lodge.chore.uncompleted",
        entityType: "ChoreAssignment",
        entityId: "assign-1",
        category: "lodge",
      })
    );
  });

  it("rejects unauthenticated requests", async () => {
    mockAuth.mockResolvedValue(null);

    const { PUT } = await import("@/app/api/lodge/roster/[date]/route");
    const req = makeRequest({
      action: "complete",
      assignmentId: "assign-1",
    }) as any;

    const res = await PUT(req, makeParams());
    expect(res.status).toBe(401);
  });

  it("rejects MEMBER role", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "m1",
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "USER" }],
    });

    const { PUT } = await import("@/app/api/lodge/roster/[date]/route");
    const req = makeRequest({
      action: "complete",
      assignmentId: "assign-1",
    }) as any;

    const res = await PUT(req, makeParams());
    expect(res.status).toBe(403);
  });

  it("rejects invalid date format", async () => {
    const { PUT } = await import("@/app/api/lodge/roster/[date]/route");
    const req = makeRequest({
      action: "complete",
      assignmentId: "assign-1",
    }) as any;

    const res = await PUT(req, makeParams("not-a-date"));
    expect(res.status).toBe(400);
  });

  it("rejects assignments outside the requested date scope", async () => {
    mockPrisma.choreAssignment.findFirst.mockResolvedValue(null);

    const { PUT } = await import("@/app/api/lodge/roster/[date]/route");
    const req = makeRequest({
      action: "complete",
      assignmentId: "assign-foreign-date",
    }) as any;

    const res = await PUT(req, makeParams());
    expect(res.status).toBe(404);
    expect(mockPrisma.choreAssignment.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F9: GET /api/lodge/roster/[date] returns completedAt/completedVia
// ---------------------------------------------------------------------------

describe("F9: GET /api/lodge/roster/[date] - completedAt/completedVia", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.count.mockResolvedValue(1);
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "session-member",
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "LODGE" }],
    });
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockPrisma.booking.count.mockResolvedValue(0);
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
    mockPrisma.lodge.findFirst.mockResolvedValue({ id: "default-lodge" });
    mockAuth.mockResolvedValue({ user: { id: "lodge1", role: "LODGE", accessRoles: [{ role: "LODGE" }] } });
  });

  it("returns completedAt and completedVia in assignments", async () => {
    const now = new Date("2026-07-10T14:30:00Z");
    mockPrisma.choreAssignment.findMany.mockResolvedValue([
      {
        id: "a1",
        choreTemplateId: "ct1",
        choreTemplate: {
          name: "Breakfast",
          description: null,
          sortOrder: 1,
          timeOfDay: "MORNING",
        },
        bookingGuestId: "g1",
        bookingGuest: { firstName: "Alice", lastName: "Smith", ageTier: "ADULT" },
        bookingId: "b1",
        status: "COMPLETED",
        completedAt: now,
        completedVia: "KIOSK",
      },
    ]);

    const { GET } = await import("@/app/api/lodge/roster/[date]/route");
    const req = new Request("http://localhost/api/lodge/roster/2026-07-10") as any;

    const res = await GET(req, makeParams());
    const data = await res.json();

    expect(data.assignments[0].completedAt).toBe(now.toISOString());
    expect(data.assignments[0].completedVia).toBe("KIOSK");
  });

  it("returns null completedAt/completedVia for non-completed", async () => {
    mockPrisma.choreAssignment.findMany.mockResolvedValue([
      {
        id: "a1",
        choreTemplateId: "ct1",
        choreTemplate: {
          name: "Dinner",
          description: null,
          sortOrder: 9,
          timeOfDay: "EVENING",
        },
        bookingGuestId: "g1",
        bookingGuest: { firstName: "Bob", lastName: "Jones", ageTier: "ADULT" },
        bookingId: "b1",
        status: "CONFIRMED",
        completedAt: null,
        completedVia: null,
      },
    ]);

    const { GET } = await import("@/app/api/lodge/roster/[date]/route");
    const req = new Request("http://localhost/api/lodge/roster/2026-07-10") as any;

    const res = await GET(req, makeParams());
    const data = await res.json();

    expect(data.assignments[0].completedAt).toBeNull();
    expect(data.assignments[0].completedVia).toBeNull();
  });

  it("denies unauthenticated roster reads for today before returning chore assignments", async () => {
    mockAuth.mockResolvedValue(null);
    const { formatDateOnly, getTodayDateOnly } = await import("@/lib/date-only");
    const today = formatDateOnly(getTodayDateOnly(CLUB_ZONE));

    const { GET } = await import("@/app/api/lodge/roster/[date]/route");
    const req = new Request(`http://localhost/api/lodge/roster/${today}`) as any;

    const res = await GET(req, makeParams(today));
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.error).toBe("Unauthorised");
    expect(mockPrisma.choreAssignment.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F9: Guest arrival/departure endpoints
// ---------------------------------------------------------------------------

describe("F9: PUT /api/lodge/guests/[date]/arrive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.count.mockResolvedValue(1);
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "session-member",
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "LODGE" }],
    });
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockPrisma.booking.count.mockResolvedValue(0);
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
    mockPrisma.lodge.findFirst.mockResolvedValue({ id: "default-lodge" });
    mockAuth.mockResolvedValue({ user: { id: "lodge1", role: "LODGE", accessRoles: [{ role: "LODGE" }] } });
  });

  it("sets arrivedAt when guest has not arrived", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue({
      id: "g1",
      bookingId: "booking-1",
      firstName: "Alice",
      lastName: "Guest",
      memberId: "member-1",
      arrivedAt: null,
      // #2628: the arrive lookup loads the stay bounds, the night rows and the
      // booking dates so it can tell a first arrival from a RETURN. A fixture
      // without them only stays green because `departedAt` is unset and the
      // check short-circuits — set a departure and the helper would be handed
      // an undefined booking date. Two nights, the 10th and the 11th, which is
      // exactly what the envelope below describes, so this is a plain arrival.
      stayStart: new Date("2026-07-10T00:00:00.000Z"),
      stayEnd: new Date("2026-07-12T00:00:00.000Z"),
      nights: [
        { stayDate: new Date("2026-07-10T00:00:00.000Z") },
        { stayDate: new Date("2026-07-11T00:00:00.000Z") },
      ],
      booking: {
        memberId: "booking-owner-1",
        checkIn: new Date("2026-07-10T00:00:00.000Z"),
        checkOut: new Date("2026-07-12T00:00:00.000Z"),
      },
    });
    mockPrisma.bookingGuest.update.mockResolvedValue({});

    const { PUT } = await import(
      "@/app/api/lodge/guests/[date]/arrive/route"
    );
    const req = new Request("http://localhost/api/lodge/guests/2026-07-10/arrive", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingGuestId: "g1" }),
    }) as any;

    const res = await PUT(req, makeParams());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.arrivedAt).toBeTruthy();
    expect(mockPrisma.bookingGuest.update).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: { arrivedAt: expect.any(Date) },
    });
  });

  it("clears arrivedAt when guest already arrived (toggle off)", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue({
      id: "g1",
      bookingId: "booking-1",
      firstName: "Alice",
      lastName: "Guest",
      memberId: "member-1",
      arrivedAt: new Date(),
      // #2628: same as the case above — the arrive lookup reads the night rows
      // and the booking dates to spot a return, so the fixture carries the two
      // nights its envelope describes (the 10th and the 11th). This guest is on
      // the first night of a contiguous stay, so the toggle-off path is what
      // runs, unchanged.
      stayStart: new Date("2026-07-10T00:00:00.000Z"),
      stayEnd: new Date("2026-07-12T00:00:00.000Z"),
      nights: [
        { stayDate: new Date("2026-07-10T00:00:00.000Z") },
        { stayDate: new Date("2026-07-11T00:00:00.000Z") },
      ],
      booking: {
        memberId: "booking-owner-1",
        checkIn: new Date("2026-07-10T00:00:00.000Z"),
        checkOut: new Date("2026-07-12T00:00:00.000Z"),
      },
    });
    mockPrisma.bookingGuest.update.mockResolvedValue({});

    const { PUT } = await import(
      "@/app/api/lodge/guests/[date]/arrive/route"
    );
    const req = new Request("http://localhost/api/lodge/guests/2026-07-10/arrive", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingGuestId: "g1" }),
    }) as any;

    const res = await PUT(req, makeParams());
    const data = await res.json();

    expect(data.arrivedAt).toBeNull();
    expect(mockPrisma.bookingGuest.update).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: { arrivedAt: null },
    });
  });

  it("returns 404 for unknown guest", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(null);

    const { PUT } = await import(
      "@/app/api/lodge/guests/[date]/arrive/route"
    );
    const req = new Request("http://localhost/api/lodge/guests/2026-07-10/arrive", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingGuestId: "unknown" }),
    }) as any;

    const res = await PUT(req, makeParams());
    expect(res.status).toBe(404);
  });

  it("rejects a guest from another date", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(null);

    const { PUT } = await import(
      "@/app/api/lodge/guests/[date]/arrive/route"
    );
    const req = new Request("http://localhost/api/lodge/guests/2026-07-10/arrive", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingGuestId: "g-outside-date" }),
    }) as any;

    const res = await PUT(req, makeParams());
    expect(res.status).toBe(404);
    expect(mockPrisma.bookingGuest.update).not.toHaveBeenCalled();
  });

  it("rejects MEMBER role", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "m1",
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "USER" }],
    });

    const { PUT } = await import(
      "@/app/api/lodge/guests/[date]/arrive/route"
    );
    const req = new Request("http://localhost/api/lodge/guests/2026-07-10/arrive", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingGuestId: "g1" }),
    }) as any;

    const res = await PUT(req, makeParams());
    expect(res.status).toBe(403);
  });
});

describe("F9: PUT /api/lodge/guests/[date]/depart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "session-member",
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "LODGE" }],
    });
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockPrisma.booking.count.mockResolvedValue(0);
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
    mockPrisma.lodge.findFirst.mockResolvedValue({ id: "default-lodge" });
    mockAuth.mockResolvedValue({ user: { id: "lodge1", role: "LODGE", accessRoles: [{ role: "LODGE" }] } });
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn(mockPrisma)
    );
    mockPrisma.choreAssignment.findMany.mockResolvedValue([]);
  });

  it("sets departedAt when guest has not departed", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue({
      id: "g1",
      bookingId: "booking-1",
      firstName: "Alice",
      lastName: "Guest",
      memberId: "member-1",
      departedAt: null,
      // #2628: the depart lookup decides in code, not in SQL — the coarse
      // `where` loads anything whose envelope touches the date and
      // `isGuestDepartureMorning` then asks whether this really IS a departure
      // morning for these nights. A fixture without the night rows or the
      // envelope is a guest the endpoint cannot resolve, so it must carry both:
      // one night on the 9th, leaving on the morning of the 10th.
      stayStart: new Date("2026-07-09T00:00:00.000Z"),
      stayEnd: new Date("2026-07-10T00:00:00.000Z"),
      nights: [{ stayDate: new Date("2026-07-09T00:00:00.000Z") }],
      booking: {
        memberId: "booking-owner-1",
        checkIn: new Date("2026-07-09T00:00:00.000Z"),
        checkOut: new Date("2026-07-10T00:00:00.000Z"),
      },
    });
    mockPrisma.bookingGuest.update.mockResolvedValue({});

    const { PUT } = await import(
      "@/app/api/lodge/guests/[date]/depart/route"
    );
    const req = new Request("http://localhost/api/lodge/guests/2026-07-10/depart", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingGuestId: "g1" }),
    }) as any;

    const res = await PUT(req, makeParams());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.departedAt).toBeTruthy();
    expect(mockPrisma.bookingGuest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          booking: expect.objectContaining({
            checkOut: { gte: new Date("2026-07-10T00:00:00.000Z") },
          }),
        }),
      })
    );
    expect(mockPrisma.choreAssignment.deleteMany).toHaveBeenCalledWith({
      where: {
        bookingGuestId: "g1",
        date: { gt: new Date("2026-07-10T00:00:00.000Z") },
        status: "SUGGESTED",
        booking: { lodgeId: "default-lodge" },
        choreTemplate: { lodgeId: "default-lodge" },
      },
    });
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(mockPrisma.$executeRaw.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      mockPrisma.bookingGuest.update.mock.invocationCallOrder[0],
    );
  });

  it("clears departedAt when guest already departed (toggle off)", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue({
      id: "g1",
      bookingId: "booking-1",
      firstName: "Alice",
      lastName: "Guest",
      memberId: "member-1",
      departedAt: new Date(),
      // Same one-night stay as above (#2628) — see the note there.
      stayStart: new Date("2026-07-09T00:00:00.000Z"),
      stayEnd: new Date("2026-07-10T00:00:00.000Z"),
      nights: [{ stayDate: new Date("2026-07-09T00:00:00.000Z") }],
      booking: {
        memberId: "booking-owner-1",
        checkIn: new Date("2026-07-09T00:00:00.000Z"),
        checkOut: new Date("2026-07-10T00:00:00.000Z"),
      },
    });
    mockPrisma.bookingGuest.update.mockResolvedValue({});

    const { PUT } = await import(
      "@/app/api/lodge/guests/[date]/depart/route"
    );
    const req = new Request("http://localhost/api/lodge/guests/2026-07-10/depart", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingGuestId: "g1" }),
    }) as any;

    const res = await PUT(req, makeParams());
    const data = await res.json();

    expect(data.departedAt).toBeNull();
    expect(mockPrisma.choreAssignment.deleteMany).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown guest", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(null);

    const { PUT } = await import(
      "@/app/api/lodge/guests/[date]/depart/route"
    );
    const req = new Request("http://localhost/api/lodge/guests/2026-07-10/depart", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingGuestId: "unknown" }),
    }) as any;

    const res = await PUT(req, makeParams());
    expect(res.status).toBe(404);
  });

  it("rejects departure toggles for guests outside the requested date", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(null);

    const { PUT } = await import(
      "@/app/api/lodge/guests/[date]/depart/route"
    );
    const req = new Request("http://localhost/api/lodge/guests/2026-07-10/depart", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingGuestId: "g-outside-date" }),
    }) as any;

    const res = await PUT(req, makeParams());
    expect(res.status).toBe(404);
    expect(mockPrisma.bookingGuest.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F9: GET /api/lodge/guests/[date] returns arrivedAt/departedAt
// ---------------------------------------------------------------------------

describe("F9: GET /api/lodge/guests/[date] - arrivedAt/departedAt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "session-member",
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "LODGE" }],
    });
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockPrisma.booking.count.mockResolvedValue(0);
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
    mockPrisma.lodge.findFirst.mockResolvedValue({ id: "default-lodge" });
    mockAuth.mockResolvedValue({ user: { id: "lodge1", role: "LODGE", accessRoles: [{ role: "LODGE" }] } });
  });

  it("returns arrivedAt and departedAt for each guest", async () => {
    const arrivedAt = new Date("2026-07-10T10:00:00Z");
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "b1",
        checkIn: new Date("2026-07-10"),
        checkOut: new Date("2026-07-12"),
        member: { firstName: "John", lastName: "Doe" },
        guests: [
          {
            id: "g1",
            firstName: "John",
            lastName: "Doe",
            ageTier: "ADULT",
            isMember: true,
            arrivedAt,
            departedAt: null,
            // #2628: the guests route always loads the night rows and answers
            // presence from them, so the fixture carries the two nights the
            // booking envelope describes — the 10th and the 11th.
            stayStart: new Date("2026-07-10"),
            stayEnd: new Date("2026-07-12"),
            nights: [
              { stayDate: new Date("2026-07-10") },
              { stayDate: new Date("2026-07-11") },
            ],
          },
        ],
      },
    ]);

    const { GET } = await import("@/app/api/lodge/guests/[date]/route");
    const req = new Request("http://localhost/api/lodge/guests/2026-07-10") as any;

    const res = await GET(req, makeParams());
    const data = await res.json();

    expect(data.bookings[0].guests[0].arrivedAt).toBe(arrivedAt.toISOString());
    expect(data.bookings[0].guests[0].departedAt).toBeNull();
  });

  it("prefers the linked member age tier over the booking snapshot", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "b1",
        checkIn: new Date("2026-07-10"),
        checkOut: new Date("2026-07-12"),
        member: { firstName: "John", lastName: "Doe" },
        guests: [
          {
            id: "g1",
            firstName: "Malia",
            lastName: "Hartley-Smith",
            ageTier: "CHILD",
            isMember: true,
            arrivedAt: null,
            departedAt: null,
            member: { ageTier: "YOUTH" },
            // #2628: the guests route always loads the night rows and answers
            // presence from them, so the fixture carries the two nights the
            // booking envelope describes — the 10th and the 11th.
            stayStart: new Date("2026-07-10"),
            stayEnd: new Date("2026-07-12"),
            nights: [
              { stayDate: new Date("2026-07-10") },
              { stayDate: new Date("2026-07-11") },
            ],
          },
        ],
      },
    ]);

    const { GET } = await import("@/app/api/lodge/guests/[date]/route");
    const req = new Request("http://localhost/api/lodge/guests/2026-07-10") as any;

    const res = await GET(req, makeParams());
    const data = await res.json();

    expect(data.bookings[0].guests[0].ageTier).toBe("YOUTH");
  });

  it("denies unauthenticated guest list reads for today before returning PII", async () => {
    mockAuth.mockResolvedValue(null);
    const { formatDateOnly, getTodayDateOnly } = await import("@/lib/date-only");
    const today = formatDateOnly(getTodayDateOnly(CLUB_ZONE));

    const { GET } = await import("@/app/api/lodge/guests/[date]/route");
    const req = new Request(`http://localhost/api/lodge/guests/${today}`) as any;

    const res = await GET(req, makeParams(today));
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.error).toBe("Unauthorised");
    expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
  });

  it("denies with 403 (not 500) when the kiosk account is bound to multiple lodges", async () => {
    // M5: a STAFF account granted at 2+ lodges is ambiguous; resolveKioskLodgeId
    // throws AmbiguousKioskLodgeError, and the route maps it to a clean 403 deny
    // rather than a 500, so a one-click admin misconfiguration is quiet and
    // never serves the wrong lodge's guest list.
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([
      { lodgeId: "lodge-A" },
      { lodgeId: "lodge-B" },
    ]);

    const { GET } = await import("@/app/api/lodge/guests/[date]/route");
    const req = new Request("http://localhost/api/lodge/guests/2026-07-10") as any;

    const res = await GET(req, makeParams());
    const data = await res.json();

    expect(res.status).toBe(403);
    expect(data.error).toBe(
      "This kiosk account is assigned to multiple lodges — an admin must fix the assignment."
    );
    expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F6: GET /api/lodge/roster/[date]/chores
// ---------------------------------------------------------------------------

describe("F6: GET /api/lodge/roster/[date]/chores", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "session-member",
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "LODGE" }],
    });
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockPrisma.booking.count.mockResolvedValue(0);
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
    mockPrisma.lodge.findFirst.mockResolvedValue({ id: "default-lodge" });
  });

  it("returns active templates for admins and hut leaders", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "session-member",
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "ADMIN" }],
    });
    mockPrisma.choreTemplate.findMany.mockResolvedValue([
      { id: "ct1", name: "Kitchen", active: true, sortOrder: 1 },
    ]);

    const { GET } = await import("@/app/api/lodge/roster/[date]/chores/route");
    const req = new Request("http://localhost/api/lodge/roster/2026-07-10/chores") as any;

    const res = await GET(req, makeParams());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.templates).toEqual([
      { id: "ct1", name: "Kitchen", active: true, sortOrder: 1 },
    ]);
    expect(mockPrisma.choreTemplate.findMany).toHaveBeenCalledWith({
      where: { active: true, lodgeId: "default-lodge" },
      orderBy: { sortOrder: "asc" },
    });
  });

  it("rejects lodge-only access for roster setup chores", async () => {
    mockAuth.mockResolvedValue({ user: { id: "lodge1", role: "LODGE", accessRoles: [{ role: "LODGE" }] } });

    const { GET } = await import("@/app/api/lodge/roster/[date]/chores/route");
    const req = new Request("http://localhost/api/lodge/roster/2026-07-10/chores") as any;

    const res = await GET(req, makeParams());

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// F6: POST /api/lodge/roster/[date]/generate
// ---------------------------------------------------------------------------

describe("F6: POST /api/lodge/roster/[date]/generate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "session-member",
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "ADMIN" }],
    });
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockPrisma.booking.count.mockResolvedValue(0);
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
    mockPrisma.lodge.findFirst.mockResolvedValue({ id: "default-lodge" });
    // Generate requires hut-leader or admin tier (LODGE can't generate)
    mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
  });

  it("generates allocations without saving to DB", async () => {
    const date = new Date("2026-07-10");
    const nextDay = new Date("2026-07-11");

    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "b1",
        checkIn: date,
        checkOut: nextDay,
        guests: [
          { id: "g1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT" },
        ],
      },
    ]);

    mockPrisma.choreTemplate.findMany.mockResolvedValue([
      {
        id: "ct1",
        name: "Breakfast",
        recommendedPeopleMin: 1,
        recommendedPeopleMax: 1,
        isEssential: true,
        ageRestriction: "ANY",
        minAge: 0,
        sortOrder: 1,
        timeOfDay: "ANYTIME",
        frequencyMode: "DAILY",
        frequencyDays: null,
        frequencyDaysOfWeek: [],
      },
    ]);

    mockPrisma.choreAssignment.findMany.mockResolvedValue([]);

    const { POST } = await import(
      "@/app/api/lodge/roster/[date]/generate/route"
    );
    const req = new Request("http://localhost/api/lodge/roster/2026-07-10/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choreTemplateIds: ["ct1"] }),
    }) as any;

    const res = await POST(req, makeParams());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.allocations).toHaveLength(1);
    expect(data.allocations[0].choreTemplateName).toBe("Breakfast");
    expect(data.allocations[0].guestName).toBe("Alice Smith");
    // Verify no DB writes
    expect(mockPrisma.choreAssignment.createMany).not.toHaveBeenCalled();
  });

  it("rejects empty choreTemplateIds", async () => {
    const { POST } = await import(
      "@/app/api/lodge/roster/[date]/generate/route"
    );
    const req = new Request("http://localhost/api/lodge/roster/2026-07-10/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choreTemplateIds: [] }),
    }) as any;

    const res = await POST(req, makeParams());
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated requests", async () => {
    mockAuth.mockResolvedValue(null);

    const { POST } = await import(
      "@/app/api/lodge/roster/[date]/generate/route"
    );
    const req = new Request("http://localhost/api/lodge/roster/2026-07-10/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choreTemplateIds: ["ct1"] }),
    }) as any;

    const res = await POST(req, makeParams());
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// F6: POST /api/lodge/roster/[date]/confirm
// ---------------------------------------------------------------------------

describe("F6: POST /api/lodge/roster/[date]/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.count.mockResolvedValue(1);
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "session-member",
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "ADMIN" }],
    });
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockPrisma.booking.count.mockResolvedValue(1);
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
    mockPrisma.lodge.findFirst.mockResolvedValue({ id: "default-lodge" });
    mockPrisma.bookingGuest.findMany.mockResolvedValue([{
      id: "g1",
      bookingId: "b1",
      stayStart: new Date("2026-07-10T00:00:00.000Z"),
      stayEnd: new Date("2026-07-11T00:00:00.000Z"),
      nights: [],
      booking: {
        checkIn: new Date("2026-07-10T00:00:00.000Z"),
        checkOut: new Date("2026-07-11T00:00:00.000Z"),
      },
    }]);
    mockPrisma.choreTemplate.count.mockResolvedValue(1);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    // Confirm requires hut-leader or admin tier (LODGE can't confirm)
    mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
  });

  it("saves allocations as CONFIRMED when no existing roster", async () => {
    mockPrisma.choreAssignment.count.mockResolvedValue(0);

    const { POST } = await import(
      "@/app/api/lodge/roster/[date]/confirm/route"
    );
    const req = new Request("http://localhost/api/lodge/roster/2026-07-10/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allocations: [
          {
            choreTemplateId: "ct1",
            bookingGuestId: "g1",
            bookingId: "b1",
          },
        ],
      }),
    }) as any;

    const res = await POST(req, makeParams());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("returns 409 when roster exists and overwrite not set", async () => {
    mockPrisma.choreAssignment.count.mockResolvedValue(5);

    const { POST } = await import(
      "@/app/api/lodge/roster/[date]/confirm/route"
    );
    const req = new Request("http://localhost/api/lodge/roster/2026-07-10/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allocations: [
          {
            choreTemplateId: "ct1",
            bookingGuestId: "g1",
            bookingId: "b1",
          },
        ],
      }),
    }) as any;

    const res = await POST(req, makeParams());
    expect(res.status).toBe(409);
  });

  it("allows overwrite when explicitly set", async () => {
    mockPrisma.choreAssignment.count.mockResolvedValue(5);

    const { POST } = await import(
      "@/app/api/lodge/roster/[date]/confirm/route"
    );
    const req = new Request("http://localhost/api/lodge/roster/2026-07-10/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allocations: [
          {
            choreTemplateId: "ct1",
            bookingGuestId: "g1",
            bookingId: "b1",
          },
        ],
        overwrite: true,
      }),
    }) as any;

    const res = await POST(req, makeParams());
    expect(res.status).toBe(200);
  });

  it("rejects empty allocations", async () => {
    const { POST } = await import(
      "@/app/api/lodge/roster/[date]/confirm/route"
    );
    const req = new Request("http://localhost/api/lodge/roster/2026-07-10/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allocations: [] }),
    }) as any;

    const res = await POST(req, makeParams());
    expect(res.status).toBe(400);
  });

  it("rejects MEMBER role", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "session-member",
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "USER" }],
    });

    const { POST } = await import(
      "@/app/api/lodge/roster/[date]/confirm/route"
    );
    const req = new Request("http://localhost/api/lodge/roster/2026-07-10/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allocations: [
          {
            choreTemplateId: "ct1",
            bookingGuestId: "g1",
            bookingId: "b1",
          },
        ],
      }),
    }) as any;

    const res = await POST(req, makeParams());
    expect(res.status).toBe(403);
  });

  it("rejects allocations whose guest does not belong to the booking for that date", async () => {
    mockPrisma.bookingGuest.findMany.mockResolvedValue([{
      id: "g1",
      bookingId: "b-other",
      stayStart: new Date("2026-07-10T00:00:00.000Z"),
      stayEnd: new Date("2026-07-11T00:00:00.000Z"),
      nights: [],
      booking: {
        checkIn: new Date("2026-07-10T00:00:00.000Z"),
        checkOut: new Date("2026-07-11T00:00:00.000Z"),
      },
    }]);

    const { POST } = await import(
      "@/app/api/lodge/roster/[date]/confirm/route"
    );
    const req = new Request("http://localhost/api/lodge/roster/2026-07-10/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        allocations: [
          {
            choreTemplateId: "ct1",
            bookingGuestId: "g1",
            bookingId: "b1",
          },
        ],
      }),
    }) as any;

    const res = await POST(req, makeParams());
    expect(res.status).toBe(400);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.choreAssignment.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.choreAssignment.createMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F6: GET /api/lodge/roster/[date]/frequency-info
// ---------------------------------------------------------------------------

describe("F6: GET /api/lodge/roster/[date]/frequency-info", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "session-member",
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "LODGE" }],
    });
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockPrisma.booking.count.mockResolvedValue(0);
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
    mockPrisma.lodge.findFirst.mockResolvedValue({ id: "default-lodge" });
    mockAuth.mockResolvedValue({ user: { id: "lodge1", role: "LODGE", accessRoles: [{ role: "LODGE" }] } });
  });

  it("returns last rostered dates per chore template", async () => {
    mockPrisma.choreAssignment.groupBy.mockResolvedValue([
      { choreTemplateId: "ct1", _max: { date: new Date("2026-07-08") } },
      { choreTemplateId: "ct2", _max: { date: new Date("2026-07-09") } },
    ]);

    const { GET } = await import(
      "@/app/api/lodge/roster/[date]/frequency-info/route"
    );
    const req = new Request(
      "http://localhost/api/lodge/roster/2026-07-10/frequency-info"
    ) as any;

    const res = await GET(req, makeParams());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.lastRosteredDates).toEqual({
      ct1: "2026-07-08",
      ct2: "2026-07-09",
    });
  });
});
