// @vitest-environment jsdom

import {
  CLUB_TIME_TEST_ZONE,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_LOCALE } from "@/config/operational";

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
}));

import { BookingCalendar } from "@/components/booking-calendar";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";

/*
  A day in the current month that is never in the past: tomorrow, clamped to
  the month's last day (the last day equals "today" at month end, which the
  calendar still treats as bookable).

  "TODAY" HERE IS THE CLUB'S DAY, NOT THE HOST'S (CT-4, #2870).

  `BookingCalendar` opens on the month `clubTime.today()` names, which comes from
  the `ClubTimeProvider` this harness mounts (`Pacific/Auckland`). Deriving these
  fixtures from a bare `new Date()` reads the RUNNER's clock instead, and the two
  agree only while the host is on or east of UTC — which is CI's shape, and is why
  it looked fine. On a developer machine or container running `TZ=America/Denver`
  the frozen instant is 30 June there and 1 July at the club, so every fixture
  below landed in the wrong month and this suite failed against entirely correct
  code. Same defect, same reasoning and same fix as the header of
  `admin-booking-calendar.test.tsx`.

  Constructed as a LOCAL date from the club's calendar parts, so every
  `now.get*()` reader below keeps working unchanged and returns the club's
  year/month/day in any host zone.
*/
const clubToday = bindClubTime(requireClubTimeZone(CLUB_TIME_TEST_ZONE)).today();
const [clubYear, clubMonth, clubDay] = clubToday.split("-").map(Number);
const now = new Date(clubYear, clubMonth - 1, clubDay);
const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
const targetDay = Math.min(now.getDate() + 1, lastDay);
const targetIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;

// Lodge nights are date-only `yyyy-MM-dd` strings (#2474), so tests pass the key
// the calendar itself would build for a calendar day rather than a `Date`.
const toDateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

describe("BookingCalendar accessibility", () => {
  beforeEach(() => {
    // 6 beds occupied on the target day -> 14 of 20 free.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          availability: { [targetIso]: 6 },
          seasons: {},
        }),
      })),
    );
  });

  it("labels day buttons with the date and available beds", async () => {
    render(<BookingCalendar onDateSelect={() => {}} />);

    const date = new Date(now.getFullYear(), now.getMonth(), targetDay);
    const dateLabel = date.toLocaleDateString(APP_LOCALE, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: `${dateLabel}, 14 of 20 beds free`,
        }),
      ).not.toBeNull(),
    );
  });

  it("announces the selection prompt via a live region", () => {
    const { container } = render(<BookingCalendar onDateSelect={() => {}} />);

    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain("Select check-in date");
  });

  it("exposes the selected check-in to screen readers", async () => {
    const date = new Date(now.getFullYear(), now.getMonth(), targetDay);
    render(<BookingCalendar onDateSelect={() => {}} selectedCheckIn={targetIso} />);

    const dateLabel = date.toLocaleDateString(APP_LOCALE, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    const selected = await waitFor(() =>
      screen.getByRole("button", {
        name: `${dateLabel}, 14 of 20 beds free, selected as check-in`,
      }),
    );
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(selected.textContent).toContain("In");
    expect(selected.className).toContain("!border-double");
  });

  it("shows text and border-style cues across a selected stay", async () => {
    const checkIn = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const checkOut = new Date(now.getFullYear(), now.getMonth() + 1, 3);
    render(
      <BookingCalendar
        onDateSelect={() => {}}
        selectedCheckIn={toDateKey(checkIn)}
        selectedCheckOut={toDateKey(checkOut)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    const buttons = await waitFor(() =>
      screen.getAllByRole("button", { pressed: true }),
    );
    const start = buttons.find((button) => button.textContent?.includes("In"));
    const middle = buttons.find((button) => button.textContent?.includes("Stay"));
    const end = buttons.find((button) => button.textContent?.includes("Out"));

    expect(start?.className).toContain("!border-double");
    expect(middle?.className).toContain("!border-dashed");
    expect(end?.className).toContain("!border-double");
  });
});
