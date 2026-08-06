import { describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8 } from "fflate";

vi.mock("server-only", () => ({}));

import { DEFAULT_BED_ALLOCATION_SETTINGS } from "@/config/club-settings-defaults";
import {
  BED_ALLOCATION_SETTINGS_FILE,
  bedAllocationSettingsExporter,
  bedAllocationSettingsFile,
  bedAllocationSettingsImporter,
} from "@/lib/config-transfer/categories/bed-allocation-settings";
import {
  lodgeConfigExporter,
  lodgeConfigImporter,
} from "@/lib/config-transfer/categories/lodge-config";
import { CATEGORY_EXPORTERS } from "@/lib/config-transfer/export";
import { CATEGORY_IMPORTERS } from "@/lib/config-transfer/import";
import { updateBedAllocationSettings } from "@/lib/admin-bed-allocation";
import type {
  ApplyContext,
  PlanContext,
  ReadDb,
  TxDb,
} from "@/lib/config-transfer/import-types";

const SEGMENT = "transport-folder";
const SLUG = "authoritative-lodge";
const LODGE_FILE = `lodge-config/lodges/${SEGMENT}/lodge.json`;
const SETTINGS_FILE = bedAllocationSettingsFile(SEGMENT);

function files(settings?: Record<string, unknown>): Map<string, Uint8Array> {
  const entries: Array<[string, Uint8Array]> = [
    [LODGE_FILE, strToU8(JSON.stringify({ slug: SLUG, name: "Lodge" }))],
  ];
  if (settings) entries.push([SETTINGS_FILE, strToU8(JSON.stringify(settings))]);
  return new Map(entries);
}

function planContext(
  db: ReadDb,
  bundleFiles: Map<string, Uint8Array>,
  mode: "merge" | "overwrite" = "merge",
): PlanContext {
  return {
    db,
    files: bundleFiles,
    manifest: {} as PlanContext["manifest"],
    mode,
    resolutions: new Map(),
    selectedCategories: ["lodge-config"],
  };
}

function applyContext(
  tx: TxDb,
  bundleFiles: Map<string, Uint8Array>,
  mode: "merge" | "overwrite" = "merge",
): ApplyContext {
  return {
    tx,
    files: bundleFiles,
    manifest: {} as ApplyContext["manifest"],
    mode,
    resolutions: new Map(),
    actorMemberId: "actor-1",
    imageRemap: new Map(),
    notes: { doorCodesWritten: [] },
    selectedCategories: ["lodge-config"],
  };
}

interface StoredSettings {
  id: string;
  lodgeId: string | null;
  autoAllocationEnabled: boolean;
  allocationPriorityOrder: string[];
  updatedByMemberId: string | null;
  updatedAt: Date;
}

function statefulDb(options: {
  lodgeId: string;
  slug: string;
  rows?: StoredSettings[];
}) {
  const rows = new Map(
    (options.rows ?? []).map((row) => [row.id, { ...row }]),
  );
  const bedAllocationSettings = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      rows.get(where.id) ?? null,
    ),
    findMany: vi.fn(
      async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.flatMap((id) => {
          const row = rows.get(id);
          return row ? [row] : [];
        }),
    ),
    create: vi.fn(async ({ data }: { data: StoredSettings }) => {
      const row = {
        ...data,
        updatedByMemberId: data.updatedByMemberId ?? null,
        updatedAt: data.updatedAt ?? new Date("2026-08-06T00:00:00.000Z"),
      };
      rows.set(row.id, row);
      return row;
    }),
    update: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<StoredSettings>;
      }) => {
        const row = { ...rows.get(where.id)!, ...data };
        rows.set(where.id, row);
        return row;
      },
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: StoredSettings;
        update: Partial<StoredSettings>;
      }) => {
        const current = rows.get(where.id);
        const row = current ? { ...current, ...update } : create;
        rows.set(where.id, row);
        return row;
      },
    ),
  };
  const db = {
    lodge: {
      findMany: vi.fn().mockResolvedValue([
        { id: options.lodgeId, slug: options.slug },
      ]),
    },
    bedAllocationSettings,
  };
  return { db, rows, bedAllocationSettings };
}

describe("per-lodge bed-allocation settings config transfer (#2593)", () => {
  it("runs immediately after base lodge config on export and import", () => {
    const exportIndex = CATEGORY_EXPORTERS.indexOf(bedAllocationSettingsExporter);
    const importIndex = CATEGORY_IMPORTERS.indexOf(bedAllocationSettingsImporter);
    expect(CATEGORY_EXPORTERS[exportIndex - 1]).toBe(lodgeConfigExporter);
    expect(CATEGORY_IMPORTERS[importIndex - 1]).toBe(lodgeConfigImporter);
  });

  it("exports one complete effective file per lodge, including legacy fallback", async () => {
    const db = {
      lodge: {
        findMany: vi.fn().mockResolvedValue([{ id: "lodge-1", slug: "main" }]),
      },
      bedAllocationSettings: {
        findUnique: vi.fn().mockImplementation(async ({ where }: { where: { id: string } }) =>
          where.id === "default"
            ? {
                id: "default",
                lodgeId: null,
                autoAllocationEnabled: false,
                allocationPriorityOrder: ["REQUESTED_ROOM"],
                updatedByMemberId: null,
                updatedAt: null,
              }
            : null,
        ),
      },
    } as unknown as ReadDb;

    const entries = await bedAllocationSettingsExporter.export({
      db,
      includeDoorCodes: false,
      media: { reference: vi.fn() },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe(
      `lodge-config/lodges/main/${BED_ALLOCATION_SETTINGS_FILE}`,
    );
    expect(JSON.parse(strFromU8(entries[0].bytes))).toEqual({
      autoAllocationEnabled: false,
      allocationPriorityOrder: ["REQUESTED_ROOM"],
    });
  });

  it("leaves a lodge untouched when its optional settings file is absent", async () => {
    const lodgeFindMany = vi.fn();
    const plan = await bedAllocationSettingsImporter.plan(
      planContext({ lodge: { findMany: lodgeFindMany } } as unknown as ReadDb, files()),
    );
    expect(plan.items).toEqual([]);
    expect(plan.errors).toEqual([]);
    expect(lodgeFindMany).not.toHaveBeenCalled();
  });

  it("keys by lodge.json slug and accepts an existing inactive lodge", async () => {
    const db = {
      lodge: {
        findMany: vi.fn().mockResolvedValue([
          { id: "lodge-1", slug: SLUG, active: false },
        ]),
      },
      bedAllocationSettings: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "lodge-1",
            autoAllocationEnabled: false,
            allocationPriorityOrder: ["BOOKING_COHESION", "REQUESTED_ROOM"],
          },
        ]),
      },
    } as unknown as ReadDb;
    const plan = await bedAllocationSettingsImporter.plan(
      planContext(
        db,
        files({ allocationPriorityOrder: ["REQUESTED_ROOM", "BOOKING_COHESION"] }),
        "overwrite",
      ),
    );

    expect(plan.errors).toEqual([]);
    expect(plan.items).toEqual([
      {
        entity: "lodge-bed-allocation-settings",
        key: SLUG,
        action: "update",
        changedFields: ["allocationPriorityOrder"],
      },
    ]);
  });

  it.each([
    ["omitted", {}, [...DEFAULT_BED_ALLOCATION_SETTINGS.allocationPriorityOrder]],
    ["explicit empty", { allocationPriorityOrder: [] }, []],
  ] as const)("treats %s priority as the designed present value", async (_name, input, expected) => {
    const db = {
      lodge: { findMany: vi.fn().mockResolvedValue([{ id: "lodge-1", slug: SLUG }]) },
      bedAllocationSettings: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "lodge-1",
            autoAllocationEnabled: true,
            allocationPriorityOrder:
              expected.length === 0
                ? [...DEFAULT_BED_ALLOCATION_SETTINGS.allocationPriorityOrder]
                : [],
          },
        ]),
      },
    } as unknown as ReadDb;
    const plan = await bedAllocationSettingsImporter.plan(
      planContext(db, files(input as Record<string, unknown>)),
    );
    expect(plan.items[0]).toMatchObject({
      action: "update",
      changedFields: ["allocationPriorityOrder"],
    });
  });

  it("rejects malformed priority data during planning", async () => {
    const db = {
      lodge: { findMany: vi.fn().mockResolvedValue([{ id: "lodge-1", slug: SLUG }]) },
      bedAllocationSettings: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as ReadDb;
    const plan = await bedAllocationSettingsImporter.plan(
      planContext(db, files({ allocationPriorityOrder: ["NOT_A_PRIORITY"] })),
    );
    expect(plan.items).toEqual([]);
    expect(plan.errors.join(" ")).toMatch(/unknown bed-allocation priority/i);
  });

  it("rejects a settings file with no authoritative sibling lodge slug", async () => {
    const bundleFiles = new Map([
      [SETTINGS_FILE, strToU8(JSON.stringify({ allocationPriorityOrder: [] }))],
    ]);
    const plan = await bedAllocationSettingsImporter.plan(
      planContext({} as ReadDb, bundleFiles),
    );
    expect(plan.items).toEqual([]);
    expect(plan.errors.join(" ")).toMatch(/requires a valid sibling lodge\.json/i);
  });

  it("creates settings for a newly resolved lodge and defaults omitted auto", async () => {
    const create = vi.fn().mockResolvedValue({});
    const tx = {
      lodge: { findMany: vi.fn().mockResolvedValue([{ id: "new-lodge-id", slug: SLUG }]) },
      bedAllocationSettings: {
        findMany: vi.fn().mockResolvedValue([]),
        create,
      },
    } as unknown as TxDb;
    const result = await bedAllocationSettingsImporter.apply(
      applyContext(tx, files({ allocationPriorityOrder: [] })),
    );
    expect(result).toMatchObject({ created: 1, updated: 0, deleted: 0 });
    expect(create).toHaveBeenCalledWith({
      data: {
        id: "new-lodge-id",
        lodgeId: "new-lodge-id",
        autoAllocationEnabled: DEFAULT_BED_ALLOCATION_SETTINGS.autoAllocationEnabled,
        allocationPriorityOrder: [],
        updatedByMemberId: "actor-1",
      },
    });
  });

  it.each(["merge", "overwrite"] as const)(
    "applies an explicit empty priority in %s mode without defaulting omitted auto",
    async (mode) => {
      const update = vi.fn().mockResolvedValue({});
      const tx = {
        lodge: { findMany: vi.fn().mockResolvedValue([{ id: "lodge-1", slug: SLUG }]) },
        bedAllocationSettings: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "lodge-1",
              autoAllocationEnabled: false,
              allocationPriorityOrder: [...DEFAULT_BED_ALLOCATION_SETTINGS.allocationPriorityOrder],
            },
          ]),
          update,
        },
      } as unknown as TxDb;
      const result = await bedAllocationSettingsImporter.apply(
        applyContext(tx, files({ allocationPriorityOrder: [] }), mode),
      );
      expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0 });
      expect(update).toHaveBeenCalledWith({
        where: { id: "lodge-1" },
        data: {
          allocationPriorityOrder: [],
          updatedByMemberId: "actor-1",
        },
      });
    },
  );

  it("fails closed when direct apply sees invalid data or an unresolved lodge", async () => {
    const resolvedTx = {
      lodge: { findMany: vi.fn().mockResolvedValue([{ id: "lodge-1", slug: SLUG }]) },
      bedAllocationSettings: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as TxDb;
    await expect(
      bedAllocationSettingsImporter.apply(
        applyContext(
          resolvedTx,
          files({ allocationPriorityOrder: ["UNKNOWN"] }),
        ),
      ),
    ).rejects.toThrow(/unknown bed-allocation priority/i);

    const unresolvedTx = {
      lodge: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as TxDb;
    await expect(
      bedAllocationSettingsImporter.apply(
        applyContext(unresolvedTx, files({ allocationPriorityOrder: [] })),
      ),
    ).rejects.toThrow(/target lodge.*was not resolved/i);
  });

  it("round-trips an exported effective file through apply and re-export", async () => {
    const source = statefulDb({
      lodgeId: "source-lodge-id",
      slug: SLUG,
      rows: [
        {
          id: "source-lodge-id",
          lodgeId: "source-lodge-id",
          autoAllocationEnabled: false,
          allocationPriorityOrder: [],
          updatedByMemberId: null,
          updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      ],
    });
    const [exported] = await bedAllocationSettingsExporter.export({
      db: source.db as unknown as ReadDb,
      includeDoorCodes: false,
      media: { reference: vi.fn() },
    });
    const target = statefulDb({ lodgeId: "target-lodge-id", slug: SLUG });
    const segment = SLUG;
    const transferFiles = new Map([
      [
        `lodge-config/lodges/${segment}/lodge.json`,
        strToU8(JSON.stringify({ slug: SLUG, name: "Lodge" })),
      ],
      [exported.path, exported.bytes],
    ]);
    await bedAllocationSettingsImporter.apply(
      applyContext(target.db as unknown as TxDb, transferFiles),
    );
    const [reExported] = await bedAllocationSettingsExporter.export({
      db: target.db as unknown as ReadDb,
      includeDoorCodes: false,
      media: { reference: vi.fn() },
    });
    expect(JSON.parse(strFromU8(reExported.bytes))).toEqual(
      JSON.parse(strFromU8(exported.bytes)),
    );
  });

  it("keeps an imported own row authoritative over a linked legacy row on later UI save", async () => {
    const linkedLegacy: StoredSettings = {
      id: "default",
      lodgeId: "target-lodge-id",
      autoAllocationEnabled: true,
      allocationPriorityOrder: ["BOOKING_COHESION"],
      updatedByMemberId: null,
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    const target = statefulDb({
      lodgeId: "target-lodge-id",
      slug: SLUG,
      rows: [linkedLegacy],
    });
    await bedAllocationSettingsImporter.apply(
      applyContext(
        target.db as unknown as TxDb,
        files({
          autoAllocationEnabled: false,
          allocationPriorityOrder: ["REQUESTED_ROOM"],
        }),
      ),
    );

    const saved = await updateBedAllocationSettings({
      db: target.db as never,
      lodgeId: "target-lodge-id",
      autoAllocationEnabled: true,
      allocationPriorityOrder: [],
      updatedByMemberId: "admin-2",
    });

    expect(target.bedAllocationSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "target-lodge-id" } }),
    );
    expect(target.rows.get("default")).toEqual(linkedLegacy);
    expect(saved).toMatchObject({
      settingsId: "target-lodge-id",
      source: "LODGE",
      autoAllocationEnabled: true,
      allocationPriorityOrder: [],
    });
  });
});
