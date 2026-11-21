import { beforeEach, describe, expect, it, vi } from "vitest";
import { bookingsAdminSession, contentAdminSession, financeAdminSession } from "./helpers/admin-area-gate-sessions";
import { evaluateRequireAdminMock } from "./helpers/require-admin-mock";
const h = vi.hoisted(() => ({ auth: vi.fn(), guard: vi.fn(), rate: vi.fn(), audit: vi.fn(), refresh: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.guard, requireActiveSessionUser: async () => null }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: h.rate, rateLimitedResponse: () => new Response("Too many requests", { status: 429 }) }));
vi.mock("@/lib/audit", () => ({ createAuditLog: h.audit }));
vi.mock("@/lib/xero-api-errors", () => ({ getXeroApiErrorInfo: () => ({ handled: true, status: 503, clientMessage: "Xero is not connected." }) }));
vi.mock("@/lib/xero-cash-credits", () => ({
  refreshXeroCashCredits: h.refresh,
  listXeroCashCreditQueue: h.list,
  XeroCashCreditReadError: class XeroCashCreditReadError extends Error {},
}));
import { GET, POST } from "@/app/api/admin/xero/cash-credits/route";
import { XeroCashCreditReadError } from "@/lib/xero-cash-credits";

const queue = { refreshedAt: null, rows: [] };

describe("Xero cash-credit queue route (#5204)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.auth.mockResolvedValue({ user: { ...financeAdminSession.user, id: "officer" } });
    h.guard.mockImplementation(evaluateRequireAdminMock);
    h.rate.mockResolvedValue({ success: true });
    h.list.mockResolvedValue(queue);
    h.refresh.mockResolvedValue({ open: 2, written: 2, zeroed: 1, current: true });
  });

  it("lists the queue for finance view, and refuses an officer of another area", async () => {
    h.auth.mockResolvedValue(contentAdminSession);
    expect((await GET()).status).toBe(403);
    expect(h.list).not.toHaveBeenCalled();
    h.auth.mockResolvedValue({ user: { ...financeAdminSession.user, id: "officer" } });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(queue);
    expect(h.guard).toHaveBeenCalledWith({ permission: { area: "finance", level: "view" } });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it.each([["finance view only", bookingsAdminSession], ["another area", contentAdminSession]])("refuses Refresh to %s before rate limiting or reading Xero", async (_who, session) => {
    h.auth.mockResolvedValue(session);
    expect((await POST()).status).toBe(403);
    expect(h.guard).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
    expect(h.rate).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("returns 429 without reading Xero or auditing when the officer's limit is reached", async () => {
    h.rate.mockResolvedValue({ success: false });
    expect((await POST()).status).toBe(429);
    expect(h.rate).toHaveBeenCalledWith(expect.objectContaining({ id: "xero-cash-credits-refresh-post", limit: 3 }), "officer");
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("refreshes once, audits the success and returns the fresh queue", async () => {
    const response = await POST();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { open: 2, written: 2, zeroed: 1, current: true }, queue });
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "XERO_CASH_CREDITS_REFRESH", category: "xero", memberId: "officer", metadata: { open: 2, written: 2, zeroed: 1, current: true },
    }));
    expect(h.audit.mock.calls[0]?.[0]).not.toHaveProperty("outcome");
  });

  it("reports and audits an unreadable Xero page as a failure, never as success", async () => {
    h.refresh.mockRejectedValue(new XeroCashCreditReadError("Xero returned an overpayment the app cannot read (x); nothing was refreshed."));
    const response = await POST();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Xero returned an overpayment the app cannot read (x); nothing was refreshed." });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "XERO_CASH_CREDITS_REFRESH", outcome: "failure" }));
  });

  it("never reports a fault after the snapshot was saved as a failed refresh", async () => {
    h.list.mockRejectedValue(new Error("queue read failed"));
    await expect(POST()).rejects.toThrow("queue read failed");
    expect(h.audit).toHaveBeenCalledOnce();
    expect(h.audit.mock.calls[0]?.[0]).not.toHaveProperty("outcome");
  });

  it("reports a provider failure with the shared Xero error answer", async () => {
    h.refresh.mockRejectedValue(new Error("not connected"));
    const response = await POST();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Xero is not connected." });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure", summary: "Xero is not connected." }));
  });
});
