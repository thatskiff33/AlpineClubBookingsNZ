import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
const h = vi.hoisted(() => ({ guard: vi.fn(), rate: vi.fn(), audit: vi.fn(), member: vi.fn(), booking: vi.fn(), club: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.guard }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: h.rate, rateLimitedResponse: () => new Response("Too many requests", { status: 429 }) }));
vi.mock("@/lib/audit", () => ({ createAuditLog: h.audit }));
vi.mock("@/lib/xero-sync-now", () => ({ syncMemberFromXeroNow: h.member, syncBookingFromXeroNow: h.booking, syncClubFromXeroNow: h.club, XeroSyncNowError: class extends Error {} }));
vi.mock("@/lib/xero-api-errors", () => ({ getXeroApiErrorInfo: () => ({ handled: false, clientMessage: "Could not finish" }) }));
import { POST } from "@/app/api/admin/xero/sync-now/route";
const request = (body: unknown) => new Request("http://localhost/api/admin/xero/sync-now", { method: "POST", body: JSON.stringify(body) });
describe("sync-now finance boundary", () => {
  beforeEach(() => {
    h.guard.mockResolvedValue({ ok: true, session: { user: { id: "officer" } } });
    h.rate.mockResolvedValue({ success: true });
    for (const run of [h.member, h.booking, h.club]) run.mockResolvedValue({ message: "Already in step." });
  });
  it("requires finance edit and denies a view-only caller before rate-limit or provider work", async () => {
    h.guard.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) });
    expect((await POST(request({ scope: "member", id: "m" }))).status).toBe(403);
    expect(h.guard).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
    expect(h.rate).not.toHaveBeenCalled(); expect(h.member).not.toHaveBeenCalled();
  });
  it("returns 429 without syncing when the actor's shared scope limit is reached", async () => {
    h.rate.mockResolvedValue({ success: false });
    expect((await POST(request({ scope: "club" }))).status).toBe(429);
    expect(h.club).not.toHaveBeenCalled(); expect(h.audit).not.toHaveBeenCalled();
  });
  it.each(["member", "booking", "club"])("dispatches %s once and writes an officer-only xero audit", async (scope) => {
    const response = await POST(request({ scope, id: "target" }));
    expect(response.status).toBe(200);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "XERO_SYNC_NOW", category: "xero", memberId: "officer", metadata: { scope } }));
    expect(h.audit.mock.calls[0]?.[0]).not.toHaveProperty("subjectMemberId");
    expect(h.rate).toHaveBeenCalledWith(expect.objectContaining({ id: "xero-sync-now", limit: 3 }), "officer");
    expect(scope === "member" ? h.member : scope === "booking" ? h.booking : h.club).toHaveBeenCalledOnce();
  });
  it("reports and audits a failed sync rather than claiming success", async () => {
    h.member.mockRejectedValue(new Error("provider failed"));
    expect((await POST(request({ scope: "member", id: "m" }))).status).toBe(500);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure", category: "xero" }));
  });
});
