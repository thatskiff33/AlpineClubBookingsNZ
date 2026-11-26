/**
 * `GET /api/admin/xero/search-contacts` makes a live Xero `getContacts` call
 * per request, so it carries a per-officer limiter like `xero-sync-now`
 * (ALP-721 review): one officer, in the browser or through an AI app
 * connection, cannot spend the club's Xero minute budget. Past the limit it
 * answers 429 before any Xero or database work.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { financeAdminSession } from "./helpers/admin-area-gate-sessions";
import { evaluateRequireAdminMock } from "./helpers/require-admin-mock";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  guard: vi.fn(),
  rate: vi.fn(),
  getContacts: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.guard, requireActiveSessionUser: async () => null }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: h.rate,
  rateLimitedResponse: () => new Response("Too many requests", { status: 429 }),
}));
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: async () => ({
    xero: { accountingApi: { getContacts: h.getContacts } },
    tenantId: "tenant",
  }),
  callXeroApi: (run: () => Promise<unknown>) => run(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { member: { findMany: h.findMany } } }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { GET } from "@/app/api/admin/xero/search-contacts/route";
import { NextRequest } from "next/server";

const search = (q: string) => new NextRequest(`http://localhost/api/admin/xero/search-contacts?q=${encodeURIComponent(q)}`);

describe("GET /api/admin/xero/search-contacts rate limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.auth.mockResolvedValue({ user: { ...financeAdminSession.user, id: "officer" } });
    h.guard.mockImplementation(evaluateRequireAdminMock);
    h.rate.mockResolvedValue({ success: true });
    h.getContacts.mockResolvedValue({ body: { contacts: [{ contactID: "c-1", name: "Aroha Ngata" }] } });
    h.findMany.mockResolvedValue([]);
  });

  it("counts each search against the signed-in officer's own budget", async () => {
    const response = await GET(search("Aroha"));
    expect(response.status).toBe(200);
    expect(h.rate).toHaveBeenCalledOnce();
    expect(h.rate).toHaveBeenCalledWith({ id: "xero-search-contacts", limit: 30, windowSeconds: 60 }, "officer");
    expect(h.getContacts).toHaveBeenCalledOnce();
  });

  it("answers 429 without asking Xero or reading members once the budget is spent", async () => {
    h.rate.mockResolvedValue({ success: false });
    expect((await GET(search("Aroha"))).status).toBe(429);
    expect(h.getContacts).not.toHaveBeenCalled();
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller before spending anyone's budget", async () => {
    h.auth.mockResolvedValue(null);
    expect((await GET(search("Aroha"))).status).toBe(401);
    expect(h.rate).not.toHaveBeenCalled();
    expect(h.getContacts).not.toHaveBeenCalled();
  });
});
