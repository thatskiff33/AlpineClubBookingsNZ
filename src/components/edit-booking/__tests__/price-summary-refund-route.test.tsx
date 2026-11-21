// @vitest-environment jsdom

/**
 * #5303: the member's own money-back choice names the route the save takes. A
 * reduction the treasurer will refund by bank transfer - an Internet Banking
 * payment, or a card payment Stripe holds no record of (#5212) - is never
 * offered as a refund to the card.
 */
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";
import { PriceSummaryCard } from "@/components/edit-booking/price-summary-card";
import type { QuoteResult, SettlementOptions } from "@/components/edit-booking/types";

function reductionQuote(refundByBankTransfer: boolean | undefined): QuoteResult {
  const settlementOptions: SettlementOptions = {
    basisAmountCents: 5_000,
    cardRefundAmountCents: 2_500,
    cardRefundPercentage: 50,
    accountCreditAmountCents: 3_750,
    accountCreditPercentage: 75,
    daysUntilCheckIn: 30,
    requiresSettlementMethod: true,
    returnsToOrganiser: false,
    organiserRefundByBankTransfer: false,
    refundHeldForDispute: false,
    ...(refundByBankTransfer === undefined ? {} : { refundByBankTransfer }),
  };
  return {
    capacityAvailable: true,
    itemizedChanges: [],
    newFinalPriceCents: 15_000,
    netChargeCents: -5_000,
    settlementOptions,
    promoStillValid: true,
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

const refundChoice = () => screen.getByRole("radio", { name: /^Refund/ });

describe("the price summary's refund choice names the route the save takes", () => {
  it("a bank-transfer refund says bank transfer, never the card", () => {
    renderQuote(reductionQuote(true));

    expect(refundChoice().closest("label")?.textContent).toBe("Refund by bank transfer: $25.00 (50%)");
    expect(screen.queryByText(/original card/)).toBeNull();
    expect(screen.getByRole("radio", { name: /account credit/ })).toBeTruthy();
  });

  it("control: a refund Stripe can return still goes to the original card", () => {
    renderQuote(reductionQuote(false));

    expect(refundChoice().closest("label")?.textContent).toBe("Refund to original card: $25.00 (50%)");
  });

  it("an older server that omits the flag reads as the card, as before", () => {
    renderQuote(reductionQuote(undefined));

    expect(refundChoice().closest("label")?.textContent).toBe("Refund to original card: $25.00 (50%)");
  });
});
