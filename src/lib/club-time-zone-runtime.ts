/**
 * The club's timezone, readable from a runtime that is not a React server
 * (CT-5, #2869; epic #2988).
 *
 * ## Why this exists, measured rather than assumed
 *
 * CT-1's reader (`club-time-zone-settings.ts`) and CT-2's binding
 * (`club-time/server.ts`) both carry `import "server-only"`, and that package
 * THROWS on import under anything but the `react-server` condition:
 *
 *     npx tsx -e "import('./src/lib/club-time/server.ts')"
 *     -> This module cannot be imported from a Client Component module.
 *
 * A `tsx` operator script is not a client component, but `server-only` cannot
 * tell the two apart. So a module that both a route and a CLI reach — the
 * finance-sync service, run by the daily cron AND by
 * `npm run finance:backfill-monthly-facts`; the Xero booking-repair loader, run
 * only by `scripts/xero-booking-repair.ts` — cannot import either of them
 * without breaking the CLI at import time, before it prints anything.
 *
 * That gap is not new and this is not a new pattern for it. CT-1's own boot
 * backfill (`clubTimeZoneSelfHealStepDefinition` in `config-self-heal-steps.ts`)
 * reads the row by hand for exactly the same reason, through the same shared
 * `CLUB_TIME_SETTINGS_ID`.
 *
 * ## What it does and does not duplicate
 *
 * It duplicates the QUERY — six lines — and no judgement at all. Which spelling
 * the row lives under (`CLUB_TIME_SETTINGS_ID`), what a usable named zone is
 * (`requireClubTimeZone`), and the precedence of persisted value over
 * environment seed over documented default (`resolveClubTimeZone`) are all
 * CT-1's, imported. The drift hazard CT-1 wrote down was four writers each
 * declaring their own `"default"` literal; sharing the constant is what closes
 * it, and this shares it.
 *
 * ## Where this should end up
 *
 * Beside CT-1's reader, as a second export of it, once something can distinguish
 * "the browser bundle" from "a Node script" better than `server-only` does. A
 * server component or route should keep using `clubTime()` / `clubTimeZone()`
 * from `@/lib/club-time/server`, which is request-scoped and memoised; this is
 * for the modules a CLI can also reach, and for those only.
 */

import {
  asClubTimeZone,
  requireClubTimeZone,
  type ClubTimeZone,
} from "@/lib/club-time";
import {
  CLUB_TIME_SETTINGS_ID,
  CLUB_TIME_ZONE_FALLBACK,
  resolveClubTimeZone,
} from "@/lib/club-time-zone";
import { readEnvironmentClubTimeZoneSeed } from "@/lib/club-time-zone-env";
import { prisma } from "@/lib/prisma";

/** The minimal delegate shape, so a structural fake can stand in for tests. */
type ClubTimeSettingsDelegate = {
  findUnique: (args: {
    where: { id: string };
    select: { timeZone: true };
  }) => Promise<{ timeZone: string } | null>;
};

/**
 * The raw persisted value, or `null` when the row is absent, the database is
 * unreachable, or the Prisma client predates the table.
 *
 * A caller that must tell "the club has not chosen" from "the club chose X"
 * needs this rather than the resolver below, which folds the first case into
 * the environment seed and hands back a string indistinguishable from a chosen
 * one. Never throws.
 */
async function readPersistedClubTimeZoneRow(): Promise<string | null> {
  const delegate = (
    prisma as unknown as { clubTimeSettings?: ClubTimeSettingsDelegate }
  ).clubTimeSettings;
  if (!delegate) return null;
  try {
    const row = await delegate.findUnique({
      where: { id: CLUB_TIME_SETTINGS_ID },
      select: { timeZone: true },
    });
    return row?.timeZone ?? null;
  } catch {
    return null;
  }
}

/**
 * The club's own persisted, usable timezone — or `null` when there is not one.
 *
 * For a caller that must NOT substitute the environment seed for an absent or
 * unreadable row, because doing so would present a fallback as the club's own
 * choice.
 */
export async function readPersistedClubTimeZoneOutsideRequest(): Promise<ClubTimeZone | null> {
  const persisted = await readPersistedClubTimeZoneRow();
  return asClubTimeZone(persisted);
}

/**
 * The club's timezone, validated and branded. Always answers, and never throws.
 *
 * Persisted value -> environment seed (`TZ` / `NEXT_PUBLIC_TZ`, seed-only,
 * retired by CT-6) -> `Pacific/Auckland`, which is CT-1's precedence unchanged.
 * An unreachable database, a missing row and a Prisma client generated before
 * the table existed all resolve to "not persisted" rather than to an exception:
 * a civil-time reader that can throw turns a database blip into a failed cron
 * tick or a CLI that will not start.
 */
export async function readClubTimeZoneOutsideRequest(): Promise<ClubTimeZone> {
  const resolved = resolveClubTimeZone(
    await readPersistedClubTimeZoneRow(),
    readEnvironmentClubTimeZoneSeed(),
  );
  // `resolveClubTimeZone` already validated whatever it returned; the second
  // check is for the one path that could still produce an unusable string — a
  // runtime whose ICU has forgotten a zone the club chose years ago — and it
  // falls back the same way CT-1's own reader does rather than failing the run.
  try {
    return requireClubTimeZone(resolved);
  } catch {
    return requireClubTimeZone(CLUB_TIME_ZONE_FALLBACK);
  }
}
