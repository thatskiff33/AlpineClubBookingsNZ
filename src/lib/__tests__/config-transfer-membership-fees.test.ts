import { describe, expect, it, vi } from "vitest";
import { strToU8, strFromU8 } from "fflate";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { buildConfigExport } from "@/lib/config-transfer/export";
import { readBundle } from "@/lib/config-transfer/bundle";
import { membershipFeesImporter } from "@/lib/config-transfer/categories/membership-fees";
import { xeroConfigImporter } from "@/lib/config-transfer/categories/xero-config";
import type { ReadDb, TxDb } from "@/lib/config-transfer/import-types";

// Config-transfer membership-fees category (#1941): first-class transfer of the
// joining-fee schedule (#1931/E5) and the annual-fee schedule + components
// (#1932/E6). Money stays in integer cents; export ordering is byte-stable;
// apply is upsert-only; and a bundle carrying joining-fees.csv SUPERSEDES the
// #1931 item-code-amount joining-fee materialisation in xero-config.

// ---- In-memory store modelling the fee delegates the category touches -------

type TypeRow = { id: string; key: string };
type JoiningRow = {
  id: string;
  membershipTypeId: string;
  ageTier: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  amountCents: number;
};
type AnnualRow = {
  id: string;
  membershipTypeId: string;
  ageTier?: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  amountCents: number;
  billingBasis: string;
  prorationRule: string;
};
type ComponentRow = {
  id: string;
  membershipAnnualFeeId: string;
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

const DEFAULT_TYPES: TypeRow[] = [
  { id: "mt-full", key: "FULL" },
  { id: "mt-family", key: "FAMILY" },
  { id: "mt-school", key: "SCHOOL" },
];

function makeStore(seed?: {
  types?: TypeRow[];
  joiningFees?: JoiningRow[];
  annualFees?: AnnualRow[];
  components?: ComponentRow[];
}) {
  const types = seed?.types ?? DEFAULT_TYPES;
  const keyById = new Map(types.map((t) => [t.id, t.key]));
  const joiningFees: JoiningRow[] = [...(seed?.joiningFees ?? [])];
  const annualFees: AnnualRow[] = [...(seed?.annualFees ?? [])];
  const components: ComponentRow[] = [...(seed?.components ?? [])];
  let seq = 0;

  const withType = <T extends { membershipTypeId: string }>(row: T) => ({
    ...row,
    membershipType: { key: keyById.get(row.membershipTypeId)! },
  });
  const componentsOf = (feeId: string) =>
    components.filter((c) => c.membershipAnnualFeeId === feeId).map((c) => ({ ...c }));

  const db = {
    // #2200: the age-tier exporter/importer ride the membership-fees category as
    // a separate module. These fee tests carry no age tiers, so the delegate
    // returns none — age-tiers.csv is simply not emitted and the fee assertions
    // are unaffected.
    ageTierSetting: { findMany: async () => [] },
    membershipType: { findMany: async () => types.map((t) => ({ ...t })) },
    joiningFee: {
      findMany: async () => joiningFees.map(withType),
      create: async ({ data }: { data: Omit<JoiningRow, "id"> }) => {
        const id = `jf-${(seq += 1)}`;
        joiningFees.push({ id, ...data });
        return { id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<JoiningRow> }) => {
        Object.assign(joiningFees.find((x) => x.id === where.id)!, data);
        return {};
      },
    },
    membershipAnnualFee: {
      findMany: async () =>
        annualFees.map((f) => ({ ...withType(f), components: componentsOf(f.id) })),
      create: async ({ data }: { data: Omit<AnnualRow, "id"> }) => {
        const id = `af-${(seq += 1)}`;
        annualFees.push({ id, ...data });
        return { id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<AnnualRow> }) => {
        Object.assign(annualFees.find((x) => x.id === where.id)!, data);
        return {};
      },
    },
    membershipAnnualFeeComponent: {
      create: async ({ data }: { data: Omit<ComponentRow, "id"> }) => {
        const id = `c-${(seq += 1)}`;
        components.push({ id, ...data });
        return { id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<ComponentRow> }) => {
        Object.assign(components.find((x) => x.id === where.id)!, data);
        return {};
      },
    },
  };
  return { db, joiningFees, annualFees, components };
}

function applyCtx(
  files: Map<string, Uint8Array>,
  tx: TxDb,
  mode: "merge" | "overwrite" = "overwrite",
  selectedCategories: string[] = ["membership-fees", "xero-config"],
) {
  return {
    tx,
    files,
    manifest: {} as never,
    mode,
    resolutions: new Map<string, string>(),
    actorMemberId: "admin-1",
    imageRemap: new Map<string, string>(),
    notes: { doorCodesWritten: [] as string[] },
    selectedCategories,
  } as never;
}

function planCtx(
  files: Map<string, Uint8Array>,
  db: ReadDb,
  mode: "merge" | "overwrite" = "merge",
  selectedCategories: string[] = ["membership-fees", "xero-config"],
) {
  return {
    db,
    files,
    manifest: {} as never,
    mode,
    resolutions: new Map<string, string>(),
    selectedCategories,
  } as never;
}

// A fully-populated source install: joining fees (per-tier + a flat family fee),
// an invoiceable annual fee with two components, and a NO_INVOICE annual fee.
function seededSource() {
  return makeStore({
    joiningFees: [
      { id: "jf-a", membershipTypeId: "mt-full", ageTier: "ADULT", effectiveFrom: d("2026-01-01"), effectiveTo: null, amountCents: 10000 },
      { id: "jf-b", membershipTypeId: "mt-full", ageTier: "YOUTH", effectiveFrom: d("2026-01-01"), effectiveTo: null, amountCents: 5000 },
      { id: "jf-c", membershipTypeId: "mt-family", ageTier: null, effectiveFrom: d("2026-01-01"), effectiveTo: null, amountCents: 20000 },
    ],
    annualFees: [
      { id: "af-full", membershipTypeId: "mt-full", effectiveFrom: d("2026-01-01"), effectiveTo: null, amountCents: 12000, billingBasis: "PER_MEMBER", prorationRule: "REMAINING_MONTHS_INCLUSIVE" },
      { id: "af-school", membershipTypeId: "mt-school", effectiveFrom: d("2026-01-01"), effectiveTo: null, amountCents: 0, billingBasis: "NO_INVOICE", prorationRule: "NONE" },
    ],
    components: [
      { id: "cc-1", membershipAnnualFeeId: "af-full", label: "Annual membership fee", amountCents: 10000, prorate: true, xeroAccountCode: "200", xeroItemCode: "SUB", sortOrder: 0 },
      { id: "cc-2", membershipAnnualFeeId: "af-full", label: "FMC subscription", amountCents: 2000, prorate: false, xeroAccountCode: null, xeroItemCode: null, sortOrder: 1 },
    ],
  });
}

async function exportFees(db: ReadDb) {
  return buildConfigExport({
    db,
    categories: ["membership-fees"],
    includeDoorCodes: false,
    appVersion: "0.11.0",
    prismaMigration: null,
    generatedAt: "2026-07-17T00:00:00.000Z",
  });
}

const FEE_FILES = [
  "membership-fees/joining-fees.csv",
  "membership-fees/annual-fees.csv",
  "membership-fees/annual-fee-components.csv",
];

describe("config-transfer membership-fees round-trip (#1941)", () => {
  it("export → import into a fresh install reproduces the fee schedule byte-identically", async () => {
    const source = seededSource();
    const { zip } = await exportFees(source.db as unknown as ReadDb);
    const { files } = readBundle(zip);

    for (const f of FEE_FILES) expect(files.get(f)).toBeDefined();

    const target = makeStore();
    const first = await membershipFeesImporter.apply(applyCtx(files, target.db as unknown as TxDb));
    // 3 joining fees + 2 annual fees + 2 components = 7 creates.
    expect(first.created).toBe(7);
    expect(first.updated).toBe(0);
    expect(target.joiningFees).toHaveLength(3);
    expect(target.annualFees).toHaveLength(2);
    expect(target.components).toHaveLength(2);
    expect(target.joiningFees.find((r) => r.ageTier === "ADULT")?.amountCents).toBe(10000);
    expect(target.annualFees.find((r) => r.billingBasis === "NO_INVOICE")?.amountCents).toBe(0);

    const { zip: zip2 } = await exportFees(target.db as unknown as ReadDb);
    const files2 = readBundle(zip2).files;
    for (const f of FEE_FILES) {
      expect(strFromU8(files2.get(f)!)).toBe(strFromU8(files.get(f)!));
    }
  });

  it("re-applying the same bundle is idempotent (no duplicate rows, all unchanged)", async () => {
    const source = seededSource();
    const { files } = readBundle((await exportFees(source.db as unknown as ReadDb)).zip);
    const target = makeStore();
    await membershipFeesImporter.apply(applyCtx(files, target.db as unknown as TxDb));
    const second = await membershipFeesImporter.apply(applyCtx(files, target.db as unknown as TxDb));
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(7);
    expect(target.joiningFees).toHaveLength(3);
    expect(target.annualFees).toHaveLength(2);
    expect(target.components).toHaveLength(2);
  });

  it("plans all-create against a fresh install and blocks nothing", async () => {
    const source = seededSource();
    const { files } = readBundle((await exportFees(source.db as unknown as ReadDb)).zip);
    const target = makeStore();
    const plan = await membershipFeesImporter.plan(planCtx(files, target.db as unknown as ReadDb));
    expect(plan.errors).toEqual([]);
    expect(plan.items.every((i) => i.action === "create")).toBe(true);
    expect(plan.items.filter((i) => i.entity === "joining-fee")).toHaveLength(3);
    expect(plan.items.filter((i) => i.entity === "annual-fee")).toHaveLength(2);
    expect(plan.items.filter((i) => i.entity === "annual-fee-component")).toHaveLength(2);
  });
});

describe("config-transfer membership-fees per-age-tier (#2067)", () => {
  // A source with Adult + Youth annual fees (same type, same window) plus a flat
  // fallback, each with a single component summing to its own total.
  function perTierSource() {
    return makeStore({
      annualFees: [
        { id: "af-adult", membershipTypeId: "mt-full", ageTier: "ADULT", effectiveFrom: d("2026-01-01"), effectiveTo: null, amountCents: 15000, billingBasis: "PER_MEMBER", prorationRule: "NONE" },
        { id: "af-youth", membershipTypeId: "mt-full", ageTier: "YOUTH", effectiveFrom: d("2026-01-01"), effectiveTo: null, amountCents: 8000, billingBasis: "PER_MEMBER", prorationRule: "NONE" },
        { id: "af-flat", membershipTypeId: "mt-full", ageTier: null, effectiveFrom: d("2026-01-01"), effectiveTo: null, amountCents: 12000, billingBasis: "PER_MEMBER", prorationRule: "NONE" },
      ],
      components: [
        { id: "c-a", membershipAnnualFeeId: "af-adult", label: "Base", amountCents: 15000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 },
        { id: "c-y", membershipAnnualFeeId: "af-youth", label: "Base", amountCents: 8000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 },
        { id: "c-f", membershipAnnualFeeId: "af-flat", label: "Base", amountCents: 12000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 },
      ],
    });
  }

  it("round-trips per-tier annual fees, keeping each tier's amount and its own component", async () => {
    const source = perTierSource();
    const { zip } = await exportFees(source.db as unknown as ReadDb);
    const { files } = readBundle(zip);
    const target = makeStore();
    const result = await membershipFeesImporter.apply(applyCtx(files, target.db as unknown as TxDb));
    // 3 annual fees + 3 components.
    expect(result.created).toBe(6);
    expect(target.annualFees).toHaveLength(3);
    expect(target.annualFees.find((r) => r.ageTier === "ADULT")?.amountCents).toBe(15000);
    expect(target.annualFees.find((r) => r.ageTier === "YOUTH")?.amountCents).toBe(8000);
    expect(target.annualFees.find((r) => (r.ageTier ?? null) === null)?.amountCents).toBe(12000);
    // Byte-stable re-export.
    const { zip: zip2 } = await exportFees(target.db as unknown as ReadDb);
    const files2 = readBundle(zip2).files;
    for (const f of FEE_FILES) expect(strFromU8(files2.get(f)!)).toBe(strFromU8(files.get(f)!));
  });

  it("imports a pre-#2067 bundle (no ageTier column) as flat NULL-tier rows", async () => {
    // Old-format annual-fees.csv/annual-fee-components.csv: no ageTier column.
    const files = bundle({
      "membership-fees/annual-fees.csv": AF_HEADER + "FULL,2026-01-01,,12000,PER_MEMBER,NONE\n",
      "membership-fees/annual-fee-components.csv": AC_HEADER + "FULL,2026-01-01,Base,12000,true,,,0\n",
    });
    const target = makeStore();
    const plan = await membershipFeesImporter.plan(planCtx(files, target.db as unknown as ReadDb));
    expect(plan.errors).toEqual([]);
    await membershipFeesImporter.apply(applyCtx(files, target.db as unknown as TxDb));
    expect(target.annualFees).toHaveLength(1);
    expect(target.annualFees[0].ageTier ?? null).toBeNull();
    expect(target.annualFees[0].amountCents).toBe(12000);
  });

  it("blocks a per-family fee that carries an age tier (decision 1)", async () => {
    const files = bundle({
      "membership-fees/annual-fees.csv": AF_TIER_HEADER + "FAMILY,ADULT,2026-01-01,,20000,PER_FAMILY,NONE\n",
      "membership-fees/annual-fee-components.csv": AC_TIER_HEADER + "FAMILY,ADULT,2026-01-01,Base,20000,true,,,0\n",
    });
    const plan = await membershipFeesImporter.plan(planCtx(files, makeStore().db as unknown as ReadDb));
    expect(plan.errors.some((e) => /per-family fee must be flat/i.test(e))).toBe(true);
  });
});

// ---- Validation -------------------------------------------------------------

function bundle(rows: Record<string, string>): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const [path, text] of Object.entries(rows)) files.set(path, strToU8(text));
  return files;
}

const JF_HEADER = "membershipTypeKey,ageTier,effectiveFrom,effectiveTo,amountCents\n";
// Pre-#2067 annual-fee headers (no ageTier column) — exercise old-bundle back-compat.
const AF_HEADER = "membershipTypeKey,effectiveFrom,effectiveTo,amountCents,billingBasis,prorationRule\n";
const AC_HEADER =
  "membershipTypeKey,effectiveFrom,label,amountCents,prorate,xeroAccountCode,xeroItemCode,sortOrder\n";
// #2067 annual-fee headers with the ageTier column.
const AF_TIER_HEADER = "membershipTypeKey,ageTier,effectiveFrom,effectiveTo,amountCents,billingBasis,prorationRule\n";
const AC_TIER_HEADER =
  "membershipTypeKey,ageTier,effectiveFrom,label,amountCents,prorate,xeroAccountCode,xeroItemCode,sortOrder\n";

describe("config-transfer membership-fees validation (#1941)", () => {
  it("rejects an unknown membership type key", async () => {
    const files = bundle({
      "membership-fees/joining-fees.csv": JF_HEADER + "GHOST,ADULT,2026-01-01,,10000\n",
    });
    const plan = await membershipFeesImporter.plan(planCtx(files, makeStore().db as unknown as ReadDb));
    expect(plan.errors.join(" ")).toMatch(/unknown membership type "GHOST"/i);
    expect(plan.items).toHaveLength(0);
  });

  it("rejects a non-integer / negative amount (money stays integer cents)", async () => {
    const files = bundle({
      "membership-fees/joining-fees.csv":
        JF_HEADER + "FULL,ADULT,2026-01-01,,100.50\nFULL,YOUTH,2026-01-01,,-5\n",
    });
    const plan = await membershipFeesImporter.plan(planCtx(files, makeStore().db as unknown as ReadDb));
    expect(plan.errors.length).toBeGreaterThanOrEqual(2);
    expect(plan.errors.join(" ")).toMatch(/non-negative whole number of cents/i);
  });

  it("rejects components that do not sum to the fee amount", async () => {
    const files = bundle({
      "membership-fees/annual-fees.csv": AF_HEADER + "FULL,2026-01-01,,12000,PER_MEMBER,NONE\n",
      "membership-fees/annual-fee-components.csv": AC_HEADER + "FULL,2026-01-01,Base,10000,true,,,0\n",
    });
    const plan = await membershipFeesImporter.plan(planCtx(files, makeStore().db as unknown as ReadDb));
    expect(plan.errors.join(" ")).toMatch(/sum to \$100\.00 but the fee amount is \$120\.00/i);
  });

  it("rejects a NO_INVOICE fee that carries components, and a non-zero no-invoice amount", async () => {
    const withComp = bundle({
      "membership-fees/annual-fees.csv": AF_HEADER + "SCHOOL,2026-01-01,,0,NO_INVOICE,NONE\n",
      "membership-fees/annual-fee-components.csv": AC_HEADER + "SCHOOL,2026-01-01,X,0,true,,,0\n",
    });
    const p1 = await membershipFeesImporter.plan(planCtx(withComp, makeStore().db as unknown as ReadDb));
    expect(p1.errors.join(" ")).toMatch(/no-invoice annual fee .* must not carry components/i);

    const nonZero = bundle({
      "membership-fees/annual-fees.csv": AF_HEADER + "SCHOOL,2026-01-01,,500,NO_INVOICE,NONE\n",
    });
    const p2 = await membershipFeesImporter.plan(planCtx(nonZero, makeStore().db as unknown as ReadDb));
    expect(p2.errors.join(" ")).toMatch(/no-invoice annual fee .* must have amountCents 0/i);
  });

  it("rejects an invoiceable fee with no components, and orphan components", async () => {
    const noComps = bundle({
      "membership-fees/annual-fees.csv": AF_HEADER + "FULL,2026-01-01,,12000,PER_MEMBER,NONE\n",
    });
    const p1 = await membershipFeesImporter.plan(planCtx(noComps, makeStore().db as unknown as ReadDb));
    expect(p1.errors.join(" ")).toMatch(/must carry at least one component/i);

    const orphan = bundle({
      "membership-fees/annual-fee-components.csv": AC_HEADER + "FULL,2026-01-01,Base,10000,true,,,0\n",
    });
    const p2 = await membershipFeesImporter.plan(planCtx(orphan, makeStore().db as unknown as ReadDb));
    expect(p2.errors.join(" ")).toMatch(/not present in .*annual-fees\.csv/i);
  });
});

// ---- Merge-mode update path -------------------------------------------------

describe("config-transfer membership-fees apply (merge/update)", () => {
  it("updates an existing joining-fee amount in place (no duplicate)", async () => {
    const target = makeStore({
      joiningFees: [
        { id: "jf-x", membershipTypeId: "mt-full", ageTier: "ADULT", effectiveFrom: d("2026-01-01"), effectiveTo: null, amountCents: 8000 },
      ],
    });
    const files = bundle({
      "membership-fees/joining-fees.csv": JF_HEADER + "FULL,ADULT,2026-01-01,,10000\n",
    });
    const result = await membershipFeesImporter.apply(applyCtx(files, target.db as unknown as TxDb, "merge"));
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(target.joiningFees).toHaveLength(1);
    expect(target.joiningFees[0].amountCents).toBe(10000);
  });
});

// ---- Precedence over the #1931 item-code-amount materialisation -------------

function xeroTx(captures: { joiningFeeCreates: unknown[] }): TxDb {
  const noop = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    create: async () => ({ id: "x" }),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
  };
  const specific: Record<string, unknown> = {
    membershipType: {
      ...noop,
      findMany: async () => [
        { id: "mt-full", key: "FULL", bookingBehavior: "MEMBER_RATE", ageGroupsApply: true },
        { id: "mt-family", key: "FAMILY", bookingBehavior: "MEMBER_RATE", ageGroupsApply: true },
        { id: "mt-nonmember", key: "NON_MEMBER", bookingBehavior: "NON_MEMBER_RATE", ageGroupsApply: true },
      ],
    },
    joiningFee: {
      ...noop,
      create: async ({ data }: { data: unknown }) => {
        captures.joiningFeeCreates.push(data);
        return { id: `jf-${captures.joiningFeeCreates.length}` };
      },
    },
  };
  return new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => specific[prop as string] ?? noop,
  }) as unknown as TxDb;
}

// A current item-code bundle carrying JOINING_FEE amounts in the amountCents
// column (the input the #1931 item-code-amount fan-out consumes). Pre-#1931
// ENTRANCE_FEE bundles are rejected upstream since #2131.
const ITEM_CODES_WITH_AMOUNTS =
  "category,ageTier,seasonType,entranceFeeCategory,itemCode,amountCents\n" +
  "JOINING_FEE,,,ADULT,ENT-AD,10000\n" +
  "JOINING_FEE,,,FAMILY,ENT-FA,20000\n";

describe("config-transfer joining-fee precedence: #1941 supersedes #1931 (xero-config)", () => {
  it("bundle without joining-fees.csv STILL materialises item-code amounts (regression)", async () => {
    const captures = { joiningFeeCreates: [] as unknown[] };
    const files = bundle({ "xero-config/item-code-mappings.csv": ITEM_CODES_WITH_AMOUNTS });
    await xeroConfigImporter.apply(applyCtx(files, xeroTx(captures)));
    expect(captures.joiningFeeCreates.length).toBeGreaterThan(0);
  });

  it("bundle with joining-fees.csv does NOT run the item-code-amount materialisation", async () => {
    const captures = { joiningFeeCreates: [] as unknown[] };
    const files = bundle({
      "xero-config/item-code-mappings.csv": ITEM_CODES_WITH_AMOUNTS,
      "membership-fees/joining-fees.csv": JF_HEADER + "FULL,ADULT,2026-01-01,,12345\n",
    });
    await xeroConfigImporter.apply(applyCtx(files, xeroTx(captures)));
    expect(captures.joiningFeeCreates).toHaveLength(0);
  });

  it("bundle with joining-fees.csv STILL materialises item-code amounts when membership-fees is DESELECTED (regression, FIX-2)", async () => {
    const captures = { joiningFeeCreates: [] as unknown[] };
    const files = bundle({
      "xero-config/item-code-mappings.csv": ITEM_CODES_WITH_AMOUNTS,
      "membership-fees/joining-fees.csv": JF_HEADER + "FULL,ADULT,2026-01-01,,12345\n",
    });
    // Only xero-config selected → membership-fees importer never runs → the
    // item-code fan-out MUST still materialise or joining fees silently vanish.
    await xeroConfigImporter.apply(applyCtx(files, xeroTx(captures), "overwrite", ["xero-config"]));
    expect(captures.joiningFeeCreates.length).toBeGreaterThan(0);
  });

  it("plan: bundle with joining-fees.csv STILL previews materialisation when membership-fees deselected (FIX-2)", async () => {
    const captures = { joiningFeeCreates: [] as unknown[] };
    const files = bundle({
      "xero-config/item-code-mappings.csv": ITEM_CODES_WITH_AMOUNTS,
      "membership-fees/joining-fees.csv": JF_HEADER + "FULL,ADULT,2026-01-01,,12345\n",
    });
    const plan = await xeroConfigImporter.plan(
      planCtx(files, xeroTx(captures) as unknown as ReadDb, "merge", ["xero-config"]),
    );
    expect(plan.items.some((i) => i.entity === "joining-fee-window")).toBe(true);
  });

  it("plan: bundle with joining-fees.csv emits no joining-fee-window items or coverage fingerprint", async () => {
    const captures = { joiningFeeCreates: [] as unknown[] };
    const files = bundle({
      "xero-config/item-code-mappings.csv": ITEM_CODES_WITH_AMOUNTS,
      "membership-fees/joining-fees.csv": JF_HEADER + "FULL,ADULT,2026-01-01,,12345\n",
    });
    const plan = await xeroConfigImporter.plan(planCtx(files, xeroTx(captures) as unknown as ReadDb));
    expect(plan.items.some((i) => i.entity === "joining-fee-window")).toBe(false);
    expect(plan.fingerprintParts.some((p) => p.startsWith("joining-fee-coverage:"))).toBe(false);
  });
});

// ---- FIX-1 (#1941): post-merge Σ(components) invariant against target state --

describe("config-transfer membership-fees post-merge component invariant (#1941)", () => {
  function seededTarget() {
    return makeStore({
      annualFees: [
        { id: "af-full", membershipTypeId: "mt-full", effectiveFrom: d("2026-01-01"), effectiveTo: null, amountCents: 12000, billingBasis: "PER_MEMBER", prorationRule: "NONE" },
      ],
      components: [
        { id: "c-base", membershipAnnualFeeId: "af-full", label: "Base fee", amountCents: 10000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 },
        { id: "c-fmc", membershipAnnualFeeId: "af-full", label: "FMC", amountCents: 2000, prorate: false, xeroAccountCode: null, xeroItemCode: null, sortOrder: 1 },
      ],
    });
  }

  it("BLOCKS a bundle that renames a component label (would leave the old row and double-bill)", async () => {
    const target = seededTarget();
    const files = bundle({
      "membership-fees/annual-fees.csv": AF_HEADER + "FULL,2026-01-01,,12000,PER_MEMBER,NONE\n",
      "membership-fees/annual-fee-components.csv":
        AC_HEADER + "FULL,2026-01-01,Membership base fee,10000,true,,,0\nFULL,2026-01-01,FMC,2000,false,,,1\n",
    });
    const plan = await membershipFeesImporter.plan(planCtx(files, target.db as unknown as ReadDb, "overwrite"));
    expect(plan.errors.join(" ")).toMatch(/"Base fee"/);
    expect(plan.errors.join(" ")).toMatch(/\$220\.00 but the fee total is \$120\.00/);
    expect(plan.errors.join(" ")).toMatch(/Fees page/i);
  });

  it("passes a bundle that exactly matches the target's fee + components", async () => {
    const target = seededTarget();
    const files = bundle({
      "membership-fees/annual-fees.csv": AF_HEADER + "FULL,2026-01-01,,12000,PER_MEMBER,NONE\n",
      "membership-fees/annual-fee-components.csv":
        AC_HEADER + "FULL,2026-01-01,Base fee,10000,true,,,0\nFULL,2026-01-01,FMC,2000,false,,,1\n",
    });
    const plan = await membershipFeesImporter.plan(planCtx(files, target.db as unknown as ReadDb, "overwrite"));
    expect(plan.errors).toEqual([]);
  });

  it("passes when the bundle carries ALL existing labels (no orphan leftover) even as amounts move", async () => {
    const target = seededTarget();
    const files = bundle({
      "membership-fees/annual-fees.csv": AF_HEADER + "FULL,2026-01-01,,12000,PER_MEMBER,NONE\n",
      "membership-fees/annual-fee-components.csv":
        AC_HEADER + "FULL,2026-01-01,Base fee,11000,true,,,0\nFULL,2026-01-01,FMC,1000,false,,,1\n",
    });
    const plan = await membershipFeesImporter.plan(planCtx(files, target.db as unknown as ReadDb, "overwrite"));
    expect(plan.errors).toEqual([]);
  });

  it("BLOCKS turning an invoiceable fee with components into NO_INVOICE while leftovers remain", async () => {
    const target = seededTarget();
    const files = bundle({
      "membership-fees/annual-fees.csv": AF_HEADER + "FULL,2026-01-01,,0,NO_INVOICE,NONE\n",
    });
    const plan = await membershipFeesImporter.plan(planCtx(files, target.db as unknown as ReadDb, "overwrite"));
    expect(plan.errors.join(" ")).toMatch(/no-invoice annual fee .* would leave orphaned component/i);
  });
});

// ---- FIX-3 (#1941): duplicate component labels within one fee ----------------

describe("config-transfer membership-fees duplicate labels (#1941)", () => {
  it("BLOCKS a bundle carrying two components with the same (fee, label)", async () => {
    const files = bundle({
      "membership-fees/annual-fees.csv": AF_HEADER + "FULL,2026-01-01,,12000,PER_MEMBER,NONE\n",
      "membership-fees/annual-fee-components.csv":
        AC_HEADER + "FULL,2026-01-01,Base,10000,true,,,0\nFULL,2026-01-01,Base,2000,false,,,1\n",
    });
    const plan = await membershipFeesImporter.plan(planCtx(files, makeStore().db as unknown as ReadDb));
    expect(plan.errors.join(" ")).toMatch(/duplicate component label\(s\) "Base"/i);
  });

  it("BLOCKS importing into a target fee that already has duplicate-label components", async () => {
    const target = makeStore({
      annualFees: [
        { id: "af-full", membershipTypeId: "mt-full", effectiveFrom: d("2026-01-01"), effectiveTo: null, amountCents: 12000, billingBasis: "PER_MEMBER", prorationRule: "NONE" },
      ],
      components: [
        { id: "c-1", membershipAnnualFeeId: "af-full", label: "Base", amountCents: 6000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 },
        { id: "c-2", membershipAnnualFeeId: "af-full", label: "Base", amountCents: 6000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 1 },
      ],
    });
    const files = bundle({
      "membership-fees/annual-fees.csv": AF_HEADER + "FULL,2026-01-01,,12000,PER_MEMBER,NONE\n",
      "membership-fees/annual-fee-components.csv": AC_HEADER + "FULL,2026-01-01,Base,12000,true,,,0\n",
    });
    const plan = await membershipFeesImporter.plan(planCtx(files, target.db as unknown as ReadDb, "overwrite"));
    expect(plan.errors.join(" ")).toMatch(/target's annual fee .* already has duplicate-label component\(s\) "Base"/i);
  });
});

// ---- FIX-2 (#2067): cross-row PER_FAMILY / per-tier mix guard ----------------

describe("config-transfer membership-fees PER_FAMILY/tier mix guard (#2067 finding 2)", () => {
  it("BLOCKS a hand-edited bundle mixing a flat PER_FAMILY fee with a per-tier fee in overlapping windows", async () => {
    const files = bundle({
      "membership-fees/annual-fees.csv":
        AF_TIER_HEADER +
        "FULL,,2026-01-01,,20000,PER_FAMILY,NONE\n" +
        "FULL,ADULT,2026-01-01,,15000,PER_MEMBER,NONE\n",
      "membership-fees/annual-fee-components.csv":
        AC_TIER_HEADER +
        "FULL,,2026-01-01,Base,20000,true,,,0\n" +
        "FULL,ADULT,2026-01-01,Base,15000,true,,,0\n",
    });
    const plan = await membershipFeesImporter.plan(planCtx(files, makeStore().db as unknown as ReadDb));
    expect(plan.errors.join(" ")).toMatch(/flat per-family fee .* overlapping a per-age-tier/i);
  });

  it("allows a flat PER_MEMBER fee coexisting with a per-tier PER_MEMBER fee (no PER_FAMILY mix)", async () => {
    const files = bundle({
      "membership-fees/annual-fees.csv":
        AF_TIER_HEADER +
        "FULL,,2026-01-01,,12000,PER_MEMBER,NONE\n" +
        "FULL,ADULT,2026-01-01,,15000,PER_MEMBER,NONE\n",
      "membership-fees/annual-fee-components.csv":
        AC_TIER_HEADER +
        "FULL,,2026-01-01,Base,12000,true,,,0\n" +
        "FULL,ADULT,2026-01-01,Base,15000,true,,,0\n",
    });
    const plan = await membershipFeesImporter.plan(planCtx(files, makeStore().db as unknown as ReadDb));
    expect(plan.errors).toEqual([]);
  });

  it("BLOCKS a flat PER_FAMILY bundle row overlapping a per-tier fee ALREADY on the target (post-merge)", async () => {
    // A legit ADULT per-tier fee is already on the target; the bundle adds a flat
    // PER_FAMILY fee in an overlapping window. The DB GiST/CHECK allow it, but it
    // reaches the exact state the fee-configuration API forbids.
    const target = makeStore({
      annualFees: [
        { id: "af-adult", membershipTypeId: "mt-full", ageTier: "ADULT", effectiveFrom: d("2026-01-01"), effectiveTo: null, amountCents: 15000, billingBasis: "PER_MEMBER", prorationRule: "NONE" },
      ],
      components: [
        { id: "c-a", membershipAnnualFeeId: "af-adult", label: "Base", amountCents: 15000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 },
      ],
    });
    const files = bundle({
      "membership-fees/annual-fees.csv": AF_TIER_HEADER + "FULL,,2026-06-01,,20000,PER_FAMILY,NONE\n",
      "membership-fees/annual-fee-components.csv": AC_TIER_HEADER + "FULL,,2026-06-01,Base,20000,true,,,0\n",
    });
    const plan = await membershipFeesImporter.plan(planCtx(files, target.db as unknown as ReadDb, "merge"));
    expect(plan.errors.join(" ")).toMatch(/flat per-family fee .* overlapping a per-age-tier/i);
  });

  it("does not flag a flat PER_FAMILY fee in a NON-overlapping window with a per-tier fee", async () => {
    const files = bundle({
      "membership-fees/annual-fees.csv":
        AF_TIER_HEADER +
        "FULL,ADULT,2026-01-01,2026-05-31,15000,PER_MEMBER,NONE\n" +
        "FULL,,2026-06-01,,20000,PER_FAMILY,NONE\n",
      "membership-fees/annual-fee-components.csv":
        AC_TIER_HEADER +
        "FULL,ADULT,2026-01-01,Base,15000,true,,,0\n" +
        "FULL,,2026-06-01,Base,20000,true,,,0\n",
    });
    const plan = await membershipFeesImporter.plan(planCtx(files, makeStore().db as unknown as ReadDb));
    expect(plan.errors).toEqual([]);
  });

  it("round-trip of a legitimate per-tier PER_MEMBER install stays clean (guard is inert on valid state)", async () => {
    // The seeded per-tier source has NO flat PER_FAMILY fee, so export→import
    // must not trip the mix guard.
    const source = makeStore({
      annualFees: [
        { id: "af-adult", membershipTypeId: "mt-full", ageTier: "ADULT", effectiveFrom: d("2026-01-01"), effectiveTo: null, amountCents: 15000, billingBasis: "PER_MEMBER", prorationRule: "NONE" },
        { id: "af-youth", membershipTypeId: "mt-full", ageTier: "YOUTH", effectiveFrom: d("2026-01-01"), effectiveTo: null, amountCents: 8000, billingBasis: "PER_MEMBER", prorationRule: "NONE" },
      ],
      components: [
        { id: "c-a", membershipAnnualFeeId: "af-adult", label: "Base", amountCents: 15000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 },
        { id: "c-y", membershipAnnualFeeId: "af-youth", label: "Base", amountCents: 8000, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 },
      ],
    });
    const { files } = readBundle((await exportFees(source.db as unknown as ReadDb)).zip);
    const plan = await membershipFeesImporter.plan(planCtx(files, makeStore().db as unknown as ReadDb));
    expect(plan.errors).toEqual([]);
  });
});

// ---- FIX-3 (#2067): NOT_APPLICABLE is not a valid fee tier -------------------

describe("config-transfer membership-fees NOT_APPLICABLE tier (#2067 finding 3)", () => {
  it("BLOCKS an annual-fee row carrying ageTier NOT_APPLICABLE", async () => {
    const files = bundle({
      "membership-fees/annual-fees.csv": AF_TIER_HEADER + "FULL,NOT_APPLICABLE,2026-01-01,,12000,PER_MEMBER,NONE\n",
      "membership-fees/annual-fee-components.csv": AC_TIER_HEADER + "FULL,NOT_APPLICABLE,2026-01-01,Base,12000,true,,,0\n",
    });
    const plan = await membershipFeesImporter.plan(planCtx(files, makeStore().db as unknown as ReadDb));
    expect(plan.errors.join(" ")).toMatch(/annual-fees\.csv.*NOT_APPLICABLE is not a valid fee tier/i);
  });

  it("BLOCKS a joining-fee row carrying ageTier NOT_APPLICABLE", async () => {
    const files = bundle({
      "membership-fees/joining-fees.csv": JF_HEADER + "FULL,NOT_APPLICABLE,2026-01-01,,10000\n",
    });
    const plan = await membershipFeesImporter.plan(planCtx(files, makeStore().db as unknown as ReadDb));
    expect(plan.errors.join(" ")).toMatch(/joining-fees\.csv.*NOT_APPLICABLE is not a valid fee tier/i);
  });
});
