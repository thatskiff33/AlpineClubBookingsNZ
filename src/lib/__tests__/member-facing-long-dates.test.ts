import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  calendarDateOfDateOnlyInstant,
  formatClubLongDate,
  requireCalendarDate,
} from "../club-time";
import { formatNZDate, formatNZLongDate } from "../nzst-date";
import { expectClubTimeZonePremise } from "./helpers/club-time-zone";

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
    mustContain: ["return formatNZLongDate(new Date(value));"],
  },
  {
    what: "the public hut-leader-instructions 'last updated' stamp",
    file: "src/app/(website-dynamic)/hut-leader-instructions/hut-leader-instructions-client.tsx",
    mustContain: ["return formatNZLongDate(new Date(value));"],
  },
  {
    what: "the generated report PDF cover",
    file: "src/lib/report-pdf.ts",
    mustContain: ["Generated: ${formatNZLongDate(new Date())}"],
  },
];

describe("member-facing dates keep the long spelled-out month (#2264)", () => {
  it("renders the long form, which is NOT the medium house form", () => {
    // 23:30 UTC on 15 April is 16 April in Auckland, so this also proves the
    // long formatter is club-zone pinned rather than UTC.
    //
    // THE PREMISE, because this case reads the ENVIRONMENT's zone and the case
    // below deliberately does not. `formatNZ*` still resolves `APP_TIME_ZONE`,
    // so on a machine whose `TZ` is set to anything else this asserts 15 April
    // and reads exactly like the dating bug it exists to disprove
    // (docs/TESTING.md rule 6). One failure that says "environment" is worth
    // more than a bare date mismatch.
    expectClubTimeZonePremise();
    const instant = new Date("2026-04-15T23:30:00.000Z");
    expect(formatNZLongDate(instant)).toBe("16 April 2026");
    expect(formatNZDate(instant)).toBe("16 Apr 2026");
  });

  it("the kernel's CALENDAR-DAY long form is the same shape, and takes no zone", () => {
    /*
      What CT-4 (#2870) replaced the first site's call with, pinned here so the
      migration cannot quietly change the shape INV-DATE-016 is about.

      The two are not interchangeable and that is the point: `formatNZLongDate`
      asks "what long date is this MOMENT, in the environment's zone?", while
      `formatClubLongDate` asks "what long date is this CALENDAR DAY?" and takes
      no zone because the question has none. For a `@db.Date` value they agree in
      New Zealand and disagree by a day for a club west of Greenwich, which is
      why the call site moved.
    */
    const lodgeNight = requireCalendarDate("2026-04-16");
    expect(formatClubLongDate(lodgeNight)).toBe("16 April 2026");
    expect(
      formatClubLongDate(
        calendarDateOfDateOnlyInstant(new Date("2026-04-16T00:00:00.000Z")),
      ),
    ).toBe("16 April 2026");
  });

  for (const site of MEMBER_FACING_LONG_DATE_SITES) {
    it(`keeps ${site.what} on formatNZLongDate`, () => {
      const source = readFileSync(join(process.cwd(), site.file), "utf8");
      for (const snippet of site.mustContain) {
        expect(source).toContain(snippet);
      }
    });
  }
});
