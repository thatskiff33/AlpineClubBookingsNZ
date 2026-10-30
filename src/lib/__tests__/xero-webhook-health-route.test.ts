import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ guard: vi.fn(), health: vi.fn(), save: vi.fn(), audit: vi.fn(), rate: vi.fn() }));
const db = { xeroInboundSettings: { upsert: h.save } };
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: (work: (tx: typeof db) => unknown) => work(db) } }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.guard }));
vi.mock("@/lib/xero-webhook-health", () => ({ getXeroWebhookHealth: h.health }));
vi.mock("@/lib/audit", () => ({ createAuditLog: h.audit }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: h.rate, rateLimitedResponse: () => new Response(null, { status: 429 }) }));
import { GET, PUT } from "@/app/api/admin/xero/webhook-health/route";
const request = (hours: unknown) => new Request("http://localhost/api/admin/xero/webhook-health", { method: "PUT", body: JSON.stringify({ hours }) });
describe("webhook health settings boundary", () => {
  beforeEach(() => { h.guard.mockResolvedValue({ ok: true, session: { user: { id: "officer" } } }); h.rate.mockResolvedValue({ success: true }); h.health.mockResolvedValue({ hours: 24, silent: false }); });
  it("allows finance view reads but requires edit for writes", async () => {
    await GET(); expect(h.guard).toHaveBeenLastCalledWith({ permission: { area: "finance", level: "view" } });
    h.guard.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await PUT(request(48))).status).toBe(403);
    expect(h.guard).toHaveBeenLastCalledWith({ permission: { area: "finance", level: "edit" } }); expect(h.save).not.toHaveBeenCalled();
  });
  it.each([0, 721, 1.5, "24"])("rejects invalid threshold %s", async (hours) => {
    expect((await PUT(request(hours))).status).toBe(400); expect(h.save).not.toHaveBeenCalled();
  });
  it("saves and audits the threshold together without overwriting the receipt", async () => {
    expect((await PUT(request(48))).status).toBe(200);
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ update: { silentWebhookHours: 48 } }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ category: "xero", action: "XERO_WEBHOOK_THRESHOLD_UPDATED", memberId: "officer", metadata: { hours: 48 } }), db);
  });
});
