import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bindClubTime,
  calendarDateOfDateOnlyInstant,
  formatClubInstantDate,
  formatClubInstantLongDate,
  formatClubLongDate,
  requireCalendarDate,
  requireClubTimeZone,
} from "../club-time";

/*
  #2264 — owner decision, 2 August 2026.

  The date sweep moved every hand-rolled `toLocaleDateString` onto the shared
  NZ-pinned helpers. Four of those sites had been rendering the LONG spelled-out
  month ("16 April 2026") and would have silently shortened to the club's medium
  house form ("16 Apr 2026") had they landed on `formatNZDate`. The owner asked
  for the long form to stay on the member-facing surfaces; admin and internal
  screens keep the medium form.

  These are the four. The source-level assertions exist because none of them is
  reachable from a unit test — two are React Server Components, one is a client
  page and one runs jsPDF in the browser — yet the format is exactly the sort of
  thing a later "tidy every date onto formatNZDate" pass would flatten without
  noticing. Asserting on the source is a blunt instrument, but it is the only
  one that fails loudly on that specific regression.

  WHAT CT-4 (#2870) CHANGED, AND WHAT IT DID NOT. All four sites have moved off
  the retired `nzst-date` adapter, and the owner decision above is untouched by it:
  the long spelled-out form still holds on all four, and the snippet each row
  names is simply the current spelling of it. What moved is which temporal
  QUESTION each site asks. The booking messages hold `@db.Date` lodge nights,
  which are calendar days and take no zone; the two instruction stamps hold real
  instants, which take the club's PERSISTED zone rather than the container's
  `TZ`. The fourth, `src/lib/report-pdf.ts`, is `src/lib` and belongs to group F.
*/

const MEMBER_FACING_LONG_DATE_SITES: ReadonlyArray<{
  what: string;
  file: string;
  mustContain: readonly string[];
}> = [
  {
    what: "the booking messages and emails a member receives",
    file: "src/app/(authenticated)/bookings/[id]/page.tsx",
    /*
      MIGRATED TO THE KERNEL BY CT-4 (#2870), AND STILL THE LONG FORM.

      `checkIn`/`checkOut` are `@db.Date` LODGE NIGHTS — calendar days, which
      have no timezone — so they now go through `formatClubLongDate`, which
      takes none and pins `UTC` over the UTC-midnight encoding. `formatNZLongDate`
      projected them through `APP_TIME_ZONE`: the identity in New Zealand, and
      the night BEFORE the stay for any club west of Greenwich, in the message a
      member is emailed. The shape INV-DATE-016 protects is unchanged, which is
      what the first case in this file pins byte-for-byte.
    */
    mustContain: [
      "checkIn: formatClubLongDate(calendarDateOfDateOnlyInstant(booking.checkIn))",
      "checkOut: formatClubLongDate(calendarDateOfDateOnlyInstant(booking.checkOut))",
    ],
  },
  {
    what: "the member lodge-instructions 'last updated' stamp",
    file: "src/app/(authenticated)/lodge-instructions/page.tsx",
    /*
      MIGRATED TO THE CLUB'S PERSISTED ZONE BY CT-4 GROUP E (#2870), AND STILL
      THE LONG FORM.

      Unlike the stay dates above, `updatedAt` is a real INSTANT: it genuinely
      has no civil date until a zone is chosen, so this one still takes a zone —
      it just takes it from the club's persisted setting, delivered to the
      browser by `ClubTimeProvider`, instead of from `APP_TIME_ZONE`.
      `clubTime.instantLongDate` IS `formatClubInstantLongDate` with that zone
      bound, so the shape INV-DATE-016 protects is byte-identical; the case below
      pins that rather than taking it on trust.
    */
    mustContain: ["clubTime.instantLongDate(new Date(value))"],
  },
  {
    what: "the public hut-leader-instructions 'last updated' stamp",
    file: "src/app/(website-dynamic)/hut-leader-instructions/hut-leader-instructions-client.tsx",
    // The same migration, for the same reason. See the row above.
    mustContain: ["clubTime.instantLongDate(new Date(value))"],
  },
  {
    what: "the generated report PDF cover",
    file: "src/lib/report-pdf.ts",
    /*
      MIGRATED TO THE CLUB'S PERSISTED ZONE BY #3123, AND STILL THE LONG FORM.

      The last of the four to move, and it moved differently from the other
      three because `report-pdf.ts` runs in the BROWSER — jsPDF and html2canvas
      over a cloned Document, reached by `await import(...)` from two
      `"use client"` components. It can read no zone at all, so the binding
      arrives as a required parameter from callers that already hold one.
      `club.instantLongDate` IS `formatClubInstantLongDate` with that zone bound,
      so the shape INV-DATE-016 protects is byte-identical to what
      `formatNZLongDate` produced; only the zone authority changed, from the
      container's `TZ` to the club's configured setting.

      THE INSTANT IS NAMED, not read inline. `generateReportPDF` also puts a day
      in the saved filename, and it used to take a second, independent reading of
      the clock for it — so an export straddling club midnight produced a file
      whose name and whose cover disagreed. Both now derive from one
      `generatedAt`, which is what this fixture pins: an inline `new Date()` back
      in this position would be a second reading again.
    */
    mustContain: [
      "Generated: ${club.instantLongDate(generatedAt)}",
      // The other half of the same pair, pinned in the same row because the two
      // are only correct together: the day in the saved filename must come from
      // that one instant, not from a second `club.today()`.
      "pdf.save(`tac-report-${club.calendarDateOf(generatedAt)}.pdf`)",
    ],
  },
];

describe("member-facing dates keep the long spelled-out month (#2264)", () => {
  it("renders the long form, which is NOT the medium house form", () => {
    /*
      23:30 UTC on 15 April is 16 April in Auckland, so this also proves the long
      formatter is club-zone pinned rather than UTC.

      THE ZONE IS NAMED, and it used to be read from the environment. This case
      called `formatNZLongDate` / `formatNZDate` from the retired `nzst-date`
      adapter, which supplied `APP_TIME_ZONE` — so on any machine whose `TZ` said
      something else the case asserted 15 April and read exactly like the dating
      bug it exists to disprove (docs/TESTING.md rule 6), and it needed
      `expectClubTimeZonePremise()` beside it to say so. Naming the zone removes
      the failure mode rather than explaining it: the subject here is the SHAPE
      INV-DATE-016 reserves, not whose zone is in force, and a case that supplies
      its own zone cannot have an environment premise to break.
    */
    const instant = new Date("2026-04-15T23:30:00.000Z");
    const auckland = requireClubTimeZone("Pacific/Auckland");
    expect(formatClubInstantLongDate(instant, auckland)).toBe("16 April 2026");
    expect(formatClubInstantDate(instant, auckland)).toBe("16 Apr 2026");
    expect(formatClubInstantLongDate(instant, auckland)).not.toBe(
      formatClubInstantDate(instant, auckland),
    );
  });

  it("the kernel's CALENDAR-DAY long form is the same shape, and takes no zone", () => {
    /*
      What CT-4 (#2870) replaced the first site's call with, pinned here so the
      migration cannot quietly change the shape INV-DATE-016 is about.

      The two were never interchangeable and that is the point: `formatNZLongDate`
      asked "what long date is this MOMENT, in the environment's zone?", while
      `formatClubLongDate` asks "what long date is this CALENDAR DAY?" and takes
      no zone because the question has none. For a `@db.Date` value they agreed in
      New Zealand and disagreed by a day for a club west of Greenwich, which is
      why the call site moved — and why #3123 deleted the adapter rather than
      leaving a second way to ask.
    */
    const lodgeNight = requireCalendarDate("2026-04-16");
    expect(formatClubLongDate(lodgeNight)).toBe("16 April 2026");
    expect(
      formatClubLongDate(
        calendarDateOfDateOnlyInstant(new Date("2026-04-16T00:00:00.000Z")),
      ),
    ).toBe("16 April 2026");
  });

  it("the kernel's INSTANT long form is that same shape, with the zone bound", () => {
    /*
      What CT-4 group E replaced the two instruction stamps with. They are the
      only two of these four sites that hold a real MOMENT, so they are the only
      two that still take a zone at all — and `clubTime.instantLongDate` is
      exactly `formatClubInstantLongDate` with the club's persisted zone closed
      over (`src/lib/club-time/bound.ts`).

      ASSERTED THROUGH TWO DIFFERENT ZONES, and that is the point rather than
      thoroughness: the same instant reads as 16 April in Auckland and 15 April
      in Denver, so this pins both that the SHAPE is the long spelled-out form
      and that the ZONE argument is what decides the day. A binding that ignored
      its zone would give the same answer twice and fail the second line.
    */
    const instant = new Date("2026-04-15T23:30:00.000Z");
    expect(
      bindClubTime(requireClubTimeZone("Pacific/Auckland")).instantLongDate(
        instant,
      ),
    ).toBe("16 April 2026");
    expect(
      bindClubTime(requireClubTimeZone("America/Denver")).instantLongDate(
        instant,
      ),
    ).toBe("15 April 2026");
  });

  for (const site of MEMBER_FACING_LONG_DATE_SITES) {
    it(`keeps ${site.what} on the long spelled-out form`, () => {
      const source = readFileSync(join(process.cwd(), site.file), "utf8");
      for (const snippet of site.mustContain) {
        expect(source).toContain(snippet);
      }
    });
  }
});
