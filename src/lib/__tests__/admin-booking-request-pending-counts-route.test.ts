import { beforeEach, describe, expect, it, vi } from "vitest";

// #4969: the Booking Requests page reads its four tab counts from a
// bookings-area route, not from the overview-area sidebar aggregate, so a role
// that holds bookings but not overview still gets its badges and landing tab.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  getBookingRequestPendingCounts: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/admin-booking-request-pending-counts", () => ({
  getBookingRequestPendingCounts: mocks.getBookingRequestPendingCounts,
}));

import { GET } from "@/app/api/admin/booking-requests/pending-counts/route";

const COUNTS = {
  bookingReviews: 1,
  lockedPeriodChangeRequests: 2,
  policyExceptionRequests: 3,
  publicBookingRequests: 4,
};

/** A custom role: exactly these areas, at these levels. */
function sessionWith(matrix: Record<string, "view" | "edit">) {
  return {
    user: {
      id: "officer-1",
      adminPermissionMatrix: {
        overview: "none",
        bookings: "none",
        membership: "none",
        finance: "none",
        lodge: "none",
        content: "none",
        support: "none",
        ...matrix,
      },
    },
  };
}

describe("GET /api/admin/booking-requests/pending-counts (#4969)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.getBookingRequestPendingCounts.mockResolvedValue(COUNTS);
  });

  it("answers the four queue counts to a role that holds bookings but not overview", async () => {
    mocks.auth.mockResolvedValue(sessionWith({ bookings: "view" }));

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(COUNTS);
  });

  it("refuses a role without bookings, even one that holds overview", async () => {
    mocks.auth.mockResolvedValue(sessionWith({ overview: "edit", finance: "edit" }));

    const response = await GET();

    expect(response.status).toBe(403);
    expect(mocks.getBookingRequestPendingCounts).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    mocks.auth.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mocks.getBookingRequestPendingCounts).not.toHaveBeenCalled();
  });
});
