import { beforeEach, describe, expect, it, vi } from "vitest";
import { bookingsAdminSession, contentAdminSession, financeAdminSession } from "./helpers/admin-area-gate-sessions";
import { evaluateRequireAdminMock } from "./helpers/require-admin-mock";
const h = vi.hoisted(() => ({ auth: vi.fn(), guard: vi.fn(), rate: vi.fn(), audit: vi.fn(), member: vi.fn(), booking: vi.fn(), club: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.guard, requireActiveSessionUser: async () => null }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: h.rate, rateLimitedResponse: () => new Response("Too many requests", { status: 429 }) }));
vi.mock("@/lib/audit", () => ({ createAuditLog: h.audit }));
vi.mock("@/lib/xero-sync-now", () => ({ syncMemberFromXeroNow: h.member, syncBookingFromXeroNow: h.booking, syncClubFromXeroNow: h.club, XeroSyncNowError: class extends Error {} }));
vi.mock("@/lib/xero-api-errors", () => ({ getXeroApiErrorInfo: () => ({ handled: false, clientMessage: "Could not finish" }) }));
import { POST } from "@/app/api/admin/xero/sync-now/route";
const request = (body: unknown) => new Request("http://localhost/api/admin/xero/sync-now", { method: "POST", body: JSON.stringify(body) });
describe("sync-now finance boundary", () => {
  beforeEach(() => {
    h.auth.mockResolvedValue({ user: { ...financeAdminSession.user, id: "officer" } });
    h.guard.mockImplementation(evaluateRequireAdminMock);
    h.rate.mockResolvedValue({ success: true });
    for (const run of [h.member, h.booking, h.club]) run.mockResolvedValue({ message: "Already in step." });
  });
  it.each(["member", "booking", "club"])("denies finance view-only users for %s before rate-limit or provider work", async (scope) => {
    h.auth.mockResolvedValue(bookingsAdminSession);
    expect((await POST(request({ scope, id: "m" }))).status).toBe(403);
    expect(h.guard).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
    expect(h.rate).not.toHaveBeenCalled(); expect(h.member).not.toHaveBeenCalled();
  });
  it("denies an officer with edit access in another area", async () => {
    h.auth.mockResolvedValue(contentAdminSession);
    expect((await POST(request({ scope: "club" }))).status).toBe(403);
    expect(h.club).not.toHaveBeenCalled();
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
