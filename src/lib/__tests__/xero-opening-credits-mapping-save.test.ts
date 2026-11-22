/**
 * WHAT THE ACCOUNT MAPPING SCREEN REFUSES FOR OPENING CREDITS (#4988), through
 * the real `PUT /api/admin/xero/account-mappings` and the real rules behind it
 * (#5209's `openingCreditsAccountConflicts` and `exemptPrerequisiteProblem`):
 *
 * - Opening Credits never shares its Xero account with another mapped role
 *   (owner decision, 21 Nov 2026, recorded on PR #5150: refuse the save);
 * - a club that is, or is scheduled to be, GST-registered maps the Exempt tax
 *   category before it maps the account.
 *
 * Only Prisma, the session and Xero's tax-rate read are doubles. A refused save
 * writes nothing. The frozen clock's club today is 2026-07-01.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { CLUB_TAX_SETTINGS_DEFAULTS, type ClubTaxSchedule } from "@/lib/club-tax-settings";
import { requireCalendarDate } from "@/lib/club-time";

const h = vi.hoisted(() => {
  const state = {
    rows: [] as Array<{ key: string; code: string | null; itemCode: string | null }>,
    taxCategoryRows: [] as Array<{ category: string; taxType: string; xeroTenantId: string }>,
  };
  const upsert = vi.fn(
    async ({ where, update, create }: {
      where: { key: string };
      update: { code?: string | null; itemCode?: string | null };
      create: { key: string; code: string | null; itemCode: string | null };
    }) => {
      const existing = state.rows.find((row) => row.key === where.key);
      if (existing) Object.assign(existing, update);
      else state.rows.push({ ...create });
      return {};
    },
  );
  return {
    state,
    upsert,
    schedule: vi.fn(),
    readXeroTaxRates: vi.fn(),
    prisma: {
      xeroAccountMapping: { findMany: vi.fn(async () => state.rows.map((row) => ({ ...row }))), upsert },
      xeroTaxCategoryMapping: { findMany: vi.fn(async () => state.taxCategoryRows) },
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: async () => null,
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/xero-tax-anchors", () => import("./support/xero-tax-anchors-baseline"));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland" }));
vi.mock("@/lib/club-tax-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-tax-settings")),
  loadClubTaxSchedule: h.schedule,
}));
vi.mock("@/lib/xero-connection", () => ({
  readXeroConnection: async () => ({ tenantId: "tenant-1", expiresAt: new Date() }),
}));
vi.mock("@/lib/xero-tax-rates", () => ({ readXeroTaxRates: h.readXeroTaxRates }));

import { auth } from "@/lib/auth";
import { PUT } from "@/app/api/admin/xero/account-mappings/route";

const REGISTERED: ClubTaxSchedule = [CLUB_TAX_SETTINGS_DEFAULTS];
const NOT_REGISTERED: ClubTaxSchedule = [
  CLUB_TAX_SETTINGS_DEFAULTS,
  { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: requireCalendarDate("2026-01-01") },
];
const REGISTERING_LATER: ClubTaxSchedule = [
  ...NOT_REGISTERED,
  { gstRegistered: true, taxRateBasisPoints: 1500, xeroTaxType: "OUTPUT2", effectiveFrom: requireCalendarDate("2026-10-01") },
];

const exemptRate = (rateBasisPoints = 0) => ({
  taxType: "EXEMPTCODE",
  name: "Exempt",
  rateBasisPoints,
  active: true,
  revenue: true,
  expenses: true,
});

function mapExempt() {
  h.state.taxCategoryRows = [{ category: "EXEMPT", taxType: "EXEMPTCODE", xeroTenantId: "tenant-1" }];
}

function store(codes: Record<string, string | null>) {
  h.state.rows = Object.entries(codes).map(([key, code]) => ({ key, code, itemCode: null }));
}

async function save(body: unknown): Promise<{ status: number; error: string }> {
  const response = await PUT(
    new NextRequest("http://localhost/api/admin/xero/account-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const payload = (await response.json()) as { error?: string };
  return { status: response.status, error: payload.error ?? "" };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.rows = [];
  h.state.taxCategoryRows = [];
  h.schedule.mockResolvedValue(REGISTERED);
  h.readXeroTaxRates.mockReset();
  h.readXeroTaxRates.mockResolvedValue([exemptRate()]);
  vi.mocked(auth).mockResolvedValue({
    user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
  } as never);
});

describe("Opening Credits never shares its Xero account with another mapped role (#4988; owner, 21 Nov 2026)", () => {
  it("MUTATION: refuses Opening Credits on the account another role is mapped to, and names that role", async () => {
    store({ hutFeesIncome: "201", hutFeeRefunds: "2100" });
    mapExempt();

    const { status, error } = await save({ openingCredits: { code: "2100" } });

    expect(status).toBe(409);
    expect(error).toBe(
      "Opening Credits cannot use the same Xero account as Hut Fee Refunds. Choose an account for Opening Credits that no other mapping uses, or change the other mapping first. No account mapping was saved.",
    );
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("names every role on that account, one that only has its application default included", async () => {
    // No stored rows: Hut Fees Income and Hut Fee Refunds both sit on their default account.
    mapExempt();
    const { status, error } = await save({ openingCredits: { code: "200" } });
    expect(status).toBe(409);
    expect(error).toMatch(/the same Xero account as Hut Fees Income and Hut Fee Refunds\./);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("refuses another role being moved onto the Opening Credits account", async () => {
    store({ hutFeeRefunds: "202", openingCredits: "2100" });
    mapExempt();
    const { status, error } = await save({ hutFeeRefunds: { code: "2100" } });
    expect(status).toBe(409);
    expect(error).toMatch(/the same Xero account as Hut Fee Refunds\./);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("judges the codes as the whole save would leave them, so a swap in one save is allowed", async () => {
    store({ hutFeeRefunds: "2100" });
    mapExempt();
    const { status } = await save({ hutFeeRefunds: { code: "202" }, openingCredits: { code: "2100" } });
    expect(status).toBe(200);
  });

  it("never puts the account code in the message, where the screen would read a bare 403 as 'not permitted'", async () => {
    store({ stripeFees: "403" });
    mapExempt();
    const { status, error } = await save({ openingCredits: { code: "403" } });
    expect(status).toBe(409);
    expect(error).toMatch(/Stripe Fees/);
    expect(error).not.toMatch(/403/);
  });

  it("MUTATION: does not count the Opening Credits key as a conflict with itself", async () => {
    store({ hutFeesIncome: "201", hutFeeRefunds: "202" });
    mapExempt();
    // Mapped for the first time, on an account no other role uses.
    expect((await save({ openingCredits: { code: "2100" } })).status).toBe(200);
    expect(h.state.rows.find((row) => row.key === "openingCredits")?.code).toBe("2100");
    // Saved again unchanged, as the screen does on every save of any mapping.
    expect((await save({ openingCredits: { code: "2100" }, stripeFees: { code: "490" } })).status).toBe(200);
  });

  it("lets Opening Credits be unmapped whatever else is stored", async () => {
    store({ hutFeeRefunds: "2100", openingCredits: "2100" });
    expect((await save({ openingCredits: { code: null } })).status).toBe(200);
    expect(h.state.rows.find((row) => row.key === "openingCredits")?.code).toBeNull();
  });
});

describe("a GST-registered club maps Exempt before it maps Opening Credits (#4988, on #5209's rule)", () => {
  beforeEach(() => {
    store({ hutFeesIncome: "201", hutFeeRefunds: "202" });
  });

  it("MUTATION: refuses the account while the Exempt tax category is not mapped", async () => {
    const { status, error } = await save({ openingCredits: { code: "2100" } });
    expect(status).toBe(409);
    // Named, so an officer saving every mapping at once knows which one was refused.
    expect(error).toBe(
      "Opening Credits needs the Exempt tax category. The club is, or is scheduled to be, GST-registered: map the Exempt tax category on the Xero setup screen first. Nothing was saved.",
    );
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("MUTATION: 'Nothing was saved' is true: a refused save of several mappings writes none of them", async () => {
    const before = JSON.stringify(h.state.rows);
    const { status, error } = await save({
      hutFeesIncome: { code: "205" },
      stripeFees: { code: "490" },
      openingCredits: { code: "2100" },
    });
    expect(status).toBe(409);
    expect(error).toMatch(/^Opening Credits needs the Exempt tax category\. .* Nothing was saved\.$/);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(JSON.stringify(h.state.rows)).toBe(before);
  });

  it("holds a club that is only scheduled to register to the same rule", async () => {
    h.schedule.mockResolvedValue(REGISTERING_LATER);
    const { status, error } = await save({ openingCredits: { code: "2100" } });
    expect(status).toBe(409);
    expect(error).toMatch(/map the Exempt tax category/);
  });

  it("saves once Exempt is mapped to a rate Xero carries at 0%, checked against a fresh read", async () => {
    mapExempt();
    expect((await save({ openingCredits: { code: "2100" } })).status).toBe(200);
    expect(h.readXeroTaxRates).toHaveBeenCalledWith({ fresh: true });
  });

  it("refuses when the mapped rate is no longer 0% in Xero, or Xero's rates cannot be read", async () => {
    mapExempt();
    h.readXeroTaxRates.mockResolvedValue([exemptRate(1500)]);
    expect((await save({ openingCredits: { code: "2100" } })).error).toMatch(/is not 0%/);
    expect((await save({ openingCredits: { code: "2100" } })).status).toBe(409);
    h.readXeroTaxRates.mockRejectedValue(new Error("Xero is down"));
    const unreadable = await save({ openingCredits: { code: "2100" } });
    // Retryable, as the tax category route answers an unreadable rate list.
    expect(unreadable.status).toBe(503);
    expect(unreadable.error).toMatch(/could not be read/);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("asks nothing of a club that is not registered, and does not read Xero", async () => {
    h.schedule.mockResolvedValue(NOT_REGISTERED);
    expect((await save({ openingCredits: { code: "2100" } })).status).toBe(200);
    expect(h.readXeroTaxRates).not.toHaveBeenCalled();
  });

  it("asks only when the save sets or changes the account, so other mappings still save while Xero is down", async () => {
    store({ hutFeesIncome: "201", hutFeeRefunds: "202", openingCredits: "2100" });
    h.readXeroTaxRates.mockRejectedValue(new Error("Xero is down"));
    // The screen sends every key on every save; the Opening Credits code is unchanged.
    expect((await save({ openingCredits: { code: "2100" }, stripeFees: { code: "490" } })).status).toBe(200);
    expect(h.schedule).not.toHaveBeenCalled();
    // Changing it asks again.
    expect((await save({ openingCredits: { code: "2150" } })).status).toBe(409);
  });
});
