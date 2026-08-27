import type { CSSProperties } from "react";
import type {
  DisplayState,
  DisplayStateBooking,
} from "@/lib/lodge-display-state";
import {
  ARRIVALS_BOARD_DEFAULT_DAYS,
  ARRIVALS_BOARD_MAX_NAMES,
  ARRIVALS_BOARD_NAME_STYLES,
  enumOption,
  intOption,
  type DisplayPanelOptions,
} from "./module-options";
import { displayWeekday, shiftDateOnly, shortDay } from "./status-helpers";
import { formatArrivalTime } from "@/lib/arrival-time";

// The everyday bar board (fork issues #30/#56; visual reference:
// docs/lobby-display/mockups/everyday-bar-board.html). Pure function of the
// privacy-reduced DisplayState payload: room rows (or per-booking rows when
// allocation is off), one bar per CONTIGUOUS RUN of the nights a booking row
// covers (the check-out morning is not a night — the mock's bars end the
// night before), up to N names then "+N", a weekday check-out label on each
// bar. Styling attaches via the display stylesheet through the display-*
// class hooks.
//
// A stay with a gap in it — in on Friday, home on Saturday, back on Monday —
// draws as TWO bars with the empty night between them (#2735). It used to draw
// as one unbroken bar, which claimed the guest was in a bed on a night nobody
// had booked.

export interface BarLayout {
  startColumn: number; // 1-based grid column within the visible window
  spanColumns: number;
  startsBeforeWindow: boolean;
  endsAfterWindow: boolean;
  /** The bar's real last night is the window's first day (mock "dep"). */
  departing: boolean;
}

/** One drawn bar: its placement plus the run of nights it was drawn from. */
export interface BarSegment extends BarLayout {
  /** This segment's own first night. */
  stayStart: string;
  /** This segment's own check-out morning — the day after its last night. */
  stayEnd: string;
}

function nextDateOnly(date: string): string {
  return shiftDateOnly(date, 1);
}

/**
 * Split sorted night keys into contiguous runs. `["10","12","13"]` → two runs.
 */
function contiguousNightRuns(nights: readonly string[]): string[][] {
  const sorted = [...nights].sort();
  const runs: string[][] = [];
  for (const night of sorted) {
    const current = runs[runs.length - 1];
    if (current && shiftDateOnly(current[current.length - 1], 1) === night) {
      current.push(night);
    } else if (!current || current[current.length - 1] !== night) {
      runs.push([night]);
    }
  }
  return runs;
}

/**
 * Every bar to draw for one row: one per contiguous run of its nights, each
 * clipped to the visible window and dropped when it has no night inside it.
 *
 * `nights` is the authoritative per-night presence the payload carries (#2735).
 * An EMPTY `nights` draws nothing — a booking with no nights is present on no
 * day (INV-DATE-008). An ABSENT `nights` falls back to the row's half-open
 * envelope, which is the single bar this drew before and is identical to the
 * night set for every contiguous stay; that branch exists for direct unit tests
 * of the maths, since every row the serialiser emits carries its nights.
 */
export function computeBarSegments(
  row: { stayStart: string; stayEnd: string; nights?: readonly string[] },
  windowDates: string[]
): BarSegment[] {
  const ranges = row.nights
    ? contiguousNightRuns(row.nights).map((run) => ({
        stayStart: run[0],
        stayEnd: nextDateOnly(run[run.length - 1]),
      }))
    : [{ stayStart: row.stayStart, stayEnd: row.stayEnd }];
  return ranges.flatMap((range) => {
    const layout = computeBarLayout(range, windowDates);
    return layout ? [{ ...layout, ...range }] : [];
  });
}

/**
 * Compute a bar's grid placement within the visible window. stayEnd is the
 * CHECK-OUT date, so the bar's last occupied night is stayEnd - 1 (issue #56
 * — bars span nights, matching the mock). Exported for direct unit testing —
 * the maths is where clipping bugs live.
 *
 * This places ONE contiguous run. Rows go through {@link computeBarSegments},
 * which is this function applied to each run of the row's nights.
 */
export function computeBarLayout(
  row: { stayStart: string; stayEnd: string },
  windowDates: string[]
): BarLayout | null {
  if (windowDates.length === 0) return null;
  const first = windowDates[0];
  const last = windowDates[windowDates.length - 1];
  // No nights in window: checked out on/before the first day, or arrives
  // after the last day.
  if (row.stayEnd <= first || row.stayStart > last) return null;

  const startIndex = windowDates.findIndex((date) => date >= row.stayStart);
  const clampedStart = startIndex === -1 ? 0 : startIndex;
  let endIndex = clampedStart;
  for (let i = windowDates.length - 1; i >= clampedStart; i--) {
    if (windowDates[i] < row.stayEnd) {
      endIndex = i;
      break;
    }
  }

  return {
    startColumn: clampedStart + 1,
    spanColumns: Math.max(1, endIndex - clampedStart + 1),
    startsBeforeWindow: row.stayStart < first,
    // Checkout after the last window date → the stay runs past the board
    // (mock "out Mon 6 →" on a Fri–Sun window).
    endsAfterWindow: row.stayEnd > last,
    // Amber "checking out" treatment: last night is tonight AND the stay
    // began before the window — a same-day arrival stays green (mock Kea).
    departing:
      row.stayEnd === nextDateOnly(first) && row.stayStart < first,
  };
}

/** "Jane S, Rewi P +2" — up to max names, then an explicit overflow count. When
 * `leadOnly` (name-style: lead-count, mock A2) only the first guest shows, with
 * everyone else folded into the +N overflow ("Jane S +2").
 *
 * `segment` (#2735) narrows the row to the people actually in a bed during that
 * run of nights. A row draws one bar per run, and each bar now carries that
 * run's own check-out — so naming the whole row on every bar would attach a
 * specific departure day to people who are not in that run at all. Omit it and
 * the whole row is named, which is the same answer whenever the row has one
 * segment. */
export function barNames(
  row: DisplayStateBooking,
  maxNames: number,
  leadOnly = false,
  segment?: { stayStart: string; stayEnd: string }
): { names: string[]; overflow: number } {
  if (!row.guests || row.guests.length === 0) {
    return { names: [row.label], overflow: 0 };
  }
  // A run of the row's nights is the union of its guests' nights, so at least
  // one guest is always in it; the `|| row.guests` is belt and braces for a
  // hand-built row whose guest nights do not add up to its own.
  const inSegment = segment
    ? row.guests.filter((guest) =>
        guest.nights.some(
          (night) => night >= segment.stayStart && night < segment.stayEnd
        )
      )
    : row.guests;
  const guests = inSegment.length > 0 ? inSegment : row.guests;
  if (leadOnly) {
    return {
      names: [guests[0].label],
      overflow: Math.max(0, guests.length - 1),
    };
  }
  const names = guests.slice(0, maxNames).map((guest) => guest.label);
  return { names, overflow: Math.max(0, guests.length - names.length) };
}

/**
 * The names printed on ONE bar — the shared label for both bar boards.
 *
 * A component rather than a call in the parent (#2735) because the names now
 * depend on the segment, so they have to be resolved per bar rather than once
 * per row, and this keeps that resolution in one place for the everyday board
 * and the blockout board alike.
 */
export function BarNamesLabel({
  row,
  maxNames,
  leadOnly = false,
  segment,
}: {
  row: DisplayStateBooking;
  maxNames: number;
  leadOnly?: boolean;
  segment: BarSegment;
}) {
  const { names, overflow } = barNames(row, maxNames, leadOnly, segment);
  return (
    <span className="display-bar-names">
      {row.guests === null ? `${row.label} · ${row.guestCount}` : names.join(", ")}
      {overflow > 0 && <span className="display-bar-overflow"> +{overflow}</span>}
    </span>
  );
}

export function windowDatesOf(state: DisplayState): string[] {
  return state.occupancy.map((day) => day.date);
}

function formatDayHeading(date: string, index: number): string {
  return index === 0 ? `Tonight · ${shortDay(date)}` : shortDay(date);
}

/**
 * "out Sun 12", "since Wed → out Sun 12", "out Tue 14 →".
 *
 * Reads the SEGMENT's own dates, not the row's (#2735): on a stay with a gap
 * each bar names the day that bar ends, so the first says "out Sat" and the
 * second says "out Tue". Labelling both with the row's overall check-out was
 * the visible half of showing a broken stay as one unbroken bar.
 */
export function barMeta(segment: BarSegment): string {
  const since = segment.startsBeforeWindow
    ? `since ${displayWeekday(segment.stayStart)} → `
    : "";
  return `${since}out ${shortDay(segment.stayEnd)}${segment.endsAfterWindow ? " →" : ""}`;
}

/** Split "A - Kea" / "B Tui" style names into a letter tag + display name. */
export function splitRoomName(name: string): { tag: string | null; label: string } {
  const match = /^([A-Za-z0-9]{1,3})\s*[-–·:]\s+(.+)$/.exec(name.trim());
  if (!match) return { tag: null, label: name };
  return { tag: match[1], label: match[2] };
}

export function ArrivalsBoard({
  state,
  options,
}: {
  state: DisplayState;
  options?: DisplayPanelOptions;
}) {
  const days = intOption(options, "days", ARRIVALS_BOARD_DEFAULT_DAYS, {
    min: 1,
    max: 7,
  });
  const maxNames = intOption(options, "max-names", ARRIVALS_BOARD_MAX_NAMES, {
    min: 1,
    max: 10,
  });
  const leadOnly =
    enumOption(options, "name-style", "names", ARRIVALS_BOARD_NAME_STYLES) ===
    "lead-count";
  const windowDates = windowDatesOf(state).slice(0, days);

  const rowGroups: Array<{ heading: string | null; rows: DisplayStateBooking[] }> =
    state.rooms === null
      ? [{ heading: null, rows: state.bookings }]
      : [
          ...state.rooms.map((room) => ({
            heading: room.name,
            rows: state.bookings.filter((row) => row.roomId === room.id),
          })),
          {
            heading: "Unassigned",
            rows: state.bookings.filter((row) => row.roomId === null),
          },
        ].filter((group) => group.rows.length > 0 || group.heading !== "Unassigned");

  return (
    <div
      className="display-arrivals-board"
      style={{ "--display-days": windowDates.length } as CSSProperties}
    >
      <div className="display-board-head" role="row">
        <span className="display-board-corner">Room</span>
        {windowDates.map((date, index) => (
          <span
            key={date}
            className="display-board-day"
            data-today={index === 0 || undefined}
            role="columnheader"
          >
            {formatDayHeading(date, index)}
          </span>
        ))}
      </div>
      {rowGroups.map((group, groupIndex) => {
        const room = group.heading === null ? null : splitRoomName(group.heading);
        return (
          <div className="display-board-row" key={group.heading ?? `group-${groupIndex}`}>
            {room !== null && (
              <span className="display-board-room" role="rowheader">
                {room.tag && <span className="display-board-room-tag">{room.tag}</span>}
                {room.label}
              </span>
            )}
            <div className="display-board-lanes">
              {group.rows.flatMap((row) => {
                const grouped = row.guests === null;
                // One bar per contiguous run of the row's nights (#2735), so a
                // stay with a gap in it leaves a visible hole rather than
                // claiming a bed on a night nobody booked. Names are resolved
                // per bar, not once per row: two people in one booking can hold
                // different runs, and each bar names only that run's occupants.
                return computeBarSegments(row, windowDates).map((layout, segmentIndex) => (
                  <div
                    key={`${row.key}-${segmentIndex}`}
                    className="display-bar"
                    data-group={grouped || undefined}
                    data-whole-lodge={row.wholeLodge || undefined}
                    data-departing={layout.departing || undefined}
                    data-starts-before={layout.startsBeforeWindow || undefined}
                    data-ends-after={layout.endsAfterWindow || undefined}
                    style={{
                      gridColumnStart: layout.startColumn,
                      gridColumnEnd: `span ${layout.spanColumns}`,
                    }}
                  >
                    <BarNamesLabel
                      row={row}
                      maxNames={maxNames}
                      leadOnly={leadOnly}
                      segment={layout}
                    />
                    {/* #2621: the expected arrival time, for tonight's (or a
                        later window day's) arrivals. Three conditions, and this
                        module enforces all three itself rather than trusting the
                        payload for any of them.

                        `!grouped` is the NAME GATE, restated here. `guests ===
                        null` is exactly the state `lodge-display-state` puts a
                        row into when the wall may not name the people on it (a
                        minor in the party, an organisation organiser, a
                        whole-lodge blockout, COUNTS_ONLY granularity), and this
                        bar then prints "label · count" instead of names. A
                        movement time beside that is the same disclosure the
                        label was chosen to avoid, so it is refused HERE too —
                        the state layer having refused it as well is defence in
                        depth, not a reason for this component to skip the check.
                        Deferring to the payload is what made the earlier guard
                        vacuous.

                        `!startsBeforeWindow` is the board's own local clip
                        guard: this module can be configured to show fewer days
                        than the state window, and a bar clipped at the left edge
                        must not sprout an arrival time for a day the viewer
                        cannot see.

                        `segmentIndex === 0` is the #2735 clause. There is ONE
                        expected arrival time per booking and it describes the
                        booking's check-in, so it belongs to the row's FIRST bar
                        only. A stay with a gap draws a second bar for the night
                        the party comes back, and repeating "arr 5:30 PM" on it
                        would announce a time nobody stored for that return. */}
                    {!grouped &&
                      row.arrivalTime &&
                      segmentIndex === 0 &&
                      !layout.startsBeforeWindow && (
                        <span className="display-bar-arrival">
                          arr {formatArrivalTime(row.arrivalTime)}
                        </span>
                      )}
                    <span className="display-bar-out">{barMeta(layout)}</span>
                  </div>
                ));
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
