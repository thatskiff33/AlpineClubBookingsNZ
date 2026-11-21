/**
 * THE ONE WRITER of the club's tax treatment (#4632): future dates only, Xero
 * must carry the code, the baseline and started periods are never touched, an
 * unregistered period stores no code, and every change writes its audit row in
 * the same Serializable transaction. The frozen clock's club today is
 * 2026-07-01, so the earliest change date is 2026-07-02.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireCalendarDate } from "@/lib/club-time";
import type { XeroTaxRateOption } from "@/lib/xero-tax-rate-options";

const h = vi.hoisted(() => {
  const tx = {
    clubTaxSettings: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn(async (callback: (client: unknown) => unknown, _options?: unknown) => callback(tx)),
      // #4988: read before a registration is scheduled. Unmapped unless a case says otherwise.
      xeroAccountMapping: { findUnique: vi.fn() },
      xeroTaxCategoryMapping: { findMany: vi.fn() },
    },
    readXeroTaxRates: vi.fn(),
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland" }));
vi.mock("@/lib/xero-tax-rates", () => ({ readXeroTaxRates: h.readXeroTaxRates }));
vi.mock("@/lib/xero-tax-anchors", () => import("./support/xero-tax-anchors-baseline"));
vi.mock("@/lib/xero-connection", () => ({
  readXeroConnection: async () => ({ tenantId: "tenant-connected", expiresAt: new Date() }),
}));

import {
  cancelScheduledClubTaxChange,
  earliestClubTaxChangeDate,
  scheduleClubTaxChange,
  type ClubTaxChange,
} from "@/lib/club-tax-settings-write";

const ACTOR = "member-full-admin";
const request = new Request("https://club.example.com/api/admin/club-tax", { method: "PUT" });
const date = (value: string) => requireCalendarDate(value);
const instant = (value: string) => new Date(`${value}T00:00:00.000Z`);
const RATES: XeroTaxRateOption[] = [
  { taxType: "OUTPUT2", name: "15% GST on Income", rateBasisPoints: 1500, active: true, revenue: true, expenses: false },
  { taxType: "TAX009", name: "17% GST on Income", rateBasisPoints: 1700, active: true, revenue: true, expenses: false },
];
const row = (id: string, effectiveFrom: string, overrides: Record<string, unknown> = {}) => ({
  id,
  gstRegistered: true,
  taxRateBasisPoints: 1500,
  xeroTaxType: "OUTPUT2",
  effectiveFrom: instant(effectiveFrom),
  ...overrides,
});
const unregisteredChange = (effectiveFrom: string): ClubTaxChange => ({
  gstRegistered: false,
  taxRateBasisPoints: 1500,
  xeroTaxType: "OUTPUT2",
  effectiveFrom: date(effectiveFrom),
});

function schedule(...rows: ReturnType<typeof row>[]) {
  h.tx.clubTaxSettings.findMany.mockResolvedValue(rows);
}

function auditData(): Record<string, unknown> {
  expect(h.tx.auditLog.create).toHaveBeenCalledTimes(1);
  return (h.tx.auditLog.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.readXeroTaxRates.mockResolvedValue(RATES);
  h.prisma.xeroAccountMapping.findUnique.mockResolvedValue(null);
  h.prisma.xeroTaxCategoryMapping.findMany.mockResolvedValue([]);
  schedule();
});

describe("scheduleClubTaxChange", () => {
  it("starts tomorrow in club time at the earliest, and refuses today", async () => {
    await expect(earliestClubTaxChangeDate()).resolves.toBe("2026-07-02");
    await expect(
      scheduleClubTaxChange({ change: unregisteredChange("2026-07-01"), actingMemberId: ACTOR, request }),
    ).resolves.toEqual({ refused: "not-future", earliest: "2026-07-02" });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("stores an unregistered period with no rate and an explicit null code, plus its audit row, Serializable", async () => {
    const outcome = await scheduleClubTaxChange({ change: unregisteredChange("2026-07-02"), actingMemberId: ACTOR, request });
    expect(outcome).toEqual({
      changed: true,
      period: { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: "2026-07-02" },
    });
    // An unregistered period names no code, so Xero is not asked.
    expect(h.readXeroTaxRates).not.toHaveBeenCalled();
    const data = h.tx.clubTaxSettings.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ gstRegistered: false, taxRateBasisPoints: 0, updatedByMemberId: ACTOR });
    expect(data).toHaveProperty("xeroTaxType", null);
    expect(data.id).not.toBe("default");
    expect(data.effectiveFrom).toEqual(instant("2026-07-02"));
    expect(h.prisma.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: "Serializable" });
    expect(auditData()).toMatchObject({
      action: "CLUB_TAX_TREATMENT_SCHEDULED",
      category: "admin",
      severity: "important",
      entityType: "ClubTaxSettings",
      entityId: "2026-07-02",
    });
  });

  it("reads Xero fresh, before the transaction, and saves a code Xero carries at the period's rate", async () => {
    h.readXeroTaxRates.mockImplementation(async () => {
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
      return RATES;
    });
    const outcome = await scheduleClubTaxChange({
      change: { gstRegistered: true, taxRateBasisPoints: 1700, xeroTaxType: "TAX009", effectiveFrom: date("2026-08-01") },
      actingMemberId: ACTOR,
      request,
    });
    expect(outcome).toMatchObject({ changed: true });
    expect(h.readXeroTaxRates).toHaveBeenCalledWith({ fresh: true });
    expect(h.tx.clubTaxSettings.create.mock.calls[0][0].data).toMatchObject({ taxRateBasisPoints: 1700, xeroTaxType: "TAX009" });
  });

  it("refuses a code Xero does not carry at the period's rate, writing nothing", async () => {
    const outcome = await scheduleClubTaxChange({
      change: { gstRegistered: true, taxRateBasisPoints: 1700, xeroTaxType: "OUTPUT2", effectiveFrom: date("2026-08-01") },
      actingMemberId: ACTOR,
      request,
    });
    expect(outcome).toEqual({ refused: "xero-code", message: expect.stringMatching(/is 15%, not 17%/) });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("re-checks the date inside the transaction, so a Xero read that crosses club midnight cannot start a period today", async () => {
    // Club midnight in Auckland (NZST, UTC+12) falls at 12:00 UTC on the frozen day.
    h.readXeroTaxRates.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-07-01T12:00:01.000Z"));
      return RATES;
    });
    try {
      const outcome = await scheduleClubTaxChange({
        change: { gstRegistered: true, taxRateBasisPoints: 1700, xeroTaxType: "TAX009", effectiveFrom: date("2026-07-02") },
        actingMemberId: ACTOR,
        request,
      });
      expect(outcome).toEqual({ refused: "not-future", earliest: "2026-07-03" });
      expect(h.tx.clubTaxSettings.create).not.toHaveBeenCalled();
      expect(h.tx.auditLog.create).not.toHaveBeenCalled();
    } finally {
      vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
    }
  });

  it("refuses rather than guesses when Xero cannot be read", async () => {
    h.readXeroTaxRates.mockRejectedValue(new Error("not connected"));
    const outcome = await scheduleClubTaxChange({
      change: { gstRegistered: true, taxRateBasisPoints: 1700, xeroTaxType: "TAX009", effectiveFrom: date("2026-08-01") },
      actingMemberId: ACTOR,
      request,
    });
    expect(outcome).toEqual({ refused: "xero-unreadable" });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a second period on a date already scheduled", async () => {
    schedule(row("later", "2026-08-01", { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null }));
    await expect(
      scheduleClubTaxChange({
        change: { gstRegistered: true, taxRateBasisPoints: 1700, xeroTaxType: "TAX009", effectiveFrom: date("2026-08-01") },
        actingMemberId: ACTOR,
        request,
      }),
    ).resolves.toEqual({ refused: "already-scheduled" });
    expect(h.tx.clubTaxSettings.create).not.toHaveBeenCalled();
    expect(h.tx.auditLog.create).not.toHaveBeenCalled();
  });

  describe("a registration while the Opening Credits account is mapped (#4988, #5375 item 3)", () => {
    const EXEMPT_RATE: XeroTaxRateOption = {
      taxType: "EXEMPTCODE", name: "Exempt", rateBasisPoints: 0, active: true, revenue: true, expenses: true,
    };
    const register = () =>
      scheduleClubTaxChange({
        change: { gstRegistered: true, taxRateBasisPoints: 1500, xeroTaxType: "OUTPUT2", effectiveFrom: date("2026-08-01") },
        actingMemberId: ACTOR,
        request,
      });
    const mapExempt = () =>
      h.prisma.xeroTaxCategoryMapping.findMany.mockResolvedValue([
        { category: "EXEMPT", taxType: "EXEMPTCODE", xeroTenantId: "tenant-connected" },
      ]);

    beforeEach(() => {
      // An unregistered club, which could map Opening Credits with no Exempt mapping.
      schedule(row("unregistered", "2026-01-01", { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null }));
      h.prisma.xeroAccountMapping.findUnique.mockResolvedValue({ code: "2100" });
      h.readXeroTaxRates.mockResolvedValue([...RATES, EXEMPT_RATE]);
    });

    it("MUTATION: is refused while Exempt is not mapped, before any transaction, and says what to map", async () => {
      const outcome = await register();
      expect(outcome).toEqual({
        refused: "exempt-required",
        message:
          "The Opening Credits account is mapped, so once the club is GST-registered each spent opening credit is sent to Xero with the Exempt rate. The club is, or is scheduled to be, GST-registered: map the Exempt tax category on the Xero setup screen first. Nothing was saved.",
      });
      expect(h.prisma.xeroAccountMapping.findUnique).toHaveBeenCalledWith({
        where: { key: "openingCredits" },
        select: { code: true },
      });
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
    });

    it("is refused while Exempt is mapped to a rate Xero no longer carries at 0%", async () => {
      mapExempt();
      h.readXeroTaxRates.mockResolvedValue([...RATES, { ...EXEMPT_RATE, rateBasisPoints: 1500 }]);
      await expect(register()).resolves.toEqual({ refused: "exempt-required", message: expect.stringMatching(/is not 0%/) });
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
    });

    it("is scheduled once Exempt is mapped to a usable rate", async () => {
      mapExempt();
      await expect(register()).resolves.toMatchObject({ changed: true });
    });

    it("is scheduled, with no Exempt mapping, while Opening Credits is unmapped", async () => {
      h.prisma.xeroAccountMapping.findUnique.mockResolvedValue({ code: null });
      await expect(register()).resolves.toMatchObject({ changed: true });
      expect(h.prisma.xeroTaxCategoryMapping.findMany).not.toHaveBeenCalled();
    });

    it("does not ask when the change takes the club OUT of registration", async () => {
      schedule();
      await expect(
        scheduleClubTaxChange({ change: unregisteredChange("2026-08-01"), actingMemberId: ACTOR, request }),
      ).resolves.toMatchObject({ changed: true });
      expect(h.prisma.xeroAccountMapping.findUnique).not.toHaveBeenCalled();
    });
  });

  it("refuses a period repeating the one it would follow", async () => {
    await expect(
      scheduleClubTaxChange({
        change: { gstRegistered: true, taxRateBasisPoints: 1500, xeroTaxType: "OUTPUT2", effectiveFrom: date("2026-08-01") },
        actingMemberId: ACTOR,
        request,
      }),
    ).resolves.toEqual({ refused: "unchanged" });
    expect(h.tx.clubTaxSettings.create).not.toHaveBeenCalled();
  });
});

describe("cancelScheduledClubTaxChange", () => {
  it("deletes only the scheduled period, never the baseline, and audits it", async () => {
    schedule(row("default", "2010-10-01"), row("later", "2026-08-01", { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null }));
    const outcome = await cancelScheduledClubTaxChange({ effectiveFrom: date("2026-08-01"), actingMemberId: ACTOR, request });
    expect(outcome).toMatchObject({ changed: true, period: { effectiveFrom: "2026-08-01", gstRegistered: false } });
    expect(h.tx.clubTaxSettings.deleteMany).toHaveBeenCalledWith({
      where: { effectiveFrom: instant("2026-08-01"), id: { not: "default" } },
    });
    expect(auditData()).toMatchObject({ action: "CLUB_TAX_TREATMENT_SCHEDULE_CANCELLED", category: "admin", severity: "important" });
  });

  it("refuses the baseline's date even when it is in the future", async () => {
    schedule(row("default", "2026-09-01"));
    await expect(
      cancelScheduledClubTaxChange({ effectiveFrom: date("2026-09-01"), actingMemberId: ACTOR, request }),
    ).resolves.toEqual({ refused: "not-found" });
    expect(h.tx.clubTaxSettings.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses a period that has started, before opening a transaction", async () => {
    await expect(
      cancelScheduledClubTaxChange({ effectiveFrom: date("2026-07-01"), actingMemberId: ACTOR, request }),
    ).resolves.toEqual({ refused: "not-future", earliest: "2026-07-02" });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("answers not-found for a date with nothing scheduled", async () => {
    await expect(
      cancelScheduledClubTaxChange({ effectiveFrom: date("2026-08-01"), actingMemberId: ACTOR, request }),
    ).resolves.toEqual({ refused: "not-found" });
  });
});
