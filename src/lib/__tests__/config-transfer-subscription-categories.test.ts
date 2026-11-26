import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, strToU8 } from "fflate";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { buildConfigExport } from "@/lib/config-transfer/export";
import { readBundle } from "@/lib/config-transfer/bundle";
import {
  lockAffectedSubscriptionCategoryFeeSchedules,
  subscriptionCategoriesImporter,
} from "@/lib/config-transfer/categories/subscription-categories";
import type { ReadDb, TxDb } from "@/lib/config-transfer/import-types";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

// #5248: Export & Import carries subscription categories and their fee
// schedules. Round trip, idempotent re-import, the post-merge checks the admin
// API would otherwise make, and the guarantee that member assignments and
// issued charges are never touched.

const CATEGORIES_FILE = "membership-fees/subscription-categories.csv";
const FEES_FILE = "membership-fees/subscription-category-fees.csv";
const COMPONENTS_FILE = "membership-fees/subscription-category-fee-components.csv";

type CategoryRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isBuiltIn: boolean;
  sortOrder: number;
};
type FeeRow = {
  id: string;
  subscriptionCategoryId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  amountCents: number;
  prorationRule: string;
};
type ComponentRow = {
  id: string;
  subscriptionCategoryFeeId: string;
  label: string;
  amountCents: number;
  prorate: boolean;
  xeroAccountCode: string | null;
  xeroItemCode: string | null;
  sortOrder: number;
};

function d(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

const BUILT_IN: CategoryRow = {
  id: "cat-individual",
  key: "individual",
  name: "Individual",
  description: null,
  isActive: true,
  isBuiltIn: true,
  sortOrder: 0,
};

function makeStore(seed?: { categories?: CategoryRow[]; fees?: FeeRow[]; components?: ComponentRow[] }) {
  const categories: CategoryRow[] = [...(seed?.categories ?? [BUILT_IN])];
  const fees: FeeRow[] = [...(seed?.fees ?? [])];
  const components: ComponentRow[] = [...(seed?.components ?? [])];
  // Any write to member assignments or issued charges is a defect here.
  const forbidden = vi.fn(() => {
    throw new Error("config transfer must not touch member data or charges");
  });
  let seq = 0;

  const db = {
    // The other membership-fees modules carry nothing in these tests.
    ageTierSetting: { findMany: async () => [] },
    membershipType: { findMany: async () => [] },
    joiningFee: { findMany: async () => [] },
    membershipAnnualFee: { findMany: async () => [] },
    mediaImage: { findMany: async () => [] },
    subscriptionCategory: {
      findMany: async (args?: { where?: { key?: { in: string[] } } }) =>
        categories
          .filter((c) => !args?.where?.key || args.where.key.in.includes(c.key))
          .map((c) => ({
            ...c,
            fees: fees
              .filter((f) => f.subscriptionCategoryId === c.id)
              .map((f) => ({
                ...f,
                components: components.filter((x) => x.subscriptionCategoryFeeId === f.id).map((x) => ({ ...x })),
              })),
          })),
      create: async ({ data }: { data: Omit<CategoryRow, "id"> }) => {
        const id = `cat-new-${(seq += 1)}`;
        categories.push({ id, ...data });
        return { id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<CategoryRow> }) => {
        Object.assign(categories.find((c) => c.id === where.id)!, data);
        return {};
      },
    },
    subscriptionCategoryFee: {
      create: async ({ data }: { data: Omit<FeeRow, "id"> }) => {
        const id = `fee-new-${(seq += 1)}`;
        fees.push({ id, ...data });
        return { id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FeeRow> }) => {
        Object.assign(fees.find((f) => f.id === where.id)!, data);
        return {};
      },
    },
    subscriptionCategoryFeeComponent: {
      create: async ({ data }: { data: Omit<ComponentRow, "id"> }) => {
        const id = `comp-new-${(seq += 1)}`;
        components.push({ id, ...data });
        return { id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<ComponentRow> }) => {
        Object.assign(components.find((c) => c.id === where.id)!, data);
        return {};
      },
    },
    seasonalMembershipAssignment: { update: forbidden, updateMany: forbidden, create: forbidden, upsert: forbidden },
    membershipSubscriptionCharge: { update: forbidden, updateMany: forbidden, create: forbidden, deleteMany: forbidden },
  };
  return { db, categories, fees, components, forbidden };
}

/** A source install: a built-in, two club categories, one with a closed and an open fee. */
function sourceStore() {
  return makeStore({
    categories: [
      BUILT_IN,
      { id: "src-couple", key: "COUPLE", name: "Couple", description: "Two adults", isActive: true, isBuiltIn: false, sortOrder: 1 },
      { id: "src-old", key: "OLD_FAMILY", name: "Old Family", description: null, isActive: false, isBuiltIn: false, sortOrder: 2 },
    ],
    fees: [
      { id: "src-f1", subscriptionCategoryId: "src-couple", effectiveFrom: d("2025-04-01"), effectiveTo: d("2026-03-31"), amountCents: 30000, prorationRule: "NONE" },
      { id: "src-f2", subscriptionCategoryId: "src-couple", effectiveFrom: d("2026-04-01"), effectiveTo: null, amountCents: 32000, prorationRule: "REMAINING_MONTHS_INCLUSIVE" },
    ],
    components: [
      { id: "src-c1", subscriptionCategoryFeeId: "src-f1", label: "Subscription fee", amountCents: 30000, prorate: true, xeroAccountCode: "200", xeroItemCode: null, sortOrder: 0 },
      { id: "src-c2", subscriptionCategoryFeeId: "src-f2", label: "Subscription fee", amountCents: 28000, prorate: true, xeroAccountCode: "200", xeroItemCode: "SUB", sortOrder: 0 },
      { id: "src-c3", subscriptionCategoryFeeId: "src-f2", label: "Hut levy", amountCents: 4000, prorate: false, xeroAccountCode: "210", xeroItemCode: null, sortOrder: 1 },
    ],
  });
}

async function exportFiles(db: unknown) {
  const result = await buildConfigExport({
    db: db as ReadDb,
    categories: ["membership-fees"],
    includeDoorCodes: false,
    appVersion: "0.14.1",
    prismaMigration: null,
    generatedAt: "2026-07-01T00:00:00.000Z",
  });
  return readBundle(result.zip).files;
}

function planCtx(files: Map<string, Uint8Array>, db: unknown, mode: "merge" | "overwrite" = "merge") {
  return {
    db: db as ReadDb,
    files,
    manifest: {} as never,
    format: CLUB_FORMAT_TEST,
    mode,
    resolutions: new Map<string, string>(),
  };
}

function applyCtx(files: Map<string, Uint8Array>, tx: unknown, mode: "merge" | "overwrite" = "merge") {
  return {
    tx: tx as TxDb,
    files,
    manifest: {} as never,
    format: CLUB_FORMAT_TEST,
    mode,
    resolutions: new Map<string, string>(),
    actorMemberId: "admin-1",
    imageRemap: new Map<string, string>(),
    notes: { doorCodesWritten: [] as string[] },
  };
}

function csv(lines: string[]): Uint8Array {
  return strToU8(`${lines.join("\r\n")}\r\n`);
}

async function planErrors(files: Map<string, Uint8Array>, db: unknown, mode: "merge" | "overwrite" = "merge") {
  return (await subscriptionCategoriesImporter.plan(planCtx(files, db, mode))).errors;
}

describe("config transfer — subscription categories (#5248)", () => {
  it("exports the club's categories and fee schedules, never the built-in row", async () => {
    const files = await exportFiles(sourceStore().db);

    const categories = strFromU8(files.get(CATEGORIES_FILE)!);
    expect(categories).toContain("COUPLE,Couple,Two adults,true,1");
    expect(categories).toContain("OLD_FAMILY,Old Family,,false,2");
    expect(categories).not.toContain("individual");
    expect(strFromU8(files.get(FEES_FILE)!)).toContain("COUPLE,2026-04-01,,32000,REMAINING_MONTHS_INCLUSIVE");
    expect(strFromU8(files.get(COMPONENTS_FILE)!)).toContain("COUPLE,2026-04-01,Hut levy,4000,false,210,,1");
  });

  it("emits nothing for an install with only the built-in category", async () => {
    const files = await exportFiles(makeStore().db);
    expect(files.has(CATEGORIES_FILE)).toBe(false);
    expect(files.has(FEES_FILE)).toBe(false);
  });

  it("round-trips into a fresh install, and a second import changes and duplicates nothing", async () => {
    const files = await exportFiles(sourceStore().db);
    const target = makeStore();

    const plan = await subscriptionCategoriesImporter.plan(planCtx(files, target.db));
    expect(plan.errors).toEqual([]);
    expect(plan.items.every((item) => item.action === "create")).toBe(true);
    const first = await subscriptionCategoriesImporter.apply(applyCtx(files, target.db));
    expect(first).toMatchObject({ created: 7, updated: 0 });

    // The target now exports byte-for-byte what the source did.
    const reExported = await exportFiles(target.db);
    for (const file of [CATEGORIES_FILE, FEES_FILE, COMPONENTS_FILE]) {
      expect(strFromU8(reExported.get(file)!)).toBe(strFromU8(files.get(file)!));
    }

    const counts = () => [target.categories.length, target.fees.length, target.components.length];
    const before = counts();
    const replan = await subscriptionCategoriesImporter.plan(planCtx(files, target.db));
    expect(replan.items.every((item) => item.action === "unchanged")).toBe(true);
    const second = await subscriptionCategoriesImporter.apply(applyCtx(files, target.db));
    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 7 });
    expect(counts()).toEqual(before);
    expect(target.forbidden).not.toHaveBeenCalled();
  });

  it("updates an existing category and fee in place by key, never touching charges or assignments", async () => {
    const files = await exportFiles(sourceStore().db);
    const target = makeStore({
      categories: [
        BUILT_IN,
        { id: "tgt-couple", key: "COUPLE", name: "Couple", description: null, isActive: true, isBuiltIn: false, sortOrder: 1 },
      ],
      fees: [
        // An invoiced fee on the target with a different amount and one component.
        { id: "tgt-f2", subscriptionCategoryId: "tgt-couple", effectiveFrom: d("2026-04-01"), effectiveTo: null, amountCents: 32000, prorationRule: "NONE" },
      ],
      components: [
        { id: "tgt-c1", subscriptionCategoryFeeId: "tgt-f2", label: "Subscription fee", amountCents: 28000, prorate: true, xeroAccountCode: "200", xeroItemCode: "SUB", sortOrder: 0 },
        { id: "tgt-c2", subscriptionCategoryFeeId: "tgt-f2", label: "Hut levy", amountCents: 4000, prorate: false, xeroAccountCode: "210", xeroItemCode: null, sortOrder: 1 },
      ],
    });

    expect(await planErrors(files, target.db)).toEqual([]);
    await subscriptionCategoriesImporter.apply(applyCtx(files, target.db));

    expect(target.categories.find((c) => c.key === "COUPLE")).toMatchObject({ id: "tgt-couple", description: "Two adults" });
    expect(target.fees.find((f) => f.id === "tgt-f2")).toMatchObject({ prorationRule: "REMAINING_MONTHS_INCLUSIVE" });
    expect(target.fees.filter((f) => f.subscriptionCategoryId === "tgt-couple")).toHaveLength(2);
    expect(target.forbidden).not.toHaveBeenCalled();
  });

  it("changes nothing and reads nothing when the bundle carries none of the files", async () => {
    const findMany = vi.fn();
    const db = { subscriptionCategory: { findMany } };
    const plan = await subscriptionCategoriesImporter.plan(planCtx(new Map(), db));
    const result = await subscriptionCategoriesImporter.apply(applyCtx(new Map(), db));
    expect(plan.items).toEqual([]);
    expect(result).toMatchObject({ created: 0, updated: 0, unchanged: 0 });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("refuses a row that targets the built-in Individual category", async () => {
    const files = new Map([
      [CATEGORIES_FILE, csv(["key,name,description,isActive,sortOrder", "individual,Individual,,true,0"])],
    ]);
    expect((await planErrors(files, makeStore().db)).join("\n")).toMatch(/built-in Individual/);
  });

  it.each(["couple", "Old-Family", "_COUPLE", "COUPLE__TWO", "A".repeat(81)])(
    "refuses a new category key %s that the Subscription Categories page could not create",
    async (key) => {
      const files = new Map([
        [CATEGORIES_FILE, csv(["key,name,description,isActive,sortOrder", `${key},Couple,,true,0`])],
      ]);
      expect((await planErrors(files, makeStore().db)).join("\n")).toMatch(/not a valid new category key/);
    },
  );

  it("accepts an existing target key as-is, even one the page would not mint today", async () => {
    const target = makeStore({
      categories: [
        BUILT_IN,
        { id: "tgt-legacy", key: "legacy-pair", name: "Pair", description: null, isActive: true, isBuiltIn: false, sortOrder: 0 },
      ],
    });
    const files = new Map([
      [CATEGORIES_FILE, csv(["key,name,description,isActive,sortOrder", "legacy-pair,Pair,Renamed note,true,0"])],
    ]);
    expect(await planErrors(files, target.db)).toEqual([]);
  });

  it("refuses a name another key already uses on the target, case-insensitively", async () => {
    const target = makeStore({
      categories: [
        BUILT_IN,
        { id: "tgt-pair", key: "PAIR", name: "Couple", description: null, isActive: true, isBuiltIn: false, sortOrder: 0 },
      ],
    });
    const files = new Map([
      [CATEGORIES_FILE, csv(["key,name,description,isActive,sortOrder", "COUPLE,COUPLE,,true,0"])],
    ]);
    expect((await planErrors(files, target.db)).join("\n")).toMatch(/already uses/);
  });

  it("refuses a fee whose category is unknown", async () => {
    const files = new Map([
      [FEES_FILE, csv(["categoryKey,effectiveFrom,effectiveTo,amountCents,prorationRule", "nope,2026-04-01,,100,NONE"])],
      [COMPONENTS_FILE, csv(["categoryKey,effectiveFrom,label,amountCents,prorate,xeroAccountCode,xeroItemCode,sortOrder", "nope,2026-04-01,Fee,100,true,,,0"])],
    ]);
    expect((await planErrors(files, makeStore().db)).join("\n")).toMatch(/neither in .* nor on the target/);
  });

  it("refuses components that do not sum to the fee amount in the bundle", async () => {
    const files = new Map([
      [CATEGORIES_FILE, csv(["key,name,description,isActive,sortOrder", "COUPLE,Couple,,true,0"])],
      [FEES_FILE, csv(["categoryKey,effectiveFrom,effectiveTo,amountCents,prorationRule", "COUPLE,2026-04-01,,30000,NONE"])],
      [COMPONENTS_FILE, csv(["categoryKey,effectiveFrom,label,amountCents,prorate,xeroAccountCode,xeroItemCode,sortOrder", "COUPLE,2026-04-01,Fee,25000,true,,,0"])],
    ]);
    expect((await planErrors(files, makeStore().db)).join("\n")).toMatch(/must sum to the fee amount/);
  });

  it("refuses a fee whose components would not sum after merging with the target's leftovers", async () => {
    // The target's fee has an extra component the bundle does not carry; an
    // upsert-only import would leave it in place and over-bill.
    const target = makeStore({
      categories: [BUILT_IN, { id: "tgt-couple", key: "COUPLE", name: "Couple", description: null, isActive: true, isBuiltIn: false, sortOrder: 0 }],
      fees: [{ id: "tgt-f", subscriptionCategoryId: "tgt-couple", effectiveFrom: d("2026-04-01"), effectiveTo: null, amountCents: 30000, prorationRule: "NONE" }],
      components: [
        { id: "tgt-c1", subscriptionCategoryFeeId: "tgt-f", label: "Fee", amountCents: 25000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 },
        { id: "tgt-c2", subscriptionCategoryFeeId: "tgt-f", label: "Old levy", amountCents: 5000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 1 },
      ],
    });
    const files = new Map([
      [FEES_FILE, csv(["categoryKey,effectiveFrom,effectiveTo,amountCents,prorationRule", "COUPLE,2026-04-01,,30000,NONE"])],
      [COMPONENTS_FILE, csv(["categoryKey,effectiveFrom,label,amountCents,prorate,xeroAccountCode,xeroItemCode,sortOrder", "COUPLE,2026-04-01,Fee,30000,true,,,0"])],
    ]);
    expect((await planErrors(files, target.db)).join("\n")).toMatch(/after merging into the target's fee/);
  });

  it("refuses fee windows that would overlap after the merge", async () => {
    const target = makeStore({
      categories: [BUILT_IN, { id: "tgt-couple", key: "COUPLE", name: "Couple", description: null, isActive: true, isBuiltIn: false, sortOrder: 0 }],
      // An open-ended target fee from 2025; the bundle adds one from 2026.
      fees: [{ id: "tgt-f", subscriptionCategoryId: "tgt-couple", effectiveFrom: d("2025-04-01"), effectiveTo: null, amountCents: 30000, prorationRule: "NONE" }],
      components: [{ id: "tgt-c", subscriptionCategoryFeeId: "tgt-f", label: "Fee", amountCents: 30000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 }],
    });
    const files = new Map([
      [FEES_FILE, csv(["categoryKey,effectiveFrom,effectiveTo,amountCents,prorationRule", "COUPLE,2026-04-01,,32000,NONE"])],
      [COMPONENTS_FILE, csv(["categoryKey,effectiveFrom,label,amountCents,prorate,xeroAccountCode,xeroItemCode,sortOrder", "COUPLE,2026-04-01,Fee,32000,true,,,0"])],
    ]);
    expect((await planErrors(files, target.db)).join("\n")).toMatch(/overlapping fee windows 2025-04-01\.\.open and 2026-04-01\.\.open/);

    // Closing the earlier window in the same bundle resolves it.
    const closed = new Map([
      [FEES_FILE, csv([
        "categoryKey,effectiveFrom,effectiveTo,amountCents,prorationRule",
        "COUPLE,2025-04-01,2026-03-31,30000,NONE",
        "COUPLE,2026-04-01,,32000,NONE",
      ])],
      [COMPONENTS_FILE, csv([
        "categoryKey,effectiveFrom,label,amountCents,prorate,xeroAccountCode,xeroItemCode,sortOrder",
        "COUPLE,2025-04-01,Fee,30000,true,,,0",
        "COUPLE,2026-04-01,Fee,32000,true,,,0",
      ])],
    ]);
    expect(await planErrors(closed, target.db)).toEqual([]);
  });

  it("locks each existing category the fee rows touch, in id order, and no new ones", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const tx = {
      $executeRaw: executeRaw,
      subscriptionCategory: {
        findMany: vi.fn(async () => [{ id: "cat-b" }, { id: "cat-a" }]),
      },
    };
    const files = new Map([
      [FEES_FILE, csv(["categoryKey,effectiveFrom,effectiveTo,amountCents,prorationRule", "b,2026-04-01,,1,NONE", "a,2026-04-01,,1,NONE", "brand-new,2026-04-01,,1,NONE"])],
    ]);
    await lockAffectedSubscriptionCategoryFeeSchedules(tx as never, files);

    expect(tx.subscriptionCategory.findMany).toHaveBeenCalledWith({
      where: { key: { in: ["b", "a", "brand-new"] } },
      select: { id: true },
    });
    const keys = executeRaw.mock.calls.map((call) => call.slice(1).join(""));
    expect(keys).toEqual(["fee-schedule:subscriptionCategory:cat-a", "fee-schedule:subscriptionCategory:cat-b"]);
  });

  it("takes the fee-schedule locks after the config-import lock and before the in-lock re-plan", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/config-transfer/apply.ts"), "utf8");
    // The apply takes every category's keys through one helper, called after
    // the singleton and before the re-plan; in it the fee schedules come last.
    const applyFn = source.slice(source.indexOf("export async function applyConfigImport"));
    const configLock = applyFn.indexOf("await acquireConfigImportLock(tx)");
    const categoryKeys = applyFn.indexOf("await lockSelectedCategoryKeys(tx, parsed, params.selectedCategories)");
    const replan = applyFn.indexOf("const replan = await buildImportPlanFromParsed");
    expect(configLock).toBeGreaterThan(-1);
    expect(categoryKeys).toBeGreaterThan(configLock);
    expect(replan).toBeGreaterThan(categoryKeys);
    const keyHelper = source.slice(
      source.indexOf("async function lockSelectedCategoryKeys"),
      source.indexOf("export type BootstrapBackupSkip"),
    );
    const policyLocks = keyHelper.indexOf("await lockAdultMemberHostingPolicySet(tx)");
    const lodgeLocks = keyHelper.indexOf("await lockAffectedLodgeConfigLodges(tx, parsed.files)");
    const feeLocks = keyHelper.indexOf("await lockAffectedSubscriptionCategoryFeeSchedules(tx, parsed.files)");
    expect(policyLocks).toBeGreaterThan(-1);
    expect(lodgeLocks).toBeGreaterThan(policyLocks);
    expect(feeLocks).toBeGreaterThan(lodgeLocks);
  });
});
