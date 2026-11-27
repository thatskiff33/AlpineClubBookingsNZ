import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The money section of the "Booking Modified" email: the HTML template and the
 * sender's admin-editable flat body compose the same sentences for the same
 * member, so each case asserts both paths together. #4344 wave C2 retired the
 * open-review note these used to sit beside.
 */

const sendEmail = vi.hoisted(() => vi.fn(async () => ({ delivered: true })));

vi.mock("@/lib/email/core", () => ({ sendEmail }));

import { bookingModifiedTemplate } from "@/lib/email-templates/booking";
import { alertBox } from "@/lib/email-templates/layout";
import { bookingModifiedRefundSentence, organiserCardRefundPendingSentence } from "@/lib/booking-modified-email-copy";
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
    addedGuests: [],
    refundAmountCents: 0,
    additionalAmountCents: 0,
    refundByBankTransfer: null,
    appliedCreditGivenBackCents: 0,
    unpaidAskCancelled: false,
    refundDestination: "own" as const,
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

describe("the settlement note", () => {
  it("names a refund, an account credit and an additional payment", async () => {
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

describe("an internet-banking refund is promised, not reported (#3827, D-3813-6)", () => {
  it("both the HTML and the editable body say the club WILL refund by bank transfer", async () => {
    const overrides = { refundAmountCents: 6000, refundByBankTransfer: "member" as const };
    const note = await paymentNoteFromSender(overrides);
    expect(note).toBe("The club will refund $60.00 to you by bank transfer.");
    const html = bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST);
    expect(html).toMatch(/The club will refund \$60\.00 to you by bank transfer\./);
    expect(html).not.toMatch(/has been processed/);
  });

  it("a split payment's reduction names the cash refund AND the credit returned (D-3813-5)", async () => {
    const overrides = { refundAmountCents: 4000, accountCreditAmountCents: 2000 };
    const note = await paymentNoteFromSender(overrides);
    expect(note).toBe(
      "A refund of $40.00 has been processed to your original payment method. Account credit of $20.00 has been added for future bookings.",
    );
    const html = bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST);
    expect(html).toMatch(/A refund of \$40\.00 has been processed/);
    expect(html).toMatch(/Account credit of \$20\.00 has been added/);
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

  it("composes with an internet-banking refund promised by bank transfer (#3829: #3827 with #3809)", async () => {
    const overrides = { refundAmountCents: 6000, refundByBankTransfer: "member" as const, appliedCreditGivenBackCents: 5000 };
    const note = await paymentNoteFromSender(overrides);
    expect(note).toContain("The club will refund $60.00 to you by bank transfer.");
    expect(note).toContain(SENTENCE);
    const html = bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST);
    expect(html).toMatch(/The club will refund \$60\.00 to you by bank transfer\./);
    expect(html).toContain(SENTENCE);
    expect(html).not.toMatch(/has been processed/);
  });

  it("is absent where nothing came back", async () => {
    expect(await paymentNoteFromSender({})).not.toContain("returned to your account credit");
    expect(bookingModifiedTemplate(params(), CLUB_FORMAT_TEST)).not.toContain("returned to your account credit");
  });
});

/*
  #3916, #4057: a joiner's booking the group organiser paid for by card refunds
  its reduction to the ORGANISER's card (#3653). The email names where the money
  went on every route, in the HTML email and the flat {{paymentNote}} alike,
  because both read the one home (`bookingModifiedRefundSentence`), and says it
  was made only when the refund's own debt says so (#4057): otherwise it is on
  its way, in an info box. A refund to the member's own card likewise, when
  Stripe did not make it (#4070).

  MUTATION PROOF. Make `bookingModifiedRefundSentence` answer one organiser case
  with the other, or with the own-card sentence, and that case fails in both
  paths; make `bookingModifiedRefundPending` answer false and the pending case's
  info box fails; drop the destination at either call site (HTML or sender) and
  that path's assertion fails.
*/
describe("#3916, #4057, #4070: the Booking Modified refund sentence names where the refund went", () => {
  const OWN_CARD = "A refund of $45.00 has been processed to your original payment method.";
  const ORGANISER_CARD =
    "A refund of $45.00 has been processed to the group organiser's card, because the group organiser paid for this booking.";
  const ORGANISER_CARD_PENDING =
    "A refund of $45.00 is on its way to the group organiser's card, because the group organiser paid for this booking.";

  it("organiser's card, made: names the group organiser's card, never the joiner's payment method", async () => {
    const overrides = { refundAmountCents: 4500, refundDestination: "organiser_card" };
    const html = bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST);
    const note = await paymentNoteFromSender(overrides);

    expect(html).toContain(ORGANISER_CARD);
    expect(html).toContain(alertBox(ORGANISER_CARD, "success"));
    expect(html).not.toContain("your original payment method");
    expect(note).toBe(ORGANISER_CARD);
  });

  it("organiser's card, not made yet: on its way, in an info box, and never 'has been processed'", async () => {
    const overrides = { refundAmountCents: 4500, refundDestination: "organiser_card_pending" };
    const html = bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST);
    const note = await paymentNoteFromSender(overrides);

    expect(html).toContain(alertBox(ORGANISER_CARD_PENDING, "info"));
    expect(html).not.toContain(alertBox(ORGANISER_CARD_PENDING, "success"));
    expect(html).not.toMatch(/has been processed|original payment method/);
    expect(note).toBe(ORGANISER_CARD_PENDING);
  });

  it("the pending sentence is #3973's, from its one home", () => {
    expect(bookingModifiedRefundSentence("$45.00", null, "organiser_card_pending")).toBe(
      organiserCardRefundPendingSentence("$45.00"),
    );
    // An organiser-card refund is a Stripe one: never by hand, made or not.
    expect(bookingModifiedRefundSentence("$45.00", "member", "organiser_card_pending")).toBe(ORGANISER_CARD_PENDING);
    expect(bookingModifiedRefundSentence("$45.00", "member", "organiser_card")).toBe(ORGANISER_CARD);
  });

  // #4070: the member's own-card refund Stripe did not make, queued for retry.
  it("own card, not made yet: on its way, in an info box, never 'has been processed' (#4070)", async () => {
    const OWN_CARD_PENDING = "A refund of $45.00 is on its way to your original payment method.";
    const overrides = { refundAmountCents: 4500, refundDestination: "own_card_pending" };
    const html = bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST);
    const note = await paymentNoteFromSender(overrides);

    expect(html).toContain(alertBox(OWN_CARD_PENDING, "info"));
    expect(html).not.toContain(alertBox(OWN_CARD_PENDING, "success"));
    expect(html).not.toMatch(/has been processed|bank transfer/);
    expect(note).toBe(OWN_CARD_PENDING);
    // A card refund the club did not send by hand: the card's pending wording, whatever the flag says.
    expect(bookingModifiedRefundSentence("$45.00", "member", "own_card_pending")).toBe(OWN_CARD_PENDING);
  });

  it("own card: the member's original payment method, byte-identical to before", async () => {
    const overrides = { refundAmountCents: 4500 };
    const html = bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST);
    expect(html).toContain(alertBox(OWN_CARD, "success"));
    expect(await paymentNoteFromSender(overrides)).toBe(OWN_CARD);
  });

  it("bank transfer: an Internet Banking reduction keeps the D-3813-6 bank-transfer promise", async () => {
    // An organiser who settled by Internet Banking is not `paidByOrganiserCard`,
    // so its door answers "own" and the bank-transfer sentence stands.
    const overrides = { refundAmountCents: 4500, refundByBankTransfer: "member" as const };
    const bank = "The club will refund $45.00 to you by bank transfer.";
    const html = bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST);
    expect(html).toContain(bank);
    expect(html).not.toContain("organiser's card");
    expect(await paymentNoteFromSender(overrides)).toBe(bank);
  });

  it("account credit: names credit, and no card at all", async () => {
    const overrides = { accountCreditAmountCents: 4500 };
    const credit = "Account credit of $45.00 has been added for future bookings.";
    const html = bookingModifiedTemplate(params(overrides), CLUB_FORMAT_TEST);
    expect(html).toContain(credit);
    expect(html).not.toMatch(/organiser's card|original payment method/);
    expect(await paymentNoteFromSender(overrides)).toBe(credit);
  });

  it("every door that can refund an edit passes the refund's own answer after it ran, not a recomputation (#4057)", () => {
    const repoRoot = resolve(__dirname, "../../..");
    for (const door of [
      "src/lib/booking-date-modification-service.ts",
      "src/lib/booking-batch-modification-service.ts",
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
      "src/lib/booking-guest-acceptance-reprice.ts",
    ]) {
      const source = readFileSync(resolve(repoRoot, door), "utf8");
      expect(source, door).toMatch(/const refund = await executeBookingModificationRefund\(/);
      expect(source, door).toMatch(/refundDestination: refund\.refundDestination,/);
      // The yes/no flag this replaced, and any answer read off the settlement plan.
      expect(source, door).not.toMatch(/refundReturnedToOrganiser|refundDestination: (?:result|reprice)\./);
    }
  });
});

/*
  #3954 (review round 4): an edit whose price drop cancelled the member's
  unpaid additional payment outright says so - in the HTML email and the flat body
  alike, beside any refund for the rest of the drop. A shrunk ask keeps the
  ordinary "an additional payment of $X is required" note at its new figure.
*/
describe("#3954: a cancelled unpaid additional payment is named in the Booking Modified email", () => {
  const SENTENCE = "The additional payment we asked for has been cancelled, so you no longer need to pay it.";

  it("MUTATION: the HTML email and the flat body both say the additional payment is cancelled", async () => {
    expect(bookingModifiedTemplate(params({ unpaidAskCancelled: true }), CLUB_FORMAT_TEST)).toContain(SENTENCE);
    expect(await paymentNoteFromSender({ unpaidAskCancelled: true })).toBe(SENTENCE);
  });

  it("composes with a refund for the rest of the drop", async () => {
    const note = await paymentNoteFromSender({ refundAmountCents: 1500, unpaidAskCancelled: true });
    expect(note).toMatch(/A refund of \$15\.00 has been processed/);
    expect(note).toContain(SENTENCE);
  });

  it("says nothing of it when no ask was cancelled", async () => {
    expect(bookingModifiedTemplate(params(), CLUB_FORMAT_TEST)).not.toContain(SENTENCE);
    expect(await paymentNoteFromSender({ additionalAmountCents: 3000 })).not.toContain(SENTENCE);
  });
});

/*
  #4299 (`INV-PAY-148`, F1): an increase on a place the group organiser paid for
  by Internet Banking is invoiced to the organiser. The joiner's email names no
  payment to make, and says who was invoiced, in both the HTML and flat body.
*/
describe("#4299: an increase invoiced to the group organiser asks the joiner for nothing", () => {
  const SENTENCE = "The extra $60.00 for this change has been invoiced to the group organiser, because the group organiser paid for this booking. There is nothing for you to pay.";

  it("MUTATION: the HTML email and the flat body both say the organiser was invoiced", async () => {
    const html = bookingModifiedTemplate(params({ billedToOrganiserCents: 6000 }), CLUB_FORMAT_TEST);
    expect(html).toContain(SENTENCE);
    expect(html).not.toContain("additional");
    expect(await paymentNoteFromSender({ billedToOrganiserCents: 6000 })).toBe(SENTENCE);
  });

  it("says nothing of it when no organiser was invoiced", async () => {
    expect(bookingModifiedTemplate(params(), CLUB_FORMAT_TEST)).not.toContain("invoiced to the group organiser");
    expect(await paymentNoteFromSender({ billedToOrganiserCents: 0 })).toBe("");
  });

  it("the three edit doors pass the transaction's organiser-billed figure to the email", () => {
    for (const file of ["src/lib/booking-date-modification-service.ts", "src/lib/booking-batch-modification-service.ts", "src/app/api/bookings/[id]/guests/route.ts"]) {
      expect(readFileSync(resolve(__dirname, "../../..", file), "utf8"), file).toContain("billedToOrganiserCents: result.billedToOrganiserCents, // #4299");
    }
  });
});
