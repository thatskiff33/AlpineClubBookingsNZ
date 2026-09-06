import { expect, type Locator, type Page } from "@playwright/test";

/** The twelve month names the calendar heading can carry, in the club locale. */
const MONTH_NAMES = Array.from({ length: 12 }, (_, index) =>
  new Date(2026, index, 1).toLocaleDateString("en-NZ", { month: "long" }),
);

/** `YYYY-MM` — the comparable form of a month. ISO order is string order. */
type MonthKey = string;

function monthKeyOfDateOnly(dateOnly: string): MonthKey {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(dateOnly);
  if (!match) {
    throw new Error(`Expected a YYYY-MM-DD date, received ${dateOnly}`);
  }
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Expected a valid month in ${dateOnly}`);
  }
  return `${match[1]}-${match[2]}`;
}

/** The booking calendar's month heading, e.g. "August 2026". */
export function calendarMonthHeading(dateOnly: string): string {
  const [year, month] = dateOnly.split("-").map(Number);
  return new Date(year, month - 1).toLocaleDateString("en-NZ", {
    month: "long",
    year: "numeric",
  });
}

/** "August 2026" back to `2026-08`. Throws on anything that is not a heading. */
export function monthKeyOfHeading(heading: string): MonthKey {
  const match = /^([A-Za-z]+)\s+(\d{4})$/.exec(heading.trim());
  const monthIndex = match ? MONTH_NAMES.indexOf(match[1]) : -1;
  if (!match || monthIndex < 0) {
    throw new Error(
      `Expected a calendar month heading like "August 2026", received ` +
        `"${heading}". The booking calendar renders one through ` +
        `formatClubMonthYear (src/components/booking-calendar.tsx).`,
    );
  }
  return `${match[2]}-${String(monthIndex + 1).padStart(2, "0")}`;
}

// How long ONE calendar click may spend becoming actionable (#2626) — a
// "Prev ‹"/"Next ›" hop here, or the day button a caller clicks on arrival.
//
// This exists because a bounded loop is not a bounded WAIT. `playwright.config.ts`
// sets no `actionTimeout`, so Playwright's default of 0 — "no timeout, wait until
// the test itself is killed" — applies to every `locator.click()`. A month walk
// bounded by a hop count therefore has no time bound at all: if the nav control
// never becomes actionable, hop 0's click alone burns the whole 90 s test budget
// and the walk's own arrival assertion is never even reached. That is exactly how
// #2626 presented — a three-hop loop dying on `locator.click: Target page,
// context or browser has been closed`, which reads as a browser crash and says
// nothing about the calendar.
//
// Matches `expect: { timeout: 15_000 }`, so a stuck control and a failed
// assertion cost the same and several hops still fit inside one test budget.
//
// EXPORTED because the walk always hands off to a day click the caller makes
// itself (`selectCalendarDay` in `e2e/helpers/booking.ts`,
// `selectPastCalendarDay` in `e2e/admin-retroactive-booking.spec.ts`), and that
// click has the identical failure mode. Asserting arrival removes the COMMON
// cause — the month is now verified before the day is clicked — but not a day
// that resolves and is still not actionable: a past or out-of-season day
// rendered `disabled` (`isPast` against `minSelectableStr`,
// `src/components/booking-calendar.tsx`), or availability still loading.
// Unbounded, that waits out the whole test budget and reports `Target page,
// context or browser has been closed` — the exact pathology
// docs/E2E_PLAYWRIGHT.md §5 declares must never recur. One constant for both, so
// the walk and the day it walks to can never drift apart.
export const CALENDAR_CLICK_TIMEOUT_MS = 15_000;

/**
 * The booking calendar's month heading, whatever month it is showing.
 *
 * `getByRole`, not `getByText` or a test id: the streamed (hidden) copy of a
 * Suspense boundary is out of the accessibility tree, so this cannot resolve to
 * the template. The name is the twelve real month names rather than a loose
 * `\w+ \d{4}`, so it cannot pick up some other heading that happens to end in a
 * year. Only `BookingCalendar` renders a bare month-year heading on `/book` and
 * `/admin/book`; the admin occupancy and calendar views are other pages, which
 * this walk is never used on.
 */
function calendarMonthLocator(page: Page): Locator {
  // Test helper: the pattern is built from the twelve formatted month names, not
  // from user input; no ReDoS.
  const anyMonthHeading = new RegExp(`^(?:${MONTH_NAMES.join("|")}) \\d{4}$`);
  return page.getByRole("heading", { name: anyMonthHeading });
}

/**
 * Walk the booking calendar to the month holding `target` and return how many
 * hops it spent. 0 means it was already there.
 *
 * THE WALK DECIDES ITS OWN DIRECTION, by reading the month the calendar is
 * actually showing (#3221). It used to take a `direction` the caller computed
 * from the date it BELIEVED the calendar had opened on, and a caller can only
 * ever get that right by guessing what day it is at the club — which is a
 * different day from the CI runner's for the last ~12 hours of every UTC day.
 * On the last day of a month it is a different MONTH: `main` failed at
 * 2026-08-31T14:30Z (02:30 on 1 September in New Zealand) with the caller
 * asserting August against a calendar that had correctly opened on September,
 * and passed on the same commit that morning.
 *
 * That argument could only ever be wrong, so it is gone rather than corrected.
 * `e2e/helpers/stay-dates.ts` and `prisma/e2e-fixtures.ts` now count every date
 * from the CLUB's day, which fixes the derivation — but a run that starts at
 * 23:55 New Zealand time and reaches a spec ten minutes later would re-arm the
 * identical failure with a perfectly correct reference date, because the suite
 * freezes "today" once per process and the app derives it live. Reading the
 * heading is what makes that harmless.
 *
 * **What was lost, and what replaces it.** The old signature asserted the
 * caller's expectation was RIGHT — `direction: "current"` clicked nothing and
 * failed if the calendar was elsewhere. `maxHops` now carries that: a caller
 * that believes it is at most one month away passes `maxHops: 1`, and a walk
 * that needs four fails naming the month it could not reach. Keep the bound
 * tight, because it is the only check on the caller's belief that remains.
 *
 * Three failures are made loud, in the order they can happen:
 *  - the calendar is not on the page at all — no month heading ever appears;
 *  - the nav control never becomes actionable — something (a modal overlay, an
 *    unmounted step) is sitting over it;
 *  - the bound is exhausted without arriving — fails naming both the month it
 *    could not reach and the one it is stuck on, rather than leaving the caller
 *    to time out on a day button.
 *
 * @param maxHops the caller's own bound — the number of months it can need to
 *   cross, plus margin. Failing on it is the point, so keep it tight.
 * @param context what the caller is walking towards, quoted back in the failure.
 */
export async function walkCalendarToMonth(
  page: Page,
  {
    target,
    maxHops,
    context,
  }: {
    target: string;
    maxHops: number;
    context: string;
  },
): Promise<number> {
  const targetMonth = monthKeyOfDateOnly(target);
  const monthHeading = calendarMonthHeading(target);
  const heading = calendarMonthLocator(page);

  // "The calendar is not reachable" fails as ITSELF, inside the expect budget,
  // instead of as an unbounded click that outlives the test.
  await expect(
    heading,
    `the booking calendar's month heading never appeared, so there is nothing ` +
      `to walk (${context}). Either the calendar is not rendered on this page, ` +
      `or something is over it — an open modal (the "Confirm member details" ` +
      `onboarding gate is the usual one) puts the whole page behind an overlay ` +
      `and out of the accessibility tree`,
  ).toBeVisible();

  let hops = 0;
  let shown = (await heading.innerText()).trim();

  while (monthKeyOfHeading(shown) !== targetMonth && hops < maxHops) {
    const forwards = monthKeyOfHeading(shown) < targetMonth;
    const control = forwards ? "Next" : "Prev";
    const nav = page.getByRole("button", { name: forwards ? /Next/ : /Prev/ });
    await expect(
      nav,
      `the booking calendar's "${control}" control never became actionable on ` +
        `hop ${hops} while walking from ${shown} to ${monthHeading} (${context})`,
    ).toBeEnabled();
    await nav.click({ timeout: CALENDAR_CLICK_TIMEOUT_MS });

    // Wait for the heading to actually MOVE before reading it again. A bare
    // re-read is a single non-retrying probe, so a click sampled mid-render
    // would read the month it just left, decide it had not moved, and hop
    // again — walking past the target and then back, burning the bound. This
    // retrying assertion is what makes one hop mean one month.
    await expect(
      heading,
      `the booking calendar did not leave ${shown} after a "${control}" hop ` +
        `(${context})`,
    ).not.toHaveText(shown);

    shown = (await heading.innerText()).trim();
    hops += 1;
  }

  await expect(
    heading,
    `calendar never reached ${monthHeading} within ${maxHops} hop(s) — it is ` +
      `showing ${shown} (${context})`,
  ).toHaveText(monthHeading);
  return hops;
}
