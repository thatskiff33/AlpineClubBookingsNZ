// @vitest-environment jsdom

/*
 * #2701 owner decision 1 — a member ALWAYS sees which lodge they are booking,
 * and cannot complete a booking whose lodge is unknown.
 *
 * The defect these pin is the one that reached money. `/api/lodges` failing
 * empties the lodge list; `LodgeSelect` renders nothing at all below two lodges
 * (ADR-002) and normalises the selection to `null`; the review step's "Lodge:"
 * line was suppressed by that SAME emptiness; and the wizard then posted no
 * lodge, which the server resolved to the club's default. A member of a
 * three-lodge club could confirm and pay with nothing on screen naming a lodge.
 *
 * The assertion that matters is the ABSENCE OF A REQUEST. A test that checks an
 * error message appears would pass just as happily while the booking was
 * created anyway.
 */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";
import { ReviewStep } from "@/app/(authenticated)/book/_components/review-step";

const LODGE = { id: "lodge-2", name: "River Lodge" };

function renderReview(overrides: Record<string, unknown>) {
  // The review step takes a wide prop surface; only the lodge-naming half is
  // under test, so every list is empty and every setter is inert.
  const props = {
    checkIn: "2026-08-01",
    checkOut: "2026-08-03",
    nights: 2,
    guests: [],
    priceQuote: {
      totalPriceCents: 0,
      deferredGuestPortionCents: 0,
      guests: [],
      nonMemberHoldDecision: null,
      paidUpAdultMemberMissing: false,
      subscriptionMemberRateNotice: null,
    },
    lodges: [LODGE],
    lodgeId: LODGE.id,
    selectedLodge: LODGE,
    reviewGuestPayload: [],
    bookingDateStrings: [],
    perGuestDatesEnabled: false,
    appliedPromo: null,
    setAppliedPromo: vi.fn(),
    availableCreditCents: 0,
    appliedCreditCents: 0,
    remainingToPay: 0,
    useCredit: false,
    setUseCredit: vi.fn(),
    groupTrip: false,
    groupBookingsEnabled: false,
    groupPaymentMode: "individual",
    showPaymentMethodChoice: false,
    paymentMethod: "card",
    setPaymentMethod: vi.fn(),
    internetBankingEnabled: false,
    internetBankingUnavailableReason: null,
    internetBankingHoldSummary: null,
    cardPaymentDescription: "",
    internetBankingPaymentDescription: "",
    internetBankingUnavailableCopy: "",
    notes: "",
    setNotes: vi.fn(),
    requiresAdminReviewLocal: false,
    memberReviewJustification: "",
    setMemberReviewJustification: vi.fn(),
    expectedArrivalTime: "",
    setExpectedArrivalTime: vi.fn(),
    roomRequestEnabled: false,
    roomOptions: [],
    requestedRoomId: null,
    setRequestedRoomId: vi.fn(),
    activeWorkPartyEvents: [],
    attendingWorkParty: false,
    setAttendingWorkParty: vi.fn(),
    selectedWorkPartyEventId: null,
    setSelectedWorkPartyEventId: vi.fn(),
    workPartyError: "",
    setWorkPartyError: vi.fn(),
    workPartyClearedNotice: null,
    setWorkPartyClearedNotice: vi.fn(),
    availablePromoCodes: [],
    promoCodesEnabled: false,
    prefillPromoCode: "",
    setPrefillPromoCode: vi.fn(),
    cancelIfGuestsBumped: false,
    setCancelIfGuestsBumped: vi.fn(),
    setStep: vi.fn(),
    handleSaveAsDraft: vi.fn(),
    submitting: false,
    onSubmit: vi.fn(),
    handleSubmit: vi.fn(),
    ...overrides,
  } as unknown as Parameters<typeof ReviewStep>[0];
  return render(<ReviewStep {...props} />);
}

describe("member booking review — the lodge is always named (#2701)", () => {
  it("names the lodge in a SINGLE-lodge club", () => {
    // MUTATION PROBE: restore the `lodges.length > 1 &&` condition on this line
    // and only this test fails. That condition is precisely what made an
    // outage indistinguishable from a one-lodge club — the state where the
    // line vanished was the state where it was most needed.
    renderReview({ lodges: [LODGE] });

    expect(screen.getByText("Lodge:")).toBeInTheDocument();
    expect(screen.getByText("River Lodge")).toBeInTheDocument();
  });

  it("names the lodge in a multi-lodge club", () => {
    renderReview({
      lodges: [LODGE, { id: "lodge-1", name: "Alpine Lodge" }],
    });

    expect(screen.getByText("Lodge:")).toBeInTheDocument();
    expect(screen.getByText("River Lodge")).toBeInTheDocument();
  });

  it("says the lodge is not known rather than showing nothing", () => {
    // The outage shape: an empty list and no selection. The summary must not
    // silently omit the line, because that is what it used to do.
    renderReview({ lodges: [], selectedLodge: null });

    expect(screen.getByText("Lodge:")).toBeInTheDocument();
    expect(screen.getByText("Not yet known")).toBeInTheDocument();
  });
});
