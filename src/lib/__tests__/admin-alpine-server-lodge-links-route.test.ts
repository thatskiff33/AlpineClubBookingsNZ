import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST|PUT /api/admin/alpine-server/lodge-links` (server onboarding, B2):
 * Full Admin only, like the key save it follows; a failed download is answered
 * as the Download button answers it; each refused save has its own answer.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  isFullAdmin: vi.fn(),
  runLodgeLinkStep: vi.fn(),
  saveLodgeLinkChoices: vi.fn(),
  respondToSyncError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/access-roles", () => ({ isFullAdmin: mocks.isFullAdmin }));
vi.mock("@/lib/servernz-lodge-link-step", () => ({
  runLodgeLinkStep: mocks.runLodgeLinkStep,
  saveLodgeLinkChoices: mocks.saveLodgeLinkChoices,
}));
vi.mock("@/lib/servernz-sync-response", () => ({ respondToSyncError: mocks.respondToSyncError }));

import { POST, PUT } from "@/app/api/admin/alpine-server/lodge-links/route";

const put = (body: unknown) =>
  new Request("http://localhost/api/admin/alpine-server/lodge-links", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const LINKS = { links: [{ lodgeId: "l1", centralLodgeId: "c_a", expectCurrent: null }] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  mocks.isFullAdmin.mockReturnValue(true);
});

describe("lodge-links route", () => {
  it("refuses an admin who is not a Full Admin, running nothing", async () => {
    mocks.isFullAdmin.mockReturnValue(false);
    expect((await POST()).status).toBe(403);
    expect((await PUT(put(LINKS))).status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
    expect(mocks.runLodgeLinkStep).not.toHaveBeenCalled();
    expect(mocks.saveLodgeLinkChoices).not.toHaveBeenCalled();
  });

  it("POST runs the step for the acting admin, and answers a failure as the Download button does", async () => {
    mocks.runLodgeLinkStep.mockResolvedValue({ download: "downloaded", step: { kind: "no-owned" } });
    const res = await POST();
    expect(await res.json()).toEqual({ download: "downloaded", step: { kind: "no-owned" } });
    expect(mocks.runLodgeLinkStep).toHaveBeenCalledWith("admin-1");

    const failure = new Error("unreachable");
    mocks.runLodgeLinkStep.mockRejectedValue(failure);
    mocks.respondToSyncError.mockResolvedValue(new Response(null, { status: 502 }));
    expect((await POST()).status).toBe(502);
    expect(mocks.respondToSyncError).toHaveBeenCalledWith(failure, "admin-1", "download");
  });

  it("PUT saves the rows as sent", async () => {
    mocks.saveLodgeLinkChoices.mockResolvedValue({ ok: true, before: [] });
    expect((await PUT(put(LINKS))).status).toBe(200);
    expect(mocks.saveLodgeLinkChoices).toHaveBeenCalledWith(LINKS.links, "admin-1");
  });

  it.each([
    [{ ok: false, reason: "already-linked", holderName: "Iwikau" }, 409, "Iwikau"],
    [{ ok: false, reason: "stale" }, 409, "changed while this was open"],
    [{ ok: false, reason: "duplicate" }, 400, "one lodge only"],
    [{ ok: false, reason: "lodge-not-found", lodgeId: "l1" }, 404, "no longer exists"],
    [{ ok: false, reason: "not-owned" }, 400, "says this club owns"],
  ])("PUT answers %o", async (result, status, text) => {
    mocks.saveLodgeLinkChoices.mockResolvedValue(result);
    const res = await PUT(put(LINKS));
    expect(res.status).toBe(status);
    expect((await res.json()).error).toContain(text);
  });

  it.each([
    ["no rows", { links: [] }],
    ["an unknown key", { links: LINKS.links, extra: 1 }],
    ["a row without its expectation", { links: [{ lodgeId: "l1", centralLodgeId: "c_a" }] }],
  ])("PUT is 400 for %s", async (_label, body) => {
    expect((await PUT(put(body))).status).toBe(400);
    expect(mocks.saveLodgeLinkChoices).not.toHaveBeenCalled();
  });
});
