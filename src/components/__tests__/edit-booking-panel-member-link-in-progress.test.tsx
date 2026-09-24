// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

/**
 * #2534 (folded into #2337): the "Link to member" control is hidden on an
 * in-progress (mid-stay) edit.
 *
 * The save path REFUSES a placeholder→member link mid-stay — the in-progress
 * pricing path re-rates the ORIGINAL guest rows, not the link-modified ones, so
 * an in-place re-rate would silently no-op and leave the member on the
 * non-member flat-split price. #2337 added that refusal at quote time; this
 * pins the matching UX fence so an officer never reaches a control that can
 * only ever return a quote-time refusal. The working mid-stay route is
 * remove-and-re-add, which settles correctly.
 *
 * The two cases are one property with the mode flipped: FUTURE offers the
 * control, IN-PROGRESS hides it, everything else about the booking held equal.
 */

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchCalls: { url: string }[];

function installFetch() {
  fetchCalls = [];
  global.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    fetchCalls.push({ url });
    if (url.includes("family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/age-tier-settings")) {
      return jsonResponse({ settings: [] });
    }
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;
}

/**
 * A MEMBER whole-lodge booking, viewed by an admin, with an unnamed placeholder
 * guest — the exact audience + booking class the placeholder→member link is
 * fenced to. `mode` is the only thing the two tests vary.
 */
function makeWholeLodgeBooking(mode: "future" | "in-progress") {
  return {
    id: "bk-2534",
    checkIn: "2026-09-01",
    checkOut: "2026-09-05",
    guests: [
      {
        id: "g1",
        firstName: "Guest",
        lastName: "1",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 12000,
      },
      {
        id: "g2",
        firstName: "Guest",
        lastName: "2",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 12000,
      },
    ],
    viewerRole: "ADMIN",
    finalPriceCents: 24000,
    totalPriceCents: 24000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    promo: null,
    canEditNonMemberGuestNames: true,
    canFixNonMemberGuestNameTypos: true,
    editPolicy: {
      mode,
      today: "2026-08-15",
      editableFrom: null,
      checkInEditable: mode === "future",
      adminOverrideAvailable: false,
    },
    requiresAdminReview: false,
    adminReviewStatus: null,
    memberGuest: {
      enabled: true,
      openSearchEnabled: true,
      approvalRequired: true,
    },
    memberWholeLodge: true,
  };
}

beforeEach(() => {
  routerRefresh.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#2534: placeholder→member link control is fenced to future edits", () => {
  it("offers 'Link to member' on a FUTURE member whole-lodge booking", async () => {
    installFetch();
    render(
      <EditBookingPanel
        booking={makeWholeLodgeBooking("future")}
        onDone={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url.includes("family"))).toBe(true),
    );

    expect(
      screen.getAllByRole("button", { name: "Link to member" }).length,
    ).toBeGreaterThan(0);
  });

  it("HIDES 'Link to member' on an IN-PROGRESS (mid-stay) booking", async () => {
    installFetch();
    render(
      <EditBookingPanel
        booking={makeWholeLodgeBooking("in-progress")}
        onDone={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url.includes("family"))).toBe(true),
    );

    // The mid-stay re-rate is out of scope and the save path refuses it, so the
    // officer is never offered the control — they use remove-and-re-add.
    expect(
      screen.queryByRole("button", { name: "Link to member" }),
    ).toBeNull();
  });
});
