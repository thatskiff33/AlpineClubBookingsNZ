/**
 * The club's civil time, for the email templates (CT-5, #2869; epic #2988).
 *
 * Every date and time a member reads in a club email is CLUB time — the same
 * time the application shows on screen, whatever zone the container that
 * rendered the message is in and whatever zone the reader is in. This module is
 * the one place the email surface learns what that zone is.
 *
 * ## Why a cached accessor rather than an argument
 *
 * The templates in `email-templates/` are synchronous pure functions, rendered
 * from around twenty sending modules, and all ~175 of their date call sites
 * would otherwise have to thread a zone down from an `async` caller. That is
 * exactly the shape `email-theme.ts` already solved for the club's brand palette
 * — a module-level cache with a synchronous accessor — so this follows it rather
 * than inventing a second pattern beside it.
 *
 * ## Why it sits BESIDE `email-templates/`, not inside it
 *
 * That directory has a stated contract: one module per message family, plus the
 * shared `layout` and `escape` leaves. `email-render-equivalence.test.ts`
 * enforces it by reading the directory off disk and requiring a pinned rendered
 * body for every function any module in it exports. This module renders nothing,
 * so it has no body to pin — putting it inside would mean either weakening that
 * census or pinning `primeEmailClubTimeZone` as though it were a template.
 *
 * ## The two states, and why the synchronous accessor never does I/O
 *
 * - **Not primed** — the answer is the environment seed, resolved through CT-1's
 *   own precedence and **frozen at module load**, which is character-for-character
 *   the `APP_TIME_ZONE` these templates used before this change. A cold cache is
 *   therefore today's behaviour, never a guess at a club's location.
 * - **Primed** — the persisted `ClubTimeSettings.timeZone` (`INV-CONFIG-002`).
 *
 * The seed is read ONCE rather than per call, deliberately. `APP_TIME_ZONE` is a
 * module constant, so the surface this replaces could not move mid-process; a
 * live `process.env.TZ` read would make an email's dates depend on when it was
 * rendered relative to an environment change, and would let one suite's `TZ` pin
 * leak into another suite's rendered output.
 *
 * Nothing here reads the database from the synchronous path. A render is a pure
 * function, and starting a query inside one is how a cold cache turns into an
 * unbounded fan-out of reads under load.
 *
 * ## When it is primed
 *
 * At server boot, by `instrumentation.node.ts`, beside the email palette prime
 * and for the same reason (#1912, #2900): Next awaits `register()` before it
 * serves a request, so by the time any route, cron tick or webhook renders an
 * email the persisted zone is already loaded. After that a TTL refresh keeps a
 * zone change made through the guarded admin page reaching emails without a
 * restart.
 *
 * ## What a failed read does — and does NOT — do
 *
 * The reader is `readPersistedClubTimeZoneOutsideRequest()`, which answers
 * `null` for "no row, no usable row, or the database could not be reached" —
 * NOT the resolver beside it, which folds those cases into the environment seed
 * and hands back a string indistinguishable from a persisted one. Committing a seed as though it were the club's choice is the
 * `readFailed` trap `email-theme.ts` documents one module along. So a failed or
 * empty read commits NOTHING: the last good value stands, or the environment
 * fallback does — which is the answer `getClubTimeZone()` would have given for
 * an absent row anyway.
 *
 * ## The honest limit
 *
 * There is no render gate. `renderEmailHtml()` (in `email-theme.ts`, which
 * belongs to another lane's file set this window) awaits the palette before any
 * themed HTML is built and is the natural place to await this too; wiring it
 * there would close the boot-prime-failed window rather than leaving it to the
 * next restart. Until then the worst case is emails dated in the environment's
 * zone on a deployment where the environment and the persisted value disagree —
 * which is the zone those emails used before this change.
 */

import {
  bindClubTime,
  requireClubTimeZone,
  type BoundClubTime,
  type ClubTimeZone,
  type Instant,
} from "@/lib/club-time";
import { resolveClubTimeZone } from "@/lib/club-time-zone";
import { readEnvironmentClubTimeZoneSeed } from "@/lib/club-time-zone-env";
import { readPersistedClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";

/** How long a loaded zone is served before a background re-read is started. */
const TTL_MS = 5 * 60 * 1000;

/**
 * The environment seed's answer, resolved once at module load. See "The two
 * states" above for why this is frozen rather than read per call.
 */
const ENVIRONMENT_FALLBACK: BoundClubTime = bindClubTime(
  requireClubTimeZone(
    resolveClubTimeZone(null, readEnvironmentClubTimeZoneSeed()),
  ),
);

let persisted: BoundClubTime | null = null;
let loadedAt = 0;
let refreshing = false;

/** The club's zone for an email being rendered right now. Never does I/O. */
function emailClubTime(): BoundClubTime {
  if (persisted === null) return ENVIRONMENT_FALLBACK;
  if (Date.now() - loadedAt > TTL_MS) {
    // Only ever AFTER a successful prime, so a cold process cannot start a
    // database read from inside a synchronous render.
    void refreshEmailClubTimeZone();
  }
  return persisted;
}

async function refreshEmailClubTimeZone(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  // Stamp up front so a burst of renders starts one read, not one per message.
  loadedAt = Date.now();
  try {
    await primeEmailClubTimeZone();
  } finally {
    refreshing = false;
  }
}

/**
 * Read the persisted club timezone and, if there is one, make it the answer.
 *
 * The boot warm point, mirroring `primeEmailPalette()`. Never throws, and never
 * commits anything but a real persisted value — see "What a failed read does".
 */
export async function primeEmailClubTimeZone(): Promise<void> {
  let zone: ClubTimeZone | null = null;
  try {
    zone = await readPersistedClubTimeZoneOutsideRequest();
  } catch {
    // The reader swallows its own database error; this is belt and braces so a
    // boot prime can never fail a server start.
    return;
  }
  if (zone === null) return;
  persisted = bindClubTime(zone);
  loadedAt = Date.now();
}

/** "16 Apr 2026" — the club calendar day a moment falls on. */
export function emailClubDate(value: Instant): string {
  return emailClubTime().instantDate(value);
}

/** "16 Apr 2026, 2:30 pm" — the club civil date and time of a moment. */
export function emailClubDateTime(value: Instant): string {
  return emailClubTime().instantDateTime(value);
}

/** Test hook: the zone the templates are rendering in right now. */
export function emailClubTimeZoneForTests(): ClubTimeZone {
  return emailClubTime().zone;
}

/** Test hook: return the cache to its cold, environment-seeded state. */
export function __resetEmailClubTimeZoneForTests(): void {
  persisted = null;
  loadedAt = 0;
  refreshing = false;
}
