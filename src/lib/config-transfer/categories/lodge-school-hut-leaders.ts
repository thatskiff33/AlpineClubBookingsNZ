import { strFromU8 } from "fflate";

import {
  loadSchoolHutLeaderKinds,
  writeImportedSchoolHutLeaderKinds,
} from "@/lib/lodge-settings";
import {
  DEFAULT_SCHOOL_HUT_LEADER_KINDS,
  SCHOOL_HUT_LEADER_KINDS,
  type SchoolHutLeaderKinds,
} from "@/lib/school-hut-leader-kinds";

import type { ReadDb, TxDb } from "../import-types";

// A lodge's "Who can be hut leader for school bookings" in a config bundle
// (#3819). It rides in lodge.json as `schoolHutLeaderKinds`, the four ticks the
// lodge RESOLVES to, exactly the way its capacity does (#3407,
// ./lodge-capacity.ts): emitted for every lodge, written to the settings row
// through the one per-lodge writer, never through the LodgeSettings model.
//
// The field is optional. When a lodge.json carries it, those ticks are applied.
// When it does not, an OLDER bundle may still carry #3416's club-wide
// `assignSchoolTeachersAsHutLeaders` in club-settings/booking-request-settings.json;
// that value is mapped onto every imported lodge's teacher tick, leaving its
// other three ticks as they are, so a bundle exported before the setting went
// per lodge keeps its meaning. With neither, the target's ticks are left alone.

const FIELD = "schoolHutLeaderKinds";
export const LEGACY_SWITCH_FILE = "club-settings/booking-request-settings.json";

/** Each lodge's resolved ticks, in the order of `lodgeIds`. */
export function loadLodgeSchoolHutLeaderKinds(
  db: ReadDb,
  lodgeIds: string[],
): Promise<SchoolHutLeaderKinds[]> {
  return Promise.all(lodgeIds.map((id) => loadSchoolHutLeaderKinds(db, id)));
}

/**
 * Validate a lodge.json's ticks: an object of exactly the four kinds, each true
 * or false. An invalid value is recorded as an error (which blocks apply) and
 * deleted, so no partial write can follow.
 */
export function validateBundleSchoolHutLeaderKinds(
  descriptor: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (!(FIELD in descriptor) || descriptor[FIELD] === null) return;
  const value = descriptor[FIELD];
  const valid =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === SCHOOL_HUT_LEADER_KINDS.length &&
    SCHOOL_HUT_LEADER_KINDS.every(
      (kind) => typeof (value as Record<string, unknown>)[kind] === "boolean",
    );
  if (valid) return;
  errors.push(
    `${path}: ${FIELD} must give each of ${SCHOOL_HUT_LEADER_KINDS.join(", ")} as true or false, or be left out`,
  );
  delete descriptor[FIELD];
}

/**
 * An older bundle's club-wide teacher switch, or undefined when the bundle
 * carries none (or carries something that is not true/false).
 */
export function legacyTeacherSwitch(files: Map<string, Uint8Array>): boolean | undefined {
  const bytes = files.get(LEGACY_SWITCH_FILE);
  if (!bytes) return undefined;
  try {
    const value = (JSON.parse(strFromU8(bytes)) as Record<string, unknown>)
      .assignSchoolTeachersAsHutLeaders;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The ticks an import writes for one lodge, or undefined to leave them alone.
 * `current` is the lodge's resolved ticks, or undefined for a lodge this
 * import creates (which would otherwise read the defaults).
 */
export function bundleSchoolHutLeaderKinds(
  descriptor: Record<string, unknown>,
  current: SchoolHutLeaderKinds | undefined,
  legacySwitch: boolean | undefined,
): SchoolHutLeaderKinds | undefined {
  const value = descriptor[FIELD];
  if (value && typeof value === "object") return { ...(value as SchoolHutLeaderKinds) };
  if (legacySwitch === undefined) return undefined;
  return { ...(current ?? DEFAULT_SCHOOL_HUT_LEADER_KINDS), teacherOnBooking: legacySwitch };
}

function sameKinds(a: SchoolHutLeaderKinds, b: SchoolHutLeaderKinds): boolean {
  return SCHOOL_HUT_LEADER_KINDS.every((kind) => a[kind] === b[kind]);
}

/** Whether an import would change a lodge's ticks (the preview's changed field). */
export function schoolHutLeaderKindsChange(
  descriptor: Record<string, unknown>,
  current: SchoolHutLeaderKinds | undefined,
  legacySwitch: boolean | undefined,
): boolean {
  const next = bundleSchoolHutLeaderKinds(descriptor, current, legacySwitch);
  return next !== undefined && current !== undefined && !sameKinds(next, current);
}

/**
 * Write the bundle's ticks for one lodge inside the import transaction, when
 * they differ from what it resolves to. Returns whether it wrote.
 */
export async function applyBundleSchoolHutLeaderKinds(
  tx: TxDb,
  input: {
    descriptor: Record<string, unknown>;
    lodgeId: string;
    current: SchoolHutLeaderKinds | undefined;
    legacySwitch: boolean | undefined;
    actorMemberId: string;
  },
): Promise<boolean> {
  // A lodge this import just created reads whatever now serves it.
  const current = input.current ?? (await loadSchoolHutLeaderKinds(tx, input.lodgeId));
  const kinds = bundleSchoolHutLeaderKinds(input.descriptor, current, input.legacySwitch);
  if (!kinds || sameKinds(kinds, current)) return false;
  await writeImportedSchoolHutLeaderKinds(tx, {
    lodgeId: input.lodgeId,
    kinds,
    updatedByMemberId: input.actorMemberId,
  });
  return true;
}
