import type { BookingRequestPendingCounts } from "@/lib/admin-booking-request-pending-counts";
import {
  bookingRequestsTabCounts,
  buildBookingRequestsHref,
  firstBookingRequestsTabWithWork,
} from "@/lib/admin-booking-requests-path";

/** "2 change requests", or null when there are none. */
function countPhrase(count: number, noun: string): string | null {
  return count > 0 ? `${count} ${noun}${count === 1 ? "" : "s"}` : null;
}

/** "a", "a and b", "a, b and c". */
function joinWithAnd(parts: readonly string[]): string {
  return parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The admin dashboard's Booking Requests card (#4969): null when no queue has
 * work, otherwise what is waiting and a link to the tab the Booking Requests
 * page itself would open on, so the card and the page cannot disagree about
 * where the work is.
 */
export function describeBookingRequestsAlert(
  counts: BookingRequestPendingCounts,
): { href: string; summary: string } | null {
  const tabCounts = bookingRequestsTabCounts(counts);
  const phrases = [
    countPhrase(tabCounts.approvals, "new booking review"),
    countPhrase(tabCounts.changes, "change request"),
    countPhrase(tabCounts.exceptions, "policy exception request"),
    countPhrase(tabCounts.public, "public booking request"),
  ].filter((phrase): phrase is string => phrase !== null);
  if (phrases.length === 0) return null;
  return {
    href: buildBookingRequestsHref(firstBookingRequestsTabWithWork(tabCounts)),
    summary: joinWithAnd(phrases),
  };
}
