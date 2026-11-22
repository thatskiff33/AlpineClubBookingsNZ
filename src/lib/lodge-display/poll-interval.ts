// Per-device lobby-display poll cadence bounds (LTV-039, issue hoppers99/AlpineClubBookingsNZ#85; consolidates
// hoppers99/AlpineClubBookingsNZ#66). The state poll doubles as the device heartbeat, so this cadence also
// governs how often a device's "last seen" refreshes. Shared by the state route
// (clamp on read), the devices PATCH route (validate on write), and the display
// client (drive the active-board tick). Deliberately free of server-only imports
// so the "use client" display hook can import it too.

export const DISPLAY_POLL_MIN_SECONDS = 15;
export const DISPLAY_POLL_MAX_SECONDS = 600;
export const DISPLAY_DEFAULT_POLL_SECONDS = 60;

/**
 * Resolve a persisted per-device override into the effective poll cadence:
 * a null/absent/non-finite value falls back to the default, otherwise the value
 * is rounded and clamped into [min, max]. The state route uses this to shape the
 * payload the client trusts, so an out-of-range legacy value can never make a
 * wall hammer (or starve) the API.
 */
export function clampPollSeconds(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DISPLAY_DEFAULT_POLL_SECONDS;
  }
  return Math.min(
    DISPLAY_POLL_MAX_SECONDS,
    Math.max(DISPLAY_POLL_MIN_SECONDS, Math.round(value))
  );
}
