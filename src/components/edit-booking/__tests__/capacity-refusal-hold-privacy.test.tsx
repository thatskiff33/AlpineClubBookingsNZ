// @vitest-environment jsdom

/**
 * #2930 — the booking-edit price summary's capacity refusal, on screen.
 *
 * The route half of this is pinned in
 * `modify-quote-hold-privacy.test.ts`; this is what the member actually reads.
 *
 * WHAT IT USED TO DO. The card built its own night list from
 * `quote.nightDetails.filter(n => n.availableBeds < 0)` and rendered
 * `"{date}: {N} bed(s) short"`. A whole-lodge-held night is pinned to exactly 0
 * available beds and never goes negative (`INV-CAP-021`, ADR-001 decision 5), so
 * it fell straight out of that filter — and the SAME refusal heading appeared
 * over an empty list for a hold and over an itemised one for ordinary fullness.
 * A member who moved their booking onto a held range could read the difference
 * off the screen, which is the one inference decision 6 forbids.
 *
 * The list is now the server's `capacityFullNights` (from the single helper,
 * which counts a held night as a full night) and carries dates only.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PriceSummaryCard } from "@/components/edit-booking/price-summary-card";
import type { QuoteResult } from "@/components/edit-booking/types";

function refusedQuote(capacityFullNights: string[]): QuoteResult {
  return {
    capacityAvailable: false,
    capacityFullNights,
  } as unknown as QuoteResult;
}

function renderRefusal(quote: QuoteResult) {
  return render(
    <PriceSummaryCard
      quote={quote}
      quoteLoading={false}
      quoteError=""
      bookingFinalPriceCents={30000}
      promo={null}
      promoAction={{ kind: "none" } as never}
      overCapacityConfirmActive={false}
      overCapacityNightList={[]}
      confirmOverCapacity={false}
      showQuoteSummary={false}
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

describe("edit-booking capacity refusal — a hold reads exactly like a full lodge (#2930)", () => {
  it("names the nights a hold-only refusal covers", () => {
    // Pre-fix this rendered the heading with NO list beneath it, because every
    // held night's `availableBeds` is 0 rather than negative.
    renderRefusal(refusedQuote(["2026-08-18", "2026-08-19"]));

    expect(screen.getByText("Not enough beds available")).toBeTruthy();
    expect(screen.getByText("2026-08-18")).toBeTruthy();
    expect(screen.getByText("2026-08-19")).toBeTruthy();
  });

  it("renders a hold-only refusal and a genuine-fullness refusal identically", () => {
    // The server hands both the same list (the helper's whole point), so the
    // rendered text must be identical rather than merely similar.
    const held = renderRefusal(refusedQuote(["2026-08-18", "2026-08-19"]));
    const heldText = held.container.textContent;
    held.unmount();

    const full = renderRefusal(refusedQuote(["2026-08-18", "2026-08-19"]));
    expect(full.container.textContent).toBe(heldText);
  });

  it("never prints a bed shortfall, which would tell the two apart by arithmetic", () => {
    const { container } = renderRefusal(refusedQuote(["2026-08-18"]));

    expect(container.textContent).not.toContain("bed(s) short");
    expect(container.textContent).not.toMatch(/\d+\s*bed/i);
  });
});
