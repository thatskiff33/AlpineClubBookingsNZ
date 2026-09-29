// @vitest-environment jsdom

import { render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BookingRequestVerifyClient } from "@/app/(website-dynamic)/booking-requests/verify/[token]/booking-request-verify-client";

/**
 * The confirmation screen must name the lodge the request is FOR, not the club's
 * default lodge — it used to contradict its own detail block two lines below,
 * saying "your booking request with <default lodge>" above "Lodge: <the other
 * one>".
 *
 * `clubLodgeName` stays the fallback rather than being removed: under the
 * ADR-002 presentation rule the API omits `lodgeName` when the club has fewer
 * than two active lodges, and that is exactly when the club-level name is right.
 */

function mockVerifyResponse(body: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    }),
  );
}

describe("booking-request verify screen names the requested lodge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the request's own lodge, not the club default", async () => {
    mockVerifyResponse({
      outcome: "verified",
      lodgeName: "Second Lodge",
      checkIn: "2026-09-01",
      checkOut: "2026-09-04",
      guestCount: 3,
    });

    render(
      <BookingRequestVerifyClient token="tok-1" clubLodgeName="Default Lodge" />,
    );

    const prose = await screen.findByText(/Thanks for your booking request with/);
    expect(prose.textContent).toContain("Second Lodge");
    // The specific regression: the club default appearing in the sentence while
    // the detail block below names a different lodge.
    expect(prose.textContent).not.toContain("Default Lodge");
  });

  it("falls back to the club lodge name when the API omits one (single-lodge club)", async () => {
    mockVerifyResponse({
      outcome: "verified",
      checkIn: "2026-09-01",
      checkOut: "2026-09-04",
      guestCount: 3,
    });

    render(
      <BookingRequestVerifyClient token="tok-2" clubLodgeName="Default Lodge" />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Thanks for your booking request with/).textContent,
      ).toContain("Default Lodge");
    });
  });
});
