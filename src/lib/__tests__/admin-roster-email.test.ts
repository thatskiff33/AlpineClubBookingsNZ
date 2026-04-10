import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockAuth = vi.fn();
const mockChoreAssignmentFindMany = vi.fn();
const mockGuestTokenDeleteMany = vi.fn();
const mockSendChoreRosterEmail = vi.fn();
const mockCreateGuestChoreToken = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    choreAssignment: {
      findMany: mockChoreAssignmentFindMany,
    },
    guestChoreToken: {
      deleteMany: mockGuestTokenDeleteMany,
    },
  },
}));

vi.mock("@/lib/email", () => ({
  sendChoreRosterEmail: mockSendChoreRosterEmail,
}));

vi.mock("@/lib/guest-chore-token", () => ({
  createGuestChoreToken: mockCreateGuestChoreToken,
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("PUT /api/admin/roster/[date] email action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } });
    mockCreateGuestChoreToken.mockResolvedValue("token-1");
  });

  it("returns partial-failure details instead of failing the whole request", async () => {
    mockChoreAssignmentFindMany.mockResolvedValue([
      {
        choreTemplate: { name: "Kitchen", description: null },
        bookingGuest: {
          id: "guest-1",
          firstName: "Alice",
          lastName: "Smith",
          member: {
            email: "alice@test.com",
            inheritEmailFromId: null,
            inheritEmailFrom: null,
          },
        },
      },
      {
        choreTemplate: { name: "Bathrooms", description: null },
        bookingGuest: {
          id: "guest-2",
          firstName: "Bob",
          lastName: "Jones",
          member: {
            email: "bob@test.com",
            inheritEmailFromId: null,
            inheritEmailFrom: null,
          },
        },
      },
    ]);

    mockSendChoreRosterEmail
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("SMTP down"));

    const { PUT } = await import("@/app/api/admin/roster/[date]/route");
    const req = new NextRequest("http://localhost/api/admin/roster/2026-04-10", {
      method: "PUT",
      body: JSON.stringify({ action: "email" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await PUT(req, { params: Promise.resolve({ date: "2026-04-10" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.partialFailure).toBe(true);
    expect(body.sent).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.failures).toHaveLength(1);
    expect(mockGuestTokenDeleteMany).toHaveBeenCalledTimes(2);
  });
});
