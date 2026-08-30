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
  await sendBookingModifiedEmail(senderParams(overrides));
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
    const silent = bookingModifiedTemplate(params());
    const honest = bookingModifiedTemplate(
      params({ financialReviewPending: true }),
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
    expect(bookingModifiedTemplate(params({ financialReviewPending: true }))).not.toMatch(
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
    const html = bookingModifiedTemplate(params(overrides));

    expect(note).toMatch(/working out what that change means/i);
    expect(note).toMatch(/An additional payment of \$45\.00 is required/);
    expect(html).toMatch(/working out what that change means/i);
    expect(html).toMatch(/An additional payment of \$45\.00 is required/);
  });

  it("carries the invoice and reference an internet-banking payment needs", async () => {
    /*
      The suppressed branch was not merely a sentence — it is HOW the member
      pays. Losing it lost the Xero invoice number and the payment reference
      too, which is the difference between a member who can pay and one who
      cannot.
    */
    const note = await paymentNoteFromSender({
      financialReviewPending: true,
      additionalAmountCents: 4500,
      additionalPaymentMethod: "INTERNET_BANKING",
      xeroInvoiceNumber: "INV-0042",
      paymentReference: "TAC-1234",
    });

    expect(note).toMatch(/working out what that change means/i);
    expect(note).toContain("Xero invoice INV-0042");
    expect(note).toContain("Payment reference: TAC-1234.");
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
