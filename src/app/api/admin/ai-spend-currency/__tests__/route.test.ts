import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  loadAiSpendCurrency: vi.fn(),
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
vi.mock("@/lib/ai-spend-currency-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/ai-spend-currency-settings")),
  loadAiSpendCurrency: mocks.loadAiSpendCurrency,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    aiSpendCurrencySettings: {
      findUnique: mocks.settingsFindUnique,
      upsert: mocks.settingsUpsert,
    },
    auditLog: { create: mocks.auditCreate },
    $transaction: mocks.transaction,
  },
}));

import { GET, PUT } from "../route";

const RATE_SET_AT = new Date("2026-06-15T00:00:00.000Z");

function unconfiguredAud() {
  return {
    clubCurrency: "AUD",
    isNzd: false,
    clubUnitsPerNzdMicros: 1_000_000,
    rateSetAt: null,
    rateSetByMemberId: null,
    isConfigured: false,
  };
}

function makeReq(body: unknown, raw?: string) {
  return new Request("https://club.example.com/api/admin/ai-spend-currency", {
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
  mocks.loadAiSpendCurrency.mockResolvedValue(unconfiguredAud());
  mocks.buildAudit.mockReturnValue({ data: {} });
  mocks.settingsFindUnique.mockResolvedValue(null);
  mocks.settingsUpsert.mockImplementation(async (args: { create: Record<string, unknown> }) => ({
    id: "default",
    clubUnitsPerNzdMicros: args.create.clubUnitsPerNzdMicros,
    rateSetAt: RATE_SET_AT,
    rateSetByMemberId: args.create.rateSetByMemberId,
  }));
  mocks.auditCreate.mockResolvedValue("AUDIT_OP");
  // Interactive-transaction form, as in the two budget routes: read the
  // previous value, upsert, and audit inside one callback with the same mocks.
  mocks.transaction.mockImplementation(async (cb) =>
    cb({
      aiSpendCurrencySettings: {
        findUnique: mocks.settingsFindUnique,
        upsert: mocks.settingsUpsert,
      },
      auditLog: { create: mocks.auditCreate },
    }),
  );
});

describe("GET /api/admin/ai-spend-currency", () => {
  it("rejects a non-admin via the guard", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await GET();
    expect(res.status).toBe(403);
    expect(mocks.loadAiSpendCurrency).not.toHaveBeenCalled();
  });

  it("returns the identity rate, flagged unconfigured, for a non-NZD club with no row", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      clubCurrency: "AUD",
      isNzd: false,
      isConfigured: false,
      clubUnitsPerNzdMicros: 1_000_000,
      clubUnitsPerNzd: "1.00",
      rateSetAt: null,
      rateSetByMemberId: null,
    });
  });

  it("returns the stored rate with when and by whom it was set", async () => {
    mocks.loadAiSpendCurrency.mockResolvedValue({
      clubCurrency: "AUD",
      isNzd: false,
      clubUnitsPerNzdMicros: 920_000,
      rateSetAt: RATE_SET_AT,
      rateSetByMemberId: "admin-9",
      isConfigured: true,
    });
    const json = await (await GET()).json();
    expect(json).toMatchObject({
      isConfigured: true,
      clubUnitsPerNzdMicros: 920_000,
      clubUnitsPerNzd: "0.92",
      rateSetAt: RATE_SET_AT.toISOString(),
      rateSetByMemberId: "admin-9",
    });
  });
});

describe("PUT /api/admin/ai-spend-currency", () => {
  it("rejects a non-admin via the guard and writes nothing", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await PUT(makeReq({ clubUnitsPerNzd: "0.92" }));
    expect(res.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("refuses to store a rate for an NZD club (nothing to convert)", async () => {
    mocks.loadAiSpendCurrency.mockResolvedValue({
      ...unconfiguredAud(),
      clubCurrency: "NZD",
      isNzd: true,
    });
    const res = await PUT(makeReq({ clubUnitsPerNzd: "0.92" }));
    expect(res.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects an unparseable body with 400", async () => {
    const res = await PUT(makeReq(undefined, "{ not json"));
    expect(res.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a numeric body — the decimal must arrive as typed", async () => {
    const res = await PUT(makeReq({ clubUnitsPerNzd: 0.92 }));
    expect(res.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each(["0", "-0.92", "$0.92", "0.9200001", "1001", "abc", ""])(
    "rejects %j with 400 and writes nothing",
    async (bad) => {
      const res = await PUT(makeReq({ clubUnitsPerNzd: bad }));
      expect(res.status).toBe(400);
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );

  it("stores the parsed micros with the acting admin and now, and audits previous/new", async () => {
    mocks.settingsFindUnique.mockResolvedValue({
      clubUnitsPerNzdMicros: 900_000,
      rateSetAt: new Date("2026-05-01T00:00:00.000Z"),
      rateSetByMemberId: "admin-old",
    });
    const res = await PUT(makeReq({ clubUnitsPerNzd: "0.92" }));
    expect(res.status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);

    const upsertArgs = mocks.settingsUpsert.mock.calls[0][0];
    expect(upsertArgs.where).toEqual({ id: "default" });
    expect(upsertArgs.create).toMatchObject({
      id: "default",
      clubUnitsPerNzdMicros: 920_000,
      rateSetByMemberId: "admin-1",
    });
    expect(upsertArgs.update).toMatchObject({
      clubUnitsPerNzdMicros: 920_000,
      rateSetByMemberId: "admin-1",
    });
    // The frozen test clock: "now" is the pinned instant, never a stopwatch.
    expect(upsertArgs.create.rateSetAt).toEqual(new Date("2026-07-01T00:00:00.000Z"));

    const auditArg = mocks.buildAudit.mock.calls[0][0];
    expect(auditArg.action).toBe("AI_SPEND_CURRENCY_RATE_UPDATED");
    expect(auditArg.category).toBe("admin");
    expect(auditArg.metadata).toMatchObject({
      clubCurrency: "AUD",
      previousClubUnitsPerNzdMicros: 900_000,
      newClubUnitsPerNzdMicros: 920_000,
    });

    const json = await res.json();
    expect(json).toMatchObject({
      isConfigured: true,
      clubUnitsPerNzdMicros: 920_000,
      clubUnitsPerNzd: "0.92",
      rateSetAt: RATE_SET_AT.toISOString(),
      rateSetByMemberId: "admin-1",
    });
  });

  it("audits a null previous rate when none was stored", async () => {
    mocks.settingsFindUnique.mockResolvedValue(null);
    const res = await PUT(makeReq({ clubUnitsPerNzd: "1.5" }));
    expect(res.status).toBe(200);
    expect(mocks.buildAudit.mock.calls[0][0].metadata).toMatchObject({
      previousClubUnitsPerNzdMicros: null,
      newClubUnitsPerNzdMicros: 1_500_000,
    });
  });
});
