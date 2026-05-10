import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  refundRequestFindMany: vi.fn(),
  refundRequestCount: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingCount: vi.fn(),
  memberApplicationFindMany: vi.fn(),
  memberApplicationCount: vi.fn(),
  memberFindMany: vi.fn(),
  deletionRequestFindMany: vi.fn(),
  deletionRequestCount: vi.fn(),
  auditLogFindMany: vi.fn(),
  auditLogCount: vi.fn(),
  parseApplicationAddress: vi.fn(),
  parseApplicationFamilyMembers: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    refundRequest: {
      findMany: mocks.refundRequestFindMany,
      count: mocks.refundRequestCount,
    },
    booking: {
      findMany: mocks.bookingFindMany,
      count: mocks.bookingCount,
    },
    memberApplication: {
      findMany: mocks.memberApplicationFindMany,
      count: mocks.memberApplicationCount,
    },
    member: {
      findMany: mocks.memberFindMany,
    },
    deletionRequest: {
      findMany: mocks.deletionRequestFindMany,
      count: mocks.deletionRequestCount,
    },
    auditLog: {
      findMany: mocks.auditLogFindMany,
      count: mocks.auditLogCount,
    },
  },
}));

vi.mock("@/lib/nomination", () => ({
  parseApplicationAddress: mocks.parseApplicationAddress,
  parseApplicationFamilyMembers: mocks.parseApplicationFamilyMembers,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn() },
}));

import { GET as getRefundRequests } from "@/app/api/admin/refund-requests/route";
import { GET as getWaitlist } from "@/app/api/admin/waitlist/route";
import { GET as getMemberApplications } from "@/app/api/admin/member-applications/route";
import { GET as getDeletionRequests } from "@/app/api/admin/deletion-requests/route";
import { GET as getCommunicationHistory } from "@/app/api/admin/communications/history/route";

function request(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

async function expectInvalidQuery(response: Response) {
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    error: "Invalid query parameters",
  });
}

function refundRequest(id: string, status = "PENDING") {
  return {
    id,
    bookingId: `booking-${id}`,
    memberId: `member-${id}`,
    reason: "Weather closure",
    requestedAmountCents: null,
    status,
    adminNotes: null,
    approvedAmountCents: null,
    reviewedAt: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    booking: {
      id: `booking-${id}`,
      checkIn: new Date("2026-07-01T00:00:00.000Z"),
      checkOut: new Date("2026-07-03T00:00:00.000Z"),
      finalPriceCents: 12000,
      status: "CANCELLED",
      creditsFromCancellation: [],
      payment: {
        amountCents: 12000,
        refundedAmountCents: 0,
        stripePaymentIntentId: "pi_123",
      },
    },
    member: {
      id: `member-${id}`,
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
    },
  };
}

function waitlistBooking(id: string) {
  return {
    id,
    member: {
      id: `member-${id}`,
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
    },
    checkIn: new Date("2026-07-01T00:00:00.000Z"),
    checkOut: new Date("2026-07-03T00:00:00.000Z"),
    guests: [],
    status: "WAITLISTED",
    waitlistPosition: 1,
    waitlistOfferExpiresAt: null,
    finalPriceCents: 12000,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
  };
}

function memberApplication(id: string, status = "PENDING_ADMIN") {
  return {
    id,
    applicantFirstName: "Jane",
    applicantLastName: "Doe",
    applicantEmail: "jane@example.com",
    applicantDateOfBirth: null,
    applicantPhone: null,
    applicantAddress: { streetCity: "Auckland" },
    familyMembers: [],
    nominator1Email: "one@example.com",
    nominator2Email: "two@example.com",
    nominator1Id: null,
    nominator2Id: null,
    nominator1ConfirmedAt: null,
    nominator2ConfirmedAt: null,
    status,
    adminNotes: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-02T00:00:00.000Z"),
  };
}

function deletionRequest(id: string, status = "PENDING") {
  return {
    id,
    status,
    reason: "Moving away",
    adminNote: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    member: {
      id: `member-${id}`,
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      role: "MEMBER",
      active: true,
    },
  };
}

function auditLogEntry(id: string) {
  return {
    id,
    memberId: "admin-1",
    details: JSON.stringify({
      subject: "Lodge update",
      recipientFilter: "all",
      totalRecipients: 10,
      eligibleRecipients: 8,
      queued: 8,
    }),
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
  };
}

describe("admin query validation and pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.refundRequestFindMany.mockResolvedValue([]);
    mocks.refundRequestCount.mockResolvedValue(0);
    mocks.bookingFindMany.mockResolvedValue([]);
    mocks.bookingCount.mockResolvedValue(0);
    mocks.memberApplicationFindMany.mockResolvedValue([]);
    mocks.memberApplicationCount.mockResolvedValue(0);
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.deletionRequestFindMany.mockResolvedValue([]);
    mocks.deletionRequestCount.mockResolvedValue(0);
    mocks.auditLogFindMany.mockResolvedValue([]);
    mocks.auditLogCount.mockResolvedValue(0);
    mocks.parseApplicationAddress.mockImplementation((value) => value);
    mocks.parseApplicationFamilyMembers.mockImplementation((value) => value);
  });

  describe("GET /api/admin/refund-requests", () => {
    it("returns 400 for invalid status", async () => {
      const response = await getRefundRequests(
        request("/api/admin/refund-requests?status=NOT_AN_ENUM")
      );

      await expectInvalidQuery(response);
      expect(mocks.refundRequestFindMany).not.toHaveBeenCalled();
    });

    it("defaults to bounded pagination without params", async () => {
      mocks.refundRequestFindMany.mockResolvedValue(
        Array.from({ length: 25 }, (_, index) => refundRequest(`refund-${index}`))
      );
      mocks.refundRequestCount.mockResolvedValue(30);

      const response = await getRefundRequests(request("/api/admin/refund-requests"));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data).toHaveLength(25);
      expect(body.data.length).toBeLessThanOrEqual(body.pageSize);
      expect(body).toMatchObject({ page: 1, pageSize: 25, total: 30 });
      expect(mocks.refundRequestFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: "PENDING" },
          take: 25,
          skip: 0,
        })
      );
    });

    it("returns expected data for valid params", async () => {
      mocks.refundRequestFindMany.mockResolvedValue([refundRequest("refund-1", "APPROVED")]);
      mocks.refundRequestCount.mockResolvedValue(1);

      const response = await getRefundRequests(
        request("/api/admin/refund-requests?status=APPROVED&page=2&pageSize=10")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data[0].id).toBe("refund-1");
      expect(body).toMatchObject({ page: 2, pageSize: 10, total: 1 });
      expect(mocks.refundRequestFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: "APPROVED" },
          take: 10,
          skip: 10,
        })
      );
    });
  });

  describe("GET /api/admin/waitlist", () => {
    it("returns 400 for invalid date", async () => {
      const response = await getWaitlist(request("/api/admin/waitlist?from=garbage"));

      await expectInvalidQuery(response);
      expect(mocks.bookingFindMany).not.toHaveBeenCalled();
    });

    it("returns 400 for date windows over 366 days", async () => {
      const response = await getWaitlist(
        request("/api/admin/waitlist?from=2026-01-01&to=2027-01-02")
      );

      await expectInvalidQuery(response);
      expect(mocks.bookingFindMany).not.toHaveBeenCalled();
    });

    it("defaults to bounded pagination without params", async () => {
      mocks.bookingFindMany.mockResolvedValue(
        Array.from({ length: 25 }, (_, index) => waitlistBooking(`booking-${index}`))
      );
      mocks.bookingCount.mockResolvedValue(30);

      const response = await getWaitlist(request("/api/admin/waitlist"));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.entries).toHaveLength(25);
      expect(body.entries.length).toBeLessThanOrEqual(body.pageSize);
      expect(body).toMatchObject({ page: 1, pageSize: 25, total: 30 });
      expect(mocks.bookingFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 25,
          skip: 0,
        })
      );
    });

    it("returns expected data for valid params", async () => {
      mocks.bookingFindMany.mockResolvedValue([waitlistBooking("booking-1")]);
      mocks.bookingCount.mockResolvedValue(1);

      const response = await getWaitlist(
        request("/api/admin/waitlist?from=2026-07-01&to=2026-07-31&page=2&pageSize=10")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.entries[0]).toMatchObject({
        id: "booking-1",
        memberName: "Jane Doe",
        checkIn: "2026-07-01",
        checkOut: "2026-07-03",
      });
      expect(body).toMatchObject({ page: 2, pageSize: 10, total: 1 });
      expect(mocks.bookingFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            checkIn: expect.objectContaining({
              gte: new Date("2026-07-01"),
            }),
            checkOut: expect.objectContaining({
              lte: new Date("2026-07-31"),
            }),
          }),
          take: 10,
          skip: 10,
        })
      );
    });
  });

  describe("GET /api/admin/member-applications", () => {
    it("returns 400 for invalid status", async () => {
      const response = await getMemberApplications(
        request("/api/admin/member-applications?status=NOT_AN_ENUM")
      );

      await expectInvalidQuery(response);
      expect(mocks.memberApplicationFindMany).not.toHaveBeenCalled();
    });

    it("defaults to bounded pagination without params", async () => {
      mocks.memberApplicationFindMany.mockResolvedValue(
        Array.from({ length: 25 }, (_, index) => memberApplication(`application-${index}`))
      );
      mocks.memberApplicationCount.mockResolvedValue(30);

      const response = await getMemberApplications(
        request("/api/admin/member-applications")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.applications).toHaveLength(25);
      expect(body.applications.length).toBeLessThanOrEqual(body.pageSize);
      expect(body).toMatchObject({ page: 1, pageSize: 25, total: 30 });
      expect(mocks.memberApplicationFindMany).toHaveBeenCalledWith({
        where: undefined,
        orderBy: { createdAt: "desc" },
        take: 25,
        skip: 0,
      });
    });

    it("returns expected data for valid params", async () => {
      mocks.memberApplicationFindMany.mockResolvedValue([
        memberApplication("application-1", "APPROVED"),
      ]);
      mocks.memberApplicationCount.mockResolvedValue(1);

      const response = await getMemberApplications(
        request("/api/admin/member-applications?status=APPROVED&page=2&pageSize=10")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.applications[0]).toMatchObject({
        id: "application-1",
        applicantEmail: "jane@example.com",
        status: "APPROVED",
      });
      expect(body).toMatchObject({ page: 2, pageSize: 10, total: 1 });
      expect(mocks.memberApplicationFindMany).toHaveBeenCalledWith({
        where: { status: "APPROVED" },
        orderBy: { createdAt: "desc" },
        take: 10,
        skip: 10,
      });
    });
  });

  describe("GET /api/admin/deletion-requests", () => {
    it("returns 400 for invalid status", async () => {
      const response = await getDeletionRequests(
        request("/api/admin/deletion-requests?status=NOT_AN_ENUM")
      );

      await expectInvalidQuery(response);
      expect(mocks.deletionRequestFindMany).not.toHaveBeenCalled();
    });

    it("defaults to bounded pagination without params", async () => {
      mocks.deletionRequestFindMany.mockResolvedValue(
        Array.from({ length: 25 }, (_, index) => deletionRequest(`deletion-${index}`))
      );
      mocks.deletionRequestCount.mockResolvedValue(30);

      const response = await getDeletionRequests(
        request("/api/admin/deletion-requests")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.requests).toHaveLength(25);
      expect(body.requests.length).toBeLessThanOrEqual(body.pageSize);
      expect(body).toMatchObject({ page: 1, pageSize: 25, total: 30 });
      expect(mocks.deletionRequestFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: "PENDING" },
          take: 25,
          skip: 0,
        })
      );
    });

    it("returns expected data for valid params", async () => {
      mocks.deletionRequestFindMany.mockResolvedValue([
        deletionRequest("deletion-1", "REJECTED"),
      ]);
      mocks.deletionRequestCount.mockResolvedValue(1);

      const response = await getDeletionRequests(
        request("/api/admin/deletion-requests?status=REJECTED&page=2&pageSize=10")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.requests[0]).toMatchObject({
        id: "deletion-1",
        status: "REJECTED",
      });
      expect(body).toMatchObject({ page: 2, pageSize: 10, total: 1 });
      expect(mocks.deletionRequestFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: "REJECTED" },
          take: 10,
          skip: 10,
        })
      );
    });
  });

  describe("GET /api/admin/communications/history", () => {
    it("returns 400 for invalid pagination", async () => {
      const response = await getCommunicationHistory(
        request("/api/admin/communications/history?page=0")
      );

      await expectInvalidQuery(response);
      expect(mocks.auditLogFindMany).not.toHaveBeenCalled();
    });

    it("defaults to bounded pagination without params", async () => {
      mocks.auditLogFindMany.mockResolvedValue(
        Array.from({ length: 25 }, (_, index) => auditLogEntry(`audit-${index}`))
      );
      mocks.auditLogCount.mockResolvedValue(30);

      const response = await getCommunicationHistory(
        request("/api/admin/communications/history")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.history).toHaveLength(25);
      expect(body.history.length).toBeLessThanOrEqual(body.pageSize);
      expect(body).toMatchObject({ page: 1, pageSize: 25, total: 30 });
      expect(mocks.auditLogFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { action: "BULK_COMMUNICATION_SENT" },
          take: 25,
          skip: 0,
        })
      );
    });

    it("returns expected data for valid params", async () => {
      mocks.auditLogFindMany.mockResolvedValue([auditLogEntry("audit-1")]);
      mocks.auditLogCount.mockResolvedValue(1);

      const response = await getCommunicationHistory(
        request("/api/admin/communications/history?page=2&pageSize=10")
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.history[0]).toMatchObject({
        id: "audit-1",
        subject: "Lodge update",
        recipientFilter: "all",
        totalRecipients: 10,
        eligibleRecipients: 8,
      });
      expect(body).toMatchObject({ page: 2, pageSize: 10, total: 1 });
      expect(mocks.auditLogFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { action: "BULK_COMMUNICATION_SENT" },
          take: 10,
          skip: 10,
        })
      );
    });
  });
});
