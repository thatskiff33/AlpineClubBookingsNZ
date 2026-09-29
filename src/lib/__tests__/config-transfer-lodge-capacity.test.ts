import { describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8 } from "fflate";

vi.mock("server-only", () => ({}));

import {
  lodgeConfigExporter,
  lodgeConfigImporter,
} from "@/lib/config-transfer/categories/lodge-config";
import type { TxDb } from "@/lib/config-transfer/import-types";

// #3407 (orchestrator decision on the issue): a config export carries each
// lodge's resolved capacity in lodge.json, and an import writes it inside the
// import transaction to the row the resolver reads. The field is optional, so a
// bundle without it imports exactly as before.

const LODGE_JSON = "lodge-config/lodges/main/lodge.json";

interface SettingsRow {
  id: string;
  lodgeId: string | null;
  capacity: number | null;
}

interface World {
  lodges: Array<{ id: string; slug: string }>;
  settings: Map<string, SettingsRow>;
  settingsCreates: Record<string, unknown>[];
  settingsUpdates: Array<{ id: string; data: Record<string, unknown> }>;
}

function world(
  lodges: World["lodges"],
  settings: SettingsRow[],
): World {
  return {
    lodges,
    settings: new Map(settings.map((row) => [row.id, row])),
    settingsCreates: [],
    settingsUpdates: [],
  };
}

/**
 * An in-memory db serving the lodge-config reads plus a live `lodgeSettings`
 * store, so the export reads, the plan compares and the apply writes the same
 * rows. Every other delegate is an empty no-op.
 */
function makeDb(w: World): TxDb {
  const noop = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    create: async () => ({ id: "x" }),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
    upsert: async () => ({ id: "x" }),
  };
  const specific: Record<string, unknown> = {
    lodge: {
      ...noop,
      findMany: async () =>
        w.lodges.map((l) => ({
          id: l.id, slug: l.slug, name: "Main Lodge", active: true, travelNote: null,
          doorCode: null, isDefault: true, displayConfig: null,
          displayNameGranularity: null, displayNotice: null,
          showGuestPhonesOnScreens: false,
        })),
      findFirst: async () => (w.lodges[0] ? { slug: w.lodges[0].slug } : null),
      findUnique: async () => ({ isDefault: true }),
      create: async () => ({ id: "lodge-new" }),
    },
    lodgeSettings: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        w.settings.get(where.id) ?? null,
      create: async ({ data }: { data: SettingsRow }) => {
        w.settingsCreates.push(data as unknown as Record<string, unknown>);
        w.settings.set(data.id, { id: data.id, lodgeId: data.lodgeId, capacity: data.capacity });
        return { id: data.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        w.settingsUpdates.push({ id: where.id, data });
        const row = w.settings.get(where.id)!;
        w.settings.set(where.id, { ...row, ...(data as Partial<SettingsRow>) });
        return { id: where.id };
      },
    },
  };
  return new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => specific[prop as string] ?? noop,
  }) as unknown as TxDb;
}

async function exportFiles(db: TxDb): Promise<Map<string, Uint8Array>> {
  const entries = await lodgeConfigExporter.export({
    db,
    includeDoorCodes: false,
    media: {} as never,
  });
  return new Map(entries.map((e) => [e.path, e.bytes]));
}

function bundleWith(descriptor: Record<string, unknown>): Map<string, Uint8Array> {
  return new Map([[LODGE_JSON, strToU8(JSON.stringify({ slug: "main", name: "Main Lodge", ...descriptor }))]]);
}

function planCtx(db: TxDb, files: Map<string, Uint8Array>) {
  return {
    db,
    files,
    manifest: {} as never,
    mode: "merge" as const,
    resolutions: new Map<string, string>(),
  } as never;
}

function applyCtx(tx: TxDb, files: Map<string, Uint8Array>) {
  return {
    tx,
    files,
    manifest: {} as never,
    mode: "merge" as const,
    resolutions: new Map<string, string>(),
    actorMemberId: "admin-1",
    imageRemap: new Map<string, string>(),
    notes: { doorCodesWritten: [] as string[] },
  } as never;
}

describe("config transfer carries each lodge's capacity (#3407)", () => {
  it("round-trips a lodge's own-row capacity into a new lodge's own settings row", async () => {
    const source = world([{ id: "lodge-main", slug: "main" }], [
      { id: "lodge-main", lodgeId: "lodge-main", capacity: 24 },
    ]);
    const files = await exportFiles(makeDb(source));
    const descriptor = JSON.parse(strFromU8(files.get(LODGE_JSON)!)) as Record<string, unknown>;
    expect(descriptor.capacity).toBe(24);

    const target = world([], []);
    const plan = await lodgeConfigImporter.plan(planCtx(makeDb(target), files));
    expect(plan.errors).toEqual([]);

    await lodgeConfigImporter.apply(applyCtx(makeDb(target), files));
    expect(target.settingsCreates).toEqual([
      { id: "lodge-new", lodgeId: "lodge-new", capacity: 24, updatedByMemberId: "admin-1" },
    ]);
  });

  it("exports the legacy default row's capacity for the lodge it serves", async () => {
    const source = world([{ id: "lodge-main", slug: "main" }], [
      { id: "default", lodgeId: "lodge-main", capacity: 30 },
    ]);
    const files = await exportFiles(makeDb(source));
    expect(JSON.parse(strFromU8(files.get(LODGE_JSON)!)).capacity).toBe(30);
  });

  it("omits capacity from the export when the lodge has none set", async () => {
    const files = await exportFiles(makeDb(world([{ id: "lodge-main", slug: "main" }], [])));
    expect("capacity" in JSON.parse(strFromU8(files.get(LODGE_JSON)!))).toBe(false);
  });

  it("imports an older bundle without the field exactly as before: no settings write", async () => {
    const files = bundleWith({});
    const created = world([], []);
    expect((await lodgeConfigImporter.plan(planCtx(makeDb(created), files))).errors).toEqual([]);
    await lodgeConfigImporter.apply(applyCtx(makeDb(created), files));
    expect(created.settingsCreates).toEqual([]);

    const existing = world([{ id: "lodge-main", slug: "main" }], [
      { id: "lodge-main", lodgeId: "lodge-main", capacity: 12 },
    ]);
    const result = await lodgeConfigImporter.apply(applyCtx(makeDb(existing), files));
    expect(existing.settingsCreates).toEqual([]);
    expect(existing.settingsUpdates).toEqual([]);
    expect(existing.settings.get("lodge-main")?.capacity).toBe(12);
    expect(result.unchanged).toBe(1);
  });

  it.each([
    ["zero", 0],
    ["above the bound", 100_001],
    ["fractional", 2.5],
    ["a string", "12"],
    ["a boolean", true],
  ])("refuses a capacity that is %s as a blocking plan error", async (_label, capacity) => {
    const plan = await lodgeConfigImporter.plan(
      planCtx(makeDb(world([], [])), bundleWith({ capacity })),
    );
    expect(plan.errors).toEqual([
      expect.stringMatching(/lodge\.json: capacity must be a whole number from 1 to 100,000/),
    ]);
  });

  it("edits an existing lodge's own row, and reports the lodge as updated", async () => {
    const w = world([{ id: "lodge-main", slug: "main" }], [
      { id: "lodge-main", lodgeId: "lodge-main", capacity: 12 },
      { id: "default", lodgeId: "lodge-other", capacity: 99 },
    ]);
    const files = bundleWith({ capacity: 20 });
    const plan = await lodgeConfigImporter.plan(planCtx(makeDb(w), files));
    expect(plan.items.find((i) => i.entity === "lodge")).toMatchObject({
      action: "update",
      changedFields: ["capacity"],
    });

    const result = await lodgeConfigImporter.apply(applyCtx(makeDb(w), files));
    expect(w.settingsUpdates).toEqual([
      { id: "lodge-main", data: { capacity: 20, updatedByMemberId: "admin-1" } },
    ]);
    expect(w.settings.get("default")?.capacity).toBe(99);
    expect(result.updated).toBe(1);
  });

  it("edits the legacy default row for the lodge it serves, and never both rows", async () => {
    const w = world([{ id: "lodge-main", slug: "main" }], [
      { id: "default", lodgeId: "lodge-main", capacity: 30 },
    ]);
    await lodgeConfigImporter.apply(applyCtx(makeDb(w), bundleWith({ capacity: 40 })));
    expect(w.settingsCreates).toEqual([]);
    expect(w.settingsUpdates).toEqual([
      { id: "default", data: { capacity: 40, updatedByMemberId: "admin-1" } },
    ]);
  });

  it("gives an existing lodge its own row when the legacy row serves another lodge", async () => {
    const w = world([{ id: "lodge-main", slug: "main" }], [
      { id: "default", lodgeId: "lodge-other", capacity: 30 },
    ]);
    await lodgeConfigImporter.apply(applyCtx(makeDb(w), bundleWith({ capacity: 16 })));
    expect(w.settingsUpdates).toEqual([]);
    expect(w.settingsCreates).toEqual([
      { id: "lodge-main", lodgeId: "lodge-main", capacity: 16, updatedByMemberId: "admin-1" },
    ]);
  });

  it("writes nothing when the bundle's capacity matches the lodge's", async () => {
    const w = world([{ id: "lodge-main", slug: "main" }], [
      { id: "lodge-main", lodgeId: "lodge-main", capacity: 12 },
    ]);
    const result = await lodgeConfigImporter.apply(applyCtx(makeDb(w), bundleWith({ capacity: 12 })));
    expect(w.settingsUpdates).toEqual([]);
    expect(result.unchanged).toBe(1);
  });
});
