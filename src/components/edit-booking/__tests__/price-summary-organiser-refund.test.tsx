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

  it("control: any other increase is still an additional charge", () => {
    renderQuote(increase);

    expect(screen.getByText("Additional charge: $60.00")).toBeTruthy();
    expect(screen.queryByTestId("organiser-billed-notice")).toBeNull();
  });
});
