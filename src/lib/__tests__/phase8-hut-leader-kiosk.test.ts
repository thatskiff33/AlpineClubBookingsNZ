import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _testStore } from "../rate-limit";
import {
  HUT_LEADER_PIN_SESSION_COOKIE,
  _testLodgePinFailureStore,
  clearLodgePinFailures,
  createLodgePinSessionWithVersion,
  getActiveLodgePinSessionForDate,
  getLodgePinLockout,
  recordLodgePinFailure,
} from "../lodge-pin-session";

const {
  mockPrisma,
  mockAuth,
  mockSendHutLeaderAssignmentEmail,
} = vi.hoisted(() => ({
  mockPrisma: {
    hutLeaderAssignment: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    member: {
      count: vi.fn(),
      findUnique: vi.fn(),
    },
    booking: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    bookingGuest: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    choreAssignment: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    memberLodgeAccess: {
      findMany: vi.fn(),
    },
    lodge: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  mockAuth: vi.fn(),
  mockSendHutLeaderAssignmentEmail: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
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
vi.mock("@/lib/email", () => ({
  sendHutLeaderAssignmentEmail: (args: unknown) =>
    mockSendHutLeaderAssignmentEmail(args),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe("Phase 8: Hut Leader & Kiosk Improvements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _testStore.clear();
    _testLodgePinFailureStore.clear();
    process.env.AUTH_SECRET = "test-auth-secret";
    process.env.NEXTAUTH_SECRET = "test-auth-secret";
    mockPrisma.member.count.mockResolvedValue(1);
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "admin-1",
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "ADMIN" }],
    });
    mockSendHutLeaderAssignmentEmail.mockResolvedValue(undefined);
    mockPrisma.auditLog.create.mockResolvedValue({});
    mockPrisma.choreAssignment.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
    mockPrisma.lodge.findFirst.mockResolvedValue({ id: "default-lodge" });
    mockPrisma.$transaction.mockImplementation(
      async (callback: (tx: typeof mockPrisma) => Promise<unknown>) =>
        callback(mockPrisma)
    );
  });

  it("creates hut leader assignments with a bcrypt-hashed PIN and emails the plaintext PIN", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
    });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      active: true,
      role: "USER",
      accessRoles: [{ role: "USER" }],
      email: "alice@example.com",
      firstName: "Alice",
    });
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
    mockPrisma.hutLeaderAssignment.create.mockResolvedValue({ id: "assign-1" });

    const { POST } = await import("@/app/api/admin/hut-leaders/route");
    const res = await POST(
      new Request("http://localhost/api/admin/hut-leaders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId: "member-1",
          startDate: "2026-07-10",
          endDate: "2026-07-17",
        }),
      }) as any
    );

    expect(res.status).toBe(201);
    expect(mockSendHutLeaderAssignmentEmail).toHaveBeenCalledTimes(1);

    const createCall = mockPrisma.hutLeaderAssignment.create.mock.calls[0][0];
    const emailCall = mockSendHutLeaderAssignmentEmail.mock.calls[0][0];

    expect(emailCall.pin).toMatch(/^\d{6}$/);
    expect(createCall.data.hutLeaderPin).toEqual(expect.any(String));
    expect(createCall.data.hutLeaderPin).not.toBe(emailCall.pin);
    expect(
      await bcrypt.compare(emailCall.pin, createCall.data.hutLeaderPin)
    ).toBe(true);
  }, 20000);

  it("rejects a PIN scoped to another lodge when kioskLodgeId is passed", async () => {
    // findMany itself is mocked (no real DB filtering), so it reflects what
    // the where-clause would already have excluded: an assignment scoped to
    // a different lodge than the kiosk never comes back from the query.
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);

    const { findActiveHutLeaderAssignmentByPin } = await import(
      "@/lib/lodge-pin-session"
    );
    const result = await findActiveHutLeaderAssignmentByPin(
      "123456",
      undefined,
      "kiosk-lodge"
    );

    expect(result).toBeNull();
    expect(mockPrisma.hutLeaderAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lodgeId: "kiosk-lodge",
        }),
      })
    );
  });

  it("matches a null-lodgeId assignment against any kioskLodgeId", async () => {
    const pinHash = await bcrypt.hash("123456", 12);
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
      {
        id: "assign-1",
        memberId: "member-1",
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        endDate: new Date("2026-07-20T00:00:00.000Z"),
        hutLeaderPin: pinHash,
        lodgeId: null,
        member: {
          id: "member-1",
          active: true,
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        },
      },
    ]);

    const { findActiveHutLeaderAssignmentByPin } = await import(
      "@/lib/lodge-pin-session"
    );
    const result = await findActiveHutLeaderAssignmentByPin(
      "123456",
      undefined,
      "kiosk-lodge"
    );

    expect(result).not.toBeNull();
    expect(result?.id).toBe("assign-1");
  });

  it("resolves the kiosk lodge binding from the staff grant on PIN login", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "lodge-1", role: "LODGE", accessRoles: [{ role: "LODGE" }], email: "lodge@example.org" },
    });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "lodge-1",
      accessRoles: [{ role: "LODGE" }],
    });
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([
      { lodgeId: "bound-lodge" },
    ]);
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);

    const { POST } = await import("@/app/api/lodge/pin-login/route");
    const res = await POST(
      new Request("http://localhost/api/lodge/pin-login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "10.0.0.9",
        },
        body: JSON.stringify({ pin: "654321" }),
      }) as any
    );

    expect(res.status).toBe(401);
    expect(mockPrisma.memberLodgeAccess.findMany).toHaveBeenCalledWith({
      where: { memberId: "lodge-1", kind: "STAFF" },
      select: { lodgeId: true },
      take: 2,
    });
    expect(mockPrisma.hutLeaderAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lodgeId: "bound-lodge",
        }),
      })
    );
    // No STAFF grant means getDefaultLodgeId is never reached for this case.
    expect(mockPrisma.lodge.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to the default lodge on PIN login when there is no staff grant", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "lodge-1", role: "LODGE", accessRoles: [{ role: "LODGE" }], email: "lodge@example.org" },
    });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "lodge-1",
      accessRoles: [{ role: "LODGE" }],
    });
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
    mockPrisma.lodge.findFirst.mockResolvedValue({ id: "default-lodge" });
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);

    const { POST } = await import("@/app/api/lodge/pin-login/route");
    const res = await POST(
      new Request("http://localhost/api/lodge/pin-login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "10.0.0.10",
        },
        body: JSON.stringify({ pin: "654321" }),
      }) as any
    );

    expect(res.status).toBe(401);
    expect(mockPrisma.lodge.findFirst).toHaveBeenCalled();
    expect(mockPrisma.hutLeaderAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lodgeId: "default-lodge",
        }),
      })
    );
  });

  it("denies PIN login when the kiosk account is bound to multiple lodges (M5)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "lodge-1", role: "LODGE", accessRoles: [{ role: "LODGE" }], email: "lodge@example.org" },
    });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "lodge-1",
      accessRoles: [{ role: "LODGE" }],
    });
    // Two STAFF grants: an ordinary admin misselection. The kiosk must not
    // silently accept the default lodge's hut-leader PINs.
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([
      { lodgeId: "lodge-A" },
      { lodgeId: "lodge-B" },
    ]);
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);

    const { POST } = await import("@/app/api/lodge/pin-login/route");
    const res = await POST(
      new Request("http://localhost/api/lodge/pin-login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "10.0.0.11",
        },
        body: JSON.stringify({ pin: "654321" }),
      }) as any
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error:
        "This kiosk account is assigned to multiple lodges — an admin must fix the assignment.",
    });
    // Deny before falling back to the default lodge or attempting a PIN match.
    expect(mockPrisma.lodge.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.hutLeaderAssignment.findMany).not.toHaveBeenCalled();
  });

  it("resolveKioskLodgeId denies an ambiguous multi-lodge kiosk binding (M5)", async () => {
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([
      { lodgeId: "lodge-A" },
      { lodgeId: "lodge-B" },
    ]);

    const { resolveKioskLodgeId } = await import("@/lib/lodge-auth");
    const { AmbiguousKioskLodgeError } = await import("@/lib/lodge-access");

    await expect(
      resolveKioskLodgeId(
        { tier: "lodge", member: { id: "lodge-1" } },
        mockPrisma as never
      )
    ).rejects.toBeInstanceOf(AmbiguousKioskLodgeError);
    // "No default-lodge data served": the default lodge is never resolved.
    expect(mockPrisma.lodge.findFirst).not.toHaveBeenCalled();
  });

  it("resolveKioskLodgeId returns the bound lodge for a single kiosk grant (M5)", async () => {
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([
      { lodgeId: "bound-lodge" },
    ]);

    const { resolveKioskLodgeId } = await import("@/lib/lodge-auth");
    const lodgeId = await resolveKioskLodgeId(
      { tier: "lodge", member: { id: "lodge-1" } },
      mockPrisma as never
    );

    expect(lodgeId).toBe("bound-lodge");
    expect(mockPrisma.lodge.findFirst).not.toHaveBeenCalled();
  });

  it("resolveKioskLodgeId falls back to the default lodge with no kiosk grant (M5)", async () => {
    mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
    mockPrisma.lodge.findFirst.mockResolvedValue({ id: "default-lodge" });

    const { resolveKioskLodgeId } = await import("@/lib/lodge-auth");
    const lodgeId = await resolveKioskLodgeId(
      { tier: "admin", member: { id: "lodge-1" } },
      mockPrisma as never
    );

    expect(lodgeId).toBe("default-lodge");
  });

  it("formats member guest phone numbers for the kiosk guest list API", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
    });
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        checkIn: new Date("2026-07-10T00:00:00.000Z"),
        checkOut: new Date("2026-07-11T00:00:00.000Z"),
        expectedArrivalTime: "15:00",
        member: { firstName: "Booking", lastName: "Owner" },
        guests: [
          {
            id: "guest-1",
            firstName: "Alice",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: true,
            arrivedAt: null,
            departedAt: null,
            member: {
              ageTier: "ADULT",
              phoneCountryCode: "64",
              phoneAreaCode: "27",
              phoneNumber: "4224115",
            },
          },
        ],
      },
    ]);

    const { GET } = await import("@/app/api/lodge/guests/[date]/route");
    const res = await GET(
      new Request("http://localhost/api/lodge/guests/2026-07-10") as any,
      { params: Promise.resolve({ date: "2026-07-10" }) }
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.bookings[0].guests[0].phone).toBe("+64 27 4224115");
  });

  it("hides non-adult phone numbers in the kiosk guest list API", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
    });
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        checkIn: new Date("2026-07-10T00:00:00.000Z"),
        checkOut: new Date("2026-07-11T00:00:00.000Z"),
        expectedArrivalTime: "15:00",
        member: { firstName: "Booking", lastName: "Owner" },
        guests: [
          {
            id: "guest-1",
            firstName: "Young",
            lastName: "Guest",
            ageTier: "YOUTH",
            isMember: true,
            arrivedAt: null,
            departedAt: null,
            member: {
              ageTier: "YOUTH",
              phoneCountryCode: "64",
              phoneAreaCode: "27",
              phoneNumber: "4224115",
            },
          },
        ],
      },
    ]);

    const { GET } = await import("@/app/api/lodge/guests/[date]/route");
    const res = await GET(
      new Request("http://localhost/api/lodge/guests/2026-07-10") as any,
      { params: Promise.resolve({ date: "2026-07-10" }) }
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.bookings[0].guests[0].ageTier).toBe("YOUTH");
    expect(data.bookings[0].guests[0].phone).toBeNull();
  });

  it("redacts adult phone numbers from staying-guest lodge list responses", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "member-1", role: "USER", accessRoles: [{ role: "USER" }], email: "member@example.org" },
    });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      accessRoles: [{ role: "USER" }],
    });
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(0);
    mockPrisma.booking.count.mockResolvedValue(1);
    mockPrisma.booking.findFirst.mockResolvedValue({ lodgeId: "default-lodge" });
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        checkIn: new Date("2026-07-10T00:00:00.000Z"),
        checkOut: new Date("2026-07-11T00:00:00.000Z"),
        expectedArrivalTime: "15:00",
        member: { firstName: "Booking", lastName: "Owner" },
        guests: [
          {
            id: "guest-1",
            firstName: "Alice",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: true,
            arrivedAt: null,
            departedAt: null,
            member: {
              ageTier: "ADULT",
              phoneCountryCode: "64",
              phoneAreaCode: "27",
              phoneNumber: "4224115",
            },
          },
        ],
      },
    ]);

    const { GET } = await import("@/app/api/lodge/guests/[date]/route");
    const res = await GET(
      new Request("http://localhost/api/lodge/guests/2026-07-10") as any,
      { params: Promise.resolve({ date: "2026-07-10" }) }
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tier).toBe("staying-guest");
    expect(data.bookings[0].guests[0].ageTier).toBe("ADULT");
    expect(data.bookings[0].guests[0].phone).toBeNull();
  });

  it("includes checkout-day guests only in lodge-list guest scope", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
    });
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        checkIn: new Date("2026-07-10T00:00:00.000Z"),
        checkOut: new Date("2026-07-11T00:00:00.000Z"),
        expectedArrivalTime: null,
        member: { firstName: "Booking", lastName: "Owner" },
        guests: [
          {
            id: "guest-1",
            firstName: "Alice",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: true,
            arrivedAt: null,
            departedAt: null,
            member: { ageTier: "ADULT" },
          },
        ],
      },
    ]);

    const { GET } = await import("@/app/api/lodge/guests/[date]/route");
    const res = await GET(
      new Request(
        "http://localhost/api/lodge/guests/2026-07-11?scope=lodge-list"
      ) as any,
      { params: Promise.resolve({ date: "2026-07-11" }) }
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          checkOut: { gte: new Date("2026-07-11T00:00:00.000Z") },
        }),
      })
    );
    expect(data.bookings[0].guests[0].isArriving).toBe(false);
    expect(data.bookings[0].guests[0].isDeparting).toBe(true);
  });

  it("keeps the default lodge guest API scope stay-night compatible", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
    });
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/lodge/guests/[date]/route");
    const res = await GET(
      new Request("http://localhost/api/lodge/guests/2026-07-11") as any,
      { params: Promise.resolve({ date: "2026-07-11" }) }
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          checkOut: { gt: new Date("2026-07-11T00:00:00.000Z") },
        }),
      })
    );
  });

  it("filters lodge guest lists by individual guest stay ranges", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
    });
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        checkIn: new Date("2026-07-10T00:00:00.000Z"),
        checkOut: new Date("2026-07-15T00:00:00.000Z"),
        expectedArrivalTime: null,
        member: { firstName: "Booking", lastName: "Owner" },
        guests: [
          {
            id: "active-guest",
            firstName: "Active",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: true,
            stayStart: new Date("2026-07-10T00:00:00.000Z"),
            stayEnd: new Date("2026-07-15T00:00:00.000Z"),
            arrivedAt: null,
            departedAt: null,
            member: { ageTier: "ADULT" },
          },
          {
            id: "departed-guest",
            firstName: "Departed",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: true,
            stayStart: new Date("2026-07-10T00:00:00.000Z"),
            stayEnd: new Date("2026-07-12T00:00:00.000Z"),
            arrivedAt: null,
            departedAt: null,
            member: { ageTier: "ADULT" },
          },
        ],
      },
    ]);

    const { GET } = await import("@/app/api/lodge/guests/[date]/route");
    const res = await GET(
      new Request("http://localhost/api/lodge/guests/2026-07-12") as any,
      { params: Promise.resolve({ date: "2026-07-12" }) }
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          guests: {
            some: {
              stayStart: { lte: new Date("2026-07-12T00:00:00.000Z") },
              stayEnd: { gt: new Date("2026-07-12T00:00:00.000Z") },
            },
          },
        }),
      })
    );
    const data = await res.json();
    expect(data.totalGuests).toBe(1);
    expect(data.bookings[0].guests.map((guest: { id: string }) => guest.id)).toEqual([
      "active-guest",
    ]);
  });

  it("returns kiosk week summaries only for dates inside a hut leader's accessible range", async () => {
    mockAuth.mockResolvedValue({
      user: {
        id: "leader-1",
        role: "USER",
        accessRoles: [{ role: "USER" }],
        email: "leader@example.org",
      },
    });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "leader-1",
      accessRoles: [{ role: "USER" }],
    });
    mockPrisma.hutLeaderAssignment.count.mockResolvedValue(1);
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
      {
        startDate: new Date("2026-04-14T00:00:00.000Z"),
        endDate: new Date("2026-04-16T00:00:00.000Z"),
      },
    ]);
    mockPrisma.hutLeaderAssignment.findFirst.mockResolvedValue({
      lodgeId: "default-lodge",
    });
    mockPrisma.booking.findMany.mockResolvedValue([]);
    mockPrisma.choreAssignment.findMany.mockResolvedValue([]);

    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/lodge/week/route");
    const res = await GET(
      new NextRequest("http://localhost/api/lodge/week?start=2026-04-13")
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.start).toBe("2026-04-13");
    expect(data.days).toHaveLength(7);
    expect(
      data.days.map((day: { date: string; accessible: boolean }) => [
        day.date,
        day.accessible,
      ])
    ).toEqual([
      ["2026-04-13", true],
      ["2026-04-14", true],
      ["2026-04-15", true],
      ["2026-04-16", true],
      ["2026-04-17", false],
      ["2026-04-18", false],
      ["2026-04-19", false],
    ]);
    expect(Object.keys(data.days[4]).sort()).toEqual([
      "accessible",
      "date",
    ]);
  });

  it("returns kiosk week counts from one booking query without guest PII", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
    });
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        checkIn: new Date("2026-04-13T00:00:00.000Z"),
        checkOut: new Date("2026-04-16T00:00:00.000Z"),
        memberName: "Secret Owner",
        guests: [
          {
            firstName: "Alice",
            lastName: "Secret",
            stayStart: new Date("2026-04-13T00:00:00.000Z"),
            stayEnd: new Date("2026-04-15T00:00:00.000Z"),
            ageTier: "ADULT",
            nights: [],
          },
          {
            firstName: "Bob",
            lastName: "Hidden",
            stayStart: new Date("2026-04-14T00:00:00.000Z"),
            stayEnd: new Date("2026-04-16T00:00:00.000Z"),
            ageTier: "YOUTH",
            nights: [],
          },
          {
            firstName: "Cara",
            lastName: "Private",
            stayStart: new Date("2026-04-12T00:00:00.000Z"),
            stayEnd: new Date("2026-04-14T00:00:00.000Z"),
            ageTier: "CHILD",
            nights: [],
          },
        ],
      },
    ]);
    mockPrisma.choreAssignment.findMany.mockResolvedValue([
      {
        date: new Date("2026-04-14T00:00:00.000Z"),
        status: "CONFIRMED",
        bookingId: "booking-1",
      },
    ]);

    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/lodge/week/route");
    const res = await GET(
      new NextRequest("http://localhost/api/lodge/week?start=2026-04-13")
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    const apr14 = data.days.find(
      (day: { date: string }) => day.date === "2026-04-14"
    );
    expect(apr14).toEqual({
      date: "2026-04-14",
      accessible: true,
      guestCount: 3,
      arrivingCount: 1,
      departingCount: 1,
      rosterStatus: "confirmed",
    });
    expect(Object.keys(apr14).sort()).toEqual([
      "accessible",
      "arrivingCount",
      "date",
      "departingCount",
      "guestCount",
      "rosterStatus",
    ]);
    expect(JSON.stringify(data)).not.toMatch(
      /Alice|Secret|Bob|Hidden|Cara|Private|memberName|firstName|lastName|phone|booking-1/
    );

    expect(mockPrisma.booking.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.choreAssignment.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          checkIn: { lte: new Date("2026-04-19T00:00:00.000Z") },
          checkOut: { gte: new Date("2026-04-13T00:00:00.000Z") },
          guests: {
            some: {
              stayStart: { lte: new Date("2026-04-19T00:00:00.000Z") },
              stayEnd: { gte: new Date("2026-04-13T00:00:00.000Z") },
            },
          },
        }),
      })
    );
    const bookingQuery = mockPrisma.booking.findMany.mock.calls[0][0];
    expect(bookingQuery.select.member).toBeUndefined();
    expect(bookingQuery.select.guests.select.firstName).toBeUndefined();
    expect(bookingQuery.select.guests.select.lastName).toBeUndefined();
  });

  it("rotates hut leader PINs and returns the new PIN once for admins", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
    });
    mockPrisma.hutLeaderAssignment.findUnique.mockResolvedValue({
      id: "assign-1",
      memberId: "member-1",
      startDate: new Date("2026-07-10T00:00:00.000Z"),
      endDate: new Date("2026-07-12T00:00:00.000Z"),
      member: {
        id: "member-1",
        active: true,
        email: "alice@example.com",
        firstName: "Alice",
      },
    });
    mockPrisma.hutLeaderAssignment.update.mockResolvedValue({ id: "assign-1" });
    mockSendHutLeaderAssignmentEmail.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/admin/hut-leaders/[id]/pin/route");
    const res = await POST(new Request("http://localhost") as any, {
      params: Promise.resolve({ id: "assign-1" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pin).toMatch(/^\d{6}$/);
    expect(data.emailSent).toBe(true);

    const updateCall = mockPrisma.hutLeaderAssignment.update.mock.calls[0][0];
    const emailCall = mockSendHutLeaderAssignmentEmail.mock.calls[0][0];
    expect(updateCall.data.hutLeaderPin).toEqual(expect.any(String));
    expect(updateCall.data.hutLeaderPin).not.toBe(data.pin);
    expect(await bcrypt.compare(data.pin, updateCall.data.hutLeaderPin)).toBe(true);
    expect(emailCall.pin).toBe(data.pin);
  });

  it("rejects unauthenticated lodge read-only access", async () => {
    mockAuth.mockResolvedValue(null);

    const { checkLodgeAuth } = await import("@/lib/lodge-auth");
    const result = await checkLodgeAuth("2026-04-13");

    expect(result.error).toBe("Unauthorised");
    expect(result.tier).toBe("none");
    expect(result.status).toBe(401);
  });

  it("rejects anonymous lodge API access even with a valid PIN cookie", async () => {
    const pinHash = await bcrypt.hash("123456", 12);
    const pinSession = createLodgePinSessionWithVersion(
      "assign-1",
      "member-1",
      pinHash,
      "lodge-1"
    );
    mockAuth.mockResolvedValue(null);

    const { checkLodgeAuth } = await import("@/lib/lodge-auth");
    const result = await checkLodgeAuth("2026-04-13", {
      request: new Request("http://localhost/api/lodge/access", {
        headers: {
          cookie: `${HUT_LEADER_PIN_SESSION_COOKIE}=${pinSession.value}`,
        },
      }),
    });

    expect(result.error).toBe("Unauthorised");
    expect(result.tier).toBe("none");
    expect(result.status).toBe(401);
    expect(mockPrisma.hutLeaderAssignment.findUnique).not.toHaveBeenCalled();
  });

  it("returns hut leader access for a lodge session with a valid PIN cookie", async () => {
    const pinHash = await bcrypt.hash("123456", 12);
    const pinSession = createLodgePinSessionWithVersion(
      "assign-1",
      "member-1",
      pinHash,
      "lodge-1"
    );
    mockAuth.mockResolvedValue({
      user: { id: "lodge-1", role: "LODGE", accessRoles: [{ role: "LODGE" }], email: "lodge@example.org" },
    });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "lodge-1",
      accessRoles: [{ role: "LODGE" }],
    });
    mockPrisma.hutLeaderAssignment.findUnique.mockResolvedValue({
      id: "assign-1",
      memberId: "member-1",
      startDate: new Date("2026-04-13T00:00:00.000Z"),
      endDate: new Date("2026-04-16T00:00:00.000Z"),
      hutLeaderPin: pinHash,
      member: {
        id: "member-1",
        active: true,
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@example.com",
      },
    });

    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/lodge/access/route");
    const res = await GET(
      new NextRequest("http://localhost/api/lodge/access?date=2026-04-13", {
        headers: {
          cookie: `${HUT_LEADER_PIN_SESSION_COOKIE}=${pinSession.value}`,
        },
      })
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      tier: "hut-leader",
      dateRange: {
        minDate: "2026-04-12",
        maxDate: "2026-04-16",
      },
      canManageRoster: true,
      canMarkAttendance: true,
      canCompleteChores: true,
      // Single-lodge club: the kiosk header lodge name stays hidden
      // (ADR-002 presentation rule).
      lodgeName: null,
    });
  });

  it("does not reuse a hut leader PIN cookie from a different lodge account", async () => {
    const pinHash = await bcrypt.hash("123456", 12);
    const pinSession = createLodgePinSessionWithVersion(
      "assign-1",
      "member-1",
      pinHash,
      "lodge-1"
    );
    mockAuth.mockResolvedValue({
      user: { id: "lodge-2", role: "LODGE", accessRoles: [{ role: "LODGE" }], email: "other-lodge@example.org" },
    });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "lodge-2",
      accessRoles: [{ role: "LODGE" }],
    });

    const { checkLodgeAuth } = await import("@/lib/lodge-auth");
    const result = await checkLodgeAuth("2026-04-13", {
      request: new Request("http://localhost/api/lodge/access", {
        headers: {
          cookie: `${HUT_LEADER_PIN_SESSION_COOKIE}=${pinSession.value}`,
        },
      }),
    });

    expect(result.error).toBeNull();
    expect(result.tier).toBe("lodge");
    expect(mockPrisma.hutLeaderAssignment.findUnique).not.toHaveBeenCalled();
  });

  it("creates a signed hut leader PIN session cookie on successful PIN login", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "lodge-1", role: "LODGE", accessRoles: [{ role: "LODGE" }], email: "lodge@example.org" },
    });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "lodge-1",
      accessRoles: [{ role: "LODGE" }],
    });
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([
      {
        id: "assign-1",
        memberId: "member-1",
        startDate: new Date("2026-04-13T00:00:00.000Z"),
        endDate: new Date("2026-04-16T00:00:00.000Z"),
        hutLeaderPin: await bcrypt.hash("123456", 12),
        member: {
          id: "member-1",
          active: true,
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@example.com",
        },
      },
    ]);

    const { POST } = await import("@/app/api/lodge/pin-login/route");
    const res = await POST(
      new Request("http://localhost/api/lodge/pin-login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "10.0.0.1",
        },
        body: JSON.stringify({ pin: "123456" }),
      }) as any
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(
      "tac_hut_leader_pin_session="
    );

    const data = await res.json();
    expect(data.tier).toBe("hut-leader");
    expect(data.memberName).toBe("Alice Smith");
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "lodge.pin.login.succeeded",
        memberId: "member-1",
        targetId: "member-1",
        subjectMemberId: "member-1",
        category: "lodge",
        outcome: "success",
        retentionClass: "sensitive_access",
        ipAddress: "10.0.0.1",
      }),
    });
  });

  it("rejects anonymous PIN login attempts", async () => {
    mockAuth.mockResolvedValue(null);

    const { POST } = await import("@/app/api/lodge/pin-login/route");
    const res = await POST(
      new Request("http://localhost/api/lodge/pin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "123456" }),
      }) as any
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorised" });
    expect(mockPrisma.hutLeaderAssignment.findMany).not.toHaveBeenCalled();
  });

  it("rejects member sessions from PIN login", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "member-1", role: "USER", accessRoles: [{ role: "USER" }], email: "member@example.com" },
    });

    const { POST } = await import("@/app/api/lodge/pin-login/route");
    const res = await POST(
      new Request("http://localhost/api/lodge/pin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "123456" }),
      }) as any
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mockPrisma.hutLeaderAssignment.findMany).not.toHaveBeenCalled();
  });

  it("writes member-linked audit rows when marking lodge guests arrived and departed", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "support@example.org" },
    });
    mockPrisma.bookingGuest.findFirst
      .mockResolvedValueOnce({
        id: "guest-1",
        bookingId: "booking-1",
        firstName: "Alice",
        lastName: "Guest",
        memberId: "guest-member-1",
        arrivedAt: null,
        departedAt: null,
        booking: {
          memberId: "booking-owner-1",
        },
      })
      .mockResolvedValueOnce({
        id: "guest-2",
        bookingId: "booking-2",
        firstName: "Bob",
        lastName: "Guest",
        memberId: null,
        arrivedAt: new Date("2026-04-13T08:00:00.000Z"),
        departedAt: null,
        booking: {
          memberId: "booking-owner-2",
        },
      });
    mockPrisma.bookingGuest.update.mockResolvedValue({});

    const { PUT: arrive } = await import("@/app/api/lodge/guests/[date]/arrive/route");
    const arriveRes = await arrive(
      new Request("http://localhost/api/lodge/guests/2026-04-13/arrive", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "10.0.0.4",
        },
        body: JSON.stringify({ bookingGuestId: "guest-1" }),
      }) as any,
      { params: Promise.resolve({ date: "2026-04-13" }) }
    );

    expect(arriveRes.status).toBe(200);
    expect(mockPrisma.bookingGuest.update).toHaveBeenCalledWith({
      where: { id: "guest-1" },
      data: { arrivedAt: expect.any(Date) },
    });

    const { PUT: depart } = await import("@/app/api/lodge/guests/[date]/depart/route");
    const departRes = await depart(
      new Request("http://localhost/api/lodge/guests/2026-04-13/depart", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "10.0.0.5",
        },
        body: JSON.stringify({ bookingGuestId: "guest-2" }),
      }) as any,
      { params: Promise.resolve({ date: "2026-04-13" }) }
    );

    expect(departRes.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "lodge.guest.arrived",
          memberId: "admin-1",
          subjectMemberId: "guest-member-1",
          entityType: "BookingGuest",
          entityId: "guest-1",
          category: "lodge",
          ipAddress: "10.0.0.4",
        }),
      });
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "lodge.guest.departed",
          memberId: "admin-1",
          subjectMemberId: "booking-owner-2",
          entityType: "BookingGuest",
          entityId: "guest-2",
          category: "lodge",
          ipAddress: "10.0.0.5",
        }),
      });
    });
  });

  it("attributes lodge-session PIN actions to the hut leader member", async () => {
    const pinHash = await bcrypt.hash("123456", 12);
    const pinSession = createLodgePinSessionWithVersion(
      "assign-1",
      "hut-leader-1",
      pinHash,
      "lodge-1"
    );

    mockAuth.mockResolvedValue({
      user: { id: "lodge-1", role: "LODGE", accessRoles: [{ role: "LODGE" }], email: "lodge@example.org" },
    });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "lodge-1",
      accessRoles: [{ role: "LODGE" }],
    });
    mockPrisma.hutLeaderAssignment.findUnique.mockResolvedValue({
      id: "assign-1",
      memberId: "hut-leader-1",
      startDate: new Date("2026-04-13T00:00:00.000Z"),
      endDate: new Date("2026-04-16T00:00:00.000Z"),
      hutLeaderPin: pinHash,
      member: {
        id: "hut-leader-1",
        active: true,
        firstName: "Alice",
        lastName: "Leader",
        email: "alice@example.com",
      },
    });
    mockPrisma.bookingGuest.findFirst.mockResolvedValue({
      id: "guest-1",
      bookingId: "booking-1",
      firstName: "Guest",
      lastName: "One",
      memberId: null,
      arrivedAt: null,
      departedAt: null,
      booking: {
        memberId: "booking-owner-1",
      },
    });
    mockPrisma.bookingGuest.update.mockResolvedValue({});

    const { PUT } = await import("@/app/api/lodge/guests/[date]/arrive/route");
    const res = await PUT(
      new Request("http://localhost/api/lodge/guests/2026-04-13/arrive", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          cookie: `${HUT_LEADER_PIN_SESSION_COOKIE}=${pinSession.value}`,
        },
        body: JSON.stringify({ bookingGuestId: "guest-1" }),
      }) as any,
      { params: Promise.resolve({ date: "2026-04-13" }) }
    );

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "lodge.guest.arrived",
          memberId: "hut-leader-1",
          category: "lodge",
          metadata: expect.objectContaining({
            tier: "hut-leader",
          }),
        }),
      });
    });
  });

  it("rate limits PIN login once the degraded per-process budget is spent", async () => {
    // Tests run with an unreachable DATABASE_URL, so the shared limiter store
    // is down and the limiter runs in degraded mode. lodgePinLogin is
    // authSensitive (issue #1142): its degraded budget is
    // floor(5 / DEGRADED_AUTH_LIMIT_DIVISOR) = 1 attempt, after which the
    // route returns 429. (Healthy-store behavior stays 5/minute — covered by
    // rate-limit.test.ts.)
    mockAuth.mockResolvedValue({
      user: { id: "lodge-1", role: "LODGE", accessRoles: [{ role: "LODGE" }], email: "lodge@example.org" },
    });
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
    const { POST } = await import("@/app/api/lodge/pin-login/route");

    const res = await POST(
      new Request("http://localhost/api/lodge/pin-login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "10.0.0.2",
        },
        body: JSON.stringify({ pin: "111111" }),
      }) as any
    );

    expect(res.status).toBe(401);

    const limited = await POST(
      new Request("http://localhost/api/lodge/pin-login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "10.0.0.2",
        },
        body: JSON.stringify({ pin: "111111" }),
      }) as any
    );

    expect(limited.status).toBe(429);
  });

  it("locks an IP after 10 consecutive failed PIN attempts", () => {
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const result = recordLodgePinFailure("10.0.0.3");
      expect(result.locked).toBe(false);
    }

    const locked = recordLodgePinFailure("10.0.0.3");
    expect(locked.locked).toBe(true);
    expect(getLodgePinLockout("10.0.0.3").locked).toBe(true);

    clearLodgePinFailures("10.0.0.3");
    expect(getLodgePinLockout("10.0.0.3").locked).toBe(false);
  });

  it("accepts a versioned hut leader cookie when the assignment PIN has not changed", async () => {
    const currentPinHash = await bcrypt.hash("123456", 12);
    const issuedSession = createLodgePinSessionWithVersion(
      "assign-1",
      "member-1",
      currentPinHash
    );

    mockPrisma.hutLeaderAssignment.findUnique.mockResolvedValue({
      id: "assign-1",
      memberId: "member-1",
      startDate: new Date("2026-04-13T00:00:00.000Z"),
      endDate: new Date("2026-04-16T00:00:00.000Z"),
      hutLeaderPin: currentPinHash,
      member: {
        id: "member-1",
        active: true,
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@example.com",
      },
    });

    const session = await getActiveLodgePinSessionForDate(
      new Date("2026-04-14T00:00:00.000Z"),
      issuedSession.value
    );

    expect(session).toMatchObject({
      assignmentId: "assign-1",
      memberId: "member-1",
    });
  });

  it("invalidates an existing hut leader cookie after the underlying PIN is rotated", async () => {
    const originalPinHash = await bcrypt.hash("123456", 12);
    const rotatedPinHash = await bcrypt.hash("654321", 12);
    const issuedSession = createLodgePinSessionWithVersion(
      "assign-1",
      "member-1",
      originalPinHash
    );

    mockPrisma.hutLeaderAssignment.findUnique.mockResolvedValue({
      id: "assign-1",
      memberId: "member-1",
      startDate: new Date("2026-04-13T00:00:00.000Z"),
      endDate: new Date("2026-04-16T00:00:00.000Z"),
      hutLeaderPin: rotatedPinHash,
      member: {
        id: "member-1",
        active: true,
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@example.com",
      },
    });

    const session = await getActiveLodgePinSessionForDate(
      new Date("2026-04-14T00:00:00.000Z"),
      issuedSession.value
    );

    expect(session).toBeNull();
  });

  it("invalidates an existing hut leader cookie after PIN access is revoked", async () => {
    const currentPinHash = await bcrypt.hash("123456", 12);
    const issuedSession = createLodgePinSessionWithVersion(
      "assign-1",
      "member-1",
      currentPinHash
    );

    mockPrisma.hutLeaderAssignment.findUnique.mockResolvedValue({
      id: "assign-1",
      memberId: "member-1",
      startDate: new Date("2026-04-13T00:00:00.000Z"),
      endDate: new Date("2026-04-16T00:00:00.000Z"),
      hutLeaderPin: null,
      member: {
        id: "member-1",
        active: true,
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@example.com",
      },
    });

    const session = await getActiveLodgePinSessionForDate(
      new Date("2026-04-14T00:00:00.000Z"),
      issuedSession.value
    );

    expect(session).toBeNull();
  });

  it("shows hut leader PIN access on the lodge tier instead of the staying-guest tier", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const kioskPath = path.resolve(
      process.cwd(),
      "src",
      "app",
      "(lodge)",
      "lodge",
      "kiosk",
      "page.tsx"
    );
    const content = fs.readFileSync(kioskPath, "utf-8");

    expect(content).toContain('{effectiveTier === "lodge" && (');
    expect(content).not.toContain(
      '{(effectiveTier === "none" || effectiveTier === "staying-guest") && ('
    );
    expect(content).toContain("controls on this kiosk");
  });

  it("renders the updated lodge kiosk list controls and refresh behavior", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const kioskPath = path.resolve(
      process.cwd(),
      "src",
      "app",
      "(lodge)",
      "lodge",
      "kiosk",
      "page.tsx"
    );
    const content = fs.readFileSync(kioskPath, "utf-8");

    expect(content).toContain("scope=lodge-list");
    expect(content).toContain("Guests Arriving Today");
    expect(content).toContain("Guests Staying");
    expect(content).toContain("Guests Departing Today");
    expect(content).toContain("guest.ageTier === \"ADULT\"");
    expect(content).toContain("canMarkAttendance && guest.isArriving");
    expect(content).toContain("canMarkAttendance && guest.isDeparting");
    expect(content).toContain("120000");
    expect(content).toContain("Manage Today's Roster");
    expect(content).not.toContain("Manage Today&apos;s Roster");
  });

  it("#1422: flags a blocked booking and disables its attendance toggles", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const kioskPath = path.resolve(
      process.cwd(),
      "src",
      "app",
      "(lodge)",
      "lodge",
      "kiosk",
      "page.tsx"
    );
    const content = fs.readFileSync(kioskPath, "utf-8");

    // A booking held by a pending admin review is shown with a clear message...
    expect(content).toContain("Blocked from Check-In — see Booking Officer");
    // ...and its arrive/depart toggles are suppressed for blocked bookings.
    expect(content).toContain(
      "canMarkAttendance && guest.isArriving && !guest.departedAt && !booking.blockedFromCheckin"
    );
    expect(content).toContain(
      "canMarkAttendance && guest.isDeparting && !booking.blockedFromCheckin"
    );
  });
});
