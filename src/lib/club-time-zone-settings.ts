import "server-only";

/**
 * The canonical, server-owned club-timezone reader (CT-1, #2989; epic #2988).
 *
 * THIS IS THE ONE PLACE that answers "what timezone is this club in?" for
 * business purposes. The answer comes from `ClubTimeSettings` (id="default"); the
 * environment is consulted only when nothing is persisted, and the reader in the
 * browser is never consulted at all. CT-2 builds the `club-time` kernel on top of
 * this function; nothing downstream should re-derive the zone from
 * `process.env`, from `Intl.DateTimeFormat().resolvedOptions().timeZone`, or from
 * the database session. INV-CONFIG-002.
 *
 * WHY IT IS SERVER-OWNED. A viewer in London must see the same club time as a
 * viewer in Ohakune, so the zone cannot come from the machine rendering the page.
 * Server components read it here and pass the resolved identifier down; a client
 * component receives it as a prop and never asks its own host.
 *
 * WHY IT NEVER THROWS. Every read is defensive: an absent row, an unreachable
 * database (unit tests run with a deliberately unreachable `DATABASE_URL`) and a
 * missing Prisma delegate all resolve to "not persisted", which falls through to
 * the environment seed and then to the documented default. A configuration reader
 * that can throw turns a database blip into a blank page.
 *
 * NO CACHE, DELIBERATELY. This is one primary-key read of a one-row table, and
 * CT-1's callers touch it a handful of times per request. A cache here would need
 * an invalidation contract on every writer, and CT-2 — which is where the hot,
 * per-format call sites arrive — is the change that should choose that contract
 * rather than inherit one guessed at now.
 */

import {
  CLUB_TIME_SETTINGS_ID,
  normaliseClubTimeZone,
  normaliseClubTimeZoneForPreservation,
  resolveClubTimeZone,
} from "@/lib/club-time-zone";
import { readEnvironmentClubTimeZoneSeed } from "@/lib/club-time-zone-env";
import { prisma } from "@/lib/prisma";

/**
 * Re-exported so this module stays the natural import for a server caller, while
 * the single declaration lives in `club-time-zone.ts` — the one module every
 * writer can reach, including the two `tsx` entrypoints that cannot import
 * anything `server-only`. See that constant's own doc for why four separate
 * spellings of `"default"` was a silent-failure hazard rather than a style
 * question (#2989 review).
 */
export { CLUB_TIME_SETTINGS_ID };

/**
 * The Prisma projection EVERY read and write of this row uses — the reader
 * below, the admin route's `findUnique` and its `upsert`.
 *
 * One spelling, exported from the canonical reader, because a second identical
 * copy is the same silent-drift hazard as a second `"default"` literal (#2989
 * fix round). `club-time-zone-admin-state.ts` had declared its own byte-identical
 * copy and exported it under this name; nothing would have failed if the two had
 * come to differ by a column — the route would simply have returned a payload
 * missing a field the panel reads, or audited a `before` value it had not
 * selected.
 */
export const CLUB_TIME_SETTINGS_SELECT = {
  timeZone: true,
  updatedByMemberId: true,
  updatedAt: true,
} as const;

export interface PersistedClubTimeSettings {
  timeZone: string;
  updatedByMemberId: string | null;
  updatedAt: Date;
}

/** The minimal delegate shape, so a structural fake can stand in for tests. */
type ClubTimeSettingsDelegate = {
  findUnique: (args: {
    where: { id: string };
    select: typeof CLUB_TIME_SETTINGS_SELECT;
  }) => Promise<PersistedClubTimeSettings | null>;
};

function clubTimeSettingsDelegate(): ClubTimeSettingsDelegate | undefined {
  return (
    prisma as unknown as { clubTimeSettings?: ClubTimeSettingsDelegate }
  ).clubTimeSettings;
}

/**
 * The persisted row, or `null` when it is absent, the database is unreachable, or
 * the delegate does not exist. Never throws — see the module doc.
 */
export async function loadPersistedClubTimeSettings(): Promise<PersistedClubTimeSettings | null> {
  const delegate = clubTimeSettingsDelegate();
  if (!delegate) return null;
  try {
    return await delegate.findUnique({
      where: { id: CLUB_TIME_SETTINGS_ID },
      select: CLUB_TIME_SETTINGS_SELECT,
    });
  } catch {
    return null;
  }
}

/**
 * The club's timezone as a validated IANA identifier. Always answers.
 *
 * Persisted value → environment seed (`TZ` / `NEXT_PUBLIC_TZ`, seed-only, retired
 * by CT-6) → `Pacific/Auckland`. Once the row exists the environment is not
 * consulted, so changing the container's `TZ` cannot change what this returns.
 */
export async function getClubTimeZone(): Promise<string> {
  const persisted = await loadPersistedClubTimeSettings();
  return resolveClubTimeZone(
    persisted?.timeZone ?? null,
    readEnvironmentClubTimeZoneSeed(),
  );
}

/**
 * Where the answer came from, for the surfaces that have to SAY so — the setup
 * readiness step and the maintenance page both have to distinguish "this club has
 * chosen its timezone" from "this is what the environment happens to say until
 * the first boot of the upgraded release persists it".
 */
export type ClubTimeZoneSource =
  | "persisted"
  | "persisted-unusable"
  | "environment"
  | "default";

export interface ResolvedClubTimeZone {
  timeZone: string;
  source: ClubTimeZoneSource;
  /** The persisted row, when there is one — for "changed by" / "changed at". */
  persisted: PersistedClubTimeSettings | null;
}

/**
 * {@link getClubTimeZone} plus its provenance.
 *
 * The provenance is decided by asking each candidate the SAME question
 * `resolveClubTimeZone` asks — "does this normalise to a usable zone?" — rather
 * than by string-comparing the answer against the raw stored text. Those two are
 * not the same test: a stored value can be a deprecated alias or a case variant
 * (`US/Pacific`, `pacific/auckland`), which normalises to a different spelling,
 * and comparing spellings would then report a perfectly good configured zone as
 * having come from the environment.
 */
export async function resolveClubTimeZoneWithSource(): Promise<ResolvedClubTimeZone> {
  const persisted = await loadPersistedClubTimeSettings();
  const environmentSeed = readEnvironmentClubTimeZoneSeed();
  const timeZone = resolveClubTimeZone(
    persisted?.timeZone ?? null,
    environmentSeed,
  );
  /*
    `persisted-unusable` is a distinct answer from `environment`, and conflating
    them produced a wrong instruction on the one screen whose job is to explain
    provenance (#2989 review). A row whose `timeZone` does not validate — a
    hand-edit, a bad restore, a future writer that skips the validator — is NOT
    the same state as no row at all: the club HAS recorded something, it just
    cannot be used, and the boot backfill will never repair it because its
    presence check is row-level. Reporting that as "nothing recorded yet, the app
    records it on the next restart" tells the reader to do something that cannot
    work. Saying so explicitly lets the panel and the setup checklist give the one
    instruction that does: set the timezone again.

    EACH LEG IS JUDGED BY THE RULE THAT PRODUCED IT (#2989 fix round). The
    persisted leg uses the strict validator, exactly as `resolveClubTimeZone`
    does; the environment leg uses the PRESERVATION rule, exactly as
    `resolveClubTimeZone` does. Asking the strict validator about the environment
    — which is what this ternary did — made the answer disagree with the value
    beside it on any deployment whose `TZ` is one of the thirty-six legacy
    aliases: with `TZ=GB` and no row, `timeZone` was `Europe/London` and `source`
    was `default`, so the maintenance panel said "Europe/London — Default:
    nothing has been recorded and the server says nothing either". Three false
    claims in one sentence, and no hint that the next restart would record
    Europe/London.
  */
  const source: ClubTimeZoneSource =
    normaliseClubTimeZone(persisted?.timeZone) !== null
      ? "persisted"
      : persisted
        ? "persisted-unusable"
        : normaliseClubTimeZoneForPreservation(environmentSeed) !== null
          ? "environment"
          : "default";
  return { timeZone, source, persisted };
}
