import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

import { DEFAULT_SCHOOL_GROUP_SOFT_CAP } from "@/lib/school-booking-constants";
import {
  DEFAULT_SCHOOL_HUT_LEADER_KINDS,
  SCHOOL_HUT_LEADER_KINDS,
  type SchoolHutLeaderKind,
  type SchoolHutLeaderKinds,
} from "@/lib/school-hut-leader-kinds";

const LODGE_SETTINGS_ID = "default";
const DEFAULT_HUT_LEADER_LOOKAHEAD_DAYS = 14;

type LodgeSettingsRecord = {
  capacity: number | null;
  hutLeaderLookaheadDays?: number | null;
  schoolGroupSoftCap?: number | null;
  lodgeId?: string | null;
  schoolHutLeaderTeacherOnBooking?: boolean;
  schoolHutLeaderCustodian?: boolean;
  schoolHutLeaderMemberOnBooking?: boolean;
  schoolHutLeaderMemberStayingSeparately?: boolean;
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
 * THE ROW THAT SERVES A LODGE — the one resolution every per-lodge reader asks
 * (`INV-SSOT-001`): the lodge's own row (`id = lodgeId`); else the legacy
 * "default" row when it is unlinked or linked to this lodge; else none, so the
 * caller's code default applies. Without a lodge id it is the legacy row,
 * which is the pre-conversion club-wide behaviour. A legacy row linked to a
 * different lodge is never returned, so one lodge's values cannot leak to
 * another. Errors propagate; each caller decides whether a failed read may
 * fall back.
 */
async function servingLodgeSettingsRow(
  db: Required<LodgeSettingsReader>,
  lodgeId?: string | null,
): Promise<LodgeSettingsRecord | null> {
  if (lodgeId && lodgeId !== LODGE_SETTINGS_ID) {
    const ownRow = await db.lodgeSettings.findUnique({ where: { id: lodgeId } });
    if (ownRow) return ownRow;
  }
  const legacy = await db.lodgeSettings.findUnique({
    where: { id: LODGE_SETTINGS_ID },
  });
  if (!legacy) return null;
  if (lodgeId && legacy.lodgeId != null && legacy.lodgeId !== lodgeId) return null;
  return legacy;
}

function hasLodgeSettings(db: LodgeSettingsReader): db is Required<LodgeSettingsReader> {
  return typeof db.lodgeSettings?.findUnique === "function";
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
  if (!hasLodgeSettings(db)) return DEFAULT_SCHOOL_GROUP_SOFT_CAP;
  try {
    const row = await servingLodgeSettingsRow(db, lodgeId);
    return row?.schoolGroupSoftCap ?? DEFAULT_SCHOOL_GROUP_SOFT_CAP;
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
  if (!hasLodgeSettings(db)) return null;
  try {
    const row = await servingLodgeSettingsRow(db, lodgeId);
    return row?.capacity ?? null;
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
  input: {
    lodgeId: string;
    capacity: number;
    updatedByMemberId: string;
    // Only a config import passes it (see writeImportedLodgeCapacity).
    schoolGroupSoftCap?: number | null;
  },
): Promise<void> {
  await tx.lodgeSettings.create({
    data: {
      id: input.lodgeId,
      lodgeId: input.lodgeId,
      capacity: input.capacity,
      updatedByMemberId: input.updatedByMemberId,
      ...(input.schoolGroupSoftCap != null
        ? { schoolGroupSoftCap: input.schoolGroupSoftCap }
        : {}),
    },
    select: { id: true },
  });
}

/**
 * A config import's capacity write (#3407): the capacity a bundle carries for
 * one lodge, written inside the import transaction. It follows the per-lodge
 * rule in docs/multi-lodge/lodge-scoping-contract.md, as the sibling
 * bed-allocation importer does:
 *
 * - a lodge the import has just created is born through
 *   `createNewLodgeSettings`, exactly as Add lodge does;
 * - an existing lodge with its own row is edited there;
 * - the legacy "default" row is edited ONLY when it is already linked to this
 *   lodge;
 * - otherwise the lodge gets its own row, and the legacy row is left untouched.
 *
 * It never claims an unlinked legacy row. An unlinked row serves EVERY lodge
 * without an own row (a guided-setup install writes one), so claiming it for
 * one lodge would silently take the figure away from the others, the default
 * lodge included, with nothing in the preview to say so (#3407 round-3
 * review, F1). When that unlinked row is what was serving this lodge, its
 * school-group soft cap is carried onto the new own row, because an own row
 * is read first and would otherwise reset the lodge's soft cap to the code
 * default. A legacy row linked to another lodge never served this one, so
 * nothing is copied from it.
 *
 * Nothing else in a config import writes a `LodgeSettings` row: the model is a
 * model-level exclusion (`MODEL_LEVEL_EXCLUSIONS`), so this is the only path.
 */
export async function writeImportedLodgeCapacity(
  tx: Pick<Prisma.TransactionClient, "lodgeSettings">,
  input: {
    lodgeId: string;
    capacity: number;
    updatedByMemberId: string;
    lodgeCreatedByThisImport: boolean;
  },
): Promise<void> {
  if (input.lodgeCreatedByThisImport) {
    return createNewLodgeSettings(tx, {
      lodgeId: input.lodgeId,
      capacity: input.capacity,
      updatedByMemberId: input.updatedByMemberId,
    });
  }
  await writeLodgeOwnSettings(tx, {
    lodgeId: input.lodgeId,
    data: { capacity: input.capacity },
    updatedByMemberId: input.updatedByMemberId,
  });
}

/**
 * Every per-lodge value a settings row serves. When a lodge stops being served
 * by an unlinked legacy row — because it gets a row of its own, or because the
 * legacy row is claimed by another lodge — these are what it resolved to, and
 * they are carried onto its new row so nothing it reads moves (#3407, #3819).
 * The club-wide `hutLeaderLookaheadDays` is not one: it is read from the legacy
 * row alone.
 */
function servedPerLodgeValues(row: LodgeSettingsRecord) {
  return {
    capacity: row.capacity ?? null,
    schoolGroupSoftCap: row.schoolGroupSoftCap ?? null,
    ...kindsToColumns(kindsFromRecord(row)),
  };
}

/**
 * Write per-lodge values onto the row that serves `lodgeId` — THE one targeting
 * rule for a per-lodge settings write (`INV-SSOT-001`), used by the config
 * importer and the school hut-leader setting:
 *
 * - a lodge with its own row is edited there;
 * - the legacy "default" row is edited ONLY when it is already linked to this
 *   lodge;
 * - otherwise the lodge gets its own row. It never claims an unlinked legacy
 *   row, which serves every lodge without an own row (a guided-setup install
 *   writes one), so claiming it for one lodge would silently take its values
 *   away from the others. When that unlinked row is what was serving this
 *   lodge, everything it served is carried onto the new own row
 *   ({@link servedPerLodgeValues}), because an own row is read first and would
 *   otherwise reset the lodge's other values to the code defaults. A legacy row
 *   linked to another lodge never served this one, so nothing is copied.
 *
 * Returns the row written, as the resolver would read it.
 */
async function writeLodgeOwnSettings(
  tx: Pick<Prisma.TransactionClient, "lodgeSettings">,
  input: {
    lodgeId: string;
    data: Prisma.LodgeSettingsUncheckedUpdateInput;
    updatedByMemberId: string;
  },
): Promise<LodgeSettingsRecord> {
  const data = { ...input.data, updatedByMemberId: input.updatedByMemberId };
  const ownRow = await tx.lodgeSettings.findUnique({
    where: { id: input.lodgeId },
    select: { id: true },
  });
  if (ownRow) {
    return tx.lodgeSettings.update({ where: { id: input.lodgeId }, data });
  }
  const legacy = await tx.lodgeSettings.findUnique({
    where: { id: LODGE_SETTINGS_ID },
  });
  if (legacy && legacy.lodgeId === input.lodgeId) {
    return tx.lodgeSettings.update({ where: { id: LODGE_SETTINGS_ID }, data });
  }
  const carried = legacy && legacy.lodgeId === null ? servedPerLodgeValues(legacy) : {};
  return tx.lodgeSettings.create({
    data: {
      ...carried,
      ...(data as Prisma.LodgeSettingsUncheckedCreateInput),
      id: input.lodgeId,
      lodgeId: input.lodgeId,
    },
  });
}

/**
 * Before an unlinked legacy row is claimed for `claimingLodgeId`, give every
 * other lodge it serves (one with no own row) its own row holding the values it
 * resolved to through that legacy row ({@link servedPerLodgeValues}).
 */
async function giveServedLodgesTheirOwnRows(
  legacy: LodgeSettingsRecord,
  claimingLodgeId: string,
): Promise<void> {
  const lodges = await prisma.lodge.findMany({
    where: { id: { not: claimingLodgeId } },
    select: { id: true },
  });
  if (lodges.length === 0) return;
  const ids = lodges.map((lodge) => lodge.id);
  const owned = new Set(
    (
      await prisma.lodgeSettings.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );
  const served = ids.filter((id) => !owned.has(id));
  if (served.length === 0) return;
  await prisma.lodgeSettings.createMany({
    data: served.map((id) => ({ id, lodgeId: id, ...servedPerLodgeValues(legacy) })),
    skipDuplicates: true,
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
    if (legacy && legacy.lodgeId === null && input.lodgeId) {
      // Claiming the unlinked legacy row for this lodge stops it serving every
      // other lodge without a row of its own. Each of those first gets its own
      // row carrying what it resolved to (#3819), so its capacity, soft cap and
      // school hut-leader kinds do not move under it.
      await giveServedLodgesTheirOwnRows(legacy, input.lodgeId);
    }
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

// ---------------------------------------------------------------------------
// Who can be hut leader for school bookings (#3819)
// ---------------------------------------------------------------------------

const SCHOOL_HUT_LEADER_KIND_COLUMNS = {
  teacherOnBooking: "schoolHutLeaderTeacherOnBooking",
  custodian: "schoolHutLeaderCustodian",
  memberOnBooking: "schoolHutLeaderMemberOnBooking",
  memberStayingSeparately: "schoolHutLeaderMemberStayingSeparately",
} as const satisfies Record<SchoolHutLeaderKind, keyof LodgeSettingsRecord>;

function kindsFromRecord(record: LodgeSettingsRecord): SchoolHutLeaderKinds {
  const kinds = { ...DEFAULT_SCHOOL_HUT_LEADER_KINDS };
  for (const kind of SCHOOL_HUT_LEADER_KINDS) {
    const value = record[SCHOOL_HUT_LEADER_KIND_COLUMNS[kind]];
    if (typeof value === "boolean") kinds[kind] = value;
  }
  return kinds;
}

function kindsToColumns(kinds: SchoolHutLeaderKinds) {
  return {
    schoolHutLeaderTeacherOnBooking: kinds.teacherOnBooking,
    schoolHutLeaderCustodian: kinds.custodian,
    schoolHutLeaderMemberOnBooking: kinds.memberOnBooking,
    schoolHutLeaderMemberStayingSeparately: kinds.memberStayingSeparately,
  };
}

/**
 * A lodge's school hut-leader kinds, resolved like its soft cap: the lodge's
 * own row, else the legacy "default" row when it is unlinked or linked to this
 * lodge, else {@link DEFAULT_SCHOOL_HUT_LEADER_KINDS}.
 *
 * Unlike the soft cap, a failed read is NOT turned into the defaults: this
 * answer decides whether an approval makes teachers hut leaders and whether a
 * night counts as covered, and a silent default would do either wrongly. Pass
 * the transaction client when the answer decides a write.
 */
export async function loadSchoolHutLeaderKinds(
  db: LodgeSettingsReader,
  lodgeId: string,
): Promise<SchoolHutLeaderKinds> {
  if (!hasLodgeSettings(db)) return { ...DEFAULT_SCHOOL_HUT_LEADER_KINDS };
  const row = await servingLodgeSettingsRow(db, lodgeId);
  return row ? kindsFromRecord(row) : { ...DEFAULT_SCHOOL_HUT_LEADER_KINDS };
}

/**
 * Save one lodge's school hut-leader kinds (#3819) through the one per-lodge
 * writer ({@link writeLodgeOwnSettings}), reading what the lodge resolved to
 * BEFORE the write in the same transaction, so the audit row's "previous" is
 * the value this save replaced and not one a concurrent save already moved.
 */
export async function saveSchoolHutLeaderKinds(input: {
  lodgeId: string;
  kinds: SchoolHutLeaderKinds;
  updatedByMemberId: string;
}): Promise<{ previous: SchoolHutLeaderKinds; saved: SchoolHutLeaderKinds }> {
  return prisma.$transaction(async (tx) => {
    const previous = await loadSchoolHutLeaderKinds(tx, input.lodgeId);
    const row = await writeLodgeOwnSettings(tx, {
      lodgeId: input.lodgeId,
      data: kindsToColumns(input.kinds),
      updatedByMemberId: input.updatedByMemberId,
    });
    return { previous, saved: kindsFromRecord(row) };
  });
}

/**
 * A config import's school hut-leader kinds for one lodge (#3819), through the
 * same per-lodge writer as its capacity.
 */
export async function writeImportedSchoolHutLeaderKinds(
  tx: Pick<Prisma.TransactionClient, "lodgeSettings">,
  input: { lodgeId: string; kinds: SchoolHutLeaderKinds; updatedByMemberId: string },
): Promise<void> {
  await writeLodgeOwnSettings(tx, {
    lodgeId: input.lodgeId,
    data: kindsToColumns(input.kinds),
    updatedByMemberId: input.updatedByMemberId,
  });
}
