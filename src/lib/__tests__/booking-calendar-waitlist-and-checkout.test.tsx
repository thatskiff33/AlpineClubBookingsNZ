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

import { BookingCalendar } from "@/components/booking-calendar";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";

/*
  #2930 — the member calendar's three defects, each of which made a legitimate
  stay unexpressible or a wrong number believable.

  Fixtures are derived from the CLUB's day, not the runner's: the calendar opens
  on the month `clubTime.today()` names, and a host west of Greenwich disagrees
  with the club about which month that is. Same reasoning as the header of
  `booking-calendar-heat.test.tsx`.
*/
const clubToday = bindClubTime(requireClubTimeZone(CLUB_TIME_TEST_ZONE)).today();
const [clubYear, clubMonth, clubDay] = clubToday.split("-").map(Number);
const now = new Date(clubYear, clubMonth - 1, clubDay);

/** A day next month, so it is always in the future whatever today is. */
function nextMonthDay(day: number) {
  const d = new Date(now.getFullYear(), now.getMonth() + 1, day);
  return {
    iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    day,
  };
}

/** The month AFTER that, for the retention test. */
function monthAfterNextDay(day: number) {
  const d = new Date(now.getFullYear(), now.getMonth() + 2, day);
  return {
    iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    day,
  };
}

const CAPACITY = 20;
const ARRIVE = nextMonthDay(10);
const FULL_DAY = nextMonthDay(12);

/**
 * Find a day cell by its accessible name, which is the fully spelled-out club
 * date (#2264). Matching the prefix rather than a bare number is what keeps the
 * lookup from colliding with the "12" inside a year or another month's cell.
 */
function labelPrefix(monthsForward: number, day: number) {
  return new Date(
    now.getFullYear(),
    now.getMonth() + monthsForward,
    day,
  ).toLocaleDateString(APP_LOCALE, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function monthHeading(monthsForward: number) {
  return new Date(
    now.getFullYear(),
    now.getMonth() + monthsForward,
    1,
  ).toLocaleDateString(APP_LOCALE, { month: "long", year: "numeric" });
}

function dayButton(monthsForward: number, day: number) {
  const prefix = labelPrefix(monthsForward, day);
  return screen.getByRole("button", {
    name: (accessibleName: string) => accessibleName.startsWith(prefix),
  }) as HTMLButtonElement;
}

async function goForwardMonths(months: number) {
  for (let i = 0; i < months; i += 1) {
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  }
  await waitFor(() => expect(screen.getByText(monthHeading(months))).toBeTruthy());
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("a full future night is the waitlist door, not a dead end (#2930)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          lodgeCapacity: CAPACITY,
          availability: { [FULL_DAY.iso]: CAPACITY },
          seasons: {},
        }),
      })),
    );
  });

  it("leaves a full future night selectable and says what selecting it does", async () => {
    render(<BookingCalendar onDateSelect={() => {}} />);
    await goForwardMonths(1);

    await waitFor(() => {
      const button = dayButton(1, FULL_DAY.day);
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(button.getAttribute("aria-label")).toContain("full — waitlist only");
    });
  });

  it("can be picked as a check-in, which is what reaches the server's waitlist offer", async () => {
    const onDateSelect = vi.fn();
    render(<BookingCalendar onDateSelect={onDateSelect} />);
    await goForwardMonths(1);

    await waitFor(() => expect(dayButton(1, FULL_DAY.day)).toBeTruthy());
    fireEvent.click(dayButton(1, FULL_DAY.day));
    // Second click completes the range; the callback firing at all is the proof
    // the full night was accepted as an arrival.
    fireEvent.click(dayButton(1, FULL_DAY.day + 1));

    expect(onDateSelect).toHaveBeenCalledWith(FULL_DAY.iso, nextMonthDay(FULL_DAY.day + 1).iso);
  });
});

describe("half-open checkout: a full night is still a valid departure morning (#2930)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          lodgeCapacity: CAPACITY,
          // The ARRIVAL night has beds. The DEPARTURE morning is full — which is
          // none of this member's business, because occupancy is [checkIn,
          // checkOut) and they use no bed on the day they leave (`INV-DATE-003`).
          availability: { [ARRIVE.iso]: 2, [FULL_DAY.iso]: CAPACITY },
          seasons: {},
        }),
      })),
    );
  });

  it("re-describes the full day as a check-out morning once an arrival is chosen", async () => {
    render(<BookingCalendar onDateSelect={() => {}} />);
    await goForwardMonths(1);

    await waitFor(() => expect(dayButton(1, ARRIVE.day)).toBeTruthy());
    // Before the arrival is picked the same cell is an ARRIVAL candidate.
    expect(dayButton(1, FULL_DAY.day).getAttribute("aria-label")).toContain(
      "waitlist only",
    );

    fireEvent.click(dayButton(1, ARRIVE.day));

    // The SAME date, same occupancy, different role — and the role is what the
    // label and the disabled state now come from.
    await waitFor(() =>
      expect(dayButton(1, FULL_DAY.day).getAttribute("aria-label")).toContain(
        "selectable as your check-out morning",
      ),
    );
    expect(dayButton(1, FULL_DAY.day).hasAttribute("disabled")).toBe(false);
    expect(dayButton(1, FULL_DAY.day).getAttribute("aria-label")).not.toContain(
      "waitlist only",
    );
  });

  it("completes a stay that departs on a full morning", async () => {
    const onDateSelect = vi.fn();
    render(<BookingCalendar onDateSelect={onDateSelect} />);
    await goForwardMonths(1);

    await waitFor(() => expect(dayButton(1, ARRIVE.day)).toBeTruthy());
    fireEvent.click(dayButton(1, ARRIVE.day));
    fireEvent.click(dayButton(1, FULL_DAY.day));

    // The stay the old grid could not express at all: the checkout day was
    // hard-disabled because its own night was full.
    expect(onDateSelect).toHaveBeenCalledWith(ARRIVE.iso, FULL_DAY.iso);
  });
});

describe("availability state: months accumulate and missing is not zero (#2930)", () => {
  it("keeps the first month's nights after paging to the second", async () => {
    const secondMonthDay = monthAfterNextDay(5);
    const fetchMock = vi.fn(async (url: string) => {
      const month = new URL(url, "http://localhost").searchParams.get("month");
      // Each month answers ONLY with its own nights, which is what a real month
      // endpoint does — and is exactly why replacing the map lost the other one.
      const isSecond = month === String((now.getMonth() + 2) % 12);
      return {
        ok: true,
        json: async () => ({
          lodgeCapacity: CAPACITY,
          availability: isSecond
            ? { [secondMonthDay.iso]: 1 }
            : { [ARRIVE.iso]: 2 },
          seasons: {},
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<BookingCalendar onDateSelect={() => {}} />);
    await goForwardMonths(1);
    await waitFor(() =>
      expect(dayButton(1, ARRIVE.day).getAttribute("aria-label")).toContain(
        `${CAPACITY - 2} of ${CAPACITY} beds free`,
      ),
    );

    // Forward one more month (the helper counts from the opening month, so the
    // second hop is an explicit click plus its own heading wait).
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => expect(screen.getByText(monthHeading(2))).toBeTruthy());
    await waitFor(() =>
      expect(dayButton(2, secondMonthDay.day).getAttribute("aria-label")).toContain(
        `${CAPACITY - 1} of ${CAPACITY} beds free`,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /Prev/ }));

    // The first month's figure is there IMMEDIATELY, from retained state, rather
    // than the grid briefly claiming an empty lodge while the refetch lands.
    expect(dayButton(1, ARRIVE.day).getAttribute("aria-label")).toContain(
      `${CAPACITY - 2} of ${CAPACITY} beds free`,
    );
  });

  it("renders an unloaded night as unknown, never as a completely free lodge", async () => {
    // The response fails. Every night of the month is therefore unknown.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));

    render(<BookingCalendar onDateSelect={() => {}} />);
    await goForwardMonths(1);

    await waitFor(() => {
      const label = dayButton(1, ARRIVE.day).getAttribute("aria-label") ?? "";
      expect(label).toContain("availability not loaded");
      // The defect in one assertion: `availability[date] ?? 0` used to make this
      // read "20 of 20 beds free" on a lodge nobody had counted.
      expect(label).not.toContain("beds free");
    });
  });

  it("renders a night MISSING from an otherwise-loaded month as unknown, not as empty", async () => {
    /*
      The sharper half of the same rule, and the one a failed-fetch test cannot
      reach. Here the month DID load and the capacity IS known, so the
      denominator is fine — but one night is absent from the map. Reading that
      absence as zero occupancy invents a completely empty lodge on a night
      nobody counted, and it does so with full confidence: the cell renders the
      success token and "20 of 20 beds free".

      Mutation-verified: flipping the reader back to `?? 0` fails only THIS
      assertion. The failed-fetch case above passes either way, because there the
      capacity is unknown too and the null arrives by the other route.
    */
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          lodgeCapacity: CAPACITY,
          // ARRIVE is counted. The day after it is simply not in the payload.
          availability: { [ARRIVE.iso]: 2 },
          seasons: {},
        }),
      })),
    );

    render(<BookingCalendar onDateSelect={() => {}} />);
    await goForwardMonths(1);

    await waitFor(() =>
      expect(dayButton(1, ARRIVE.day).getAttribute("aria-label")).toContain(
        `${CAPACITY - 2} of ${CAPACITY} beds free`,
      ),
    );

    const missing = dayButton(1, ARRIVE.day + 1).getAttribute("aria-label") ?? "";
    expect(missing).toContain("availability not loaded");
    expect(missing).not.toContain("beds free");
  });

  it("uses the SELECTED lodge's capacity as the denominator", async () => {
    // A capped second lodge: 8 beds, not the club-identity 20 this grid used to
    // divide by (`INV-CAP-001`).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          lodgeCapacity: 8,
          availability: { [ARRIVE.iso]: 6 },
          seasons: {},
        }),
      })),
    );

    render(<BookingCalendar onDateSelect={() => {}} lodgeId="lodge-b" />);
    await goForwardMonths(1);

    await waitFor(() =>
      // 2 of 8, not 14 of 20.
      expect(dayButton(1, ARRIVE.day).getAttribute("aria-label")).toContain(
        "2 of 8 beds free",
      ),
    );
  });
});


describe("what is on screen belongs to the lodge on screen (#2930 fix round)", () => {
  it("discards the previous lodge's numbers when the new lodge's fetch is REFUSED", async () => {
    /*
      A member who is not eligible to book a lodge gets a refusal on every month,
      so the "different lodge -> discard" branch inside the response handler
      never runs. The grid went on rendering lodge A's free-bed counts, heat
      colours and full/not-full decisions over lodge B's dates — and a night HELD
      at lodge B could therefore be drawn as free, which is the one thing the
      hold rules exist to prevent.

      Mutation-verified: deleting the synchronous reset makes this test read
      "18 of 20 beds free" for lodge-b.
    */
    const fetchMock = vi.fn(async (url: string) => {
      const lodge = new URL(url, "http://localhost").searchParams.get("lodgeId");
      if (lodge === "lodge-b") {
        // Refused: not eligible. No response body ever arrives.
        return { ok: false, json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({
          lodgeCapacity: CAPACITY,
          availability: { [ARRIVE.iso]: 2 },
          seasons: {},
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <BookingCalendar onDateSelect={() => {}} lodgeId="lodge-a" />,
    );
    await goForwardMonths(1);
    await waitFor(() =>
      expect(dayButton(1, ARRIVE.day).getAttribute("aria-label")).toContain(
        `${CAPACITY - 2} of ${CAPACITY} beds free`,
      ),
    );

    rerender(<BookingCalendar onDateSelect={() => {}} lodgeId="lodge-b" />);

    await waitFor(() => {
      const label = dayButton(1, ARRIVE.day).getAttribute("aria-label") ?? "";
      expect(label).toContain("availability not loaded");
      expect(label).not.toContain("beds free");
    });
  });

  it("drops a season label the month no longer carries", async () => {
    /*
      Season labels are SPARSE — only a day inside a season gets a key — so
      merging each month's answer over the accumulated map could add a label but
      never remove one. A season deactivated or re-dated by an officer kept
      showing on the member's grid until the lodge changed. The nights do not
      have this problem: the month endpoint returns a key for every night, so a
      merge overwrites all of them.
    */
    let seasonActive = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          lodgeCapacity: CAPACITY,
          availability: { [ARRIVE.iso]: 2 },
          seasons: seasonActive
            ? { [ARRIVE.iso]: { name: "Winter", type: "WINTER" } }
            : {},
        }),
      })),
    );

    render(<BookingCalendar onDateSelect={() => {}} />);
    await goForwardMonths(1);
    await waitFor(() =>
      expect(dayButton(1, ARRIVE.day).getAttribute("aria-label")).toContain(
        "Winter season",
      ),
    );

    // The officer deactivates it, and the member pages away and back.
    seasonActive = false;
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => expect(screen.getByText(monthHeading(2))).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Prev/ }));
    await waitFor(() => expect(screen.getByText(monthHeading(1))).toBeTruthy());

    await waitFor(() =>
      expect(dayButton(1, ARRIVE.day).getAttribute("aria-label")).not.toContain(
        "Winter season",
      ),
    );
    // And the night itself is still loaded: evicting a stale label must not
    // evict the occupancy the same response carried.
    expect(dayButton(1, ARRIVE.day).getAttribute("aria-label")).toContain(
      `${CAPACITY - 2} of ${CAPACITY} beds free`,
    );
  });
});
