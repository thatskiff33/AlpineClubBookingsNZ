import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  bulkSave: vi.fn(),
  getPreview: vi.fn(),
  memberFindMany: vi.fn(),
  getAuditRequestContext: vi.fn(() => ({ id: "req-1" })),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/seasonal-membership-assignments", () => ({
  bulkSaveSeasonalMembershipAssignments: mocks.bulkSave,
  getSeasonalMembershipChangePreview: mocks.getPreview,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findMany: mocks.memberFindMany } },
}));
vi.mock("@/lib/audit", () => ({
  getAuditRequestContext: mocks.getAuditRequestContext,
}));

import { POST as savePost } from "@/app/api/admin/members/bulk-membership-type/route";
import { POST as previewPost } from "@/app/api/admin/members/bulk-membership-type/preview/route";

const MEMBERSHIP_EDIT = { area: "membership", level: "edit" } as const;
const okGuard = {
  ok: true as const,
  session: { user: { id: "admin-1" } },
};

function req(bodyObj: unknown) {
  return new NextRequest("http://localhost/api/admin/members/bulk-membership-type", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
}

function forbidden() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

describe("bulk-membership-type routes (#2107)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(okGuard);
    mocks.bulkSave.mockResolvedValue({ body: { outcomeCounts: {} }, init: undefined });
    mocks.getPreview.mockResolvedValue({
      body: {
        preview: {
          previewToken: "tok",
          previousAssignment: null,
          applyFrom: null,
          currentAgeTier: "ADULT",
          resultingAgeTier: "ADULT",
          ageTierChanged: false,
          linkedGuestBookings: { count: 0, truncatedCount: 0, list: [] },
          affectedCounts: {
            futureConfirmedBookings: 0,
            draftBookings: 0,
            waitlistRecords: 0,
          },
        },
      },
      init: undefined,
    });
    mocks.memberFindMany.mockResolvedValue([
      { id: "m-1", firstName: "A", lastName: "B", email: "a@b.test", archivedAt: null },
    ]);
  });

  describe("save route guard", () => {
    it("requires membership:edit and short-circuits on denial", async () => {
      mocks.requireAdmin.mockResolvedValue({ ok: false, response: forbidden() });
      const res = await savePost(
        req({
          ids: ["m-1"],
          seasonYear: 2026,
          membershipTypeId: "t-1",
          reason: "x",
          previewTokens: { "m-1": "tok" },
        }),
      );
      expect(res.status).toBe(403);
      expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: MEMBERSHIP_EDIT });
      expect(mocks.bulkSave).not.toHaveBeenCalled();
    });
  });

  describe("save route validation", () => {
    it("rejects an empty ids array", async () => {
      const res = await savePost(
        req({ ids: [], seasonYear: 2026, membershipTypeId: "t-1", reason: "x", previewTokens: {} }),
      );
      expect(res.status).toBe(400);
      expect(mocks.bulkSave).not.toHaveBeenCalled();
    });

    it("rejects more than 100 ids", async () => {
      const ids = Array.from({ length: 101 }, (_, i) => `m-${i}`);
      const res = await savePost(
        req({ ids, seasonYear: 2026, membershipTypeId: "t-1", reason: "x", previewTokens: {} }),
      );
      expect(res.status).toBe(400);
      expect(mocks.bulkSave).not.toHaveBeenCalled();
    });

    it("rejects a missing reason", async () => {
      const res = await savePost(
        req({ ids: ["m-1"], seasonYear: 2026, membershipTypeId: "t-1", previewTokens: { "m-1": "tok" } }),
      );
      expect(res.status).toBe(400);
      expect(mocks.bulkSave).not.toHaveBeenCalled();
    });

    it("rejects unknown extra fields (strict schema)", async () => {
      const res = await savePost(
        req({
          ids: ["m-1"],
          seasonYear: 2026,
          membershipTypeId: "t-1",
          reason: "x",
          previewTokens: { "m-1": "tok" },
          action: "sneaky",
        }),
      );
      expect(res.status).toBe(400);
      expect(mocks.bulkSave).not.toHaveBeenCalled();
    });

    it("refuses an applyFrom day that does not exist (2026-02-30)", async () => {
      const res = await savePost(
        req({
          ids: ["m-1"],
          seasonYear: 2026,
          membershipTypeId: "t-1",
          applyFrom: "2026-02-30",
          reason: "x",
          previewTokens: { "m-1": "tok" },
        }),
      );
      expect(res.status).toBe(400);
      expect(mocks.bulkSave).not.toHaveBeenCalled();
    });

    it("passes a valid request through to the lib wrapper", async () => {
      const res = await savePost(
        req({
          ids: ["m-1", "m-2"],
          seasonYear: 2026,
          membershipTypeId: "t-1",
          reason: "season start",
          previewTokens: { "m-1": "tok1", "m-2": "tok2" },
        }),
      );
      expect(res.status).toBe(200);
      expect(mocks.bulkSave).toHaveBeenCalledTimes(1);
      expect(mocks.bulkSave).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: ["m-1", "m-2"],
          membershipTypeId: "t-1",
          adminMemberId: "admin-1",
          reason: "season start",
        }),
      );
    });
  });

  describe("preview route", () => {
    it("requires membership:edit and short-circuits on denial", async () => {
      mocks.requireAdmin.mockResolvedValue({ ok: false, response: forbidden() });
      const res = await previewPost(
        req({ ids: ["m-1"], seasonYear: 2026, membershipTypeId: "t-1" }),
      );
      expect(res.status).toBe(403);
      expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: MEMBERSHIP_EDIT });
      expect(mocks.getPreview).not.toHaveBeenCalled();
    });

    it("rejects an empty ids array", async () => {
      const res = await previewPost(req({ ids: [], seasonYear: 2026, membershipTypeId: "t-1" }));
      expect(res.status).toBe(400);
    });

    it("refuses an applyFrom day that does not exist (2026-02-30)", async () => {
      const res = await previewPost(
        req({ ids: ["m-1"], seasonYear: 2026, membershipTypeId: "t-1", applyFrom: "2026-02-30" }),
      );
      expect(res.status).toBe(400);
      expect(mocks.getPreview).not.toHaveBeenCalled();
    });

    it("previews previewable members and reports archived/not-found skips by id", async () => {
      mocks.memberFindMany.mockResolvedValue([
        { id: "m-1", firstName: "A", lastName: "B", email: "a@b.test", archivedAt: null },
        {
          id: "m-arch",
          firstName: "C",
          lastName: "D",
          email: "c@d.test",
          archivedAt: new Date("2026-01-01"),
        },
      ]);
      const res = await previewPost(
        req({ ids: ["m-1", "m-arch", "m-missing"], seasonYear: 2026, membershipTypeId: "t-1" }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.previewed).toBe(1);
      expect(body.skipped).toEqual(
        expect.arrayContaining([
          { memberId: "m-arch", reason: "archived" },
          { memberId: "m-missing", reason: "not_found" },
        ]),
      );
      // Only the one previewable member reaches the preview helper.
      expect(mocks.getPreview).toHaveBeenCalledTimes(1);
    });

    it("surfaces a type-level preview error as the whole-request response", async () => {
      mocks.getPreview.mockResolvedValue({
        body: { error: "Membership type not found" },
        init: { status: 404 },
      });
      const res = await previewPost(
        req({ ids: ["m-1"], seasonYear: 2026, membershipTypeId: "missing-type" }),
      );
      expect(res.status).toBe(404);
    });
  });
});
