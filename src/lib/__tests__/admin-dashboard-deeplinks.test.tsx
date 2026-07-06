import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn() },
    booking: { count: vi.fn(), findMany: vi.fn() },
    payment: { aggregate: vi.fn() },
    refundRequest: { count: vi.fn() },
    adminCreditAdjustmentRequest: { count: vi.fn() },
    membershipCancellationRequest: { count: vi.fn() },
    memberLifecycleActionRequest: { count: vi.fn() },
    deletionRequest: { count: vi.fn() },
    bookingChangeRequest: { count: vi.fn() },
  },
}));

vi.mock("@/lib/hut-leader-coverage", () => ({
  getUnassignedHutLeaderDates: vi.fn(),
}));

import AdminDashboardPage from "@/app/(admin)/admin/dashboard/page";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";
import { prisma } from "@/lib/prisma";

function mockDashboardCounts({
  pendingBookingReviews,
  pendingBookingChangeRequests,
  pendingDeletionRequests = 0,
}: {
  pendingBookingReviews: number;
  pendingBookingChangeRequests: number;
  pendingDeletionRequests?: number;
}) {
  vi.mocked(prisma.member.count).mockResolvedValue(0);
  vi.mocked(prisma.booking.count)
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(pendingBookingReviews);
  vi.mocked(prisma.payment.aggregate).mockResolvedValue({
    _sum: { amountCents: 0 },
  } as any);
  vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
  vi.mocked(prisma.refundRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.adminCreditAdjustmentRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.membershipCancellationRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.memberLifecycleActionRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.deletionRequest.count).mockResolvedValue(
    pendingDeletionRequests,
  );
  vi.mocked(prisma.bookingChangeRequest.count).mockResolvedValue(
    pendingBookingChangeRequests,
  );
  vi.mocked(getUnassignedHutLeaderDates).mockResolvedValue([]);
}

describe("admin dashboard deep links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("links booking request alerts to the changes tab when only change requests are pending", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 2,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).toContain('href="/admin/booking-requests?tab=changes"');
  });

  it("links booking request alerts to the approvals tab when booking reviews are pending", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 1,
      pendingBookingChangeRequests: 2,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).toContain('href="/admin/booking-requests?tab=approvals"');
  });

  it("links pending account deletion request alerts to the deletion request queue", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 0,
      pendingDeletionRequests: 2,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).toContain('href="/admin/deletion-requests?status=PENDING"');
    expect(html).toContain("Account Deletion Requests");
    expect(html).toContain(
      "2 account deletion requests waiting for admin review",
    );
  });
});
