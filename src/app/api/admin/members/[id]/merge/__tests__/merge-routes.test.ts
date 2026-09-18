import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  actorIsFullAdmin: vi.fn(),
  buildMemberMergePreview: vi.fn(),
  executeMemberMerge: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/admin-account-guards", () => ({ actorIsFullAdmin: h.actorIsFullAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/member-merge", async () => {
  const actual = (await vi.importActual("@/lib/member-merge")) as typeof import("@/lib/member-merge");
  return {
    ...actual,
    buildMemberMergePreview: h.buildMemberMergePreview,
    executeMemberMerge: h.executeMemberMerge,
  };
});

import { POST as previewPOST } from "@/app/api/admin/members/[id]/merge/preview/route";
import { POST as executePOST } from "@/app/api/admin/members/[id]/merge/route";
import { MemberMergeError } from "@/lib/member-merge";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/admin/members/master-1/merge", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "master-1" });

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  h.actorIsFullAdmin.mockResolvedValue(true);
});

describe("merge preview route", () => {
  it("401s when not an admin", async () => {
    h.requireAdmin.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const res = await previewPOST(req({ loserId: "loser-1" }), { params });
    expect(res.status).toBe(401);
  });

  it("403s when the admin is not a Full Admin", async () => {
    h.actorIsFullAdmin.mockResolvedValue(false);
    const res = await previewPOST(req({ loserId: "loser-1" }), { params });
    expect(res.status).toBe(403);
    expect(h.buildMemberMergePreview).not.toHaveBeenCalled();
  });

  it("400s on an invalid body", async () => {
    const res = await previewPOST(req({ notLoser: "x" }), { params });
    expect(res.status).toBe(400);
  });

  it("returns the preview payload", async () => {
    h.buildMemberMergePreview.mockResolvedValue({ previewToken: "tok", warnings: [] });
    const res = await previewPOST(req({ loserId: "loser-1" }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ previewToken: "tok" });
  });

  it("maps a MemberMergeError to its status code", async () => {
    h.buildMemberMergePreview.mockRejectedValue(
      new MemberMergeError("nope", 404, "member_missing"),
    );
    const res = await previewPOST(req({ loserId: "loser-1" }), { params });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "member_missing" });
  });
});

describe("merge execute route", () => {
  it("403s when the admin is not a Full Admin", async () => {
    h.actorIsFullAdmin.mockResolvedValue(false);
    const res = await executePOST(
      req({ loserId: "loser-1", previewToken: "t", confirmationText: "MERGE X" }),
      { params },
    );
    expect(res.status).toBe(403);
    expect(h.executeMemberMerge).not.toHaveBeenCalled();
  });

  it("400s when required fields are missing", async () => {
    const res = await executePOST(req({ loserId: "loser-1" }), { params });
    expect(res.status).toBe(400);
  });

  it("executes and returns ok", async () => {
    h.executeMemberMerge.mockResolvedValue({ masterId: "master-1", loserId: "loser-1" });
    const res = await executePOST(
      req({ loserId: "loser-1", previewToken: "t", confirmationText: "MERGE X" }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, loserId: "loser-1" });
  });

  it("maps preview_drift to 409", async () => {
    h.executeMemberMerge.mockRejectedValue(
      new MemberMergeError("drift", 409, "preview_drift"),
    );
    const res = await executePOST(
      req({ loserId: "loser-1", previewToken: "t", confirmationText: "MERGE X" }),
      { params },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "preview_drift" });
  });
});
