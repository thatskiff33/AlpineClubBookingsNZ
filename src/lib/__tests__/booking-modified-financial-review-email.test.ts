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
 * MUTATION PROOF. Remove either branch and its "says the amount is coming" test
 * fails. Move the branch below the additional-payment test and "the honest
 * sentence wins over a priced half of the same edit" fails in both paths. Put an
 * amount in the sentence and "names no amount" fails.
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
  const call = sendEmail.mock.calls[0][0] as {
    templateData: { paymentNote: string };
  };
  return call.templateData.paymentNote;
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
    expect(silent).not.toMatch(/working out what this change means/i);
    expect(honest).toMatch(/working out what this change means/i);
    expect(honest).toMatch(/nothing has been refunded or charged/i);
  });

  it("the sender's flat body says the same thing", async () => {
    expect(await paymentNoteFromSender()).toBe("");
    expect(await paymentNoteFromSender({ financialReviewPending: true })).toMatch(
      /working out what this change means/i,
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
  });

  it("the honest sentence wins over a priced half of the same edit", async () => {
    /*
      Checked FIRST, not last, and that ordering is the test. An edit can
      surrender nights it cannot value while adding nights that price normally
      under current policy, so a review-pending change can still carry a positive
      additional amount. Checked last, this branch would be shadowed and the
      member would be told what to pay while hearing nothing about what they are
      owed.
    */
    const overrides = { financialReviewPending: true, additionalAmountCents: 4500 };

    expect(await paymentNoteFromSender(overrides)).toMatch(
      /working out what this change means/i,
    );
    expect(bookingModifiedTemplate(params(overrides))).not.toMatch(
      /An additional payment of/,
    );
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
