// #3269 / INV-PAY-053 — the admin "Confirm pending guests" button on the member
// booking page says whether confirming WILL CHARGE the member's saved card. That
// wording has to come from the same answer the confirm-pending-guests route
// charges on, or the page promises a charge the route will not make (or hides
// one it will).
//
// WHY THIS IS A SOURCE-TEXT CONTRACT AND NOT A RENDER TEST. Same reasoning as
// `issue-2779-draft-pickup-card.test.ts` beside it: the prop is computed inside
// an async React Server Component two thousand lines long, and standing it up
// tests the mocks. What must be true is narrow and structural:
//
//  * the prop is derived by `savedPaymentMethodForBooking` — the one home for
//    "may this card be charged off-session" — and not by a truthiness check on
//    `stripePaymentMethodId`, which is what read a one-off checkout card (and a
//    laundered copy of one) as a saved card;
//  * the member's "Save Payment Method" card keys on the SAME named const
//    (epic #3270, composing #3266 with #3269): the form shows exactly when the
//    cron would find nothing to charge, so the page can never ask for a card
//    while promising a charge, or promise a charge while asking for a card;
//  * the query gives that function what it needs: the split parent's payment
//    row, including `stripeSetupIntentId`, without which a child charged on
//    its parent's genuinely saved card would read as "no card".
//
// Comments are stripped before matching, so the paragraph explaining a guard can
// never stand in for the guard.
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

const PAGE = "src/app/(authenticated)/bookings/[id]/page.tsx";

function readPageSource(): string {
  // Test helper: a fixed repo file under process.cwd(), not user input.
  return readFileSync(path.resolve(process.cwd(), PAGE), "utf8");
}

describe("#3269 saved-card provenance on the member booking page (INV-PAY-053)", () => {
  const source = stripComments(readPageSource());

  it("derives ONE named answer from savedPaymentMethodForBooking, own row and parent row", () => {
    expect(source).toContain(
      'import { savedPaymentMethodForBooking } from "@/lib/saved-payment-method";',
    );
    expect(source).toMatch(
      /const savedCard = savedPaymentMethodForBooking\(\{\s*payment: booking\.payment,\s*parentBooking: booking\.parentBooking,\s*\}\);/,
    );
    // Exactly one call: a second derivation is a second place the answer could
    // drift, which is the defect this contract exists to make unrepresentable.
    expect(source.match(/savedPaymentMethodForBooking\(/g)).toHaveLength(1);
  });

  it("the confirm button's will-charge wording reads that const", () => {
    expect(source).toMatch(/hasSavedPaymentMethod=\{savedCard !== null\}/);
  });

  it("the member's Save Payment Method card shows exactly when that const finds no card (epic #3270)", () => {
    expect(source).toMatch(
      /const showSavePaymentMethodCard =\s*isBookingOwner &&\s*!isDeleted &&\s*!internetBankingPayment &&\s*booking\.status === "PENDING" &&\s*savedCard === null;/,
    );
    // Not the retired #3266 predicate over the card column alone, which hid the
    // form from a legacy split child carrying a copied, unchargeable card.
    expect(source).not.toMatch(/needsSavedCardEntry/);
  });

  it("never falls back to the populated-fields check that read a one-off checkout card as saved", () => {
    expect(source).not.toMatch(
      /hasSavedPaymentMethod=\{Boolean\(\s*booking\.payment\?\.stripePaymentMethodId/,
    );
  });

  it("loads the split parent's payment row with the SetupIntent column the predicate needs", () => {
    expect(source).toMatch(
      /parentBooking: \{\s*select: \{\s*id: true,\s*status: true,\s*finalPriceCents: true,\s*payment: \{\s*select: \{\s*stripeCustomerId: true,\s*stripePaymentMethodId: true,\s*stripeSetupIntentId: true,\s*\},\s*\},\s*\},\s*\}/,
    );
  });
});
