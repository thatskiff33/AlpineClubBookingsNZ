import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getAiUsageSummary: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/ai-assistant-usage", () => ({
  getAiUsageSummary: mocks.getAiUsageSummary,
}));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError } }));

import { GET } from "../route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
});

describe("GET /api/admin/ai-assistant/usage", () => {
  it("rejects an unauthenticated caller via the admin guard", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    const res = await GET(new Request("http://localhost/api/admin/ai-assistant/usage"));
    expect(res.status).toBe(401);
    expect(mocks.getAiUsageSummary).not.toHaveBeenCalled();
  });

  it("returns the usage summary for an admin", async () => {
    mocks.getAiUsageSummary.mockResolvedValue({
      budget: { limitCents: 1000, warningThresholds: [0.7, 0.85, 0.95] },
      month: { month: "2026-07", costCents: 12 },
    });
    const res = await GET(new Request("http://localhost/api/admin/ai-assistant/usage"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.budget.limitCents).toBe(1000);
  });

  it("returns 500 when the summary fails to load", async () => {
    mocks.getAiUsageSummary.mockRejectedValue(new Error("db down"));
    const res = await GET(new Request("http://localhost/api/admin/ai-assistant/usage"));
    expect(res.status).toBe(500);
    expect(mocks.loggerError).toHaveBeenCalled();
  });
});
