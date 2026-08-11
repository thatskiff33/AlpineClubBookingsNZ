import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2320 review (MED-3) — bind the "false claim" senders to the composed note
 * tokens their shipped default bodies depend on. Four at #2320; the fifth
 * (`admin-late-capture-auto-refund`) joined at #2761, which is when a review found
 * that nothing pinned its population sentence either.
 *
 * The #2268 guards prove properties of the REGISTRY (defaults, approvals,
 * optional declarations), and the note helpers have their own unit truth — but
 * nothing proved the SENDERS still put the composed paragraph into
 * templateData. Drop one supply line (`settlementActionNote: ...`) and the
 * registry guards stay green while every club override of that template
 * renders the token as "" — silently deleting exactly the outcome-dependent
 * sentence #2268 existed to make truthful. These tests call each real sender
 * with a representative fixture, capture the templateData it builds, and
 * render the SHIPPED default body with it, asserting the note's lead sentence
 * survives end to end.
 */

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  sendToAdmins: vi.fn(),
  sendUnmuteableAdminAlert: vi.fn(),
}));

vi.mock("@/lib/email/core", () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock("@/lib/email/admin-alerts-shared", () => ({
  sendToAdmins: mocks.sendToAdmins,
  // #2761: the late-capture auto-refund alert ships through the unmuteable path,
  // so its composed note has to be captured from there, not from sendToAdmins.
  sendUnmuteableAdminAlert: mocks.sendUnmuteableAdminAlert,
}));

import { EMAIL_AUDIT_DEFAULTS } from "@/lib/email-message-audit-defaults";
import {
  renderTemplateString,
  type EmailTemplateData,
} from "@/lib/email-message-renderer";
import {
  sendAdminSplitSettlementCancelledAlert,
  sendAdminSplitSettlementUnpaidAlert,
} from "@/lib/email/admin-alerts-booking";
import {
  sendAdminDuplicateCaptureRefundAlert,
  sendAdminLateCaptureAutoRefundAlert,
  sendAdminLateCaptureHandBackConflictAlert,
} from "@/lib/email/admin-alerts-finance";
import {
  sendBookingBumpedEmail,
  sendSplitGuestPortionCancelledEmail,
} from "@/lib/email/booking";

function capturedAdminTemplateData(): EmailTemplateData {
  expect(mocks.sendToAdmins).toHaveBeenCalledTimes(1);
  const [args] = mocks.sendToAdmins.mock.calls[0] as [
    { templateData: EmailTemplateData },
  ];
  return args.templateData;
}

function capturedUnmuteableTemplateData(): EmailTemplateData {
  expect(mocks.sendUnmuteableAdminAlert).toHaveBeenCalledTimes(1);
  const [args] = mocks.sendUnmuteableAdminAlert.mock.calls[0] as [
    { templateData: EmailTemplateData },
  ];
  return args.templateData;
}

function renderDefaultBody(
  templateName: keyof typeof EMAIL_AUDIT_DEFAULTS,
  data: EmailTemplateData,
): string {
  return renderTemplateString(
    EMAIL_AUDIT_DEFAULTS[templateName].defaultBody,
    data,
  );
}

describe("#2320 review — senders supply the composed notes their defaults render", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendEmail.mockResolvedValue(undefined);
    mocks.sendToAdmins.mockResolvedValue(undefined);
    mocks.sendUnmuteableAdminAlert.mockResolvedValue(undefined);
  });

  it("admin-split-settlement-unpaid: {{settlementActionNote}} is supplied and renders its lead sentence", async () => {
    await sendAdminSplitSettlementUnpaidAlert({
      memberName: "Alice Example",
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      guestCount: 3,
      totalCents: 45000,
      holdUntil: new Date("2026-07-09T18:00:00.000Z"),
      parentUnpaid: false,
    });

    const data = capturedAdminTemplateData();
    expect(typeof data.settlementActionNote).toBe("string");
    expect(String(data.settlementActionNote).trim()).not.toBe("");

    const rendered = renderDefaultBody("admin-split-settlement-unpaid", data);
    expect(rendered).toContain(
      "A split booking reached its hold deadline for the non-member guest portion",
    );
    // The truthful outcome arm for this fixture: a link WAS emailed.
    expect(rendered).toContain(
      "A secure payment link has been emailed to the member",
    );
  });

  it("admin-split-settlement-cancelled: {{settlementActionNote}} is supplied and renders its lead sentence", async () => {
    await sendAdminSplitSettlementCancelledAlert({
      memberName: "Alice Example",
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      guestCount: 3,
      totalCents: 45000,
      parentUnpaid: false,
    });

    const data = capturedAdminTemplateData();
    expect(typeof data.settlementActionNote).toBe("string");
    expect(String(data.settlementActionNote).trim()).not.toBe("");

    const rendered = renderDefaultBody(
      "admin-split-settlement-cancelled",
      data,
    );
    expect(rendered).toContain(
      "A split booking's non-member guest portion was still unpaid at the end of its check-in day",
    );
    // The cancelled paragraph, not the recurring unpaid alert's (they share a
    // token name; supplying the wrong helper's output must go red).
    expect(rendered).toContain(
      "The provisional guest booking has now been automatically cancelled",
    );
    expect(rendered).not.toContain("hold has been extended");
  });

  it("admin-duplicate-capture-refund: {{refundOutcomeNote}} tells the true story on both outcomes", async () => {
    await sendAdminDuplicateCaptureRefundAlert({
      memberName: "Alice Example",
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      amountCents: 12345,
      paymentIntentId: "pi_dup_1",
      settledPaymentIntentId: "pi_settled_1",
      operationReference: "op_1",
      errorMessage: null,
      refundFailed: false,
    });

    const data = capturedAdminTemplateData();
    expect(typeof data.refundOutcomeNote).toBe("string");
    expect(String(data.refundOutcomeNote).trim()).not.toBe("");
    const rendered = renderDefaultBody("admin-duplicate-capture-refund", data);
    expect(rendered).toContain(
      "The duplicate charge was automatically refunded in full",
    );

    // The failure arm — the exact claim the pre-#2268 flat body got wrong —
    // must state the refund did NOT complete, and must carry the detail.
    mocks.sendToAdmins.mockClear();
    await sendAdminDuplicateCaptureRefundAlert({
      memberName: "Alice Example",
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      amountCents: 12345,
      paymentIntentId: "pi_dup_1",
      settledPaymentIntentId: "pi_settled_1",
      operationReference: "op_1",
      errorMessage: "card_declined",
      refundFailed: true,
    });
    const failedData = capturedAdminTemplateData();
    const failedRendered = renderDefaultBody(
      "admin-duplicate-capture-refund",
      failedData,
    );
    expect(failedRendered).toContain("the refund could not complete inline");
    expect(failedRendered).toContain("Failure detail: card_declined");
    expect(failedRendered).not.toContain("refunded in full");
  });

  it("admin-late-capture-auto-refund: {{refundOutcomeNote}} names the right population on both arms", async () => {
    /*
      #2761. The two arms need genuinely different follow-up — a DELETED booking
      may have been deleted by mistake, in which case it has to be remade and the
      member charged again, while a merely cancelled one is normal operation — so
      dropping the supply line here would render the token as "" for every club
      override and delete exactly the sentence that tells the two apart.
    */
    await sendAdminLateCaptureAutoRefundAlert({
      memberName: "Alice Example",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      amountCents: 2500,
      paymentIntentId: "pi_additional_late",
      bookingId: "booking-9",
      bookingDeleted: true,
      captureKind: "modification",
    });

    const deletedData = capturedUnmuteableTemplateData();
    expect(typeof deletedData.refundOutcomeNote).toBe("string");
    expect(String(deletedData.refundOutcomeNote).trim()).not.toBe("");
    const deletedRendered = renderDefaultBody(
      "admin-late-capture-auto-refund",
      deletedData,
    );
    expect(deletedRendered).toContain("had already been DELETED");
    expect(deletedRendered).toContain("charged again");
    expect(deletedRendered).not.toContain("there is usually nothing to do");

    mocks.sendUnmuteableAdminAlert.mockClear();
    await sendAdminLateCaptureAutoRefundAlert({
      memberName: "Alice Example",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      amountCents: 2500,
      paymentIntentId: "pi_additional_late",
      bookingId: "booking-9",
      bookingDeleted: false,
      captureKind: "modification",
    });

    const cancelledData = capturedUnmuteableTemplateData();
    const cancelledRendered = renderDefaultBody(
      "admin-late-capture-auto-refund",
      cancelledData,
    );
    expect(cancelledRendered).toContain("had already been CANCELLED");
    expect(cancelledRendered).toContain("there is usually nothing to do");
    expect(cancelledRendered).not.toContain("had already been DELETED");
  });

  it("admin-late-capture-auto-refund: {{lateCaptureLeadNote}} names the right capture on both kinds", async () => {
    /*
      #2773. The shipped default used to hard-code "a booking-change payment" and
      "the supplementary Xero invoice for the change was not released". Both handlers
      send this mail now, and neither sentence is true about the booking's OWN
      payment - which has no supplementary invoice at all - so dropping the supply
      line here would render the token as "" for every club override AND leave the
      default asserting the wrong accounting for half the events it reports.
    */
    await sendAdminLateCaptureAutoRefundAlert({
      memberName: "Alice Example",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      amountCents: 2500,
      paymentIntentId: "pi_additional_late",
      bookingId: "booking-9",
      bookingDeleted: true,
      captureKind: "modification",
    });

    const modificationData = capturedUnmuteableTemplateData();
    expect(typeof modificationData.lateCaptureLeadNote).toBe("string");
    expect(String(modificationData.lateCaptureLeadNote).trim()).not.toBe("");
    const modificationRendered = renderDefaultBody(
      "admin-late-capture-auto-refund",
      modificationData,
    );
    expect(modificationRendered).toContain("supplementary Xero invoice");

    mocks.sendUnmuteableAdminAlert.mockClear();
    await sendAdminLateCaptureAutoRefundAlert({
      memberName: "Alice Example",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      amountCents: 2500,
      paymentIntentId: "pi_primary_late",
      bookingId: "booking-9",
      bookingDeleted: true,
      captureKind: "primary",
    });

    const primaryRendered = renderDefaultBody(
      "admin-late-capture-auto-refund",
      capturedUnmuteableTemplateData(),
    );
    expect(primaryRendered).not.toContain("supplementary Xero invoice");
    expect(primaryRendered).toContain("payment for the booking itself");
  });

  it("admin-late-capture-hand-back-conflict: {{handBackConflictNote}} says which way the money went", async () => {
    /*
      #2774. The whole message is the direction. A default body that stated one
      direction would tell an operator the opposite of what happened on the other -
      either that a withheld refund had gone out, or that a double payment had not.
    */
    await sendAdminLateCaptureHandBackConflictAlert({
      memberName: "Alice Example",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      amountCents: 2500,
      paymentIntentId: "pi_additional_late",
      bookingId: "booking-9",
      bookingDeleted: false,
      captureKind: "modification",
      handBackAmountCents: 2500,
      refundSent: false,
    });

    const withheldData = capturedUnmuteableTemplateData();
    expect(typeof withheldData.handBackConflictNote).toBe("string");
    expect(String(withheldData.handBackConflictNote).trim()).not.toBe("");
    const withheldRendered = renderDefaultBody(
      "admin-late-capture-hand-back-conflict",
      withheldData,
    );
    expect(withheldRendered).toContain("has NOT been sent back a second time");
    expect(withheldRendered).not.toContain("may have gone back TWICE");

    mocks.sendUnmuteableAdminAlert.mockClear();
    await sendAdminLateCaptureHandBackConflictAlert({
      memberName: "Alice Example",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      amountCents: 2500,
      paymentIntentId: "pi_additional_late",
      bookingId: "booking-9",
      bookingDeleted: false,
      captureKind: "modification",
      handBackAmountCents: null,
      refundSent: true,
    });

    const sentRendered = renderDefaultBody(
      "admin-late-capture-hand-back-conflict",
      capturedUnmuteableTemplateData(),
    );
    expect(sentRendered).toContain("may have gone back TWICE");
    expect(sentRendered).not.toContain("has NOT been sent back a second time");
  });

  it("split-guest-portion-cancelled: {{ownBookingNote}} is supplied and renders its reassurance sentence", async () => {
    await sendSplitGuestPortionCancelledEmail({
      bookingId: "booking_1",
      recipientMemberId: "member_1",
      email: "member@example.org",
      firstName: "Alice",
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      parentConfirmed: true,
      parentBookingReference: "BK-1234",
    });

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const [args] = mocks.sendEmail.mock.calls[0] as [
      { templateName: string; templateData: EmailTemplateData },
    ];
    expect(args.templateName).toBe("split-guest-portion-cancelled");
    expect(typeof args.templateData.ownBookingNote).toBe("string");
    expect(String(args.templateData.ownBookingNote).trim()).not.toBe("");

    const rendered = renderDefaultBody(
      "split-guest-portion-cancelled",
      args.templateData,
    );
    // The confirmed-parent sentence — the promise the pre-#2268 flat body made
    // unconditionally is now only made when it is true.
    expect(rendered).toContain(
      "your own booking is unaffected and remains confirmed",
    );
  });
});

// ---------------------------------------------------------------------------
// #2430 — the bumped notice's way back in, per recipient class.
// ---------------------------------------------------------------------------
describe("#2430 booking-bumped points each recipient class somewhere it can go", () => {
  const BASE_URL = "https://club.example.org";
  const SUPPORT_EMAIL = "club@example.org";
  const SUPPORT_LINE = `If you have any questions, contact the club at ${SUPPORT_EMAIL}.`;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendEmail.mockResolvedValue(undefined);
  });

  async function bumpedTemplateData(
    recipientCanBookOnline: boolean,
  ): Promise<EmailTemplateData> {
    await sendBookingBumpedEmail(
      { bookingId: "booking_1", recipientMemberId: "member_1" },
      "someone@example.org",
      "Alice",
      new Date("2026-07-10"),
      new Date("2026-07-12"),
      2,
      null,
      recipientCanBookOnline,
    );
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const [args] = mocks.sendEmail.mock.calls[0] as [
      { templateName: string; templateData: EmailTemplateData },
    ];
    expect(args.templateName).toBe("booking-bumped");
    // BASE_URL and SUPPORT_EMAIL are GLOBAL tokens resolved from the club's own
    // configured public URL and support address at render time, which is
    // exactly why the sender supplies only the caption and the path.
    return { ...args.templateData, BASE_URL, SUPPORT_EMAIL };
  }

  it("a club member still gets the members-only booking flow", async () => {
    const rendered = renderDefaultBody(
      "booking-bumped",
      await bumpedTemplateData(true),
    );
    expect(rendered).toContain(
      `

Book Again: ${BASE_URL}/book

${SUPPORT_LINE}

We apologise for the inconvenience.`,
    );
    expect(rendered).not.toContain("Contact the Club");
  });

  it("a non-login contact gets the club contact page instead of a login they cannot complete", async () => {
    const rendered = renderDefaultBody(
      "booking-bumped",
      await bumpedTemplateData(false),
    );
    expect(rendered).toContain(
      `

Contact the Club: ${BASE_URL}/contact

${SUPPORT_LINE}

We apologise for the inconvenience.`,
    );
    expect(rendered).not.toContain("Book Again");
    expect(rendered).not.toContain(`${BASE_URL}/book`);
  });

  // #2430 review: the contact page is a club-authored page and need not host a
  // contact form, so a recipient who cannot sign in must be given an address
  // too. Both classes get the same courtesy line.
  it("names the club's support address for both classes", async () => {
    for (const canBook of [true, false]) {
      mocks.sendEmail.mockClear();
      const rendered = renderDefaultBody(
        "booking-bumped",
        await bumpedTemplateData(canBook),
      );
      expect(rendered).toContain(SUPPORT_LINE);
    }
  });

  it("leaves no dangling caption or bare base URL for either class", async () => {
    for (const canBook of [true, false]) {
      mocks.sendEmail.mockClear();
      const data = await bumpedTemplateData(canBook);
      expect(String(data.rebookLabel).trim()).not.toBe("");
      expect(String(data.rebookPath)).toMatch(/^\/[a-z]/);
      const rendered = renderDefaultBody("booking-bumped", data);
      expect(rendered).not.toMatch(/:\s*$/m);
      expect(rendered).not.toContain("{{");
    }
  });
});
