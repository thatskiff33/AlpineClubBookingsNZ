import { describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8 } from "fflate";

vi.mock("server-only", () => ({}));

import {
  lodgeConfigExporter,
  lodgeConfigImporter,
} from "@/lib/config-transfer/categories/lodge-config";
import type { TxDb } from "@/lib/config-transfer/import-types";
import { loadLodgeCapacityOverride, loadSchoolHutLeaderKinds } from "@/lib/lodge-settings";

// #3819 review: "Who can be hut leader for school bookings" is portable per
// lodge. Each lodge.json carries the four ticks the lodge resolves to, the way
// its capacity does (#3407); an import writes them to the row the resolver
// reads; and an OLDER bundle's club-wide teacher switch is mapped onto every
// imported lodge's teacher tick rather than ignored.

const LODGE_JSON = "lodge-config/lodges/main/lodge.json";

interface SettingsRow {
  id: string;
  lodgeId: string | null;
  capacity: number | null;
  schoolGroupSoftCap?: number | null;
  schoolHutLeaderTeacherOnBooking?: boolean;
  schoolHutLeaderCustodian?: boolean;
  schoolHutLeaderMemberOnBooking?: boolean;
  schoolHutLeaderMemberStayingSeparately?: boolean;
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
        w.settings.set(data.id, { ...data });
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

type Mode = "merge" | "overwrite";
const MODES: Mode[] = ["merge", "overwrite"];

function planCtx(db: TxDb, files: Map<string, Uint8Array>, mode: Mode = "merge") {
  return {
    db,
    files,
    manifest: {} as never,
    mode,
    resolutions: new Map<string, string>(),
  } as never;
}

function applyCtx(tx: TxDb, files: Map<string, Uint8Array>, mode: Mode = "merge") {
  return {
    tx,
    files,
    manifest: {} as never,
    mode,
    resolutions: new Map<string, string>(),
    actorMemberId: "admin-1",
    imageRemap: new Map<string, string>(),
    notes: { doorCodesWritten: [] as string[] },
  } as never;
}

const TICKED_ROW = {
  schoolHutLeaderTeacherOnBooking: true,
  schoolHutLeaderCustodian: false,
  schoolHutLeaderMemberOnBooking: true,
  schoolHutLeaderMemberStayingSeparately: false,
};
const TICKED = {
  teacherOnBooking: true,
  custodian: false,
  memberOnBooking: true,
  memberStayingSeparately: false,
};
const DEFAULTS = {
  teacherOnBooking: false,
  custodian: true,
  memberOnBooking: true,
  memberStayingSeparately: true,
};

describe("config transfer carries each lodge's school hut-leader ticks (#3819)", () => {
  it("exports the ticks the lodge resolves to", async () => {
    const source = world([{ id: "lodge-main", slug: "main" }], [
      { id: "lodge-main", lodgeId: "lodge-main", capacity: 24, ...TICKED_ROW },
    ]);
    const files = await exportFiles(makeDb(source));
    expect(JSON.parse(strFromU8(files.get(LODGE_JSON)!)).schoolHutLeaderKinds).toEqual(TICKED);
  });

  it.each(MODES)("imports a lodge.json's ticks onto the lodge's own row, previewed as a change (%s)", async (mode) => {
    const target = world([{ id: "lodge-main", slug: "main" }], [
      { id: "lodge-main", lodgeId: "lodge-main", capacity: 12 },
    ]);
    const db = makeDb(target);
    const files = bundleWith({ schoolHutLeaderKinds: TICKED });

    const plan = await lodgeConfigImporter.plan(planCtx(db, files, mode));
    expect(plan.errors).toEqual([]);
    expect(plan.items.find((item) => item.entity === "lodge")?.changedFields).toContain("schoolHutLeaderKinds");

    await lodgeConfigImporter.apply(applyCtx(db, files, mode));
    expect(await loadSchoolHutLeaderKinds(db as never, "lodge-main")).toEqual(TICKED);
    expect(await loadLodgeCapacityOverride(db as never, "lodge-main")).toBe(12);
  });

  it("maps an older bundle's club-wide teacher switch onto the lodge's teacher tick", async () => {
    const target = world([{ id: "lodge-main", slug: "main" }], [
      { id: "lodge-main", lodgeId: "lodge-main", capacity: 12, schoolHutLeaderCustodian: false },
    ]);
    const db = makeDb(target);
    const files = bundleWith({});
    files.set(
      "club-settings/booking-request-settings.json",
      strToU8(JSON.stringify({ assignSchoolTeachersAsHutLeaders: true })),
    );

    const plan = await lodgeConfigImporter.plan(planCtx(db, files));
    expect(plan.items.find((item) => item.entity === "lodge")?.changedFields).toContain("schoolHutLeaderKinds");
    await lodgeConfigImporter.apply(applyCtx(db, files));

    // Only the teacher tick moves; the lodge's other ticks are its own.
    expect(await loadSchoolHutLeaderKinds(db as never, "lodge-main")).toEqual({
      ...DEFAULTS,
      teacherOnBooking: true,
      custodian: false,
    });
  });

  it("leaves the ticks alone when the bundle carries neither", async () => {
    const target = world([{ id: "lodge-main", slug: "main" }], [
      { id: "lodge-main", lodgeId: "lodge-main", capacity: 12, ...TICKED_ROW },
    ]);
    const db = makeDb(target);
    await lodgeConfigImporter.apply(applyCtx(db, bundleWith({})));
    expect(await loadSchoolHutLeaderKinds(db as never, "lodge-main")).toEqual(TICKED);
    expect(target.settingsUpdates).toEqual([]);
  });

  it.each([
    ["a missing kind", { teacherOnBooking: true }],
    ["a non-boolean", { ...TICKED, custodian: "yes" }],
    ["an unknown kind", { ...TICKED, everyone: true }],
    ["not an object", "teachers"],
  ])("refuses %s in the preview", async (_label, value) => {
    const db = makeDb(world([{ id: "lodge-main", slug: "main" }], []));
    const plan = await lodgeConfigImporter.plan(planCtx(db, bundleWith({ schoolHutLeaderKinds: value })));
    expect(plan.errors.join(" ")).toMatch(/schoolHutLeaderKinds must give each of/);
  });
});
