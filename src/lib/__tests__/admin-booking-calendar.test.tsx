// @vitest-environment jsdom

import {
  CLUB_TIME_TEST_ZONE,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { AdminBookingCalendar } from "@/components/admin-booking-calendar";
import { ClubTimeProvider } from "@/components/club-time-provider";
import { normalizeDateOnlyForTimeZone } from "@/lib/date-only";

// The component reads router/search params from next/navigation; provide
// minimal stand-ins so it renders outside the App Router.
const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => new URLSearchParams(),
}));

// The calendar initially shows the current month, so build booking dates
// inside it (days 5-20 exist in every month).
//
// These fixtures — and the first two describes, which use them — run on a
// PINNED clock rather than the runner's. (The LAST two describes pin a
// different instant of their own for a deterministic June grid.) The instant is
// chosen, not arbitrary: 2026-06-30T22:00Z is 30 June in UTC and 1 July in NZ
// (10:00 NZST). The component seeds its month from the CLUB's timezone
// (`clubTime.today()`), so with the club on NZ time it renders JULY here — a
// component that regressed to the runner's local date would render June on a
// UTC runner and paint none of the fixtures below. That disagreement used to
// exist only during the last hours of a month, which is exactly why it reached
// CI unnoticed (#2426); pinning it makes the same regression fail on every run.
//
// THE ZONE THE FIXTURES ARE BUILT IN IS THE HARNESS'S, NOT THE ENVIRONMENT'S,
// and after CT-4 (#2870) that distinction is load-bearing. Until CT-4 the
// component read `APP_TIME_ZONE` and so did this line, so the two agreed
// whatever `TZ` said and the old comment here could truthfully call the check
// inert on a `TZ`-set host. The component now reads the ClubTimeProvider, so a
// fixture month derived from `APP_TIME_ZONE` follows the HOST while the calendar
// follows the PROVIDER: on `TZ=America/Denver` the fixtures landed in June, the
// calendar opened on July, and nine of the thirteen tests below failed against
// entirely correct code. `CLUB_TIME_TEST_ZONE` is what the harness mounts, so
// both sides now name the same authority and no host can move one without the
// other.
//
// The month is then resolved the way the COMPONENT resolves it — the club
// timezone's calendar date for that instant, as UTC midnight — which is what the
// module scope needs: fixtures are built at import time, before any `beforeEach`
// can install the fake clock.
const PINNED_NOW = new Date("2026-06-30T22:00:00.000Z"); // NZ 2026-07-01 10:00
const now = normalizeDateOnlyForTimeZone(PINNED_NOW, CLUB_TIME_TEST_ZONE); // 2026-07-01
const isoDay = (day: number) =>
  `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

// Fake only Date so React Testing Library's real timers still drive waitFor.
function pinClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
}

const calendarResponse = {
  bookings: [
    {
      id: "booking-paid",
      memberName: "Paula Paid",
      checkIn: isoDay(5),
      checkOut: isoDay(7),
      status: "PAID",
      guestCount: 2,
    },
    {
      id: "booking-cancelled",
      memberName: "Casey Cancelled",
      checkIn: isoDay(10),
      checkOut: isoDay(12),
      status: "CANCELLED",
      guestCount: 1,
    },
  ],
  availability: {},
};

describe("AdminBookingCalendar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pinClock();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => calendarResponse,
      })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("hides cancelled bookings by default with the Cancelled pill off", async () => {
    render(<AdminBookingCalendar />);

    // Non-cancelled bookings render once the fetch resolves.
    await waitFor(() => {
      expect(screen.getByText(/Paula Paid/)).toBeTruthy();
    });

    // The CANCELLED toggle pill starts in the off state; others stay on.
    expect(
      screen.getByRole("button", { name: "Cancelled" }).getAttribute("aria-pressed")
    ).toBe("false");
    expect(
      screen.getByRole("button", { name: "Paid" }).getAttribute("aria-pressed")
    ).toBe("true");

    // The cancelled booking bar is not rendered.
    expect(screen.queryByText(/Casey Cancelled/)).toBeNull();
  });

  it("shows cancelled bookings after the Cancelled pill is toggled on", async () => {
    render(<AdminBookingCalendar />);

    await waitFor(() => {
      expect(screen.getByText(/Paula Paid/)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancelled" }));

    expect(
      screen.getByRole("button", { name: "Cancelled" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.getByText(/Casey Cancelled/)).toBeTruthy();
  });

  it("persists the status toggles across visits (#1039)", async () => {
    const { unmount } = render(<AdminBookingCalendar />);

    await waitFor(() => {
      expect(screen.getByText(/Paula Paid/)).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancelled" }));
    unmount();

    // A fresh mount (new visit) restores the stored choice instead of the
    // hide-cancelled default.
    render(<AdminBookingCalendar />);
    await waitFor(() => {
      expect(screen.getByText(/Paula Paid/)).toBeTruthy();
    });
    expect(
      screen.getByRole("button", { name: "Cancelled" }).getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.getByText(/Casey Cancelled/)).toBeTruthy();
  });

  it("falls back to the hide-cancelled default when storage holds garbage (#1039)", async () => {
    window.localStorage.setItem(
      "admin-calendar-enabled-statuses",
      "not json at all",
    );

    render(<AdminBookingCalendar />);
    await waitFor(() => {
      expect(screen.getByText(/Paula Paid/)).toBeTruthy();
    });
    expect(
      screen.getByRole("button", { name: "Cancelled" }).getAttribute("aria-pressed")
    ).toBe("false");
    expect(screen.queryByText(/Casey Cancelled/)).toBeNull();
  });
});

// A day that exists in every month; days 5..19 are covered by the fixtures.
const CONCURRENT_START = 5;
const CONCURRENT_CHECKOUT = 9; // covers nights 5..8

function concurrentResponse(
  count: number,
  opts?: { spanning?: boolean },
) {
  const bookings = Array.from({ length: count }, (_, i) => ({
    id: `busy-${i}`,
    memberName: `Member ${i}`,
    checkIn: isoDay(CONCURRENT_START),
    checkOut: isoDay(CONCURRENT_CHECKOUT),
    status: "PAID",
    guestCount: 2,
  }));
  if (opts?.spanning) {
    // Spans ~two weeks so it crosses at least one week boundary in any month.
    bookings.push({
      id: "spanner",
      memberName: "Spanner Sam",
      checkIn: isoDay(CONCURRENT_START),
      checkOut: isoDay(20),
      status: "PAID",
      guestCount: 3,
    });
  }
  return { bookings, availability: {} };
}

function stubCalendar(response: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => response }),
  );
}

function assertBarsWithinBands(container: HTMLElement) {
  const bars = container.querySelectorAll<HTMLElement>("[data-booking-id]");
  expect(bars.length).toBeGreaterThan(0);
  bars.forEach((bar) => {
    const rowTop = Number(bar.getAttribute("data-row-top"));
    const rowHeight = Number(bar.getAttribute("data-row-height"));
    const top = parseFloat(bar.style.top);
    const height = parseFloat(bar.style.height);
    // Every bar segment sits inside its own week row band, so nothing paints
    // over the row below (#2088).
    expect(top).toBeGreaterThanOrEqual(rowTop);
    expect(top + height).toBeLessThanOrEqual(rowTop + rowHeight + 0.01);
  });
}

describe("AdminBookingCalendar overflow layout (#2088)", () => {
  beforeEach(() => {
    pinClock();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  for (const count of [4, 6, 10]) {
    it(`keeps every bar inside its week band with ${count} concurrent bookings`, async () => {
      stubCalendar(concurrentResponse(count, { spanning: true }));
      const { container } = render(<AdminBookingCalendar />);

      await waitFor(() => {
        expect(container.querySelectorAll("[data-booking-id]").length).toBeGreaterThan(0);
      });

      assertBarsWithinBands(container);
    });
  }

  it("shows no '+N more' affordance when bookings stay within the lane cap", async () => {
    stubCalendar(concurrentResponse(4));
    const { container } = render(<AdminBookingCalendar />);

    await waitFor(() => {
      expect(container.querySelectorAll("[data-booking-id]").length).toBeGreaterThan(0);
    });

    expect(container.querySelector("[data-more-day]")).toBeNull();
  });

  it("collapses the surplus into '+N more' and opens the complete day list", async () => {
    stubCalendar(concurrentResponse(10));
    const { container } = render(<AdminBookingCalendar />);

    await waitFor(() => {
      expect(container.querySelectorAll("[data-booking-id]").length).toBeGreaterThan(0);
    });

    // Only 5 of the 10 lanes render as bars; the remainder collapse to a chip.
    const more = container.querySelector<HTMLElement>("[data-more-day]");
    expect(more).not.toBeNull();
    expect(more?.textContent).toMatch(/\+5 more/);

    // A hidden booking (lane 5+) is not painted anywhere until the list opens.
    expect(screen.queryByText("Member 9")).toBeNull();

    fireEvent.click(more as HTMLElement);

    const dialog = await screen.findByRole("dialog");
    // The dialog lists ALL bookings for the night and says so explicitly, so the
    // "+5 more" chip count and the dialog count no longer read as a mismatch.
    expect(
      within(dialog).getByText(
        /All 10 bookings staying this night \(5 shown on the calendar\)/,
      ),
    ).toBeTruthy();
    // The full list includes the bookings that were collapsed under the cap.
    expect(within(dialog).getByText("Member 9")).toBeTruthy();
    expect(within(dialog).getByText("Member 0")).toBeTruthy();
  });
});

describe("AdminBookingCalendar overflow name labelling (#2088 review)", () => {
  // Pin the view to June 2026 (June 1 is a Monday, so week 0 = the 1st–7th and
  // week 1 = the 8th–14th) for a deterministic grid.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  // A multi-week booking whose *first* segment is collapsed under week 0's
  // "+N more" cap, but whose continuation renders as a visible bar in the
  // (non-overflow) next week. Ordering forces lanes: five fillers take lanes
  // 0–4, the spanner takes lane 5 (hidden in the overflow week), and two more
  // fillers take lanes 6–7 to push week 0 over the cap. In week 1 the spanner is
  // the only booking, so its lane-5 bar is painted and must carry the member
  // name — previously it rendered as a nameless orphan bar.
  function orphanBarResponse() {
    const iso = (day: number) => `2026-06-${String(day).padStart(2, "0")}`;
    const filler = (id: string) => ({
      id,
      memberName: `Filler ${id}`,
      checkIn: iso(2),
      checkOut: iso(5), // nights 2–4, all inside week 0
      status: "PAID",
      guestCount: 2,
    });
    return {
      bookings: [
        filler("a0"),
        filler("a1"),
        filler("a2"),
        filler("a3"),
        filler("a4"),
        {
          id: "spanner",
          memberName: "Spanner Sam",
          checkIn: iso(2),
          checkOut: iso(12), // nights 2–11: week 0 into week 1
          status: "PAID",
          guestCount: 3,
        },
        filler("b0"),
        filler("b1"),
      ],
      availability: {},
    };
  }

  it("labels the first VISIBLE segment so a hidden-first-week booking is not a nameless bar", async () => {
    stubCalendar(orphanBarResponse());
    const { container } = render(<AdminBookingCalendar />);

    await waitFor(() => {
      expect(container.querySelectorAll("[data-booking-id]").length).toBeGreaterThan(0);
    });

    // The spanner's week-0 segment is collapsed under the cap, but its week-1
    // continuation now renders the member name (regression: it was blank).
    const spannerBars = container.querySelectorAll('[data-booking-id="spanner"]');
    // Exactly one visible segment (week 1); the week-0 segment is hidden.
    expect(spannerBars.length).toBe(1);
    expect(spannerBars[0].getAttribute("data-row-index")).toBe("1");
    expect(spannerBars[0].textContent).toMatch(/Spanner Sam/);

    // And it is still counted in week 0's "+N more" chip + dialog for the 2nd.
    const more = container.querySelector<HTMLElement>('[data-more-day="2026-06-02"]');
    expect(more).not.toBeNull();
    expect(more?.textContent).toMatch(/\+3 more/);

    fireEvent.click(more as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        /All 8 bookings staying this night \(5 shown on the calendar\)/,
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText("Spanner Sam")).toBeTruthy();
  });
});

describe("AdminBookingCalendar past-day greying (#2088 D-G2)", () => {
  // Fake only Date so React Testing Library's real timers still drive waitFor.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // NZ (UTC+12) reads this instant as 2026-06-15, and a UTC test runner reads
    // the same calendar month, so the visible month is June 2026 either way.
    vi.setSystemTime(new Date("2026-06-15T00:00:00Z"));
    stubCalendar({ bookings: [], availability: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  const dataPast = (container: HTMLElement, day: string) =>
    container
      .querySelector(`[data-day="${day}"]`)
      ?.getAttribute("data-past") ?? null;

  it("greys strictly-past days but leaves today and future days live", () => {
    const { container } = render(<AdminBookingCalendar />);

    // Today (NZ) stays live.
    expect(container.querySelector('[data-day="2026-06-15"]')).not.toBeNull();
    expect(dataPast(container, "2026-06-15")).toBeNull();

    // A finished day earlier in the month is greyed.
    expect(dataPast(container, "2026-06-14")).toBe("true");
    // The first of the month (a month-boundary day) is greyed when past.
    expect(dataPast(container, "2026-06-01")).toBe("true");

    // A future day stays live.
    expect(dataPast(container, "2026-06-20")).toBeNull();
  });

  it("greys an entire finished previous month across the boundary", async () => {
    const { container } = render(<AdminBookingCalendar />);

    fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await waitFor(() => expect(screen.getByText("May 2026")).toBeTruthy());

    // The previous month is wholly in the past — its last day greys too.
    expect(dataPast(container, "2026-05-31")).toBe("true");
    expect(dataPast(container, "2026-05-01")).toBe("true");
  });

  it("leaves a future month entirely live", async () => {
    const { container } = render(<AdminBookingCalendar />);

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    await waitFor(() => expect(screen.getByText("July 2026")).toBeTruthy());

    expect(dataPast(container, "2026-07-01")).toBeNull();
    expect(dataPast(container, "2026-07-15")).toBeNull();
  });
});

/**
 * THE CLUB'S PERSISTED ZONE DECIDES WHICH MONTH OPENS (CT-4, #2870; epic #2988;
 * INV-CONFIG-002).
 *
 * Everything above renders through the harness's default provider, which is
 * `Pacific/Auckland` — the same answer `APP_TIME_ZONE` gives under test — so the
 * migrated code and the code it replaced produce the identical grid and none of
 * those assertions can tell the persisted zone from the environment. That is
 * deliberate: they are about bars, overflow and greying, and re-pointing them at
 * a foreign zone would change what they mean without proving anything.
 *
 * This pair is the one that is about the ZONE. The same component, the same
 * pinned instant, under two provider zones, asserted to open on two different
 * MONTHS. An implementation that ignored the provider — reading `APP_TIME_ZONE`,
 * the viewer's clock, or a hard-coded `Pacific/Auckland` — answers both halves
 * identically and fails one of them, whatever the host's `TZ` happens to be.
 */
describe("AdminBookingCalendar opens on the CLUB's month (CT-4, #2870)", () => {
  /** Behind UTC, so it disagrees with both the harness zone and a UTC host. */
  const CLUB_ZONE_BEHIND_UTC = "America/Denver";

  function providerFor(zone: string) {
    return function PinnedClubTime({ children }: { children: ReactNode }) {
      return <ClubTimeProvider zone={zone}>{children}</ClubTimeProvider>;
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(PINNED_NOW);
    stubCalendar({ bookings: [], availability: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("opens on June for a club six hours behind UTC", async () => {
    /*
      PREMISE, as an ANSWER rather than an identifier: on this pinned instant the
      two zones fall in DIFFERENT MONTHS. Asserting the calendar day rather than
      comparing zone names is what stops this going vacuous if the fixture instant
      is ever edited — a name check passes happily under America/Chicago while the
      assertion beneath it stops discriminating.
    */
    expect(
      normalizeDateOnlyForTimeZone(PINNED_NOW, CLUB_ZONE_BEHIND_UTC)
        .toISOString()
        .slice(0, 10),
    ).toBe("2026-06-30");
    expect(
      normalizeDateOnlyForTimeZone(PINNED_NOW, CLUB_TIME_TEST_ZONE)
        .toISOString()
        .slice(0, 10),
    ).toBe("2026-07-01");

    render(<AdminBookingCalendar />, {
      wrapper: providerFor(CLUB_ZONE_BEHIND_UTC),
    });

    await waitFor(() => expect(screen.getByText("June 2026")).toBeTruthy());
    expect(screen.queryByText("July 2026")).toBeNull();
  });

  it("opens on July for a club twelve hours ahead of it", async () => {
    // The mirror image, and it is what makes the case above about the PROVIDER
    // rather than about a hard-coded June.
    render(<AdminBookingCalendar />, {
      wrapper: providerFor(CLUB_TIME_TEST_ZONE),
    });

    await waitFor(() => expect(screen.getByText("July 2026")).toBeTruthy());
    expect(screen.queryByText("June 2026")).toBeNull();
  });
});
