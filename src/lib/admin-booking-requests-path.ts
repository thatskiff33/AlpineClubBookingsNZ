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
import type { BookingRequestStatus } from "@prisma/client";
import { adminHref } from "@/lib/admin-hubs";

export const BOOKING_REQUESTS_TABS = [
  "approvals",
  "changes",
  "exceptions",
  "public",
] as const;

/** One of the booking-requests page's tabs — see BOOKING_REQUESTS_TABS. */
export type BookingRequestsTab = (typeof BOOKING_REQUESTS_TABS)[number];

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

/**
 * The one query key that carries a booking-requests tab's status filter
 * (#4960 follow-up). The panels read their opening filter from it and
 * `buildBookingRequestDatasetPath` writes it, so a link that names the filter
 * any other way — the quote-accepted email once sent `filter=ACCEPTED` —
 * silently opens the default queue instead.
 */
export const BOOKING_REQUESTS_STATUS_PARAM = "status";

/**
 * Every token the public-requests tab can filter on: each
 * `BookingRequestStatus` (the API accepts exactly these) plus the two views
 * `QUEUE` (the default) and `ALL`. Derived from the enum with a type-only
 * import, so it stays client-safe and cannot name a status that does not exist.
 */
export type PublicBookingRequestFilter = BookingRequestStatus | "QUEUE" | "ALL";

/**
 * Keyed by the whole vocabulary rather than listed, so adding or removing a
 * `BookingRequestStatus` is a compile error here (and, through the panel's
 * `Record<PublicBookingRequestFilter, string>` labels, at the filter row).
 * Without that, a new status the API accepts would open on `QUEUE` from a link,
 * with nothing failing (INV-SSOT-001: unrepresentable, not policed).
 */
const PUBLIC_BOOKING_REQUEST_FILTER_TOKENS: Record<PublicBookingRequestFilter, true> = {
  QUEUE: true,
  NEW: true,
  VERIFIED: true,
  PRICED: true,
  QUOTED: true,
  QUOTE_SENT: true,
  QUERY_PENDING: true,
  MODIFICATION_REQUESTED: true,
  ACCEPTED: true,
  APPROVED: true,
  DECLINED: true,
  CANCELLED: true,
  CONVERTED: true,
  ALL: true,
};

export const DEFAULT_PUBLIC_BOOKING_REQUEST_FILTER: PublicBookingRequestFilter = "QUEUE";

function isPublicBookingRequestFilter(value: string | null): value is PublicBookingRequestFilter {
  // `hasOwn`, not `in`: "toString" and "constructor" are not filters.
  return value !== null && Object.hasOwn(PUBLIC_BOOKING_REQUEST_FILTER_TOKENS, value);
}

/** Link to the public-requests tab opened on `status`. */
export function buildPublicBookingRequestsHref(status: PublicBookingRequestFilter) {
  return buildBookingRequestsHref("public", { [BOOKING_REQUESTS_STATUS_PARAM]: status });
}

/** The filter the public-requests tab opens on for these query params. */
export function readPublicBookingRequestFilter(
  searchParams: Pick<URLSearchParams, "get">,
): PublicBookingRequestFilter {
  const value = searchParams.get(BOOKING_REQUESTS_STATUS_PARAM);
  return isPublicBookingRequestFilter(value) ? value : DEFAULT_PUBLIC_BOOKING_REQUEST_FILTER;
}
