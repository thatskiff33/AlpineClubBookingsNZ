import type { BookingStatus } from "@prisma/client";
import { isBookingStatus } from "@/lib/booking-status";

// The admin booking calendar remembers which statuses an admin HID, so a status
// added later is shown by default instead of missing from every saved
// preference (#4923). Client-safe: it only reads the storage it is handed.
const HIDDEN_STATUSES_STORAGE_KEY = "admin-calendar-hidden-statuses";

// The pre-#4923 preference stored the ENABLED statuses. It is read once,
// converted against the statuses that existed when it was written, and removed.
const ENABLED_STATUSES_STORAGE_KEY = "admin-calendar-enabled-statuses";

// Frozen: the statuses the old enabled-list preference could have contained.
// Never add a status here — one it never knew about must not count as hidden.
const LEGACY_ENABLED_LIST_STATUSES: readonly BookingStatus[] = [
  "DRAFT", "PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID", "COMPLETED",
  "CANCELLED", "BUMPED", "WAITLISTED", "WAITLIST_OFFERED",
];

/** Cancelled bookings are hidden until the CANCELLED pill is switched on, to reduce noise. */
export function defaultHiddenCalendarStatuses(): Set<BookingStatus> {
  return new Set<BookingStatus>(["CANCELLED"]);
}

/**
 * The statuses to hide: the saved hidden list, else the legacy enabled list
 * converted once, else the defaults. Anything unreadable or unrecognised falls
 * back to the defaults; unknown entries inside a readable list are ignored.
 */
export function readHiddenCalendarStatuses(storage: Pick<Storage, "getItem">): Set<BookingStatus> {
  try {
    const stored = storage.getItem(HIDDEN_STATUSES_STORAGE_KEY);
    if (stored !== null) {
      const parsed: unknown = JSON.parse(stored);
      return Array.isArray(parsed)
        ? new Set(parsed.filter(isBookingStatus))
        : defaultHiddenCalendarStatuses();
    }
    const legacy = storage.getItem(ENABLED_STATUSES_STORAGE_KEY);
    if (legacy === null) return defaultHiddenCalendarStatuses();
    const parsed: unknown = JSON.parse(legacy);
    if (!Array.isArray(parsed)) return defaultHiddenCalendarStatuses();
    const enabled = new Set(parsed.filter(isBookingStatus));
    // The old reader fell back to the defaults when nothing valid was saved.
    if (enabled.size === 0) return defaultHiddenCalendarStatuses();
    return new Set(LEGACY_ENABLED_LIST_STATUSES.filter((status) => !enabled.has(status)));
  } catch {
    return defaultHiddenCalendarStatuses();
  }
}

/** Saves the hidden statuses and drops the legacy enabled-list key. */
export function writeHiddenCalendarStatuses(
  storage: Pick<Storage, "setItem" | "removeItem">,
  hidden: ReadonlySet<BookingStatus>
): void {
  storage.setItem(HIDDEN_STATUSES_STORAGE_KEY, JSON.stringify([...hidden]));
  storage.removeItem(ENABLED_STATUSES_STORAGE_KEY);
}
