import { describe, expect, it } from "vitest";

import {
  FINANCIAL_REVIEW_NOTHING_MOVED,
  FINANCIAL_REVIEW_NOTHING_TO_DO,
  FINANCIAL_REVIEW_NOT_IN_THAT_FIGURE,
  FINANCIAL_REVIEW_WILL_BE_IN_TOUCH,
  FINANCIAL_REVIEW_WORKING_IT_OUT,
  financialReviewNote,
  financialReviewNoteBesideAnAmount,
} from "@/lib/booking-financial-review-copy";
import { resolveBookingNarrative } from "@/lib/booking-narrative";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";

/**
 * #3194 (epic #2797): THE TWO SURFACES CANNOT COME TO DISAGREE.
 *
 * The booking-detail page renders the composed narrative, which appends the
 * review sentences to a payable one across two paragraphs. The public
 * payment-link page renders its own payment card, so it cannot use that
 * composed message and takes the review half on its own from
 * `financialReviewNoteBesideAnAmount`.
 *
 * That is two compositions, and two compositions of one claim about a member's
 * money is exactly the drift #3194 exists to close. What makes it safe is that
 * both are built from the same five constants, and this file is what holds them
 * to it: it DERIVES what the narrative appends, by resolving the same booking
 * with the review open and closed and subtracting, then asserts the pay page's
 * note is that, sentence for sentence and in order. Neither can be reworded
 * alone.
 */

const CLUB = bindClubTime(requireClubTimeZone("Pacific/Auckland"));

const PAYABLE_BOOKING = {
  status: "CONFIRMED",
  finalPriceCents: 12000,
  checkIn: new Date("2026-08-01T00:00:00.000Z"),
  checkOut: new Date("2026-08-03T00:00:00.000Z"),
  firstName: "Tara",
  adminReviewStatus: null,
  adminReviewNotes: null,
  adminReviewReason: null,
};

function narrative(financialReviewPending: boolean) {
  return resolveBookingNarrative({
    club: CLUB,
    booking: PAYABLE_BOOKING,
    events: [],
    financialReviewPending,
  });
}

/**
 * What the review adds to a payable narrative, taken from the narrative itself
 * rather than restated here. A restatement would be a THIRD copy of the
 * sentences, and this file would then pass while all three drifted together.
 */
function reviewAddendum(): string {
  const without = narrative(false);
  const withReview = narrative(true);

  expect(withReview.message.startsWith(`${without.message} `)).toBe(true);
  expect(withReview.nextStep.startsWith(`${without.nextStep} `)).toBe(true);

  const addedToMessage = withReview.message.slice(without.message.length + 1);
  const addedToNextStep = withReview.nextStep.slice(without.nextStep.length + 1);
  return `${addedToMessage} ${addedToNextStep}`;
}

describe("financial-review copy has one home", () => {
  it("gives the payment-link page exactly the sentences the booking page adds", () => {
    expect(financialReviewNoteBesideAnAmount()).toBe(reviewAddendum());
  });

  it("says the five sentences in the order a member reads them", () => {
    expect(financialReviewNoteBesideAnAmount()).toBe(
      [
        FINANCIAL_REVIEW_NOT_IN_THAT_FIGURE,
        FINANCIAL_REVIEW_WORKING_IT_OUT,
        FINANCIAL_REVIEW_NOTHING_MOVED,
        FINANCIAL_REVIEW_NOTHING_TO_DO,
        FINANCIAL_REVIEW_WILL_BE_IN_TOUCH,
      ].join(" "),
    );
  });

  /*
    The epic's rules, asserted on the composition rather than on each constant:
    no amount of any kind, and no past-tense claim that money has moved. A
    reviewed edit's amount is precisely the thing nobody knows, so "$0" is as
    wrong here as a guess would be.
  */
  it("names no amount and claims no money has moved", () => {
    const note = financialReviewNoteBesideAnAmount();
    expect(note).not.toContain("$");
    expect(note).not.toMatch(/\d/);
    // The only past-tense money verb the note is allowed is a NEGATED one:
    // "Nothing has been refunded or charged for it yet". Anything else would be
    // a claim that money moved, which for a parked review is never true.
    for (const sentence of note.split(". ")) {
      if (/has been/.test(sentence)) {
        expect(sentence.startsWith("Nothing has been")).toBe(true);
      }
    }
  });

  /*
    The confirmation card on the payment link renders the note WITHOUT the
    "not part of that figure" opener, because by then the member has paid and
    there is no figure on screen for it to point at. It is the same composition
    the two email surfaces use, which is why it is not a fourth one.
  */
  it("gives the post-payment card the same clauses, minus the figure sentence", () => {
    expect(financialReviewNote({ moneyAlreadyMoved: false })).toBe(
      [
        FINANCIAL_REVIEW_WORKING_IT_OUT,
        FINANCIAL_REVIEW_NOTHING_MOVED,
        FINANCIAL_REVIEW_NOTHING_TO_DO,
      ].join(" "),
    );
    expect(financialReviewNote({ moneyAlreadyMoved: false })).not.toContain(
      FINANCIAL_REVIEW_NOT_IN_THAT_FIGURE,
    );
  });

  it("drops the nothing-moved sentence when a settlement note beside it says otherwise", () => {
    expect(financialReviewNote({ moneyAlreadyMoved: true })).not.toContain(
      FINANCIAL_REVIEW_NOTHING_MOVED,
    );
    expect(financialReviewNote({ moneyAlreadyMoved: true })).toContain(
      FINANCIAL_REVIEW_WORKING_IT_OUT,
    );
  });
});
