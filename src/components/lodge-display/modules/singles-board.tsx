import type { CSSProperties } from "react";
import type { DisplayState } from "@/lib/lodge-display-state";
import {
  ARRIVALS_BOARD_DEFAULT_DAYS,
  intOption,
  type DisplayPanelOptions,
} from "./module-options";
import {
  barMeta,
  computeBarSegments,
  splitRoomName,
  windowDatesOf,
} from "./arrivals-board";
import { shortDay } from "./status-helpers";

// The by-booking singles board (fork issues #30/#58; visual reference:
// docs/lobby-display/mockups/singles-by-booking.html): Room | Guest | night
// columns — the room label spans its guests' rows, one row per guest, each
// guest keeping their OWN night bar and check-out date (four people in one
// room can leave on three different days). Privacy-reduced bookings (family/
// org/counts-only) collapse to a single row with the reduced label. Bar
// night-span and colour semantics are shared with the everyday board.

interface SinglesRow {
  key: string;
  label: string;
  stayStart: string;
  stayEnd: string;
  /** The row's own nights — one bar per contiguous run of them (#2735). */
  nights: readonly string[];
}

interface SinglesGroup {
  heading: string | null;
  rows: SinglesRow[];
}

function rowsOf(booking: DisplayState["bookings"][number]): SinglesRow[] {
  if (booking.guests === null || booking.guests.length === 0) {
    return [
      {
        key: booking.key,
        label: `${booking.label} · ${booking.guestCount}`,
        stayStart: booking.stayStart,
        stayEnd: booking.stayEnd,
        nights: booking.nights,
      },
    ];
  }
  return booking.guests.map((guest, index) => ({
    key: `${booking.key}-${index}`,
    label: guest.label,
    stayStart: guest.stayStart,
    stayEnd: guest.stayEnd,
    nights: guest.nights,
  }));
}

export function SinglesBoard({
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
  const windowDates = windowDatesOf(state).slice(0, days);

  const groups: SinglesGroup[] =
    state.rooms === null
      ? [{ heading: null, rows: state.bookings.flatMap(rowsOf) }]
      : [
          ...state.rooms.map((room) => ({
            heading: room.name,
            rows: state.bookings
              .filter((row) => row.roomId === room.id)
              .flatMap(rowsOf),
          })),
          {
            heading: "Unassigned",
            rows: state.bookings
              .filter((row) => row.roomId === null)
              .flatMap(rowsOf),
          },
        ].filter((group) => group.rows.length > 0);

  const hasRooms = state.rooms !== null;
  // Grid rows are assigned explicitly so a room label can span its group.
  let nextRow = 2;

  return (
    <div
      className="display-singles-board"
      data-has-rooms={hasRooms || undefined}
      style={{ "--display-days": windowDates.length } as CSSProperties}
    >
      {hasRooms && <span className="display-singles-head">Room</span>}
      <span
        className="display-singles-head"
        style={{ gridColumn: hasRooms ? 2 : 1 }}
      >
        Guest
      </span>
      {windowDates.map((date, index) => (
          <span
            key={date}
            className="display-singles-head"
            data-today={index === 0 || undefined}
            style={{ gridColumn: index + (hasRooms ? 3 : 2) }}
          >
            {shortDay(date)}
          </span>
        ))}
      {groups.map((group) => {
        const startRow = nextRow;
        nextRow += group.rows.length;
        const room = group.heading === null ? null : splitRoomName(group.heading);
        return (
          <div style={{ display: "contents" }} key={group.heading ?? "all"}>
            {hasRooms && room !== null && (
              <span
                className="display-singles-room"
                style={{ gridRow: `${startRow} / span ${group.rows.length}` }}
              >
                {room.tag && (
                  <span className="display-board-room-tag">{room.tag}</span>
                )}
                {room.label}
              </span>
            )}
            {group.rows.map((row, index) => {
              const gridRow = startRow + index;
              // One bar per contiguous run of this person's nights (#2735):
              // four people in one room can already leave on three different
              // days, and one of them can also go home mid-stay and come back.
              const segments = computeBarSegments(row, windowDates);
              return (
                <div style={{ display: "contents" }} key={row.key}>
                  <span
                    className="display-singles-guest"
                    style={{ gridRow, gridColumn: hasRooms ? 2 : 1 }}
                  >
                    {row.label}
                  </span>
                  <span
                    className="display-singles-track"
                    style={{
                      gridRow,
                      gridColumn: `${hasRooms ? 3 : 2} / -1`,
                    }}
                  />
                  {segments.map((layout, segmentIndex) => (
                    <span
                      key={`${row.key}-${segmentIndex}`}
                      className="display-singles-bar"
                      data-departing={layout.departing || undefined}
                      style={{
                        gridRow,
                        gridColumnStart: layout.startColumn + (hasRooms ? 2 : 1),
                        gridColumnEnd: `span ${layout.spanColumns}`,
                      }}
                    >
                      {barMeta(layout)}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
