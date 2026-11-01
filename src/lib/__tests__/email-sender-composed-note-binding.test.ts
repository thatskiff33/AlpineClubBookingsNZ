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

// #3643: the hold-kept alert stamps the Xero organisation at send time.
vi.mock("@/lib/xero-link-short-code", () => ({
  getXeroOrgShortCode: async () => null,
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
  sendAdminManualRefundTaskAlert,
} from "@/lib/email/admin-alerts-finance";
import { sendAdminInternetBankingHoldKeptAlert } from "@/lib/email/admin-alerts-internet-banking";
import { sendAdminLateCaptureRefundedOutsideAppAlert } from "@/lib/email/admin-alerts-late-capture";
import { sendAdminUnrecognisedStripePaymentAlert } from "@/lib/email/admin-alerts-unrecognised-stripe-payment";
import { UNRECOGNISED_STRIPE_PAYMENT_NOTE } from "@/lib/unrecognised-stripe-payment-note";
import { LATE_CAPTURE_REFUNDED_OUTSIDE_APP_NOTE } from "@/lib/late-capture-outside-app-note";
import {
  sendAdminBankTransferSettlementFigureAlert,
  sendAdminSecondInstrumentSettlementConflictAlert,
  sendAdminDuplicateCaptureKeptAlert,
  sendAdminSupersededCaptureRefusedAlert,
} from "@/lib/email/admin-alerts-settlement";
import {
  sendBookingBumpedEmail,
  sendSplitGuestPortionCancelledEmail,
} from "@/lib/email/booking";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

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
    // What `sendToAdmins` really returns (#3672); a sender that reads it,
    // like #3643's hold-kept alert, needs the shape rather than undefined.
    mocks.sendToAdmins.mockResolvedValue({
      deliveryAllowed: true,
      recipients: 1,
      sent: 1,
      queuedForRetry: 0,
      notDelivered: 0,
    });
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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);
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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

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
    }, CLUB_FORMAT_TEST);

    const sentRendered = renderDefaultBody(
      "admin-late-capture-hand-back-conflict",
      capturedUnmuteableTemplateData(),
    );
    expect(sentRendered).toContain("may have gone back TWICE");
    expect(sentRendered).not.toContain("has NOT been sent back a second time");
  });

  it("admin-internet-banking-hold-kept: {{holdKeptNote}} gives the instruction each reason needs (#3643)", async () => {
    /*
      Part-paid says wait for the rest or cancel in the app (which credits the
      part payment); paid-in-full says the sync is behind; unreadable says the
      job keeps trying up to the bound; released-unreadable says it let go.
      One editable body carries all four only through the token.
    */
    const send = (
      reason:
        | "part-paid"
        | "part-paid-manual"
        | "paid-in-full"
        | "unreadable"
        | "released-unreadable"
        | "cancelled-payment-recorded",
    ) =>
      sendAdminInternetBankingHoldKeptAlert({
        reason,
        memberName: "Alice Example",
        bookingId: "booking-9",
        checkIn: new Date("2026-08-01"),
        checkOut: new Date("2026-08-03"),
        holdUntil:
          reason === "cancelled-payment-recorded" ? null : new Date("2026-07-20T00:00:00Z"),
        paidCents: reason === "part-paid" ? 5000 : null,
        amountOwingCents: reason === "part-paid" ? 10000 : null,
        xeroInvoiceNumber: "INV-001",
        xeroInvoiceUrl: null,
      }, CLUB_FORMAT_TEST);
    const rendered = async (reason: Parameters<typeof send>[0]) => {
      mocks.sendToAdmins.mockClear();
      await send(reason);
      return renderDefaultBody("admin-internet-banking-hold-kept", capturedAdminTemplateData());
    };

    const partPaid = await rendered("part-paid");
    expect(partPaid).toContain("Xero shows part of its invoice already paid");
    expect(partPaid).toContain("records the part payment as money received");
    expect(partPaid).toContain("Paid so far: $50.00");
    expect(partPaid).toContain("Still owing: $100.00");

    const paidInFull = await rendered("paid-in-full");
    expect(paidInFull).toContain("paid in full");
    expect(paidInFull).not.toContain("pay the rest");

    const unreadable = await rendered("unreadable");
    expect(unreadable).toContain("could not be read from Xero");
    expect(unreadable).toContain("seven days after the hold deadline");
    expect(unreadable).toContain("Paid so far: unknown");

    const released = await rendered("released-unreadable");
    expect(released).toContain("has now been released");
    expect(released).not.toContain("NOT cancelled");

    // #3643 D5: an organisation's, or an unsizable, payment is settled by hand.
    const manual = await rendered("part-paid-manual");
    expect(manual).toContain("cannot hand this payment back as account credit");
    expect(manual).not.toContain("returns the refundable share");

    // DECISION 2: the cancel alert, for a booking that may never have held.
    const cancelled = await rendered("cancelled-payment-recorded");
    expect(cancelled).toContain("cancelled as unpaid");
    expect(cancelled).toContain("Hold deadline: none");
  });

  it("admin-bank-transfer-settlement-figure: {{settlementFigureNote}} says what needs a person (#3979)", async () => {
    const alert = {
      memberName: "Alice Example",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      bookingId: "booking-9",
      keptReason: "folded-refund" as const,
      owed: null,
      hasSupplementaryInvoice: false,
      recordedCents: 30000,
      cashCents: 20000,
      owedCents: null,
      xeroInvoiceNumber: "INV-9",
      // No link, so the send-time organisation stamp is not exercised here.
      xeroInvoiceUrl: null,
    };
    await sendAdminBankTransferSettlementFigureAlert(alert, CLUB_FORMAT_TEST);

    const keptRendered = renderDefaultBody("admin-bank-transfer-settlement-figure", capturedUnmuteableTemplateData());
    expect(keptRendered).toContain("kept the amount it had recorded instead of the cash");
    expect(keptRendered).toContain("the owner or a developer");
    expect(keptRendered).toContain("Amount recorded: $300.00");
    expect(keptRendered).toContain("Cash Xero shows: $200.00");
    // Unmuteable and named for the event, never the payment-failure mail.
    const [keptArgs] = mocks.sendUnmuteableAdminAlert.mock.calls[0] as [
      { subject: string; templateName: string },
    ];
    expect(keptArgs.subject).toBe("Bank transfer amount needs checking: Alice Example");
    expect(keptArgs.templateName).toBe("admin-bank-transfer-settlement-figure");
    expect(mocks.sendToAdmins).not.toHaveBeenCalled();

    mocks.sendUnmuteableAdminAlert.mockClear();
    await sendAdminBankTransferSettlementFigureAlert(
      { ...alert, keptReason: null, owed: "overpaid", owedCents: 15000 },
      CLUB_FORMAT_TEST,
    );
    const owedRendered = renderDefaultBody("admin-bank-transfer-settlement-figure", capturedUnmuteableTemplateData());
    expect(owedRendered).toContain("The member paid more than the booking owes");
    expect(owedRendered).not.toContain("kept the amount");
    expect(owedRendered).toContain("Booking owes: $150.00");
  });

  it("admin-late-capture-refunded-outside-app: {{outsideAppRefundNote}} says what the app did not do (#4170)", async () => {
    await sendAdminLateCaptureRefundedOutsideAppAlert(
      {
        memberName: "Alice Example",
        checkIn: new Date("2026-08-01"),
        checkOut: new Date("2026-08-03"),
        bookingId: "booking-9",
        paymentIntentId: "pi_late_9",
        refundedCents: 2500,
      },
      CLUB_FORMAT_TEST,
    );

    const data = capturedUnmuteableTemplateData();
    expect(data.outsideAppRefundNote).toBe(LATE_CAPTURE_REFUNDED_OUTSIDE_APP_NOTE);
    const rendered = renderDefaultBody("admin-late-capture-refunded-outside-app", data);
    expect(rendered).toContain("raised no Xero credit note");
    expect(rendered).toContain("Amount refunded: $25.00");
    expect(rendered).toContain("Stripe reference: pi_late_9");
    // Unmuteable, named for the event, owned by Finance editors - never the payment-failure mail.
    const [args] = mocks.sendUnmuteableAdminAlert.mock.calls[0] as [
      { subject: string; templateName: string; requirement: unknown },
    ];
    expect(args.subject).toBe("Late payment refunded outside the app - check Xero: Alice Example");
    expect(args.templateName).toBe("admin-late-capture-refunded-outside-app");
    expect(args.requirement).toEqual({ area: "finance", level: "edit" });
    expect(mocks.sendToAdmins).not.toHaveBeenCalled();
  });

  it("admin-unrecognised-stripe-payment: {{unrecognisedPaymentNote}} says how to code it, and every Stripe id renders (#4532)", async () => {
    await sendAdminUnrecognisedStripePaymentAlert({
      amount: "$50.00",
      receivedAt: "1 Jul 2026, 9:00 am",
      description: "Donation",
      paymentIntentId: "pi_foreign_1",
      chargeId: "ch_foreign_1",
      checkoutSessionId: "cs_foreign_1",
      paymentLinkId: "plink_foreign_1",
      stripeDashboardUrl: "https://dashboard.stripe.com/payments/pi_foreign_1",
    });

    const data = capturedUnmuteableTemplateData();
    expect(data.unrecognisedPaymentNote).toBe(UNRECOGNISED_STRIPE_PAYMENT_NOTE);
    const rendered = renderDefaultBody("admin-unrecognised-stripe-payment", data);
    expect(rendered).toContain("Stripe clearing account");
    expect(rendered).toContain("Amount: $50.00");
    expect(rendered).toContain("Description: Donation");
    expect(rendered).toContain("Stripe payment: pi_foreign_1");
    expect(rendered).toContain("Charge: ch_foreign_1");
    expect(rendered).toContain("Checkout session: cs_foreign_1");
    expect(rendered).toContain("Payment Link: plink_foreign_1");
    expect(rendered).toContain("Open in Stripe: https://dashboard.stripe.com/payments/pi_foreign_1");
    const [args] = mocks.sendUnmuteableAdminAlert.mock.calls[0] as [
      { subject: string; templateName: string; requirement: unknown },
    ];
    expect(args.subject).toBe("Stripe payment the app did not create - code it in Xero: $50.00");
    expect(args.templateName).toBe("admin-unrecognised-stripe-payment");
    expect(args.requirement).toEqual({ area: "finance", level: "edit" });
    expect(mocks.sendToAdmins).not.toHaveBeenCalled();
  });

  it("admin-manual-refund-task: {{handBackNote}} and {{handBackLabel}} say which hand-back it is (#4042)", async () => {
    const send = async (situation?: "group-organiser-internet-banking" | "joiner-cancel-organiser") => {
      mocks.sendToAdmins.mockClear();
      await sendAdminManualRefundTaskAlert({
        memberName: "Alice Example",
        checkIn: new Date("2026-08-01"),
        checkOut: new Date("2026-08-03"),
        refundAmountCents: 7500,
        bookingId: "booking-9",
        reason: "reason-1",
        ...(situation ? { situation } : {}),
      }, CLUB_FORMAT_TEST);
      const [args] = mocks.sendToAdmins.mock.calls[0] as [{ subject: string; templateData: EmailTemplateData }];
      return {
        subject: args.subject,
        defaultSubject: renderTemplateString(EMAIL_AUDIT_DEFAULTS["admin-manual-refund-task"].defaultSubject, args.templateData),
        body: renderDefaultBody("admin-manual-refund-task", capturedAdminTemplateData()),
      };
    };

    // The cash cancel (#2262), every caller before #4042: its subject unchanged.
    const cash = await send();
    expect(cash.subject).toBe("Manual refund needed — cash booking cancelled: Alice Example");
    expect(cash.defaultSubject).toBe("Manual refund needed - cash booking cancelled: Alice Example");
    expect(cash.body).toContain("A booking settled in cash");
    expect(cash.body).toContain("The member's cancellation refund has been worked out under the club's normal policy");
    expect(cash.body).toContain("so the ledger records the refund");
    expect(cash.body).toContain("Member: Alice Example");
    expect(cash.body).toContain("Amount to refund: $75.00");
    // The cash text default reads exactly as it did before #4042.
    expect(cash.body).toBe(
      "Manual Refund Needed - Cash Booking Cancelled\n\nA booking settled in cash (or by an off-Xero bank transfer) has been cancelled. The refund has to be paid back by hand - nothing was refunded automatically.\n\nThe member's cancellation refund has been worked out under the club's normal policy, but there is no card charge to reverse and no Xero invoice to credit, so the system has raised a hand-back task instead of pretending money moved. The member has been told the club will arrange the refund.\n\nPay the member back, then mark the task complete on the payments board so the ledger records the refund. If the member declines it, or it was settled another way, dismiss the task with a note.\n\nMember: Alice Example\nCheck-in: " + cash.body.split("Check-in: ")[1],
    );
    expect(cash.body.startsWith("Manual Refund Needed - Cash Booking Cancelled\n")).toBe(true);

    // An organiser's Internet Banking group cancel: the refunds are already booked.
    const group = await send("group-organiser-internet-banking");
    expect(group.subject).toBe("Manual refund needed — Internet Banking group cancelled: Alice Example");
    expect(group.defaultSubject).toBe("Manual refund needed - Internet Banking group cancelled: Alice Example");
    expect(group.body).toContain("repay the organiser by bank transfer");
    expect(group.body).toContain("recorded in the app's ledger as made");
    expect(group.body).toContain("Organiser: Alice Example");
    expect(group.body.startsWith("Manual Refund Needed - Internet Banking Group Cancelled\n")).toBe(true);
    expect(group.body).toContain("Owed when this alert was sent: $75.00");
    expect(group.body).not.toContain("settled in cash");
    expect(group.body).not.toContain("no Xero invoice to credit");
    expect(group.body).not.toMatch(/in Xero/);

    // #3949 (owner decision, 22 Oct 2026): a joiner's own cancel of a place the organiser paid for by Internet Banking.
    const joiner = await send("joiner-cancel-organiser");
    expect(joiner.subject).toBe("Manual refund needed — group joiner cancelled, refund to the organiser: Alice Example");
    expect(joiner.body.startsWith("Manual Refund Needed - Group Joiner Cancelled, Refund to the Organiser\n")).toBe(true);
    expect(joiner.body).toContain("repay the organiser by bank transfer");
    expect(joiner.body).toContain("never to the joiner");
    expect(joiner.body).toContain("Until automatic Xero notes are added");
    expect(joiner.body).not.toMatch(/#\d/);
    // Review round 4: the row names the organiser it repays, as #4042's alert does.
    expect(joiner.body).toContain("Organiser: Alice Example");
    expect(joiner.body).toContain("Amount to refund to the organiser: $75.00");
    expect(joiner.body).not.toContain("settled in cash");
  });

  it("admin-second-instrument-settlement-conflict: {{secondInstrumentConflictNote}} says what the card money already did (#3638)", async () => {
    const alert = {
      memberName: "Alice Example",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      bookingId: "booking-9",
      bookingStatus: "PAID",
      conflictKind: "settled" as const,
      invoiceAmountCents: 27000,
      cardHeldCents: 27000,
      cardPaymentIntentId: "pi_card",
      xeroInvoiceNumber: "INV-9",
      // No link, so the send-time organisation stamp is not exercised here.
      xeroInvoiceUrl: null,
    };
    await sendAdminSecondInstrumentSettlementConflictAlert(alert, CLUB_FORMAT_TEST);

    const liveData = capturedUnmuteableTemplateData();
    const liveRendered = renderDefaultBody(
      "admin-second-instrument-settlement-conflict",
      liveData,
    );
    expect(liveRendered).toContain("This booking may have been paid TWICE");
    expect(liveRendered).not.toContain("later cancelled");
    expect(liveRendered).toContain("Booking: booking-9");
    expect(liveRendered).toContain("/bookings/booking-9");
    // Unmuteable and named for the event, never the payment-failure mail.
    const [liveArgs] = mocks.sendUnmuteableAdminAlert.mock.calls[0] as [
      { subject: string; templateName: string },
    ];
    expect(liveArgs.subject).toContain("may have been paid twice");
    expect(liveArgs.templateName).toBe("admin-second-instrument-settlement-conflict");
    expect(mocks.sendToAdmins).not.toHaveBeenCalled();

    mocks.sendUnmuteableAdminAlert.mockClear();
    await sendAdminSecondInstrumentSettlementConflictAlert(
      { ...alert, bookingStatus: "CANCELLED", conflictKind: "cancelledAfterCard" },
      CLUB_FORMAT_TEST,
    );
    const cancelledRendered = renderDefaultBody(
      "admin-second-instrument-settlement-conflict",
      capturedUnmuteableTemplateData(),
    );
    expect(cancelledRendered).toContain("paid by card and later cancelled");
    expect(cancelledRendered).not.toContain("This booking may have been paid TWICE");

    // #3638 delta D3: the #1765 arm. The card was refunded before the switch,
    // so the mail must not claim the cancellation settled it, nor that the
    // booking was paid twice.
    mocks.sendUnmuteableAdminAlert.mockClear();
    await sendAdminSecondInstrumentSettlementConflictAlert(
      { ...alert, bookingStatus: "CANCELLED", conflictKind: "cancelledAfterRefund" },
      CLUB_FORMAT_TEST,
    );
    const refundRendered = renderDefaultBody(
      "admin-second-instrument-settlement-conflict",
      capturedUnmuteableTemplateData(),
    );
    expect(refundRendered).toContain("refunded before it moved to Internet Banking");
    expect(refundRendered).toContain("Nothing was paid twice");
    expect(refundRendered).not.toContain("already settled the card payment");
  });

  it("admin-duplicate-capture-kept: {{duplicateCaptureKeptNote}} says why nothing was refunded, per reason (#4211)", async () => {
    const alert = {
      memberName: "Alice Example",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      bookingId: "booking-9",
      reason: "not-recorded" as const,
      amountCents: 27000,
      paymentIntentId: "pi_kept",
      otherPaymentIntentId: "pi_other",
    };
    await sendAdminDuplicateCaptureKeptAlert(alert, CLUB_FORMAT_TEST);
    const notRecorded = renderDefaultBody("admin-duplicate-capture-kept", capturedUnmuteableTemplateData());
    expect(notRecorded).toContain("card payment pi_other on it still holds money");
    expect(notRecorded).toContain("no record of which payment settled this booking");
    expect(notRecorded).toContain("check in Stripe that neither payment has already been refunded");
    expect(notRecorded).toContain("refund the other one by hand");
    expect(notRecorded).toContain("Booking: booking-9");
    const [args] = mocks.sendUnmuteableAdminAlert.mock.calls[0] as [{ subject: string; templateName: string }];
    expect(args.subject).toBe("Booking may have been paid twice — check by hand: Alice Example");
    expect(args.templateName).toBe("admin-duplicate-capture-kept");
    expect(mocks.sendToAdmins).not.toHaveBeenCalled();

    mocks.sendUnmuteableAdminAlert.mockClear();
    await sendAdminDuplicateCaptureKeptAlert(
      { ...alert, reason: "settler-released", otherPaymentIntentId: null },
      CLUB_FORMAT_TEST,
    );
    const released = renderDefaultBody("admin-duplicate-capture-kept", capturedUnmuteableTemplateData());
    expect(released).toContain("a cash or bank payment on it still holds money");
    expect(released).toContain("no longer holds money");
    expect(released).not.toContain("no record of which payment settled");

    mocks.sendUnmuteableAdminAlert.mockClear();
    await sendAdminDuplicateCaptureKeptAlert(
      { ...alert, reason: "settler-released", otherPaymentIntentId: null, otherHoldsMoney: false },
      CLUB_FORMAT_TEST,
    );
    const alone = renderDefaultBody("admin-duplicate-capture-kept", capturedUnmuteableTemplateData());
    expect(alone).toContain("the app counts no other payment on it as settling it");
    expect(alone).toContain("whether this payment now pays for the booking or is a duplicate");
    expect(alone).not.toContain("a cash or bank payment");
    // #4211 review: never "refund the other one" when there is no other one.
    expect(alone).not.toContain("refund the other one");
    expect(alone).toContain("refund it by hand only if the booking should not be paid by it");

    // #4285 review: a lone capture the app had never recorded, on a booking paid some other way.
    mocks.sendUnmuteableAdminAlert.mockClear();
    await sendAdminDuplicateCaptureKeptAlert(
      { ...alert, reason: "new-capture", otherPaymentIntentId: null, otherHoldsMoney: false },
      CLUB_FORMAT_TEST,
    );
    const stray = renderDefaultBody("admin-duplicate-capture-kept", capturedUnmuteableTemplateData());
    expect(stray).toContain("A new card payment was recorded on this booking after it was already paid, and the app counts no other payment on it as settling it");
    // #4285 review 7 F5: never "no other card or bank payment holds money", which the ledger reading cannot prove.
    expect(stray).not.toContain("card or bank payment on it hold");
    expect(stray).toContain("the booking was paid some other way");
    expect(stray).not.toContain("no record of which payment settled");
    // Only one payment: no "neither payment" Stripe check (#4285 review).
    expect(stray).not.toContain("neither payment");

    // #4285 review F3: the same payment's owed alert, after the booking was cancelled.
    mocks.sendUnmuteableAdminAlert.mockClear();
    await sendAdminDuplicateCaptureKeptAlert(
      { ...alert, reason: "new-capture-closed", otherPaymentIntentId: null, otherHoldsMoney: false },
      CLUB_FORMAT_TEST,
    );
    const closed = renderDefaultBody("admin-duplicate-capture-kept", capturedUnmuteableTemplateData());
    expect(closed).toContain("the booking has since been cancelled or closed");
    expect(closed).toContain("A cancellation refunds at most what the booking was worth");
    expect(closed).toContain("refund by hand what the booking no longer needs");
    expect(closed).not.toContain("should pay for the booking");
    expect(closed).not.toContain("neither payment");
    // #4285 review F2: the figure is what the CARD payment still holds; a credit or by-hand refund never touches it.
    expect(closed).toContain("the amount shown is what this card payment still holds after any card refund taken from it");
    expect(closed).toContain("A refund made as account credit or by hand never touches this card payment, so part of what it holds may already have been refunded another way.");
    expect(closed).toContain("Check the cancellation's refund in the booking's history");
    expect(closed).toContain("Still held by this payment: ");
    expect(closed).not.toContain("Payment kept:");
    expect(closed).not.toContain("The cancellation's record shows");
    expect(closed).not.toContain("in full");
    expect(closed).not.toContain("Nothing was refunded");

    // #4285 review F2: the cancellation's recorded refund is named when the drain read one.
    mocks.sendUnmuteableAdminAlert.mockClear();
    await sendAdminDuplicateCaptureKeptAlert(
      { ...alert, reason: "new-capture-closed", otherPaymentIntentId: null, otherHoldsMoney: false, cancellationRefund: { method: "credit", amount: "$100.00" } },
      CLUB_FORMAT_TEST,
    );
    expect(renderDefaultBody("admin-duplicate-capture-kept", capturedUnmuteableTemplateData())).toContain(
      "The cancellation's record shows it refunded $100.00 as account credit.",
    );

    // #4285 review 7 F1: a card refund is said as its row stands - never "refunded to card" before it was sent -
    // and a card refund shortfall's parts beside it.
    // #4285 review 8: to the group organiser's card where it went there, and each shortfall part as its hand-back task stands.
    const owed = { byBank: { amount: "$30.00", standing: "owed" }, toCheck: { amount: "$10.00", standing: "owed" } } as const;
    for (const [card, said, parts = owed] of [
      [{ amount: "$60.00", standing: "not-sent" }, "a card refund of $60.00 was planned but has not been sent in full, $30.00 is owed back by bank transfer and $10.00 is for the club to check before paying it back."],
      [{ amount: "$60.00", standing: "sent" }, "it refunded $60.00 to card, $30.00 is owed back by bank transfer and $10.00 is for the club to check before paying it back."],
      [
        { amount: "$60.00", standing: "sent" },
        "it refunded $60.00 to card, $30.00 was paid back by bank transfer and $10.00 was paid back by bank transfer after the club checked it.",
        { byBank: { amount: "$30.00", standing: "paid" }, toCheck: { amount: "$10.00", standing: "paid" } },
      ],
      [
        { amount: "$60.00", standing: "sent" },
        "it refunded $60.00 to card, the club recorded the $30.00 owed by bank transfer as settled and the club checked the $10.00 and closed it.",
        { byBank: { amount: "$30.00", standing: "closed" }, toCheck: { amount: "$10.00", standing: "closed" } },
      ],
      [{ amount: "$60.00", standing: "sent", organiserCard: true }, "it refunded $60.00 to the group organiser's card.", { byBank: null, toCheck: null }],
      [{ amount: "$60.00", standing: "not-sent", organiserCard: true }, "a refund of $60.00 to the group organiser's card was planned but has not been sent in full.", { byBank: null, toCheck: null }],
      // #4285 review 9 F1: a part close names what it left unpaid; F2: a refund made, of which a part failed later and was closed another way, names that part.
      [{ amount: "$60.00", standing: "paid-another-way" }, "its card refund of $60.00 was closed as paid another way.", { byBank: null, toCheck: null }],
      [{ amount: "$60.00", standing: "paid-another-way", unpaid: "$25.00" }, "its card refund of $60.00 was closed as paid another way, with $25.00 of it left unpaid.", { byBank: null, toCheck: null }],
      [
        { amount: "$60.00", standing: "sent", closedAnotherWay: "$20.00", unpaid: "$5.00" },
        "it refunded $60.00 to card, but $20.00 of that failed later and was closed as paid another way, with $5.00 of it left unpaid.",
        { byBank: null, toCheck: null },
      ],
    ] as const) {
      mocks.sendUnmuteableAdminAlert.mockClear();
      await sendAdminDuplicateCaptureKeptAlert(
        { ...alert, reason: "new-capture-closed", otherPaymentIntentId: null, otherHoldsMoney: false, cancellationRefund: { method: "card", card, ...parts } },
        CLUB_FORMAT_TEST,
      );
      expect(renderDefaultBody("admin-duplicate-capture-kept", capturedUnmuteableTemplateData())).toContain(`The cancellation's record shows ${said}`);
    }

    // #4285 review 7 F2: the settle's new-capture alert beside a payment the app no longer counts (a dead cancel's capture) names it.
    mocks.sendUnmuteableAdminAlert.mockClear();
    await sendAdminDuplicateCaptureKeptAlert(
      { ...alert, reason: "new-capture", otherPaymentIntentId: "pi_dead_cancel", otherHoldsMoney: true },
      CLUB_FORMAT_TEST,
    );
    const strayBeside = renderDefaultBody("admin-duplicate-capture-kept", capturedUnmuteableTemplateData());
    expect(strayBeside).toContain("Card payment pi_dead_cancel on it also holds money, so one or both of them may be extra.");
    expect(strayBeside).not.toContain("so this payment may be extra");
    expect(strayBeside).toContain("refund by hand any the booking does not need");

    // #4285 review F3: the same owed alert once a later payment holds money too.
    mocks.sendUnmuteableAdminAlert.mockClear();
    await sendAdminDuplicateCaptureKeptAlert(
      { ...alert, reason: "new-capture-later-payment", otherPaymentIntentId: "pi_later", otherHoldsMoney: true },
      CLUB_FORMAT_TEST,
    );
    const later = renderDefaultBody("admin-duplicate-capture-kept", capturedUnmuteableTemplateData());
    // #4285 review F5: the same two causes as new-capture, and the other payment holds money NOW.
    expect(later).toContain("the booking was paid some other way (with account credit, at a zero total, or by a group organiser), or its earlier payment was refunded");
    expect(later).toContain("Card payment pi_later on it also holds money");
    expect(later).toContain("while the app counted no other payment on it as settling it");
    expect(later).not.toContain("recorded on it since");
    // #4285 review F6: either or both may be extra.
    expect(later).toContain("refund by hand any the booking does not need — both, if it was paid another way.");
    expect(later).not.toContain("no record of which payment settled");
    expect(later).not.toContain("previous app version");
    expect(stray).not.toContain("refund the other one");
    expect(stray).toContain("refund it by hand only if the booking should not be paid by it");
  });

  it("admin-superseded-capture-refused: {{supersededCaptureNote}} says it was not applied, worded by the booking's status (#4300)", async () => {
    const alert = {
      memberName: "Alice Example",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      bookingId: "booking-9",
      bookingCancelled: false,
      amountCents: 27000,
      paymentIntentId: "pi_superseded",
    };
    await sendAdminSupersededCaptureRefusedAlert(alert, CLUB_FORMAT_TEST);
    const owing = renderDefaultBody("admin-superseded-capture-refused", capturedUnmuteableTemplateData());
    expect(owing).toContain("It did not mark the booking paid");
    expect(owing).toContain("The booking still owes its payment.");
    expect(owing).toContain("Stripe PI: pi_superseded");
    const [args] = mocks.sendUnmuteableAdminAlert.mock.calls[0] as [{ subject: string; templateName: string }];
    expect(args.subject).toBe("Card payment on a replaced payment — not applied: Alice Example");
    expect(args.templateName).toBe("admin-superseded-capture-refused");
    expect(mocks.sendToAdmins).not.toHaveBeenCalled();

    mocks.sendUnmuteableAdminAlert.mockClear();
    await sendAdminSupersededCaptureRefusedAlert({ ...alert, bookingCancelled: true }, CLUB_FORMAT_TEST);
    const cancelled = renderDefaultBody("admin-superseded-capture-refused", capturedUnmuteableTemplateData());
    expect(cancelled).toContain("The booking has been cancelled");
    expect(cancelled).not.toContain("still owes");
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
