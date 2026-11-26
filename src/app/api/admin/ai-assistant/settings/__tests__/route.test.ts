import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  settingsFindUnique: vi.fn(),
  settingsUpsert: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  buildAudit: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: mocks.buildAudit,
  getAuditRequestContext: () => ({ id: null, ipAddress: "1.2.3.4", userAgent: "t" }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    aiAssistantSettings: {
      findUnique: mocks.settingsFindUnique,
      upsert: mocks.settingsUpsert,
    },
    auditLog: { create: mocks.auditCreate },
    $transaction: mocks.transaction,
  },
}));

import { GET, PUT } from "../route";

function makeReq(body: unknown, raw?: string) {
  return new Request("https://club.example.com/api/admin/ai-assistant/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mocks.buildAudit.mockReturnValue({ data: {} });
  mocks.settingsUpsert.mockResolvedValue({
    monthlyBudgetCents: 2000,
    updatedAt: new Date("2026-07-23T10:00:00.000Z"),
    updatedByMemberId: "admin-1",
  });
  mocks.auditCreate.mockResolvedValue("AUDIT_OP");
  // Interactive-transaction form: the route reads the previous value, upserts,
  // and audits inside one callback. Run it with a tx that reuses the same
  // delegate mocks so the read-then-write race fix is exercised.
  mocks.transaction.mockImplementation(async (cb) =>
    cb({
      aiAssistantSettings: {
        findUnique: mocks.settingsFindUnique,
        upsert: mocks.settingsUpsert,
      },
      auditLog: { create: mocks.auditCreate },
    }),
  );
});

describe("GET /api/admin/ai-assistant/settings", () => {
  it("rejects a non-admin via the guard", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await GET(new Request("http://localhost/api/admin/ai-assistant/settings"));
    expect(res.status).toBe(403);
  });

  it("returns the default budget when no row is stored", async () => {
    mocks.settingsFindUnique.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/api/admin/ai-assistant/settings"));
    const json = await res.json();
    expect(json).toEqual({
      monthlyBudgetCents: 1000,
      updatedAt: null,
      updatedByMemberId: null,
    });
  });

  it("returns the stored budget when a row exists", async () => {
    mocks.settingsFindUnique.mockResolvedValue({
      monthlyBudgetCents: 2500,
      updatedAt: new Date("2026-07-23T10:00:00.000Z"),
      updatedByMemberId: "admin-9",
    });
    const res = await GET(new Request("http://localhost/api/admin/ai-assistant/settings"));
    const json = await res.json();
    expect(json.monthlyBudgetCents).toBe(2500);
    expect(json.updatedByMemberId).toBe("admin-9");
  });
});

describe("PUT /api/admin/ai-assistant/settings", () => {
  it("rejects a non-admin via the guard and writes nothing", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await PUT(makeReq({ monthlyBudgetCents: 500 }));
    expect(res.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("accepts the boundary value 0 (hard-off)", async () => {
    mocks.settingsFindUnique.mockResolvedValue(null);
    const res = await PUT(makeReq({ monthlyBudgetCents: 0 }));
    expect(res.status).toBe(200);
    expect(mocks.settingsUpsert).toHaveBeenCalledTimes(1);
  });

  it("rejects 100001 (above the max) with 400 and writes nothing", async () => {
    const res = await PUT(makeReq({ monthlyBudgetCents: 100001 }));
    expect(res.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a negative budget with 400", async () => {
    const res = await PUT(makeReq({ monthlyBudgetCents: -1 }));
    expect(res.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects an unparseable body with 400", async () => {
    const res = await PUT(makeReq(undefined, "{ not json"));
    expect(res.status).toBe(400);
  });

  it("upserts + writes a structured audit log with previous/new cents", async () => {
    mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 1000 });
    const res = await PUT(makeReq({ monthlyBudgetCents: 2000 }));
    expect(res.status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    // audit args carry the before/after
    const auditArg = mocks.buildAudit.mock.calls[0][0];
    expect(auditArg.action).toBe("AI_ASSISTANT_SETTINGS_UPDATED");
    expect(auditArg.metadata).toMatchObject({
      previousMonthlyBudgetCents: 1000,
      newMonthlyBudgetCents: 2000,
    });
    const json = await res.json();
    expect(json.monthlyBudgetCents).toBe(2000);
  });
});
