// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

// #2363. The minimum-stay banner in this panel has always been advisory (#2124)
// and the save endpoint never checked the rule at all, so a member could read
// the warning, press Save, and the shortened stay was written anyway.
//
// The server is now authoritative: PUT /api/bookings/[id]/modify refuses a
// non-admin save that breaks the rule. Save deliberately stays ENABLED — a
// stale or missing quote must never decide the outcome — so the panel's job is
// to explain the refusal when it comes back, naming the rule rather than
// showing "Failed to save changes".

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

const BOOKING_ID = "bk-2363";

const VIOLATION = {
  reasonCode: "MINIMUM_STAY",
  policyId: "policy-weekend",
  policyVersion: 3,
  policyName: "Weekend minimum",
  resolvedScope: {
    kind: "CLUB_WIDE",
    lodgeId: null,
    effectiveLodgeId: "lodge-1",
  },
  affectedNights: ["2026-09-04"],
  exceptionEligible: true,
  capacityMode: "HOLD",
  message:
    "Bookings including a Friday night require a minimum stay of 2 nights (Weekend minimum). Your booking is 1 night.",
  triggerDay: "Friday",
  minimumNights: 2,
  actualNights: 1,
  requirements: {
    kind: "MINIMUM_STAY",
    minimumNights: 2,
    actualNights: 1,
    triggerDays: [5],
  },
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function quotePayload() {
  return {
    newTotalPriceCents: 5000,
    newDiscountCents: 0,
    newPromoAdjustmentCents: 0,
    newFinalPriceCents: 5000,
    priceDiffCents: -5000,
    changeFeeCents: 0,
    netChargeCents: -5000,
    settlementOptions: null,
    capacityAvailable: true,
    minimumStayValid: false,
    minimumStayViolations: [VIOLATION],
    exceptionReview: { violations: [VIOLATION], capacityMode: "HOLD" },
    promoStillValid: true,
    promoCoverage: null,
    promoValidation: null,
    itemizedChanges: [],
  };
}

let modifyResponse: () => Response;

function installFetch() {
  modifyResponse = () =>
    jsonResponse(
      {
        error: "Two nights are required on a Friday.",
        code: "MINIMUM_STAY_VIOLATION",
        details: "Two nights are required on a Friday.",
        violations: [VIOLATION],
        exceptionReview: { violations: [VIOLATION], capacityMode: "HOLD" },
      },
      400,
    );
  global.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/age-tier-settings")) {
      return jsonResponse({ settings: [] });
    }
    if (url.includes("/modify-quote")) {
      return jsonResponse(quotePayload());
    }
    if (url.endsWith(`/api/bookings/${BOOKING_ID}/modify`)) {
      return modifyResponse();
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

function makeBooking() {
  return {
    id: BOOKING_ID,
    checkIn: "2026-09-04",
    checkOut: "2026-09-06",
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
    finalPriceCents: 10000,
    totalPriceCents: 10000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    promo: null,
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

async function shortenStayAndWaitForSave() {
  fireEvent.change(screen.getByLabelText(/Check-out/i), {
    target: { value: "2026-09-05" },
  });
  const saveButton = screen.getByRole("button", { name: "Save Changes" });
  await waitFor(() => expect(saveButton).not.toBeDisabled(), { timeout: 2500 });
  return saveButton;
}

beforeEach(() => {
  installFetch();
  routerRefresh.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditBookingPanel — minimum stay (#2363)", () => {
  it("keeps Save enabled while warning: the server, not the quote, decides", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    const saveButton = await shortenStayAndWaitForSave();

    expect(
      screen.getByText(/would leave your stay under a minimum-stay rule/i),
    ).toBeInTheDocument();
    expect(saveButton).not.toBeDisabled();
  });

  it("names the rule when the save is refused, instead of a generic failure", async () => {
    const onDone = vi.fn();
    render(<EditBookingPanel booking={makeBooking()} onDone={onDone} />);

    const saveButton = await shortenStayAndWaitForSave();
    fireEvent.click(saveButton);

    const refusal = await screen.findByText(
      /do not meet the minimum-stay rules/i,
    );
    // The rule itself is quoted in the refusal, not just "it failed".
    expect(refusal).toHaveTextContent("require a minimum stay of 2 nights");
    expect(refusal).toHaveTextContent("Weekend minimum");
    expect(screen.queryByText("Failed to save changes")).toBeNull();
    // The edit was refused, so the panel stays open on the member's changes.
    expect(onDone).not.toHaveBeenCalled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("falls back to the server's own sentence if no violations ride the refusal", async () => {
    modifyResponse = () =>
      jsonResponse(
        {
          error: "Two nights are required on a Friday.",
          code: "MINIMUM_STAY_VIOLATION",
        },
        400,
      );

    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);
    const saveButton = await shortenStayAndWaitForSave();
    fireEvent.click(saveButton);

    expect(
      await screen.findByText("Two nights are required on a Friday."),
    ).toBeInTheDocument();
  });
});
