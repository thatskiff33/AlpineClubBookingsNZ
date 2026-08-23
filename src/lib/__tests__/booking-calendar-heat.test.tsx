// @vitest-environment jsdom

import {
  CLUB_TIME_TEST_ZONE,
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
  A day in the current month that is never in the past: tomorrow, clamped to the
  month's last day (mirrors booking-calendar-a11y.test.tsx so assertions stay
  deterministic across any run date).

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

function targetLabelPrefix() {
  const date = new Date(now.getFullYear(), now.getMonth(), targetDay);
  return date.toLocaleDateString(APP_LOCALE, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function stubAvailability(
  occupiedOnTarget: number,
  season?: { name: string; type: string },
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        availability: { [targetIso]: occupiedOnTarget },
        seasons: season ? { [targetIso]: season } : {},
      }),
    })),
  );
}

async function targetButton() {
  const prefix = targetLabelPrefix();
  return waitFor(() =>
    screen.getByRole("button", {
      name: (accessibleName: string) => accessibleName.startsWith(prefix),
    }),
  );
}

describe("BookingCalendar token-driven availability heat (#1814)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("paints a plenty night (>15 free) with the success token and shows the free-bed count", async () => {
    stubAvailability(2); // 18 of 20 free
    render(<BookingCalendar onDateSelect={() => {}} />);

    const button = await targetButton();
    expect(button.className).toContain("bg-success-muted");
    expect(button.className).toContain("text-success");
    // The free-bed count is the non-colour signal.
    expect(button.textContent).toContain("18");
  });

  it("paints a filling night (6-15 free) with the warning token", async () => {
    stubAvailability(8); // 12 of 20 free
    render(<BookingCalendar onDateSelect={() => {}} />);

    const button = await targetButton();
    expect(button.className).toContain("bg-warning-muted");
    expect(button.className).toContain("text-warning");
    expect(button.textContent).toContain("12");
  });

  it("paints a nearly-full night (1-5 free) with the info step", async () => {
    stubAvailability(17); // 3 of 20 free
    render(<BookingCalendar onDateSelect={() => {}} />);

    const button = await targetButton();
    expect(button.className).toContain("bg-info-muted");
    expect(button.className).toContain("text-info");
    expect(button.textContent).toContain("3");
  });

  it("paints a full night (0 free) with the danger token and a 'Full' label instead of colour alone", async () => {
    stubAvailability(20); // 0 of 20 free
    render(<BookingCalendar onDateSelect={() => {}} />);

    const button = await targetButton();
    expect(button.className).toContain("bg-danger-muted");
    expect(button.className).toContain("text-danger");
    // "Full" carries the meaning without relying on the danger colour.
    expect(button.textContent).toContain("Full");
  });

  it("marks the selected check-in with the brand-gold accent, not a heat colour", async () => {
    stubAvailability(2);
    render(<BookingCalendar onDateSelect={() => {}} selectedCheckIn={targetIso} />);

    const button = await targetButton();
    expect(button.className).toContain("!bg-brand-gold");
    expect(button.className).toContain("!text-brand-charcoal");
  });

  it("states a season with text as well as a coloured top border", async () => {
    stubAvailability(2, { name: "Winter 2026", type: "WINTER" });
    render(<BookingCalendar onDateSelect={() => {}} />);

    const button = await targetButton();
    expect(button.getAttribute("aria-label")).toContain("Winter 2026 season");
    expect(button.textContent).toContain("W");
  });
});
