// @vitest-environment jsdom
/**
 * #4202: the booking editor's promo box is sent the same officer re-rates as
 * the quote. An officer ticks a guest as another club's member and applies a
 * code: the promo preview's `otherLodgeId`, `otherLodgeMemberGuestIds` and
 * `linkGuestToMember` must be the modification payload's, so the server clears
 * the same guest's locked prices for the box as for the quote. (No guest is
 * linked here, so `linkGuestToMember` is absent from both; the server-side
 * parity suite drives a link through both routes.)
 *
 * Frozen clock discipline: September 2026 lodge nights, after the 2026-07-01
 * freeze; the edit policy's own `today` is fixed.
 */
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const BOOKING_ID = "bk-4202";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const quoteBodies: Array<Record<string, unknown>> = [];
const validateBodies: Array<Record<string, unknown>> = [];

function installFetch() {
  quoteBodies.length = 0;
  validateBodies.length = 0;
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.includes("/api/members/family")) return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    if (url.includes("/api/age-tier-settings")) return jsonResponse({ settings: [] });
    if (url.includes("/api/promo-codes/guest-codes")) return jsonResponse({ multiPromoCodes: false, guests: [] });
    if (url.includes("/api/promo-codes/validate")) {
      validateBodies.push(body);
      return jsonResponse({ valid: false, error: "Promo code not found" }, 400);
    }
    if (url.includes("/modify-quote")) {
      quoteBodies.push(body);
      return jsonResponse({
        newTotalPriceCents: 15000,
        newDiscountCents: 0,
        newPromoAdjustmentCents: 0,
        newFinalPriceCents: 15000,
        priceDiffCents: 0,
        changeFeeCents: 0,
        netChargeCents: 0,
        settlementOptions: null,
        capacityAvailable: true,
        promoStillValid: true,
        promoCoverage: null,
        promoChangeNotApplied: null,
        promoValidation: null,
        itemizedChanges: [],
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

function makeBooking() {
  return {
    id: BOOKING_ID,
    checkIn: "2026-09-01",
    checkOut: "2026-09-04",
    guests: [
      {
        id: "g-owner",
        firstName: "Ada",
        lastName: "Owner",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-ada",
        stayStart: "2026-09-01",
        stayEnd: "2026-09-04",
        priceCents: 15000,
      },
      {
        id: "g-visitor",
        firstName: "Vic",
        lastName: "Visitor",
        ageTier: "ADULT",
        isMember: false,
        stayStart: "2026-09-01",
        stayEnd: "2026-09-04",
        priceCents: 30000,
      },
    ],
    memberId: "member-ada",
    viewerRole: "ADMIN",
    finalPriceCents: 45000,
    totalPriceCents: 45000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    promo: null,
    canEditNonMemberGuestNames: false,
    canFixNonMemberGuestNameTypos: false,
    editPolicy: {
      mode: "future" as const,
      today: "2026-08-01",
      editableFrom: null,
      checkInEditable: true,
      adminOverrideAvailable: false,
    },
    requiresAdminReview: false,
    adminReviewStatus: null,
    otherLodges: [{ id: "lodge-a", name: "Aorangi Lodge", label: "Aorangi Lodge" }],
    otherLodgeId: null,
    otherLodgeRateEligibleGuestIds: ["g-visitor"],
  };
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const RERATE_FIELDS = ["otherLodgeId", "otherLodgeMemberGuestIds", "linkGuestToMember"] as const;
const pick = (body: Record<string, unknown>) =>
  Object.fromEntries(RERATE_FIELDS.map((field) => [field, body[field]]));

describe("EditBookingPanel — the promo box is sent the quote's re-rates (#4202)", () => {
  it("an officer's other-lodge tick travels with the promo preview exactly as with the quote", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    fireEvent.click((await screen.findByText("Member of Other Lodge")).previousSibling as HTMLInputElement);
    fireEvent.change(screen.getByLabelText("Other Lodge Name"), { target: { value: "lodge-a" } });
    fireEvent.click(screen.getByLabelText("Price Vic Visitor at the other-lodge member rate"));

    await waitFor(
      () => expect(quoteBodies.some((body) => Array.isArray(body.otherLodgeMemberGuestIds))).toBe(true),
      { timeout: 2500 },
    );
    const payload = quoteBodies.at(-1)!;
    expect(pick(payload)).toEqual({
      otherLodgeId: "lodge-a",
      otherLodgeMemberGuestIds: ["g-visitor"],
      linkGuestToMember: undefined,
    });

    fireEvent.change(await screen.findByPlaceholderText("Enter promo code"), { target: { value: "SAVE" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(validateBodies.length).toBe(1));

    expect(pick(validateBodies[0]!)).toEqual(pick(payload));
  });
});
