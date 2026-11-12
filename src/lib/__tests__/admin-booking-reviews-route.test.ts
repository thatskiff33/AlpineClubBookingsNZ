import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  bookingFindMany: vi.fn(),
  bookingCount: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: mocks.bookingFindMany, count: mocks.bookingCount },
  },
}));

vi.mock("@/lib/booking-review", () => ({
  bookingReviewReasonCodes: () => [],
  bookingReviewReasonSentences: () => [],
}));

import { GET } from "@/app/api/admin/booking-reviews/route";

function request(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

function rows(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` }));
}

const pendingWhere = { deletedAt: null, adminReviewStatus: "PENDING" };
const decidedWhere = {
  deletedAt: null,
  adminReviewStatus: { in: ["APPROVED", "REJECTED"] },
};

/**
 * #4960 / INV-OPS-017: the booking approvals queue pages to every row, reads
 * PENDING oldest first, and on ALL keeps PENDING ahead of decided rows.
 */
describe("GET /api/admin/booking-reviews paging and order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.bookingFindMany.mockResolvedValue([]);
    mocks.bookingCount.mockResolvedValue(0);
  });

  it("reads PENDING oldest first and answers the shared page envelope", async () => {
    mocks.bookingFindMany.mockResolvedValue(rows("pending", 25));
    mocks.bookingCount.mockResolvedValue(40);

    const response = await GET(request("/api/admin/booking-reviews?status=PENDING"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: pendingWhere,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: 0,
        take: 25,
      }),
    );
    expect(body).toMatchObject({ page: 1, pageSize: 25, total: 40, totalPages: 2 });
    expect(body).not.toHaveProperty("pagination");
  });

  it("reads a decided filter newest first", async () => {
    await GET(request("/api/admin/booking-reviews?status=APPROVED&page=3&pageSize=10"));

    expect(mocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, adminReviewStatus: "APPROVED" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: 20,
        take: 10,
      }),
    );
  });

  it("slices ALL across PENDING (oldest first) then decided (newest first)", async () => {
    mocks.bookingCount.mockImplementation(async ({ where }) =>
      where.adminReviewStatus === "PENDING" ? 12 : 30,
    );
    mocks.bookingFindMany.mockImplementation(async ({ where, take }) =>
      rows(where.adminReviewStatus === "PENDING" ? "pending" : "decided", take),
    );

    const response = await GET(
      request("/api/admin/booking-reviews?status=ALL&page=2&pageSize=10"),
    );
    const body = await response.json();

    expect(mocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: pendingWhere,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: 10,
        take: 2,
      }),
    );
    expect(mocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: decidedWhere,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: 0,
        take: 8,
      }),
    );
    expect(body.data.map((row: { id: string }) => row.id.split("-")[0])).toEqual([
      "pending",
      "pending",
      ...Array(8).fill("decided"),
    ]);
    expect(body).toMatchObject({ page: 2, pageSize: 10, total: 42, totalPages: 5 });
  });

  it("skips the PENDING read once ALL has paged past it", async () => {
    mocks.bookingCount.mockImplementation(async ({ where }) =>
      where.adminReviewStatus === "PENDING" ? 3 : 30,
    );

    await GET(request("/api/admin/booking-reviews?status=ALL&page=2&pageSize=10"));

    expect(mocks.bookingFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: decidedWhere, skip: 7, take: 10 }),
    );
  });

  it("reads one focused booking inside the review scope", async () => {
    await GET(
      request("/api/admin/booking-reviews?status=PENDING&bookingId=booking-77"),
    );

    expect(mocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...pendingWhere, id: "booking-77" } }),
    );
    expect(mocks.bookingCount).toHaveBeenCalledWith({
      where: { ...pendingWhere, id: "booking-77" },
    });
  });
});
