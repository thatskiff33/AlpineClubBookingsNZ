import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #5248: the bulk subscription-category routes. The lib wrapper is mocked; the
// subject here is the guard, the request schema and the one zone read.
const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  bulkSave: vi.fn(),
  preview: vi.fn(),
  clubTimeZone: vi.fn(async () => "Pacific/Auckland"),
  getAuditRequestContext: vi.fn(() => ({ id: "req-1" })),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/bulk-subscription-category-assignments", () => ({
  bulkSaveSubscriptionCategory: mocks.bulkSave,
  previewBulkSubscriptionCategory: mocks.preview,
}));
vi.mock("@/lib/club-time/server", () => ({ clubTimeZone: mocks.clubTimeZone }));
vi.mock("@/lib/audit", () => ({
  getAuditRequestContext: mocks.getAuditRequestContext,
}));

import { POST as savePost } from "@/app/api/admin/members/bulk-subscription-category/route";
import { POST as previewPost } from "@/app/api/admin/members/bulk-subscription-category/preview/route";

const MEMBERSHIP_EDIT = { area: "membership", level: "edit" } as const;
const okGuard = { ok: true as const, session: { user: { id: "admin-1" } } };

function req(bodyObj: unknown) {
  return new NextRequest("http://localhost/api/admin/members/bulk-subscription-category", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
}

const validSave = {
  ids: ["m-1"],
  seasonYear: 2026,
  subscriptionCategoryId: "cat-couple",
  reason: "Couples move to the Couple category",
  previewTokens: { "m-1": "tok" },
};
const validPreview = { ids: ["m-1"], seasonYear: 2026, subscriptionCategoryId: "cat-couple" };

describe.each([
  ["save", savePost, validSave, () => mocks.bulkSave],
  ["preview", previewPost, validPreview, () => mocks.preview],
] as const)("bulk-subscription-category %s route (#5248)", (_label, post, valid, lib) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(okGuard);
    mocks.bulkSave.mockResolvedValue({ body: { outcomeCounts: {} }, init: undefined });
    mocks.preview.mockResolvedValue({ body: { members: [], skipped: [] }, init: undefined });
  });

  it("asks for membership EDIT, so a view-only officer is refused before anything runs", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });
    const res = await post(req(valid));
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: MEMBERSHIP_EDIT });
    expect(lib()).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty ids array", { ids: [] }],
    ["more than 100 ids", { ids: Array.from({ length: 101 }, (_, i) => `m-${i}`) }],
    ["an unknown extra field", { membershipTypeId: "t-1" }],
    ["an empty-string category (null means Individual)", { subscriptionCategoryId: "" }],
  ])("rejects %s", async (_case, override) => {
    const res = await post(req({ ...valid, ...override }));
    expect(res.status).toBe(400);
    expect(lib()).not.toHaveBeenCalled();
  });

  it("rejects an omitted category rather than reading it as 'keep the current one'", async () => {
    const withoutCategory: Record<string, unknown> = { ...valid };
    delete withoutCategory.subscriptionCategoryId;
    const res = await post(req(withoutCategory));
    expect(res.status).toBe(400);
    expect(lib()).not.toHaveBeenCalled();
  });

  it("passes null through as the Individual (clear) target", async () => {
    const res = await post(req({ ...valid, subscriptionCategoryId: null }));
    expect(res.status).toBe(200);
    expect(lib()).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionCategoryId: null, ids: ["m-1"], seasonYear: 2026 }),
    );
  });

  it("returns the wrapper's whole-request refusal as-is", async () => {
    lib().mockResolvedValue({
      body: { error: "Archived subscription categories cannot be newly assigned" },
      init: { status: 409 },
    });
    const res = await post(req(valid));
    expect(res.status).toBe(409);
  });
});

describe("bulk-subscription-category save route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(okGuard);
    mocks.bulkSave.mockResolvedValue({ body: { outcomeCounts: {} }, init: undefined });
  });

  it("rejects a missing reason", async () => {
    const withoutReason: Record<string, unknown> = { ...validSave };
    delete withoutReason.reason;
    const res = await savePost(req(withoutReason));
    expect(res.status).toBe(400);
    expect(mocks.bulkSave).not.toHaveBeenCalled();
  });

  it("attributes the change to the signed-in officer", async () => {
    await savePost(req(validSave));
    expect(mocks.bulkSave).toHaveBeenCalledWith(
      expect.objectContaining({
        adminMemberId: "admin-1",
        previewTokens: { "m-1": "tok" },
        request: { id: "req-1" },
      }),
    );
  });
});

describe("bulk-subscription-category preview route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(okGuard);
    mocks.preview.mockResolvedValue({ body: { members: [], skipped: [] }, init: undefined });
  });

  it("reads the club's zone once and hands the batch one club day and season", async () => {
    await previewPost(req({ ...validPreview, ids: ["m-1", "m-2", "m-3"] }));
    expect(mocks.clubTimeZone).toHaveBeenCalledTimes(1);
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        // The frozen clock, 1 July 2026, is 1 July in New Zealand and season 2026.
        now: new Date("2026-07-01T00:00:00.000Z"),
        clubCurrentSeasonYear: 2026,
      }),
    );
  });
});
