import "server-only";

/**
 * What the club-format maintenance surface is TOLD about the setting (stage 1
 * of programme #3205, #3563) — the payload `/api/admin/club-format` returns on
 * both verbs, and the two readers that build it.
 *
 * It is a module rather than part of the route because `src/app` validates and
 * authorises at the boundary and delegates the rest to `src/lib`
 * (`docs/ARCHITECTURE.md` -> "Where code lives"), and because this half has one
 * question of its own: what may travel to a browser.
 *
 * WHAT IS DELIBERATELY NOT HERE. The currency selector list: an option list is
 * a list of CHOICES the browser may render, and it has no business on the
 * payload that states what the club's currency actually IS. Nor the changer's
 * email — see `MEMBER_NAME_SELECT`.
 */

import type {
  ClubFormatFieldSource,
  PersistedClubFormatSettings,
  ResolvedClubFormat,
} from "@/lib/club-format-settings";
import { prisma } from "@/lib/prisma";

/**
 * Name fields ONLY. The panel says WHO last changed the format, so it needs a
 * display name and nothing else — selecting the email, or the whole row, would
 * put a contact address into a configuration payload with no use for one.
 */
const MEMBER_NAME_SELECT = {
  firstName: true,
  lastName: true,
} as const;

/** The row this module turns into a payload. */
export type PersistedRow = PersistedClubFormatSettings;

/**
 * The payload.
 *
 * `currencySource` / `localeSource` are the provenance words the panel explains
 * to the operator, so they travel rather than being re-derived in the browser —
 * which cannot derive them anyway, because it can see neither the row nor the
 * server's environment.
 *
 * `unusableStoredCurrency` / `unusableStoredLocale` are non-null for exactly one
 * state each: `persisted-unusable`, a row whose stored value this runtime cannot
 * use (a hand-edit, a bad restore, an ICU that stopped accepting the tag). The
 * panel has to NAME it, because "the stored value is not usable" is unactionable
 * without saying which one, and the boot backfill will never repair it: that
 * check is row-level, so the bad row counts as present. The value beside it is
 * the one actually in force — the environment seed, or the shipped default —
 * never the unusable text.
 */
export type ClubFormatState = {
  currencyCode: string;
  locale: string;
  currencySource: ClubFormatFieldSource;
  localeSource: ClubFormatFieldSource;
  updatedAt: string | null;
  updatedByName: string | null;
  unusableStoredCurrency: string | null;
  unusableStoredLocale: string | null;
};

/**
 * The display name of the member who last saved, or `null`. Defensive because
 * the column carries no foreign key (the house shape for a settings singleton),
 * so the member may since have been merged or deleted: a missing member, a blank
 * name and an unreachable database all mean "we cannot name them", never a
 * failed read of the setting.
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
  resolved: ResolvedClubFormat,
): Promise<ClubFormatState> {
  return {
    currencyCode: resolved.format.currencyCode,
    locale: resolved.format.locale,
    currencySource: resolved.currencySource,
    localeSource: resolved.localeSource,
    updatedAt: resolved.persisted?.updatedAt.toISOString() ?? null,
    updatedByName: await readChangedByName(
      resolved.persisted?.updatedByMemberId ?? null,
    ),
    unusableStoredCurrency:
      resolved.currencySource === "persisted-unusable"
        ? (resolved.persisted?.currencyCode ?? null)
        : null,
    unusableStoredLocale:
      resolved.localeSource === "persisted-unusable"
        ? (resolved.persisted?.locale ?? null)
        : null,
  };
}

/**
 * The state a WRITE produces: both fields `persisted` and neither unusable,
 * because the saved values came through the validators and the route's dirty
 * gate can only match a stored pair that did too.
 */
export async function stateFromRow(
  row: PersistedRow,
): Promise<ClubFormatState> {
  return {
    currencyCode: row.currencyCode,
    locale: row.locale,
    currencySource: "persisted",
    localeSource: "persisted",
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: await readChangedByName(row.updatedByMemberId),
    unusableStoredCurrency: null,
    unusableStoredLocale: null,
  };
}
