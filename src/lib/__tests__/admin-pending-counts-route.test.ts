import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

/*
  GET /api/admin/pending-counts (#4962): one queue whose count throws must not
  blank the rest. Before, the route awaited a single Promise.all, so a database
  blip on any one queue turned into an error response and the sidebar read every
  count as zero. Real `getAdminPendingCounts`; only its data sources are faked.
*/

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  issueReportCount: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/club-time/server", () => ({
  clubTodayDateOnlyInstant: vi.fn().mockResolvedValue(new Date("2026-06-30T00:00:00.000Z")),
}));
// Every model's count answers 2, bar the one that fails.
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_target, model) =>
        model === "issueReport"
          ? { count: mocks.issueReportCount }
          : { count: vi.fn().mockResolvedValue(2) },
    },
  ),
}));
vi.mock("@/lib/xero-webhook-health", () => ({
  getXeroWebhookHealth: vi.fn().mockResolvedValue({ silent: true }),
}));
vi.mock("@/lib/membership-cancellation-admin", () => ({
  getPendingMembershipCancellationReviewCount: vi.fn().mockResolvedValue(2),
}));
vi.mock("@/lib/member-lifecycle-actions", () => ({
  getPendingMemberArchiveReviewCount: vi.fn().mockResolvedValue(2),
  getPendingMemberDeleteReviewCount: vi.fn().mockResolvedValue(2),
}));
vi.mock("@/lib/hut-leader-coverage", () => ({
  getUnassignedHutLeaderDates: vi.fn().mockResolvedValue([{}, {}]),
}));
vi.mock("@/lib/stuck-state-affected-count", () => ({
  getStuckStateAffectedCount: vi.fn().mockResolvedValue(2),
}));

import { GET } from "@/app/api/admin/pending-counts/route";

describe("GET /api/admin/pending-counts", () => {
  beforeEach(() => {
    mocks.requireAdmin.mockResolvedValue({ ok: true });
    mocks.issueReportCount.mockResolvedValue(2);
  });

  it("returns the other counts and names the one that threw", async () => {
    mocks.issueReportCount.mockRejectedValue(new Error("connection reset"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.unavailable).toEqual(["issueReports"]);
    expect(body.issueReports).toBe(0);
    expect(body.bookingReviews).toBe(2);
    expect(body.manualRefundTasks).toBe(2);
    expect(body.stuckStatesAffected).toBe(2);
    expect(body.xeroSilentWebhook).toBe(1);
  });

  it("is never cached, so a refetch after a decision sees the new number", async () => {
    const response = await GET();

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await response.json()).unavailable).toEqual([]);
  });

  it("stays behind requireAdmin", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await GET();

    expect(response.status).toBe(403);
    expect(mocks.issueReportCount).not.toHaveBeenCalled();
  });
});
