// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

// #2124: on an in-progress stay the change-dates UI must keep the original
// (past) check-in fixed and let the member extend the check-out night by night
// from the editable-from date, with copy that explains the minimum-stay rule
// applies to the whole stay (not the added nights).

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const BOOKING_ID = "bk-2124";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(quoteOverrides: Record<string, unknown> = {}) {
  global.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/age-tier-settings")) {
      return jsonResponse({ settings: [] });
    }
    if (url.includes("/modify-quote")) {
      return jsonResponse({
        newTotalPriceCents: 30000,
        newDiscountCents: 0,
        newPromoAdjustmentCents: 0,
        newFinalPriceCents: 30000,
        priceDiffCents: 0,
        changeFeeCents: 0,
        netChargeCents: 0,
        settlementOptions: null,
        capacityAvailable: true,
        minimumStayValid: true,
        minimumStayViolations: [],
        promoStillValid: true,
        promoValidation: null,
        itemizedChanges: [],
        ...quoteOverrides,
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

// In-progress booking: check-in 2026-08-14 is in the past, editable-from is
// tomorrow (2026-08-16), so the member can only extend the check-out forward.
function inProgressBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    checkIn: "2026-08-14",
    checkOut: "2026-08-18",
    guests: [
      {
        id: "g1",
        firstName: "Mel",
        lastName: "Member",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 30000,
      },
    ],
    viewerRole: "MEMBER",
    finalPriceCents: 30000,
    totalPriceCents: 30000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    promo: null,
    canEditNonMemberGuestNames: false,
    canFixNonMemberGuestNameTypos: false,
    editPolicy: {
      mode: "in-progress" as const,
      today: "2026-08-15",
      editableFrom: "2026-08-16",
      checkInEditable: false,
      adminOverrideAvailable: false,
    },
    requiresAdminReview: false,
    adminReviewStatus: null,
    ...overrides,
  };
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditBookingPanel — in-progress date extension (#2124)", () => {
  it("renders the check-in fixed at the original past date", () => {
    render(
      <EditBookingPanel booking={inProgressBooking()} onDone={vi.fn()} />,
    );

    const checkIn = screen.getByLabelText("Check-in") as HTMLInputElement;
    expect(checkIn).toBeDisabled();
    expect(checkIn.value).toBe("2026-08-14");
  });

  it("lets the check-out extend forward from the editable-from date", () => {
    render(
      <EditBookingPanel booking={inProgressBooking()} onDone={vi.fn()} />,
    );

    const checkOut = screen.getByLabelText("Check-out") as HTMLInputElement;
    expect(checkOut).not.toBeDisabled();
    // The earliest selectable check-out is the editable-from (tomorrow) date,
    // so today and earlier stay locked.
    expect(checkOut.min).toBe("2026-08-16");
    expect(checkOut.value).toBe("2026-08-18");
  });

  it("explains that the check-in is fixed and minimum-stay applies to the whole stay", () => {
    render(
      <EditBookingPanel booking={inProgressBooking()} onDone={vi.fn()} />,
    );

    expect(
      screen.getByText(/check-in date stays fixed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/minimum-stay rules apply to your whole stay/i),
    ).toBeInTheDocument();
  });

  it("renders the advisory warning when a quote flags the whole stay under a minimum", async () => {
    // #2124 review: the verdict must be VISIBLE to the member. It is advisory
    // only — Save is not gated on it (pinned below), matching the future-edit
    // semantics; the hard block lives on the create path.
    installFetch({
      minimumStayValid: false,
      minimumStayViolations: [
        { message: "Stays including a Friday or Saturday night must be at least 2 nights." },
      ],
    });
    render(
      <EditBookingPanel booking={inProgressBooking()} onDone={vi.fn()} />,
    );

    const checkOut = screen.getByLabelText("Check-out") as HTMLInputElement;
    // Shorten to the earliest allowed check-out to trigger a fresh quote.
    fireEvent.change(checkOut, { target: { value: "2026-08-16" } });

    expect(
      await screen.findByText(
        /leave your stay under a minimum-stay rule/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/at least 2 nights/i),
    ).toBeInTheDocument();
    // Advisory only: Save stays enabled despite the flagged minimum.
    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeEnabled();
  });
});
