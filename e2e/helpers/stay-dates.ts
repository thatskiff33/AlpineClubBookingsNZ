// Disjoint Monday–Wednesday stay windows for the booking persona, starting a
// few weeks out so they clear the demo seed's relative bookings.
//
// EVERY DATE HERE IS COUNTED FROM THE CLUB'S DAY, never the runner's. "Today" is
// `E2E_TODAY_NZ` (via `relDateOnly`) — the one clock read the E2E date space
// has, documented in `prisma/e2e-fixtures.ts`. This file used to do its own
// `new Date()` + `getFullYear()/getMonth()/getDate()`, which is the CI runner's
// zone (UTC) and therefore a DIFFERENT day from the app's for the last ~12 hours
// of every UTC day. It also meant these windows and the seeded seasons they are
// checked against were counted from two different "todays".
//
// Windows are pure date math (NZ date-only lodge nights); the wizard itself rejects a
// window that falls outside a seeded season, which keeps failures loud. Since
// issue #2117 the base seed's seasons are RELATIVE (a broad Winter band from
// ~90 days back to ~240 days out, a ~30-day gap, then a Summer band), so a
// window a few weeks out is always in-season on any run date — see
// SEEDED_SEASONS (prisma/e2e-fixtures.ts) and docs/E2E_PLAYWRIGHT.md.
import {
  IB_WINDOW,
  relDateOnly,
  SEEDED_SEASONS,
  shiftDateOnly,
  WAITLIST_FULL_WINDOW,
  WAITLIST_OFFER_WINDOW,
} from "../../prisma/e2e-fixtures";

const FIRST_WINDOW_OFFSET_DAYS = 21;

// The September fixture windows are FIXED dates while stayWindow Mondays drift
// weekly with the run date, so an index periodically lands ON one of them —
// including the seeded-FULL waitlist window (22 guests), where a spec's
// booking creation is refused outright (#1703; first observed as #1686's
// admin-override collision). Every reserved Monday is skipped for every index,
// so windows stay mutually disjoint AND clear of the fixtures on all run dates.
const RESERVED_WINDOW_CHECKINS = new Set<string>([
  IB_WINDOW.checkIn,
  WAITLIST_FULL_WINDOW.checkIn,
  WAITLIST_OFFER_WINDOW.checkIn,
]);

// Seeded booking seasons (relative; defined in prisma/e2e-fixtures.ts, written
// by prisma/seed.ts): a Winter band and a Summer band with a deliberate ~30-day
// gap between them. A window whose nights fall in that gap (or outside both
// bands) has no season rate, so /api/bookings/quote prices it out-of-season and
// the wizard refuses to advance to review (cf. #1703). Windows must therefore
// land entirely inside one season, on any run date. ISO YYYY-MM-DD sorts
// lexicographically, so plain string comparison is a correct date compare.
// Season key matches the club-config rate columns (config/club.json →
// nightlyRates.winter / .summer) and the seed's WINTER/SUMMER season types.
// The concrete season spans are RELATIVE (issue #2117) and defined ONCE in
// prisma/e2e-fixtures.ts, imported by BOTH this helper and
// e2e/setup/relativize-seasons.ts (which re-dates the base seed's Season rows on
// the E2E DB), so the DB seasons and this classifier can never drift apart.
export type SeededSeasonKey = (typeof SEEDED_SEASONS)[number]["key"];

function isWindowInSeededSeason(nights: string[]): boolean {
  return SEEDED_SEASONS.some((season) =>
    nights.every((night) => night >= season.start && night <= season.end),
  );
}

// Which seeded season a window's nights fall in — winter vs summer selects the
// club-config rate column, so a price assertion stays correct on any run date
// regardless of which season the index lands in (stayWindow may drift a window
// from winter into summer as the run date advances). Throws if the window is not
// wholly inside one seeded season, which stayWindow already guarantees.
export function seasonForWindow(
  window: Pick<StayWindow, "nights">,
): SeededSeasonKey {
  const season = SEEDED_SEASONS.find((s) =>
    window.nights.every((night) => night >= s.start && night <= s.end),
  );
  if (!season) {
    throw new Error(
      `stay window nights ${window.nights.join(", ")} fall outside every seeded ` +
        `season (see SEEDED_SEASONS / prisma/seed.ts).`,
    );
  }
  return season.key;
}

export type StayWindow = {
  checkIn: string; // YYYY-MM-DD (NZ date-only lodge night)
  checkOut: string;
  nights: string[]; // occupied lodge nights: checkIn inclusive, checkOut exclusive
};

const PAST_RETRY_OFFSETS_DAYS = [-7, -11, -15] as const;

/**
 * Select a two-night past stay for a Playwright attempt.
 *
 * CI retries reuse the seeded database, so an attempt that persisted its
 * booking before a later navigation failure must not retry against the same
 * member nights. Each retry moves into a disjoint band while remaining inside
 * the relative seeded Winter season. Callers provide booking windows owned by
 * their chosen member; overlap fails closed rather than borrowing another
 * attempt's window.
 */
export function pastStayWindowForAttempt(
  retry: number,
  blockedRanges: ReadonlyArray<readonly [string, string]> = [],
): StayWindow {
  if (!Number.isInteger(retry) || retry < 0 || retry > 2) {
    throw new Error("retroactive retry must be an integer from 0 to 2");
  }

  const offsetDays = PAST_RETRY_OFFSETS_DAYS[retry];
  if (offsetDays === undefined) {
    throw new Error("retroactive retry must be an integer from 0 to 2");
  }
  const checkIn = relDateOnly(offsetDays);
  const checkOut = shiftDateOnly(checkIn, 2);
  const nights = [checkIn, shiftDateOnly(checkIn, 1)];
  const overlapsBlockedRange = blockedRanges.some(
    ([start, end]) => checkIn < end && checkOut > start,
  );

  if (overlapsBlockedRange || !isWindowInSeededSeason(nights)) {
    throw new Error(
      `No conflict-free seeded past window for Playwright retry ${retry}`,
    );
  }

  return { checkIn, checkOut, nights };
}

/**
 * Every check-in date a leftover retroactive booking can sit on that would still
 * block one of THIS run's three attempt windows (#2625).
 *
 * The retroactive spec creates a real PENDING booking and, unlike every other
 * date-based spec, used to leave it behind — so it self-blocked on the second run
 * against one seeded database, and could block the NEXT DAY's run too. The
 * windows above are derived from the RUN DATE and therefore slide one day per
 * day, while a leftover stays on the absolute date it was created on; yesterday's
 * attempt-0 booking is today's -8, and it still occupies one of today's
 * attempt-0 nights.
 *
 * Which check-ins can collide is exact rather than guessed. A two-night stay
 * checking in on `c` occupies nights `c` and `c + 1`, so it overlaps the attempt
 * window at offset `o` (nights `o` and `o + 1`) exactly when `c` is `o - 1`, `o`,
 * or `o + 1`. Sweeping the contiguous band from the oldest offset minus a day to
 * the newest offset plus a day therefore covers every leftover that can wedge
 * this run — today's own, yesterday's, and an attempt/retry pair that straddled
 * NZ midnight — and it is derived from PAST_RETRY_OFFSETS_DAYS, so it cannot
 * drift if those offsets ever move.
 *
 * A leftover older than the band has slid clear of all three windows and holds
 * no night this run wants, so it is deliberately NOT swept: the sweep stays the
 * narrowest thing that makes the spec re-runnable.
 *
 * The band is -16…-6 on any run date. `admin-override-dates.spec.ts` sweeps
 * -6…+1 for the same member, so the two touch at -6 only — and -6 is a CHECK-IN
 * for neither spec on any run date, which is all a check-in sweep can act on. It
 * is the day of slack each band adds at its near edge: this spec's newest
 * check-in is -7 and the override spec's oldest is -5. (-6 is not unbooked — it
 * is attempt 0's second night, since a check-in on -7 occupies -7 and -6 — but a
 * booking is only ever swept by its check-in.) Overlapping there is
 * harmless anyway: `playwright.config.ts` runs one worker with
 * `fullyParallel: false`, so no two specs are ever in flight together, and each
 * clears its own leftovers in its own `beforeAll` before it creates anything.
 */
export function pastStayLeftoverCheckIns(): string[] {
  const oldest = Math.min(...PAST_RETRY_OFFSETS_DAYS) - 1;
  const newest = Math.max(...PAST_RETRY_OFFSETS_DAYS) + 1;
  const checkIns: string[] = [];
  for (let offset = oldest; offset <= newest; offset += 1) {
    checkIns.push(relDateOnly(offset));
  }
  return checkIns;
}

// Day of week for a lodge night, 0 = Sunday, matching `Date.prototype.getDay`.
// UTC-anchored on purpose: a date-only string names a club calendar day, and
// reading its weekday must not depend on the runner's zone or on a DST edge.
function dayOfWeek(dateOnly: string): number {
  return new Date(`${dateOnly}T00:00:00.000Z`).getUTCDay();
}

// Window n = the (n+1)th usable Monday at least FIRST_WINDOW_OFFSET_DAYS from
// today, staying Mon+Tue nights (checkout Wednesday). A Monday is usable when it
// is neither a reserved fixture check-in nor in a seeded-season gap. Each spec
// uses its own index so bookings never collide on a member-night.
export function stayWindow(index: number): StayWindow {
  const earliest = relDateOnly(FIRST_WINDOW_OFFSET_DAYS);
  const daysUntilMonday = (8 - dayOfWeek(earliest)) % 7; // Monday === 1
  let monday = shiftDateOnly(earliest, daysUntilMonday);
  let remaining = index;
  // Walk Mondays, skipping reserved fixture check-ins and any window that would
  // fall outside a seeded season (e.g. the October 2026 gap), until the index-th
  // usable one. Bounded by MAX_MONDAYS so a run date past the last seeded season
  // fails loudly (reseed required) instead of looping forever.
  const MAX_MONDAYS = 200;
  for (let step = 0; step < MAX_MONDAYS; step += 1) {
    const nights = [monday, shiftDateOnly(monday, 1)];
    const usable =
      !RESERVED_WINDOW_CHECKINS.has(monday) && isWindowInSeededSeason(nights);
    if (usable) {
      if (remaining === 0) {
        return {
          checkIn: monday,
          checkOut: shiftDateOnly(monday, 2),
          nights,
        };
      }
      remaining -= 1;
    }
    monday = shiftDateOnly(monday, 7);
  }
  throw new Error(
    `stayWindow(${index}) found no in-season Monday within ${MAX_MONDAYS} weeks ` +
      `of ${relDateOnly(FIRST_WINDOW_OFFSET_DAYS)}. The seeded ` +
      `seasons (see prisma/seed.ts and SEEDED_SEASONS) no longer cover the test ` +
      `horizon for this run date — reseed the booking seasons. See docs/E2E_PLAYWRIGHT.md.`,
  );
}

// Index offset between one attempt of a test and the next (#2302).
//
// Chosen so `stayWindowForAttempt` maps attempt 0/1/2 of a spec onto three
// mutually disjoint bands of Mondays. Bases are hand-allocated per spec and the
// allocation is re-derived (not assumed) whenever one moves — see the WINDOW
// comment in e2e/locked-out-pickup-and-pay.spec.ts for the current census.
//
// Two ceilings bound this stride, and BOTH must be re-checked before it (or a
// base index) is raised:
//  - Seeded seasons. They cover roughly 79 usable Mondays from the first window
//    (winter runs to +239 days, summer from +270 to +599 — see SEEDED_SEASONS),
//    so the highest index in use today (base 28 attempt 2 = 60, ≈ +470 days)
//    stays inside them with ~19 Mondays of headroom; stayWindow still throws
//    loudly if a run date ever changes that.
//  - Calendar month hops. A spec reaches these dates by clicking the booking
//    calendar's "Next ›" one month at a time, bounded by MAX_MONTH_HOPS in
//    e2e/helpers/booking.ts (24). Stay index 60 is ≈ 16 month hops, so even a
//    calendar-driven spec clears it — and the specs on the highest bases
//    (locked-out-pickup-and-pay) create their bookings over the API and never
//    open the calendar at all. This ceiling was missed when the stride was first
//    chosen: the old bound of 12 hops was already the exact worst case of the
//    windows in use and one short of base 9 attempt 2, and it failed as a
//    timeout on the day button rather than on the navigation.
const RETRY_WINDOW_STRIDE = 16;

// The stay window for a given ATTEMPT of a test.
//
// A booking spec that reaches its assertion by creating a booking leaves that
// booking behind, and `playwright.config.ts` retries in CI against the same
// database (the suite seeds once per run, never between attempts). Re-running on
// the SAME window therefore hits the member-night guard and fails deterministically
// — `stripe-payment.spec.ts:40` did exactly this in run 30586027310, where both
// retries died at the review step instead of re-running the payment. Giving each
// attempt its own window removes the collision at its source, rather than
// papering over it with more retries or a looser assertion.
//
// Attempt 0 returns `stayWindow(index)` unchanged, so the happy path is
// byte-identical to before.
export function stayWindowForAttempt(index: number, retry: number): StayWindow {
  return stayWindow(index + retry * RETRY_WINDOW_STRIDE);
}

// How the app renders a lodge night in prose, e.g. "17 Aug 2026" — the member-
// night conflict copy (#2250) formats every night with
// `formatNZDate(parseDateOnly(night))`, which is `Intl.DateTimeFormat` at
// `dateStyle: "medium"` in the club locale and time zone. Computed here from
// the same inputs rather than imported from `src/lib`, so the assertion is an
// independent oracle instead of a restatement of the implementation. Locale and
// zone are pinned exactly as `calendarDayLabel` below already pins them.
//
// This exists because these windows DRIFT with the run date (see stayWindow):
// hardcoding a date in a spec produces an assertion that can only pass on the
// week it was written.
export function lodgeNightLabel(dateOnly: string): string {
  const [y, m, d] = dateOnly.split("-").map(Number);
  return new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    dateStyle: "medium",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

// aria-label date fragment used by the booking calendar day buttons, e.g.
// "Monday, 17 August 2026".
export function calendarDayLabel(dateOnly: string): RegExp {
  const [y, m, d] = dateOnly.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const weekday = date.toLocaleDateString("en-NZ", { weekday: "long" });
  const month = date.toLocaleDateString("en-NZ", { month: "long" });
  // Test helper: pattern is built from a formatted test date (weekday/day/month/year), not user input; no ReDoS.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp(`^${weekday}, ${d} ${month} ${y},`);
}
