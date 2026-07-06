/**
 * Phase 10b tests: F-COMP-03 (Personal Data Export) and F-COMP-04 (Account Deletion)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { checkRateLimitInMemory as checkRateLimit, _testStore, rateLimiters } from "@/lib/rate-limit";
import {
  accountDeletionApprovedTemplate,
  accountDeletionRejectedTemplate,
} from "@/lib/email-templates";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      count: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    booking: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    bookingGuest: {
      updateMany: vi.fn(),
    },
    choreAssignment: {
      findMany: vi.fn(),
    },
    memberSubscription: {
      findMany: vi.fn(),
    },
    auditLog: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    deletionRequest: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    payment: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    promoRedemption: {
      findUnique: vi.fn(),
    },
    familyGroupMember: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendAccountDeletionApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendAccountDeletionRejectedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminAccountDeletionRequestedAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/booking-cancel", () => ({
  cancelBooking: vi.fn().mockResolvedValue({ status: 200, data: { success: true, refundAmountCents: 0, refundPercentage: 0, message: "Cancelled" } }),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { GET as dataExportGet } from "@/app/api/member/data-export/route";
import { POST as requestDeletionPost } from "@/app/api/member/request-deletion/route";
import { GET as adminDeletionRequestsGet } from "@/app/api/admin/deletion-requests/route";
import { POST as adminDeletionActionPost } from "@/app/api/admin/deletion-requests/[id]/route";

const mockedAuth = vi.mocked(auth);
const mockedPrisma = vi.mocked(prisma, true);

// ─── F-COMP-03: Personal Data Export ─────────────────────────────────────────

describe("F-COMP-03: Personal Data Export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _testStore.clear();
    mockedPrisma.member.count.mockResolvedValue(1);
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const res = await dataExportGet();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns export JSON with correct Content-Disposition header", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
    } as any);

    mockedPrisma.member.findUnique.mockResolvedValue({
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@test.com",
      phoneCountryCode: null, phoneAreaCode: "021", phoneNumber: "000 0000",
      dateOfBirth: new Date("1990-06-15"),
      role: "MEMBER",
      ageTier: "ADULT",
      active: true,
      joinedDate: new Date("2022-04-01"),
      createdAt: new Date("2022-04-01"),
    } as any);

    mockedPrisma.booking.findMany.mockResolvedValue([]);
    mockedPrisma.choreAssignment.findMany.mockResolvedValue([]);
    mockedPrisma.memberSubscription.findMany.mockResolvedValue([]);
    mockedPrisma.auditLog.findMany.mockResolvedValue([]);

    const res = await dataExportGet();
    expect(res.status).toBe(200);

    const disposition = res.headers.get("Content-Disposition");
    expect(disposition).toMatch(/attachment/);
    expect(disposition).toMatch(/tac-my-data-\d{4}-\d{2}-\d{2}\.json/);

    const body = await res.json();
    expect(body.profile.firstName).toBe("Alice");
    expect(body.profile.email).toBe("alice@test.com");
    expect((body.profile as any).passwordHash).toBeUndefined();
    expect(Array.isArray(body.bookings)).toBe(true);
    expect(Array.isArray(body.subscriptions)).toBe(true);
    expect(Array.isArray(body.auditLog)).toBe(true);
  });

  it("excludes passwordHash from export", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
    } as any);

    mockedPrisma.member.findUnique.mockResolvedValue({
      firstName: "Bob",
      lastName: "Jones",
      email: "bob@test.com",
      phoneCountryCode: null, phoneAreaCode: null, phoneNumber: null,
      dateOfBirth: null,
      role: "MEMBER",
      ageTier: "ADULT",
      active: true,
      joinedDate: null,
      createdAt: new Date(),
    } as any);

    mockedPrisma.booking.findMany.mockResolvedValue([]);
    mockedPrisma.choreAssignment.findMany.mockResolvedValue([]);
    mockedPrisma.memberSubscription.findMany.mockResolvedValue([]);
    mockedPrisma.auditLog.findMany.mockResolvedValue([]);

    const res = await dataExportGet();
    const body = await res.json();
    const profileStr = JSON.stringify(body.profile);
    expect(profileStr).not.toContain("passwordHash");
    expect(profileStr).not.toContain("password");
  });

  it("rate limits to 5 exports per day per member", () => {
    const config = rateLimiters.dataExport;
    expect(config.limit).toBe(5);
    expect(config.windowSeconds).toBe(24 * 60 * 60);

    for (let i = 0; i < 5; i++) {
      const result = checkRateLimit(config, "member-abc");
      expect(result.success).toBe(true);
    }
    const blocked = checkRateLimit(config, "member-abc");
    expect(blocked.success).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("rate limits are per-member (different members independent)", () => {
    const config = rateLimiters.dataExport;
    for (let i = 0; i < 5; i++) {
      checkRateLimit(config, "member-1");
    }
    const other = checkRateLimit(config, "member-2");
    expect(other.success).toBe(true);
  });
});

// ─── F-COMP-04: Account Deletion Request ─────────────────────────────────────

describe("F-COMP-04: Account Deletion - request endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _testStore.clear();
    mockedPrisma.member.count.mockResolvedValue(1);
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const req = new NextRequest("http://localhost/api/member/request-deletion", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const res = await requestDeletionPost(req);
    expect(res.status).toBe(401);
  });

  it("returns 403 for admin accounts", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "a1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    } as any);
    const req = new NextRequest("http://localhost/api/member/request-deletion", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const res = await requestDeletionPost(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Admin");
  });

  it("creates a deletion request for a member", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
    } as any);
    mockedPrisma.deletionRequest.findFirst.mockResolvedValue(null);
    mockedPrisma.deletionRequest.create.mockResolvedValue({
      id: "dr1",
      memberId: "m1",
      status: "PENDING",
      reason: "Moving overseas",
      member: {
        firstName: "Jane",
        lastName: "Member",
        email: "jane@example.org",
      },
    } as any);

    const req = new NextRequest("http://localhost/api/member/request-deletion", {
      method: "POST",
      body: JSON.stringify({ reason: "Moving overseas" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await requestDeletionPost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestId).toBe("dr1");
    expect(mockedPrisma.deletionRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          memberId: "m1",
          reason: "Moving overseas",
          status: "PENDING",
        }),
      }),
    );
    const { sendAdminAccountDeletionRequestedAlert } = await import("@/lib/email");
    expect(sendAdminAccountDeletionRequestedAlert).toHaveBeenCalledWith({
      requestId: "dr1",
      memberName: "Jane Member",
      memberEmail: "jane@example.org",
      reason: "Moving overseas",
    });
  });

  it("returns 409 if a pending request already exists", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
    } as any);
    mockedPrisma.deletionRequest.findFirst.mockResolvedValue({
      id: "dr-existing",
      status: "PENDING",
    } as any);

    const req = new NextRequest("http://localhost/api/member/request-deletion", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const res = await requestDeletionPost(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("pending");
  });
});

// ─── F-COMP-04: Admin Deletion Requests API ──────────────────────────────────

describe("F-COMP-04: Admin - list deletion requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.member.count.mockResolvedValue(1);
    mockedPrisma.member.findUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "ADMIN" }],
    } as any);
  });

  it("returns 401 for unauthenticated", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const req = new NextRequest("http://localhost/api/admin/deletion-requests");
    const res = await adminDeletionRequestsGet(req);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    mockedPrisma.member.findUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "USER" }],
    } as any);
    const req = new NextRequest("http://localhost/api/admin/deletion-requests");
    const res = await adminDeletionRequestsGet(req);
    expect(res.status).toBe(403);
  });

  it("returns deletion requests list for admin", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);
    mockedPrisma.deletionRequest.findMany.mockResolvedValue([
      {
        id: "dr1",
        status: "PENDING",
        reason: "Moving away",
        adminNote: null,
        reviewedBy: null,
        reviewedAt: null,
        createdAt: new Date("2026-04-07"),
        member: {
          id: "m1",
          firstName: "Jane",
          lastName: "Doe",
          email: "jane@test.com",
          role: "MEMBER",
          active: true,
        },
      },
    ] as any);
    mockedPrisma.deletionRequest.count.mockResolvedValue(1);

    const req = new NextRequest("http://localhost/api/admin/deletion-requests");
    const res = await adminDeletionRequestsGet(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].member.email).toBe("jane@test.com");
    expect(body.total).toBe(1);
  });
});

describe("F-COMP-04: Admin - approve/reject deletion request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.member.count.mockResolvedValue(1);
    mockedPrisma.member.findUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "ADMIN" }],
    } as any);
  });

  const makeRequest = (body: object) =>
    new NextRequest("http://localhost/api/admin/deletion-requests/dr1", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

  const params = Promise.resolve({ id: "dr1" });

  it("returns 401 for unauthenticated", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const res = await adminDeletionActionPost(makeRequest({ action: "reject" }), { params });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
    mockedPrisma.member.findUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "USER" }],
    } as any);
    const res = await adminDeletionActionPost(makeRequest({ action: "reject" }), { params });
    expect(res.status).toBe(403);
  });

  it("returns 404 for unknown request", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);
    mockedPrisma.deletionRequest.findUnique.mockResolvedValue(null);
    const res = await adminDeletionActionPost(makeRequest({ action: "reject" }), { params });
    expect(res.status).toBe(404);
  });

  it("returns 409 for already-reviewed request", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);
    mockedPrisma.deletionRequest.findUnique.mockResolvedValue({
      id: "dr1",
      status: "APPROVED",
      member: {
        id: "m1",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@test.com",
        role: "MEMBER",
        active: false,
      },
    } as any);
    const res = await adminDeletionActionPost(makeRequest({ action: "approve" }), { params });
    expect(res.status).toBe(409);
  });

  it("rejects a deletion request and notifies member", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);
    mockedPrisma.deletionRequest.findUnique.mockResolvedValue({
      id: "dr1",
      status: "PENDING",
      member: {
        id: "m1",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@test.com",
        role: "MEMBER",
        active: true,
      },
    } as any);
    mockedPrisma.deletionRequest.update.mockResolvedValue({} as any);

    const { sendAccountDeletionRejectedEmail } = await import("@/lib/email");
    const res = await adminDeletionActionPost(
      makeRequest({ action: "reject", note: "Outstanding booking" }),
      { params }
    );
    expect(res.status).toBe(200);
    expect(mockedPrisma.deletionRequest.update).toHaveBeenCalledWith({
      where: { id: "dr1" },
      data: expect.objectContaining({ status: "REJECTED", adminNote: "Outstanding booking" }),
    });
    expect(sendAccountDeletionRejectedEmail).toHaveBeenCalledWith(
      "jane@test.com",
      "Jane",
      "Outstanding booking"
    );
  });

  it("approves a deletion request, anonymises member, and cancels future bookings", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);
    mockedPrisma.deletionRequest.findUnique.mockResolvedValue({
      id: "dr1",
      status: "PENDING",
      member: {
        id: "m1",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@test.com",
        role: "MEMBER",
        active: true,
      },
    } as any);

    mockedPrisma.booking.findMany
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([{ id: "bk1" }] as any);

    mockedPrisma.member.update.mockResolvedValue({} as any);
    mockedPrisma.bookingGuest.updateMany.mockResolvedValue({ count: 0 } as any);
    mockedPrisma.familyGroupMember.deleteMany.mockResolvedValue({ count: 0 } as any);
    mockedPrisma.deletionRequest.update.mockResolvedValue({} as any);
    // $transaction executes the callback with the same mock prisma as tx
    mockedPrisma.$transaction.mockImplementation((cb: any) => cb(mockedPrisma));

    const { cancelBooking } = await import("@/lib/booking-cancel");
    const { sendAccountDeletionApprovedEmail } = await import("@/lib/email");

    const res = await adminDeletionActionPost(
      makeRequest({ action: "approve" }),
      { params }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cancelledBookings).toBe(1);

    // Verify anonymisation
    expect(mockedPrisma.member.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: expect.objectContaining({
        firstName: "Deleted",
        lastName: "Member",
        active: false,
        passwordHash: "DELETED_ACCOUNT",
      }),
    });

    // Confirm the anonymous email ends with @deleted.invalid
    const updateCall = vi.mocked(mockedPrisma.member.update).mock.calls[0][0];
    expect((updateCall.data as any).email).toMatch(/@deleted\.invalid$/);

    // Booking was cancelled
    expect(cancelBooking).toHaveBeenCalledWith("bk1", "a1", "ADMIN", expect.any(String));
    expect(mockedPrisma.booking.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          status: "PAID",
        }),
      })
    );
    expect(mockedPrisma.booking.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["PENDING", "PAYMENT_PENDING", "CONFIRMED"] },
        }),
      })
    );

    // Approval email sent
    expect(sendAccountDeletionApprovedEmail).toHaveBeenCalledWith("jane@test.com", "Jane");

    // Request marked APPROVED
    expect(mockedPrisma.deletionRequest.update).toHaveBeenCalledWith({
      where: { id: "dr1" },
      data: expect.objectContaining({ status: "APPROVED" }),
    });
  });

  it("blocks approval while future PAID bookings remain active", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);
    mockedPrisma.deletionRequest.findUnique.mockResolvedValue({
      id: "dr1",
      status: "PENDING",
      member: {
        id: "m1",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@test.com",
        role: "MEMBER",
        active: true,
      },
    } as any);
    mockedPrisma.booking.findMany.mockResolvedValueOnce([{ id: "paid-bk1" }] as any);

    const { cancelBooking } = await import("@/lib/booking-cancel");
    const { sendAccountDeletionApprovedEmail } = await import("@/lib/email");

    const res = await adminDeletionActionPost(
      makeRequest({ action: "approve" }),
      { params }
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("future paid bookings");
    expect(body.paidBookingIds).toEqual(["paid-bk1"]);
    expect(cancelBooking).not.toHaveBeenCalled();
    expect(sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
    expect(mockedPrisma.member.update).not.toHaveBeenCalled();
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("does not anonymise the member if future booking cancellation fails", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);
    mockedPrisma.deletionRequest.findUnique.mockResolvedValue({
      id: "dr1",
      status: "PENDING",
      member: {
        id: "m1",
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@test.com",
        role: "MEMBER",
        active: true,
      },
    } as any);
    mockedPrisma.booking.findMany
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([{ id: "bk1" }] as any);

    const { cancelBooking } = await import("@/lib/booking-cancel");
    vi.mocked(cancelBooking).mockResolvedValueOnce({
      status: 400,
      error: "Only active bookings can be cancelled",
    });
    const { sendAccountDeletionApprovedEmail } = await import("@/lib/email");

    const res = await adminDeletionActionPost(
      makeRequest({ action: "approve" }),
      { params }
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("future bookings could not be cancelled");
    expect(body.failedBookingIds).toEqual(["bk1"]);
    expect(sendAccountDeletionApprovedEmail).not.toHaveBeenCalled();
    expect(mockedPrisma.member.update).not.toHaveBeenCalled();
    expect(mockedPrisma.deletionRequest.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "APPROVED" }),
      })
    );
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });
});

// ─── Email templates ──────────────────────────────────────────────────────────

describe("F-COMP-04: Email templates", () => {
  it("deletion approved template includes member name", () => {
    const html = accountDeletionApprovedTemplate("Alice");
    expect(html).toContain("Alice");
    expect(html.toLowerCase()).toContain("deletion");
    expect(html.toLowerCase()).toContain("anonymised");
  });

  it("deletion rejected template includes member name and note", () => {
    const html = accountDeletionRejectedTemplate("Bob", "Outstanding balance");
    expect(html).toContain("Bob");
    expect(html).toContain("Outstanding balance");
  });

  it("deletion rejected template handles empty note gracefully", () => {
    const html = accountDeletionRejectedTemplate("Carol", "");
    expect(html).toContain("Carol");
    expect(html).not.toContain("Admin note:");
  });
});

// ─── Rate limiters registered ─────────────────────────────────────────────────

describe("Rate limiter config", () => {
  it("dataExport limiter is 5/day", () => {
    expect(rateLimiters.dataExport.limit).toBe(5);
    expect(rateLimiters.dataExport.windowSeconds).toBe(24 * 60 * 60);
  });

  it("deletionRequest limiter is 3/day", () => {
    expect(rateLimiters.deletionRequest.limit).toBe(3);
    expect(rateLimiters.deletionRequest.windowSeconds).toBe(24 * 60 * 60);
  });
});
