import type { DisplayState, DisplayStateBooking } from "@/lib/lodge-display-state";
import type { DisplayPanelOptions } from "./module-options";
import {
  shortDay,
  staySegmentOn,
  type StaySegment,
  type StayStatus,
} from "./status-helpers";

// Allocation-off status board (issue #115, closes #114; visual reference:
// origin five-panel mock O4 "When rooms aren't assigned"). Three status columns
// for TONIGHT (window.start): Arriving / Staying / Leaving today — the plain
// arrivals board grouped by status, with NO room boxes.
//
// This is the allocation-agnostic board: it derives purely from the bookings on
// window.start and never reads state.rooms, so it renders identically whether or
// not bed allocation is configured. Its condition affinity is
// `bed-allocation:enabled` = false (a template rotates to it when rooms are
// off), but the component itself must not depend on rooms being null.
//
// Booking-level, like the look-ahead columns: a party is one entry (lead name +
// "+N", or a withheld label + count), coloured by its status group.

interface StatusEntry {
  key: string;
  label: string;
  span: string;
  group: boolean;
}

const GROUPS: Array<{ status: StayStatus; title: string }> = [
  { status: "arriving", title: "Arriving" },
  { status: "staying", title: "Staying" },
  { status: "departing", title: "Leaving today" },
];

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

function spanText(segment: StaySegment): string {
  // Leaving shows the whole stay (mock O4: "Mon 6 – Fri 10"); arriving/staying
  // point at the check-out ("→ Sun 12").
  //
  // The SEGMENT's dates, not the row's envelope (#2735). The status beside them
  // is per segment, so labelling with the envelope printed "Leaving today ·
  // Gappy G · Mon 13 – Thu 16" for a stay with a gap — a check-out three days
  // after the day it says they leave. For a contiguous stay the segment IS the
  // envelope and nothing changes.
  if (segment.status === "departing") {
    return `${shortDay(segment.stayStart)} – ${shortDay(segment.stayEnd)}`;
  }
  return `→ ${shortDay(segment.stayEnd)}`;
}

export function StatusBoard({
  state,
}: {
  state: DisplayState;
  options?: DisplayPanelOptions;
}) {
  const tonight = state.window.start;

  const byStatus = new Map<StayStatus, StatusEntry[]>([
    ["arriving", []],
    ["staying", []],
    ["departing", []],
  ]);

  for (const booking of state.bookings) {
    const segment = staySegmentOn(booking, tonight);
    if (segment === null) continue;
    const { label, group } = bookingLabel(booking);
    byStatus.get(segment.status)!.push({
      key: booking.key,
      label,
      span: spanText(segment),
      group,
    });
  }

  return (
    <div className="display-status-board">
      {GROUPS.map(({ status, title }) => {
        const entries = byStatus.get(status)!;
        return (
          <div key={status} className="display-status-group" data-status={status}>
            <div className="display-status-group-head">
              <span className="display-status-dot" data-status={status} />
              <span className="display-status-title">{title}</span>
            </div>
            {entries.length === 0 ? (
              <div className="display-status-empty">—</div>
            ) : (
              <div className="display-status-list">
                {entries.map((entry) => (
                  <div
                    key={entry.key}
                    className="display-status-row"
                    data-group={entry.group || undefined}
                  >
                    <span className="display-status-name">{entry.label}</span>
                    <span className="display-status-span">{entry.span}</span>
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
