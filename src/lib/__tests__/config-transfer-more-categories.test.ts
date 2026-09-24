import { describe, expect, it, vi } from "vitest";
import { strFromU8 } from "fflate";

vi.mock("server-only", () => ({}));

import { buildConfigExport } from "@/lib/config-transfer/export";
import { buildImportPlan } from "@/lib/config-transfer/import";
import { readBundle } from "@/lib/config-transfer/bundle";
import { parseCsv } from "@/lib/config-transfer/csv";
import type { ReadDb } from "@/lib/config-transfer/import-types";

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
    xeroToken: { findFirst: vi.fn().mockResolvedValue({ tenantId: "tenant-src" }) },
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
    xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
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
