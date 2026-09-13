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

/**
 * A refused quote.
 *
 * `nightDetails` is supplied alongside the new field on purpose. The server no
 * longer sends it to a member at all, but it IS still sent on the admin-override
 * branch, and it is the field the old card rendered from — so a fixture carrying
 * both is what makes these assertions discriminate. The card must ignore it
 * whoever it belongs to.
 */
function refusedQuote(
  capacityFullNights: string[],
  nightDetails: { date: string; availableBeds: number }[],
): QuoteResult {
  return {
    capacityAvailable: false,
    capacityFullNights,
    nightDetails,
  } as unknown as QuoteResult;
}

/** A held night as the engine reports it: full lodge, zero free, never below. */
const HELD = (date: string) => ({ date, availableBeds: 0 });
/** A night the party will not fit on, with its shortfall. */
const SHORT = (date: string, by: number) => ({ date, availableBeds: -by });

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
  const HELD_NIGHTS = ["2026-08-18", "2026-08-19"];

  it("names the nights a hold-only refusal covers", () => {
    // Pre-fix this rendered the heading with NO list beneath it, because every
    // held night's `availableBeds` is 0 rather than negative.
    renderRefusal(
      refusedQuote(HELD_NIGHTS, [HELD("2026-08-18"), HELD("2026-08-19")]),
    );

    expect(screen.getByText("Not enough beds available")).toBeTruthy();
    expect(screen.getByText("2026-08-18")).toBeTruthy();
    expect(screen.getByText("2026-08-19")).toBeTruthy();
  });

  it("renders a hold-only refusal and a genuine-fullness refusal identically", () => {
    // The two fixtures differ ONLY in the bed numbers, which is the difference
    // between the two real cases. Pre-fix the first drew an empty list and the
    // second drew "2 bed(s) short" / "5 bed(s) short"; the rendered text must
    // now be identical rather than merely similar.
    const held = renderRefusal(
      refusedQuote(HELD_NIGHTS, [HELD("2026-08-18"), HELD("2026-08-19")]),
    );
    const heldText = held.container.textContent;
    held.unmount();

    const full = renderRefusal(
      refusedQuote(HELD_NIGHTS, [
        SHORT("2026-08-18", 2),
        SHORT("2026-08-19", 5),
      ]),
    );
    expect(full.container.textContent).toBe(heldText);
  });

  it("never prints a bed shortfall, which would tell the two apart by arithmetic", () => {
    const { container } = renderRefusal(
      refusedQuote(["2026-08-18"], [SHORT("2026-08-18", 7)]),
    );

    expect(container.textContent).not.toContain("bed(s) short");
    expect(container.textContent).not.toMatch(/\d+\s*bed/i);
  });
});
