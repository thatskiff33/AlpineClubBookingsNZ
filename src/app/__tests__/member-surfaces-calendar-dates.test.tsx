// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * A LODGE NIGHT RENDERS AS THE DAY IT IS STORED AS, ON EVERY CLUB (CT-4 group E,
 * #2870; epic #2988; INV-DATE-010).
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
 * ## The premise, asserted rather than assumed
 *
 * Stubbing the module is only useful if the stub is what the code reads, and if
 * the stubbed zone really would move the day. Both are checked out loud below,
 * against the raw `Intl` reading rather than against anything this repository
 * wrote, so a runtime that disagreed could not leave the file quietly green.
 */

/**
 * A club whose clocks are BEHIND UTC, which is where this defect shows. The
 * locale is left exactly as the application ships it, because the expected
 * strings below are `en-NZ` house shapes.
 */
const { BEHIND_UTC_CLUB } = vi.hoisted(() => ({
  BEHIND_UTC_CLUB: "America/Denver",
}));

vi.mock("@/config/operational", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  APP_TIME_ZONE: BEHIND_UTC_CLUB,
}));

import { NonMemberGuestsSection } from "@/app/(authenticated)/bookings/_components/non-member-guests-section";
import { KioskWeekView } from "@/app/(lodge)/lodge/kiosk/_components/kiosk-week-view";
import { APP_TIME_ZONE } from "@/config/operational";
import type { KioskWeekDaySummary } from "@/app/(lodge)/lodge/kiosk/_components/kiosk-week-view";

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
  it("the stub is live, and the stubbed club really would move the day", () => {
    /*
      TWO PREMISES, BOTH OF WHICH A LATER EDIT COULD SILENTLY BREAK.

      First: the module stub reached the code. A `vi.mock` that stopped applying
      would leave `APP_TIME_ZONE` at `Pacific/Auckland` and every assertion
      below would pass on the broken code too.

      Second: this club genuinely reads a UTC-midnight encoding as the previous
      day. That is checked against `Intl` directly rather than through any
      helper in this repository, so it is a statement about the runtime rather
      than about the code under test.
    */
    expect(APP_TIME_ZONE).toBe(BEHIND_UTC_CLUB);

    const encoded = new Date(`${WEEK_START}T00:00:00.000Z`);
    const asStored = new Intl.DateTimeFormat("en-NZ", {
      timeZone: "UTC",
      dateStyle: "medium",
    }).format(encoded);
    const throughTheClubZone = new Intl.DateTimeFormat("en-NZ", {
      timeZone: BEHIND_UTC_CLUB,
      dateStyle: "medium",
    }).format(encoded);
    expect(asStored).toBe("13 Apr 2026");
    expect(throughTheClubZone).toBe("12 Apr 2026");
    expect(asStored).not.toBe(throughTheClubZone);
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
});
