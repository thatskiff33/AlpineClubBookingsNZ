import "server-only";

/**
 * The canonical, server-owned reader for the club's currency and locale (stage
 * 1 of programme #3205, #3563). INV-CONFIG-006.
 *
 * THIS IS THE ONE PLACE that will answer "what currency does this club charge
 * in, and how does it format numbers and dates?" The answer comes from
 * `ClubFormatSettings` (id="default"); the environment is consulted only when
 * nothing is persisted, and the reader in the browser is never consulted at all.
 *
 * EVERY DISPLAY READER NOW COMES HERE. Owner decision D1 on #3205: the
 * authority was created first (stage 1) and the readers moved behind it — the
 * browser seam (#3564), the money formatters (#3565) and the date locale and
 * remaining server readers (#3566) — and #3567 moved card charges onto it and
 * deleted the old environment constants with `src/config/operational.ts`. A new
 * reader comes here (or to `club-format-server.ts` in a request).
 *
 * WHY IT IS SERVER-OWNED. A viewer in London must see the same club currency as
 * a viewer in Ohakune, so it cannot come from the machine rendering the page,
 * and `NEXT_PUBLIC_*` is inlined at BUILD time into an image that serves every
 * club. Server components read it here and pass the resolved values down; a
 * client component receives them as props and never asks its own host.
 *
 * WHY IT NEVER THROWS. Every read is defensive: an absent row, an unreachable
 * database (unit tests run with a deliberately unreachable `DATABASE_URL`) and a
 * missing Prisma delegate all resolve to "not persisted", which falls through to
 * the environment seed and then to the documented defaults. A configuration
 * reader that can throw turns a database blip into a blank page.
 *
 * NO CACHE, DELIBERATELY — the same call `club-time-zone-settings.ts` makes and
 * for the same reason. This is one primary-key read of a one-row table, and
 * stage 1 has a handful of callers. A cache here would need an invalidation
 * contract on every writer, and #3565 — which is where the hot, per-format call
 * sites arrive — is the change that should choose that contract rather than
 * inherit one guessed at now.
 */

import {
  CLUB_FORMAT_SETTINGS_ID,
  normaliseClubLocale,
  usableClubCurrencyCode,
  type ClubFormat,
} from "@/lib/club-format";
import {
  readEnvironmentClubFormatSeed,
  resolveStoredClubFormat,
} from "@/lib/club-format-env";
import { prisma } from "@/lib/prisma";

/**
 * Re-exported so this module stays the natural import for a server caller,
 * while the single declaration lives in `club-format.ts` — the one module every
 * writer can reach, including the browser panel. See that constant's own doc
 * for why several spellings of `"default"` is a silent-failure hazard rather
 * than a style question.
 */
export { CLUB_FORMAT_SETTINGS_ID };

/**
 * The Prisma projection EVERY read and write of this row uses — the reader
 * below, the admin route's `findUnique` and its `upsert`.
 *
 * One spelling, exported from the canonical reader, because a second identical
 * copy is the same silent-drift hazard as a second `"default"` literal. That is
 * not hypothetical: `club-time-zone-admin-state.ts` shipped a byte-identical
 * copy of its equivalent and nothing would have failed had the two come to
 * differ by a column — the route would simply have returned a payload missing a
 * field the panel reads, or audited a `before` value it had not selected
 * (#2989 fix round).
 */
export const CLUB_FORMAT_SETTINGS_SELECT = {
  currencyCode: true,
  locale: true,
  updatedByMemberId: true,
  updatedAt: true,
} as const;

export interface PersistedClubFormatSettings {
  currencyCode: string;
  locale: string;
  updatedByMemberId: string | null;
  updatedAt: Date;
}

/** The minimal delegate shape, so a structural fake can stand in for tests. */
type ClubFormatSettingsDelegate = {
  findUnique: (args: {
    where: { id: string };
    select: typeof CLUB_FORMAT_SETTINGS_SELECT;
  }) => Promise<PersistedClubFormatSettings | null>;
};

function clubFormatSettingsDelegate(): ClubFormatSettingsDelegate | undefined {
  return (
    prisma as unknown as { clubFormatSettings?: ClubFormatSettingsDelegate }
  ).clubFormatSettings;
}

/**
 * The persisted row, or `null` when it is absent, the database is unreachable,
 * or the delegate does not exist. Never throws — see the module doc.
 */
export async function loadPersistedClubFormatSettings(): Promise<PersistedClubFormatSettings | null> {
  const delegate = clubFormatSettingsDelegate();
  if (!delegate) return null;
  try {
    return await delegate.findUnique({
      where: { id: CLUB_FORMAT_SETTINGS_ID },
      select: CLUB_FORMAT_SETTINGS_SELECT,
    });
  } catch {
    return null;
  }
}

/**
 * The club's currency and locale, both validated. Always answers.
 *
 * Persisted row -> environment seed (`CURRENCY` / `LOCALE`, seed-only) ->
 * `NZD` / `en-NZ`. Once the row exists the environment is not
 * consulted, so editing `CURRENCY` on the server cannot change what this
 * returns — which is owner decision D3 on #3205, and is what the operator
 * documentation has to say plainly.
 */
export async function getClubFormat(): Promise<ClubFormat> {
  return resolveStoredClubFormat(await loadPersistedClubFormatSettings());
}

/**
 * Where one field's answer came from, for the surfaces that have to SAY so. The
 * maintenance panel has to distinguish "this club has chosen its currency" from
 * "this is what the environment happens to say until the first boot of the
 * upgraded release records it".
 */
export type ClubFormatFieldSource =
  | "persisted"
  | "persisted-unusable"
  | "environment"
  | "default";

export interface ResolvedClubFormat {
  format: ClubFormat;
  currencySource: ClubFormatFieldSource;
  localeSource: ClubFormatFieldSource;
  /** The persisted row, when there is one — for "changed by" / "changed at". */
  persisted: PersistedClubFormatSettings | null;
}

function fieldSource(
  persistedRowExists: boolean,
  persistedValue: string | null | undefined,
  environmentValue: string | null,
  normalise: (value: string | null | undefined) => string | null,
): ClubFormatFieldSource {
  /*
    `persisted-unusable` is a distinct answer from `environment`, and conflating
    them produced a wrong INSTRUCTION on the one screen whose job is to explain
    provenance (#2989 review, on the timezone's identical shape). A row whose
    value does not validate — a hand-edit, a bad restore, a future writer that
    skips the validator — is NOT the same state as no row at all: the club HAS
    recorded something, it just cannot be used, and the boot backfill will never
    repair it because its presence check is row-level. Reporting that as
    "nothing recorded yet, the app records it on the next restart" tells the
    reader to do something that cannot work.

    The provenance is decided by asking each candidate the SAME question
    `resolveClubFormat` asks — "does this normalise?" — rather than by
    string-comparing the answer against the raw stored text. Those are not the
    same test: a stored `nzd` normalises to a different spelling, and comparing
    spellings would report a perfectly good configured currency as having come
    from the environment.
  */
  if (normalise(persistedValue) !== null) return "persisted";
  if (persistedRowExists) return "persisted-unusable";
  return normalise(environmentValue) !== null ? "environment" : "default";
}

/** {@link getClubFormat} plus each field's provenance. */
export async function resolveClubFormatWithSource(): Promise<ResolvedClubFormat> {
  const persisted = await loadPersistedClubFormatSettings();
  const environment = readEnvironmentClubFormatSeed();
  return {
    format: resolveStoredClubFormat(persisted),
    currencySource: fieldSource(
      persisted !== null,
      persisted?.currencyCode,
      environment.currencyCode,
      // #3567 review: a stored JPY is "Not usable", not "Configured".
      usableClubCurrencyCode,
    ),
    localeSource: fieldSource(
      persisted !== null,
      persisted?.locale,
      environment.locale,
      normaliseClubLocale,
    ),
    persisted,
  };
}
