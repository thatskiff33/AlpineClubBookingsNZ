import type { DisplayPanelOptionValue } from "@/lib/lodge-display/template-registry";

// Per-module option parsing for the lobby display (fork issue hoppers99/AlpineClubBookingsNZ#30). Every
// module renders sensibly with zero options; an invalid value falls back to
// its documented default rather than throwing (issue hoppers99/AlpineClubBookingsNZ#30 AC6) — a bad
// template edit can make a screen plainer, never blank.

export type DisplayPanelOptions = Record<string, DisplayPanelOptionValue>;

export function intOption(
  options: DisplayPanelOptions | undefined,
  key: string,
  fallback: number,
  bounds: { min: number; max: number }
): number {
  const raw = options?.[key];
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(value)));
}

/**
 * A boolean option. Accepts a real boolean, the strings true/false/1/0/yes/no
 * (case-insensitive), or a number (0 is false). Anything else — including an
 * unset option — falls back to the documented default (issue hoppers99/AlpineClubBookingsNZ#30 AC6: a bad
 * template edit never throws, it just uses the default).
 */
export function boolOption(
  options: DisplayPanelOptions | undefined,
  key: string,
  fallback: boolean
): boolean {
  const raw = options?.[key];
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw !== 0 : fallback;
  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    if (value === "true" || value === "1" || value === "yes") return true;
    if (value === "false" || value === "0" || value === "no") return false;
  }
  return fallback;
}

/**
 * A closed-set string option. Returns the matching allowed value (case-sensitive
 * against `allowed`), else the documented fallback — so a bad template edit never
 * throws (issue hoppers99/AlpineClubBookingsNZ#30 AC6).
 */
export function enumOption<T extends string>(
  options: DisplayPanelOptions | undefined,
  key: string,
  fallback: T,
  allowed: readonly T[]
): T {
  const raw = options?.[key];
  if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) {
    return raw as T;
  }
  return fallback;
}

export const ARRIVALS_BOARD_DEFAULT_DAYS = 3;
export const ARRIVALS_BOARD_MAX_NAMES = 5;
/** Bar-board name rendering: full names (up to max-names) or lead name + count. */
export const ARRIVALS_BOARD_NAME_STYLES = ["names", "lead-count"] as const;
/** Whole-lodge blockout rendering: auto by rooms presence, or force board/statement. */
export const OCCUPANCY_GRID_VARIANTS = ["auto", "board", "statement"] as const;

export const NIGHT_COLUMNS_DEFAULT_DAYS = 3;
// The board is a permanent 3-night look-ahead. This ceiling matches the fixed
// display-device data window (`clampDisplayWindowDays(null)` →
// DISPLAY_WINDOW_DEFAULT_DAYS = 3): bookings beyond that window are never
// fetched, so a higher ceiling would silently render fewer columns than it
// promises. A wider board therefore requires widening the device window first —
// decided against in issue #2056 (Option C: keep the 3-day window, make the
// module honest at 3 nights).
export const NIGHT_COLUMNS_MAX_DAYS = 3;
