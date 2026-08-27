// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type {
  DisplayState,
  DisplayStateBooking,
  DisplayStateGuest,
} from "@/lib/lodge-display-state";
import {
  ArrivalsBoard,
  barNames,
  computeBarLayout,
  computeBarSegments,
} from "@/components/lodge-display/modules/arrivals-board";
import { OccupancyGrid } from "@/components/lodge-display/modules/occupancy-grid";
import { SinglesBoard } from "@/components/lodge-display/modules/singles-board";
import { WelcomePanel } from "@/components/lodge-display/modules/welcome-panel";
import { DISPLAY_MODULE_COMPONENTS } from "@/components/lodge-display/modules";
import {
  intOption,
  NIGHT_COLUMNS_DEFAULT_DAYS,
  NIGHT_COLUMNS_MAX_DAYS,
} from "@/components/lodge-display/modules/module-options";

// Issue #30 (LTV-005): the booking/occupancy display modules — pure functions
// of the privacy-reduced DisplayState. Fixtures mirror the payload the
// serialiser emits; no module ever queries anything.

const WINDOW = ["2026-04-13", "2026-04-14", "2026-04-15"];

/** Expand a half-open envelope into night keys — the payload's own rule. */
function envelopeNights(stayStart: string, stayEnd: string): string[] {
  const nights: string[] = [];
  for (let key = stayStart; key < stayEnd; ) {
    nights.push(key);
    const next = new Date(`${key}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    key = next.toISOString().slice(0, 10);
  }
  return nights;
}

/**
 * A fixture row or guest may leave `nights` out, and gets the expanded envelope
 * (#2735).
 *
 * `nights` is REQUIRED on the real payload, and for every CONTIGUOUS stay the
 * serialiser emits exactly the expanded envelope — so a fixture that says
 * nothing about nights is handed the payload it would really receive, and the
 * cases below assert the same bars they always did. A case about a stay with a
 * GAP in it states `nights` explicitly, which is the only way to express one.
 */
type GuestFixture = Omit<DisplayStateGuest, "nights"> & { nights?: string[] };
type RowFixture = Partial<Omit<DisplayStateBooking, "guests">> & {
  guests?: GuestFixture[] | null;
};

function row(overrides: RowFixture): DisplayStateBooking {
  const merged = {
    key: "row-1-0",
    label: "Olive O",
    wholeLodge: false,
    roomId: null,
    guests: [
      { label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-15" },
    ] as GuestFixture[] | null,
    guestCount: 1,
    stayStart: "2026-04-13",
    stayEnd: "2026-04-15",
    // #2621: no expected arrival time is the ordinary case, so the base fixture
    // has none; the cases that exercise the chip set it explicitly.
    arrivalTime: null,
    ...overrides,
  };
  return {
    ...merged,
    guests:
      merged.guests?.map((guest) => ({
        ...guest,
        nights: guest.nights ?? envelopeNights(guest.stayStart, guest.stayEnd),
      })) ?? null,
    nights:
      overrides.nights ?? envelopeNights(merged.stayStart, merged.stayEnd),
  };
}

function state(overrides: Partial<DisplayState>): DisplayState {
  return {
    lodge: { name: "Silverpeak Lodge" },
    club: { name: "Alpine Sports Club", logoUrl: null, logoDataUrl: null },
    generatedAt: "2026-04-13T00:00:00.000Z",
    window: { start: "2026-04-13", days: 3 },
    rooms: null,
    bookings: [],
    occupancy: WINDOW.map((date) => ({
      date,
      arriving: 0,
      departing: 0,
      staying: 0,
    })),
    chores: [],
    rules: null,
    notice: null,
    config: {},
    capabilities: { bedAllocation: false, chores: false },
    // #2286: no custodian in residence in the base fixture.
    custodian: null,
    ...overrides,
  };
}

describe("bar layout maths (clipping regression surface)", () => {
  // stayEnd is the CHECK-OUT date (issue #56): a bar occupies nights
  // stayStart .. stayEnd-1, matching the approved mock.
  it("places an in-window stay on its nights only (checkout morning excluded)", () => {
    expect(
      computeBarLayout({ stayStart: "2026-04-14", stayEnd: "2026-04-15" }, WINDOW)
    ).toEqual({
      startColumn: 2,
      spanColumns: 1,
      startsBeforeWindow: false,
      endsAfterWindow: false,
      departing: false,
    });
  });

  it("clamps stays that started earlier or run past the window, and flags them", () => {
    expect(
      computeBarLayout({ stayStart: "2026-04-10", stayEnd: "2026-04-20" }, WINDOW)
    ).toEqual({
      startColumn: 1,
      spanColumns: 3,
      startsBeforeWindow: true,
      endsAfterWindow: true,
      departing: false,
    });
  });

  it("marks a stay whose last night is tonight as departing (amber treatment)", () => {
    expect(
      computeBarLayout({ stayStart: "2026-04-10", stayEnd: "2026-04-14" }, WINDOW)
    ).toEqual({
      startColumn: 1,
      spanColumns: 1,
      startsBeforeWindow: true,
      endsAfterWindow: false,
      departing: true,
    });
  });

  it("does NOT mark a same-day arrival leaving tomorrow as departing (mock Kea stays green)", () => {
    const layout = computeBarLayout(
      { stayStart: "2026-04-13", stayEnd: "2026-04-14" },
      WINDOW
    );
    expect(layout).toMatchObject({ spanColumns: 1, departing: false });
  });

  it("returns null when there are no nights in the window", () => {
    // Entirely after the window.
    expect(
      computeBarLayout({ stayStart: "2026-05-01", stayEnd: "2026-05-03" }, WINDOW)
    ).toBeNull();

    // Checks out on the window's first morning — no night tonight.
    expect(
      computeBarLayout({ stayStart: "2026-04-10", stayEnd: "2026-04-13" }, WINDOW)
    ).toBeNull();
  });
});

describe("bar segments: a stay with a gap draws as two bars (#2735)", () => {
  it("splits the row's nights into contiguous runs, each with its own check-out", () => {
    // In on the 13th, home on the 14th, back on the 15th. One unbroken bar
    // across all three columns claimed a bed on a night nobody booked, and
    // labelled the whole thing with the LAST check-out.
    const segments = computeBarSegments(
      {
        stayStart: "2026-04-13",
        stayEnd: "2026-04-16",
        nights: ["2026-04-13", "2026-04-15"],
      },
      WINDOW
    );
    expect(segments).toEqual([
      {
        stayStart: "2026-04-13",
        stayEnd: "2026-04-14",
        startColumn: 1,
        spanColumns: 1,
        startsBeforeWindow: false,
        endsAfterWindow: false,
        departing: false,
      },
      {
        stayStart: "2026-04-15",
        stayEnd: "2026-04-16",
        startColumn: 3,
        spanColumns: 1,
        startsBeforeWindow: false,
        endsAfterWindow: true,
        departing: false,
      },
    ]);
  });

  it("is one bar, identical to the envelope, for a contiguous stay", () => {
    const envelope = { stayStart: "2026-04-13", stayEnd: "2026-04-15" };
    expect(
      computeBarSegments(
        { ...envelope, nights: ["2026-04-13", "2026-04-14"] },
        WINDOW
      )
    ).toEqual([{ ...envelope, ...computeBarLayout(envelope, WINDOW) }]);
  });

  it("drops a run with no night in the window, and keeps the ones that have", () => {
    // Nights on the 10th (before the window) and the 14th.
    const segments = computeBarSegments(
      {
        stayStart: "2026-04-10",
        stayEnd: "2026-04-15",
        nights: ["2026-04-10", "2026-04-14"],
      },
      WINDOW
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      stayStart: "2026-04-14",
      stayEnd: "2026-04-15",
      startColumn: 2,
      spanColumns: 1,
      startsBeforeWindow: false,
    });
  });

  it("draws nothing for a row with no nights (INV-DATE-008)", () => {
    expect(
      computeBarSegments(
        { stayStart: "2026-04-13", stayEnd: "2026-04-13", nights: [] },
        WINDOW
      )
    ).toEqual([]);
  });

  it("falls back to the envelope when a caller passes no nights at all", () => {
    // The direct-unit-test branch. Every row the serialiser emits carries its
    // nights, so this shape does not occur on the wall.
    expect(
      computeBarSegments({ stayStart: "2026-04-14", stayEnd: "2026-04-15" }, WINDOW)
    ).toEqual([
      {
        stayStart: "2026-04-14",
        stayEnd: "2026-04-15",
        startColumn: 2,
        spanColumns: 1,
        startsBeforeWindow: false,
        endsAfterWindow: false,
        departing: false,
      },
    ]);
  });
});

describe("bar names overflow (AC2)", () => {
  it("shows up to the max then an explicit +N", () => {
    const guests = ["A", "B", "C", "D", "E", "F", "G"].map((n) => ({
      label: `${n} X`,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-14",
    }));
    const result = barNames(row({ guests, guestCount: 7 }), 5);
    expect(result.names).toHaveLength(5);
    expect(result.overflow).toBe(2);
  });

  it("falls back to the booking label when names are withheld", () => {
    const result = barNames(row({ guests: null, label: "Harakeke College", guestCount: 14 }), 5);
    expect(result.names).toEqual(["Harakeke College"]);
    expect(result.overflow).toBe(0);
  });

  it("lead-count style (A2) shows only the lead name + everyone else as +N", () => {
    const guests = ["A", "B", "C", "D", "E", "F", "G"].map((n) => ({
      label: `${n} X`,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-14",
    }));
    const result = barNames(row({ guests, guestCount: 7 }), 5, true);
    expect(result.names).toEqual(["A X"]);
    expect(result.overflow).toBe(6);
  });

  it("names only the guests in the bar's own run of nights (#2735)", () => {
    // One booking, one room, two people who are never here at the same time.
    // The row's night union is {13, 15}, so it draws two bars — and each bar
    // now carries its own check-out, so naming the whole row on both would
    // attach "out Tue 14" to someone whose bed is on the 15th.
    const split = row({
      guests: [
        { label: "Ari A", stayStart: "2026-04-13", stayEnd: "2026-04-14", nights: ["2026-04-13"] },
        { label: "Bex B", stayStart: "2026-04-15", stayEnd: "2026-04-16", nights: ["2026-04-15"] },
      ],
      guestCount: 2,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-16",
      nights: ["2026-04-13", "2026-04-15"],
    });
    expect(barNames(split, 5, false, { stayStart: "2026-04-13", stayEnd: "2026-04-14" }).names)
      .toEqual(["Ari A"]);
    expect(barNames(split, 5, false, { stayStart: "2026-04-15", stayEnd: "2026-04-16" }).names)
      .toEqual(["Bex B"]);
    // No segment given → the whole row, exactly as before.
    expect(barNames(split, 5).names).toEqual(["Ari A", "Bex B"]);
  });

  it("ArrivalsBoard labels each bar of a split row with only that run's people (#2735)", () => {
    const split = row({
      guests: [
        { label: "Ari A", stayStart: "2026-04-13", stayEnd: "2026-04-14", nights: ["2026-04-13"] },
        { label: "Bex B", stayStart: "2026-04-15", stayEnd: "2026-04-16", nights: ["2026-04-15"] },
      ],
      guestCount: 2,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-16",
      nights: ["2026-04-13", "2026-04-15"],
    });
    const { container } = render(<ArrivalsBoard state={state({ bookings: [split] })} />);
    const bars = Array.from(container.querySelectorAll(".display-bar")) as HTMLElement[];
    expect(bars).toHaveLength(2);
    expect(bars[0].querySelector(".display-bar-names")?.textContent).toBe("Ari A");
    expect(bars[1].querySelector(".display-bar-names")?.textContent).toBe("Bex B");
  });
});

describe("ArrivalsBoard name-style option (A2)", () => {
  it("renders the lead name + count when name-style=lead-count", () => {
    const guests = ["Alex B", "Sam R", "Jo K"].map((label) => ({
      label,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-16",
    }));
    render(
      <ArrivalsBoard
        state={state({ bookings: [row({ guests, guestCount: 3 })] })}
        options={{ "name-style": "lead-count" }}
      />
    );
    expect(screen.getByText("Alex B")).toBeDefined();
    expect(screen.getByText("+2")).toBeDefined();
    expect(screen.queryByText("Sam R")).toBeNull();
  });

  it("falls back to full names on an unknown name-style (AC6)", () => {
    const guests = ["Alex B", "Sam R"].map((label) => ({
      label,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-16",
    }));
    render(
      <ArrivalsBoard
        state={state({ bookings: [row({ guests, guestCount: 2 })] })}
        options={{ "name-style": "banana" }}
      />
    );
    expect(screen.getByText("Alex B, Sam R")).toBeDefined();
  });
});

describe("ArrivalsBoard", () => {
  it("renders room rows when allocation is on, including an Unassigned lane", () => {
    render(
      <ArrivalsBoard
        state={state({
          rooms: [
            { id: "r1", name: "Kea" },
            { id: "r2", name: "Tui" },
          ],
          bookings: [
            row({ key: "a", roomId: "r1" }),
            row({ key: "b", roomId: null, label: "Rewi P" }),
          ],
        })}
      />
    );
    expect(screen.getByText("Kea")).toBeDefined();
    expect(screen.getByText("Unassigned")).toBeDefined();
    expect(screen.queryByText("Tui")).toBeDefined(); // empty room still shows its lane
  });

  it("renders overflow with an explicit +N and never throws on bad options (AC6)", () => {
    const guests = ["A", "B", "C", "D", "E", "F"].map((n) => ({
      label: `${n} X`,
      stayStart: "2026-04-13",
      stayEnd: "2026-04-14",
    }));
    render(
      <ArrivalsBoard
        state={state({ bookings: [row({ guests, guestCount: 6 })] })}
        options={{ days: "banana", "max-names": -3 }}
      />
    );
    // max-names clamps to 1 → 5 overflow
    expect(screen.getByText("+5")).toBeDefined();
  });

  // #2621: the expected arrival time chip. `lodge-display-state` makes the same
  // privacy decision upstream, but this module does NOT rely on that: the
  // name-suppression case below hands it a payload with a time on a
  // name-withheld row — the shape a mistake upstream, a hand-built payload or a
  // future caller would produce — and requires the module to refuse it anyway.
  // What is tested besides that is that the module prints what it is given, in
  // the 12-hour form the kiosk and the booking page use, and stays quiet
  // otherwise.
  it("shows the expected arrival time on a bar that starts inside the window", () => {
    const { container } = render(
      <ArrivalsBoard
        state={state({
          bookings: [row({ key: "a", arrivalTime: "17:30" })],
        })}
      />
    );
    expect(screen.getByText("arr 5:30 PM")).toBeDefined();
    expect(container.querySelector(".display-bar-arrival")).not.toBeNull();
  });

  it("shows nothing when the row carries no time — the ordinary case", () => {
    const { container } = render(
      <ArrivalsBoard
        state={state({ bookings: [row({ key: "a", arrivalTime: null })] })}
      />
    );
    expect(container.querySelector(".display-bar-arrival")).toBeNull();
    expect(screen.queryByText(/^arr /)).toBeNull();
  });

  it("shows no time on a bar clipped at the left edge — the arrival day is off the board", () => {
    // The module can be configured to show fewer days than the state window, so
    // it guards this itself rather than trusting the payload alone. A time with
    // no visible arrival day beside it reads as tonight.
    const { container } = render(
      <ArrivalsBoard
        state={state({
          bookings: [
            row({
              key: "a",
              stayStart: "2026-04-11",
              stayEnd: "2026-04-15",
              arrivalTime: "17:30",
            }),
          ],
        })}
      />
    );
    expect(container.querySelector(".display-bar-arrival")).toBeNull();
  });

  it("PRIVACY: never shows a time on a row whose names are withheld, even when the payload carries one", () => {
    // The guard that matters, exercised against the payload it is meant to
    // survive. `guests: null` is what the wall serialiser produces for a row it
    // may not name; such a row renders "label · count" instead of names, and a
    // movement time beside that is the same disclosure the label exists to
    // avoid. Both name-withheld shapes are covered: a whole-lodge blockout and
    // an ordinary grouped row (a party containing a minor, or COUNTS_ONLY).
    //
    // The time is handed in DELIBERATELY. An earlier version of this test passed
    // `arrivalTime: null` and so asserted nothing whatsoever — the module could
    // have printed every suppressed row's time and stayed green.
    const { container } = render(
      <ArrivalsBoard
        state={state({
          bookings: [
            row({
              key: "a",
              wholeLodge: true,
              label: "Harakeke College",
              guests: null,
              guestCount: 14,
              arrivalTime: "17:30",
            }),
            row({
              key: "b",
              wholeLodge: false,
              label: "Smith family",
              guests: null,
              guestCount: 4,
              arrivalTime: "09:00",
            }),
          ],
        })}
      />
    );
    expect(container.querySelector(".display-bar-arrival")).toBeNull();
    expect(screen.queryByText(/^arr /)).toBeNull();
    expect(container.textContent).not.toContain("5:30 PM");
    expect(container.textContent).not.toContain("9:00 AM");
    // The rows themselves did render — otherwise this would pass for the wrong
    // reason.
    expect(screen.getByText("Harakeke College · 14")).toBeDefined();
    expect(screen.getByText("Smith family · 4")).toBeDefined();
  });

  it("draws a stay with a gap as two bars, each labelled with its own check-out (#2735)", () => {
    const { container } = render(
      <ArrivalsBoard
        state={state({
          bookings: [
            row({
              key: "gap",
              guests: [
                {
                  label: "Gappy G",
                  stayStart: "2026-04-13",
                  stayEnd: "2026-04-16",
                  nights: ["2026-04-13", "2026-04-15"],
                },
              ],
              stayStart: "2026-04-13",
              stayEnd: "2026-04-16",
              nights: ["2026-04-13", "2026-04-15"],
            }),
          ],
        })}
      />
    );
    const bars = Array.from(container.querySelectorAll(".display-bar"));
    expect(bars).toHaveLength(2);
    // Column 1 (the 13th) and column 3 (the 15th) — column 2 stays empty.
    expect(bars.map((bar) => (bar as HTMLElement).style.gridColumnStart)).toEqual([
      "1",
      "3",
    ]);
    // Each bar names the day IT ends, not the row's overall check-out.
    expect(screen.getByText("out Tue 14")).toBeDefined();
    expect(screen.getByText("out Thu 16 →")).toBeDefined();
  });

  it("prints the expected arrival time on the FIRST bar only (#2735)", () => {
    // There is one stored arrival time per booking and it describes the
    // check-in. Repeating it on the bar for the night the party comes back
    // would announce a time nobody stored.
    const { container } = render(
      <ArrivalsBoard
        state={state({
          bookings: [
            row({
              key: "gap",
              arrivalTime: "17:30",
              guests: [
                {
                  label: "Gappy G",
                  stayStart: "2026-04-13",
                  stayEnd: "2026-04-16",
                  nights: ["2026-04-13", "2026-04-15"],
                },
              ],
              stayStart: "2026-04-13",
              stayEnd: "2026-04-16",
              nights: ["2026-04-13", "2026-04-15"],
            }),
          ],
        })}
      />
    );
    expect(container.querySelectorAll(".display-bar")).toHaveLength(2);
    expect(container.querySelectorAll(".display-bar-arrival")).toHaveLength(1);
    expect(screen.getByText("arr 5:30 PM")).toBeDefined();
  });
});

describe("OccupancyGrid / WelcomePanel (whole-lodge treatment, AC3/AC5)", () => {
  const blockoutState = state({
    bookings: [
      row({
        wholeLodge: true,
        label: "Harakeke College",
        guests: null,
        guestCount: 14,
        stayEnd: "2026-04-15",
      }),
    ],
  });

  it("blockout shows the group label only — no individual names exist to leak", () => {
    const { container } = render(<OccupancyGrid state={blockoutState} />);
    expect(screen.getByText("Harakeke College")).toBeDefined();
    expect(container.textContent).toContain("14 guests");
  });

  it("welcome renders with zero options and greets the group when present", () => {
    render(<WelcomePanel state={blockoutState} />);
    expect(screen.getByText(/Welcome to Silverpeak Lodge/)).toBeDefined();
    expect(screen.getByText("Harakeke College")).toBeDefined();
  });

  it("welcome shows the mock's info tiles for the group (issue #58)", () => {
    const { container } = render(
      <WelcomePanel
        state={{
          ...blockoutState,
          config: { "whole-lodge-note": "See your group leader" },
        }}
      />
    );
    expect(screen.getByText("Group")).toBeDefined();
    expect(screen.getByText("Staying")).toBeDefined();
    expect(screen.getByText("See your group leader")).toBeDefined();
    expect(container.querySelectorAll(".display-welcome-tile").length).toBe(3);
  });

  it("statement variant (no rooms) renders the block statement with a week strip (issue #58)", () => {
    const { container } = render(<OccupancyGrid state={blockoutState} />);
    expect(screen.getByText("The lodge is fully booked")).toBeDefined();
    expect(container.querySelectorAll(".display-week-day").length).toBe(3);
  });

  it("prints each variant's own date SHAPE, not merely a date (CT-2, #2990)", () => {
    /*
      The two blockout variants deliberately use different house shapes: the
      wall-sized statement spells the day out ("Monday, 13 April") and the board
      strip abbreviates it ("Mon, 13 Apr"), and both drop the YEAR because a
      lobby screen only ever names days inside the current stay window.

      Nothing asserted WHICH shape each one picked. Swapping
      `formatClubWeekdayDayMonth` for `formatClubWeekdayDate` in
      `occupancy-grid.tsx` — a year back on the wall, on every blockout — left
      the whole suite green. The wiring is byte-correct today; this is what keeps
      it that way, and it is also the only place the kernel's two year-less
      shapes are exercised through a real render.
    */
    const statement = render(<OccupancyGrid state={blockoutState} />);
    expect(statement.container.textContent).toContain(
      "Monday, 13 April → Wednesday, 15 April",
    );
    expect(statement.container.textContent).not.toContain("2026");
    statement.unmount();

    const board = render(
      <OccupancyGrid
        state={state({
          rooms: [
            { id: "room-1", name: "A - Kea" },
            { id: "room-2", name: "B - Tui" },
          ],
          bookings: [
            row({
              wholeLodge: true,
              label: "Harakeke College",
              guests: null,
              guestCount: 14,
              stayEnd: "2026-04-15",
            }),
          ],
        })}
      />,
    );
    expect(board.container.textContent).toContain(
      "Mon, 13 Apr → Wed, 15 Apr · reopens Wed",
    );
    expect(board.container.textContent).not.toContain("2026");
  });

  it("variant=statement forces the summary + week strip even when rooms exist (B1b)", () => {
    const withRooms = state({
      rooms: [
        { id: "room-1", name: "A - Kea" },
        { id: "room-2", name: "B - Tui" },
      ],
      bookings: [
        row({
          wholeLodge: true,
          label: "Harakeke College",
          guests: null,
          guestCount: 14,
          stayEnd: "2026-04-15",
        }),
      ],
    });
    const { container } = render(
      <OccupancyGrid state={withRooms} options={{ variant: "statement" }} />
    );
    // Forced statement look, not the room-grid board, despite rooms being set.
    expect(screen.getByText("The lodge is fully booked")).toBeDefined();
    expect(container.querySelectorAll(".display-week-day").length).toBe(3);
    expect(container.querySelector(".display-blockout-board")).toBeNull();
  });

  it("board variant blocks only the booked nights and keeps other bars (part-week, issue #58)", () => {
    const partWeek = state({
      rooms: [
        { id: "room-1", name: "A - Kea" },
        { id: "room-2", name: "B - Tui" },
      ],
      bookings: [
        row({
          key: "row-wl",
          wholeLodge: true,
          label: "Harakeke College",
          guests: null,
          guestCount: 42,
          roomId: null,
          stayStart: "2026-04-13",
          stayEnd: "2026-04-15", // nights 13+14; the 15th is free
        }),
        row({
          key: "row-jess",
          label: "Jess L",
          guests: [
            { label: "Jess L", stayStart: "2026-04-15", stayEnd: "2026-04-16" },
          ],
          guestCount: 1,
          roomId: "room-2",
          stayStart: "2026-04-15",
          stayEnd: "2026-04-16",
        }),
      ],
    });
    const { container } = render(<OccupancyGrid state={partWeek} />);
    const block = container.querySelector(".display-blockout-panel") as HTMLElement;
    expect(block).not.toBeNull();
    // Columns 2..3 (nights 13+14) — column 4 (the 15th) stays free.
    expect(block.style.gridColumnStart).toBe("2");
    expect(block.style.gridColumnEnd).toBe("span 2");
    expect(screen.getByText("Jess L")).toBeDefined();
    // The room with a live bar lights up; the held room stays dimmed.
    const rooms = container.querySelectorAll(".display-board-room");
    expect(rooms[1].hasAttribute("data-live")).toBe(true);
    expect(rooms[0].hasAttribute("data-live")).toBe(false);
  });

  // A whole-lodge row is NOT guaranteed contiguous. The explicit hold flag is,
  // but `wholeLodge` is also set by the sole-occupancy heuristic — sole on every
  // night the booking covers — which never looks at the nights in between. A
  // group alone on the 13th and the 15th but not the 14th satisfies it, and the
  // envelope spans all three days.
  const gappyBlockout = row({
    key: "row-wl-gap",
    wholeLodge: true,
    label: "Harakeke College",
    guests: null,
    guestCount: 14,
    roomId: null,
    stayStart: "2026-04-13",
    stayEnd: "2026-04-16",
    nights: ["2026-04-13", "2026-04-15"],
  });

  it("statement variant leaves a gapped hold's free night unblocked (#2735)", () => {
    const { container } = render(
      <OccupancyGrid state={state({ bookings: [gappyBlockout] })} />
    );
    const blocked = Array.from(
      container.querySelectorAll(".display-week-bar > span")
    ).map((bar) => bar.hasAttribute("data-blocked"));
    // The 14th is nobody's night — the strip must not paint "whole lodge
    // booked" over a day whose own count reads 0.
    expect(blocked).toEqual([true, false, true]);
  });

  it("board variant draws one block per run of a gapped hold, kicker on the first (#2735)", () => {
    const withRooms = state({
      rooms: [{ id: "room-1", name: "A - Kea" }],
      bookings: [gappyBlockout],
    });
    const { container } = render(<OccupancyGrid state={withRooms} />);
    const blocks = Array.from(
      container.querySelectorAll(".display-blockout-panel")
    ) as HTMLElement[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].style.gridColumnStart).toBe("2"); // the 13th
    expect(blocks[0].style.gridColumnEnd).toBe("span 1");
    expect(blocks[1].style.gridColumnStart).toBe("4"); // the 15th
    expect(blocks[1].style.gridColumnEnd).toBe("span 1");
    // One panel per blockout: the kicker, label, headcount and dates are
    // printed once, on the first block, and the resumption is bare.
    expect(container.querySelectorAll(".display-blockout-kicker")).toHaveLength(1);
    expect(blocks[1].textContent).toBe("");
    expect(blocks[1].getAttribute("data-continuation")).toBe("true");
  });

  it("welcome counts the nights a gapped hold really holds, not the envelope (#2735)", () => {
    const { container } = render(
      <WelcomePanel state={state({ bookings: [gappyBlockout] })} />
    );
    // 13 → 16 is a three-day envelope over two booked nights.
    expect(container.textContent).toContain("· 2 nights");
    expect(container.textContent).not.toContain("· 3 nights");
  });
});

describe("SinglesBoard (AC4)", () => {
  it("renders one row per guest with their own check-out when rooms is null", () => {
    render(
      <SinglesBoard
        state={state({
          bookings: [
            row({
              guests: [
                { label: "Jane S", stayStart: "2026-04-13", stayEnd: "2026-04-14" },
                { label: "Rewi P", stayStart: "2026-04-13", stayEnd: "2026-04-15" },
              ],
              guestCount: 2,
            }),
          ],
        })}
      />
    );
    expect(screen.getByText("Jane S")).toBeDefined();
    // Weekday out labels (issue #58) — each guest keeps their own check-out.
    expect(screen.getByText("out Tue 14")).toBeDefined();
    expect(screen.getByText("out Wed 15")).toBeDefined();
  });

  it("keeps reduced labels for counts-only rows", () => {
    render(
      <SinglesBoard
        state={state({
          bookings: [row({ guests: null, label: "Guests · 3", guestCount: 3 })],
        })}
      />
    );
    expect(screen.getByText(/Guests · 3/)).toBeDefined();
  });

  it("gives a guest with a gap in their stay two bars on their own row (#2735)", () => {
    const { container } = render(
      <SinglesBoard
        state={state({
          bookings: [
            row({
              guests: [
                {
                  label: "Gappy G",
                  stayStart: "2026-04-13",
                  stayEnd: "2026-04-16",
                  nights: ["2026-04-13", "2026-04-15"],
                },
                { label: "Rewi P", stayStart: "2026-04-13", stayEnd: "2026-04-15" },
              ],
              guestCount: 2,
              stayStart: "2026-04-13",
              stayEnd: "2026-04-16",
              nights: ["2026-04-13", "2026-04-14", "2026-04-15"],
            }),
          ],
        })}
      />
    );
    // Two bars for Gappy, one for Rewi — three in total, all on their own rows.
    const bars = Array.from(
      container.querySelectorAll(".display-singles-bar")
    ) as HTMLElement[];
    expect(bars).toHaveLength(3);
    // With no room axis the night columns start at 2 (column 1 is the guest
    // name), so the 13th is column 2 and the 15th is column 4 — the 14th is
    // left empty between them.
    const gappyBars = bars.filter((bar) => bar.style.gridRow === "2");
    expect(gappyBars.map((bar) => bar.style.gridColumnStart)).toEqual(["2", "4"]);
  });
});

describe("module map and options (AC6/AC7)", () => {
  it("maps this task's four registry names to components (later tasks add theirs)", () => {
    const keys = Object.keys(DISPLAY_MODULE_COMPONENTS);
    for (const name of ["arrivals-board", "occupancy-grid", "singles-board", "welcome"]) {
      expect(keys).toContain(name);
    }
  });

  it("intOption clamps and falls back per documented defaults", () => {
    expect(intOption(undefined, "days", 3, { min: 1, max: 7 })).toBe(3);
    expect(intOption({ days: "4" }, "days", 3, { min: 1, max: 7 })).toBe(4);
    expect(intOption({ days: 99 }, "days", 3, { min: 1, max: 7 })).toBe(7);
    expect(intOption({ days: "banana" }, "days", 3, { min: 1, max: 7 })).toBe(3);
  });

  it("night-columns is a permanent 3-night board (matches the fixed device window, #2056)", () => {
    // Option C: the board ceiling matches the 3-day display-device data window,
    // so a template promising more nights honestly renders three, never more.
    expect(NIGHT_COLUMNS_DEFAULT_DAYS).toBe(3);
    expect(NIGHT_COLUMNS_MAX_DAYS).toBe(3);
    const bounds = { min: 1, max: NIGHT_COLUMNS_MAX_DAYS };
    expect(intOption({ days: 7 }, "days", NIGHT_COLUMNS_DEFAULT_DAYS, bounds)).toBe(3);
    expect(intOption({ days: "5" }, "days", NIGHT_COLUMNS_DEFAULT_DAYS, bounds)).toBe(3);
    expect(intOption({ days: 2 }, "days", NIGHT_COLUMNS_DEFAULT_DAYS, bounds)).toBe(2);
  });
});
