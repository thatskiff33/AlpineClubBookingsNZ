// @vitest-environment jsdom

/**
 * #3653, #3949 (review round 5): a reduction on a joiner's booking the group organiser paid for goes back to the
 * organiser, with nothing to choose. The panel says how: to the organiser's card, or - the organiser having paid by
 * Internet Banking - by bank transfer. It never offers the joiner account credit.
 */
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";
import { PriceSummaryCard } from "@/components/edit-booking/price-summary-card";
import type { QuoteResult } from "@/components/edit-booking/types";
import { organiserBilledSentence } from "@/lib/booking-modified-email-copy";

function organiserQuote(organiserRefundByBankTransfer: boolean): QuoteResult {
  return {
    capacityAvailable: true,
    itemizedChanges: [],
    newFinalPriceCents: 15_000,
    netChargeCents: -5_000,
    settlementOptions: {
      basisAmountCents: 5_000,
      cardRefundAmountCents: 2_500,
      cardRefundPercentage: 50,
      accountCreditAmountCents: 0,
      accountCreditPercentage: 0,
      daysUntilCheckIn: 30,
      requiresSettlementMethod: false,
      returnsToOrganiser: true,
      organiserRefundByBankTransfer,
    },
    promoStillValid: true,
  } as unknown as QuoteResult;
}

function renderQuote(quote: QuoteResult, ledgerAppliedCreditCents = 0) {
  return render(
    <PriceSummaryCard
      quote={quote}
      quoteLoading={false}
      quoteError=""
      bookingFinalPriceCents={20_000}
      promo={null}
      promoAction={{ type: "keep" } as never}
      overCapacityConfirmActive={false}
      overCapacityNightList={[]}
      confirmOverCapacity={false}
      showQuoteSummary
      ledgerAppliedCreditCents={ledgerAppliedCreditCents}
      useCredit={false}
      desiredElectionCents={0}
      actingAsAdmin={false}
      settlementMethod={null}
      onConfirmOverCapacityChange={vi.fn()}
      onSettlementMethodChange={vi.fn()}
    />,
  );
}

describe("the price summary names how a reduction goes back to the group organiser", () => {
  it("#3949: by bank transfer where the organiser paid by Internet Banking - never a card, never a choice", () => {
    renderQuote(organiserQuote(true));

    expect(screen.getByTestId("organiser-refund-notice").textContent).toMatch(/^To be refunded to the group organiser by bank transfer: \$25\.00 \(50%\)/);
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("#3949 review round 6: mid group cancel, shows the save's refusal and promises no refund", () => {
    renderQuote({ ...organiserQuote(true), priceChangeRefusal: "The group organiser is cancelling this group." } as QuoteResult);

    expect(screen.getByTestId("organiser-price-change-refusal").textContent).toBe("The group organiser is cancelling this group.");
    expect(screen.queryByTestId("organiser-refund-notice")).toBeNull();
  });

  it("#3653: to the organiser's card where the organiser paid by card", () => {
    renderQuote(organiserQuote(false));

    expect(screen.getByTestId("organiser-refund-notice").textContent).toMatch(/^Refunded to the group organiser's card: \$25\.00 \(50%\)/);
  });
});

describe("#4299 N4: an increase on a place the organiser paid for by Internet Banking", () => {
  const increase = { ...organiserQuote(true), netChargeCents: 6_000, settlementOptions: null } as unknown as QuoteResult;

  it("says the organiser will be invoiced, in the email's own words, never 'Additional charge'", () => {
    renderQuote({ ...increase, billedToOrganiser: true } as QuoteResult);

    expect(screen.getByTestId("organiser-billed-notice").textContent).toBe(organiserBilledSentence("$60.00", "quote"));
    expect(screen.getByTestId("organiser-billed-notice").textContent).toMatch(/will be invoiced to the group organiser/);
    expect(screen.queryByText(/Additional charge/)).toBeNull();
  });

  it("promises no organiser invoice while the save would refuse the change (a group cancel part-way through)", () => {
    renderQuote({ ...increase, billedToOrganiser: true, priceChangeRefusal: "The group organiser is cancelling this group." } as QuoteResult);

    expect(screen.queryByTestId("organiser-billed-notice")).toBeNull();
    expect(screen.getByTestId("organiser-price-change-refusal").textContent).toBe("The group organiser is cancelling this group.");
    expect(screen.queryByText(/Additional charge/)).toBeNull();
  });

  it.each([
    { refusal: "priceChangeRefusal", testId: "organiser-price-change-refusal" },
    { refusal: "chargeRefusal", testId: "organiser-charge-refusal" },
  ])("a refused increase ($refusal) never shows the joiner an 'Additional charge' they are never asked for", ({ refusal, testId }) => {
    // With account credit applied, so the "Remaining to pay" line renders too.
    renderQuote({ ...increase, billedToOrganiser: true, [refusal]: "The save refuses this change." } as QuoteResult, 2_000);

    expect(screen.queryByText(/Additional charge/)).toBeNull();
    expect(screen.queryByTestId("organiser-billed-notice")).toBeNull();
    expect(screen.getByTestId(testId).textContent).toBe("The save refuses this change.");
    expect(screen.getByTestId("remaining-to-pay").textContent).toBe("Remaining to pay$0.00");
  });

  it("control: a refused increase on the member's own booking still shows the additional charge", () => {
    renderQuote({ ...increase, chargeRefusal: "The save refuses this change." } as QuoteResult);

    expect(screen.getByText("Additional charge: $60.00")).toBeTruthy();
    expect(screen.getByTestId("organiser-charge-refusal").textContent).toBe("The save refuses this change.");
  });

  it("control: any other increase is still an additional charge", () => {
    renderQuote(increase);

    expect(screen.getByText("Additional charge: $60.00")).toBeTruthy();
    expect(screen.queryByTestId("organiser-billed-notice")).toBeNull();
  });
});

describe("#4299: what this member has remaining to pay", () => {
  // A $150 place with $20 of account credit applied, re-priced with no net change.
  const unchanged = { ...organiserQuote(true), netChargeCents: 0, newFinalPriceCents: 15_000, changeFeeCents: 0, settlementOptions: null } as unknown as QuoteResult;

  it("is nothing on a place the group organiser paid for by Internet Banking: the organiser is billed for it", () => {
    renderQuote({ ...unchanged, billedToOrganiser: true } as QuoteResult, 2_000);

    expect(screen.getByTestId("remaining-to-pay").textContent).toBe("Remaining to pay$0.00");
  });

  it("control: the member's own booking still shows its price less the credit applied", () => {
    renderQuote(unchanged, 2_000);

    expect(screen.getByTestId("remaining-to-pay").textContent).toBe("Remaining to pay$130.00");
  });
});
