import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: vi.fn(),
    },
    notificationPreference: {
      upsert: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { PUT } from "@/app/api/admin/notifications/route";

const mockedAuth = vi.mocked(auth);

const adminSession = { user: { id: "admin-1", role: "ADMIN" } } as any;
const memberSession = { user: { id: "member-1", role: "MEMBER" } } as any;

const fullAdminPreferences = {
  adminNewBooking: true,
  adminPaymentFailure: true,
  adminPendingDeadline: true,
  adminBookingBumped: true,
  adminXeroSyncError: true,
  adminCapacityWarning: true,
  adminDailyDigest: true,
  adminWaitlistOffer: true,
};

describe("Admin notifications API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 for non-admin users", async () => {
    mockedAuth.mockResolvedValue(memberSession);

    const req = new NextRequest("http://localhost/api/admin/notifications", {
      method: "PUT",
      body: JSON.stringify({
        memberId: "admin-2",
        preferences: { adminNewBooking: false },
      }),
    });

    const res = await PUT(req);
    expect(res.status).toBe(403);
  });

  it("returns 400 when the target user is not an admin", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "member-2",
      firstName: "Not",
      lastName: "Admin",
      email: "member@example.com",
      role: "MEMBER",
      notificationPreference: null,
    } as any);

    const req = new NextRequest("http://localhost/api/admin/notifications", {
      method: "PUT",
      body: JSON.stringify({
        memberId: "member-2",
        preferences: { adminNewBooking: false },
      }),
    });

    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("updates admin notification preferences", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "admin-2",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      role: "ADMIN",
      notificationPreference: null,
    } as any);
    vi.mocked(prisma.notificationPreference.upsert).mockResolvedValue({
      ...fullAdminPreferences,
      adminNewBooking: false,
    } as any);

    const req = new NextRequest("http://localhost/api/admin/notifications", {
      method: "PUT",
      body: JSON.stringify({
        memberId: "admin-2",
        preferences: { adminNewBooking: false },
      }),
    });

    const res = await PUT(req);
    expect(res.status).toBe(200);

    expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith({
      where: { memberId: "admin-2" },
      create: {
        memberId: "admin-2",
        adminNewBooking: false,
      },
      update: {
        adminNewBooking: false,
      },
      select: expect.objectContaining({
        adminNewBooking: true,
        adminPaymentFailure: true,
        adminDailyDigest: true,
      }),
    });

    const body = await res.json();
    expect(body.preferences.adminNewBooking).toBe(false);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADMIN_NOTIFICATION_PREFERENCES_UPDATED",
        memberId: "admin-1",
        targetId: "admin-2",
      })
    );
  });
});
