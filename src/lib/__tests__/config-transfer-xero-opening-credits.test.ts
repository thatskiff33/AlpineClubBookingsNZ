/**
 * THE CONFIG IMPORT HOLDS OPENING CREDITS TO THE MAPPING SCREEN'S RULES (#4988).
 * An imported bundle writes the same `XeroAccountMapping` rows the account
 * mapping screen saves, so its plan applies the same two checks:
 *
 * - Opening Credits on a Xero account another mapped role uses is a blocking
 *   error, in the guard's own sentence (owner decision, 21 Nov 2026: refuse);
 * - Opening Credits set or changed on a club that is, or is scheduled to be,
 *   GST-registered with no Exempt mapping is a warning, never a refusal.
 *
 * The real exporter builds each bundle and the real planner reads it; only the
 * database is a double. The frozen clock's club today is 2026-07-01.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland" }));

import { buildConfigExport } from "@/lib/config-transfer/export";
import { buildImportPlan } from "@/lib/config-transfer/import";
import type { ImportMode, ReadDb } from "@/lib/config-transfer/import-types";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

type AccountRow = { key: string; code: string | null; itemCode: string | null };
const account = (key: string, code: string | null): AccountRow => ({ key, code, itemCode: null });

const TENANT = "tenant-connected";
const UNREGISTERED_PERIOD = {
  id: "unregistered",
  gstRegistered: false,
  taxRateBasisPoints: 0,
  xeroTaxType: null,
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
};

/** A database double: the stored account mappings, the tax schedule's later rows and the Exempt mapping. */
function db(options: {
  accounts: AccountRow[];
  laterTaxPeriods?: unknown[];
  exemptMappedIn?: string | null;
}): ReadDb {
  return {
    xeroAccountMapping: {
      findMany: vi.fn().mockResolvedValue(options.accounts.map((row, index) => ({ id: `xam-${index}`, ...row }))),
    },
    xeroItemCodeMapping: { findMany: vi.fn().mockResolvedValue([]) },
    membershipType: { findMany: vi.fn().mockResolvedValue([]) },
    xeroConnection: { findUnique: vi.fn().mockResolvedValue({ tenantId: TENANT, expiresAt: new Date() }) },
    // No stored baseline row: the club is registered since 2010 unless a later period says otherwise.
    clubTaxSettings: { findMany: vi.fn().mockResolvedValue(options.laterTaxPeriods ?? []) },
    xeroTaxCategoryMapping: {
      findMany: vi.fn().mockResolvedValue(
        options.exemptMappedIn ? [{ category: "EXEMPT", taxType: "EXEMPTCODE", xeroTenantId: options.exemptMappedIn }] : [],
      ),
    },
  } as unknown as ReadDb;
}

/** Plan the import of a bundle carrying `bundle` into a club that stores `target`. */
async function plan(bundle: AccountRow[], target: ReadDb, mode: ImportMode = "merge") {
  const { zip } = await buildConfigExport({
    db: db({ accounts: bundle }),
    categories: ["xero-config"],
    includeDoorCodes: false,
    appVersion: "0.10.1",
    prismaMigration: null,
    generatedAt: "2026-07-01T00:00:00.000Z",
  });
  const result = await buildImportPlan(target, zip, { format: CLUB_FORMAT_TEST, mode });
  const xero = result.categories.find((category) => category.category === "xero-config")!;
  return { errors: result.errors, warnings: xero.warnings };
}

const SHARED =
  "xero-config/account-mappings.csv: Opening Credits cannot use the same Xero account as Hut Fee Refunds. Choose an account for Opening Credits that no other mapping uses, or change the other mapping first. No account mapping was saved.";

describe("an imported Opening Credits account never shares its Xero account with another role (#4988)", () => {
  it("MUTATION: blocks a bundle whose own rows put Opening Credits on another role's account", async () => {
    const { errors } = await plan(
      [account("hutFeesIncome", "201"), account("hutFeeRefunds", "2100"), account("openingCredits", "2100")],
      db({ accounts: [], exemptMappedIn: TENANT }),
    );
    expect(errors).toEqual([SHARED]);
  });

  it("MUTATION: overlays the bundle on what the club stores: a stored role already uses the imported account", async () => {
    const { errors } = await plan(
      [account("openingCredits", "2100")],
      db({ accounts: [account("hutFeesIncome", "201"), account("hutFeeRefunds", "2100")], exemptMappedIn: TENANT }),
    );
    expect(errors).toEqual([SHARED]);
  });

  it("blocks a bundle that moves another role onto the stored Opening Credits account", async () => {
    const { errors } = await plan(
      [account("hutFeeRefunds", "2100")],
      db({
        accounts: [account("hutFeesIncome", "201"), account("hutFeeRefunds", "202"), account("openingCredits", "2100")],
        exemptMappedIn: TENANT,
      }),
    );
    expect(errors).toEqual([SHARED]);
  });

  it("follows the import mode: a blank cell leaves the stored code in merge mode, and clears it in overwrite mode", async () => {
    // The bundle carries a blank Hut Fee Refunds code beside Opening Credits on 2100.
    const bundle = [account("hutFeeRefunds", null), account("openingCredits", "2100")];
    const stored = () =>
      db({ accounts: [account("hutFeesIncome", "201"), account("hutFeeRefunds", "2100")], exemptMappedIn: TENANT });
    // Merge keeps the stored 2100 on Hut Fee Refunds: shared.
    expect((await plan(bundle, stored(), "merge")).errors).toEqual([SHARED]);
    // Overwrite clears it to its default (200): no longer shared.
    expect((await plan(bundle, stored(), "overwrite")).errors).toEqual([]);
  });

  it("allows Opening Credits on an account no other role uses, and never reports the key against itself", async () => {
    const { errors, warnings } = await plan(
      [account("hutFeesIncome", "201"), account("hutFeeRefunds", "202"), account("openingCredits", "2100")],
      db({ accounts: [account("openingCredits", "2100")], exemptMappedIn: TENANT }),
    );
    expect(errors).toEqual([]);
    expect(warnings.join(" ")).not.toMatch(/Opening Credits/);
  });
});

describe("an imported Opening Credits account on a GST-registered club with no Exempt mapping (#4988)", () => {
  const bundle = [account("hutFeesIncome", "201"), account("hutFeeRefunds", "202"), account("openingCredits", "2100")];
  const WARNING =
    "Opening Credits needs the Exempt tax category. The club is, or is scheduled to be, GST-registered: map the Exempt tax category on the Xero setup screen first. The import still sets the account; until Exempt is mapped, spent opening credits wait in the Xero queue. On a card booking, the booking's Xero invoice operation fails instead; retry it from the Xero Operations list once Exempt is mapped.";

  it("MUTATION: warns, and does not block, telling the officer to map Exempt", async () => {
    const { errors, warnings } = await plan(bundle, db({ accounts: [] }));
    expect(errors).toEqual([]);
    expect(warnings).toContain(WARNING);
  });

  it("warns when the only Exempt mapping was chosen in another Xero organisation", async () => {
    const { warnings } = await plan(bundle, db({ accounts: [], exemptMappedIn: "tenant-before" }));
    expect(warnings).toContain(WARNING);
  });

  it("says nothing once Exempt is mapped in the connected organisation", async () => {
    const { warnings } = await plan(bundle, db({ accounts: [], exemptMappedIn: TENANT }));
    expect(warnings.join(" ")).not.toMatch(/Exempt/);
  });

  it("says nothing for a club that is not registered now or later", async () => {
    const { warnings } = await plan(bundle, db({ accounts: [], laterTaxPeriods: [UNREGISTERED_PERIOD] }));
    expect(warnings.join(" ")).not.toMatch(/Exempt/);
  });

  it("says nothing when the bundle leaves the stored Opening Credits account as it is, and reads no tax setting", async () => {
    const target = db({ accounts: [account("openingCredits", "2100")] });
    const { warnings } = await plan(bundle, target);
    expect(warnings.join(" ")).not.toMatch(/Exempt/);
    expect((target as unknown as { clubTaxSettings: { findMany: ReturnType<typeof vi.fn> } }).clubTaxSettings.findMany).not.toHaveBeenCalled();
  });
});
