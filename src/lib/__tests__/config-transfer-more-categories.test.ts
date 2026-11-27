import { describe, expect, it, vi } from "vitest";
import { strFromU8 } from "fflate";

vi.mock("server-only", () => ({}));

import { buildConfigExport } from "@/lib/config-transfer/export";
import { buildImportPlan } from "@/lib/config-transfer/import";
import { readBundle } from "@/lib/config-transfer/bundle";
import { parseCsv } from "@/lib/config-transfer/csv";
import type { ReadDb } from "@/lib/config-transfer/import-types";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

function sourceDb(): ReadDb {
  return {
    committeeRole: {
      findMany: vi.fn().mockResolvedValue([
        { key: "president", name: "President", description: "Runs it", contactEmail: "p@x.nz", isActive: true, sortOrder: 1 },
      ]),
    },
    xeroAccountMapping: {
      findMany: vi.fn().mockResolvedValue([
        { key: "hutFeesIncome", code: "200", itemCode: null },
      ]),
    },
    // HUT_FEE item codes are keyed by membership type (#1930, E4): the row
    // carries membershipTypeId, and export resolves it to the type key.
    xeroItemCodeMapping: {
      findMany: vi.fn().mockResolvedValue([
        { category: "HUT_FEE", ageTier: "ADULT", seasonType: "WINTER", membershipTypeId: "mt-full", entranceFeeCategory: null, itemCode: "HUT-A", amountCents: null },
        // A frozen legacy isMember-keyed HUT_FEE row (membershipTypeId null) is
        // NOT exported.
        { category: "HUT_FEE", ageTier: "ADULT", seasonType: "WINTER", membershipTypeId: null, entranceFeeCategory: null, itemCode: "LEGACY", amountCents: null },
      ]),
    },
    membershipType: {
      findMany: vi.fn().mockResolvedValue([
        { id: "mt-full", key: "FULL" },
        { id: "mt-nonmember", key: "NON_MEMBER" },
      ]),
    },
    // Connected Xero org, stamped into xero-config/source.json by the exporter.
    xeroConnection: {
      findUnique: vi.fn().mockResolvedValue({ tenantId: "tenant-src", expiresAt: new Date() }),
    },
  } as unknown as ReadDb;
}

function emptyTargetDb(): ReadDb {
  return {
    committeeRole: { findMany: vi.fn().mockResolvedValue([]) },
    xeroAccountMapping: { findMany: vi.fn().mockResolvedValue([]) },
    xeroItemCodeMapping: { findMany: vi.fn().mockResolvedValue([]) },
    membershipType: {
      findMany: vi.fn().mockResolvedValue([
        { id: "mt-full", key: "FULL" },
        { id: "mt-nonmember", key: "NON_MEMBER" },
      ]),
    },
    xeroConnection: { findUnique: vi.fn().mockResolvedValue(null) },
  } as unknown as ReadDb;
}

async function exportCats() {
  return buildConfigExport({
    db: sourceDb(),
    categories: ["committee", "xero-config"],
    includeDoorCodes: false,
    appVersion: "0.10.1",
    prismaMigration: null,
    generatedAt: "2026-07-08T00:00:00.000Z",
  });
}

describe("config-transfer committee + xero-config", () => {
  it("exports committee roles (only) and xero mappings, with source org in a category file", async () => {
    const { zip } = await exportCats();
    const { manifest, files } = readBundle(zip);
    expect(manifest.includedCategories).toEqual(
      expect.arrayContaining(["committee", "xero-config"]),
    );
    // The source Xero org lives in a category-local file, not the manifest.
    expect("sourceXeroTenantId" in manifest).toBe(false);
    const source = JSON.parse(strFromU8(files.get("xero-config/source.json")!)) as {
      tenantId: string | null;
    };
    expect(source.tenantId).toBe("tenant-src");

    const roles = parseCsv(strFromU8(files.get("committee/roles.csv")!));
    expect(roles.rows[0].key).toBe("president");
    // The legacy standalone committee members file is no longer exported.
    expect(files.get("committee/members.csv")).toBeUndefined();

    const accounts = parseCsv(strFromU8(files.get("xero-config/account-mappings.csv")!));
    expect(accounts.rows[0].key).toBe("hutFeesIncome");

    // Item codes re-key by membership type (#1930, E4): the HUT_FEE row carries
    // membershipTypeKey (not isMember) and the frozen legacy row is skipped.
    const items = parseCsv(strFromU8(files.get("xero-config/item-code-mappings.csv")!));
    expect(items.headers).toContain("membershipTypeKey");
    expect(items.headers).not.toContain("isMember");
    expect(items.rows).toHaveLength(1);
    expect(items.rows[0]).toMatchObject({
      category: "HUT_FEE",
      membershipTypeKey: "FULL",
      ageTier: "ADULT",
      seasonType: "WINTER",
      itemCode: "HUT-A",
    });
  });

  it("plans all-create against an empty target and warns on Xero", async () => {
    const { zip } = await exportCats();
    const plan = await buildImportPlan(emptyTargetDb(), zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    const committee = plan.categories.find((c) => c.category === "committee")!;
    const xero = plan.categories.find((c) => c.category === "xero-config")!;
    expect(committee.items.every((i) => i.action === "create")).toBe(true);
    expect(xero.items.every((i) => i.action === "create")).toBe(true);
    expect(xero.warnings.join(" ")).toMatch(/connected Xero org/i);
    // Source org (tenant-src) vs no connected target org → mismatch flagged.
    expect(plan.xero.sourceTenantId).toBe("tenant-src");
    expect(plan.xero.mismatch).toBe(true);
  });
});

/**
 * #5235 (owner decision, 22 Nov 2026): the import writes the rows the account
 * mapping screen saves, so its plan refuses a code the connected organisation's
 * stored chart shows is the wrong kind of account for its mapping. The real
 * exporter builds each bundle and the real planner reads it.
 */
describe("an imported account code is the kind of account its mapping accepts (#5235)", () => {
  type AccountRow = { key: string; code: string | null; itemCode: string | null };
  const account = (key: string, code: string | null): AccountRow => ({ key, code, itemCode: null });
  const CHART = [
    { code: "200", name: "Hut Fees", type: "REVENUE", class: "REVENUE" },
    { code: "090", name: "Club Cheque Account", type: "BANK", class: "ASSET" },
    { code: "429", name: "General Expenses", type: "OVERHEADS", class: "EXPENSE" },
  ];
  const NOT_EXPIRED = new Date("2026-07-01T00:30:00.000Z");
  const REFUSED =
    "xero-config/account-mappings.csv: Hut Fee Refunds needs a revenue or expense account, and the code chosen for it is an asset account in the connected Xero organisation.";

  function target(options: {
    accounts?: AccountRow[];
    tenantId?: string | null;
    chart?: { payload: unknown; expiresAt: Date } | null;
  }) {
    const tenantId = options.tenantId === undefined ? "tenant-here" : options.tenantId;
    const chartRead = vi
      .fn()
      .mockResolvedValue(options.chart === undefined ? { payload: CHART, expiresAt: NOT_EXPIRED } : options.chart);
    const db = {
      xeroAccountMapping: {
        findMany: vi.fn().mockResolvedValue((options.accounts ?? []).map((row, index) => ({ id: `xam-${index}`, ...row }))),
      },
      xeroItemCodeMapping: { findMany: vi.fn().mockResolvedValue([]) },
      membershipType: { findMany: vi.fn().mockResolvedValue([]) },
      xeroConnection: {
        findUnique: vi.fn().mockResolvedValue(tenantId ? { tenantId, expiresAt: new Date() } : null),
      },
      xeroAdminCache: { findUnique: chartRead },
    } as unknown as ReadDb;
    return { db, chartRead };
  }

  async function planErrors(bundle: AccountRow[], db: ReadDb, mode: "merge" | "overwrite" = "merge") {
    const { zip } = await buildConfigExport({
      db: target({ accounts: bundle }).db,
      categories: ["xero-config"],
      includeDoorCodes: false,
      appVersion: "0.10.1",
      prismaMigration: null,
      generatedAt: "2026-07-01T00:00:00.000Z",
    });
    return (await buildImportPlan(db, zip, { format: CLUB_FORMAT_TEST, mode })).errors;
  }

  it("MUTATION: blocks a bundle that puts Hut Fee Refunds on a bank account, naming the row", async () => {
    const { db, chartRead } = target({});
    expect(await planErrors([account("hutFeeRefunds", "090")], db)).toEqual([REFUSED]);
    // The chart is the connected organisation's, read through the plan's own client.
    expect(chartRead).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cacheKey_tenantId: { cacheKey: "chart-of-accounts", tenantId: "tenant-here" } },
      }),
    );
  });

  it("accepts Hut Fee Refunds on a revenue account and on an expense account", async () => {
    expect(await planErrors([account("hutFeeRefunds", "200")], target({}).db)).toEqual([]);
    expect(await planErrors([account("hutFeeRefunds", "429")], target({}).db)).toEqual([]);
  });

  it("still holds a one-class mapping to its class: an expense account is refused for Hut Fees Income", async () => {
    expect(await planErrors([account("hutFeesIncome", "429")], target({}).db)).toEqual([
      "xero-config/account-mappings.csv: Hut Fees Income needs a revenue account, and the code chosen for it is an expense account in the connected Xero organisation.",
    ]);
  });

  it("judges only a code the bundle sets or changes: a stored bank code it repeats, or leaves alone, passes", async () => {
    const stored = [account("hutFeeRefunds", "090")];
    // The bundle carries the code the club already stores.
    const repeated = target({ accounts: stored });
    expect(await planErrors([account("hutFeeRefunds", "090")], repeated.db)).toEqual([]);
    expect(repeated.chartRead).not.toHaveBeenCalled();
    // A blank cell in merge mode leaves the stored code as it is.
    expect(await planErrors([account("hutFeeRefunds", null)], target({ accounts: stored }).db)).toEqual([]);
  });

  it("allows what the chart cannot place: no connection, no stored chart, an expired one, or a code it does not list", async () => {
    const bundle = [account("hutFeeRefunds", "090")];
    const disconnected = target({ tenantId: null });
    expect(await planErrors(bundle, disconnected.db)).toEqual([]);
    expect(disconnected.chartRead).not.toHaveBeenCalled();
    expect(await planErrors(bundle, target({ chart: null }).db)).toEqual([]);
    // The frozen clock is 2026-07-01T00:00:00Z; this chart expired an hour before it.
    const expired = { payload: CHART, expiresAt: new Date("2026-06-30T23:00:00.000Z") };
    expect(await planErrors(bundle, target({ chart: expired }).db)).toEqual([]);
    expect(await planErrors([account("hutFeeRefunds", "777")], target({}).db)).toEqual([]);
  });
});
