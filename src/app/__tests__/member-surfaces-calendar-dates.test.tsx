// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * A LODGE NIGHT RENDERS AS THE DAY IT IS STORED AS, ON EVERY CLUB (CT-4 group E,
 * #2870; epic #2988; INV-DATE-019's first exact boundary, with INV-DATE-026).
 *
 * INV-DATE-010 is why the stored value is an encoding of a calendar day rather
 * than a moment, and that is the only claim it is cited for here: it is not the
 * authority for reading one back, and it says so itself (#3080).
 *
 * ## The defect these assertions are about
 *
 * Every member and public surface in this group rendered its stay dates by
 * handing a `@db.Date` value — a calendar day encoded at UTC midnight — to a
 * formatter pinned to `APP_TIME_ZONE`. That is the identity ONLY because New
 * Zealand is east of Greenwich: the encoding lands at 12:00 or 13:00 on the
 * intended day. For a club west of Greenwich the same encoding lands the
 * PREVIOUS evening, so a stay checking in on Thursday the 16th displayed as
 * Wednesday the 15th — on the booking wizard, the week strip, the emails' twin
 * screens and the guest cards alike.
 *
 * The fix is not a better zone. It is that a calendar day HAS no zone, so the
 * formatters are pinned to `UTC` over the UTC-midnight encoding, which is
 * provably the identity for every club rather than for one.
 *
 * ## Why these assertions can fail, when the obvious version cannot
 *
 * Rendering a lodge night under the default configuration proves nothing:
 * `APP_TIME_ZONE` resolves to `Pacific/Auckland` here (and on CI, where `TZ` is
 * unset), which is exactly the zone whose accident hid the defect. So
 * `@/config/operational` is STUBBED to a behind-UTC club for the whole file.
 * With that stub in place:
 *
 * - the code as written pins `UTC` and renders the stored day — these pass;
 * - the code as it was pins the configured zone and renders the day before —
 *   every assertion below goes red.
 *
 * Measured: flipping any one of the surviving local formatters back to
 * `APP_TIME_ZONE` fails this file. That is the mutant it exists to kill.
 *
 * ## The HOST is moved too, and that is a second, different mutant
 *
 * Stubbing `APP_TIME_ZONE` catches a formatter pinned to the CONFIGURED zone. It
 * cannot catch a formatter pinned to no zone at all — one that dropped its
 * `timeZone: "UTC"` and so renders in whatever zone the runtime resolves, the
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` read `INV-CONFIG-002`
 * forbids. MEASURED, and this is why the line below exists: with `TZ` unset the
 * host on CI IS `UTC`, so `timeZone: "UTC"` and no pin at all are literally the
 * same thing, and that mutant killed **0 of 530** tests in this branch's related
 * set at `TZ=UTC` and 0 with `TZ` unset. Nothing else closes it either —
 * `INV-DATE-015`'s lint arm fires on a MISSING `timeZone` key, and a formatter
 * that names the host's zone has one.
 *
 * So `process.env.TZ` is pointed at the same behind-UTC place for this file, and
 * it is pointed there from `vi.hoisted` — ABOVE the imports — rather than from a
 * `beforeEach`. That is not tidiness. Two of the formatters this file exists to
 * protect are module-level `Intl.DateTimeFormat` CONSTANTS
 * (`kiosk-week-view.tsx`'s `LONG_WEEKDAY_DAY` and `SHORT_DAY_MONTH`), frozen
 * when the module loads; a zone assigned after that point never reaches them,
 * so a `beforeEach` pin would leave exactly the code named above untested. It is
 * put back with `restoreHostTimeZone` in an `afterAll` — never by deleting the
 * variable, because Node only re-derives the zone on ASSIGNMENT (#2485), and
 * never per-test, because the pin is installed once.
 *
 * ## The premise, asserted rather than assumed
 *
 * Stubbing the module is only useful if the stub is what the code reads, and if
 * the stubbed zone really would move the day. Both are checked out loud below,
 * against the raw `Intl` reading rather than against anything this repository
 * wrote, so a runtime that disagreed could not leave the file quietly green.
 *
 * ## Two of the five cases are over `src/lib`, deliberately
 *
 * `resolveDisplayText`'s `{{display-date}}` token and the member-guest consent
 * card's two calendar-day labels are library functions, and `src/lib/**` is
 * group F by the epic's published partition. They are pinned HERE because group
 * E migrated the other half of each value — the lobby wall's header date line,
 * and `bookings/[id]/page.tsx`'s stay dates — so leaving them behind put two
 * different days on one screen. Their own docblocks record the exception and
 * what group F still owns; this file is where the behaviour is held, because it
 * is the one place in the tree with a behind-UTC club AND a behind-UTC host
 * installed, which is what makes either mutant fail.
 */

/**
 * TWO PLACES BEHIND UTC, WHICH IS WHERE THIS DEFECT SHOWS — the configured club
 * and, separately, the MACHINE, moved before anything in this file is imported.
 *
 * They are two DIFFERENT zones on purpose. If the host were pinned to the same
 * `America/Denver` as the stub, then a `vi.mock` that quietly stopped applying
 * would leave `APP_TIME_ZONE` resolving `process.env.TZ` — Denver — and the
 * premise guard demanding Denver would go on passing while proving nothing. With
 * the two apart, a dropped stub answers `America/New_York` and fails loudly.
 * Both are behind Greenwich, so either one moves the calendar day.
 *
 * The locale is left exactly as the application ships it, because the expected
 * strings below are `en-NZ` house shapes.
 *
 * The host reading is taken by hand rather than with `captureHostTimeZone`,
 * because `vi.hoisted` runs above this file's imports and that binding does not
 * exist yet; `restoreHostTimeZone` below is the shared rule, so the awkward half
 * is two property reads and nothing more.
 */
const { BEHIND_UTC_CLUB, BEHIND_UTC_HOST, originalHostTimeZone } = vi.hoisted(
  () => {
    const host = "America/New_York";
    const original = {
      envTz: process.env.TZ,
      resolvedZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    process.env.TZ = host;
    return {
      BEHIND_UTC_CLUB: "America/Denver",
      BEHIND_UTC_HOST: host,
      originalHostTimeZone: original,
    };
  },
);

vi.mock("@/config/operational", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  APP_TIME_ZONE: BEHIND_UTC_CLUB,
}));

import { NonMemberGuestsSection } from "@/app/(authenticated)/bookings/_components/non-member-guests-section";
import { KioskWeekView } from "@/app/(lodge)/lodge/kiosk/_components/kiosk-week-view";
import { APP_TIME_ZONE } from "@/config/operational";
import { restoreHostTimeZone } from "@/lib/__tests__/helpers/timezone";
import { resolveDisplayText } from "@/lib/lodge-display/display-text";
import {
  formatConsentNightsLabel,
  formatConsentStayLabel,
} from "@/lib/member-guest-consent-card";
import type { DisplayState } from "@/lib/lodge-display-state";
import type { KioskWeekDaySummary } from "@/app/(lodge)/lodge/kiosk/_components/kiosk-week-view";

afterAll(() => {
  restoreHostTimeZone(originalHostTimeZone);
});

/** Monday 13 April 2026, and the six days after it. */
const WEEK_START = "2026-04-13";

const WEEK_DAYS: KioskWeekDaySummary[] = [
  {
    date: WEEK_START,
    accessible: true,
    guestCount: 2,
    arrivingCount: 1,
    departingCount: 0,
    rosterStatus: "needs-roster",
  },
];

describe("calendar dates on the member and public surfaces (CT-4, #2870)", () => {
  it("the stub is live, the host has moved, and both would move the day", () => {
    /*
      THREE PREMISES, EVERY ONE OF WHICH A LATER EDIT COULD SILENTLY BREAK.

      First: the module stub reached the code. A `vi.mock` that stopped applying
      would leave `APP_TIME_ZONE` at `Pacific/Auckland` and every assertion
      below would pass on the broken code too.

      Second: the HOST really is where the hoisted block put it, and it is
      somewhere else again. Deleting that assignment — or restoring the zone
      with `delete process.env.TZ`, which Node does not honour (#2485) — would
      put the runtime back on UTC, where a formatter with no zone pin at all is
      indistinguishable from one pinned to `UTC`. This is read from `Intl`
      rather than from `process.env`, because it is the RESOLVED zone that
      decides what an unpinned formatter renders.

      Third: BOTH of those zones genuinely read a UTC-midnight encoding as the
      previous day, so either mutant moves the answer. That is checked against
      `Intl` directly rather than through any helper in this repository, so it
      is a statement about the runtime rather than about the code under test.
    */
    expect(APP_TIME_ZONE).toBe(BEHIND_UTC_CLUB);
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
      BEHIND_UTC_HOST,
    );
    expect(APP_TIME_ZONE).not.toBe(BEHIND_UTC_HOST);

    const encoded = new Date(`${WEEK_START}T00:00:00.000Z`);
    const readIn = (zone: string) =>
      new Intl.DateTimeFormat("en-NZ", {
        timeZone: zone,
        dateStyle: "medium",
      }).format(encoded);
    expect(readIn("UTC")).toBe("13 Apr 2026");
    expect(readIn(BEHIND_UTC_CLUB)).toBe("12 Apr 2026");
    expect(readIn(BEHIND_UTC_HOST)).toBe("12 Apr 2026");
    expect(readIn("UTC")).not.toBe(readIn(BEHIND_UTC_CLUB));
  });

  it("the kiosk week strip labels each column with the night it is", () => {
    render(
      <KioskWeekView
        days={WEEK_DAYS}
        weekStart={WEEK_START}
        todayDate={WEEK_START}
        selectedDate={WEEK_START}
        lodgeName="Silverpeak Lodge"
        readOnly={false}
        refreshing={false}
        canGoToPreviousWeek
        canGoToNextWeek
        onSelectDate={vi.fn()}
        onChangeWeek={vi.fn()}
        onToday={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    // The week range: "13 Apr - 19 Apr 2026". Under the old environment pin this
    // read "12 Apr - 18 Apr 2026" — a whole strip naming the wrong seven nights.
    expect(screen.getByText("13 Apr - 19 Apr 2026")).toBeInTheDocument();

    // The per-column accessible label, rendered verbatim into the day tile's
    // `aria-label` — this is what a hut leader on a tablet hears before tapping,
    // and the long weekday form is the one the kernel has no house shape for, so
    // it is the surviving local formatter this file exists to pin.
    expect(screen.getByLabelText("Open Monday, 13 April")).toBeInTheDocument();

    // And the visible short form beside it.
    expect(screen.getByText("Mon, 13 Apr")).toBeInTheDocument();
  });

  it("a linked non-member child's stay names its own nights", () => {
    render(
      <NonMemberGuestsSection
        nonOwnerAdminViewer={false}
        guests={[
          {
            id: "child-1",
            status: "PENDING",
            guestCount: 2,
            finalPriceCents: 12_000,
            datesDiffer: true,
            // Straight off Prisma: a `@db.Date` column, so UTC midnight.
            checkIn: new Date("2026-04-16T00:00:00.000Z"),
            checkOut: new Date("2026-04-18T00:00:00.000Z"),
          },
        ]}
      />,
    );

    expect(screen.getByText("16 Apr 2026 - 18 Apr 2026")).toBeInTheDocument();
  });

  it("the lobby wall's {{display-date}} token names the window's own night", () => {
    /*
      THE HALF GROUP E FIRST LEFT BEHIND (#2870 fix round).

      `display-header-clock.tsx` was migrated to resolve the header's date line
      to a `CalendarDate` and format it with no zone. This token renders the SAME
      value — `window.start`, a date-only lodge night — and went on pushing it
      through `APP_TIME_ZONE`. One lobby wall, two days, one line apart: under
      the stub above the header read "Thu, 16 Apr" and a template carrying this
      token read "Wednesday, 15 April".

      MUTATION-VERIFIED: pin `displayDateToken`'s formatter back to
      `APP_TIME_ZONE` (or drop the pin altogether, which the moved host catches)
      and this goes red with "Wednesday, 15 April".
    */
    const state = {
      window: { start: "2026-04-16" },
    } as unknown as DisplayState;

    expect(resolveDisplayText("Today is {{display-date}}.", state)).toBe(
      "Today is Thursday, 16 April.",
    );
    expect(resolveDisplayText("{{display-date}}", state)).not.toContain(
      "15 April",
    );
  });

  it("the member-guest consent card lists the nights the guest is actually on", () => {
    /*
      THE SAME PAGE CONTRADICTING ITSELF (#2870 fix round).

      `bookings/[id]/page.tsx` now decodes its stay line as the calendar days it
      holds, while these two labels — rendered a few lines below it, from
      `@db.Date` values of the same kind — still projected through
      `APP_TIME_ZONE`. Under the stub above the stay line read "8 August 2026"
      and the consent card beside it listed the guest's nights as
      "Fri 7 Aug, Sat 8 Aug".

      The fixtures are exactly the Prisma shape: `@db.Date` columns come back as
      UTC midnight.

      MUTATION-VERIFIED: send `consentCalendarNight` / `consentCalendarDay` back
      through `CONSENT_WEEKDAY_DATE` / `CONSENT_FULL_DATE` and both assertions go
      red a day early.
    */
    const night = (day: string) => new Date(`${day}T00:00:00.000Z`);

    expect(
      formatConsentNightsLabel([night("2026-08-08"), night("2026-08-09")]),
    ).toBe("Sat 8 Aug, Sun 9 Aug");
    expect(
      formatConsentStayLabel(night("2026-08-08"), night("2026-08-10")),
    ).toBe("Sat 8 Aug – Mon 10 Aug 2026 (2 nights)");
  });
});
