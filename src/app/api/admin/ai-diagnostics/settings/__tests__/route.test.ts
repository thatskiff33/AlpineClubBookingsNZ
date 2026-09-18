import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  settingsFindUnique: vi.fn(),
  settingsUpsert: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  buildAudit: vi.fn(),
  usageSummary: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: mocks.buildAudit,
  getAuditRequestContext: () => ({ id: null, ipAddress: "1.2.3.4", userAgent: "t" }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    diagnosticsSettings: {
      findUnique: mocks.settingsFindUnique,
      upsert: mocks.settingsUpsert,
    },
    auditLog: { create: mocks.auditCreate },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/ai-diagnostics-usage", async (importActual) => {
  const actual = (await importActual()) as typeof import("@/lib/ai-diagnostics-usage");
  return { ...actual, getDiagnosticsUsageSummary: mocks.usageSummary };
});

import { GET, PUT } from "../route";
import { DIAGNOSTICS_MAX_MONTHLY_BUDGET_CENTS } from "@/lib/ai-diagnostics-usage";

function makeReq(body: unknown, raw?: string) {
  return new Request("https://club.example.com/api/admin/ai-diagnostics/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  mocks.buildAudit.mockReturnValue({ data: {} });
  mocks.usageSummary.mockResolvedValue({ month: { settledCents: 0 } });
  mocks.settingsUpsert.mockResolvedValue({
    monthlyBudgetCents: 2000,
    updatedAt: new Date("2026-08-02T10:00:00.000Z"),
    updatedByMemberId: "admin-1",
  });
  mocks.auditCreate.mockResolvedValue("AUDIT_OP");
  mocks.transaction.mockImplementation(async (cb) =>
    cb({
      diagnosticsSettings: {
        findUnique: mocks.settingsFindUnique,
        upsert: mocks.settingsUpsert,
      },
      auditLog: { create: mocks.auditCreate },
    }),
  );
});

describe("GET /api/admin/ai-diagnostics/settings", () => {
  it("rejects a non-admin via the guard", async () => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("returns the NZ$0 default budget when no row is stored", async () => {
    mocks.settingsFindUnique.mockResolvedValue(null);
    const res = await GET();
    const json = await res.json();
    expect(json.monthlyBudgetCents).toBe(0);
    expect(json.maxMonthlyBudgetCents).toBe(DIAGNOSTICS_MAX_MONTHLY_BUDGET_CENTS);
    expect(json.updatedAt).toBeNull();
  });
});

describe("PUT /api/admin/ai-diagnostics/settings", () => {
  it("rejects a non-admin via the guard and writes nothing", async () => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
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

  it("accepts the max budget and rejects one cent over it (fat-finger guard)", async () => {
    const ok = await PUT(makeReq({ monthlyBudgetCents: DIAGNOSTICS_MAX_MONTHLY_BUDGET_CENTS }));
    expect(ok.status).toBe(200);
    const over = await PUT(makeReq({ monthlyBudgetCents: DIAGNOSTICS_MAX_MONTHLY_BUDGET_CENTS + 1 }));
    expect(over.status).toBe(400);
  });

  it("rejects a negative budget with 400 and writes nothing", async () => {
    const res = await PUT(makeReq({ monthlyBudgetCents: -1 }));
    expect(res.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects an unparseable body with 400", async () => {
    const res = await PUT(makeReq(undefined, "{ not json"));
    expect(res.status).toBe(400);
  });

  it("upserts + writes a DEDICATED structured audit action with previous/new cents", async () => {
    mocks.settingsFindUnique.mockResolvedValue({ monthlyBudgetCents: 0 });
    const res = await PUT(makeReq({ monthlyBudgetCents: 2000 }));
    expect(res.status).toBe(200);
    const auditArg = mocks.buildAudit.mock.calls[0][0];
    // Its OWN audit action — never the page-help one.
    expect(auditArg.action).toBe("AI_DIAGNOSTICS_SETTINGS_UPDATED");
    expect(auditArg.entity).toMatchObject({ type: "DiagnosticsSettings" });
    expect(auditArg.metadata).toMatchObject({
      previousMonthlyBudgetCents: 0,
      newMonthlyBudgetCents: 2000,
    });
  });
});
