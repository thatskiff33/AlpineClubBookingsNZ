import { describe, expect, it } from "vitest";

import { BookingEventType } from "@prisma/client";

import {
  FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE,
  FINANCIAL_REVIEW_NOTHING_MOVED,
  FINANCIAL_REVIEW_NOTHING_TO_DO,
  FINANCIAL_REVIEW_NOT_IN_THAT_FIGURE,
  FINANCIAL_REVIEW_WILL_BE_IN_TOUCH,
  FINANCIAL_REVIEW_WILL_BE_IN_TOUCH_OR_ASK,
  FINANCIAL_REVIEW_WORKING_IT_OUT,
  financialReviewNote,
  financialReviewNoteBesideAnAmount,
} from "@/lib/booking-financial-review-copy";
import { resolveBookingNarrative } from "@/lib/booking-narrative";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";

/**
 * #3194 (epic #2797): THE SURFACES CANNOT COME TO DISAGREE.
 *
 * The booking-detail page renders the composed narrative, which says the review
 * sentences beside a payable or a paid one across two paragraphs. The public
 * payment-link page renders its own payment card, so it cannot use that composed
 * message and takes the review half on its own from
 * `financialReviewNoteBesideAnAmount`.
 *
 * That is three compositions, and three compositions of one claim about a
 * member's money is exactly the drift #3194 exists to close. What makes it safe
 * is that all three are built from the same five constants, and this file is
 * what holds them to it: it DERIVES what each narrative adds, by resolving the
 * same booking with the review open and closed and subtracting, then asserts the
 * pay page's note is that, sentence for sentence and in order. None can be
 * reworded alone.
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

/**
 * The same booking PAID, with the durable event that proves it. The paid
 * narrative names the amount off this event, so the composition under review has
 * a real figure in front of the member — which is the case the bridging sentence
 * exists for.
 */
const PAID_BOOKING = { ...PAYABLE_BOOKING, status: "PAID" };
const PAID_EVENTS = [
  {
    type: BookingEventType.MEMBER_PAID,
    occurredAt: new Date("2026-06-20T02:00:00.000Z"),
    amountCents: 12000,
    reason: null,
    snapshot: null,
  },
];

function narrative(financialReviewPending: boolean) {
  return resolveBookingNarrative({
    club: CLUB,
    booking: PAYABLE_BOOKING,
    events: [],
    financialReviewPending,
  });
}

function paidNarrative(financialReviewPending: boolean) {
  return resolveBookingNarrative({
    club: CLUB,
    booking: PAID_BOOKING,
    events: PAID_EVENTS,
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

/**
 * The same derivation for the PAID composition (#3194), and the one structural
 * difference between the two: its `message` is appended to, but its `nextStep`
 * is REPLACED, because the paid one opens with "Nothing more to do" — the
 * sentence this issue is named after. So what the review adds is everything
 * after the paid message plus the whole of the new next step.
 */
function paidReviewAddendum(): string {
  const without = paidNarrative(false);
  const withReview = paidNarrative(true);

  // The premise, asserted rather than assumed: the control really is the paid
  // narrative, really does name the amount received, and really does carry the
  // banned sentence this composition drops.
  expect(without.state).toBe("paid");
  expect(without.message).toContain("$120.00");
  expect(without.nextStep).toMatch(/nothing more to do/i);

  expect(withReview.message.startsWith(`${without.message} `)).toBe(true);
  expect(withReview.nextStep).not.toMatch(/nothing more to do/i);

  const addedToMessage = withReview.message.slice(without.message.length + 1);
  return `${addedToMessage} ${withReview.nextStep}`;
}

describe("financial-review copy has one home", () => {
  it("gives the payment-link page exactly the sentences the booking page adds", () => {
    expect(
      financialReviewNoteBesideAnAmount({ amountPredatesTheChange: true }),
    ).toBe(reviewAddendum());
  });

  it("says the same five sentences beside a payment already received", () => {
    expect(
      financialReviewNoteBesideAnAmount({ amountPredatesTheChange: false }),
    ).toBe(paidReviewAddendum());
  });

  /*
    THE TWO KINDS OF AMOUNT GET DIFFERENT OPENING SENTENCES, and this is the
    fix-round finding the whole change turns on (#3194).

    An amount still DUE is `booking.finalPriceCents`, and both services that can
    park an edit write that column back UNCHANGED while saving the new dates and
    deleting the departing guest's row. So the figure beside these sentences is
    the price from BEFORE the member's change, under the change's own dates. It
    must say so.

    An amount already RECEIVED is read off a durable payment event and a parked
    edit cannot make it out of date, so it keeps the sentence that says only that
    the change's amount sits outside it.
  */
  it("tells a member the amount they are being asked to pay predates their change", () => {
    const due = financialReviewNoteBesideAnAmount({
      amountPredatesTheChange: true,
    });

    expect(due.startsWith(FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE)).toBe(
      true,
    );
    expect(due).not.toContain(FINANCIAL_REVIEW_NOT_IN_THAT_FIGURE);
  });

  it("MUTATION: does not tell a member their RECEIVED payment is out of date", () => {
    // The control for the case above. A payment that arrived is a settled fact;
    // saying it "does not yet reflect the change" would be false and would read
    // as the club disputing money it already has.
    const received = financialReviewNoteBesideAnAmount({
      amountPredatesTheChange: false,
    });

    expect(received.startsWith(FINANCIAL_REVIEW_NOT_IN_THAT_FIGURE)).toBe(true);
    expect(received).not.toContain(
      FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE,
    );
  });

  /*
    And the two compositions differ in EXACTLY that one sentence, derived rather
    than restated. Everything after the opener is one shared tail, so a reword of
    any of the four remaining clauses still moves both surfaces together.
  */
  it("differs between the two only in its opening sentence", () => {
    const due = financialReviewNoteBesideAnAmount({
      amountPredatesTheChange: true,
    });
    const received = financialReviewNoteBesideAnAmount({
      amountPredatesTheChange: false,
    });

    expect(
      due.slice(FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE.length),
    ).toBe(received.slice(FINANCIAL_REVIEW_NOT_IN_THAT_FIGURE.length));
  });

  /*
    The long form of the in-touch promise is the short one plus an invitation,
    not a second wording of it (#3194). Rewording either half of the shared
    clause has to move both, which is what this asserts: the long form is the
    short form with its full stop swapped for the invitation.
  */
  it("builds the long in-touch sentence out of the short one", () => {
    const clause = FINANCIAL_REVIEW_WILL_BE_IN_TOUCH.replace(/\.$/, "");

    expect(FINANCIAL_REVIEW_WILL_BE_IN_TOUCH.endsWith(".")).toBe(true);
    expect(FINANCIAL_REVIEW_WILL_BE_IN_TOUCH_OR_ASK.startsWith(`${clause} —`)).toBe(
      true,
    );
    // And the review-pending narrative says the long one rather than a third
    // copy of the same promise.
    expect(
      resolveBookingNarrative({
        club: CLUB,
        booking: { ...PAYABLE_BOOKING, status: "WAITLISTED" },
        events: [],
        financialReviewPending: true,
      }).nextStep,
    ).toContain(FINANCIAL_REVIEW_WILL_BE_IN_TOUCH_OR_ASK);
  });

  it("says the five sentences in the order a member reads them", () => {
    expect(
      financialReviewNoteBesideAnAmount({ amountPredatesTheChange: false }),
    ).toBe(
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
    // BOTH compositions, because the stale-amount opener is a second sentence
    // standing next to a figure and is under exactly the same rules.
    for (const amountPredatesTheChange of [true, false]) {
      const note = financialReviewNoteBesideAnAmount({
        amountPredatesTheChange,
      });
      expect(note).not.toContain("$");
      expect(note).not.toMatch(/\d/);
      // The only past-tense money verb the note is allowed is a NEGATED one:
      // "Nothing has been refunded or charged for it yet". Anything else would
      // be a claim that money moved, which for a parked review is never true.
      for (const sentence of note.split(". ")) {
        if (/has been/.test(sentence)) {
          expect(sentence.startsWith("Nothing has been")).toBe(true);
        }
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
    expect(financialReviewNote({ moneyAlreadyMoved: false })).not.toContain(
      FINANCIAL_REVIEW_AMOUNT_PREDATES_THE_CHANGE,
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
