"use client";

import { formatCents } from "@/lib/utils";
import {
  formatClubDayMonth,
  formatClubWeekday,
  requireCalendarDate,
} from "@/lib/club-time";

/**
 * A night column is two stacked lines — weekday above, day-and-month below — so
 * each half is formatted on its own and neither carries the year, which a narrow
 * column has no room for (#2264).
 *
 * THIS FILE WAS ALREADY RIGHT, and CT-4 (#2870) is recording WHY rather than
 * changing what it renders. Both halves were pinned to `timeZone: "UTC"`
 * deliberately, because the column key is a calendar day carried as a
 * `yyyy-MM-dd` string: reading it back in UTC is the identity, which is exactly
 * the mechanism `club-time/intl.ts` uses for every calendar-date shape. The
 * weekday half is now the kernel's own `formatClubWeekday`, which takes no zone
 * at all and makes the reasoning structural instead of a comment.
 *
 * BOTH HALVES ARE NOW THE KERNEL'S. The day-and-month half used to be a local
 * `Intl.DateTimeFormat` for want of a "16 Apr" shape — `HOUSE_SHAPES.date` is
 * "16 Apr 2026" and there was nothing between it and the bare weekday. CT-4's
 * `src/lib` group added `dayMonth` with byte-identical options, so this file now
 * builds no formatter and constructs no `Date` at all.
 */

/**
 * Per-guest night picker grid (issue #713 — multi date range stays).
 *
 * Rows are guests, columns are each night between arrival and departure. Each
 * cell toggles whether that guest stays that night: an included night shows its
 * price with a red ✕ to switch it off; an excluded night shows the price struck
 * through with a green + to switch it back on. Non-contiguous selections (gaps)
 * are allowed. Long stays scroll horizontally; the guest column stays pinned so
 * the grid stays usable on a phone.
 *
 * Presentational only: the parent owns the selection state, the nightly prices
 * (from a quote) and the toggle handler.
 */
export interface GuestNightGridProps {
  guestLabels: string[];
  /** Column nights as `yyyy-mm-dd` keys, ascending. */
  nights: string[];
  isNightOn: (guestIndex: number, nightKey: string) => boolean;
  priceForNight?: (guestIndex: number, nightKey: string) => number | null;
  onToggle: (guestIndex: number, nightKey: string) => void;
  arrivalLabel?: string;
  departureLabel?: string;
}

function nightColumnLabel(nightKey: string): { weekday: string; day: string } {
  // nightKey is a calendar day; both halves render with no zone in the picture.
  const day = requireCalendarDate(nightKey);
  return {
    weekday: formatClubWeekday(day),
    day: formatClubDayMonth(day),
  };
}

export function GuestNightGrid({
  guestLabels,
  nights,
  isNightOn,
  priceForNight,
  onToggle,
  arrivalLabel,
  departureLabel,
}: GuestNightGridProps) {
  if (nights.length === 0 || guestLabels.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {(arrivalLabel || departureLabel) && (
        <p className="text-sm text-muted-foreground">
          Arrival <span className="font-medium">{arrivalLabel}</span>
          {" · "}
          Departure <span className="font-medium">{departureLabel}</span>
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Tap a night to switch it off for a guest. Each guest is only charged for,
        and allocated a bed on, the nights that stay on.
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium">
                Guest
              </th>
              {nights.map((nightKey) => {
                const { weekday, day } = nightColumnLabel(nightKey);
                return (
                  <th
                    key={nightKey}
                    className="whitespace-nowrap px-2 py-2 text-center font-medium"
                  >
                    <div className="text-muted-foreground">{weekday}</div>
                    <div>{day}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {guestLabels.map((label, guestIndex) => (
              <tr key={guestIndex} className="border-t">
                <td className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">
                  {label || `Guest ${guestIndex + 1}`}
                </td>
                {nights.map((nightKey) => {
                  const on = isNightOn(guestIndex, nightKey);
                  const priceCents = priceForNight?.(guestIndex, nightKey) ?? null;
                  const priceText =
                    priceCents != null ? formatCents(priceCents) : on ? "On" : "Off";
                  return (
                    <td key={nightKey} className="px-1 py-1 text-center">
                      <button
                        type="button"
                        onClick={() => onToggle(guestIndex, nightKey)}
                        aria-pressed={on}
                        aria-label={`${on ? "Remove" : "Add"} ${nightColumnLabel(nightKey).day} for ${label || `Guest ${guestIndex + 1}`}`}
                        className={[
                          "flex w-full min-w-14 flex-col items-center gap-0.5 rounded-md border px-2 py-1 transition-colors",
                          on
                            ? "border-success-6 bg-success-3 text-success-11 hover:bg-success-3"
                            : "border-border bg-card text-muted-foreground hover:bg-muted",
                        ].join(" ")}
                      >
                        <span className={on ? "" : "line-through"}>{priceText}</span>
                        <span
                          className={on ? "text-danger-11" : "text-success-11"}
                          aria-hidden="true"
                        >
                          {on ? "✕" : "+"}
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
