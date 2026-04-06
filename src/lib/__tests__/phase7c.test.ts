import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const mockPrisma = {
  booking: { findMany: vi.fn() },
  bookingGuest: { findUnique: vi.fn(), update: vi.fn() },
  choreAssignment: {
    findMany: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    groupBy: vi.fn(),
  },
  choreTemplate: { findMany: vi.fn() },
  hutLeaderAssignment: { count: vi.fn() },
  $transaction: vi.fn(),
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
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockAuth.mockResolvedValue({ user: { id: "lodge1", role: "LODGE" } });
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
  });

  it("sets completedAt and completedVia on complete action", async () => {
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
  });

  it("clears completedAt and completedVia on uncomplete action", async () => {
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
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } });

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
});

// ---------------------------------------------------------------------------
// F9: GET /api/lodge/roster/[date] returns completedAt/completedVia
// ---------------------------------------------------------------------------

describe("F9: GET /api/lodge/roster/[date] - completedAt/completedVia", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockAuth.mockResolvedValue({ user: { id: "lodge1", role: "LODGE" } });
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
});

// ---------------------------------------------------------------------------
// F9: Guest arrival/departure endpoints
// ---------------------------------------------------------------------------

describe("F9: PUT /api/lodge/guests/[date]/arrive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockAuth.mockResolvedValue({ user: { id: "lodge1", role: "LODGE" } });
  });

  it("sets arrivedAt when guest has not arrived", async () => {
    mockPrisma.bookingGuest.findUnique.mockResolvedValue({
      id: "g1",
      arrivedAt: null,
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
    mockPrisma.bookingGuest.findUnique.mockResolvedValue({
      id: "g1",
      arrivedAt: new Date(),
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
    mockPrisma.bookingGuest.findUnique.mockResolvedValue(null);

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

  it("rejects MEMBER role", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } });

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
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockAuth.mockResolvedValue({ user: { id: "lodge1", role: "LODGE" } });
  });

  it("sets departedAt when guest has not departed", async () => {
    mockPrisma.bookingGuest.findUnique.mockResolvedValue({
      id: "g1",
      departedAt: null,
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
  });

  it("clears departedAt when guest already departed (toggle off)", async () => {
    mockPrisma.bookingGuest.findUnique.mockResolvedValue({
      id: "g1",
      departedAt: new Date(),
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
  });

  it("returns 404 for unknown guest", async () => {
    mockPrisma.bookingGuest.findUnique.mockResolvedValue(null);

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
});

// ---------------------------------------------------------------------------
// F9: GET /api/lodge/guests/[date] returns arrivedAt/departedAt
// ---------------------------------------------------------------------------

describe("F9: GET /api/lodge/guests/[date] - arrivedAt/departedAt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockAuth.mockResolvedValue({ user: { id: "lodge1", role: "LODGE" } });
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
});

// ---------------------------------------------------------------------------
// F6: POST /api/lodge/roster/[date]/generate
// ---------------------------------------------------------------------------

describe("F6: POST /api/lodge/roster/[date]/generate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockAuth.mockResolvedValue({ user: { id: "lodge1", role: "LODGE" } });
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
        timeOfDay: "MORNING",
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
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockAuth.mockResolvedValue({ user: { id: "lodge1", role: "LODGE" } });
  });

  it("saves allocations as CONFIRMED when no existing roster", async () => {
    mockPrisma.choreAssignment.count.mockResolvedValue(0);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      await fn({
        choreAssignment: {
          deleteMany: vi.fn(),
          createMany: vi.fn(),
        },
      });
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
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      await fn({
        choreAssignment: {
          deleteMany: vi.fn(),
          createMany: vi.fn(),
        },
      });
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
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } });

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
});

// ---------------------------------------------------------------------------
// F6: GET /api/lodge/roster/[date]/frequency-info
// ---------------------------------------------------------------------------

describe("F6: GET /api/lodge/roster/[date]/frequency-info", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockAuth.mockResolvedValue({ user: { id: "lodge1", role: "LODGE" } });
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
