import type { CSSProperties } from "react";
import type { DisplayState, DisplayStateBooking } from "@/lib/lodge-display-state";
import {
  NIGHT_COLUMNS_DEFAULT_DAYS,
  NIGHT_COLUMNS_MAX_DAYS,
  boolOption,
  intOption,
  type DisplayPanelOptions,
} from "./module-options";
import {
  STAY_STATUS_ORDER,
  shortDay,
  staySegmentOn,
  type StaySegment,
  type StayStatus,
} from "./status-helpers";

// Next-N-nights look-ahead (issue #115; visual references: origin five-panel
// mock O3 "The next three nights" without rooms, and
// docs/lobby-display/mockups/guest-rows.html variant "A" / C1a WITH rooms).
// One module, optional room dimension: columns are the next N nights, each
// headed by its date (+ "Tonight" on window.start and an occupancy count).
// Under each column the bookings active that night are listed and marked
// arriving / staying / departing, each with its check-out. When bed allocation
// is on AND the show-rooms option holds, each row is annotated with its room
// (C1a); otherwise it is the plain look-ahead (O3).
//
// Booking-level, not per-guest: a party reads as one row (lead name + "+N", or
// a withheld label + count), matching the mocks — the point is the look-ahead,
// not a full guest manifest (the arrivals / singles boards do that).

interface NightRow {
  key: string;
  label: string;
  status: StayStatus;
  span: string;
  roomName: string | null;
  /** Withheld / group row — rendered with the group (purple) treatment. */
  group: boolean;
}

function windowDatesOf(state: DisplayState): string[] {
  return state.occupancy.map((day) => day.date);
}

function bookingLabel(booking: DisplayStateBooking): { label: string; group: boolean } {
  if (booking.guests === null || booking.guests.length === 0) {
    return { label: `${booking.label} · ${booking.guestCount}`, group: true };
  }
  const [lead, ...rest] = booking.guests;
  if (!lead) {
    // Unreachable: the length check above guarantees at least one guest.
    return { label: `${booking.label} · ${booking.guestCount}`, group: true };
  }
  return {
    label: rest.length > 0 ? `${lead.label} +${rest.length}` : lead.label,
    group: false,
  };
}

// The SEGMENT's check-out, not the row's envelope (#2735). This panel shows
// several days at once, so the contradiction was visible inside one panel: for
// nights {13, 15} the 13th's column said "→ Thu 16" while the 14th's said
// "leaves". Now the 13th says "→ Tue 14" and the 15th says "→ Thu 16".
function spanText(segment: StaySegment): string {
  if (segment.status === "departing") return "leaves";
  return `→ ${shortDay(segment.stayEnd)}`;
}

export function NightColumns({
  state,
  options,
}: {
  state: DisplayState;
  options?: DisplayPanelOptions;
}) {
  const days = intOption(options, "days", NIGHT_COLUMNS_DEFAULT_DAYS, {
    min: 1,
    max: NIGHT_COLUMNS_MAX_DAYS,
  });
  const windowDates = windowDatesOf(state).slice(0, days);
  // Rooms are shown only when allocation is on; the option defaults to that
  // presence so O3 (no rooms) and C1a (rooms) both fall out naturally.
  const showRooms =
    state.rooms !== null && boolOption(options, "show-rooms", true);
  const roomsById = new Map((state.rooms ?? []).map((room) => [room.id, room.name]));

  return (
    <div
      className="display-night-columns"
      style={{ "--display-days": windowDates.length } as CSSProperties}
    >
      {windowDates.map((date, index) => {
        const today = index === 0;
        const occ = state.occupancy.find((day) => day.date === date) ?? null;

        const rows: NightRow[] = state.bookings
          .map((booking): NightRow | null => {
            const segment = staySegmentOn(booking, date);
            if (segment === null) return null;
            const { label, group } = bookingLabel(booking);
            const roomName =
              showRooms && booking.roomId !== null
                ? roomsById.get(booking.roomId) ?? null
                : null;
            return {
              key: booking.key,
              label,
              status: segment.status,
              span: spanText(segment),
              roomName,
              group,
            };
          })
          .filter((row): row is NightRow => row !== null)
          .sort((a, b) => STAY_STATUS_ORDER[a.status] - STAY_STATUS_ORDER[b.status]);

        const dayLabel = today ? `Tonight · ${shortDay(date)}` : shortDay(date);
        const newCount = occ && !today && occ.arriving > 0 ? ` · ${occ.arriving} new` : "";
        const countLabel = occ ? `${occ.staying} in${newCount}` : "";

        return (
          <div
            key={date}
            className={`display-night-col${today ? " display-night-col-today" : ""}`}
          >
            <div className="display-night-col-head">
              <span className="display-night-col-date">{dayLabel}</span>
              {countLabel && (
                <span className="display-night-col-count">{countLabel}</span>
              )}
            </div>
            {rows.length === 0 ? (
              <div className="display-night-empty">No one in</div>
            ) : (
              <div className="display-night-list">
                {rows.map((row) => (
                  <div
                    key={row.key}
                    className="display-night-row"
                    data-status={row.status}
                    data-group={row.group || undefined}
                  >
                    <span className="display-night-dot" data-status={row.status} />
                    <span className="display-night-name">{row.label}</span>
                    {row.roomName && (
                      <span className="display-night-room">{row.roomName}</span>
                    )}
                    <span className="display-night-span">{row.span}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
