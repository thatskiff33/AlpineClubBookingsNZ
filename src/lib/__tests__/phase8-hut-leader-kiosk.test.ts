import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _testStore } from "../rate-limit";
import {
  _testLodgePinFailureStore,
  clearLodgePinFailures,
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
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    member: {
      count: vi.fn(),
      findUnique: vi.fn(),
    },
    booking: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    choreAssignment: {
      findMany: vi.fn(),
    },
  },
  mockAuth: vi.fn(),
  mockSendHutLeaderAssignmentEmail: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
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
    mockSendHutLeaderAssignmentEmail.mockResolvedValue(undefined);
  });

  it("creates hut leader assignments with a bcrypt-hashed PIN and emails the plaintext PIN", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", email: "support@tokoroa.org.nz" },
    });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "member-1",
      active: true,
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
  });

  it("formats member guest phone numbers for the kiosk guest list API", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", email: "support@tokoroa.org.nz" },
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

  it("allows read-only public lodge access when requested", async () => {
    mockAuth.mockResolvedValue(null);

    const { checkLodgeAuth } = await import("@/lib/lodge-auth");
    const result = await checkLodgeAuth("2026-04-13", {
      allowPublicReadOnly: true,
    });

    expect(result.error).toBeNull();
    expect(result.tier).toBe("none");
  });

  it("creates a signed hut leader PIN session cookie on successful PIN login", async () => {
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
  });

  it("rate limits PIN login after 5 failed attempts per minute", async () => {
    mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
    const { POST } = await import("@/app/api/lodge/pin-login/route");

    for (let attempt = 0; attempt < 5; attempt += 1) {
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
    }

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
    expect(content).toContain("unlock hut leader controls on");
  });
});
