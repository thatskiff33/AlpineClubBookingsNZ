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
 * ## The two states, and what a cold cache actually answers
 *
 * - **Not primed** — the answer is the environment seed, resolved through CT-1's
 *   own precedence and **frozen at module load**.
 * - **Primed** — the persisted `ClubTimeSettings.timeZone` (`INV-CONFIG-002`).
 *
 * A cold cache is TODAY'S BEHAVIOUR FOR EVERY DEPLOYMENT WHOSE `TZ` NAMES A
 * PLACE, and that is the honest form of the claim — the earlier wording said
 * "character-for-character the `APP_TIME_ZONE` these templates used before",
 * which is false for one class and worth naming rather than glossing (#2869
 * review). `APP_TIME_ZONE` is `process.env.TZ` UNVALIDATED, whereas this
 * resolves the seed through `resolveClubTimeZone`, which refuses a value that
 * names no place — `UTC`, `GMT`, `Zulu`, `Universal`, `UCT`, `Greenwich`,
 * `Etc/*`, `SystemV/*` — and answers `Pacific/Auckland` instead. So a deployment
 * running `TZ=UTC` with no persisted row sees its email dates move by up to
 * thirteen hours on the release that lands this. That is the epic's intended
 * behaviour and matches CT-1's refusal to record such a seed: an abbreviation or
 * a fixed offset names no place, so it promises nothing about next spring's DST
 * rules. The remedy is the same one the setup checklist already asks for — set
 * the club's zone on Admin -> Club Time Zone. The thirty-six legacy spellings
 * that DO canonicalise to a location (`GB` -> `Europe/London`, `NZ-CHAT` ->
 * `Pacific/Chatham`) are preserved exactly, so only the non-location class moves.
 *
 * The seed is read ONCE rather than per call, deliberately. `APP_TIME_ZONE` is a
 * module constant, so the surface this replaces could not move mid-process; a
 * live `process.env.TZ` read would make an email's dates depend on when it was
 * rendered relative to an environment change, and would let one suite's `TZ` pin
 * leak into another suite's rendered output.
 *
 * ## The synchronous accessor never WAITS, and self-warms from cold
 *
 * A render never awaits a database read: `emailClubDate()` answers from the
 * cache and returns. It does start a background read when the cache is stale OR
 * has never been loaded, which is exactly what `emailPalette()` one module along
 * does, and the fan-out is bounded the same way — an in-flight flag, a stamp
 * taken UP FRONT so a burst of renders starts one read rather than one per
 * message, and a cooldown after a failure so an unreadable database is not
 * hammered.
 *
 * THE COLD CASE IS WHY THAT MATTERS, and it was a real defect (#2869 review).
 * The first version of this module returned the fallback before ever consulting
 * the TTL, so the refresh was unreachable while nothing was loaded — the only
 * thing that could load the cache was the boot prime, and the only thing that
 * could recover from a boot prime that failed was another boot. A container that
 * started before PostgreSQL was ready therefore dated EVERY email for the life
 * of that process in the environment's zone, while the comment beside it claimed
 * the cache self-warmed. It now genuinely does.
 *
 * ## When it is primed
 *
 * At server boot, by `instrumentation.node.ts`, beside the email palette prime
 * and for the same reason (#1912, #2900): Next awaits `register()` before it
 * serves a request, so by the time any route, cron tick or webhook renders an
 * email the persisted zone is already loaded. After that the TTL refresh keeps a
 * zone change made through the guarded admin page reaching emails without a
 * restart.
 *
 * ## What a failed read does — and does NOT — do
 *
 * The reader is `readPersistedClubTimeZoneOutsideRequest()`, which answers
 * `null` for "no row, no usable row, or the database could not be reached" —
 * NOT the resolver beside it, which folds those cases into the environment seed
 * and hands back a string indistinguishable from a persisted one. Committing a
 * seed as though it were the club's choice is the `readFailed` trap
 * `email-theme.ts` documents one module along. So a failed or empty read commits
 * NOTHING: the last good value stands, or the environment fallback does — which
 * is the answer `getClubTimeZone()` would have given for an absent row anyway.
 *
 * ## The honest limit
 *
 * There is no render gate. `renderEmailHtml()` (in `email-theme.ts`, which
 * belongs to another lane's file set this window) awaits the palette before any
 * themed HTML is built and is the natural place to await this too; wiring it
 * there would close the boot-prime-failed window immediately rather than within
 * one cooldown. Until then the worst case is emails dated in the environment's
 * zone for the first `FAILED_READ_COOLDOWN_MS` after an unreadable start, on a
 * deployment where the environment and the persisted value disagree.
 */

import {
  bindClubTime,
  calendarDateOfDateOnlyInstant,
  formatClubDate,
  requireClubTimeZone,
  requireStoredCalendarDay,
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
 * After a read that FAILED, do not start another for this long. Without it a
 * cold process whose database is unreachable would start one read per rendered
 * email — which is the traffic a cold cache must not generate. Shorter than the
 * TTL on purpose: a container that started before PostgreSQL was ready should be
 * dating emails correctly within half a minute, not within five.
 */
const FAILED_READ_COOLDOWN_MS = 30_000;

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
/** When the last attempt that did not FAIL completed (0 = never attempted). */
let attemptedAt = 0;
let refreshing = false;
/** When the last attempt failed (0 = no failure on record). */
let failedAt = 0;

/** The club's zone for an email being rendered right now. Never waits. */
function emailClubTime(): BoundClubTime {
  if (Date.now() - attemptedAt > TTL_MS) {
    void refreshEmailClubTimeZone();
  }
  return persisted ?? ENVIRONMENT_FALLBACK;
}

/**
 * `committed` — a persisted zone was read and is now the answer.
 * `absent`    — the read succeeded and there is no usable persisted zone.
 * `failed`    — the read threw. Nothing is known, so nothing is committed.
 */
type ClubTimeZoneReadOutcome = "committed" | "absent" | "failed";

async function readAndCommitClubTimeZone(): Promise<ClubTimeZoneReadOutcome> {
  let zone: ClubTimeZone | null;
  try {
    zone = await readPersistedClubTimeZoneOutsideRequest();
  } catch {
    // The reader swallows its own database error; this is belt and braces so a
    // boot prime can never fail a server start.
    return "failed";
  }
  if (zone === null) return "absent";
  persisted = bindClubTime(zone);
  return "committed";
}

async function refreshEmailClubTimeZone(): Promise<void> {
  if (refreshing) return;
  if (failedAt !== 0 && Date.now() - failedAt < FAILED_READ_COOLDOWN_MS) return;
  refreshing = true;
  // Stamp up front so a burst of renders starts one read, not one per message.
  const attemptedAtBeforeRefresh = attemptedAt;
  attemptedAt = Date.now();
  try {
    const outcome = await readAndCommitClubTimeZone();
    if (outcome === "failed") {
      // Nothing was learned, so the TTL clock must not stay advanced — that
      // would suppress the next attempt for a full five minutes. Rolling it
      // back is only safe BECAUSE the cooldown is armed in the same breath;
      // otherwise the very next render would start another read.
      attemptedAt = attemptedAtBeforeRefresh;
      failedAt = Date.now();
    } else {
      failedAt = 0;
    }
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
  const outcome = await readAndCommitClubTimeZone();
  if (outcome === "failed") {
    failedAt = Date.now();
    return;
  }
  attemptedAt = Date.now();
  failedAt = 0;
}

/** "16 Apr 2026" — the club calendar day a moment falls on. */
export function emailClubDate(value: Instant): string {
  return emailClubTime().instantDate(value);
}

/**
 * "16 Apr 2026" — a STORED CALENDAR DAY, rendered without consulting any zone.
 *
 * ## Why this is a different function from `emailClubDate`, and not a shape of it
 *
 * A lodge night, a hut-leader assignment's start date and a capacity-warning day
 * are `@db.Date` columns. Such a column stores an ENCODING, not a moment: it
 * round-trips as a `Date` pinned to exactly UTC midnight, and the calendar day it
 * means is read back in UTC (`INV-DATE-019`'s first exact boundary, plus
 * `INV-DATE-026`). Handing one to `emailClubDate` projects that encoding through
 * the club's zone, and `formatCalendarDateShape` in the kernel states what that
 * costs: it is "byte-identical to what the tree renders today ... which works
 * only because New Zealand is east of Greenwich, and is a day early for any club
 * that is not."
 *
 * Measured on this tree: the stored night `2026-08-01T00:00:00.000Z` renders as
 * `1 Aug 2026` zone-free and for `Pacific/Auckland`, `UTC`, `Europe/London` and
 * `Atlantic/Azores` — and as `31 Jul 2026` for `America/Denver` and
 * `Pacific/Honolulu`. So every current adopter sees no change from this function
 * at all, and a club behind Greenwich stops being told the wrong night.
 *
 * **The name deliberately omits "Club".** Its two siblings above take a zone
 * because an instant needs one to become a civil date; this one consults no zone
 * and could not be changed by one, so carrying the club's name in it would
 * promise a projection that does not happen.
 *
 * ## Why it refuses a value carrying a time of day
 *
 * `calendarDateOfDateOnlyInstant` alone would silently take the UTC day of a real
 * timestamp, which is the `INV-DATE-019` defect and is silently RIGHT for a club
 * east of Greenwich — the hardest kind of wrong to notice, and the one this epic
 * exists to remove. `requireStoredCalendarDay` (#3082) proves the `Date` really
 * carries a `@db.Date` encoding first, so a caller that has wired a `createdAt`
 * or an `expiresAt` into a calendar-day token fails loudly instead of mailing a
 * plausible wrong day. PostgreSQL cannot keep a time in a `date` column, so the
 * throw is unreachable for every value that came from one; what it catches is a
 * `Date` some code path built wrong.
 *
 * An instant that genuinely needs rendering as a bare day — a consent expiry, a
 * payment-recorded stamp — keeps `emailClubDate`, because THAT one really is a
 * projection and the club's zone really is the right authority for it.
 */
export function emailCalendarDay(value: Date): string {
  return formatClubDate(
    calendarDateOfDateOnlyInstant(
      requireStoredCalendarDay(value, {
        subject: "An email's calendar-day token",
        instead:
          "A real timestamp rendered as a bare day is a projection: use " +
          "emailClubDate, which reads it in the club's persisted zone.",
      }),
    ),
  );
}

/**
 * `emailCalendarDay`, or the literal "Unknown" for a date the sender does not have.
 *
 * ## Why this exists at all, rather than each caller writing the ternary
 *
 * An email renders twice — the default HTML body, and a rebuild from
 * `templateData` when an operator has saved a body override — and #3113 is
 * entirely about those two paths disagreeing. A null fallback written out
 * longhand at both is two chances to write a different word, in the one place
 * where a difference is the whole defect. One function means the two paths agree
 * by construction, not by review.
 *
 * ## Why "Unknown" rather than an empty string or a dash
 *
 * It matches the `memberName: "Unknown group organiser"` its callers already
 * pass beside it, so a reader of the alert sees one vocabulary for "we could not
 * resolve this" instead of a blank cell they have to interpret. A blank row also
 * reads as a rendering fault, which sends an officer looking for a bug rather
 * than at the money event the alert is about.
 *
 * This is deliberately NOT the general shape of `emailCalendarDay`. A caller
 * that HAS a stored calendar day must keep the refusal — that guard is what
 * stops a real timestamp being mailed as a plausible wrong lodge night. Reach
 * for this only where the value is genuinely absent and the message still has to
 * go out.
 */
export function emailCalendarDayOrUnknown(value: Date | null | undefined): string {
  return value ? emailCalendarDay(value) : "Unknown";
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
  attemptedAt = 0;
  refreshing = false;
  failedAt = 0;
}
