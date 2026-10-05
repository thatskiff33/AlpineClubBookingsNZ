import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * #3033 (epic #2797) — the "Booking Modified" email with a silent money section.
 *
 * THE HOLE THIS CLOSES WAS LIVE. Both the HTML template and the sender composed
 * `paymentNote` from a three-way test, and every branch requires a POSITIVE
 * amount: a refund, an account credit, or an additional payment. An edit whose
 * adjustment could not be worked out has none of those by construction, so the
 * token rendered empty and the member received a change confirmation whose money
 * section said nothing at all — which reads as "no money is involved" on the one
 * change where that is most conspicuously untrue.
 *
 * The two paths are asserted TOGETHER because they compose the same sentence for
 * the same member: a branch added to one and not the other means the HTML email
 * and the admin-editable body disagree about money.
 *
 * AND THE SECOND HOLE, closed in the same place. The first fix made
 * `financialReviewPending` a fourth arm of the same exclusive chain, checked
 * first — which suppressed a real payment instruction. One edit can surrender
 * nights that cannot be valued while adding nights that price normally, so a
 * review-pending change can carry a genuine additional amount; the member was
 * told "there is nothing for you to do" and shown no amount, no invoice number
 * and no payment reference. They do not pay, the hold expires, the booking
 * cancels. Both facts are true at once, so both are now rendered.
 *
 * MUTATION PROOF. Remove either branch and its "says the amount is coming" test
 * fails. Make the review note exclusive with the settlement note in either
 * direction — return early on the review, or fall through to it only when no
 * amount is positive — and "says BOTH what is being worked out and what is owed"
 * fails in that path. Widen `FINANCIAL_REVIEW_NOTHING_TO_DO` back to the whole
 * email and "scopes 'nothing to do' to the change, so the payment instruction
 * still stands" fails. Put an amount in the review sentence and "names no
 * amount" fails.
 */

const sendEmail = vi.hoisted(() => vi.fn(async () => ({ delivered: true })));

vi.mock("@/lib/email/core", () => ({ sendEmail }));

import { bookingModifiedTemplate } from "@/lib/email-templates/booking";
import { sendBookingModifiedEmail } from "@/lib/email/booking";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const OLD_CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const OLD_CHECK_OUT = new Date("2026-08-05T00:00:00.000Z");
const NEW_CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const NEW_CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

function params(overrides: Record<string, unknown> = {}) {
  return {
    firstName: "Sam",
    modificationType: "DATE_CHANGE",
    oldCheckIn: OLD_CHECK_IN,
    oldCheckOut: OLD_CHECK_OUT,
    newCheckIn: NEW_CHECK_IN,
    newCheckOut: NEW_CHECK_OUT,
    oldGuestCount: 2,
    newGuestCount: 2,
    oldFinalPriceCents: 24000,
    newFinalPriceCents: 12000,
    changeFeeCents: 0,
    refundAmountCents: 0,
    additionalAmountCents: 0,
    // #3032 made this required, so the base fixture states the CONTROL value
    // explicitly: this is the "no review is open" email every case below is
    // measured against, not an absence the compiler filled in.
    financialReviewPending: false,
    appliedCreditGivenBackCents: 0,
    refundReturnedToOrganiser: false,
    ...overrides,
  };
}

function senderParams(overrides: Record<string, unknown> = {}) {
  return {
    bookingId: "booking-1",
    recipientMemberId: "member-1",
    email: "sam@example.org",
    ...params(overrides),
  };
}

/** The flat body's `{{paymentNote}}` value, as the sender composed it. */
async function paymentNoteFromSender(overrides: Record<string, unknown> = {}) {
  sendEmail.mockClear();
  await sendBookingModifiedEmail(senderParams(overrides), CLUB_FORMAT_TEST);
  const [call] = sendEmail.mock.calls as unknown as [
    [{ templateData: { paymentNote: string } }],
  ];
  return call[0].templateData.paymentNote;
}

beforeEach(() => {
  sendEmail.mockClear();
});

describe("an unresolved adjustment no longer sends a silent money section (#3033)", () => {
  it("the HTML template says the amount is coming, where it used to say nothing", async () => {
    const silent = bookingModifiedTemplate(params(), CLUB_FORMAT_TEST);
    const honest = bookingModifiedTemplate(
      params({ financialReviewPending: true }),
      CLUB_FORMAT_TEST,
    );

    // The pre-#3033 behaviour, kept as the control: with no positive amount in
    // any of the three branches, the money section was empty.
    expect(silent).not.toMatch(/working out what that change means/i);
    expect(honest).toMatch(/working out what that change means/i);
    expect(honest).toMatch(/nothing has been refunded or charged/i);
  });

  it("the sender's flat body says the same thing", async () => {
    expect(await paymentNoteFromSender()).toBe("");
    expect(await paymentNoteFromSender({ financialReviewPending: true })).toMatch(
      /working out what that change means/i,
    );
  });

  it("names no amount — not a zero, not an estimate, not the new total", async () => {
    const note = await paymentNoteFromSender({ financialReviewPending: true });

    expect(note).not.toContain("$");
    expect(bookingModifiedTemplate(params({ financialReviewPending: true }), CLUB_FORMAT_TEST)).not.toMatch(
      /\$0\.00/,
    );
  });

  it("never implies the money has already moved", async () => {
    const note = await paymentNoteFromSender({ financialReviewPending: true });

    expect(note).not.toMatch(/has been processed|has been added|is required/i);
    expect(note).toContain("Nothing has been refunded or charged for it yet.");
  });

  it("says BOTH what is being worked out and what is owed, on the same edit", async () => {
    /*
      NOT AN EXCLUSIVE CHOICE, and that is the test. An edit can surrender nights
      it cannot value while adding nights that price normally under current
      policy, so a review-pending change can still carry a positive additional
      amount. Whichever way round an exclusive chain is ordered, one of the two
      true things is lost: the payment instruction shadows the honest sentence,
      or — as the first fix did — the honest sentence suppresses an instruction
      to pay $45.00 and the member never learns they owe it.
    */
    const overrides = { financialReviewPending: true, additionalAmountCents: 4500 };
    const note = await paymentNoteFromSender(overrides);
    const html = bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST);

    expect(note).toMatch(/working out what that change means/i);
    expect(note).toMatch(/An additional payment of \$45\.00 is required/);
    expect(html).toMatch(/working out what that change means/i);
    expect(html).toMatch(/An additional payment of \$45\.00 is required/);
  });

  it("drops 'nothing has moved' when the settlement note says money HAS moved", async () => {
    /*
      #3032 - THE ONE COMPOSITION THAT CONTRADICTS ITSELF.

      Two of the settlement note's four arms are past tense about money: "A
      refund of $X has been processed" and "Account credit of $X has been
      added". Beside either of them, "Nothing has been refunded or charged for
      it yet" is a flat contradiction in one email about one change, and the
      member has no way to tell which sentence to believe. The
      additional-payment arms are compatible - they are about money that has NOT
      moved - and the case above requires the sentence to survive them.

      NOT REACHABLE THROUGH ANY CURRENT PATH, and pinned anyway. A parked edit
      settles nothing, so its refund, credit and additional amounts are all zero
      by construction. The reachability is a property of today's callers, not of
      the copy; the contradiction is removed where it is composed, so a future
      caller cannot reintroduce it by being written.
    */
    for (const moved of [
      { refundAmountCents: 5000 },
      { accountCreditAmountCents: 5000 },
    ]) {
      const overrides = { financialReviewPending: true, ...moved };
      const note = await paymentNoteFromSender(overrides);
      const html = bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST);

      // The honest half stays: the club is still working the amount out.
      expect(note).toMatch(/working out what that change means/i);
      expect(html).toMatch(/working out what that change means/i);
      // The contradicting sentence is gone from both surfaces.
      expect(note).not.toMatch(/nothing has been refunded or charged/i);
      expect(html).not.toMatch(/nothing has been refunded or charged/i);
      // And the settlement fact itself is untouched.
      expect(note).toMatch(/has been (processed|added)/i);
    }
  });

  it("keeps 'nothing has moved' when the settlement note is a request to PAY", async () => {
    // THE CONTROL, and it is the half that would be lost by suppressing the
    // sentence whenever any settlement note is present. "An additional payment
    // is required" is about money that has not moved, so the two agree.
    const overrides = {
      financialReviewPending: true,
      additionalAmountCents: 4500,
      refundAmountCents: 0,
      accountCreditAmountCents: 0,
    };

    expect(await paymentNoteFromSender(overrides)).toMatch(
      /nothing has been refunded or charged/i,
    );
    expect(bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST)).toMatch(
      /nothing has been refunded or charged/i,
    );
  });

  it("carries the invoice and reference an internet-banking payment needs", async () => {
    /*
      The suppressed branch was not merely a sentence — it is HOW the member
      pays. Losing it lost the Xero invoice number and the payment reference
      too, which is the difference between a member who can pay and one who
      cannot.
    */
    const overrides = {
      financialReviewPending: true,
      additionalAmountCents: 4500,
      additionalPaymentMethod: "INTERNET_BANKING",
      xeroInvoiceNumber: "INV-0042",
      paymentReference: "TAC-1234",
    };
    const note = await paymentNoteFromSender(overrides);

    expect(note).toMatch(/working out what that change means/i);
    expect(note).toContain("Xero invoice INV-0042");
    expect(note).toContain("Payment reference: TAC-1234.");

    /*
      #3032: and the SAME composition in the HTML the member actually opens.
      The flat body and the template build this from separate code, so asserting
      only one of them leaves the other free to drop the how-to-pay half - which
      is the exact shape of the #3033 defect, in the surface most members read.
      This is also the case pinned byte-for-byte as
      `bookingModifiedTemplate:financialReviewPendingWithPayment` in the
      rendered-email corpus.
    */
    const html = bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST);

    expect(html).toMatch(/working out what that change means/i);
    expect(html).toMatch(
      /An additional Internet Banking payment of \$45\.00 is required/,
    );
    expect(html).toContain("Xero invoice INV-0042");
    expect(html).toContain("Payment reference: TAC-1234.");
    // The two notes are SEPARATE boxes, and the review one comes first: the
    // honest sentence must not be buried under the instruction to pay.
    expect(html.indexOf("working out what that change means")).toBeLessThan(
      html.indexOf("An additional Internet Banking payment"),
    );
  });

  it("scopes 'nothing to do' to the change, so the payment instruction still stands", async () => {
    /*
      The two sentences sit side by side, so an unscoped "there is nothing for
      you to do" would cancel the one beside it. It names what it is about.
    */
    const note = await paymentNoteFromSender({
      financialReviewPending: true,
      additionalAmountCents: 4500,
    });

    expect(note).toContain("There is nothing you need to do about that change.");
    expect(note).not.toMatch(/there is nothing (for you to do|you need to do)\./i);
  });

  it("still says only the honest sentence when the edit priced nothing", async () => {
    // The control for the composition above: no settlement note exists to
    // compose with, so the review note is the whole of the money section.
    const note = await paymentNoteFromSender({ financialReviewPending: true });

    expect(note).toMatch(/working out what that change means/i);
    expect(note).not.toMatch(/is required|has been processed|has been added/i);
  });

  it("leaves every existing branch exactly as it was", async () => {
    expect(await paymentNoteFromSender({ refundAmountCents: 4500 })).toMatch(
      /A refund of \$45\.00 has been processed/,
    );
    expect(
      await paymentNoteFromSender({ accountCreditAmountCents: 4500 }),
    ).toMatch(/Account credit of \$45\.00 has been added/);
    expect(await paymentNoteFromSender({ additionalAmountCents: 4500 })).toMatch(
      /An additional payment of \$45\.00 is required/,
    );
  });
});

/*
  #3809: a change that gave back applied credit says so, in the HTML email and
  in the flat body's {{paymentNote}} alike - and beside a card refund on a
  booking paid by card and credit, since both are true.
*/
describe("#3809: applied credit given back is named in the Booking Modified email", () => {
  const SENTENCE = "$50.00 of the account credit used for this booking has been returned to your account credit.";

  it("MUTATION: the HTML email and the flat body both state the amount, as account credit", async () => {
    expect(bookingModifiedTemplate(params({ appliedCreditGivenBackCents: 5000 }), CLUB_FORMAT_TEST)).toContain(SENTENCE);
    expect(await paymentNoteFromSender({ appliedCreditGivenBackCents: 5000 })).toBe(SENTENCE);
  });

  it("composes with a card refund rather than replacing it", async () => {
    const note = await paymentNoteFromSender({ refundAmountCents: 10000, appliedCreditGivenBackCents: 5000 });

    expect(note).toMatch(/A refund of \$100\.00 has been processed/);
    expect(note).toContain(SENTENCE);
  });

  it("is absent where nothing came back", async () => {
    expect(await paymentNoteFromSender({})).not.toContain("returned to your account credit");
    expect(bookingModifiedTemplate(params(), CLUB_FORMAT_TEST)).not.toContain("returned to your account credit");
  });
});

/*
  #3916: a joiner's booking the group organiser paid for by card refunds its
  reduction to the ORGANISER's card (#3653). The email names where the money
  went on every route, in the HTML email and the flat {{paymentNote}} alike,
  because both read the one home (`editRefundNote`).

  MUTATION PROOF. Make `editRefundNote` ignore its flag in either direction and
  either "organiser's card" or "own card" fails in both paths; drop the flag at
  either call site (HTML or sender) and that path's assertion fails.
*/
describe("#3916: the Booking Modified refund sentence names where the refund went", () => {
  const OWN_CARD = "A refund of $45.00 has been processed to your original payment method.";
  const ORGANISER_CARD =
    "A refund of $45.00 has been processed to the group organiser's card, because the group organiser paid for this booking.";

  it("organiser's card: names the group organiser's card, never the joiner's payment method", async () => {
    const overrides = { refundAmountCents: 4500, refundReturnedToOrganiser: true };
    const html = bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST);
    const note = await paymentNoteFromSender(overrides);

    expect(html).toContain(ORGANISER_CARD);
    expect(html).not.toContain("your original payment method");
    expect(note).toBe(ORGANISER_CARD);
  });

  it("own card: the member's original payment method, byte-identical to before", async () => {
    const overrides = { refundAmountCents: 4500 };
    expect(bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST)).toContain(OWN_CARD);
    expect(await paymentNoteFromSender(overrides)).toBe(OWN_CARD);
  });

  it("bank transfer: an Internet Banking reduction keeps the original-payment-method sentence", async () => {
    // An organiser who settled by Internet Banking is not `paidByOrganiserCard`,
    // so its door answers false and the sentence is the ordinary one.
    const overrides = { refundAmountCents: 4500, additionalPaymentMethod: "INTERNET_BANKING" };
    expect(bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST)).toContain(OWN_CARD);
    expect(await paymentNoteFromSender(overrides)).toBe(OWN_CARD);
  });

  it("account credit: names credit, and no card at all", async () => {
    const overrides = { accountCreditAmountCents: 4500 };
    const credit = "Account credit of $45.00 has been added for future bookings.";
    const html = bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST);
    expect(html).toContain(credit);
    expect(html).not.toMatch(/organiser's card|original payment method/);
    expect(await paymentNoteFromSender(overrides)).toBe(credit);
  });

  it("every door that can refund an edit routes the flag from its settlement result, not a recomputation", () => {
    const repoRoot = resolve(__dirname, "../../..");
    for (const door of [
      "src/lib/booking-date-modification-service.ts",
      "src/lib/booking-batch-modification-service.ts",
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
    ]) {
      const source = readFileSync(resolve(repoRoot, door), "utf8");
      expect(source, door).toContain("refundReturnedToOrganiser: result.organiserChildRefund !== null,");
    }
  });
});
