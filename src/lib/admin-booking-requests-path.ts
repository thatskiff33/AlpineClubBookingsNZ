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
