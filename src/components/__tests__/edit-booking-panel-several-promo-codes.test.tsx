// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

// #3828 (review E1): a booking carrying several promo codes reaches the panel
// as `promo: null` plus `promoLines`. The one-code card would read that as "no
// code — apply one", and applying would send the legacy one-code request, which
// replaces every code on the booking. The card is locked instead, and the
// codes are shown read-only.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  global.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/age-tier-settings")) return jsonResponse({ settings: [] });
    return jsonResponse({});
  }) as unknown as typeof fetch;
});

function makeBooking(promo: {
  promo: { code: string; type: string; description: string | null } | null;
  promoLines?: Array<{ code: string; type: string; description: string | null; amountCents: number }>;
}) {
  return {
    id: "bk-3828",
    checkIn: "2026-09-01",
    checkOut: "2026-09-03",
    guests: [
      {
        id: "g1",
        firstName: "Ann",
        lastName: "Hughes",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-ann",
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 5000,
      },
    ],
    viewerRole: "MEMBER",
    finalPriceCents: 7000,
    totalPriceCents: 12000,
    discountCents: 5000,
    promoAdjustmentCents: -5000,
    ...promo,
    canEditNonMemberGuestNames: true,
    canFixNonMemberGuestNameTypos: true,
    editPolicy: {
      mode: "future" as const,
      today: "2026-08-01",
      editableFrom: null,
      checkInEditable: true,
      adminOverrideAvailable: false,
    },
    requiresAdminReview: false,
    adminReviewStatus: null,
  };
}

describe("EditBookingPanel on a several-code booking (#3828)", () => {
  it("locks the one-code controls and shows the codes read-only", () => {
    render(
      <EditBookingPanel
        booking={makeBooking({
          promo: null,
          promoLines: [
            { code: "SPRING10", type: "PERCENTAGE", description: null, amountCents: -3000 },
            { code: "GUESTFREE", type: "FREE_NIGHTS", description: null, amountCents: -2000 },
          ],
        })}
        onDone={vi.fn()}
      />,
    );

    expect(screen.getByText("Promo Codes")).toBeInTheDocument();
    expect(screen.getByText("SPRING10")).toBeInTheDocument();
    expect(screen.getByText("GUESTFREE")).toBeInTheDocument();
    expect(screen.getByText(/can't be added, removed or swapped here yet/)).toBeInTheDocument();
    // No one-code card: nothing to apply, remove or replace a code with.
    expect(screen.queryByText("Promo Code")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply/i })).not.toBeInTheDocument();
  });

  it("keeps a one-code booking's card as it was", () => {
    render(
      <EditBookingPanel
        booking={makeBooking({
          promo: { code: "SPRING10", type: "PERCENTAGE", description: null },
        })}
        onDone={vi.fn()}
      />,
    );

    expect(screen.getByText("Promo Code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(screen.queryByText("Promo Codes")).not.toBeInTheDocument();
  });
});
