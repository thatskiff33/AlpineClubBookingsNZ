// @vitest-environment jsdom

/**
 * #3954 (review round 4): the edit panel tells the member, before they save,
 * what a reduction takes off the extra payment they have not paid yet - and
 * what is left of it afterwards, so "comes off" never reads as a refund.
 */
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";
import { PriceSummaryCard } from "@/components/edit-booking/price-summary-card";
import type { QuoteResult } from "@/components/edit-booking/types";

function reducedQuote(unpaidAskOffsetCents: number, askLeftCents: number | undefined): QuoteResult {
  return {
    capacityAvailable: true,
    itemizedChanges: [],
    newFinalPriceCents: 13_000,
    netChargeCents: -2_000,
    settlementOptions: null,
    promoStillValid: true,
    unpaidAskOffsetCents,
    askLeftCents,
  } as unknown as QuoteResult;
}

function renderQuote(quote: QuoteResult) {
  return render(
    <PriceSummaryCard
      quote={quote}
      quoteLoading={false}
      quoteError=""
      bookingFinalPriceCents={15_000}
      promo={null}
      promoAction={{ type: "keep" } as never}
      overCapacityConfirmActive={false}
      overCapacityNightList={[]}
      confirmOverCapacity={false}
      showQuoteSummary
      ledgerAppliedCreditCents={0}
      useCredit={false}
      desiredElectionCents={0}
      actingAsAdmin={false}
      settlementMethod={null}
      onConfirmOverCapacityChange={vi.fn()}
      onSettlementMethodChange={vi.fn()}
    />,
  );
}

describe("#3954: the price summary says what is left of the unpaid additional payment", () => {
  it("MUTATION: a shrunk ask names what the member will then owe", () => {
    renderQuote(reducedQuote(2_000, 3_000));

    expect(screen.getByTestId("unpaid-ask-offset").textContent).toBe(
      "Comes off your unpaid additional payment: $20.00 (you will then owe $30.00)",
    );
  });

  it("a cancelled ask says nothing is left to pay", () => {
    renderQuote(reducedQuote(5_000, 0));

    expect(screen.getByTestId("unpaid-ask-offset").textContent).toBe(
      "Comes off your unpaid additional payment: $50.00 (nothing left to pay)",
    );
  });

  it("says nothing where no ask is touched", () => {
    renderQuote(reducedQuote(0, 0));

    expect(screen.queryByTestId("unpaid-ask-offset")).toBeNull();
  });
});
