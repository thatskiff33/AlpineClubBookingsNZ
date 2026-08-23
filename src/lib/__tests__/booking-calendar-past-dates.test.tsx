// @vitest-environment jsdom

import {
  CLUB_TIME_TEST_ZONE,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_LOCALE } from "@/config/operational";

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
}));

import { BookingCalendar } from "@/components/booking-calendar";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";

/*
  Navigating with the calendar's own Prev button keeps the assertions
  deterministic across any real run date: the 15th exists in every month, a
  month one step back is always within the 365-day retroactive window, and a
  month 13 steps back is always beyond it (#1695).

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

function monthLabelPrefix(monthsBack: number, day: number) {
  const date = new Date(now.getFullYear(), now.getMonth() - monthsBack, day);
  return date.toLocaleDateString(APP_LOCALE, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function monthHeading(monthsBack: number) {
  return new Date(now.getFullYear(), now.getMonth() - monthsBack, 1).toLocaleDateString(
    APP_LOCALE,
    { month: "long", year: "numeric" },
  );
}

async function goBackMonths(months: number) {
  for (let i = 0; i < months; i += 1) {
    fireEvent.click(screen.getByRole("button", { name: /Prev/ }));
  }
  await waitFor(() =>
    expect(screen.getByText(monthHeading(months))).toBeTruthy(),
  );
}

function dayButton(monthsBack: number, day: number) {
  const prefix = monthLabelPrefix(monthsBack, day);
  return screen.getByRole("button", {
    name: (accessibleName: string) => accessibleName.startsWith(prefix),
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ availability: {}, seasons: {} }),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BookingCalendar retroactive dates (#1695)", () => {
  it("disables past days by default (member flow pin)", async () => {
    render(<BookingCalendar onDateSelect={() => {}} />);
    await goBackMonths(1);

    expect(dayButton(1, 15).hasAttribute("disabled")).toBe(true);
  });

  it("makes a past day within the window clickable under allowPastDates", async () => {
    render(<BookingCalendar onDateSelect={() => {}} allowPastDates />);
    await goBackMonths(1);

    const button = dayButton(1, 15);
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-label")).toContain(
      "past date — retroactive booking",
    );
  });

  it("keeps days beyond the 365-day lookback disabled even under allowPastDates", async () => {
    render(<BookingCalendar onDateSelect={() => {}} allowPastDates />);
    await goBackMonths(13);

    expect(dayButton(13, 15).hasAttribute("disabled")).toBe(true);
  });
});

describe("BookingCalendar full future days (#1767)", () => {
  // The month one step FORWARD always contains the 15th as a future day.
  const fullDay = new Date(now.getFullYear(), now.getMonth() + 1, 15);
  const fullDayStr = `${fullDay.getFullYear()}-${String(fullDay.getMonth() + 1).padStart(2, "0")}-${String(fullDay.getDate()).padStart(2, "0")}`;

  async function goForwardOneMonth() {
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() =>
      expect(screen.getByText(monthHeading(-1))).toBeTruthy(),
    );
  }

  beforeEach(() => {
    // Mark the target day fully occupied (capacity is mocked at 20).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ availability: { [fullDayStr]: 20 }, seasons: {} }),
      })),
    );
  });

  it("keeps a full future day disabled by default (member flow pin)", async () => {
    render(<BookingCalendar onDateSelect={() => {}} />);
    await goForwardOneMonth();

    await waitFor(() =>
      expect(dayButton(-1, 15).hasAttribute("disabled")).toBe(true),
    );
    const label = dayButton(-1, 15).getAttribute("aria-label");
    expect(label).toContain("full");
    expect(label).not.toContain("selectable for over-capacity booking");
  });

  it("makes a full future day clickable under allowFullDates with the over-capacity hint", async () => {
    render(<BookingCalendar onDateSelect={() => {}} allowFullDates />);
    await goForwardOneMonth();

    await waitFor(() =>
      expect(dayButton(-1, 15).getAttribute("aria-label")).toContain(
        "full — selectable for over-capacity booking",
      ),
    );
    expect(dayButton(-1, 15).hasAttribute("disabled")).toBe(false);
  });
});
