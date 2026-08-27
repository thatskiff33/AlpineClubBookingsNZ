import type { DisplayState } from "@/lib/lodge-display-state";
import type { DisplayPanelOptions } from "./module-options";
import { countClubNights, requireCalendarDate } from "@/lib/club-time";
import { shortDay } from "./status-helpers";

// The rotating welcome panel (fork issues #30/#58; visual reference:
// docs/lobby-display/mockups/approved/whole-lodge-rotating.html panel B): a
// warm counterpart to the operational boards. Greets the current whole-lodge
// group by its (privacy-reduced) label with the mock's info tiles — group
// size, stay dates and nights, and an optional bunks note — or greets the
// lodge generally when no group holds it.

function shortDate(date: string): string {
  // The one shared column-head shape (`status-helpers.shortDay`).
  return shortDay(date);
}

/**
 * How many nights the group actually holds (#2735).
 *
 * Counted from the row's own night set, not from the envelope: `stayStart` to
 * `stayEnd` cannot see a gap, so a hold on Monday and Wednesday but not Tuesday
 * used to be announced as three nights. `nights` is required on the payload; the
 * envelope difference is the fallback for a row from an older deploy, and it is
 * the same number for every contiguous stay.
 */
function nightsHeld(row: {
  stayStart: string;
  stayEnd: string;
  nights?: readonly string[];
}): number {
  if (row.nights) return Math.max(1, row.nights.length);
  // Integer calendar arithmetic (CT-2, #2990). The elapsed-milliseconds
  // subtraction this replaces needed a `Math.round` to survive a DST-affected
  // span; a calendar night count has no such span to round away.
  return Math.max(
    1,
    countClubNights(
      requireCalendarDate(row.stayStart),
      requireCalendarDate(row.stayEnd),
    ),
  );
}

export function WelcomePanel({
  state,
}: {
  state: DisplayState;
  options?: DisplayPanelOptions;
}) {
  const wholeLodgeRow = state.bookings.find((row) => row.wholeLodge) ?? null;
  const checkinNote = state.config["checkin-note"] ?? null;
  const bunksNote = state.config["whole-lodge-note"] ?? null;

  return (
    <div className="display-welcome">
      <span className="display-welcome-kicker">Welcome to {state.lodge.name}</span>
      {wholeLodgeRow && (
        <span className="display-welcome-group">{wholeLodgeRow.label}</span>
      )}
      {checkinNote && <span className="display-welcome-note">{checkinNote}</span>}
      {wholeLodgeRow && (
        <div className="display-welcome-tiles">
          <span className="display-welcome-tile">
            <span className="display-tile-key">Group</span>
            <span className="display-tile-value">
              {wholeLodgeRow.guestCount} <small>guests</small>
            </span>
          </span>
          <span className="display-welcome-tile">
            <span className="display-tile-key">Staying</span>
            <span className="display-tile-value">
              {shortDate(wholeLodgeRow.stayStart)} → {shortDate(wholeLodgeRow.stayEnd)}{" "}
              <small>· {nightsHeld(wholeLodgeRow)} nights</small>
            </span>
          </span>
          {bunksNote && (
            <span className="display-welcome-tile">
              <span className="display-tile-key">Bunks</span>
              <span className="display-tile-value">{bunksNote}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
