// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PromoCodeInput } from "@/components/promo-code-input";
import { PromoCodeCard } from "@/components/edit-booking/promo-code-card";

/**
 * The promo adjustment line on the two promo components renders through the
 * one `formatSignedCents` (#3264). Neither component had a test pinning that
 * string before the local copies were deleted, so these are the equivalence
 * evidence for those two former call sites.
 */
describe("promo adjustment line", () => {
  it("PromoCodeInput shows the applied promo's signed adjustment", () => {
    render(
      <PromoCodeInput
        checkIn="2026-08-01"
        checkOut="2026-08-03"
        guests={[{ ageTier: "ADULT", isMember: true }]}
        onPromoApplied={vi.fn()}
        appliedPromo={{
          code: "SAVE",
          description: null,
          type: "PERCENT",
          discountCents: 14000,
          promoAdjustmentCents: -14000,
          totalPriceCents: 20000,
          finalPriceCents: 6000,
        }}
      />,
    );
    expect(screen.getByText("(-$140.00)")).toBeInTheDocument();
  });

  it("PromoCodeCard shows the kept promo's signed adjustment", () => {
    render(
      <PromoCodeCard
        promo={{ code: "SAVE", type: "PERCENT", description: null }}
        promoAdjustmentCents={-6000}
        promoAction={{ type: "keep" }}
        availablePromoCodes={[]}
        appliedNewPromo={null}
        prefillPromoCode={undefined}
        checkIn="2026-08-01"
        checkOut="2026-08-03"
        remainingGuests={[]}
        addedGuests={[]}
        perGuestDatesEnabled={false}
        isInProgressEdit={false}
        getExistingGuestRange={() => ({ stayStart: "2026-08-01", stayEnd: "2026-08-03" })}
        quote={null}
        forMemberId={undefined}
        lodgeId={null}
        onRemovePromo={vi.fn()}
        onKeepPromo={vi.fn()}
        onPrefillCode={vi.fn()}
        onPromoApplied={vi.fn()}
      />,
    );
    expect(screen.getByText("(-$60.00)")).toBeInTheDocument();
  });
});
