/** The D3 tax setting (#4626, Ledger M3a) as a dated schedule (#4632): defaults, treatment by date, and the one reader. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLUB_TAX_SETTINGS_DEFAULTS,
  CLUB_TAX_SETTINGS_ID,
  ClubTaxTreatmentUnavailableError,
  DEFAULT_CLUB_TAX_SCHEDULE,
  MAX_TAX_RATE_BASIS_POINTS,
  clubTaxTreatmentOn,
  loadClubTaxSchedule,
  type ClubTaxPeriod,
} from "@/lib/club-tax-settings";
import { requireCalendarDate } from "@/lib/club-time";

const MIGRATION = readFileSync("prisma/migrations/20261128050000_club_tax_settings/migration.sql", "utf8");
const SCHEDULE_MIGRATION = readFileSync("prisma/migrations/20261212010000_club_tax_schedule/migration.sql", "utf8");
const day = requireCalendarDate;
const period = (overrides: Partial<ClubTaxPeriod>): ClubTaxPeriod => ({ ...CLUB_TAX_SETTINGS_DEFAULTS, ...overrides });
const unregistered = (effectiveFrom: string) => period({ gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: day(effectiveFrom) });

describe("club tax settings", () => {
  it("defaults to today's treatment, and the migrations' column defaults and CHECKs agree", () => {
    expect(CLUB_TAX_SETTINGS_DEFAULTS).toEqual({ gstRegistered: true, taxRateBasisPoints: 1500, xeroTaxType: "OUTPUT2", effectiveFrom: "2010-10-01" });
    expect(DEFAULT_CLUB_TAX_SCHEDULE).toEqual([CLUB_TAX_SETTINGS_DEFAULTS]);
    expect(MIGRATION).toContain(`"gstRegistered" BOOLEAN NOT NULL DEFAULT ${CLUB_TAX_SETTINGS_DEFAULTS.gstRegistered}`);
    expect(MIGRATION).toContain(`"taxRateBasisPoints" INTEGER NOT NULL DEFAULT ${CLUB_TAX_SETTINGS_DEFAULTS.taxRateBasisPoints}`);
    expect(MIGRATION).toContain(`"effectiveFrom" DATE NOT NULL DEFAULT '${CLUB_TAX_SETTINGS_DEFAULTS.effectiveFrom}'::date`);
    expect(MIGRATION).toContain(`"id" TEXT NOT NULL DEFAULT '${CLUB_TAX_SETTINGS_ID}'`);
    expect(MIGRATION).toContain(`CHECK ("taxRateBasisPoints" BETWEEN 0 AND ${MAX_TAX_RATE_BASIS_POINTS})`);
    expect(SCHEDULE_MIGRATION).toContain(`"xeroTaxType" TEXT DEFAULT '${CLUB_TAX_SETTINGS_DEFAULTS.xeroTaxType}'`);
  });

  it("gives the registered rate, its frozen code and its Xero code on and after the effective date", () => {
    expect(clubTaxTreatmentOn(DEFAULT_CLUB_TAX_SCHEDULE, day("2010-10-01")))
      .toEqual({ registered: true, rateBasisPoints: 1500, taxCode: "GST_INCLUSIVE_1500BP", xeroTaxType: "OUTPUT2" });
    expect(clubTaxTreatmentOn([period({ taxRateBasisPoints: 1250, xeroTaxType: "OUTPUT3" })], day("2026-07-01")))
      .toMatchObject({ rateBasisPoints: 1250, taxCode: "GST_INCLUSIVE_1250BP", xeroTaxType: "OUTPUT3" });
  });

  it("gives no tax for a club that is not registered", () => {
    expect(clubTaxTreatmentOn([unregistered("2010-10-01")], day("2026-07-01"))).toEqual({ registered: false });
  });

  it("picks the period in force on the date: the last one starting on or before it", () => {
    const schedule = [unregistered("2010-10-01"), period({ effectiveFrom: day("2026-08-01") }),
      period({ taxRateBasisPoints: 1250, xeroTaxType: "OUTPUT3", effectiveFrom: day("2027-04-01") })];
    expect(clubTaxTreatmentOn(schedule, day("2026-07-31"))).toEqual({ registered: false });
    expect(clubTaxTreatmentOn(schedule, day("2026-08-01"))).toMatchObject({ rateBasisPoints: 1500, xeroTaxType: "OUTPUT2" });
    expect(clubTaxTreatmentOn(schedule, day("2027-03-31"))).toMatchObject({ rateBasisPoints: 1500 });
    expect(clubTaxTreatmentOn(schedule, day("2027-04-01"))).toMatchObject({ rateBasisPoints: 1250, xeroTaxType: "OUTPUT3" });
  });

  it("refuses a date before the setting starts: a split that cannot be derived is never guessed (D3)", () => {
    expect(() => clubTaxTreatmentOn(DEFAULT_CLUB_TAX_SCHEDULE, day("2010-09-30"))).toThrow(ClubTaxTreatmentUnavailableError);
  });

  it.each([-1, 10_001, 1500.5])("refuses a rate of %s basis points", (taxRateBasisPoints) => {
    expect(() => clubTaxTreatmentOn([period({ taxRateBasisPoints })], day("2026-07-01"))).toThrow(/basis points/);
  });

  it("refuses a registered period with no Xero code, and an unregistered one with a code", () => {
    expect(() => clubTaxTreatmentOn([period({ xeroTaxType: " " })], day("2026-07-01"))).toThrow(/names no Xero tax type/);
    expect(() => clubTaxTreatmentOn([period({ gstRegistered: false })], day("2026-07-01"))).toThrow(/not registered but names/);
  });

  describe("the one reader", () => {
    const db = (rows: unknown[]) => ({ clubTaxSettings: { findMany: async () => rows } }) as unknown as Parameters<typeof loadClubTaxSchedule>[0];
    const row = (id: string, overrides: Record<string, unknown>) => ({ id, gstRegistered: true, taxRateBasisPoints: 1500, xeroTaxType: "OUTPUT2", ...overrides });

    it("reads the defaults when nothing is written", async () => {
      expect(await loadClubTaxSchedule(db([]))).toEqual([CLUB_TAX_SETTINGS_DEFAULTS]);
    });

    it("reads the stored baseline, then the scheduled periods in start order", async () => {
      expect(await loadClubTaxSchedule(db([
        row(CLUB_TAX_SETTINGS_ID, { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: new Date("2010-10-01T00:00:00.000Z") }),
        row("p1", { effectiveFrom: new Date("2027-04-01T00:00:00.000Z") }),
      ]))).toEqual([
        { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: "2010-10-01" },
        { gstRegistered: true, taxRateBasisPoints: 1500, xeroTaxType: "OUTPUT2", effectiveFrom: "2027-04-01" },
      ]);
    });

    it("keeps the code defaults as the baseline when only a scheduled period is written", async () => {
      expect(await loadClubTaxSchedule(db([row("p1", { gstRegistered: false, xeroTaxType: null, effectiveFrom: new Date("2027-04-01T00:00:00.000Z") })])))
        .toEqual([CLUB_TAX_SETTINGS_DEFAULTS, expect.objectContaining({ gstRegistered: false, effectiveFrom: "2027-04-01" })]);
    });

    it("refuses a scheduled period starting on or before the baseline", async () => {
      await expect(loadClubTaxSchedule(db([row("p1", { effectiveFrom: new Date("2010-10-01T00:00:00.000Z") })])))
        .rejects.toThrow(/on or before the baseline/);
    });

    it("refuses a stored row the CHECKs would not allow", async () => {
      await expect(loadClubTaxSchedule(db([row(CLUB_TAX_SETTINGS_ID, { gstRegistered: false, effectiveFrom: new Date("2010-10-01T00:00:00.000Z") })])))
        .rejects.toThrow(/not registered but names/);
    });
  });
});
