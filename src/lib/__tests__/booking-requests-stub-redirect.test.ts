import { describe, expect, it, vi } from "vitest";

import { adminHref } from "@/lib/admin-hubs";
import { buildBookingRequestsHref } from "@/lib/admin-booking-requests-path";

const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect }));

// The two Bookings stubs stay pages (C10 #4807). Each forwards to Booking
// Requests at the registry address, with its tab and the request's other
// parameters. In-app links already open Booking Requests directly. Retiring
// the second hop, once the switch is on, is C18 (#4815).
describe("the Booking Approvals and Booking Change Requests stubs", () => {
  it("sends Booking Approvals to Booking Requests' approvals tab", async () => {
    redirect.mockClear();
    const { default: Page } = await import(
      "@/app/(admin)/admin/booking-desk/booking-approvals/page"
    );
    const params = { status: "PENDING", bookingId: "bk_1" };
    await expect(Page({ searchParams: Promise.resolve(params) })).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith(buildBookingRequestsHref("approvals", params));
    expect(buildBookingRequestsHref("approvals", params)).toBe(
      `${adminHref("booking-requests")}?tab=approvals&status=PENDING&bookingId=bk_1`,
    );
    expect(buildBookingRequestsHref("approvals", params)).not.toContain("booking-approvals");
  });

  it("sends Booking Change Requests to Booking Requests' changes tab", async () => {
    redirect.mockClear();
    const { default: Page } = await import(
      "@/app/(admin)/admin/booking-desk/booking-change-requests/page"
    );
    const params = { requestId: "request-1", tab: "approvals" };
    await expect(Page({ searchParams: Promise.resolve(params) })).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith(buildBookingRequestsHref("changes", params));
    expect(buildBookingRequestsHref("changes", params)).toBe(
      `${adminHref("booking-requests")}?tab=changes&requestId=request-1`,
    );
  });
});

describe("buildBookingRequestsHref", () => {
  it.each([false, true])(
    "starts from the registry address in both switch states (live=%s)",
    async (live) => {
      vi.resetModules();
      vi.doMock("@/lib/admin-hubs/release", () => ({ ADMIN_HUBS_LIVE: live }));
      const { buildBookingRequestsHref: build } = await import("@/lib/admin-booking-requests-path");
      const { adminHref: href } = await import("@/lib/admin-hubs");
      const built = build("approvals", {
        status: "PENDING",
        ignored: undefined,
        tab: "nope",
        list: ["a", "b"],
      });
      expect(built).toBe(
        `${href("booking-requests")}?tab=approvals&status=PENDING&list=a&list=b`,
      );
      expect(href("booking-requests")).toBe(
        live ? "/admin/booking-desk/booking-requests" : "/admin/booking-requests",
      );
    },
  );
});
