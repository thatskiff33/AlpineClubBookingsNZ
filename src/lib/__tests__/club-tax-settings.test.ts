/** The D3 tax setting (#4626, Ledger M3a): defaults, treatment by date, and the stored-row reader. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLUB_TAX_SETTINGS_DEFAULTS,
  CLUB_TAX_SETTINGS_ID,
  ClubTaxTreatmentUnavailableError,
  MAX_TAX_RATE_BASIS_POINTS,
  clubTaxTreatmentOn,
  loadClubTaxSettings,
} from "@/lib/club-tax-settings";
import { requireCalendarDate } from "@/lib/club-time";

const MIGRATION = readFileSync("prisma/migrations/20261128050000_club_tax_settings/migration.sql", "utf8");
const day = requireCalendarDate;

describe("club tax settings", () => {
  it("defaults to today's treatment, and the migration's column defaults and CHECK agree", () => {
    expect(CLUB_TAX_SETTINGS_DEFAULTS).toEqual({ gstRegistered: true, taxRateBasisPoints: 1500, effectiveFrom: "2010-10-01" });
    expect(MIGRATION).toContain(`"gstRegistered" BOOLEAN NOT NULL DEFAULT ${CLUB_TAX_SETTINGS_DEFAULTS.gstRegistered}`);
    expect(MIGRATION).toContain(`"taxRateBasisPoints" INTEGER NOT NULL DEFAULT ${CLUB_TAX_SETTINGS_DEFAULTS.taxRateBasisPoints}`);
    expect(MIGRATION).toContain(`"effectiveFrom" DATE NOT NULL DEFAULT '${CLUB_TAX_SETTINGS_DEFAULTS.effectiveFrom}'::date`);
    expect(MIGRATION).toContain(`"id" TEXT NOT NULL DEFAULT '${CLUB_TAX_SETTINGS_ID}'`);
    expect(MIGRATION).toContain(`CHECK ("taxRateBasisPoints" BETWEEN 0 AND ${MAX_TAX_RATE_BASIS_POINTS})`);
  });

  it("gives the registered rate and its frozen code on and after the effective date", () => {
    expect(clubTaxTreatmentOn(CLUB_TAX_SETTINGS_DEFAULTS, day("2010-10-01")))
      .toEqual({ registered: true, rateBasisPoints: 1500, taxCode: "GST_INCLUSIVE_1500BP" });
    expect(clubTaxTreatmentOn({ ...CLUB_TAX_SETTINGS_DEFAULTS, taxRateBasisPoints: 1250 }, day("2026-07-01")))
      .toMatchObject({ rateBasisPoints: 1250, taxCode: "GST_INCLUSIVE_1250BP" });
  });

  it("gives no tax for a club that is not registered", () => {
    expect(clubTaxTreatmentOn({ ...CLUB_TAX_SETTINGS_DEFAULTS, gstRegistered: false }, day("2026-07-01"))).toEqual({ registered: false });
  });

  it("refuses a date before the setting starts: a split that cannot be derived is never guessed (D3)", () => {
    expect(() => clubTaxTreatmentOn(CLUB_TAX_SETTINGS_DEFAULTS, day("2010-09-30"))).toThrow(ClubTaxTreatmentUnavailableError);
  });

  it.each([-1, 10_001, 1500.5])("refuses a rate of %s basis points", (taxRateBasisPoints) => {
    expect(() => clubTaxTreatmentOn({ ...CLUB_TAX_SETTINGS_DEFAULTS, taxRateBasisPoints }, day("2026-07-01"))).toThrow(/basis points/);
  });

  it("reads the stored row, or the defaults when none is written", async () => {
    const db = (row: unknown) => ({ clubTaxSettings: { findUnique: async () => row } }) as unknown as Parameters<typeof loadClubTaxSettings>[0];
    expect(await loadClubTaxSettings(db(null))).toEqual(CLUB_TAX_SETTINGS_DEFAULTS);
    expect(await loadClubTaxSettings(db({ gstRegistered: false, taxRateBasisPoints: 0, effectiveFrom: new Date("2027-04-01T00:00:00.000Z") })))
      .toEqual({ gstRegistered: false, taxRateBasisPoints: 0, effectiveFrom: "2027-04-01" });
  });
});
