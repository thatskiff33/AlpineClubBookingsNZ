import { strToU8, strFromU8 } from "fflate";

import type { BundleEntry } from "../bundle";
import {
  cleanedLiteralWarning,
  stripCleanedLiterals,
} from "../cleaned-literals";
import { serialiseCsv } from "../csv";
import { registerEntity } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  applyRow,
  changedFields,
  hashRow,
  planActionFor,
  resolutionKey,
  updateDataForMode,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  type PlanContext,
  type PlanItem,
  type ReadDb,
} from "../import-types";
import { RowValidator, asStr, coerceBool, nz, readCsvRows } from "../values";

// lodge-config category (part 1): lodges + their rooms + beds + seasons + rates
// — the structural "multi-lodge" core. Each lodge is a self-contained folder,
//   lodge-config/lodges/<slug>/
//     lodge.json          { slug, name, active, travelNote, isDefault, doorCode? }
//     rooms.csv           name, sortOrder, active, notes
//     beds.csv            roomName, name, sortOrder, active
//     seasons.csv         name, type, startDate, endDate, active,
//                         flatWholeLodgeNightCents (#2338; blank = no flat
//                         whole-lodge rate — whole-lodge bookings then price
//                         per guest)
//     season-rates.csv    seasonName, membershipTypeKey, ageTier, pricePerNightCents
//                         (ageTier blank = a flat type's single all-ages rate)
//     Rates are keyed by membership type (#1930, E4). The old-bundle IMPORT
//     compat for the legacy `isMember` column closed one release after the E13
//     contraction (#2131): a bundle carrying that shape is now REJECTED with a
//     clear validation error, never silently mapped (re-export it from an
//     install running the current release).
// so the lodge a row belongs to is implied by the folder (not a CSV column).
// The authoritative slug is lodge.json's `slug` — the folder name is just a
// container.
//
// Row validation is strict and BLOCKS apply (plan errors): malformed dates,
// enums, and money never reach a write; blank cells are only legal where merge
// mode would keep the existing value. Per-lodge capacity stays out of scope;
// allocation settings are handled by the ordered companion module. ADR-001/002.

/** Every per-lodge folder lives under this prefix. */
export const LODGES_PREFIX = "lodge-config/lodges/";

const LODGE_JSON = "lodge.json";
const ROOMS_CSV = "rooms.csv";
const BEDS_CSV = "beds.csv";
const SEASONS_CSV = "seasons.csv";
const RATES_CSV = "season-rates.csv";
export const BED_ALLOCATION_SETTINGS_FILE = "bed-allocation-settings.json";

const LODGE_FIELDS = [
  "slug", "name", "active", "travelNote", "doorCode", "isDefault",
  // Lobby display settings (fork epic #25 / issue #50): the per-lodge
  // {{config:<key>}} glob, the name-granularity override, and the committee
  // notice travel with the lodge descriptor.
  "displayConfig", "displayNameGranularity", "displayNotice",
  // Whether opted-in adult guest phone numbers may show on the public lobby
  // display (#137 / #37). Travels with the lodge descriptor like the other
  // per-lodge display settings.
  "showGuestPhonesOnScreens",
] as const;

const DISPLAY_GRANULARITIES = [
  "FULL_NAME", "FIRST_NAME_SURNAME_INITIAL", "FIRST_NAME_ONLY", "COUNTS_ONLY",
] as const;
const DISPLAY_CONFIG_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DISPLAY_CONFIG_VALUE_MAX = 500;
const DISPLAY_NOTICE_MAX = 2000;
const ROOM_FIELDS = ["name", "sortOrder", "active", "notes"] as const;
const BED_FIELDS = ["roomName", "name", "sortOrder", "active", "bedType", "bunkGroup"] as const;
// `flatWholeLodgeNightCents` (#2338) is a per-season scalar, so it rides in
// seasons.csv beside the window fields — NOT season-rates.csv, which is keyed
// per membership type. Blank cell = no flat rate (null); a whole number of
// cents otherwise. A pre-#2338 bundle simply omits the column, which imports as
// "leave unset", so old bundles keep restoring cleanly.
const SEASON_FIELDS = [
  "name", "type", "startDate", "endDate", "active", "flatWholeLodgeNightCents",
] as const;
const RATE_FIELDS = ["seasonName", "membershipTypeKey", "ageTier", "pricePerNightCents"] as const;

/** Folder-name segment for a lodge slug (slugs are url-safe; guard anyway). */
export function folderSegment(slug: string): string {
  return slug.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** The eight possible file paths inside one lodge folder segment. */
export function lodgeFolderFiles(segment: string) {
  const base = `${LODGES_PREFIX}${segment}`;
  return {
    lodge: `${base}/${LODGE_JSON}`,
    rooms: `${base}/${ROOMS_CSV}`,
    beds: `${base}/${BEDS_CSV}`,
    seasons: `${base}/${SEASONS_CSV}`,
    rates: `${base}/${RATES_CSV}`,
    instructions: `${base}/instructions.csv`,
    choreTemplates: `${base}/chore-templates.csv`,
    bedAllocationSettings: `${base}/${BED_ALLOCATION_SETTINGS_FILE}`,
  };
}

/** Folder segments present in the bundle, sorted for deterministic apply order. */
export function lodgeFolderSegments(files: Map<string, Uint8Array>): string[] {
  const set = new Set<string>();
  for (const path of files.keys()) {
    if (!path.startsWith(LODGES_PREFIX)) continue;
    const seg = path.slice(LODGES_PREFIX.length).split("/")[0];
    if (seg) set.add(seg);
  }
  return [...set].sort();
}

/** Read a lodge.json descriptor as a loose record (tolerant for hand-editing). */
function readLodgeJson(
  files: Map<string, Uint8Array>,
  path: string,
): Record<string, unknown> | null {
  const bytes = files.get(path);
  if (!bytes) return null;
  try {
    const value = JSON.parse(strFromU8(bytes));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The authoritative lodge slug for a folder segment, from its lodge.json. */
export function folderLodgeSlug(
  files: Map<string, Uint8Array>,
  segment: string,
): string | null {
  const descriptor = readLodgeJson(files, lodgeFolderFiles(segment).lodge);
  const slug = asStr(descriptor?.slug);
  return slug || null;
}

/** date-only (@db.Date): serialise as YYYY-MM-DD. */
function toDateStr(value: Date | null | undefined): string {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}

function asNullableStr(value: unknown): string | null {
  const s = asStr(value);
  return s === "" ? null : s;
}

registerEntity({
  entity: "lodge",
  category: "lodge-config",
  tier: "key-strong",
  format: "json",
  file: `${LODGES_PREFIX}<slug>/${LODGE_JSON}`,
  naturalKey: ["slug"],
  singleton: false,
  fields: [...LODGE_FIELDS],
  optInFields: ["doorCode"],
});
registerEntity({
  entity: "lodge-room",
  category: "lodge-config",
  tier: "key-strong",
  format: "csv",
  file: `${LODGES_PREFIX}<slug>/${ROOMS_CSV}`,
  naturalKey: ["name"],
  singleton: false,
  fields: [...ROOM_FIELDS],
});
registerEntity({
  entity: "lodge-bed",
  category: "lodge-config",
  tier: "key-strong",
  format: "csv",
  file: `${LODGES_PREFIX}<slug>/${BEDS_CSV}`,
  naturalKey: ["roomName", "name"],
  singleton: false,
  fields: [...BED_FIELDS],
});
registerEntity({
  entity: "season",
  category: "lodge-config",
  tier: "key-weak",
  format: "csv",
  file: `${LODGES_PREFIX}<slug>/${SEASONS_CSV}`,
  naturalKey: ["name"],
  singleton: false,
  fields: [...SEASON_FIELDS],
});
registerEntity({
  entity: "season-rate",
  category: "lodge-config",
  tier: "key-strong",
  format: "csv",
  file: `${LODGES_PREFIX}<slug>/${RATES_CSV}`,
  naturalKey: ["seasonName", "membershipTypeKey", "ageTier"],
  singleton: false,
  fields: [...RATE_FIELDS],
});

// ---- Shared write-data builders + batched current-state loading -------------
//
// Plan (for the change diff) and apply (for the write) share the SAME builders
// and the SAME batched lookups, so the dry-run cannot drift from what apply
// does, and neither side issues per-row queries.

function buildLodgeData(descriptor: Record<string, unknown>, slug: string): Record<string, unknown> {
  const data: Record<string, unknown> = {
    name: asStr(descriptor.name) || slug,
    active: coerceBool(descriptor.active),
    travelNote: asNullableStr(descriptor.travelNote),
  };
  if ("doorCode" in descriptor) data.doorCode = asNullableStr(descriptor.doorCode);
  // Display settings: written only when the descriptor carries the key (hand
  // authors omit a key to leave the value alone in merge mode). A null
  // displayConfig writes the empty glob — Prisma Json columns reject JS null.
  if ("displayNameGranularity" in descriptor) {
    data.displayNameGranularity = asNullableStr(descriptor.displayNameGranularity);
  }
  if ("displayConfig" in descriptor) {
    data.displayConfig =
      descriptor.displayConfig && typeof descriptor.displayConfig === "object"
        ? descriptor.displayConfig
        : {};
  }
  if ("displayNotice" in descriptor) {
    data.displayNotice = asNullableStr(descriptor.displayNotice);
  }
  if ("showGuestPhonesOnScreens" in descriptor) {
    data.showGuestPhonesOnScreens = coerceBool(descriptor.showGuestPhonesOnScreens);
  }
  return data;
}

interface LodgeCurrent {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  travelNote: string | null;
  doorCode: string | null;
  isDefault: boolean;
  displayConfig: unknown;
  displayNameGranularity: string | null;
  displayNotice: string | null;
  showGuestPhonesOnScreens: boolean;
}
interface SeasonCurrent {
  id: string;
  lodgeId: string;
  name: string;
  type: string;
  startDate: Date;
  endDate: Date;
  active: boolean;
  // Flat whole-lodge night rate in integer cents, or null when unset (#2338).
  flatWholeLodgeNightCents: number | null;
}
interface LodgeBatch {
  lodges: Map<string, LodgeCurrent>; // by slug
  rooms: Map<string, { id: string; sortOrder: number; active: boolean; notes: string | null }>; // lodgeId/name
  beds: Map<string, { id: string; sortOrder: number; active: boolean; bedType: string; bunkGroup: string | null }>; // lodgeId/roomName/name
  seasons: Map<string, SeasonCurrent>; // lodgeId/name (first match)
  seasonsById: Map<string, SeasonCurrent>;
  seasonsByLodge: Map<string, Array<{ id: string; name: string; startDate: Date; endDate: Date }>>;
  rates: Map<string, { id: string; pricePerNightCents: number }>; // lodgeId/seasonName/membershipTypeKey/ageTierOrEmpty
  membershipTypeIdByKey: Map<string, string>; // club-wide key -> id (for rate apply)
  // Full descriptors for import validation (#1930, E4): rate rows may only
  // target rate-bearing types (D2 invariant) and must match the type's
  // ageGroupsApply shape.
  membershipTypesByKey: Map<
    string,
    { id: string; bookingBehavior: string; ageGroupsApply: boolean }
  >;
  currentDefaultSlug: string | null;
}

/** One findMany per entity for every lodge the bundle touches. */
async function loadLodgeBatch(db: ReadDb, slugs: string[]): Promise<LodgeBatch> {
  const lodgeRows = await db.lodge.findMany({
    where: { slug: { in: slugs } },
    select: {
      id: true, slug: true, name: true, active: true, travelNote: true,
      doorCode: true, isDefault: true,
      displayConfig: true, displayNameGranularity: true, displayNotice: true,
      showGuestPhonesOnScreens: true,
    },
  });
  const lodges = new Map(lodgeRows.map((l) => [l.slug, l]));
  const lodgeIds = lodgeRows.map((l) => l.id);

  const [roomRows, bedRows, seasonRows, rateRows, membershipTypeRows, currentDefault] = await Promise.all([
    db.lodgeRoom.findMany({
      where: { lodgeId: { in: lodgeIds } },
      select: { id: true, lodgeId: true, name: true, sortOrder: true, active: true, notes: true },
    }),
    db.lodgeBed.findMany({
      where: { room: { lodgeId: { in: lodgeIds } } },
      select: { id: true, name: true, sortOrder: true, active: true, bedType: true, bunkGroup: true, room: { select: { lodgeId: true, name: true } } },
    }),
    db.season.findMany({
      where: { lodgeId: { in: lodgeIds } },
      orderBy: [{ startDate: "asc" }, { id: "asc" }],
      select: { id: true, lodgeId: true, name: true, type: true, startDate: true, endDate: true, active: true, flatWholeLodgeNightCents: true },
    }),
    // Membership-type-keyed rates (#1930, E4) — the only hut-rate table; the
    // legacy SeasonRate table was dropped by #2129 step 2.
    db.membershipTypeSeasonRate.findMany({
      where: { season: { lodgeId: { in: lodgeIds } } },
      select: {
        id: true,
        ageTier: true,
        pricePerNightCents: true,
        membershipType: { select: { key: true } },
        season: { select: { lodgeId: true, name: true } },
      },
    }),
    db.membershipType.findMany({
      select: { id: true, key: true, bookingBehavior: true, ageGroupsApply: true },
    }),
    db.lodge.findFirst({ where: { isDefault: true }, select: { slug: true } }),
  ]);

  const rooms = new Map(roomRows.map((r) => [`${r.lodgeId}/${r.name}`, r]));
  const beds = new Map(bedRows.map((b) => [`${b.room.lodgeId}/${b.room.name}/${b.name}`, b]));
  const seasons = new Map<string, SeasonCurrent>();
  const seasonsById = new Map<string, SeasonCurrent>();
  const seasonsByLodge = new Map<string, Array<{ id: string; name: string; startDate: Date; endDate: Date }>>();
  for (const s of seasonRows) {
    const key = `${s.lodgeId}/${s.name}`;
    if (!seasons.has(key)) seasons.set(key, s); // key-weak: first match wins
    seasonsById.set(s.id, s);
    const list = seasonsByLodge.get(s.lodgeId) ?? [];
    list.push({ id: s.id, name: s.name, startDate: s.startDate, endDate: s.endDate });
    seasonsByLodge.set(s.lodgeId, list);
  }
  const rates = new Map(
    rateRows.map((r) => [
      `${r.season.lodgeId}/${r.season.name}/${r.membershipType.key}/${r.ageTier ?? ""}`,
      { id: r.id, pricePerNightCents: r.pricePerNightCents },
    ]),
  );
  const membershipTypeIdByKey = new Map(
    membershipTypeRows.map((t) => [t.key, t.id]),
  );
  const membershipTypesByKey = new Map(
    membershipTypeRows.map((t) => [
      t.key,
      { id: t.id, bookingBehavior: t.bookingBehavior, ageGroupsApply: t.ageGroupsApply },
    ]),
  );

  return {
    lodges,
    rooms,
    beds,
    seasons,
    seasonsById,
    seasonsByLodge,
    rates,
    membershipTypeIdByKey,
    membershipTypesByKey,
    currentDefaultSlug: currentDefault?.slug ?? null,
  };
}

// The slug the bundle designates as the default lodge (first lodge.json with
// isDefault=true), or null. isDefault is applied by a dedicated clear-then-set
// pass (never the per-lodge upsert): at most one lodge may be flagged
// (Lodge_isDefault_key). We only ever SET a default, never clear to none.
function bundleDesignatedDefaultSlug(files: Map<string, Uint8Array>): string | null {
  for (const segment of lodgeFolderSegments(files)) {
    const descriptor = readLodgeJson(files, lodgeFolderFiles(segment).lodge);
    if (descriptor && asStr(descriptor.slug) && coerceBool(descriptor.isDefault)) {
      return asStr(descriptor.slug);
    }
  }
  return null;
}

// ---- Export ----------------------------------------------------------------

export const lodgeConfigExporter: CategoryExporter = {
  category: "lodge-config",
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const lodges = await ctx.db.lodge.findMany({
      orderBy: { slug: "asc" },
      select: {
        slug: true, name: true, active: true, travelNote: true,
        doorCode: true, isDefault: true,
        displayConfig: true, displayNameGranularity: true, displayNotice: true,
      showGuestPhonesOnScreens: true,
      },
    });
    const rooms = await ctx.db.lodgeRoom.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { name: true, sortOrder: true, active: true, notes: true, lodge: { select: { slug: true } } },
    });
    const beds = await ctx.db.lodgeBed.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { name: true, sortOrder: true, active: true, bedType: true, bunkGroup: true, room: { select: { name: true, lodge: { select: { slug: true } } } } },
    });
    const seasons = await ctx.db.season.findMany({
      orderBy: [{ startDate: "asc" }, { name: "asc" }],
      select: { name: true, type: true, startDate: true, endDate: true, active: true, flatWholeLodgeNightCents: true, lodge: { select: { slug: true } } },
    });
    const rates = await ctx.db.membershipTypeSeasonRate.findMany({
      orderBy: [{ membershipTypeId: "asc" }, { ageTier: "asc" }],
      select: {
        ageTier: true,
        pricePerNightCents: true,
        membershipType: { select: { key: true } },
        season: { select: { name: true, lodge: { select: { slug: true } } } },
      },
    });

    const bySlug = <T>() => new Map<string, T[]>();
    const roomsBy = bySlug<Record<string, unknown>>();
    const bedsBy = bySlug<Record<string, unknown>>();
    const seasonsBy = bySlug<Record<string, unknown>>();
    const ratesBy = bySlug<Record<string, unknown>>();
    const push = <T>(map: Map<string, T[]>, slug: string, row: T) => {
      const list = map.get(slug) ?? [];
      list.push(row);
      map.set(slug, list);
    };
    for (const r of rooms) push(roomsBy, r.lodge.slug, { name: r.name, sortOrder: r.sortOrder, active: r.active, notes: r.notes });
    for (const b of beds) push(bedsBy, b.room.lodge.slug, { roomName: b.room.name, name: b.name, sortOrder: b.sortOrder, active: b.active, bedType: b.bedType, bunkGroup: b.bunkGroup });
    for (const s of seasons) push(seasonsBy, s.lodge.slug, { name: s.name, type: s.type, startDate: toDateStr(s.startDate), endDate: toDateStr(s.endDate), active: s.active, flatWholeLodgeNightCents: s.flatWholeLodgeNightCents ?? "" });
    for (const r of rates) push(ratesBy, r.season.lodge.slug, { seasonName: r.season.name, membershipTypeKey: r.membershipType.key, ageTier: r.ageTier ?? "", pricePerNightCents: r.pricePerNightCents });

    const entries: BundleEntry[] = [];
    for (const lodge of lodges) {
      const paths = lodgeFolderFiles(folderSegment(lodge.slug));
      const descriptor: Record<string, unknown> = {
        slug: lodge.slug,
        name: lodge.name,
        active: lodge.active,
        travelNote: lodge.travelNote,
        isDefault: lodge.isDefault,
        displayConfig: lodge.displayConfig ?? null,
        displayNameGranularity: lodge.displayNameGranularity,
        displayNotice: lodge.displayNotice,
        showGuestPhonesOnScreens: lodge.showGuestPhonesOnScreens,
      };
      if (ctx.includeDoorCodes) descriptor.doorCode = lodge.doorCode;
      entries.push({
        path: paths.lodge,
        category: "lodge-config",
        rowCount: null,
        bytes: strToU8(JSON.stringify(descriptor, null, 2)),
      });

      // Always emit the full per-lodge skeleton (header-only when empty) so a
      // lodge folder captures the entire lodge config and the format is
      // self-documenting for hand-authoring from scratch.
      const emit = (path: string, fields: readonly string[], rows: Record<string, unknown>[]) => {
        entries.push({ path, category: "lodge-config", rowCount: rows.length, bytes: strToU8(serialiseCsv([...fields], rows)) });
      };
      emit(paths.rooms, ROOM_FIELDS, roomsBy.get(lodge.slug) ?? []);
      emit(paths.beds, BED_FIELDS, bedsBy.get(lodge.slug) ?? []);
      emit(paths.seasons, SEASON_FIELDS, seasonsBy.get(lodge.slug) ?? []);
      emit(paths.rates, RATE_FIELDS, ratesBy.get(lodge.slug) ?? []);
    }

    return entries;
  },
};

// ---- Row parsing (shared by plan + apply; validation errors block apply) ----

interface ParsedLodgeRows {
  slug: string;
  descriptor: Record<string, unknown>;
  rooms: Array<{ raw: Record<string, string>; name: string; data: Record<string, unknown> }>;
  beds: Array<{ raw: Record<string, string>; roomName: string; name: string; data: Record<string, unknown> }>;
  seasons: Array<{ raw: Record<string, string>; name: string; data: Record<string, unknown> }>;
  rates: Array<{ raw: Record<string, string>; seasonName: string; membershipTypeKey: string; ageTier: string | null; data: Record<string, unknown> }>;
}

/**
 * Parse + strictly validate one lodge folder's rows. `blankOk(current)` cells:
 * a blank enum/date/bool/int/money cell is legal only when merge mode will keep
 * an existing row's value; on a create (or in overwrite mode) it is an error.
 * Malformed non-blank values are always errors. Invalid rows are EXCLUDED from
 * the returned sets (and, because errors block apply, never written).
 */
function parseLodgeFolder(
  files: Map<string, Uint8Array>,
  segment: string,
  ctxMode: "merge" | "overwrite",
  batch: LodgeBatch,
  errors: string[],
): ParsedLodgeRows | null {
  const paths = lodgeFolderFiles(segment);
  const descriptor = readLodgeJson(files, paths.lodge);
  if (!descriptor || !asStr(descriptor.slug)) {
    errors.push(
      `${paths.lodge}: missing or unreadable lodge.json (a valid {"slug": ...} descriptor is required)`,
    );
    return null;
  }
  const slug = asStr(descriptor.slug);
  const lodge = batch.lodges.get(slug) ?? null;
  const lodgeId = lodge?.id ?? null;

  // Display settings validation (issue #50): invalid values are errors (which
  // block apply) and the offending key is dropped so no partial write occurs.
  if ("displayNameGranularity" in descriptor && descriptor.displayNameGranularity !== null) {
    const value = asStr(descriptor.displayNameGranularity);
    if (!(DISPLAY_GRANULARITIES as readonly string[]).includes(value)) {
      errors.push(
        `${paths.lodge}: displayNameGranularity must be one of ${DISPLAY_GRANULARITIES.join(", ")} or null`,
      );
      delete descriptor.displayNameGranularity;
    }
  }
  if ("displayConfig" in descriptor && descriptor.displayConfig !== null) {
    const config = descriptor.displayConfig;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      errors.push(`${paths.lodge}: displayConfig must be an object of string values or null`);
      delete descriptor.displayConfig;
    } else {
      for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
        if (!DISPLAY_CONFIG_KEY_PATTERN.test(key)) {
          errors.push(`${paths.lodge}: displayConfig key "${key}" must be a lower-case slug (max 64 chars)`);
          delete descriptor.displayConfig;
          break;
        }
        if (typeof value !== "string" || value.length > DISPLAY_CONFIG_VALUE_MAX) {
          errors.push(
            `${paths.lodge}: displayConfig value for "${key}" must be text of at most ${DISPLAY_CONFIG_VALUE_MAX} characters`,
          );
          delete descriptor.displayConfig;
          break;
        }
      }
    }
  }
  if ("displayNotice" in descriptor && descriptor.displayNotice !== null) {
    const notice = descriptor.displayNotice;
    if (typeof notice !== "string" || notice.length > DISPLAY_NOTICE_MAX) {
      errors.push(`${paths.lodge}: displayNotice must be text of at most ${DISPLAY_NOTICE_MAX} characters or null`);
      delete descriptor.displayNotice;
    }
  }
  if (
    "showGuestPhonesOnScreens" in descriptor &&
    typeof descriptor.showGuestPhonesOnScreens !== "boolean"
  ) {
    errors.push(`${paths.lodge}: showGuestPhonesOnScreens must be true or false`);
    delete descriptor.showGuestPhonesOnScreens;
  }

  const out: ParsedLodgeRows = { slug, descriptor, rooms: [], beds: [], seasons: [], rates: [] };

  readCsvRows(files, paths.rooms).forEach((raw, i) => {
    const v = new RowValidator(paths.rooms, i, errors);
    const name = v.required("name", raw.name);
    const current = lodgeId ? batch.rooms.get(`${lodgeId}/${name}`) : null;
    const blankOk = ctxMode === "merge" && !!current;
    const sortOrder = blankOk && nz(raw.sortOrder) === null ? 0 : v.int("sortOrder", raw.sortOrder);
    const active = blankOk && nz(raw.active) === null ? false : v.bool("active", raw.active);
    if (!v.ok) return;
    out.rooms.push({ raw, name, data: { sortOrder, active, notes: nz(raw.notes) } });
  });

  readCsvRows(files, paths.beds).forEach((raw, i) => {
    const v = new RowValidator(paths.beds, i, errors);
    const roomName = v.required("roomName", raw.roomName);
    const name = v.required("name", raw.name);
    const current = lodgeId ? batch.beds.get(`${lodgeId}/${roomName}/${name}`) : null;
    const blankOk = ctxMode === "merge" && !!current;
    const sortOrder = blankOk && nz(raw.sortOrder) === null ? 0 : v.int("sortOrder", raw.sortOrder);
    const active = blankOk && nz(raw.active) === null ? false : v.bool("active", raw.active);
    // bedType has a DB default (SINGLE): blank means the default on create/
    // overwrite and keep-existing in merge (same treatment as the chore enums).
    const bedType = nz(raw.bedType) === null ? "SINGLE" : v.enum("bedType", "BedType", raw.bedType);
    if (!v.ok) return;
    out.beds.push({ raw, roomName, name, data: { sortOrder, active, bedType: bedType as never, bunkGroup: nz(raw.bunkGroup) } });
  });

  readCsvRows(files, paths.seasons).forEach((raw, i) => {
    const v = new RowValidator(paths.seasons, i, errors);
    const name = v.required("name", raw.name);
    const current = lodgeId ? batch.seasons.get(`${lodgeId}/${name}`) : null;
    const blankOk = ctxMode === "merge" && !!current;
    const type = blankOk && nz(raw.type) === null ? "" : v.enum("type", "SeasonType", raw.type);
    const startDate = blankOk && nz(raw.startDate) === null ? new Date(0) : v.date("startDate", raw.startDate);
    const endDate = blankOk && nz(raw.endDate) === null ? new Date(0) : v.date("endDate", raw.endDate);
    const active = blankOk && nz(raw.active) === null ? false : v.bool("active", raw.active);
    // #2338 flat whole-lodge rate: NULLABLE, so a blank cell is ALWAYS legal and
    // means "no flat rate" (null) — no blankOk gate, unlike the fields above. A
    // present cell must be a whole number of cents. In merge mode a blank cell
    // still leaves an existing value untouched (updateDataForMode drops blank
    // raws); in overwrite mode a blank cell clears it to null.
    const flatWholeLodgeNightCents =
      nz(raw.flatWholeLodgeNightCents) === null
        ? null
        : v.moneyCents("flatWholeLodgeNightCents", raw.flatWholeLodgeNightCents);
    if (!v.ok) return;
    out.seasons.push({ raw, name, data: { type: type as never, startDate, endDate, active, flatWholeLodgeNightCents } });
  });

  // Row numbers below are `i + 2` — the physical CSV line (header is line 1) —
  // matching RowValidator, so every error about the same row names one line.
  readCsvRows(files, paths.rates).forEach((raw, i) => {
    const v = new RowValidator(paths.rates, i, errors);
    const seasonName = v.required("seasonName", raw.seasonName);

    // Membership-type key (#1930, E4). The legacy pre-#1930 `isMember` column
    // (true -> FULL, false -> NON_MEMBER) is no longer imported — the compat
    // window closed one release after E13 (#2131) — so a bundle carrying that
    // shape is rejected here, never silently mapped.
    if (nz(raw.membershipTypeKey) === null && nz(raw.isMember) !== null) {
      errors.push(
        `${paths.rates}: row ${i + 2}: the legacy 'isMember' season-rate shape is no longer imported; re-export this bundle from an install running the current release`,
      );
      return;
    }
    const membershipTypeKey = v.required("membershipTypeKey", raw.membershipTypeKey);
    const membershipType = batch.membershipTypesByKey.get(membershipTypeKey);
    if (membershipTypeKey && !membershipType) {
      errors.push(
        `${paths.rates}: row ${i + 2}: unknown membership type "${membershipTypeKey}"`,
      );
    }

    // ageTier is optional: blank = a flat type's single all-ages rate (null).
    const ageTier = nz(raw.ageTier) === null ? null : v.enum("ageTier", "AgeTier", raw.ageTier);

    // D2 invariant + shape validation (#1930, E4). Both are blocking errors,
    // exactly like an unknown membership type: a NON_MEMBER_RATE type (other
    // than the built-in NON_MEMBER rate holder) or BLOCK_BOOKING type owns
    // ZERO rate rows, and a row's ageTier must match the type's
    // ageGroupsApply shape (per-tier rows for age-keyed types, one blank-tier
    // flat row for flat types).
    let rowShapeValid = true;
    if (membershipType) {
      const rateBearing =
        membershipType.bookingBehavior === "MEMBER_RATE" ||
        membershipTypeKey === "NON_MEMBER";
      if (!rateBearing) {
        errors.push(
          `${paths.rates}: row ${i + 2}: membership type "${membershipTypeKey}" does not carry its own hut rates (${membershipType.bookingBehavior} types own zero rate rows)`,
        );
        rowShapeValid = false;
      } else if (!membershipType.ageGroupsApply && ageTier !== null) {
        errors.push(
          `${paths.rates}: row ${i + 2}: membership type "${membershipTypeKey}" prices from a single flat rate — leave ageTier blank`,
        );
        rowShapeValid = false;
      } else if (membershipType.ageGroupsApply && ageTier === null) {
        errors.push(
          `${paths.rates}: row ${i + 2}: membership type "${membershipTypeKey}" uses per-age-tier rates — specify an ageTier`,
        );
        rowShapeValid = false;
      }
    }

    const current =
      lodgeId
        ? batch.rates.get(`${lodgeId}/${seasonName}/${membershipTypeKey}/${ageTier ?? ""}`)
        : null;
    const blankOk = ctxMode === "merge" && !!current;
    const pricePerNightCents =
      blankOk && nz(raw.pricePerNightCents) === null
        ? 0
        : v.moneyCents("pricePerNightCents", raw.pricePerNightCents);
    if (!v.ok || !membershipType || !rowShapeValid) return;
    out.rates.push({ raw, seasonName, membershipTypeKey, ageTier, data: { pricePerNightCents } });
  });

  return out;
}

// ---- Plan ------------------------------------------------------------------

async function planLodgeConfig(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];
  const doorCodeChanges: string[] = [];

  const segments = lodgeFolderSegments(ctx.files);
  const slugs = segments
    .map((seg) => folderLodgeSlug(ctx.files, seg))
    .filter((s): s is string => s !== null);
  const batch = await loadLodgeBatch(ctx.db, slugs);

  // The default-lodge designation is applied by a dedicated pass; fingerprint
  // the CURRENT default so a concurrent default change trips the drift guard.
  fingerprintParts.push(`default-lodge:${batch.currentDefaultSlug ?? "none"}`);

  for (const segment of segments) {
    const parsed = parseLodgeFolder(ctx.files, segment, ctx.mode, batch, errors);
    if (!parsed) continue;
    const { slug, descriptor } = parsed;
    const currentLodge = batch.lodges.get(slug) ?? null;
    const lodgeId = currentLodge?.id ?? null;

    // Lodge.
    fingerprintParts.push(
      `lodge:${slug}:${currentLodge ? hashRow([...LODGE_FIELDS], currentLodge) : "absent"}`,
    );
    {
      const data = buildLodgeData(descriptor, slug);
      // #2511: refuse to re-plant a value a cleanup migration removed. The one
      // registered lodge literal is the Waldvogel address (#2484), which is
      // DORMANT today — `address` is not in LODGE_FIELDS, so buildLodgeData never
      // produces it and this strip is a guaranteed no-op. Wiring it here anyway
      // makes the guard live-by-construction: if `address` (or any future
      // registered lodge field) is ever made portable, the planner drops the
      // cleaned literal and surfaces the warning instead of re-planting it.
      const guarded = stripCleanedLiterals("lodge", slug, descriptor, data);
      for (const hit of guarded.hits) warnings.push(cleanedLiteralWarning(hit));
      const write = updateDataForMode(ctx.mode, descriptor, guarded.write);
      const changed = changedFields(write, currentLodge);
      items.push({ entity: "lodge", key: slug, action: planActionFor(currentLodge, changed), changedFields: changed.length ? changed : undefined });
      // Door-code disclosure: creating with a code, or changing one.
      const writesCode =
        "doorCode" in write &&
        (!currentLodge || changed.includes("doorCode"));
      if (writesCode && nz(descriptor.doorCode) !== null) {
        doorCodeChanges.push(slug);
        warnings.push(`Door code for lodge "${slug}" will be ${currentLodge?.doorCode ? "changed" : "set"}.`);
      }
    }

    // Rooms.
    for (const row of parsed.rooms) {
      const key = `${slug}/${row.name}`;
      const current = lodgeId ? batch.rooms.get(`${lodgeId}/${row.name}`) ?? null : null;
      fingerprintParts.push(`lodge-room:${key}:${current ? hashRow(["sortOrder", "active", "notes"], current) : "absent"}`);
      const write = updateDataForMode(ctx.mode, row.raw, row.data);
      const changed = changedFields(write, current);
      items.push({ entity: "lodge-room", key, action: planActionFor(current, changed), changedFields: changed.length ? changed : undefined });
    }

    // Beds.
    for (const row of parsed.beds) {
      const key = `${slug}/${row.roomName}/${row.name}`;
      const current = lodgeId ? batch.beds.get(`${lodgeId}/${row.roomName}/${row.name}`) ?? null : null;
      fingerprintParts.push(`lodge-bed:${key}:${current ? hashRow(["sortOrder", "active", "bedType", "bunkGroup"], current) : "absent"}`);
      const write = updateDataForMode(ctx.mode, row.raw, row.data);
      const changed = changedFields(write, current);
      items.push({ entity: "lodge-bed", key, action: planActionFor(current, changed), changedFields: changed.length ? changed : undefined });
    }

    // Seasons (key-weak: name match; unmatched rows may be resolved to an
    // existing season via the picker — a resolution means "renamed").
    const bundleSeasonNames = new Set(parsed.seasons.map((s) => s.name));
    for (const row of parsed.seasons) {
      const key = `${slug}/${row.name}`;
      const resolvedId = ctx.resolutions.get(resolutionKey("season", key));
      const exactMatch = lodgeId ? batch.seasons.get(`${lodgeId}/${row.name}`) ?? null : null;
      let current: SeasonCurrent | null = exactMatch;
      let candidates: PlanItem["candidates"];
      if (!exactMatch && lodgeId) {
        // Offer rename candidates: this lodge's seasons not named by the bundle.
        // Kept on RESOLVED rows too, so the admin can change or undo the match.
        const options = (batch.seasonsByLodge.get(lodgeId) ?? []).filter(
          (s) => !bundleSeasonNames.has(s.name),
        );
        if (options.length > 0) {
          candidates = options.map((s) => ({
            id: s.id,
            label: `${s.name} (${toDateStr(s.startDate)} – ${toDateStr(s.endDate)})`,
          }));
        }
      }
      if (resolvedId) {
        const target = batch.seasonsById.get(resolvedId);
        if (!target || target.lodgeId !== lodgeId) {
          errors.push(`Season "${key}": the matched season no longer exists on this lodge — re-run the preview.`);
          continue;
        }
        current = target;
      }
      fingerprintParts.push(`season:${key}:${current ? hashRow(["name", "type", "startDate", "endDate", "active", "flatWholeLodgeNightCents"], current) : "absent"}`);
      // A resolved (renamed) season also writes the bundle's name.
      const data = resolvedId ? { name: row.name, ...row.data } : row.data;
      const write = updateDataForMode(ctx.mode, { ...row.raw, name: row.name }, data);
      const changed = changedFields(write, current);
      items.push({
        entity: "season",
        key,
        action: planActionFor(current, changed),
        changedFields: changed.length ? changed : undefined,
        ...(candidates ? { candidates } : {}),
      });
    }

    // Season rates (keyed by membership type + optional age tier, #1930 E4).
    for (const row of parsed.rates) {
      const key = `${slug}/${row.seasonName}/${row.membershipTypeKey}/${row.ageTier ?? ""}`;
      const current = lodgeId
        ? batch.rates.get(`${lodgeId}/${row.seasonName}/${row.membershipTypeKey}/${row.ageTier ?? ""}`) ?? null
        : null;
      fingerprintParts.push(`season-rate:${key}:${current ? String(current.pricePerNightCents) : "absent"}`);
      const write = updateDataForMode(ctx.mode, row.raw, row.data);
      const changed = changedFields(write, current);
      items.push({ entity: "season-rate", key, action: planActionFor(current, changed), changedFields: changed.length ? changed : undefined });
    }
  }

  // Default-lodge change disclosure.
  const desiredDefault = bundleDesignatedDefaultSlug(ctx.files);
  if (desiredDefault && desiredDefault !== batch.currentDefaultSlug) {
    warnings.push(`The default lodge will be set to "${desiredDefault}".`);
  }

  return { items, warnings, errors, fingerprintParts, doorCodeChanges };
}

// ---- Apply -----------------------------------------------------------------

async function applyLodgeConfig(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0 };
  const errors: string[] = []; // plan blocked all errors; defensive collection only

  const segments = lodgeFolderSegments(ctx.files);
  const slugs = segments
    .map((seg) => folderLodgeSlug(ctx.files, seg))
    .filter((s): s is string => s !== null);
  const batch = await loadLodgeBatch(ctx.tx, slugs);

  for (const segment of segments) {
    const parsed = parseLodgeFolder(ctx.files, segment, ctx.mode, batch, errors);
    if (!parsed) {
      result.skipped += 1;
      continue;
    }
    const { slug, descriptor } = parsed;

    // 1) Lodge (by slug).
    const currentLodge = batch.lodges.get(slug) ?? null;
    // #2511: mirror the plan's cleaned-literal strip so preview and apply stay
    // in lockstep. A dormant no-op for the Waldvogel address today (it is not in
    // LODGE_FIELDS, so buildLodgeData never writes it); live-by-construction if a
    // registered lodge field is ever made portable — the applier then leaves the
    // cleaned state instead of writing the removed value back.
    const { write: lodgeData } = stripCleanedLiterals(
      "lodge",
      slug,
      descriptor,
      buildLodgeData(descriptor, slug),
    );
    let lodgeId: string;
    if (currentLodge) {
      const write = updateDataForMode(ctx.mode, descriptor, lodgeData);
      const changed = changedFields(write, currentLodge);
      if (changed.length > 0) {
        await ctx.tx.lodge.update({ where: { id: currentLodge.id }, data: write });
        result.updated += 1;
        if (changed.includes("doorCode")) ctx.notes.doorCodesWritten.push(slug);
      } else {
        result.unchanged += 1;
      }
      lodgeId = currentLodge.id;
    } else {
      const created = await ctx.tx.lodge.create({
        data: { slug, ...(lodgeData as { name: string }) },
        select: { id: true },
      });
      result.created += 1;
      if (nz(descriptor.doorCode) !== null) ctx.notes.doorCodesWritten.push(slug);
      lodgeId = created.id;
    }

    // 2) Rooms (by lodgeId + name); keep an id map for beds.
    const roomIdByName = new Map<string, string>();
    for (const [key, room] of batch.rooms) {
      if (key.startsWith(`${lodgeId}/`)) roomIdByName.set(key.slice(lodgeId.length + 1), room.id);
    }
    for (const row of parsed.rooms) {
      const current = batch.rooms.get(`${lodgeId}/${row.name}`) ?? null;
      await applyRow({
        mode: ctx.mode,
        raw: row.raw,
        data: row.data,
        current,
        create: async (data) => {
          const created = await ctx.tx.lodgeRoom.create({
            data: { lodgeId, name: row.name, ...(data as object) },
            select: { id: true },
          });
          roomIdByName.set(row.name, created.id);
        },
        update: (write) => ctx.tx.lodgeRoom.update({ where: { id: current!.id }, data: write }),
        result,
      });
    }

    // 3) Beds (by roomId + name) — room ids come from the map, no re-query.
    for (const row of parsed.beds) {
      const roomId = roomIdByName.get(row.roomName);
      if (!roomId) {
        result.skipped += 1;
        continue;
      }
      const current = batch.beds.get(`${lodgeId}/${row.roomName}/${row.name}`) ?? null;
      await applyRow({
        mode: ctx.mode,
        raw: row.raw,
        data: row.data,
        current,
        create: (data) => ctx.tx.lodgeBed.create({ data: { roomId, name: row.name, ...(data as object) } }),
        update: (write) => ctx.tx.lodgeBed.update({ where: { id: current!.id }, data: write }),
        result,
      });
    }

    // 4) Seasons (key-weak; resolutions = renames); keep name → id for rates.
    const seasonIdByName = new Map<string, string>();
    for (const [key, season] of batch.seasons) {
      if (key.startsWith(`${lodgeId}/`)) seasonIdByName.set(key.slice(lodgeId.length + 1), season.id);
    }
    for (const row of parsed.seasons) {
      const resolvedId = ctx.resolutions.get(resolutionKey("season", `${slug}/${row.name}`));
      const current = resolvedId
        ? batch.seasonsById.get(resolvedId) ?? null
        : batch.seasons.get(`${lodgeId}/${row.name}`) ?? null;
      if (resolvedId && !current) {
        result.skipped += 1; // replan validates this; defensive
        continue;
      }
      const data = resolvedId ? { name: row.name, ...row.data } : row.data;
      await applyRow({
        mode: ctx.mode,
        raw: { ...row.raw, name: row.name },
        data,
        current,
        create: async (d) => {
          const created = await ctx.tx.season.create({
            data: { lodgeId, name: row.name, ...(d as object) } as never,
            select: { id: true },
          });
          seasonIdByName.set(row.name, created.id);
        },
        update: async (write) => {
          await ctx.tx.season.update({ where: { id: current!.id as string }, data: write });
          seasonIdByName.set(row.name, current!.id as string);
        },
        result,
      });
      if (current) seasonIdByName.set(row.name, current.id as string);
    }

    // 5) Season rates (by seasonId + membershipTypeId + ageTier, #1930 E4).
    for (const row of parsed.rates) {
      const seasonId = seasonIdByName.get(row.seasonName);
      const membershipTypeId = batch.membershipTypeIdByKey.get(row.membershipTypeKey);
      if (!seasonId || !membershipTypeId) {
        result.skipped += 1;
        continue;
      }
      const current = batch.rates.get(`${lodgeId}/${row.seasonName}/${row.membershipTypeKey}/${row.ageTier ?? ""}`) ?? null;
      await applyRow({
        mode: ctx.mode,
        raw: row.raw,
        data: row.data,
        current,
        create: (data) =>
          ctx.tx.membershipTypeSeasonRate.create({
            data: { seasonId, membershipTypeId, ageTier: row.ageTier as never, ...(data as object) } as never,
          }),
        update: (write) => ctx.tx.membershipTypeSeasonRate.update({ where: { id: current!.id }, data: write }),
        result,
      });
    }
  }

  // Default-lodge marker: at most one lodge may be flagged (Lodge_isDefault_key),
  // so change it clear-then-set inside this transaction. Scoped to the current
  // holder (never a blanket updateMany), and only ever SET, never clear to none.
  const desiredDefault = bundleDesignatedDefaultSlug(ctx.files);
  if (desiredDefault) {
    const target = await ctx.tx.lodge.findUnique({ where: { slug: desiredDefault }, select: { isDefault: true } });
    if (target && !target.isDefault) {
      await ctx.tx.lodge.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      await ctx.tx.lodge.update({ where: { slug: desiredDefault }, data: { isDefault: true } });
    }
  }

  return result;
}

export const lodgeConfigImporter: CategoryImporter = {
  category: "lodge-config",
  plan: planLodgeConfig,
  apply: applyLodgeConfig,
};
