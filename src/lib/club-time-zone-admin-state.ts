import "server-only";

/**
 * What the club-timezone maintenance surface is TOLD about the setting (CT-1,
 * #2989; epic #2988) — the payload `/api/admin/club-time-zone` returns on both
 * verbs, and the two readers that build it.
 *
 * It is a module rather than part of the route because the route is already at
 * its documented size budget with the authorisation, confirmation, audit and
 * isolation reasoning that is genuinely about the WRITE, and because this half
 * has one question of its own: what may travel to a browser. `src/app` validates
 * and authorises at the boundary and delegates the rest to `src/lib`
 * (`docs/ARCHITECTURE.md` -> "Where code lives"), and this is the rest.
 *
 * WHAT IS DELIBERATELY NOT HERE. The 418-entry selector list: an option list is
 * a list of CHOICES the browser may render, and it has no business on the
 * payload that states what the club's timezone actually IS. Nor the changer's
 * email — see `MEMBER_NAME_SELECT`.
 */

import type {
  ClubTimeZoneSource,
  PersistedClubTimeSettings,
  ResolvedClubTimeZone,
} from "@/lib/club-time-zone-settings";
import { prisma } from "@/lib/prisma";

/**
 * Name fields ONLY. The panel says WHO last changed the timezone, so it needs a
 * display name and nothing else — selecting the email, or the whole row, would
 * put a contact address into a configuration payload with no use for one.
 */
const MEMBER_NAME_SELECT = {
  firstName: true,
  lastName: true,
} as const;

/**
 * The row this module turns into a payload.
 *
 * The PROJECTION that produces it — `CLUB_TIME_SETTINGS_SELECT` — lives in
 * `club-time-zone-settings.ts`, the canonical reader, and this module used to
 * carry a byte-identical copy of it under the same name (#2989 fix round). Two
 * copies of one projection drift the way two spellings of the singleton id
 * drift, and just as quietly, so there is now one.
 */
export type PersistedRow = PersistedClubTimeSettings;

/**
 * The payload. `source` is the provenance word the panel and the setup
 * checklist both explain to the operator, so it travels rather than being
 * re-derived in the browser.
 *
 * `unusableStoredValue` is non-null for exactly one state — `persisted-unusable`,
 * a row whose stored zone this runtime cannot use (a hand-edit, a bad restore,
 * an ICU that dropped the zone). The panel has to NAME it, because "the stored
 * timezone is not usable" is unactionable without saying which one, and the boot
 * backfill will never repair it: that check is row-level, so the bad row counts
 * as present. `timeZone` in that state is the zone actually in force — the
 * environment seed, or the shipped default — never the unusable text.
 */
export type ClubTimeZoneState = {
  timeZone: string;
  source: ClubTimeZoneSource;
  updatedAt: string | null;
  updatedByName: string | null;
  unusableStoredValue: string | null;
};

/**
 * The display name of the member who last saved, or `null`. Defensive because
 * the column carries no foreign key (the house shape for a settings singleton),
 * so the member may since have been merged or deleted: a missing member, a blank
 * name and an unreachable database all mean "we cannot name them", never a
 * failed read of the timezone.
 */
async function readChangedByName(
  memberId: string | null,
): Promise<string | null> {
  if (!memberId) return null;
  try {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: MEMBER_NAME_SELECT,
    });
    if (!member) return null;
    return `${member.firstName} ${member.lastName}`.trim() || null;
  } catch {
    return null;
  }
}

/** The state a READ produces, provenance and all. */
export async function stateFromResolved(
  resolved: ResolvedClubTimeZone,
): Promise<ClubTimeZoneState> {
  return {
    timeZone: resolved.timeZone,
    source: resolved.source,
    updatedAt: resolved.persisted?.updatedAt.toISOString() ?? null,
    updatedByName: await readChangedByName(
      resolved.persisted?.updatedByMemberId ?? null,
    ),
    unusableStoredValue:
      resolved.source === "persisted-unusable"
        ? (resolved.persisted?.timeZone ?? null)
        : null,
  };
}

/**
 * The state a WRITE produces: always `persisted` and never unusable, because the
 * saved value came through `normaliseClubTimeZone` and the route's dirty gate can
 * only match a stored value that did too.
 */
export async function stateFromRow(
  row: PersistedRow,
): Promise<ClubTimeZoneState> {
  return {
    timeZone: row.timeZone,
    source: "persisted",
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: await readChangedByName(row.updatedByMemberId),
    unusableStoredValue: null,
  };
}
