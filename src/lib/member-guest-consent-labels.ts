/**
 * The member-guest consent surfaces' DATE, NAME AND COUNT LABELS ("+ Add Member
 * Guest", epic #2305, MG2 #2307).
 *
 * Split out of `member-guest-consent-card.ts` in the CT-4 group E fix round
 * (#2870) rather than allowanced: that module was 695 lines against a 700-line
 * budget, and the club-time correction below plus the explanation it has to
 * carry took it over for the FIRST time — which the file-size ratchet refuses to
 * allowance, correctly (`size-allowances.d/README.md`). The seam was not
 * invented for the line count: the module already carried a
 * `// Date labels ---` divider at exactly this point, and this is everything
 * below it plus the three formatters those labels are the only users of. The
 * card module keeps every one of these on its own export surface, so no call
 * site moved and no sibling lane's file was touched to make room.
 *
 * The copy is the copy the owner signed off on the #2307 mockup pack (30 Jul)
 * and must not drift from it casually.
 */

import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";
import {
  calendarDateOfDateOnlyInstant,
  formatClubWeekdayDate,
  formatClubWeekdayDayMonth,
} from "@/lib/club-time";

/*
  THE THREE FORMATTERS BELOW NOW SERVE ONE TEMPORAL KIND ONLY: A REAL INSTANT
  (CT-4 group E fix round, #2870).

  #2264 hand-pinned three shapes here rather than moving to the shared
  `nzst-date` helpers, because they are locked to the signed-off #2307 mockup
  pack (a year-less badge date, and two comma-stripped weekday forms) and their
  rendered strings must not drift. That is still true, and the shapes are
  unchanged.

  What changed is that this module was rendering TWO KINDS through them. A
  guest's consent nights and a booking's check-in/check-out are `@db.Date`
  CALENDAR DAYS — UTC-midnight encodings — and projecting one of those through
  any zone west of Greenwich reads back the previous day. `consentExpiresAt`,
  `consentRespondedAt` and an admin row's `statusAt` are real DateTime INSTANTS,
  which genuinely need a zone. One set of formatters cannot be right for both,
  and this file had picked the answer that is wrong for the calendar days.

  So the calendar-day callers — `formatConsentNightsLabel` and
  `formatConsentStayLabel` — go through the kernel's zone-free calendar-date
  formatters instead (see their own docblocks), and only the instant callers
  reach these.

  WHY THESE THREE ARE STILL PINNED TO `APP_TIME_ZONE`, DECLARED RATHER THAN
  FIXED. An instant's civil day is the club's PERSISTED zone's to name
  (`INV-CONFIG-002`), not the container's — but `consentExpiresAt` is minted from
  an env-zone civil boundary too (`computeMemberGuestConsentExpiry`'s
  `startOfDateOnlyForTimeZone` clamp), these are synchronous module constants in
  a file six pages import, and moving them means threading the persisted zone
  through `describeMemberGuestConsentBadge` and every caller. That is group F's
  by the epic's published partition and it is a coherent job rather than a line
  change. Leaving it does not create a same-screen contradiction: the value is
  rendered under one authority everywhere it appears.
*/
const CONSENT_SHORT_DATE = new Intl.DateTimeFormat(APP_LOCALE, {
  day: "numeric",
  month: "short",
  timeZone: APP_TIME_ZONE,
});

const CONSENT_WEEKDAY_DATE = new Intl.DateTimeFormat(APP_LOCALE, {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: APP_TIME_ZONE,
});

const CONSENT_FULL_DATE = new Intl.DateTimeFormat(APP_LOCALE, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: APP_TIME_ZONE,
});
// ---------------------------------------------------------------------------
// Date labels — NZ lodge dates, in the shapes the mockups draw
// ---------------------------------------------------------------------------

/**
 * "Tama Kaur" — or "Tama Kaur (age 9)" for a guest the club treats as a child.
 *
 * A guest row is allowed to carry an EMPTY last name: a member with one name, a
 * row an admin left half-filled, a legacy import. The delegate page used to
 * build the whole string — age suffix and all — and trim the result, and
 * `.trim()` only tidies the ENDS, so such a row rendered as "Tama  (age 9)":
 * two spaces, in a page heading. The name is therefore composed and tidied
 * FIRST, and only then does the age go on the end. Collapsing the whitespace
 * run rather than trimming it also covers a surname that is blank instead of
 * empty. It lives here beside the other label shapes so both consent pages
 * compose a name the same way.
 *
 * The age is shown only for a minor: it is there so the person answering knows
 * a child is being put on a booking, and an adult's age is nobody's business.
 */
export function formatConsentGuestName(guest: {
  firstName: string;
  lastName: string;
  ageYears: number | null;
}): string {
  const fullName = `${guest.firstName} ${guest.lastName}`.replace(/\s+/g, " ").trim();
  return guest.ageYears !== null && guest.ageYears < 18
    ? `${fullName} (age ${guest.ageYears})`
    : fullName;
}

/** "7 Aug" — the badge / inline-sentence shape. An INSTANT: see the note above
 * the formatters for why this one still reads the environment's zone. */
export function formatConsentShortDate(date: Date): string {
  return CONSENT_SHORT_DATE.format(date);
}

/** "Sat 8 Aug" — the lapse sentence's deadline. An INSTANT, as above.
 * en-NZ renders "Sat, 8 Aug"; the comma is stripped because the signed-off
 * mockups write the bare "Sat 8 Aug" shape throughout. */
export function formatConsentWeekdayDate(date: Date): string {
  return CONSENT_WEEKDAY_DATE.format(date).replace(/,/g, "");
}

/** "Fri 7 Aug 2026" — the facts-table shape (comma stripped, as above). Also an
 * INSTANT at every call site: `consentExpiresAt` and `consentRespondedAt`. */
export function formatConsentFullDate(date: Date): string {
  return CONSENT_FULL_DATE.format(date).replace(/,/g, "");
}

/*
  THE CALENDAR-DAY HALF, and the two shapes below are the SAME two shapes as
  `CONSENT_WEEKDAY_DATE` and `CONSENT_FULL_DATE` — asked of the kernel, which
  pins `UTC` over the UTC-midnight encoding rather than projecting through a
  zone. `club-time/__tests__/house-shapes.test.ts` pins both byte-for-byte
  against the exact `Intl` options above, over a 400-day sweep, so the
  signed-off #2307 strings do not move for the club this codebase was written
  for; they simply stop moving for everybody else.

  A DECLARED `src/lib` FIX INSIDE CT-4 GROUP E, for the reason group B recorded
  when it took four of them: group E migrated `bookings/[id]/page.tsx` to decode
  its stay dates as the calendar days they are, and these two labels render on
  THE SAME PAGE from the same kind of value. Left alone, a club in
  `America/Denver` saw the stay line read "8 August 2026" while the consent card
  beside it listed the guest's nights as "Fri 7 Aug, Sat 8 Aug" — one page, two
  answers, a few lines apart. A straddle is worse than either consistent state.

  GROUP F STILL OWNS THE CONVERGENCE (#2870 comment 6): these two should TAKE
  `CalendarDate[]` rather than `Date[]`, which is the only reason
  `bookings/[id]/page.tsx` still imports `eachDateOnlyInRange`. Changing the
  signature moves four call sites in two route groups, so it belongs with the
  rest of that sweep; decoding at the boundary here closes the defect now
  without pre-empting it.
*/

/** One `@db.Date` night as "Sat 8 Aug" — comma stripped, as above. */
function consentCalendarNight(night: Date): string {
  return formatClubWeekdayDayMonth(calendarDateOfDateOnlyInstant(night)).replace(
    /,/g,
    "",
  );
}

/** One `@db.Date` day as "Mon 10 Aug 2026" — comma stripped, as above. */
function consentCalendarDay(day: Date): string {
  return formatClubWeekdayDate(calendarDateOfDateOnlyInstant(day)).replace(
    /,/g,
    "",
  );
}

/** "Sat 8 Aug – Mon 10 Aug 2026 (2 nights)" — the facts-table stay row.
 * `checkIn`/`checkOut` are `@db.Date` CALENDAR DAYS at every call site. */
export function formatConsentStayLabel(checkIn: Date, checkOut: Date): string {
  const nights = Math.max(
    1,
    Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000),
  );
  return (
    `${consentCalendarNight(checkIn)} – ${consentCalendarDay(checkOut)} ` +
    `(${nights} night${nights === 1 ? "" : "s"})`
  );
}

/** "Sat 8 Aug, Sun 9 Aug" — the guest's own nights row. Every entry is a
 * `@db.Date` lodge night, so this takes no zone at all. */
export function formatConsentNightsLabel(nights: readonly Date[]): string {
  return nights.map((night) => consentCalendarNight(night)).join(", ");
}

const NIGHT_COUNT_WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
] as const;

/** "two nights" — the intro sentence's count, in words as the mockup writes it. */
export function describeConsentNightsCount(count: number): string {
  const word =
    count >= 0 && count < NIGHT_COUNT_WORDS.length
      ? NIGHT_COUNT_WORDS[count]
      : String(count);
  return `${word} night${count === 1 ? "" : "s"}`;
}

