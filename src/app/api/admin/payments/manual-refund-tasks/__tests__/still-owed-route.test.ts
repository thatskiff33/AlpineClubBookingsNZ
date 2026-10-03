import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3835: the settle dialog's read of what a review share on a cancelled
 * booking still owes. The figure itself is `previewEditReviewStillOwed`'s
 * (proven equal to the completion's on PostgreSQL); this pins the door: the
 * gate, the parse, and that the share asked about is the one passed on.
 */
const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  previewEditReviewStillOwed: vi.fn(),
}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: vi.fn(async () => "Pacific/Auckland") }));
vi.mock("@/lib/club-format-server", async () => ({ clubFormatValues: async () => (await import("@/lib/__tests__/support/club-format-fixture")).CLUB_FORMAT_TEST }));
vi.mock("@/lib/edit-financial-review-still-owed", () => ({ previewEditReviewStillOwed: mocks.previewEditReviewStillOwed }));

import { GET } from "../[id]/still-owed/route";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const params = Promise.resolve({ id: "task-1" });
const get = (query: string) => GET(new NextRequest(`http://localhost/api/admin/payments/manual-refund-tasks/task-1/still-owed${query}`), { params });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  mocks.previewEditReviewStillOwed.mockResolvedValue({ shareCents: 5_000, stillOwedCents: 2_500, captureCents: 2_500, creditCents: 0, route: "hand-back" });
});

describe("GET still-owed (#3835)", () => {
  it("MUTATION: answers the completion's figure for the share asked about", async () => {
    const response = await get("?shareCents=5000");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ preview: { shareCents: 5_000, stillOwedCents: 2_500, captureCents: 2_500, creditCents: 0, route: "hand-back" } });
    expect(mocks.previewEditReviewStillOwed).toHaveBeenCalledWith({ taskId: "task-1", shareCents: 5_000, clubZone: "Pacific/Auckland", format: CLUB_FORMAT_TEST });
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "view" } });
  });

  it.each(["", "?shareCents=", "?shareCents=0", "?shareCents=12.5", "?shareCents=-1", "?shareCents=abc"])(
    "MUTATION: refuses %j without reading anything",
    async (query) => {
      expect((await get(query)).status).toBe(400);
      expect(mocks.previewEditReviewStillOwed).not.toHaveBeenCalled();
    },
  );

  it("is gated like the queue", async () => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });

    expect((await get("?shareCents=5000")).status).toBe(403);
    expect(mocks.previewEditReviewStillOwed).not.toHaveBeenCalled();
  });
});
