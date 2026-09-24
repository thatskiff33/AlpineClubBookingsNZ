import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  bookingPoliciesExporter,
  bookingPoliciesImporter,
  MINIMUM_STAY_POLICIES_FILE,
} from "@/lib/config-transfer/categories/booking-policies";
import { ADULT_MEMBER_HOSTING_FILE } from "@/lib/config-transfer/categories/adult-member-hosting";
import {
  ConfigTransferBundleError,
  readBundle,
} from "@/lib/config-transfer/bundle";
import { parseCsv } from "@/lib/config-transfer/csv";
import { buildConfigExport } from "@/lib/config-transfer/export";
import { buildImportPlan } from "@/lib/config-transfer/import";
import type { ExportContext } from "@/lib/config-transfer/export-types";
import type {
  ApplyContext,
  PlanContext,
  ReadDb,
  TxDb,
} from "@/lib/config-transfer/import-types";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const lodge = { id: "lodge-tlr", slug: "tukino" };
const policy = {
  id: "policy-1",
  name: "Winter weekends",
  startDate: new Date("2026-06-01T00:00:00.000Z"),
  endDate: new Date("2026-09-30T00:00:00.000Z"),
  triggerDays: [6, 5],
  minimumNights: 2,
  capacityMode: "HOLD",
  active: true,
  lodgeId: lodge.id,
  version: 4,
};

function db(policies: unknown[] = [policy], lodges: unknown[] = [lodge]): ReadDb {
  return {
    lodge: { findMany: vi.fn().mockResolvedValue(lodges) },
    minimumStayPolicy: { findMany: vi.fn().mockResolvedValue(policies) },
    // #2364 shares this category. These tests are about the minimum-stay
    // replace-set, so the hosting side is empty on both sides throughout and
    // contributes nothing to any plan, summary or apply asserted below; its own
    // behaviour is covered in adult-member-hosting-config-transfer.test.ts.
    adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as ReadDb;
}

/** Mutation-capable hosting client for an apply context. */
function hostingTx() {
  return {
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
}

/** The header-only hosting file every booking-policies bundle must carry. */
// #2569 added a fourth column, hostScopes. Header-only, so no row carries it.
const EMPTY_HOSTING_CSV = "scope,mode,capacityMode,hostScopes\n";

function files(csv: string): Map<string, Uint8Array> {
  return new Map([
    [MINIMUM_STAY_POLICIES_FILE, strToU8(csv)],
    [ADULT_MEMBER_HOSTING_FILE, strToU8(EMPTY_HOSTING_CSV)],
  ]);
}

function planContext(
  csv: string,
  target = db(),
  extraFiles: Array<[string, Uint8Array]> = [],
): PlanContext {
  return {
    db: target,
    files: new Map([
      [MINIMUM_STAY_POLICIES_FILE, strToU8(csv)],
      [ADULT_MEMBER_HOSTING_FILE, strToU8(EMPTY_HOSTING_CSV)],
      ...extraFiles,
    ]),
    manifest: {} as never,
    mode: "merge",
    resolutions: new Map(),
    format: CLUB_FORMAT_TEST,
    selectedCategories: ["lodge-config", "booking-policies"],
  };
}

function csvRow(overrides: Record<string, string> = {}): string {
  const row = {
    scope: "lodge:tukino",
    name: "Winter weekends",
    startDate: "2026-06-01",
    endDate: "2026-09-30",
    triggerDays: "5|6",
    minimumNights: "2",
    capacityMode: "HOLD",
    active: "true",
    ...overrides,
  };
  return [
    "scope,name,startDate,endDate,triggerDays,minimumNights,capacityMode,active",
    Object.values(row).join(","),
  ].join("\n") + "\n";
}

describe("config-transfer booking policies (#2363)", () => {
  it("exports a deterministic, id-free policy file and always emits an empty header", async () => {
    const context = {
      db: db(),
      includeDoorCodes: false,
      media: { reference: vi.fn() },
    } as ExportContext;
    const [entry] = await bookingPoliciesExporter.export(context);
    const parsed = parseCsv(strFromU8(entry.bytes));
    expect(entry.path).toBe(MINIMUM_STAY_POLICIES_FILE);
    expect(parsed.headers).toEqual([
      "scope", "name", "startDate", "endDate", "triggerDays",
      "minimumNights", "capacityMode", "active",
    ]);
    expect(parsed.headers).not.toContain("id");
    expect(parsed.headers).not.toContain("version");
    expect(parsed.rows).toEqual([
      expect.objectContaining({
        scope: "lodge:tukino",
        triggerDays: "5|6",
        capacityMode: "HOLD",
      }),
    ]);

    const [empty] = await bookingPoliciesExporter.export({
      ...context,
      db: db([]),
    });
    expect(empty.rowCount).toBe(0);
    expect(strFromU8(empty.bytes)).toBe(
      "scope,name,startDate,endDate,triggerDays,minimumNights,capacityMode,active\n",
    );
  });

  it("is wired through the bundle export and plan orchestrators", async () => {
    const exported = await buildConfigExport({
      db: db(),
      categories: ["booking-policies"],
      includeDoorCodes: false,
      appVersion: "0.13.2",
      prismaMigration: null,
      generatedAt: "2026-08-01T00:00:00.000Z",
    });
    const parsed = readBundle(exported.zip);
    expect(exported.categories).toEqual(["booking-policies"]);
    expect(parsed.manifest.includedCategories).toEqual(["booking-policies"]);
    expect(parsed.files.has(MINIMUM_STAY_POLICIES_FILE)).toBe(true);
    // #2364: the category carries BOTH files, and a bundle missing either is
    // refused rather than half-applied.
    expect(parsed.files.has(ADULT_MEMBER_HOSTING_FILE)).toBe(true);

    const plan = await buildImportPlan(db(), exported.zip, { format: CLUB_FORMAT_TEST, mode: "merge" });
    expect(plan.errors).toEqual([]);
    expect(plan.summary).toEqual({
      create: 0,
      update: 0,
      delete: 0,
      unchanged: 1,
    });
  });

  it("previews replace-set creates, updates, deletes, and unchanged rows truthfully", async () => {
    const target = [
      policy,
      { ...policy, id: "delete-me", name: "Omitted policy", version: 2 },
      {
        ...policy,
        id: "unchanged",
        name: "Club rule",
        lodgeId: null,
        version: 1,
        capacityMode: "NO_HOLD",
      },
    ];
    const csv = csvRow({ minimumNights: "3" }) +
      "club-wide,Club rule,2026-06-01,2026-09-30,5|6,2,NO_HOLD,true\n" +
      "lodge:tukino,New rule,2027-01-01,2027-02-01,0,2,NO_HOLD,false\n";
    const plan = await bookingPoliciesImporter.plan(planContext(csv, db(target)));
    expect(plan.errors).toEqual([]);
    expect(plan.warnings.join(" ")).toMatch(/complete replace-set.*deleted/i);
    expect(plan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "lodge:tukino / Winter weekends", action: "update" }),
      expect.objectContaining({ key: "club-wide / Club rule", action: "unchanged" }),
      expect.objectContaining({ key: "lodge:tukino / New rule", action: "create" }),
      expect.objectContaining({ key: "lodge:tukino / Omitted policy", action: "delete" }),
    ]));
  });

  it("treats a header-only file as an intentional clear in both write modes", async () => {
    const header =
      "scope,name,startDate,endDate,triggerDays,minimumNights,capacityMode,active\n";
    for (const mode of ["merge", "overwrite"] as const) {
      const ctx = planContext(header);
      ctx.mode = mode;
      const plan = await bookingPoliciesImporter.plan(ctx);
      expect(plan.errors).toEqual([]);
      expect(plan.items).toEqual([
        expect.objectContaining({ action: "delete", key: "lodge:tukino / Winter weekends" }),
      ]);
    }
  });

  it.each([
    ["empty file", ""],
    [
      "wrong header order",
      "name,scope,startDate,endDate,triggerDays,minimumNights,capacityMode,active\n",
    ],
    [
      "missing header column",
      "scope,name,startDate,endDate,triggerDays,minimumNights,active\n",
    ],
    [
      "extra header column",
      "scope,name,startDate,endDate,triggerDays,minimumNights,capacityMode,active,extra\n",
    ],
    [
      "extra row value",
      "scope,name,startDate,endDate,triggerDays,minimumNights,capacityMode,active\n" +
        "club-wide,Weekend,2026-06-01,2026-09-30,5|6,2,HOLD,true,extra\n",
    ],
    [
      "malformed CSV",
      'scope,name,startDate,endDate,triggerDays,minimumNights,capacityMode,active\nlodge:tukino,"unterminated\n',
    ],
  ])("blocks a %s without previewing or applying deletes", async (_label, csv) => {
    const plan = await bookingPoliciesImporter.plan(planContext(csv));
    expect(plan.errors.length).toBeGreaterThan(0);
    expect(plan.items.filter((item) => item.action === "delete")).toEqual([]);

    const deleteMany = vi.fn();
    const tx = {
      lodge: { findMany: vi.fn().mockResolvedValue([lodge]) },
      minimumStayPolicy: {
        findMany: vi.fn().mockResolvedValue([policy]),
        create: vi.fn(),
        updateMany: vi.fn(),
        deleteMany,
      },
      // #2364 travels in the same category, so every apply context needs its
      // client too. Header-only file + no target rows means it does nothing.
      adultMemberHostingPolicy: hostingTx(),
    } as unknown as TxDb;
    await expect(
      bookingPoliciesImporter.apply({
        tx,
        files: files(csv),
        manifest: {} as never,
        mode: "overwrite",
        resolutions: new Map(),
        format: CLUB_FORMAT_TEST,
        actorMemberId: "admin-1",
        imageRemap: new Map(),
        notes: { doorCodesWritten: [] },
      } as ApplyContext),
    ).rejects.toThrow();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("preserves a legal policy name byte-for-byte while rejecting blank and overlong names", async () => {
    const exactName = '  Winter "quoted" policy  ';
    const csv =
      "scope,name,startDate,endDate,triggerDays,minimumNights,capacityMode,active\n" +
      'lodge:tukino,"  Winter ""quoted"" policy  ",2026-06-01,2026-09-30,5|6,2,HOLD,true\n';
    const create = vi.fn().mockResolvedValue({ id: "new" });
    const tx = {
      lodge: { findMany: vi.fn().mockResolvedValue([lodge]) },
      minimumStayPolicy: {
        findMany: vi.fn().mockResolvedValue([]),
        create,
        updateMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      // #2364 travels in the same category, so every apply context needs its
      // client too. Header-only file + no target rows means it does nothing.
      adultMemberHostingPolicy: hostingTx(),
    } as unknown as TxDb;
    await bookingPoliciesImporter.apply({
      tx,
      files: files(csv),
      manifest: {} as never,
      mode: "merge",
      resolutions: new Map(),
      format: CLUB_FORMAT_TEST,
      actorMemberId: "admin-1",
      imageRemap: new Map(),
      notes: { doorCodesWritten: [] },
    } as ApplyContext);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: exactName }),
    }));

    for (const name of ["   ", "x".repeat(201)]) {
      const invalid = await bookingPoliciesImporter.plan(
        planContext(csvRow({ name }), db([])),
      );
      expect(invalid.errors.join(" ")).toMatch(/name .* (blank|200 characters)/i);
      expect(invalid.items).toEqual([]);
    }
  });

  it("namespaces club-wide identity from a lodge whose legal slug is club-wide", async () => {
    const collisionLodge = { id: "lodge-collision", slug: "club-wide" };
    const rows = [
      { ...policy, id: "club-policy", name: "Same name", lodgeId: null },
      {
        ...policy,
        id: "lodge-policy",
        name: "Same name",
        lodgeId: collisionLodge.id,
      },
    ];
    const context = {
      db: db(rows, [collisionLodge]),
      includeDoorCodes: false,
      media: { reference: vi.fn() },
    } as ExportContext;
    const [entry] = await bookingPoliciesExporter.export(context);
    const exported = parseCsv(strFromU8(entry.bytes));
    expect(exported.rows.map((row) => row.scope)).toEqual([
      "club-wide",
      "lodge:club-wide",
    ]);

    const plan = await bookingPoliciesImporter.plan(
      planContext(strFromU8(entry.bytes), db(rows, [collisionLodge])),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "club-wide / Same name", action: "unchanged" }),
      expect.objectContaining({ key: "lodge:club-wide / Same name", action: "unchanged" }),
    ]));
  });

  it("fails a colliding EXPORT with an actionable typed error naming both rows (#2363)", async () => {
    // Two rows sharing (scope, name) — freely creatable before the admin route
    // guard, and still reachable by deactivate-then-recreate because
    // `loadCurrent` reads inactive rows. This used to throw a bare Error, which
    // `configTransferErrorResponse` turns into an opaque 500 with the detail
    // left in the server log: the whole configuration export aborted and the
    // admin was told nothing. It must be a ConfigTransferBundleError (400) that
    // names both rows and the remedy.
    const context = {
      db: db([
        policy,
        {
          ...policy,
          id: "policy-2",
          version: 1,
          active: false,
          startDate: new Date("2025-06-01T00:00:00.000Z"),
          endDate: new Date("2025-09-30T00:00:00.000Z"),
        },
      ]),
      includeDoorCodes: false,
      media: { reference: vi.fn() },
    } as ExportContext;

    await expect(bookingPoliciesExporter.export(context)).rejects.toBeInstanceOf(
      ConfigTransferBundleError,
    );
    const error: Error = await bookingPoliciesExporter
      .export(context)
      .then(() => new Error("export unexpectedly succeeded"))
      .catch((err: unknown) => err as Error);
    // The key alone cannot tell the two apart, so the date range and the active
    // flag of BOTH rows are in the message, plus the fix.
    expect(error.message).toContain('"lodge:tukino / Winter weekends"');
    expect(error.message).toContain("2026-06-01 to 2026-09-30, active");
    expect(error.message).toContain("2025-06-01 to 2025-09-30, inactive");
    expect(error.message).toContain("rename one of them");
    expect(error.message).toContain("a deactivated policy still counts");
  });

  it("blocks ambiguous natural keys and malformed policy values", async () => {
    const duplicateTarget = db([
      policy,
      { ...policy, id: "policy-2", version: 1 },
    ]);
    const duplicatePlan = await bookingPoliciesImporter.plan(
      planContext(csvRow(), duplicateTarget),
    );
    expect(duplicatePlan.errors.join(" ")).toMatch(
      /share the same scope and name/i,
    );

    const malformed = csvRow({
      endDate: "2026-05-01",
      triggerDays: "6|6",
      minimumNights: "1",
      capacityMode: "MAYBE",
    });
    const malformedPlan = await bookingPoliciesImporter.plan(
      planContext(malformed),
    );
    expect(malformedPlan.errors.join(" ")).toMatch(/endDate.*after startDate/i);
    expect(malformedPlan.errors.join(" ")).toMatch(/duplicate weekdays/i);
    expect(malformedPlan.errors.join(" ")).toMatch(/minimumNights.*at least 2/i);
    expect(malformedPlan.errors.join(" ")).toMatch(/PolicyExceptionCapacityMode/i);
  });

  it("accepts a lodge created by the selected lodge-config category", async () => {
    const newLodge = strToU8(JSON.stringify({ slug: "new-lodge", name: "New" }));
    const plan = await bookingPoliciesImporter.plan(
      planContext(
        csvRow({ scope: "lodge:new-lodge" }),
        db([], []),
        [["lodge-config/lodges/new-lodge/lodge.json", newLodge]],
      ),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.items[0]).toMatchObject({
      key: "lodge:new-lodge / Winter weekends",
      action: "create",
    });
  });

  it("applies the replacement with version-guarded updates and deletes", async () => {
    const omitted = { ...policy, id: "delete-me", name: "Omitted", version: 8 };
    const findMany = vi.fn().mockResolvedValue([policy, omitted]);
    const create = vi.fn().mockResolvedValue({ id: "created" });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      lodge: { findMany: vi.fn().mockResolvedValue([lodge]) },
      minimumStayPolicy: { findMany, create, updateMany, deleteMany },
      // #2364 travels in the same category, so every apply context needs its
      // client too. Header-only file + no target rows means it does nothing.
      adultMemberHostingPolicy: hostingTx(),
    } as unknown as TxDb;
    const csv = csvRow({ capacityMode: "NO_HOLD" }) +
      "club-wide,New club rule,2027-01-01,2027-02-01,0,2,HOLD,true\n";
    const result = await bookingPoliciesImporter.apply({
      tx,
      files: files(csv),
      manifest: {} as never,
      mode: "merge",
      resolutions: new Map(),
      format: CLUB_FORMAT_TEST,
      actorMemberId: "admin-1",
      imageRemap: new Map(),
      notes: { doorCodesWritten: [] },
    } as ApplyContext);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: policy.id, version: 4 },
      data: expect.objectContaining({ capacityMode: "NO_HOLD", version: 5 }),
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "delete-me", version: 8 },
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: "New club rule",
        lodgeId: null,
        version: 1,
        capacityMode: "HOLD",
      }),
    }));
    expect(result).toEqual({
      created: 1,
      updated: 1,
      deleted: 1,
      unchanged: 0,
      skipped: 0,
    });
  });

  it("pins config singleton -> both policy sets -> re-plan -> apply ordering", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/config-transfer/apply.ts"),
      "utf8",
    );
    const configLock = source.indexOf("await acquireConfigImportLock(tx)");
    const minimumStayPolicyLock = source.indexOf(
      "await lockMinimumStayPolicySet(tx)",
    );
    const hostingPolicyLock = source.indexOf(
      "await lockAdultMemberHostingPolicySet(tx)",
    );
    const replan = source.indexOf("const replan = await buildImportPlanFromParsed");
    const categoryApply = source.indexOf("await importer.apply(applyCtx)");
    expect(configLock).toBeGreaterThan(-1);
    expect(minimumStayPolicyLock).toBeGreaterThan(configLock);
    expect(hostingPolicyLock).toBeGreaterThan(minimumStayPolicyLock);
    expect(replan).toBeGreaterThan(hostingPolicyLock);
    expect(categoryApply).toBeGreaterThan(replan);
  });
});
