import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      count: vi.fn(),
      findUnique: vi.fn(),
    },
    notificationPreference: {
      upsert: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn().mockImplementation((operation: unknown) => {
      if (Array.isArray(operation)) {
        return Promise.all(operation);
      }

      return (operation as (tx: unknown) => Promise<unknown>)({});
    }),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) => mockRequireActiveSessionUser(...args),
}));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditRequestContext: vi.fn(() => ({ ipAddress: "127.0.0.1" })),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
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
  adminFamilyGroupRequest: true,
  adminRefundRequest: true,
  adminIssueReport: true,
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
        adminIssueReport: true,
      }),
    });

    const body = await res.json();
    expect(body.preferences.adminNewBooking).toBe(false);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ADMIN_NOTIFICATION_PREFERENCES_UPDATED",
          actor: { memberId: "admin-1" },
          subject: { memberId: "admin-2" },
          category: "admin",
          metadata: {
            changedPreferenceKeys: ["adminNewBooking"],
            changes: [
              {
                key: "adminNewBooking",
                before: true,
                after: false,
              },
            ],
          },
        }),
      })
    );
  });
});
