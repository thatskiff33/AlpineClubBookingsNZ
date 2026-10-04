// @vitest-environment jsdom

/**
 * #3809: the edit panel tells the member, before they save, what a reduction
 * will give back of the account credit their booking used - with no card to
 * choose, so beside (or instead of) the card-or-credit chooser.
 */
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";
import { PriceSummaryCard } from "@/components/edit-booking/price-summary-card";
import type { QuoteResult } from "@/components/edit-booking/types";

function reducedQuote(appliedCreditGiveBackCents: number | undefined): QuoteResult {
  return {
    capacityAvailable: true,
    itemizedChanges: [],
    newFinalPriceCents: 15_000,
    netChargeCents: -5_000,
    settlementOptions: null,
    promoStillValid: true,
    appliedCreditGiveBackCents,
  } as unknown as QuoteResult;
}

function renderQuote(quote: QuoteResult) {
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
      ledgerAppliedCreditCents={20_000}
      useCredit={false}
      desiredElectionCents={0}
      actingAsAdmin={false}
      settlementMethod={null}
      onConfirmOverCapacityChange={vi.fn()}
      onSettlementMethodChange={vi.fn()}
    />,
  );
}

describe("#3809: the price summary names the account credit a reduction returns", () => {
  it("MUTATION: states the amount, as account credit", () => {
    renderQuote(reducedQuote(5_000));

    expect(screen.getByTestId("applied-credit-give-back").textContent).toBe("Returned as account credit: $50.00");
  });

  it("says nothing where nothing comes back", () => {
    renderQuote(reducedQuote(0));

    expect(screen.queryByTestId("applied-credit-give-back")).toBeNull();
  });
});
