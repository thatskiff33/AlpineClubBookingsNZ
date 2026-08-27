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
 * `__tests__/cli-server-only-reach-census.test.ts` walks the real import graph
 * from every CLI entrypoint and fails if one regains such an edge.
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
 * ## A resolution that says where its answer came from
 *
 * `readClubTimeZoneOutsideRequest()` always answers, which is right for a
 * civil-time reader that a cron tick and a CLI both depend on — but "always
 * answers" and "answered from the club's own setting" are different facts, and
 * a caller that cannot tell them apart will present a fallback as a choice.
 * {@link resolveClubTimeZoneOutsideRequest} reports both, so the boot hook can
 * log which happened instead of logging every outcome as a success (#2869
 * review).
 *
 * ## What a failed read does, and why it is not silent
 *
 * A read that THROWS — a pool timeout, a database restart mid-request — is not
 * the same as an absent row, and this module no longer folds the two together.
 * Both still resolve to a fallback rather than an exception, because a civil-time
 * reader that can throw turns a database blip into a failed cron tick or a CLI
 * that will not start. But the failure is LOGGED, throttled to one line per
 * minute per process, because these calls now date financial records: an
 * invoice's `date` and `dueDate`, a credit note's date, a payment's date. Each
 * of those decides a GST period and a financial year, and a document quietly
 * dated in the wrong calendar with nothing in the log is the shape of defect
 * this epic exists to end.
 *
 * IT DELIBERATELY DOES NOT THROW ON THAT PATH, and the reasoning is worth
 * stating rather than rediscovering. Refusing to produce a document date would
 * take a club's invoicing offline for two conditions that are not emergencies:
 * a brief database blip, and a club that has never configured its zone — which
 * is a real, reachable state, because CT-1's self-heal correctly refuses to
 * GUESS a location when the deployment's `TZ` names no place (`UTC`, `GMT`,
 * `Etc/*`). Those clubs would lose Xero invoicing entirely at a moment when the
 * setup checklist is already telling them what to fix. A loud log plus a visible
 * setup blocker is the proportionate answer; the residual limit is that a
 * document created inside the blip carries the fallback zone's calendar day,
 * and the log line is what makes it findable afterwards.
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
  normaliseClubTimeZone,
  normaliseClubTimeZoneForPreservation,
  resolveClubTimeZone,
} from "@/lib/club-time-zone";
import { readEnvironmentClubTimeZoneSeed } from "@/lib/club-time-zone-env";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/** The minimal delegate shape, so a structural fake can stand in for tests. */
type ClubTimeSettingsDelegate = {
  findUnique: (args: {
    where: { id: string };
    select: { timeZone: true };
  }) => Promise<{ timeZone: string } | null>;
};

/**
 * Where the answer came from. `persisted` is the club's own choice; the other
 * two are fallbacks, and a caller that reports one as the club's zone without
 * saying so is making a claim the data does not support.
 */
export type ClubTimeZoneSourceOutsideRequest =
  | "persisted"
  | "environment-seed"
  | "default";

export interface ClubTimeZoneResolution {
  /** The zone to use. Always a usable named IANA identifier. */
  readonly zone: ClubTimeZone;
  readonly source: ClubTimeZoneSourceOutsideRequest;
  /**
   * True when the persisted read THREW rather than finding nothing — the
   * database was unreachable, or the query failed. Distinct from `source`,
   * because "the club has not chosen" and "we could not look" are different
   * states that happen to produce the same fallback.
   */
  readonly readFailed: boolean;
}

/** At most one "could not read the club's timezone" line per window. */
const READ_FAILURE_WARN_INTERVAL_MS = 60_000;
let lastReadFailureWarnAt = 0;

type PersistedRowRead =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false };

/**
 * The raw persisted value, or the fact that the read failed.
 *
 * A caller that must tell "the club has not chosen" from "the club chose X"
 * needs this rather than the resolver below, which folds the first case into
 * the environment seed and hands back a string indistinguishable from a chosen
 * one. Never throws.
 *
 * A Prisma client generated before the table existed reports `ok` with a `null`
 * value rather than a failure: nothing went wrong, the deployment simply has no
 * such table yet, and treating it as an outage would log a warning on every
 * blue/green boot of the expand phase.
 */
async function readPersistedClubTimeZoneRow(): Promise<PersistedRowRead> {
  const delegate = (
    prisma as unknown as { clubTimeSettings?: ClubTimeSettingsDelegate }
  ).clubTimeSettings;
  if (!delegate) return { ok: true, value: null };
  try {
    const row = await delegate.findUnique({
      where: { id: CLUB_TIME_SETTINGS_ID },
      select: { timeZone: true },
    });
    return { ok: true, value: row?.timeZone ?? null };
  } catch {
    return { ok: false };
  }
}

/** One throttled line, so a sustained outage cannot turn into a log flood. */
function warnClubTimeZoneUnreadable(zone: string): void {
  const now = Date.now();
  if (
    lastReadFailureWarnAt !== 0 &&
    now - lastReadFailureWarnAt < READ_FAILURE_WARN_INTERVAL_MS
  ) {
    return;
  }
  lastReadFailureWarnAt = now;
  try {
    logger.warn(
      { scope: "club-time-zone", fallbackTimeZone: zone },
      "The club's persisted timezone could not be read; falling back for this call. Anything dated while this lasts — an invoice, a credit note, a payment — carries the fallback zone's calendar day, not the club's.",
    );
  } catch {
    // A broken logger must not take a cron tick or an invoice down with it.
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
  const read = await readPersistedClubTimeZoneRow();
  return read.ok ? asClubTimeZone(read.value) : null;
}

/**
 * The club's timezone AND where it came from. Always answers, never throws.
 *
 * Persisted value -> environment seed (`TZ` / `NEXT_PUBLIC_TZ`, seed-only,
 * retired by CT-6) -> `Pacific/Auckland`, which is CT-1's precedence unchanged.
 * The two legs use CT-1's two normalisers for CT-1's reasons, so `source` is
 * decided by the same judgement `resolveClubTimeZone` applies rather than by a
 * second opinion beside it.
 */
export async function resolveClubTimeZoneOutsideRequest(): Promise<ClubTimeZoneResolution> {
  const read = await readPersistedClubTimeZoneRow();
  const persisted = read.ok ? read.value : null;
  const environmentSeed = readEnvironmentClubTimeZoneSeed();
  const resolved = resolveClubTimeZone(persisted, environmentSeed);

  // `resolveClubTimeZone` already validated whatever it returned; the second
  // check is for the one path that could still produce an unusable string — a
  // runtime whose ICU has forgotten a zone the club chose years ago — and it
  // falls back the same way CT-1's own reader does rather than failing the run.
  let zone: ClubTimeZone;
  try {
    zone = requireClubTimeZone(resolved);
  } catch {
    zone = requireClubTimeZone(CLUB_TIME_ZONE_FALLBACK);
  }

  const source: ClubTimeZoneSourceOutsideRequest =
    normaliseClubTimeZone(persisted) !== null
      ? "persisted"
      : normaliseClubTimeZoneForPreservation(environmentSeed) !== null
        ? "environment-seed"
        : "default";

  if (!read.ok) warnClubTimeZoneUnreadable(zone);

  return { zone, source, readFailed: !read.ok };
}

/**
 * The club's timezone, validated and branded. Always answers, never throws.
 *
 * The plain reader, for the great majority of callers that have nothing useful
 * to do with the provenance. A caller that WILL report the answer to an
 * operator, or pin it for a process lifetime, wants
 * {@link resolveClubTimeZoneOutsideRequest} instead.
 */
export async function readClubTimeZoneOutsideRequest(): Promise<ClubTimeZone> {
  return (await resolveClubTimeZoneOutsideRequest()).zone;
}

/** Test hook: forget the warning throttle so a suite can observe the next one. */
export function __resetClubTimeZoneRuntimeWarningForTests(): void {
  lastReadFailureWarnAt = 0;
}
