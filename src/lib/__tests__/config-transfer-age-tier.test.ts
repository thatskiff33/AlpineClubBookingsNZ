import { describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8 } from "fflate";

vi.mock("server-only", () => ({}));

import { parseCsv } from "@/lib/config-transfer/csv";
import {
  ageTierExporter,
  ageTierImporter,
} from "@/lib/config-transfer/categories/age-tier";
import type {
  ApplyContext,
  PlanContext,
  ReadDb,
  TxDb,
} from "@/lib/config-transfer/import-types";
import type { ExportContext } from "@/lib/config-transfer/export-types";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const AGE_TIERS_FILE = "membership-fees/age-tiers.csv";

// A full four-tier TAC install. `id`/`createdAt`/`updatedAt` are present on the
// rows so the export can be shown to EXCLUDE them.
function fourTierRows() {
  return [
    { id: "id-infant", tier: "INFANT", minAge: 0, maxAge: 4, label: "Infant (under 5)", subscriptionRequiredForBooking: false, familyGroupRequestCreateMemberAllowed: true, sortOrder: 0, createdAt: new Date(), updatedAt: new Date() },
    { id: "id-child", tier: "CHILD", minAge: 5, maxAge: 9, label: "Child (5-9)", subscriptionRequiredForBooking: false, familyGroupRequestCreateMemberAllowed: true, sortOrder: 1, createdAt: new Date(), updatedAt: new Date() },
    { id: "id-youth", tier: "YOUTH", minAge: 10, maxAge: 17, label: "Youth (10-17)", subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, sortOrder: 2, createdAt: new Date(), updatedAt: new Date() },
    { id: "id-adult", tier: "ADULT", minAge: 18, maxAge: null, label: "Adult (18+)", subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, sortOrder: 3, createdAt: new Date(), updatedAt: new Date() },
  ];
}

function exportDb(rows: unknown[]): ReadDb {
  return { ageTierSetting: { findMany: vi.fn().mockResolvedValue(rows) } } as unknown as ReadDb;
}

const media = { reference: () => {} };
function exportCtx(db: ReadDb): ExportContext {
  return { db, includeDoorCodes: false, media } as unknown as ExportContext;
}

async function exportCsv(rows: unknown[]): Promise<string> {
  const entries = await ageTierExporter.export(exportCtx(exportDb(rows)));
  expect(entries).toHaveLength(1);
  return strFromU8(entries[0].bytes);
}

function filesFor(csv: string): Map<string, Uint8Array> {
  return new Map([[AGE_TIERS_FILE, strToU8(csv)]]);
}

function planDb(rows: unknown[]): ReadDb {
  return { ageTierSetting: { findMany: vi.fn().mockResolvedValue(rows) } } as unknown as ReadDb;
}

function planCtx(
  files: Map<string, Uint8Array>,
  db: ReadDb,
  mode: "merge" | "overwrite" = "merge",
): PlanContext {
  return { db, files, manifest: {} as never, mode, resolutions: new Map(), format: CLUB_FORMAT_TEST } as PlanContext;
}

type TierSpy = { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
function txStub(rows: unknown[]): { tx: TxDb; spy: TierSpy } {
  const spy: TierSpy = {
    findMany: vi.fn().mockResolvedValue(rows),
    create: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
  };
  return { tx: { ageTierSetting: spy } as unknown as TxDb, spy };
}

function applyCtx(files: Map<string, Uint8Array>, tx: TxDb, mode: "merge" | "overwrite" = "merge"): ApplyContext {
  return {
    tx, files, manifest: {} as never, mode,
    resolutions: new Map(), actorMemberId: "admin-1",
    format: CLUB_FORMAT_TEST,
    imageRemap: new Map(), notes: { doorCodesWritten: [] },
  } as ApplyContext;
}

describe("config-transfer age-tier export (#2200)", () => {
  it("exports the seven portable policy columns and excludes id/createdAt/updatedAt", async () => {
    const csv = await exportCsv(fourTierRows());
    const { headers, rows } = parseCsv(csv);
    expect(headers).toEqual([
      "tier", "minAge", "maxAge", "label",
      "subscriptionRequiredForBooking", "familyGroupRequestCreateMemberAllowed", "sortOrder",
    ]);
    for (const forbidden of ["id", "createdAt", "updatedAt"]) {
      expect(headers).not.toContain(forbidden);
    }
    // Sorted by sortOrder; ADULT carries a blank (null) maxAge.
    expect(rows.map((r) => r.tier)).toEqual(["INFANT", "CHILD", "YOUTH", "ADULT"]);
    expect(rows[3]).toMatchObject({ tier: "ADULT", maxAge: "", label: "Adult (18+)" });
    expect(rows[0]).toMatchObject({ tier: "INFANT", minAge: "0", maxAge: "4", subscriptionRequiredForBooking: "false" });
  });

  it("emits nothing for an install with no age tiers (category simply absent)", async () => {
    const entries = await ageTierExporter.export(exportCtx(exportDb([])));
    expect(entries).toEqual([]);
  });
});

describe("config-transfer age-tier import round-trip + rekey (#2200)", () => {
  it("round-trips: an identical target is unchanged", async () => {
    const csv = await exportCsv(fourTierRows());
    const plan = await ageTierImporter.plan(planCtx(filesFor(csv), planDb(fourTierRows())));
    expect(plan.errors).toEqual([]);
    expect(plan.items.every((i) => i.action === "unchanged")).toBe(true);
  });

  it("REKEYS by tier: updates the target's OWN row id, never the source id", async () => {
    const csv = await exportCsv(fourTierRows());
    // The target has the same tiers but different ids and an older ADULT label.
    const target = fourTierRows().map((r) => ({ ...r, id: `tgt-${r.tier}` }));
    target[3] = { ...target[3], label: "Adults" };

    const plan = await ageTierImporter.plan(planCtx(filesFor(csv), planDb(target)));
    expect(plan.errors).toEqual([]);
    const adult = plan.items.find((i) => i.key === "ADULT");
    expect(adult?.action).toBe("update");
    expect(adult?.changedFields).toEqual(["label"]);

    const { tx, spy } = txStub(target);
    const result = await ageTierImporter.apply(applyCtx(filesFor(csv), tx));
    // The ADULT update targets the DESTINATION's id (tgt-ADULT), not "id-adult".
    expect(spy.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tgt-ADULT" }, data: expect.objectContaining({ label: "Adult (18+)" }) }),
    );
    // No create (every tier already existed), no orphan.
    expect(spy.create).not.toHaveBeenCalled();
    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(3);
  });

  it("creates a tier the target lacks (rekey create), staying a valid partition", async () => {
    const csv = await exportCsv(fourTierRows());
    // Target is a 3-tier install missing INFANT, with CHILD spanning 0-9.
    const target = [
      { id: "t-child", tier: "CHILD", minAge: 0, maxAge: 9, label: "Child", subscriptionRequiredForBooking: false, familyGroupRequestCreateMemberAllowed: true, sortOrder: 0 },
      { id: "t-youth", tier: "YOUTH", minAge: 10, maxAge: 17, label: "Youth", subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, sortOrder: 1 },
      { id: "t-adult", tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, sortOrder: 2 },
    ];
    // The full 4-tier bundle re-tiles the partition (INFANT 0-4, CHILD 5-9, ...),
    // so the post-merge set is the valid four-tier partition.
    const plan = await ageTierImporter.plan(planCtx(filesFor(csv), planDb(target)));
    expect(plan.errors).toEqual([]);
    expect(plan.items.find((i) => i.key === "INFANT")?.action).toBe("create");

    const { tx, spy } = txStub(target);
    await ageTierImporter.apply(applyCtx(filesFor(csv), tx));
    expect(spy.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tier: "INFANT", minAge: 0, maxAge: 4 }) }),
    );
  });
});

describe("config-transfer age-tier partition safety (#2200)", () => {
  it("BLOCKS a subset bundle that would leave the target with an overlapping partition", async () => {
    // Bundle carries a two-tier partition (CHILD 0-17 + ADULT 18+)...
    const subset = [
      { id: "s1", tier: "CHILD", minAge: 0, maxAge: 17, label: "Child (0-17)", subscriptionRequiredForBooking: false, familyGroupRequestCreateMemberAllowed: true, sortOrder: 0 },
      { id: "s2", tier: "ADULT", minAge: 18, maxAge: null, label: "Adult (18+)", subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, sortOrder: 1 },
    ];
    const csv = await exportCsv(subset);
    // ...but the target still has INFANT 0-4 and YOUTH 10-17 that upsert-only
    // apply cannot delete, so the effective set overlaps.
    const plan = await ageTierImporter.plan(planCtx(filesFor(csv), planDb(fourTierRows())));
    expect(plan.errors.length).toBeGreaterThan(0);
    expect(plan.errors.join(" ")).toMatch(/effective age partition invalid/i);
    expect(plan.errors.join(" ")).toMatch(/Age Tiers admin page/i);
  });

  it("rejects the NOT_APPLICABLE tier as un-configurable", async () => {
    const csv = [
      "tier,minAge,maxAge,label,subscriptionRequiredForBooking,familyGroupRequestCreateMemberAllowed,sortOrder",
      "NOT_APPLICABLE,0,,Org,false,false,0",
    ].join("\n") + "\n";
    const plan = await ageTierImporter.plan(planCtx(filesFor(csv), planDb(fourTierRows())));
    expect(plan.errors.join(" ")).toMatch(/NOT_APPLICABLE .* cannot be configured/i);
  });

  it("rejects a duplicate tier row", async () => {
    const csv = [
      "tier,minAge,maxAge,label,subscriptionRequiredForBooking,familyGroupRequestCreateMemberAllowed,sortOrder",
      "ADULT,18,,Adult,true,false,0",
      "ADULT,20,,Adult 2,true,false,1",
    ].join("\n") + "\n";
    const plan = await ageTierImporter.plan(planCtx(filesFor(csv), planDb(fourTierRows())));
    expect(plan.errors.join(" ")).toMatch(/duplicate row for tier "ADULT"/i);
  });

  it("rejects a non-integer minAge and an over-long label", async () => {
    const csv = [
      "tier,minAge,maxAge,label,subscriptionRequiredForBooking,familyGroupRequestCreateMemberAllowed,sortOrder",
      `ADULT,x,,${"L".repeat(101)},true,false,0`,
    ].join("\n") + "\n";
    const plan = await ageTierImporter.plan(planCtx(filesFor(csv), planDb(fourTierRows())));
    const joined = plan.errors.join(" ");
    expect(joined).toMatch(/minAge — "x" is not a whole number/i);
  });
});

describe("config-transfer age-tier files-first tolerance (#2200)", () => {
  it("a bundle without age-tiers.csv is a no-op and never reads the delegate", async () => {
    const findMany = vi.fn();
    const db = { ageTierSetting: { findMany } } as unknown as ReadDb;
    const plan = await ageTierImporter.plan(planCtx(new Map(), db));
    expect(plan.items).toEqual([]);
    expect(plan.errors).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();

    const { tx, spy } = txStub([]);
    spy.findMany.mockClear();
    const result = await ageTierImporter.apply(applyCtx(new Map(), tx));
    expect(result).toEqual({ created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0 });
    expect(spy.findMany).not.toHaveBeenCalled();
  });
});
