/**
 * THE ONE WRITER of the club's tax category mappings (#5209): Xero must carry
 * the rate, read fresh before the transaction; the mapping records the
 * organisation it was chosen in; a reconnect between the read and the write is
 * refused; and every change writes its audit row in the same Serializable
 * transaction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_TAX_SETTINGS_DEFAULTS, type ClubTaxSchedule } from "@/lib/club-tax-settings";
import { requireCalendarDate } from "@/lib/club-time";
import type { XeroTaxRateOption } from "@/lib/xero-tax-rate-options";

const h = vi.hoisted(() => {
  const tx = {
    xeroConnection: { findUnique: vi.fn() },
    xeroTaxCategoryMapping: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    prisma: {
      xeroConnection: { findUnique: vi.fn() },
      // #4988: whether the Opening Credits account is mapped, and where Exempt was mapped, read before a clear of Exempt.
      xeroAccountMapping: { findUnique: vi.fn() },
      xeroTaxCategoryMapping: { findMany: vi.fn() },
      $transaction: vi.fn(async (callback: (client: unknown) => unknown, _options?: unknown) => callback(tx)),
    },
    readXeroTaxRates: vi.fn(),
    schedule: vi.fn(),
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/xero-tax-rates", () => ({ readXeroTaxRates: h.readXeroTaxRates }));
vi.mock("@/lib/xero-tax-anchors", () => import("./support/xero-tax-anchors-baseline"));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland" }));
vi.mock("@/lib/club-tax-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/club-tax-settings")),
  loadClubTaxSchedule: h.schedule,
}));

import { clearXeroTaxCategory, mapXeroTaxCategory } from "@/lib/xero-tax-category-write";
import { EXEMPT_CLEAR_REFUSED_WHILE_DISCONNECTED } from "@/lib/xero-opening-credits-exempt-guards";

const ACTOR = "member-full-admin";
const TENANT = "tenant-connected";
const request = new Request("https://club.example.com/api/admin/xero/tax-categories", { method: "PUT" });
const RATES: XeroTaxRateOption[] = [
  { taxType: "EXEMPTOUTPUT", name: "Exempt Income", rateBasisPoints: 0, active: true, revenue: true, expenses: false },
  { taxType: "OUTPUT2", name: "15% GST on Income", rateBasisPoints: 1500, active: true, revenue: true, expenses: false },
];
const connected = (tenantId: string | null) => (tenantId === null ? null : { tenantId, expiresAt: new Date() });
// The frozen clock's club today is 2026-07-01.
const REGISTERED: ClubTaxSchedule = [CLUB_TAX_SETTINGS_DEFAULTS];
const NOT_REGISTERED: ClubTaxSchedule = [
  CLUB_TAX_SETTINGS_DEFAULTS,
  { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: requireCalendarDate("2026-01-01") },
];
const REGISTERING_LATER: ClubTaxSchedule = [
  ...NOT_REGISTERED,
  { gstRegistered: true, taxRateBasisPoints: 1500, xeroTaxType: "OUTPUT2", effectiveFrom: requireCalendarDate("2026-10-01") },
];

function auditData(): Record<string, unknown> {
  expect(h.tx.auditLog.create).toHaveBeenCalledTimes(1);
  return (h.tx.auditLog.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.readXeroTaxRates.mockResolvedValue(RATES);
  h.prisma.xeroConnection.findUnique.mockResolvedValue(connected(TENANT));
  h.tx.xeroConnection.findUnique.mockResolvedValue(connected(TENANT));
  h.tx.xeroTaxCategoryMapping.findUnique.mockResolvedValue(null);
  h.prisma.xeroAccountMapping.findUnique.mockResolvedValue(null);
  h.prisma.xeroTaxCategoryMapping.findMany.mockResolvedValue([]);
  h.schedule.mockResolvedValue(REGISTERED);
});

describe("mapXeroTaxCategory", () => {
  it("saves the rate with the connected organisation and its audit row, Serializable, after a fresh Xero read", async () => {
    await expect(
      mapXeroTaxCategory({ category: "EXEMPT", taxType: " EXEMPTOUTPUT ", actingMemberId: ACTOR, request }),
    ).resolves.toEqual({ changed: true });
    expect(h.readXeroTaxRates).toHaveBeenCalledWith({ fresh: true });
    expect(h.tx.xeroTaxCategoryMapping.upsert).toHaveBeenCalledWith({
      where: { category: "EXEMPT" },
      create: { category: "EXEMPT", taxType: "EXEMPTOUTPUT", xeroTenantId: TENANT, updatedByMemberId: ACTOR },
      update: { taxType: "EXEMPTOUTPUT", xeroTenantId: TENANT, updatedByMemberId: ACTOR },
    });
    expect(h.prisma.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: "Serializable" });
    expect(auditData()).toMatchObject({ action: "XERO_TAX_CATEGORY_MAPPED", category: "admin", severity: "important" });
  });

  it("refuses a rate Xero does not carry for the category, before any transaction", async () => {
    const outcome = await mapXeroTaxCategory({ category: "EXEMPT", taxType: "OUTPUT2", actingMemberId: ACTOR, request });
    expect(outcome).toEqual({ refused: "xero-code", message: expect.stringMatching(/not 0%/) });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses when Xero cannot be read, or is not connected", async () => {
    h.readXeroTaxRates.mockRejectedValue(new Error("down"));
    await expect(mapXeroTaxCategory({ category: "EXEMPT", taxType: "EXEMPTOUTPUT", actingMemberId: ACTOR, request }))
      .resolves.toEqual({ refused: "xero-unreadable" });
    h.prisma.xeroConnection.findUnique.mockResolvedValue(null);
    await expect(mapXeroTaxCategory({ category: "EXEMPT", taxType: "EXEMPTOUTPUT", actingMemberId: ACTOR, request }))
      .resolves.toEqual({ refused: "not-connected" });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses when Xero was reconnected to another organisation after the rates were read", async () => {
    h.tx.xeroConnection.findUnique.mockResolvedValue(connected("tenant-other"));
    await expect(mapXeroTaxCategory({ category: "EXEMPT", taxType: "EXEMPTOUTPUT", actingMemberId: ACTOR, request }))
      .resolves.toEqual({ refused: "not-connected" });
    expect(h.tx.xeroTaxCategoryMapping.upsert).not.toHaveBeenCalled();
    expect(h.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses an unchanged save, but re-saves the same code chosen in another organisation", async () => {
    h.tx.xeroTaxCategoryMapping.findUnique.mockResolvedValue({ taxType: "EXEMPTOUTPUT", xeroTenantId: TENANT });
    await expect(mapXeroTaxCategory({ category: "EXEMPT", taxType: "EXEMPTOUTPUT", actingMemberId: ACTOR, request }))
      .resolves.toEqual({ refused: "unchanged" });
    h.tx.xeroTaxCategoryMapping.findUnique.mockResolvedValue({ taxType: "EXEMPTOUTPUT", xeroTenantId: "tenant-before" });
    await expect(mapXeroTaxCategory({ category: "EXEMPT", taxType: "EXEMPTOUTPUT", actingMemberId: ACTOR, request }))
      .resolves.toEqual({ changed: true });
    expect(auditData()).toMatchObject({ metadata: expect.objectContaining({ tenantChanged: true }) });
  });
});

describe("clearXeroTaxCategory", () => {
  it("deletes the mapping with its audit row", async () => {
    h.tx.xeroTaxCategoryMapping.findUnique.mockResolvedValue({ taxType: "EXEMPTOUTPUT" });
    await expect(clearXeroTaxCategory({ category: "EXEMPT", actingMemberId: ACTOR, request })).resolves.toEqual({ changed: true });
    expect(h.tx.xeroTaxCategoryMapping.delete).toHaveBeenCalledWith({ where: { category: "EXEMPT" } });
    expect(auditData()).toMatchObject({ action: "XERO_TAX_CATEGORY_CLEARED", category: "admin" });
  });

  it("refuses a category that is not mapped", async () => {
    await expect(clearXeroTaxCategory({ category: "ZERO_RATED", actingMemberId: ACTOR, request }))
      .resolves.toEqual({ refused: "not-found" });
    expect(h.tx.auditLog.create).not.toHaveBeenCalled();
  });

  describe("Exempt while the Opening Credits account is mapped (#4988)", () => {
    const clearExempt = () => clearXeroTaxCategory({ category: "EXEMPT", actingMemberId: ACTOR, request });

    beforeEach(() => {
      h.tx.xeroTaxCategoryMapping.findUnique.mockResolvedValue({ taxType: "EXEMPTOUTPUT" });
      h.prisma.xeroAccountMapping.findUnique.mockResolvedValue({ code: "2100" });
      // Mapped in the organisation connected now, so lines are being sent with it.
      h.prisma.xeroTaxCategoryMapping.findMany.mockResolvedValue([
        { category: "EXEMPT", taxType: "EXEMPTOUTPUT", xeroTenantId: TENANT },
      ]);
    });

    it("MUTATION: clears a mapping chosen in another Xero organisation: it already reads as unmapped, so nothing is sent with it", async () => {
      h.prisma.xeroTaxCategoryMapping.findMany.mockResolvedValue([
        { category: "EXEMPT", taxType: "EXEMPTOUTPUT", xeroTenantId: "tenant-before" },
      ]);
      await expect(clearExempt()).resolves.toEqual({ changed: true });
      expect(h.tx.xeroTaxCategoryMapping.delete).toHaveBeenCalledWith({ where: { category: "EXEMPT" } });
    });

    it("MUTATION: refuses the clear for a GST-registered club, and says to unmap Opening Credits first", async () => {
      await expect(clearExempt()).resolves.toEqual({
        refused: "in-use",
        message: expect.stringMatching(/Unmap the Opening Credits account under Account Mappings first, then clear Exempt\.$/),
      });
      expect(h.prisma.xeroAccountMapping.findUnique).toHaveBeenCalledWith({
        where: { key: "openingCredits" },
        select: { code: true },
      });
      expect(h.tx.xeroTaxCategoryMapping.delete).not.toHaveBeenCalled();
      expect(h.tx.auditLog.create).not.toHaveBeenCalled();
    });

    it.each([
      ["GST-registered", REGISTERED],
      ["only scheduled to register", REGISTERING_LATER],
    ])(
      "MUTATION: refuses the clear while Xero is disconnected, for a club that is %s: the row would be missing on reconnecting the same organisation",
      async (_label, schedule) => {
        // Disconnecting deletes the connection row, so every stored mapping reads as "not this organisation's".
        h.prisma.xeroConnection.findUnique.mockResolvedValue(connected(null));
        h.schedule.mockResolvedValue(schedule);
        // Its own sentence: nothing is "in use" or "sent to Xero" while disconnected.
        await expect(clearExempt()).resolves.toEqual({
          refused: "in-use",
          message: EXEMPT_CLEAR_REFUSED_WHILE_DISCONNECTED,
        });
        expect(EXEMPT_CLEAR_REFUSED_WHILE_DISCONNECTED).toMatch(/^Xero is not connected/);
        expect(EXEMPT_CLEAR_REFUSED_WHILE_DISCONNECTED).not.toMatch(/is in use|is sent to Xero/);
        expect(h.tx.xeroTaxCategoryMapping.delete).not.toHaveBeenCalled();
        expect(h.tx.auditLog.create).not.toHaveBeenCalled();
      },
    );

    it("refuses it while a connection row names no organisation", async () => {
      h.prisma.xeroConnection.findUnique.mockResolvedValue({ tenantId: null, expiresAt: new Date() });
      await expect(clearExempt()).resolves.toEqual({
        refused: "in-use",
        message: EXEMPT_CLEAR_REFUSED_WHILE_DISCONNECTED,
      });
      expect(h.tx.xeroTaxCategoryMapping.delete).not.toHaveBeenCalled();
    });

    it("fails closed when the connection read throws: no clear, no transaction", async () => {
      h.prisma.xeroConnection.findUnique.mockRejectedValue(new Error("database unavailable"));
      await expect(clearExempt()).rejects.toThrow("database unavailable");
      expect(h.tx.xeroTaxCategoryMapping.delete).not.toHaveBeenCalled();
      expect(h.tx.auditLog.create).not.toHaveBeenCalled();
    });

    it("clears it while Xero is disconnected once Opening Credits is unmapped, or the club is not registered", async () => {
      h.prisma.xeroConnection.findUnique.mockResolvedValue(connected(null));
      h.prisma.xeroAccountMapping.findUnique.mockResolvedValue(null);
      await expect(clearExempt()).resolves.toEqual({ changed: true });
      h.prisma.xeroAccountMapping.findUnique.mockResolvedValue({ code: "2100" });
      h.schedule.mockResolvedValue(NOT_REGISTERED);
      await expect(clearExempt()).resolves.toEqual({ changed: true });
    });

    it("refuses it for a club that is only scheduled to register", async () => {
      h.schedule.mockResolvedValue(REGISTERING_LATER);
      await expect(clearExempt()).resolves.toMatchObject({ refused: "in-use" });
      expect(h.tx.xeroTaxCategoryMapping.delete).not.toHaveBeenCalled();
    });

    it("clears it for a club that is not registered: no line names a tax type there", async () => {
      h.schedule.mockResolvedValue(NOT_REGISTERED);
      await expect(clearExempt()).resolves.toEqual({ changed: true });
    });

    it.each([null, { code: null }, { code: "  " }])(
      "clears it once Opening Credits is unmapped (stored row %j)",
      async (row) => {
        h.prisma.xeroAccountMapping.findUnique.mockResolvedValue(row);
        await expect(clearExempt()).resolves.toEqual({ changed: true });
        expect(h.tx.xeroTaxCategoryMapping.delete).toHaveBeenCalledWith({ where: { category: "EXEMPT" } });
      },
    );

    it("holds only Exempt: another category clears, and the account mapping is not even read", async () => {
      await expect(clearXeroTaxCategory({ category: "ZERO_RATED", actingMemberId: ACTOR, request }))
        .resolves.toEqual({ changed: true });
      expect(h.prisma.xeroAccountMapping.findUnique).not.toHaveBeenCalled();
    });

    it("still answers not-found when Exempt was never mapped", async () => {
      h.tx.xeroTaxCategoryMapping.findUnique.mockResolvedValue(null);
      await expect(clearExempt()).resolves.toEqual({ refused: "not-found" });
    });
  });
});
