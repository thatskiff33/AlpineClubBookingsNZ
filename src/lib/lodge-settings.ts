import { prisma } from "@/lib/prisma";

export const LODGE_SETTINGS_ID = "default";
export const DEFAULT_HUT_LEADER_LOOKAHEAD_DAYS = 14;
export const MAX_HUT_LEADER_LOOKAHEAD_DAYS = 365;

type LodgeSettingsRecord = {
  capacity: number | null;
  hutLeaderLookaheadDays?: number | null;
};

type LodgeSettingsFindUniqueArgs = {
  where: { id: string };
};

export type LodgeSettingsReader = {
  lodgeSettings?: {
    findUnique: (
      args: LodgeSettingsFindUniqueArgs,
    ) => Promise<LodgeSettingsRecord | null>;
  };
};

export interface LodgeSettingsValues {
  capacity: number | null;
  hutLeaderLookaheadDays: number;
}

export function normalizeHutLeaderLookaheadDays(value: unknown): number {
  return Number.isInteger(value) &&
    Number(value) > 0 &&
    Number(value) <= MAX_HUT_LEADER_LOOKAHEAD_DAYS
    ? Number(value)
    : DEFAULT_HUT_LEADER_LOOKAHEAD_DAYS;
}

/**
 * Reads singleton lodge settings with safe defaults. Missing delegates or query
 * failures fall back to the code defaults so callers can keep rendering.
 */
export async function loadLodgeSettings(
  db: LodgeSettingsReader = prisma as unknown as LodgeSettingsReader,
): Promise<LodgeSettingsValues> {
  if (!db.lodgeSettings?.findUnique) {
    return {
      capacity: null,
      hutLeaderLookaheadDays: DEFAULT_HUT_LEADER_LOOKAHEAD_DAYS,
    };
  }

  try {
    const record = await db.lodgeSettings.findUnique({
      where: { id: LODGE_SETTINGS_ID },
    });
    return {
      capacity: record?.capacity ?? null,
      hutLeaderLookaheadDays: normalizeHutLeaderLookaheadDays(
        record?.hutLeaderLookaheadDays,
      ),
    };
  } catch {
    return {
      capacity: null,
      hutLeaderLookaheadDays: DEFAULT_HUT_LEADER_LOOKAHEAD_DAYS,
    };
  }
}

/**
 * Admin-set lodge capacity override, or null to fall back to the club config
 * bed total. Reads are resilient: a missing delegate or a query failure resolves
 * to null so capacity always falls back rather than throwing.
 */
export async function loadLodgeCapacityOverride(
  db: LodgeSettingsReader = prisma as unknown as LodgeSettingsReader,
): Promise<number | null> {
  const settings = await loadLodgeSettings(db);
  return settings.capacity;
}

export async function loadHutLeaderLookaheadDays(
  db: LodgeSettingsReader = prisma as unknown as LodgeSettingsReader,
): Promise<number> {
  const settings = await loadLodgeSettings(db);
  return settings.hutLeaderLookaheadDays;
}

export async function updateLodgeSettings(input: {
  capacity: number | null;
  hutLeaderLookaheadDays: number;
  updatedByMemberId: string;
}): Promise<LodgeSettingsValues & { updatedAt: Date }> {
  return prisma.lodgeSettings.upsert({
    where: { id: LODGE_SETTINGS_ID },
    create: {
      id: LODGE_SETTINGS_ID,
      capacity: input.capacity,
      hutLeaderLookaheadDays: normalizeHutLeaderLookaheadDays(
        input.hutLeaderLookaheadDays,
      ),
      updatedByMemberId: input.updatedByMemberId,
    },
    update: {
      capacity: input.capacity,
      hutLeaderLookaheadDays: normalizeHutLeaderLookaheadDays(
        input.hutLeaderLookaheadDays,
      ),
      updatedByMemberId: input.updatedByMemberId,
    },
    select: { capacity: true, hutLeaderLookaheadDays: true, updatedAt: true },
  });
}
