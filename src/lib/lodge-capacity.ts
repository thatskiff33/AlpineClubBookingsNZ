import { clubConfig } from "@/config/club";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_KEYS,
  getEffectiveModuleFlags,
  readClubModuleSettingsRecord,
  type ModuleSettingsValues,
} from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";

// Club config bed total. Since #1982 the DB is the SOLE runtime source of a
// lodge's booking capacity (the per-lodge `LodgeSettings.capacity`, backfilled
// from this total by the boot-time config self-heal — see
// `config-self-heal.ts`). This constant is therefore NO LONGER read by
// `getLodgeCapacityStatus`; it survives only as a SEED-TEMPLATE reference — the
// "import rooms & beds from config" affordance (`bed-allocation-rooms.ts`) and
// the admin lodge-settings screen's "config suggests N beds" hint
// (`api/admin/lodge-settings`). `club.json beds[]` is a seed input, never a
// runtime capacity source.
export const CLUB_CONFIG_LODGE_CAPACITY = clubConfig.beds.reduce(
  (total, bed) => total + bed.capacity,
  0,
);

/**
 * A fixed, database-less default lodge capacity for the handful of legacy
 * DISPLAY / scaling call sites that cannot reach the database (email templates,
 * chore people-count scaling, sample-token previews, and the public request
 * form's client-side guest-cap hint). It is a fixed constant (#1982) — no
 * longer derived from `clubConfig.beds` — so `club.json` is not read at runtime.
 *
 * IMPORTANT: this value NEVER decides booking capacity. Every booking,
 * availability, finance and cron path resolves through
 * `getLodgeCapacityStatus`, whose unconfigured fallback is 0 (never silently
 * overbook) plus a setup-readiness warning. Do not reintroduce it into a
 * capacity decision.
 *
 * @deprecated Prefer the resolved capacity from getLodgeCapacityStatus, which
 * reads the database and honours the admin capacity override. Retained only for
 * the static, DB-less display defaults above.
 */
export const FALLBACK_LODGE_CAPACITY = 20;

type ModuleSettingsRecord = Partial<ModuleSettingsValues> | null;

interface LodgeCapacityDb {
  clubModuleSettings?: {
    findUnique: (args: {
      where: { id: string };
      select?: Record<string, boolean>;
    }) => Promise<ModuleSettingsRecord>;
  };
  lodgeSettings?: {
    findUnique: (args: {
      where: { id: string };
    }) => Promise<{ capacity: number | null; lodgeId?: string | null } | null>;
  };
  lodgeBed: {
    count: (args: {
      where: { active: boolean; room?: { lodgeId: string }; bedType?: "DOUBLE" };
    }) => Promise<number>;
  };
  // Optional so existing structural mocks keep working: when absent, the
  // requested lodge is treated as the club's default lodge (single-lodge
  // behaviour, club-config fallback preserved).
  lodge?: {
    findFirst: (args: {
      where: { active: boolean };
      orderBy: Array<Record<string, "asc" | "desc">>;
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
}

export interface LodgeCapacityStatus {
  capacity: number;
  source:
    | "configured_beds"
    | "capped_beds"
    | "capacity_override"
    | "unconfigured_lodge";
  bedAllocationEnabled: boolean;
  activeBedCount: number;
  fallbackCapacity: number;
}

function normalizeModuleSettings(
  record?: ModuleSettingsRecord,
): ModuleSettingsValues {
  return Object.fromEntries(
    MODULE_KEYS.map((key) => [key, record?.[key] ?? DEFAULT_MODULE_SETTINGS[key]]),
  ) as ModuleSettingsValues;
}

async function resolveLodgeCapacityDb(): Promise<LodgeCapacityDb> {
  const { prisma } = await import("@/lib/prisma");
  return prisma as unknown as LodgeCapacityDb;
}

async function loadCapacityModuleState(
  db: LodgeCapacityDb,
): Promise<FeatureFlags> {
  if (!db.clubModuleSettings?.findUnique) {
    return getEffectiveModuleFlags(DEFAULT_MODULE_SETTINGS);
  }

  try {
    const record = await readClubModuleSettingsRecord({
      clubModuleSettings: db.clubModuleSettings,
    });
    return getEffectiveModuleFlags(normalizeModuleSettings(record));
  } catch {
    return getEffectiveModuleFlags(DEFAULT_MODULE_SETTINGS);
  }
}

/**
 * Capacity for one lodge on one night. Never sums beds across lodges
 * (docs/multi-lodge/lodge-scoping-contract.md).
 *
 * Resolution order (see docs/CAPACITY_MODEL.md for the full scenario table):
 * 1. Bed Allocation module ON with ≥1 active bed: the physical bed inventory
 *    is the placement set, and the admin capacity value acts as a *maximum
 *    sleeping capacity* ceiling on top of it. Effective capacity is the LOWER
 *    of the two — a lodge may have more beds installed than it is licensed to
 *    sleep (#1653). No capacity set (or set ≥ bed count) → the bed count wins
 *    ("configured_beds"); a capacity below the bed count caps it ("capped_beds").
 * 2. Otherwise (module off, or on with no active beds): the admin capacity
 *    value for this lodge (the per-lodge `LodgeSettings.capacity` override,
 *    source "capacity_override").
 * 3. Neither → 0 ("unconfigured_lodge"), for EVERY lodge including the default.
 *    Since #1982 the DB is the sole runtime source: the default lodge carries
 *    an explicit `LodgeSettings.capacity` backfilled from the club-config bed
 *    total by the boot-time self-heal (`config-self-heal.ts`), so it normally
 *    resolves via step 2. A default lodge that still resolves to 0 here is
 *    genuinely unconfigured (no beds AND no override — e.g. a fork whose boot
 *    self-heal was skipped) and is flagged loudly by the setup-readiness
 *    club-config check rather than being handed phantom capacity that could
 *    silently overbook. `club.json` is never read here.
 */
export async function getLodgeCapacityStatus(
  lodgeId: string,
  db?: LodgeCapacityDb,
): Promise<LodgeCapacityStatus> {
  // Bed allocation availability follows the admin Modules toggle only.
  const client = db ?? (await resolveLodgeCapacityDb());
  const modules = await loadCapacityModuleState(client);

  // The override is the admin-set lodge capacity if present. Imported
  // dynamically so this module's static graph stays free of the Prisma client
  // (config/club-identity imports the constants here at load time, well before
  // any database is available).
  const { loadLodgeCapacityOverride } = await import("@/lib/lodge-settings");
  const override = await loadLodgeCapacityOverride(client, lodgeId);

  // No club-config fallback (#1982): an unconfigured lodge — default or
  // additional — resolves to 0 so it can never be overbooked before its
  // capacity is configured or self-healed into the DB.
  const fallbackCapacity = override ?? 0;
  const fallbackSource =
    override !== null && override !== undefined
      ? ("capacity_override" as const)
      : ("unconfigured_lodge" as const);

  if (!modules.bedAllocation) {
    return {
      capacity: fallbackCapacity,
      source: fallbackSource,
      bedAllocationEnabled: false,
      activeBedCount: 0,
      fallbackCapacity,
    };
  }

  const activeBedCount = await client.lodgeBed.count({
    where: { active: true, room: { lodgeId } },
  });

  if (activeBedCount <= 0) {
    // Module on but no beds configured yet: fall back to the per-lodge
    // capacity override, else 0 (unconfigured), unchanged.
    return {
      capacity: fallbackCapacity,
      source: fallbackSource,
      bedAllocationEnabled: true,
      activeBedCount,
      fallbackCapacity,
    };
  }

  // Beds are the placement inventory; an explicit per-lodge capacity is the
  // maximum sleeping capacity ceiling. Effective capacity is the lower of the
  // two (#1653). Only an explicit override caps — an unconfigured (0) fallback
  // does not, so `override` (not `fallbackCapacity`) is the ceiling here.
  const capped =
    override !== null && override !== undefined && override < activeBedCount;

  return {
    capacity: capped ? override : activeBedCount,
    source: capped ? "capped_beds" : "configured_beds",
    bedAllocationEnabled: true,
    activeBedCount,
    fallbackCapacity,
  };
}

export async function getLodgeCapacity(
  lodgeId: string,
  db?: LodgeCapacityDb,
): Promise<number> {
  const status = await getLodgeCapacityStatus(lodgeId, db);
  return status.capacity;
}

export interface LodgePartnerSharedCapacityStatus extends LodgeCapacityStatus {
  activeDoubleBedCount: number;
  partnerSharedHeadroom: number;
}

/**
 * Capacity status plus the partner-shared headroom (#1745): how many guests
 * beyond the base `capacity` may be admitted as second occupants of shared
 * DOUBLE beds. Kept out of getLodgeCapacityStatus so ordinary availability
 * checks — which must never see the extra slots — pay no extra query.
 *
 * Headroom is one slot per active DOUBLE bed, bounded by an explicit admin
 * capacity value when one is set: that value is a maximum *sleeping* capacity
 * (fire/consent/licence, #1653), and a partner-sharer sleeps in the lodge like
 * anyone else. So a `capped_beds` lodge gets no headroom at all, and a lodge
 * whose capacity sits between `beds` and `beds + doubles` gets only the gap.
 * The headroom never raises the base figure the public booking paths read —
 * it is consumed only by the admin-initiated partner-shared admission check
 * (`checkCapacityForPartnerSharedAdmission`, see docs/CAPACITY_MODEL.md).
 */
export async function getLodgePartnerSharedCapacityStatus(
  lodgeId: string,
  db?: LodgeCapacityDb,
): Promise<LodgePartnerSharedCapacityStatus> {
  const client = db ?? (await resolveLodgeCapacityDb());
  const base = await getLodgeCapacityStatus(lodgeId, client);

  // Shared slots exist only where beds are the bookable inventory: with the
  // module off (or no active beds) there are no DOUBLE rows admitting a second
  // occupant, and with a capacity below the bed count the explicit people
  // ceiling already binds.
  if (
    !base.bedAllocationEnabled ||
    base.activeBedCount <= 0 ||
    base.source !== "configured_beds"
  ) {
    return { ...base, activeDoubleBedCount: 0, partnerSharedHeadroom: 0 };
  }

  const activeDoubleBedCount = await client.lodgeBed.count({
    where: { active: true, room: { lodgeId }, bedType: "DOUBLE" },
  });

  const { loadLodgeCapacityOverride } = await import("@/lib/lodge-settings");
  const override = await loadLodgeCapacityOverride(client, lodgeId);
  const peopleCeiling =
    override !== null && override !== undefined
      ? override
      : Number.POSITIVE_INFINITY;

  const partnerSharedHeadroom = Math.max(
    0,
    Math.min(
      activeDoubleBedCount,
      peopleCeiling - base.activeBedCount,
    ),
  );

  return { ...base, activeDoubleBedCount, partnerSharedHeadroom };
}

/**
 * Capacity of the club's default lodge (oldest active). For display surfaces
 * and single-lodge bridging call sites that have no lodge context of their
 * own; booking/capacity mutation paths must pass the booking's real lodgeId
 * to getLodgeCapacity instead.
 */
export async function getDefaultLodgeCapacity(
  db?: LodgeCapacityDb,
): Promise<number> {
  const client = db ?? (await resolveLodgeCapacityDb());

  let lodgeId = "default-lodge";
  if (client.lodge?.findFirst) {
    const { getDefaultLodgeId } = await import("@/lib/lodges");
    lodgeId = await getDefaultLodgeId(
      client as unknown as Parameters<typeof getDefaultLodgeId>[0],
    );
  }
  // Without a lodge delegate (structural test mocks) the sentinel id is used;
  // capacity still resolves via the per-lodge override, else 0 (#1982).
  return getLodgeCapacity(lodgeId, client);
}
