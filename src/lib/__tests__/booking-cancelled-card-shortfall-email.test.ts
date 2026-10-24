import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4097 (`INV-PAY-129`): an own-card cancel whose card refund plan carried less
 * than the refund due names what went to the card, the part the club refunds
 * by bank transfer and the part it will be in touch about - in the "Booking Cancelled" email (HTML and the
 * admin-editable body's `{{refundMessage}}`), as information, from the one
 * wording home (`booking-modified-email-copy.ts`). The officers' alert names
 * the situation.
 *
 * MUTATION PROOF. Drop the shortfall branch from `bookingCancelledRefundSentence`
 * and the split cases fail; word the part to check as a bank transfer and its
 * own case fails; drop `shortfallCents` from `bookingCancelledRefundMade` and the
 * info-box cases fail; drop the shortfall from the sender's or the template's
 * call and their own case fails.
 */

const sendEmail = vi.hoisted(() => vi.fn(async () => ({ delivered: true })));
const sendToAdmins = vi.hoisted(() => vi.fn(async () => ({ delivered: true })));

vi.mock("@/lib/email/core", () => ({ sendEmail, sendToAdmins }));

import {
  bookingCancelledRefundMade,
  bookingCancelledRefundSentence,
  bookingModifiedRefundSentence,
  ownCardRefundPendingSentence,
  ownCardRefundWithShortfallSentence,
  refundRequestApprovedRefundSentence,
} from "@/lib/booking-modified-email-copy";
import { CARD_REFUND_SHORTFALL_ALERT_BODY, CARD_REFUND_SHORTFALL_ALERT_LEAD } from "@/lib/cancel-card-refund-shortfall-copy";
import {
  manualRefundTaskAlertAmountLabel,
  manualRefundTaskAlertHeading,
  manualRefundTaskAlertLabel,
  manualRefundTaskAlertNote,
} from "@/lib/email-message-notes";
import { adminManualRefundTaskTemplate } from "@/lib/email-templates/admin-finance";
import { bookingCancelledTemplate } from "@/lib/email-templates/booking";
import { alertBox } from "@/lib/email-templates/layout";
import { sendBookingCancelledEmail } from "@/lib/email/booking";
import { formatCents } from "@/lib/utils";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
const fmt = (cents: number) => formatCents(cents, CLUB_FORMAT_TEST);

// Pinned before #4097, unchanged with nothing short.
const OWN_CARD = "A refund of $45.00 has been processed to your original payment method.";
const OWN_CARD_PENDING = "A refund of $45.00 is on its way to your original payment method.";

async function sent(method: "card" | "card_pending", shortfall: { bankCents: number; checkCents: number }) {
  sendEmail.mockClear();
  await sendBookingCancelledEmail(
    { bookingId: "booking-1", recipientMemberId: "member-1" },
    "sam@example.org",
    "Sam",
    CHECK_IN,
    CHECK_OUT,
    4500,
    CLUB_FORMAT_TEST,
    method,
    0,
    null,
    "cancellation-policy",
    4500,
    shortfall,
  );
  const [call] = sendEmail.mock.calls as unknown as [[{ html: string; templateData: { refundMessage: string; refundAmount: string } }]];
  return { html: call[0].html, refundMessage: call[0].templateData.refundMessage, refundAmount: call[0].templateData.refundAmount };
}

beforeEach(() => {
  sendEmail.mockClear();
  sendToAdmins.mockClear();
});

describe("#4097: the Booking Cancelled refund line names the card's part and what the club does with the rest", () => {
  it.each([
    ["card", 1500, 0, "A refund of $30.00 has been processed to your original payment method, and the club will refund the remaining $15.00 to you by bank transfer."],
    ["card_pending", 1500, 0, "A refund of $30.00 is on its way to your original payment method, and the club will refund the remaining $15.00 to you by bank transfer."],
    ["card", 0, 1500, "A refund of $30.00 has been processed to your original payment method, and the club will be in touch about the remaining $15.00."],
    ["card", 500, 1000, "A refund of $30.00 has been processed to your original payment method; the club will refund $5.00 to you by bank transfer and will be in touch about the remaining $10.00."],
    ["card", 4500, 0, "The club will refund $45.00 to you by bank transfer."],
    ["card", 0, 4500, "The club will be in touch about the $45.00 refund."],
    ["card_pending", 1500, 3000, "The club will refund $15.00 to you by bank transfer and will be in touch about the remaining $30.00."],
  ] as const)("%s, %i by bank, %i to check: one sentence, in an info box, in the HTML and {{refundMessage}}", async (method, bankCents, checkCents, sentence) => {
    const template = bookingCancelledTemplate("Sam", CHECK_IN, CHECK_OUT, 4500, CLUB_FORMAT_TEST, method, 0, "cancellation-policy", 4500, { bankCents, checkCents });
    const sender = await sent(method, { bankCents, checkCents });

    expect(template).toContain(alertBox(sentence, "info"));
    expect(sender.html).toContain(alertBox(sentence, "info"));
    expect(sender.refundMessage).toBe(sentence);
    // `{{refundAmount}}` stays the refund due in all.
    expect(sender.refundAmount).toBe("$45.00");
    for (const body of [template, sender.html, sender.refundMessage]) {
      expect(body).not.toContain("A refund of $45.00");
    }
  });

  it("MUTATION: a part to check is never promised as a bank transfer", async () => {
    const message = (await sent("card", { bankCents: 0, checkCents: 4500 })).refundMessage;
    expect(message).not.toMatch(/bank transfer/);
  });

  it("keeps the wording byte-identical with nothing short", async () => {
    expect((await sent("card", { bankCents: 0, checkCents: 0 })).refundMessage).toBe(OWN_CARD);
    expect((await sent("card_pending", { bankCents: 0, checkCents: 0 })).refundMessage).toBe(OWN_CARD_PENDING);
    expect(bookingCancelledTemplate("Sam", CHECK_IN, CHECK_OUT, 4500, CLUB_FORMAT_TEST, "card")).toContain(alertBox(OWN_CARD, "success"));
  });

  it("is built from the one card clause and the one bank clause, for the member or an officer (`INV-SSOT`)", () => {
    const parts = { bankCents: 1500, checkCents: 0, formatAmount: fmt };
    expect(bookingCancelledRefundSentence(4500, "$45.00", "card", parts)).toBe(ownCardRefundWithShortfallSentence(3000, parts, false));
    // The card clause is the pending sentence without its full stop.
    expect(ownCardRefundWithShortfallSentence(3000, parts, true, "the member's")).toBe(
      `${ownCardRefundPendingSentence("$30.00", "the member's").slice(0, -1)}, and the club will refund the remaining $15.00 to the member by bank transfer.`,
    );
    // The bank clause is Booking Modified's and the refund appeal's sentence.
    expect(ownCardRefundWithShortfallSentence(0, { ...parts, bankCents: 4500 }, false)).toBe(bookingModifiedRefundSentence("$45.00", "member", "own"));
    expect(bookingModifiedRefundSentence("$45.00", "member", "own")).toBe(refundRequestApprovedRefundSentence(4500, 4500, fmt));
    expect(ownCardRefundWithShortfallSentence(0, { ...parts, bankCents: 0, checkCents: 4500 }, false, "the member's")).toBe(
      "The club will be in touch about the $45.00 refund.",
    );
  });

  it("#4119: the cancel preview says each part before anything is asked of the card, from the same clauses", () => {
    const fmtParts = (bankCents: number, checkCents: number) => ({ bankCents, checkCents, formatAmount: fmt });
    expect(ownCardRefundWithShortfallSentence(3000, fmtParts(1500, 0), "planned")).toBe(
      "A refund of $30.00 will be processed to your original payment method, and the club will refund the remaining $15.00 to you by bank transfer.",
    );
    // The planned card clause is the approved appeal's own.
    expect(ownCardRefundWithShortfallSentence(3000, fmtParts(1500, 0), "planned")).toBe(refundRequestApprovedRefundSentence(4500, 1500, fmt));
    expect(ownCardRefundWithShortfallSentence(3000, fmtParts(1000, 500), "planned", "the member's")).toBe(
      "A refund of $30.00 will be processed to the member's original payment method; the club will refund $10.00 to the member by bank transfer and will be in touch about the remaining $5.00.",
    );
    expect(ownCardRefundWithShortfallSentence(3000, fmtParts(0, 1500), "planned")).toBe(
      "A refund of $30.00 will be processed to your original payment method, and the club will be in touch about the remaining $15.00.",
    );
    // No card part: the same sentences as the cancel's own.
    expect(ownCardRefundWithShortfallSentence(0, fmtParts(4500, 0), "planned")).toBe(ownCardRefundWithShortfallSentence(0, fmtParts(4500, 0), false));
  });

  it("only an own-card refund takes a shortfall, and none reads as made", () => {
    expect(bookingCancelledRefundSentence(4500, "$45.00", "credit", { bankCents: 1500, checkCents: 0, formatAmount: fmt })).toBe(
      "A credit of $45.00 has been added to your account for future bookings.",
    );
    expect(bookingCancelledRefundMade(4500, "card", 1500)).toBe(false);
    expect(bookingCancelledRefundMade(4500, "card", 0)).toBe(true);
    expect(bookingCancelledRefundMade(4500, "card")).toBe(true);
  });
});

describe("#4097: the officers' alert names a card refund shortfall", () => {
  it("has its own subject, heading, amount label and note", () => {
    expect(manualRefundTaskAlertLabel("card-refund-shortfall")).toBe("card refund short on a cancelled booking");
    expect(manualRefundTaskAlertHeading("card-refund-shortfall")).toBe("Manual Refund Needed - Card Refund Short on a Cancelled Booking");
    expect(manualRefundTaskAlertAmountLabel("card-refund-shortfall")).toBe("Amount the card refund could not carry");
    expect(manualRefundTaskAlertNote("card-refund-shortfall")).toBe(`${CARD_REFUND_SHORTFALL_ALERT_LEAD}\n\n${CARD_REFUND_SHORTFALL_ALERT_BODY}`);
  });

  it("#4154 review: tells officers to mark each part paid back first and pay straight after the app accepts, never pay then mark", () => {
    expect(CARD_REFUND_SHORTFALL_ALERT_BODY).toContain("refunded by bank transfer: mark it paid back first, which records it and, where the booking has a Xero invoice, raises its refund credit note, then pay it straight after the app accepts.");
    expect(CARD_REFUND_SHORTFALL_ALERT_BODY).toContain("if it really is owed, mark it paid back first, after the bank-transfer part, then pay it by bank transfer straight after the app accepts.");
    expect(CARD_REFUND_SHORTFALL_ALERT_BODY).not.toMatch(/pay it(?: by bank transfer)?,? (?:then|and) mark/);
  });

  it("renders the shortfall arm, never the cash one", () => {
    const html = adminManualRefundTaskTemplate(
      {
        memberName: "Sam Lee",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        refundAmountCents: 1500,
        bookingId: "booking-1",
        reason: "reason",
        reviewUrl: "https://example.org/admin/payments",
        situation: "card-refund-shortfall",
      },
      CLUB_FORMAT_TEST,
    );

    expect(html).toContain(alertBox(CARD_REFUND_SHORTFALL_ALERT_LEAD, "warning"));
    expect(html).toContain("Amount the card refund could not carry");
    expect(html).toContain("$15.00");
    expect(html).not.toContain("settled in cash");
    // It says nothing about what the member was told: only the reason line can know.
    expect(html).not.toContain("has been told");
    expect(CARD_REFUND_SHORTFALL_ALERT_BODY).toMatch(/check Stripe and the bank, then contact the member with what you found/);
    expect(CARD_REFUND_SHORTFALL_ALERT_BODY).toMatch(/until the card refund itself has gone through/);
    expect(CARD_REFUND_SHORTFALL_ALERT_LEAD).toMatch(/has not been refunded by the card refund\.$/);
  });

  it.each(["cash-cancellation", "group-organiser-internet-banking", "card-refund-shortfall"] as const)(
    "the HTML heading is the shared table's (%s), with its dash typeset",
    (situation) => {
      const html = adminManualRefundTaskTemplate(
        { memberName: "Sam", checkIn: CHECK_IN, checkOut: CHECK_OUT, refundAmountCents: 100, bookingId: "b", reason: "r", reviewUrl: "https://example.org", situation },
        CLUB_FORMAT_TEST,
      );
      expect(html).toContain(manualRefundTaskAlertHeading(situation).replace(" - ", " — "));
    },
  );
});
