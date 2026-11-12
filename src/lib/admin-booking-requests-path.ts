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

  return `/admin/booking-requests?${params.toString()}`;
}

/**
 * The one query key that carries a booking-requests tab's status filter
 * (#4960 follow-up). The panels read their opening filter from it and
 * `buildBookingRequestDatasetPath` writes it, so a link that names the filter
 * any other way — the quote-accepted email once sent `filter=ACCEPTED` —
 * silently opens the default queue instead.
 */
export const BOOKING_REQUESTS_STATUS_PARAM = "status";

/** The public-requests tab's filters; `QUEUE` is the default. */
const PUBLIC_BOOKING_REQUEST_FILTERS = [
  "QUEUE",
  "NEW",
  "VERIFIED",
  "PRICED",
  "QUOTED",
  "QUOTE_SENT",
  "QUERY_PENDING",
  "MODIFICATION_REQUESTED",
  "ACCEPTED",
  "APPROVED",
  "DECLINED",
  "CANCELLED",
  "CONVERTED",
  "ALL",
] as const;

export type PublicBookingRequestFilter = (typeof PUBLIC_BOOKING_REQUEST_FILTERS)[number];

export const DEFAULT_PUBLIC_BOOKING_REQUEST_FILTER: PublicBookingRequestFilter = "QUEUE";

function isPublicBookingRequestFilter(value: string | null): value is PublicBookingRequestFilter {
  return (PUBLIC_BOOKING_REQUEST_FILTERS as readonly (string | null)[]).includes(value);
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
