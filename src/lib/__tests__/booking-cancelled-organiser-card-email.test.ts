import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * #3973 — the "Booking Cancelled" email names the group organiser's card.
 *
 * A joiner cancelling a booking the group organiser paid for by card is refunded
 * to the ORGANISER's card (#3653), but the email told the joiner the refund had
 * gone "to your original payment method". The cancel's organiser-card branch now
 * passes "organiser_card", and the HTML email and the admin-editable body's
 * `{{refundMessage}}` both take their line from `bookingCancelledRefundSentence`,
 * whose organiser-card case is the sentence #3916 wrote for Booking Modified
 * (`organiserCardRefundSentence`), so neither the two paths nor the two emails
 * can drift apart. The other wordings are pinned here and by the render pins.
 *
 * The fix rounds add the rest: a refund to the organiser's card Stripe has not
 * made yet ("organiser_card_pending", the joiner's own cancel or the organiser's
 * cancel of the group), the organiser's earlier cancellation still refunding
 * ("group_cancel_refunding") or having refunded ("group_cancel_refunded") a
 * joiner's booking, and an Internet Banking settlement the club repays the
 * organiser by hand ("organiser_by_hand"). Only a refund already made reads as
 * a success, and `{{refundAmount}}` stays this booking's own figure when the
 * sentence names the group's refund.
 *
 * MUTATION PROOF. Drop the "organiser_card" case (it falls through to no
 * sentence) or map it to the own-card sentence and "organiser's card" fails;
 * reword the shared sentence and "from the one home" fails too. In
 * `booking-cancel.test.ts` (#3653), passing "card" to the email from the
 * organiser-card branch fails; the audit there must still record "card".
 */

const sendEmail = vi.hoisted(() => vi.fn(async () => ({ delivered: true })));

vi.mock("@/lib/email/core", () => ({ sendEmail }));

import {
  type BookingCancelledRefundMethod,
  bookingCancelledRefundMade,
  bookingModifiedRefundSentence,
  organiserCardRefundSentence,
  ownCardRefundPendingSentence,
} from "@/lib/booking-modified-email-copy";
import { bookingCancelledTemplate } from "@/lib/email-templates/booking";
import { alertBox } from "@/lib/email-templates/layout";
import { sendBookingCancelledEmail } from "@/lib/email/booking";
import { groupCancellationRefundNote } from "@/lib/organiser-child-refund";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

const ORGANISER_CARD =
  "A refund of $45.00 has been processed to the group organiser's card, because the group organiser paid for this booking.";
const OWN_CARD = "A refund of $45.00 has been processed to your original payment method.";
const CREDIT = "A credit of $45.00 has been added to your account for future bookings.";
const MANUAL =
  "You paid for this booking in cash or by bank transfer, so there is no card payment to reverse. The club will arrange your refund of $45.00 directly and will be in touch.";
const NO_REFUND = "No refund was applicable based on the cancellation policy.";
// #3973 fix rounds: a refund to the organiser's card not yet made, and the group's cancellation's refund.
const ORGANISER_CARD_PENDING =
  "A refund of $45.00 is on its way to the group organiser's card, because the group organiser paid for this booking.";
const GROUP_CANCEL_REFUNDING =
  "The group organiser's cancellation is already refunding $45.00 for this booking to the organiser's card.";
const GROUP_CANCEL_REFUNDED =
  "The group organiser's cancellation refunded $45.00 for this booking to the organiser's card.";
const ORGANISER_BY_HAND =
  "The club will refund $45.00 to the group organiser directly, because the group organiser paid for this booking.";

function html(refundCents: number, method: BookingCancelledRefundMethod) {
  return bookingCancelledTemplate("Sam", CHECK_IN, CHECK_OUT, refundCents, CLUB_FORMAT_TEST, method);
}

/** What the sender handed to the mailer: its HTML and the flat body's `{{refundMessage}}`. */
async function sent(refundCents: number, method: BookingCancelledRefundMethod, sentenceCents = refundCents) {
  sendEmail.mockClear();
  await sendBookingCancelledEmail(
    { bookingId: "booking-1", recipientMemberId: "member-1" },
    "sam@example.org",
    "Sam",
    CHECK_IN,
    CHECK_OUT,
    refundCents,
    CLUB_FORMAT_TEST,
    method,
    0,
    null,
    "cancellation-policy",
    sentenceCents,
  );
  const [call] = sendEmail.mock.calls as unknown as [[{ html: string; templateData: { refundMessage: string; refundAmount: string } }]];
  return { html: call[0].html, refundMessage: call[0].templateData.refundMessage, refundAmount: call[0].templateData.refundAmount };
}

beforeEach(() => {
  sendEmail.mockClear();
});

describe("#3973: the Booking Cancelled refund line names where the refund went", () => {
  it("organiser's card: names the group organiser's card, never the joiner's payment method", async () => {
    const template = html(4500, "organiser_card");
    const sender = await sent(4500, "organiser_card");

    expect(template).toContain(ORGANISER_CARD);
    expect(template).not.toContain("your original payment method");
    expect(sender.refundMessage).toBe(ORGANISER_CARD);
    expect(sender.html).toContain(ORGANISER_CARD);
    expect(sender.html).not.toContain("your original payment method");
  });

  it.each([
    ["organiser_card_pending", ORGANISER_CARD_PENDING],
    ["group_cancel_refunding", GROUP_CANCEL_REFUNDING],
    ["group_cancel_refunded", GROUP_CANCEL_REFUNDED],
    ["organiser_by_hand", ORGANISER_BY_HAND],
  ] as const)("%s: names the group organiser, never the joiner's payment method nor \"no refund\"", async (method, sentence) => {
    const template = html(4500, method);
    const sender = await sent(4500, method);

    expect(template).toContain(sentence);
    expect(sender.refundMessage).toBe(sentence);
    expect(sender.html).toContain(sentence);
    for (const body of [template, sender.html]) {
      expect(body).not.toContain("your original payment method");
      expect(body).not.toContain(NO_REFUND);
    }
  });

  it("the group's cancellation's sentences are the cancel preview's, switched on its debt's own status", () => {
    expect(groupCancellationRefundNote({ amountCents: 4500, status: "PENDING" }, CLUB_FORMAT_TEST)).toBe(GROUP_CANCEL_REFUNDING);
    expect(groupCancellationRefundNote({ amountCents: 4500, status: "FAILED" }, CLUB_FORMAT_TEST)).toBe(GROUP_CANCEL_REFUNDING);
    expect(groupCancellationRefundNote({ amountCents: 4500, status: "SUCCEEDED" }, CLUB_FORMAT_TEST)).toBe(GROUP_CANCEL_REFUNDED);
  });

  it("reads only a refund already made as a success", () => {
    for (const method of ["card", "credit", "organiser_card", "group_cancel_refunded"] as const) {
      expect(bookingCancelledRefundMade(4500, method)).toBe(true);
      expect(bookingCancelledRefundMade(0, method)).toBe(false);
    }
    for (const method of ["manual", "organiser_card_pending", "group_cancel_refunding", "organiser_by_hand", "card_pending"] as const) {
      expect(bookingCancelledRefundMade(4500, method)).toBe(false);
    }
  });

  it("keeps {{refundAmount}} this booking's own figure when the sentence names the group's refund", async () => {
    const sender = await sent(0, "group_cancel_refunding", 4500);

    expect(sender.refundAmount).toBe("$0.00");
    expect(sender.refundMessage).toBe(GROUP_CANCEL_REFUNDING);
    expect(sender.html).toContain(GROUP_CANCEL_REFUNDING);
  });

  it("is the Booking Modified sentence, from the one home", () => {
    expect(organiserCardRefundSentence("$45.00")).toBe(ORGANISER_CARD);
    expect(bookingModifiedRefundSentence("$45.00", null, "organiser_card")).toBe(ORGANISER_CARD);
  });

  it.each([
    ["card", OWN_CARD],
    ["credit", CREDIT],
    ["manual", MANUAL],
  ] as const)("%s: byte-identical to before, and no organiser's card", async (method, sentence) => {
    const template = html(4500, method);
    const sender = await sent(4500, method);

    expect(template).toContain(sentence);
    expect(template).not.toContain("organiser's card");
    expect(sender.refundMessage).toBe(sentence);
  });

  it("claims no refund when nothing was refunded, organiser-paid or not", async () => {
    expect(html(0, "organiser_card")).toContain(NO_REFUND);
    expect(html(0, "organiser_card")).not.toContain("organiser's card");
    expect((await sent(0, "organiser_card")).refundMessage).toBe(NO_REFUND);
  });
});

/**
 * #4084: a cancel's refund to the member's own card that Stripe did not make
 * (the call threw and the refund is queued for the recovery runner, or Stripe
 * answered `failed` or `canceled`) is on its way, in an info box: the Booking
 * Modified sentence (#4070), from the one home. A made refund ("card") keeps
 * its byte-identical success wording, pinned above and by the render pins.
 */
describe("#4084: the Booking Cancelled refund line for an own-card refund not made yet", () => {
  const OWN_CARD_PENDING = "A refund of $45.00 is on its way to your original payment method.";

  it("says on its way, in an info box, in the HTML and in {{refundMessage}}", async () => {
    const template = html(4500, "card_pending");
    const sender = await sent(4500, "card_pending");

    expect(template).toContain(alertBox(OWN_CARD_PENDING, "info"));
    expect(sender.html).toContain(alertBox(OWN_CARD_PENDING, "info"));
    expect(sender.refundMessage).toBe(OWN_CARD_PENDING);
    for (const body of [template, sender.html, sender.refundMessage]) {
      expect(body).not.toContain("has been processed");
      expect(body).not.toContain("organiser's card");
    }
  });

  it("keeps a made own-card refund in its success box", () => {
    expect(html(4500, "card")).toContain(alertBox(OWN_CARD, "success"));
  });

  it("is the Booking Modified sentence, from the one home", () => {
    expect(ownCardRefundPendingSentence("$45.00")).toBe(OWN_CARD_PENDING);
    expect(bookingModifiedRefundSentence("$45.00", null, "own_card_pending")).toBe(OWN_CARD_PENDING);
  });

  it("claims no refund when nothing was refunded", () => {
    expect(html(0, "card_pending")).toContain(NO_REFUND);
    expect(bookingCancelledRefundMade(0, "card_pending")).toBe(false);
  });
});
