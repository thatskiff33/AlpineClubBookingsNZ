import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

import { DEFAULT_SCHOOL_GROUP_SOFT_CAP } from "@/lib/school-booking-constants";

const LODGE_SETTINGS_ID = "default";
const DEFAULT_HUT_LEADER_LOOKAHEAD_DAYS = 14;

type LodgeSettingsRecord = {
  capacity: number | null;
  hutLeaderLookaheadDays?: number | null;
  schoolGroupSoftCap?: number | null;
  lodgeId?: string | null;
};

// Per-lodge conversion (lodge-scoping contract): a lodge's settings row is
// keyed by its lodge id (`id = lodgeId`), while the legacy "default" row —
// soft-linked to the club's original lodge in the phase-2 backfill — keeps
// serving that lodge and any pre-conversion reader. Readers resolve: the
// lodge's own row, else the legacy row when it is unlinked or linked to the
// same lodge, else code defaults. hutLeaderLookaheadDays deliberately stays
// a club-wide knob read from the legacy row.

export type LodgeSettingsReader = {
  lodgeSettings?: {
    findUnique: (args: {
      where: { id: string };
    }) => Promise<LodgeSettingsRecord | null>;
  };
};

export interface LodgeSettingsValues {
  capacity: number | null;
  hutLeaderLookaheadDays: number;
  // Resolved per lodge: the lodge's own soft cap, else the code default.
  schoolGroupSoftCap: number;
}

export function normalizeHutLeaderLookaheadDays(value: unknown): number {
  return Number.isInteger(value) && Number(value) > 0
    ? Number(value)
    : DEFAULT_HUT_LEADER_LOOKAHEAD_DAYS;
}

/**
 * Reads lodge settings with safe defaults. Missing delegates or query
 * failures fall back to the code defaults so callers can keep rendering.
 *
 * With a lodgeId, capacity resolves per lodge (own row, else the legacy
 * row when unlinked or linked to this lodge); without one, the legacy
 * club-wide behaviour is unchanged. hutLeaderLookaheadDays always comes
 * from the legacy row — it is a club-wide knob.
 */
export async function loadLodgeSettings(
  db: LodgeSettingsReader = prisma,
  lodgeId?: string | null,
): Promise<LodgeSettingsValues> {
  if (!db.lodgeSettings?.findUnique) {
    return {
      capacity: null,
      hutLeaderLookaheadDays: DEFAULT_HUT_LEADER_LOOKAHEAD_DAYS,
      schoolGroupSoftCap: DEFAULT_SCHOOL_GROUP_SOFT_CAP,
    };
  }

  try {
    const record = await db.lodgeSettings.findUnique({
      where: { id: LODGE_SETTINGS_ID },
    });
    const lookahead = normalizeHutLeaderLookaheadDays(
      record?.hutLeaderLookaheadDays,
    );
    if (lodgeId && lodgeId !== LODGE_SETTINGS_ID) {
      return {
        capacity: await loadLodgeCapacityOverride(db, lodgeId),
        hutLeaderLookaheadDays: lookahead,
        schoolGroupSoftCap: await loadSchoolGroupSoftCap(db, lodgeId),
      };
    }
    return {
      capacity: record?.capacity ?? null,
      hutLeaderLookaheadDays: lookahead,
      schoolGroupSoftCap: record?.schoolGroupSoftCap ?? DEFAULT_SCHOOL_GROUP_SOFT_CAP,
    };
  } catch {
    return {
      capacity: null,
      hutLeaderLookaheadDays: DEFAULT_HUT_LEADER_LOOKAHEAD_DAYS,
      schoolGroupSoftCap: DEFAULT_SCHOOL_GROUP_SOFT_CAP,
    };
  }
}

/**
 * Per-lodge school-group soft cap, mirroring loadLodgeCapacityOverride's
 * resolution but returning the code default (never null) as the final
 * fallback: the lodge's own row wins; else the legacy "default" row when it
 * is unlinked or linked to this lodge; else the default constant.
 */
export async function loadSchoolGroupSoftCap(
  db: LodgeSettingsReader = prisma,
  lodgeId?: string | null,
): Promise<number> {
  if (!db.lodgeSettings?.findUnique) return DEFAULT_SCHOOL_GROUP_SOFT_CAP;
  try {
    if (lodgeId && lodgeId !== LODGE_SETTINGS_ID) {
      const ownRow = await db.lodgeSettings.findUnique({
        where: { id: lodgeId },
      });
      if (ownRow) return ownRow.schoolGroupSoftCap ?? DEFAULT_SCHOOL_GROUP_SOFT_CAP;
    }
    const record = await db.lodgeSettings.findUnique({
      where: { id: LODGE_SETTINGS_ID },
    });
    if (!record) return DEFAULT_SCHOOL_GROUP_SOFT_CAP;
    if (
      lodgeId &&
      record.lodgeId !== undefined &&
      record.lodgeId !== null &&
      record.lodgeId !== lodgeId
    ) {
      return DEFAULT_SCHOOL_GROUP_SOFT_CAP;
    }
    return record.schoolGroupSoftCap ?? DEFAULT_SCHOOL_GROUP_SOFT_CAP;
  } catch {
    return DEFAULT_SCHOOL_GROUP_SOFT_CAP;
  }
}

/**
 * Admin-set lodge capacity override, or null to fall back. Reads are
 * resilient: a missing delegate or a query failure resolves to null so
 * capacity always falls back rather than throwing.
 *
 * Resolution order when a lodgeId is supplied: the lodge's own settings row
 * (id = lodgeId) wins; otherwise the legacy "default" row applies only when
 * it is unlinked (null lodgeId — pre-backfill data or a draining old colour)
 * or soft-linked to this same lodge. A legacy row linked to a different
 * lodge resolves null, so one lodge's override can never leak to another.
 */
export async function loadLodgeCapacityOverride(
  db: LodgeSettingsReader = prisma,
  lodgeId?: string,
): Promise<number | null> {
  if (!db.lodgeSettings?.findUnique) return null;

  try {
    if (lodgeId && lodgeId !== LODGE_SETTINGS_ID) {
      const ownRow = await db.lodgeSettings.findUnique({
        where: { id: lodgeId },
      });
      if (ownRow) return ownRow.capacity ?? null;
    }
    const record = await db.lodgeSettings.findUnique({
      where: { id: LODGE_SETTINGS_ID },
    });
    if (!record) return null;
    if (
      lodgeId &&
      record.lodgeId !== undefined &&
      record.lodgeId !== null &&
      record.lodgeId !== lodgeId
    ) {
      return null;
    }
    return record.capacity ?? null;
  } catch {
    return null;
  }
}

export async function loadHutLeaderLookaheadDays(
  db: LodgeSettingsReader = prisma,
): Promise<number> {
  const settings = await loadLodgeSettings(db);
  return settings.hutLeaderLookaheadDays;
}

/**
 * The settings row a NEW lodge is born with (#3407): its own row, keyed by the
 * lodge id, carrying the capacity the officer typed on Add lodge. Written
 * inside the lodge-create transaction so a lodge never exists without one.
 *
 * Always the lodge's OWN row, never the legacy "default" one, whatever state
 * that row is in. `loadLodgeCapacityOverride` reads an own row first, so this
 * is the row that decides; and claiming an unlinked legacy row here would take
 * the capacity it serves away from the lodge that was relying on it.
 * `updateLodgeSettings` below targets an existing own row for the same reason,
 * so a later edit on the lodge hub lands on the row the resolver reads.
 * `hutLeaderLookaheadDays` is left at its column default: it is a club-wide
 * knob read only from the legacy row.
 */
export async function createNewLodgeSettings(
  tx: Pick<Prisma.TransactionClient, "lodgeSettings">,
  input: { lodgeId: string; capacity: number; updatedByMemberId: string },
): Promise<void> {
  await tx.lodgeSettings.create({
    data: {
      id: input.lodgeId,
      lodgeId: input.lodgeId,
      capacity: input.capacity,
      updatedByMemberId: input.updatedByMemberId,
    },
    select: { id: true },
  });
}

export async function updateLodgeSettings(input: {
  capacity: number | null;
  hutLeaderLookaheadDays: number;
  // Per-lodge like capacity; null clears it back to the code default.
  schoolGroupSoftCap?: number | null;
  updatedByMemberId: string;
  // Lodge whose capacity override is being edited. Omitted keeps the
  // legacy single-row behaviour. The hut-leader lookahead is club-wide
  // and always lands on the legacy row regardless of the target lodge.
  lodgeId?: string | null;
}): Promise<LodgeSettingsValues & { updatedAt: Date }> {
  const lookahead = normalizeHutLeaderLookaheadDays(
    input.hutLeaderLookaheadDays,
  );
  const softCap = input.schoolGroupSoftCap ?? null;

  const [legacy, ownRow] = await Promise.all([
    prisma.lodgeSettings.findUnique({
      where: { id: LODGE_SETTINGS_ID },
      select: { lodgeId: true },
    }),
    input.lodgeId && input.lodgeId !== LODGE_SETTINGS_ID
      ? prisma.lodgeSettings.findUnique({
          where: { id: input.lodgeId },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  // The legacy row keeps serving the lodge it was soft-linked to in the
  // phase-2 backfill (and single-lodge clubs); other lodges get their own
  // row keyed by lodge id, so overrides can never collide.
  //
  // A lodge that already HAS its own row is edited there, whatever the legacy
  // row says (#3407). The reader (`loadLodgeCapacityOverride`) prefers an own
  // row unconditionally, so writing the legacy row instead would save a figure
  // the resolver never reads. Every lodge created since #3407 has an own row
  // from birth (`createNewLodgeSettings`), which is what makes this reachable.
  const targetsLegacyRow =
    !ownRow &&
    (!input.lodgeId ||
      !legacy ||
      legacy.lodgeId === null ||
      legacy.lodgeId === input.lodgeId);

  if (targetsLegacyRow) {
    const row = await prisma.lodgeSettings.upsert({
      where: { id: LODGE_SETTINGS_ID },
      create: {
        id: LODGE_SETTINGS_ID,
        capacity: input.capacity,
        hutLeaderLookaheadDays: lookahead,
        schoolGroupSoftCap: softCap,
        updatedByMemberId: input.updatedByMemberId,
        lodgeId: input.lodgeId ?? null,
      },
      update: {
        capacity: input.capacity,
        hutLeaderLookaheadDays: lookahead,
        schoolGroupSoftCap: softCap,
        updatedByMemberId: input.updatedByMemberId,
        // An unlinked legacy row is claimed by the lodge being edited, so a
        // later edit for a different lodge cannot overwrite this override.
        ...(input.lodgeId && legacy?.lodgeId === null
          ? { lodgeId: input.lodgeId }
          : {}),
      },
      select: {
        capacity: true,
        hutLeaderLookaheadDays: true,
        schoolGroupSoftCap: true,
        updatedAt: true,
      },
    });
    return {
      capacity: row.capacity,
      hutLeaderLookaheadDays: row.hutLeaderLookaheadDays,
      schoolGroupSoftCap: row.schoolGroupSoftCap ?? DEFAULT_SCHOOL_GROUP_SOFT_CAP,
      updatedAt: row.updatedAt,
    };
  }

  const [, savedOwnRow] = await prisma.$transaction([
    // An upsert, not an update: since #3407 an own row can exist while the
    // legacy row does not (a club whose legacy row was never created), and the
    // club-wide lookahead still belongs on the legacy row. Created unlinked with
    // no capacity, it serves no lodge a figure.
    prisma.lodgeSettings.upsert({
      where: { id: LODGE_SETTINGS_ID },
      create: {
        id: LODGE_SETTINGS_ID,
        hutLeaderLookaheadDays: lookahead,
        updatedByMemberId: input.updatedByMemberId,
      },
      update: {
        hutLeaderLookaheadDays: lookahead,
        updatedByMemberId: input.updatedByMemberId,
      },
    }),
    prisma.lodgeSettings.upsert({
      where: { id: input.lodgeId! },
      create: {
        id: input.lodgeId!,
        lodgeId: input.lodgeId!,
        capacity: input.capacity,
        hutLeaderLookaheadDays: lookahead,
        schoolGroupSoftCap: softCap,
        updatedByMemberId: input.updatedByMemberId,
      },
      update: {
        capacity: input.capacity,
        schoolGroupSoftCap: softCap,
        updatedByMemberId: input.updatedByMemberId,
      },
      select: { capacity: true, schoolGroupSoftCap: true, updatedAt: true },
    }),
  ]);

  return {
    capacity: savedOwnRow.capacity,
    hutLeaderLookaheadDays: lookahead,
    schoolGroupSoftCap:
      savedOwnRow.schoolGroupSoftCap ?? DEFAULT_SCHOOL_GROUP_SOFT_CAP,
    updatedAt: savedOwnRow.updatedAt,
  };
}
