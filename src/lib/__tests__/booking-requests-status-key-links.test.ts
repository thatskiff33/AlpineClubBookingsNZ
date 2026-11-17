import { BookingRequestStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  BOOKING_REQUESTS_STATUS_PARAM,
  DEFAULT_PUBLIC_BOOKING_REQUEST_FILTER,
  buildBookingRequestsHref,
  buildPublicBookingRequestsHref,
  readPublicBookingRequestFilter,
} from "@/lib/admin-booking-requests-path";

/*
 * The booking-requests links and the panels that open from them share one
 * status key and one filter vocabulary (#4960 follow-up). The vocabulary is
 * the BookingRequestStatus enum plus QUEUE and ALL, which the admin API also
 * accepts, so a link to any status the API knows must open on that status.
 */

function search(href: string) {
  return new URL(href, "http://localhost").searchParams;
}

describe("public booking-requests filter links", () => {
  it("names the status in the one key the panels read", () => {
    expect(BOOKING_REQUESTS_STATUS_PARAM).toBe("status");
    expect(buildPublicBookingRequestsHref("ACCEPTED")).toBe(
      "/admin/booking-requests?tab=public&status=ACCEPTED",
    );
  });

  it("round-trips every status the API accepts, plus QUEUE and ALL", () => {
    for (const filter of [...Object.values(BookingRequestStatus), "QUEUE", "ALL"] as const) {
      const params = search(buildPublicBookingRequestsHref(filter));
      expect(params.get("tab")).toBe("public");
      expect(readPublicBookingRequestFilter(params)).toBe(filter);
    }
  });

  it("opens on the default filter when the key is absent, misspelt or not a filter", () => {
    expect(DEFAULT_PUBLIC_BOOKING_REQUEST_FILTER).toBe("QUEUE");
    for (const query of [
      "tab=public",
      "tab=public&filter=ACCEPTED",
      "tab=public&status=",
      "tab=public&status=accepted",
      "tab=public&status=PENDING",
      "tab=public&status=toString",
      "tab=public&status=constructor",
    ]) {
      expect(readPublicBookingRequestFilter(new URLSearchParams(query))).toBe("QUEUE");
    }
  });
});

describe("buildBookingRequestsHref", () => {
  it("keeps the Bookings list Review chip's link as it was written by hand", () => {
    expect(
      buildBookingRequestsHref("approvals", {
        bookingId: "bk_1",
        [BOOKING_REQUESTS_STATUS_PARAM]: "ALL",
      }),
    ).toBe("/admin/booking-requests?tab=approvals&bookingId=bk_1&status=ALL");
  });
});
