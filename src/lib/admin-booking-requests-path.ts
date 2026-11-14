import type { BookingRequestPendingCounts } from "@/lib/admin-booking-request-pending-counts";

/**
 * The runtime list exists so consumers that need the tokens as VALUES — the
 * diagnostics page-context registry's tab allowlist (#2812, owner decision
 * 13 Aug 2026: every tab), and the page's own query-param parser — share ONE
 * authority with the type instead of hand-copying a union that drifts. NOTE
 * the flip side of that sharing: adding a token here simultaneously widens
 * what the page parses AND what Diagnostics may be told about, so a new tab
 * is a registry-review moment, not just a UI edit.
 *
 * `exceptions` (#2526) is the Booking Officer's booking-policy exception
 * queue — a distinct tab from `changes` because the two decide different
 * things: a locked-period change request is an acknowledgement an admin then
 * applies by hand, while approving a policy exception EXECUTES the reviewed
 * proposal.
 */
import { adminHref } from "@/lib/admin-hubs";

export const BOOKING_REQUESTS_TABS = [
  "approvals",
  "changes",
  "exceptions",
  "public",
] as const;

/** One of the booking-requests page's tabs — see BOOKING_REQUESTS_TABS. */
export type BookingRequestsTab = (typeof BOOKING_REQUESTS_TABS)[number];

/**
 * Where the Booking Requests page reads its four queue counts. A bookings-area
 * route, not the overview-area sidebar aggregate, so an admin who can open the
 * page can always read it (the route file is pinned to this path in the path
 * tests).
 */
export const BOOKING_REQUEST_PENDING_COUNTS_PATH =
  "/api/admin/booking-requests/pending-counts";

/**
 * Every field of `BookingRequestPendingCounts`, as VALUES so a client can check
 * a payload. Typed as a record over the type's own keys, so a queue added to
 * the type without being added here (or one named here that the type lacks)
 * fails to compile, rather than being waved through by a hand-copied list.
 */
const PENDING_COUNT_FIELDS = {
  bookingReviews: true,
  lockedPeriodChangeRequests: true,
  policyExceptionRequests: true,
  publicBookingRequests: true,
} satisfies Record<keyof BookingRequestPendingCounts, true>;

/**
 * The counts out of a fetched payload, or null when it is not one: anything
 * that is not an object carrying all four fields as numbers. Extra fields (the
 * sidebar aggregate carries many) are ignored.
 */
export function readBookingRequestPendingCounts(
  data: unknown,
): BookingRequestPendingCounts | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const fields = Object.keys(PENDING_COUNT_FIELDS) as Array<
    keyof BookingRequestPendingCounts
  >;
  if (!fields.every((field) => typeof record[field] === "number")) return null;
  return Object.fromEntries(
    fields.map((field) => [field, record[field]]),
  ) as BookingRequestPendingCounts;
}

/** A pending count for each tab, keyed by the tab that shows that queue. */
export type BookingRequestsTabCounts = Record<BookingRequestsTab, number>;

/**
 * Which pending count each tab shows (#4969). The sidebar badge is the sum of
 * these four, so the tab badges always add up to it.
 */
export function bookingRequestsTabCounts(
  counts: BookingRequestPendingCounts,
): BookingRequestsTabCounts {
  return {
    approvals: counts.bookingReviews,
    changes: counts.lockedPeriodChangeRequests,
    exceptions: counts.policyExceptionRequests,
    public: counts.publicBookingRequests,
  };
}

/** The sidebar's Booking Requests badge: every tab's pending count added up. */
export function totalBookingRequestsPending(
  counts: BookingRequestPendingCounts,
): number {
  const tabCounts = bookingRequestsTabCounts(counts);
  return BOOKING_REQUESTS_TABS.reduce((sum, tab) => sum + tabCounts[tab], 0);
}

/**
 * The tab a bare link to the page should open on (#4969): the first tab, in
 * BOOKING_REQUESTS_TABS order, with pending work, or `approvals` when nothing
 * is waiting. The page and the dashboard card both ask this, so they cannot
 * disagree about where the work is.
 */
export function firstBookingRequestsTabWithWork(
  counts: BookingRequestsTabCounts,
): BookingRequestsTab {
  return BOOKING_REQUESTS_TABS.find((tab) => counts[tab] > 0) ?? "approvals";
}

type SearchParamValue = string | string[] | undefined;

export function buildBookingRequestsHref(
  tab: BookingRequestsTab,
  searchParams: Record<string, SearchParamValue> = {},
) {
  const params = new URLSearchParams({ tab });

  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "tab" || value == null) {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => params.append(key, item));
    } else {
      params.set(key, value);
    }
  }

  return `${adminHref("booking-requests")}?${params.toString()}`;
}
