import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ALP-574: `applyFrom` on both the single-member save and its preview now goes
 * through `dateOnlyStringSchema`, which refuses a shape-valid but non-existent
 * calendar day (e.g. `2026-02-30`) at the schema, before either route reaches
 * its lib call.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  save: vi.fn(),
  getPreview: vi.fn(),
  getAuditRequestContext: vi.fn(() => ({ id: "req-1" })),
  clubTimeZone: vi.fn(),
  clubToday: vi.fn(),
  dateOnlyInstantOf: vi.fn(),
  clubSeasonYear: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/seasonal-membership-assignments", () => ({
  saveSeasonalMembershipAssignment: mocks.save,
  getSeasonalMembershipChangePreview: mocks.getPreview,
}));
vi.mock("@/lib/audit", () => ({
  getAuditRequestContext: mocks.getAuditRequestContext,
}));
vi.mock("@/lib/club-time/server", () => ({
  clubTimeZone: mocks.clubTimeZone,
}));
vi.mock("@/lib/club-time", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/club-time");
  return {
    ...actual,
    clubToday: mocks.clubToday,
    dateOnlyInstantOf: mocks.dateOnlyInstantOf,
  };
});
vi.mock("@/lib/financial-year", () => ({
  clubSeasonYear: mocks.clubSeasonYear,
}));

import { PATCH } from "@/app/api/admin/members/[id]/seasonal-membership/route";
import { POST as previewPost } from "@/app/api/admin/members/[id]/seasonal-membership/preview/route";

const okGuard = {
  ok: true as const,
  session: { user: { id: "admin-1" } },
};

function patchRequest(bodyObj: unknown) {
  return new NextRequest(
    "http://localhost/api/admin/members/m-1/seasonal-membership",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj),
    },
  );
}

function previewRequest(bodyObj: unknown) {
  return new NextRequest(
    "http://localhost/api/admin/members/m-1/seasonal-membership/preview",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj),
    },
  );
}

const params = Promise.resolve({ id: "m-1" });

function forbidden() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

describe("seasonal-membership applyFrom (ALP-574)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(okGuard);
    mocks.save.mockResolvedValue({ body: { success: true }, init: undefined });
    mocks.getPreview.mockResolvedValue({
      body: { preview: { previewToken: "tok" } },
      init: undefined,
    });
    mocks.clubTimeZone.mockResolvedValue("Pacific/Auckland");
    mocks.clubToday.mockReturnValue(new Date("2026-07-01T00:00:00.000Z"));
    mocks.dateOnlyInstantOf.mockReturnValue(new Date("2026-07-01T00:00:00.000Z"));
    mocks.clubSeasonYear.mockReturnValue(2026);
  });

  it("refuses an applyFrom day that does not exist on save (2026-02-30)", async () => {
    const res = await PATCH(
      patchRequest({
        seasonYear: 2026,
        membershipTypeId: "t-1",
        applyFrom: "2026-02-30",
        reason: "x",
        previewToken: "tok",
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refuses an applyFrom day that does not exist on preview (2026-02-30)", async () => {
    const res = await previewPost(
      previewRequest({
        seasonYear: 2026,
        membershipTypeId: "t-1",
        applyFrom: "2026-02-30",
      }),
      { params },
    );
    expect(res.status).toBe(400);
    expect(mocks.getPreview).not.toHaveBeenCalled();
  });

  it("still requires admin membership:edit before validation fails open", async () => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: forbidden() });
    const res = await PATCH(
      patchRequest({
        seasonYear: 2026,
        membershipTypeId: "t-1",
        applyFrom: "2026-02-30",
        reason: "x",
        previewToken: "tok",
      }),
      { params },
    );
    expect(res.status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
