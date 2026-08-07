// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewStep } from "@/app/(authenticated)/book/_components/review-step";
import type { PriceQuote } from "@/app/(authenticated)/book/_components/types";
import type { GuestData } from "@/components/guest-form";
import { sumDeferredGuestPortionCents } from "@/lib/deferred-guest-portion";
import { formatMissingPaidUpAdultRefusal } from "@/lib/policies/subscription-lockout-pricing";

vi.mock("@/components/promo-code-input", () => ({
  PromoCodeInput: () => <div data-testid="promo-code-input" />,
}));

const memberGuest: GuestData = {
  firstName: "Sam",
  lastName: "Skier",
  ageTier: "ADULT",
  isMember: true,
  memberId: "member-self",
};
const nonMemberGuest: GuestData = {
  firstName: "Robin",
  lastName: "Visitor",
  ageTier: "ADULT",
  isMember: false,
};

function buildQuote(
  guests: GuestData[],
  hold?: PriceQuote["nonMemberHoldDecision"],
): PriceQuote {
  return {
    guests: guests.map((g) => ({
      ageTier: g.ageTier,
      isMember: g.isMember,
      nights: 2,
      priceCents: g.isMember ? 8000 : 12000,
    })),
    totalPriceCents: guests.reduce(
      (sum, g) => sum + (g.isMember ? 8000 : 12000),
      0,
    ),
    nonMemberHoldDecision: hold,
  };
}

function renderReview(
  guests: GuestData[],
  hold?: PriceQuote["nonMemberHoldDecision"],
  overrides: Partial<ComponentProps<typeof ReviewStep>> = {},
) {
  const priceQuote = buildQuote(guests, hold);
  return render(
    <ReviewStep
      checkIn="2026-07-20"
      checkOut="2026-07-22"
      nights={2}
      memberGuestPendingHoldExpiryDays={7}
      guests={guests}
      priceQuote={priceQuote}
      lodges={[]}
      lodgeId={null}
      selectedLodge={null}
      reviewGuestPayload={guests}
      bookingDateStrings={{ checkIn: "2026-07-20", checkOut: "2026-07-22" }}
      perGuestDatesEnabled={false}
      appliedPromo={null}
      setAppliedPromo={vi.fn()}
      availableCreditCents={0}
      appliedCreditCents={0}
      remainingToPay={priceQuote.totalPriceCents}
      useCredit={false}
      setUseCredit={vi.fn()}
      groupTrip={false}
      groupBookingsEnabled={false}
      groupPaymentMode="EACH_PAYS_OWN"
      showPaymentMethodChoice={false}
      paymentMethod="stripe"
      setPaymentMethod={vi.fn()}
      internetBankingEnabled={false}
      internetBankingUnavailableReason={null}
      internetBankingHoldSummary={null}
      cardPaymentDescription=""
      internetBankingPaymentDescription=""
      internetBankingUnavailableCopy=""
      notes=""
      setNotes={vi.fn()}
      requiresAdminReviewLocal={false}
      memberReviewJustification=""
      setMemberReviewJustification={vi.fn()}
      roomRequestEnabled={false}
      roomOptions={[]}
      requestedRoomId={null}
      setRequestedRoomId={vi.fn()}
      activeWorkPartyEvents={[]}
      attendingWorkParty={false}
      setAttendingWorkParty={vi.fn()}
      selectedWorkPartyEventId={null}
      setSelectedWorkPartyEventId={vi.fn()}
      workPartyError=""
      setWorkPartyError={vi.fn()}
      workPartyClearedNotice={null}
      setWorkPartyClearedNotice={vi.fn()}
      availablePromoCodes={[]}
      promoCodesEnabled={false}
      prefillPromoCode={undefined}
      setPrefillPromoCode={vi.fn()}
      cancelIfGuestsBumped={false}
      setCancelIfGuestsBumped={vi.fn()}
      setStep={vi.fn()}
      // #2562: no refusal has happened in these fixtures, so no request is on
      // offer and the card is not drawn.
      exceptionOffer={null}
      replaceExceptionRequestId={null}
      submitExceptionRequest={vi.fn()}
      handleSaveAsDraft={vi.fn()}
      handleSubmit={vi.fn()}
      submitting={false}
      savingDraft={false}
      {...overrides}
    />,
  );
}

const splitHold: PriceQuote["nonMemberHoldDecision"] = {
  enabled: true,
  holdDays: 7,
  source: "default",
  daysUntilCheckIn: 30,
  shouldBePending: true,
  status: "PAYMENT_PENDING",
};

describe("ReviewStep split provisional copy (#1942)", () => {
  it("explains the split when the party mixes member and non-member guests outside the hold window", () => {
    renderReview([memberGuest, nonMemberGuest], splitHold);

    expect(
      screen.getByText(/non-member guests are held provisionally/i),
    ).toBeInTheDocument();
    // Names the provisional guest (the <strong> holds exactly the name, while
    // the guest row renders "Robin Visitor (ADULT, Non-member)").
    expect(screen.getByText("Robin Visitor")).toBeInTheDocument();
    expect(screen.getByText(/Held provisionally:/i)).toBeInTheDocument();
    // States today's charge covers only the member portion.
    expect(
      screen.getByText(/Today you only pay for the member places/i),
    ).toBeInTheDocument();
    // Shows the guest-portion sub-amount derived from the quote ($120.00) and
    // frames it as the non-member-rate portion not charged today — without
    // anchoring on "the total above" (which is the net remainingToPay). FIX 3.
    expect(
      screen.getByText(/at non-member rates\) are not charged today/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/\$120\.00/).length).toBeGreaterThanOrEqual(1);
    // Honest later-charge wording: saved payment method, not "the same card",
    // with a fallback promise if we cannot take payment. FIX 2.
    expect(
      screen.getByText(/take the non-member portion from your saved payment method/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/contact you to arrange it/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/the same card/i),
    ).not.toBeInTheDocument();
    // Explains the "why" using the hold-days from the quote.
    expect(screen.getByText(/more than 7 days away/i)).toBeInTheDocument();
  });

  it("renders the deferred guest portion from the single owner, not an ad-hoc sum (#2003)", () => {
    // A composition with odd, non-round per-guest cents (two non-members) so
    // the banner's figure is the exact integer sum the shared owner produces —
    // the same figure the pay step shows for this composition.
    const secondNonMember: GuestData = {
      firstName: "Alex",
      lastName: "Guest",
      ageTier: "CHILD",
      isMember: false,
    };
    const guests = [memberGuest, nonMemberGuest, secondNonMember];
    const priceQuote: PriceQuote = {
      guests: [
        { ageTier: "ADULT", isMember: true, nights: 3, priceCents: 24000 },
        { ageTier: "ADULT", isMember: false, nights: 3, priceCents: 12999 },
        { ageTier: "CHILD", isMember: false, nights: 3, priceCents: 8331 },
      ],
      totalPriceCents: 24000 + 12999 + 8331,
      nonMemberHoldDecision: splitHold,
    };
    const expectedCents = sumDeferredGuestPortionCents(priceQuote.guests);
    expect(expectedCents).toBe(12999 + 8331); // 21330 → $213.30

    renderReview(guests, splitHold, {
      priceQuote,
      reviewGuestPayload: guests,
      remainingToPay: priceQuote.totalPriceCents,
    });

    // The banner renders the owner's figure ($213.30), not the party total.
    expect(screen.getAllByText(/\$213\.30/).length).toBeGreaterThanOrEqual(1);
  });

  it("prefers the server deferredGuestPortionCents over the whole-party sum, so a group discount cannot under-quote the banner (#2003)", () => {
    // Under a group discount the whole-party quote's non-member rows are
    // discounted ($90.00 each → $180.00), but the split child is charged the
    // non-member subset alone, which is NOT discounted ($259.98). The server
    // sends deferredGuestPortionCents = the subset figure; the banner must show
    // THAT (what is actually charged), never the lower whole-party sum.
    const secondNonMember: GuestData = {
      firstName: "Alex",
      lastName: "Guest",
      ageTier: "ADULT",
      isMember: false,
    };
    const guests = [memberGuest, nonMemberGuest, secondNonMember];
    const priceQuote: PriceQuote = {
      guests: [
        { ageTier: "ADULT", isMember: true, nights: 3, priceCents: 9000 },
        { ageTier: "ADULT", isMember: false, nights: 3, priceCents: 9000 },
        { ageTier: "ADULT", isMember: false, nights: 3, priceCents: 9000 },
      ],
      totalPriceCents: 27000,
      // The server-priced non-member subset (undiscounted): the real charge.
      deferredGuestPortionCents: 25998,
      nonMemberHoldDecision: splitHold,
    };
    // The naive whole-party sum would have shown the discounted $180.00.
    expect(sumDeferredGuestPortionCents(priceQuote.guests)).toBe(18000);

    renderReview(guests, splitHold, {
      priceQuote,
      reviewGuestPayload: guests,
      remainingToPay: priceQuote.totalPriceCents,
    });

    // The banner shows the server figure ($259.98), NOT the discounted sum.
    expect(screen.getAllByText(/\$259\.98/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/\$180\.00/)).not.toBeInTheDocument();
  });

  it("shows no provisional copy for an all-member party (no split)", () => {
    renderReview([memberGuest], undefined);

    expect(
      screen.queryByText(/held provisionally/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Today you only pay for the member places/i),
    ).not.toBeInTheDocument();
  });

  it("shows no provisional copy inside the hold window (shouldBePending false)", () => {
    renderReview([memberGuest, nonMemberGuest], {
      ...splitHold,
      daysUntilCheckIn: 3,
      shouldBePending: false,
    });

    expect(
      screen.queryByText(/held provisionally/i),
    ).not.toBeInTheDocument();
  });

  it("uses the single-hold copy (not split copy) for an all-non-member provisional party", () => {
    renderReview([nonMemberGuest], splitHold);

    expect(
      screen.getByText(/held provisionally until closer to check-in/i),
    ).toBeInTheDocument();
    // Not the split-specific member-portion wording.
    expect(
      screen.queryByText(/Today you only pay for the member places/i),
    ).not.toBeInTheDocument();
  });

  it("shows no split banner when 'Only book if my guests can come' is ticked (server keeps the whole party as one provisional booking) — FIX 1", () => {
    renderReview([memberGuest, nonMemberGuest], splitHold, {
      cancelIfGuestsBumped: true,
    });

    // The split banner's up-front-charge claims would be false on the flagged
    // path (one PENDING booking, nothing charged now), so it must not show.
    expect(
      screen.queryByText(/Today you only pay for the member places/i),
    ).not.toBeInTheDocument();
    // The adjacent checkbox copy (nothing charged up front) stays coherent: the
    // whole-party single-hold notice is shown instead.
    expect(
      screen.getByText(/held provisionally until closer to check-in/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Only book if my guests can come/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/nothing is charged up front/i),
    ).toBeInTheDocument();
  });

  it("keeps the guest-portion copy coherent when a promo drops the net total below the gross guest portion — FIX 3", () => {
    // Net remainingToPay ($60) is now BELOW the gross non-member portion
    // ($120), so the old "$X of the total above" phrasing would have implied
    // more than the whole total. The rephrased copy anchors on non-member
    // rates instead of "the total above", staying self-consistent.
    renderReview([memberGuest, nonMemberGuest], splitHold, {
      appliedPromo: {
        code: "SAVE",
        description: null,
        type: "PERCENT",
        discountCents: 14000,
        promoAdjustmentCents: -14000,
        totalPriceCents: 20000,
        finalPriceCents: 6000,
      },
      remainingToPay: 6000,
    });

    expect(
      screen.getByText(/at non-member rates\) are not charged today/i),
    ).toBeInTheDocument();
    // The gross guest portion is still shown ($120.00) but no longer framed as
    // a slice of "the total above".
    expect(
      screen.queryByText(/of the total above is for your non-member guests/i),
    ).not.toBeInTheDocument();
  });

  it("names the hold deadline with DST-immune date-only arithmetic (#2474)", () => {
    // The hold deadline is check-in minus the policy hold-days. Derived from the
    // date-only lodge night with UTC day arithmetic (addDaysDateOnly), it names
    // the correct night even across an NZ daylight-saving change — where the old
    // `checkIn.getTime() - days * 86_400_000` millisecond subtraction landed off
    // midnight and could roll the day. Check-in 7 Apr 2026 minus the 7-day hold
    // is 31 Mar 2026, and the range spans the 5 Apr 2026 NZ DST-end boundary.
    renderReview([memberGuest, nonMemberGuest], splitHold, {
      checkIn: "2026-04-07",
      checkOut: "2026-04-09",
    });

    expect(
      screen.getByText(/If beds are still available around \w+, 31 Mar 2026/),
    ).toBeInTheDocument();
  });

  it("shows no split banner when the booking is held for admin review — FIX 1", () => {
    renderReview([memberGuest, nonMemberGuest], splitHold, {
      requiresAdminReviewLocal: true,
      memberReviewJustification: "No adult can attend.",
    });

    // Admin-review bookings are never split — the whole party waits in review.
    expect(
      screen.queryByText(/Today you only pay for the member places/i),
    ).not.toBeInTheDocument();
    // The whole-party-hold fallback copy is shown instead of the split banner.
    expect(
      screen.getByText(/held provisionally until closer to check-in/i),
    ).toBeInTheDocument();
  });
});

// The server's sentence, deliberately NOT the real wording: the review step must
// render whatever the quote hands it, verbatim, so a fixture that could not have
// been produced client-side proves the component is not rebuilding the copy.
const SERVER_RATE_NOTICE =
  "One person on this booking has an unpaid 2026/2027 membership subscription, so member rates aren't available for their nights.";

describe("ReviewStep subscription-lockout notices (#2543)", () => {
  function quoteWith(extra: Partial<PriceQuote>): PriceQuote {
    return { ...buildQuote([memberGuest]), ...extra };
  }

  it("renders the server's member-rate notice verbatim when the quote carries one", () => {
    const priceQuote = quoteWith({
      subscriptionMemberRateNotice: SERVER_RATE_NOTICE,
    });
    renderReview([memberGuest], undefined, { priceQuote });

    const notice = screen.getByTestId("subscription-member-rate-notice");
    expect(notice).toHaveTextContent(SERVER_RATE_NOTICE);
  });

  it("renders no member-rate notice when the quote returns null", () => {
    const priceQuote = quoteWith({ subscriptionMemberRateNotice: null });
    renderReview([memberGuest], undefined, { priceQuote });

    expect(
      screen.queryByTestId("subscription-member-rate-notice"),
    ).not.toBeInTheDocument();
  });

  it("renders no member-rate notice on an older cached quote that omits the field", () => {
    // Absent must behave exactly as null — a response predating the field must
    // not fall through to some other rendering.
    renderReview([memberGuest], undefined, { priceQuote: quoteWith({}) });

    expect(
      screen.queryByTestId("subscription-member-rate-notice"),
    ).not.toBeInTheDocument();
  });

  it("warns with the server's own refusal sentence when no paid-up adult member is on the party", () => {
    const priceQuote = quoteWith({ paidUpAdultMemberMissing: true });
    renderReview([memberGuest], undefined, { priceQuote });

    const warning = screen.getByTestId("paid-up-adult-missing-notice");
    // Identical to the sentence the write paths refuse with, so the warning and
    // the refusal can never say different things.
    expect(warning).toHaveTextContent(formatMissingPaidUpAdultRefusal());
    // It names both escape routes rather than only stating the problem.
    expect(warning).toHaveTextContent(/Renew a subscription/i);
    expect(warning).toHaveTextContent(
      /add an adult member whose subscription is paid/i,
    );
  });

  it("shows the warning without a disclosure: it is in the document on first render", () => {
    // The whole point is warning BEFORE the rest of the wizard is filled in, so
    // it must never be hidden behind a "show details" affordance.
    const priceQuote = quoteWith({ paidUpAdultMemberMissing: true });
    renderReview([memberGuest], undefined, { priceQuote });

    const warning = screen.getByTestId("paid-up-adult-missing-notice");
    expect(warning).toBeVisible();
    // Announced assertively (the shared Alert's warning variant), not silently.
    expect(warning).toHaveAttribute("role", "alert");
  });

  it("warns the unfinancial BOOKER even though nothing on the party was repriced", () => {
    // Owner decision 3 Aug 2026 widened the server's trigger: the requirement also
    // fires when the person BOOKING has an unpaid subscription, whether or not they
    // are staying. A member booking beds for a party of non-members therefore gets
    // this flag with a NULL rate notice — nobody's nights were repriced, so there is
    // no price to explain — and this warning is the only thing standing between them
    // and a 409 on submit. Pinned because coupling the warning to the notice would
    // silence exactly that case.
    const priceQuote = quoteWith({
      paidUpAdultMemberMissing: true,
      subscriptionMemberRateNotice: null,
    });
    renderReview([memberGuest], undefined, { priceQuote });

    expect(
      screen.getByTestId("paid-up-adult-missing-notice"),
    ).toHaveTextContent(formatMissingPaidUpAdultRefusal());
    expect(
      screen.queryByTestId("subscription-member-rate-notice"),
    ).not.toBeInTheDocument();
  });

  it("renders no paid-up-adult warning when the flag is false", () => {
    const priceQuote = quoteWith({ paidUpAdultMemberMissing: false });
    renderReview([memberGuest], undefined, { priceQuote });

    expect(
      screen.queryByTestId("paid-up-adult-missing-notice"),
    ).not.toBeInTheDocument();
  });

  it("renders no paid-up-adult warning on an older cached quote that omits the field", () => {
    renderReview([memberGuest], undefined, { priceQuote: quoteWith({}) });

    expect(
      screen.queryByTestId("paid-up-adult-missing-notice"),
    ).not.toBeInTheDocument();
  });

  it("does NOT gate the submit or draft affordances on the paid-up-adult warning", () => {
    // Pinned deliberately. The server owns this refusal and a Booking Officer can
    // approve an override (the violation is exception-eligible and HOLDs the
    // beds), so a stale or missing quote must never be what decides the outcome.
    // Anybody later "helpfully" disabling the button should fail here.
    const priceQuote = quoteWith({
      paidUpAdultMemberMissing: true,
      subscriptionMemberRateNotice: SERVER_RATE_NOTICE,
    });
    renderReview([memberGuest], undefined, { priceQuote });

    expect(
      screen.getByRole("button", { name: "Continue to Payment" }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Save as Draft" }),
    ).not.toBeDisabled();
  });

  it("puts both notices above the totals, because they explain the figures below them", () => {
    const priceQuote = quoteWith({
      paidUpAdultMemberMissing: true,
      subscriptionMemberRateNotice: SERVER_RATE_NOTICE,
    });
    renderReview([memberGuest], undefined, { priceQuote });

    const warning = screen.getByTestId("paid-up-adult-missing-notice");
    const notice = screen.getByTestId("subscription-member-rate-notice");
    const total = screen.getByText("Total");

    // Node.compareDocumentPosition: DOCUMENT_POSITION_FOLLOWING === 4.
    expect(warning.compareDocumentPosition(notice) & 4).toBe(4);
    expect(notice.compareDocumentPosition(total) & 4).toBe(4);
  });
});

/**
 * #2562 review — the request card on the new-booking path.
 *
 * Two defects, one screen. The card was handed `omittedChanges: []` with the note
 * that "a new booking's whole intent IS the party and the nights, so there is
 * nothing the request cannot carry", and a price of
 * `appliedPromo?.finalPriceCents ?? priceQuote.totalPriceCents`. Neither survives a
 * discounted party: `POST /api/bookings/exception-requests` takes only the lodge,
 * the nights, the guests and the message, and `executeApprovedNewBooking` calls
 * `createConfirmedBooking` with no promo and no credit — so the frozen proposal and
 * the executed booking both price at the full rate, while the member was shown the
 * discounted figure and told nothing was left out.
 */
describe("ReviewStep — the exception-request card (#2562 review)", () => {
  const offer = {
    code: "MINIMUM_STAY_VIOLATION" as const,
    message: "Friday nights need a two-night booking.",
    capacityMode: "NO_HOLD" as const,
    violations: [
      {
        reasonCode: "MINIMUM_STAY" as const,
        message: "Friday nights need a two-night booking.",
        affectedNights: ["2026-07-20"],
        capacityMode: "NO_HOLD" as const,
      },
    ],
  };

  it("shows the undiscounted quote and names the promo as not included", () => {
    renderReview([memberGuest], undefined, {
      exceptionOffer: offer,
      appliedPromo: {
        code: "WINTER20",
        description: "20% off",
        type: "PERCENT",
        discountCents: 6000,
        promoAdjustmentCents: -6000,
        totalPriceCents: 8000,
        finalPriceCents: 2000,
      },
    });

    const card = screen.getByTestId("request-officer-approval");
    // The club's quote for the party being frozen: $80.00, not the $20.00 the
    // price summary above shows and no approval could ever produce.
    expect(card).toHaveTextContent("$80.00");
    expect(card).not.toHaveTextContent("$20.00");
    expect(card).toHaveTextContent(
      /Total for this stay at the club's normal rates/,
    );
    // And the disclosure block must actually render, naming what was dropped.
    expect(card).toHaveTextContent(/are NOT included/);
    expect(card).toHaveTextContent(/the promo code/);
  });

  it("names a working-bee discount even though it carries no promo code", () => {
    renderReview([memberGuest], undefined, {
      exceptionOffer: offer,
      attendingWorkParty: true,
      selectedWorkPartyEventId: "event-1",
      appliedPromo: {
        // A work-party discount never sends its internal code to the client.
        code: null,
        description: "Working bee",
        type: "PERCENT",
        discountCents: 8000,
        promoAdjustmentCents: -8000,
        totalPriceCents: 8000,
        finalPriceCents: 0,
      },
    });

    const card = screen.getByTestId("request-officer-approval");
    expect(card).toHaveTextContent(/the working bee discount/);
    expect(card).toHaveTextContent("$80.00");
  });

  it("keeps the plain price label when nothing priced was dropped", () => {
    renderReview([memberGuest], undefined, { exceptionOffer: offer });

    const card = screen.getByTestId("request-officer-approval");
    expect(card).toHaveTextContent("Total for this stay:");
    expect(card).not.toHaveTextContent(/normal rates/);
    expect(card).not.toHaveTextContent(/are NOT included/);
  });

  it("names the non-price choices the request drops", () => {
    renderReview([memberGuest], undefined, {
      exceptionOffer: offer,
      requestedRoomId: "room-2",
      notes: "Arriving after dark.",
    });

    const card = screen.getByTestId("request-officer-approval");
    expect(card).toHaveTextContent(/the room you asked for/);
    expect(card).toHaveTextContent(/your note to the club/);
    // These do not move the price, so the figure keeps its plain label.
    expect(card).toHaveTextContent("Total for this stay:");
  });
});
