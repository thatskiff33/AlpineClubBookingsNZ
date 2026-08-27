import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, it, expect, vi, beforeEach } from "vitest";

// #2444 — the confirmed-but-UNPAID booking confirmation told a member to
// transfer the booking's FULL price ("Total Due: $300.00") without ever
// mentioning the invoice that figure is supposed to agree with. The invoice is
// a separate document a club admin can adjust by hand — netting a member's
// account credit off it, most commonly — so a member who transfers the emailed
// figure can send more than the club is asking for.
//
// The INTERIM fix (owner decision, 1 Aug 2026): one neutral, conditional
// sentence pointing at the invoice. No figure is computed and no Xero read is
// made — the computed-figure version is deliberately its own later piece of
// work.
//
// WHAT THE SENTENCE MUST NOT SAY, and why (review, 1 Aug 2026). Its first draft
// promised that credit a member holds "will be applied to your invoice",
// justified by #1620 "allocate-existing". That is FALSE on this path: the one
// send site mints a brand-new booking with no BOOKING_APPLIED ledger rows, so
// the allocation op it enqueues always short-circuits and the invoice stands at
// the full price. The guard below pins the copy against promising it again.
//
// What is pinned here is that the sentence renders on the paymentDue branch and
// NOWHERE else, that both renderers get it from the one shared composer, that
// it promises nothing the system does not do, and that it reads sensibly for
// the great majority of members, who hold no account credit at all.

const { sendEmailMock, loadLodgeSettingsMock, loadAppliedCreditMock } =
  vi.hoisted(() => ({
    sendEmailMock: vi.fn().mockResolvedValue({ status: "sent" }),
    loadLodgeSettingsMock: vi.fn(),
    loadAppliedCreditMock: vi.fn(),
  }));

vi.mock("@/lib/email/core", () => ({
  sendEmail: sendEmailMock,
}));

vi.mock("@/lib/booking-confirmation-credit", () => ({
  loadBookingAppliedCredit: loadAppliedCreditMock,
}));

// Fork #35: the sender resolves booking-link authority before composing its
// add-to-calendar links. Mocked to "unauthorized" so no calendar material
// enters these renders — this suite's byte-parity and log-count assertions
// are about the money story, and the calendar path has its own dedicated
// suite (booking-confirmed-calendar-authority.test.ts). Unmocked, the real
// resolver would hit unmocked prisma and add a second logged error.
vi.mock("@/lib/booking-email-authority", () => ({
  resolveBookingEmailLink: vi
    .fn()
    .mockResolvedValue({ authority: "unauthorized", bookingUrl: null }),
}));

vi.mock("@/lib/email-message-settings", () => ({
  EMAIL_DEFAULT_LODGE_NAME: "Example Club Lodge",
  EMAIL_DEFAULT_FROM_NAME: "Example Club - Online Booking System",
  loadEmailMessageSettingsForLodge: loadLodgeSettingsMock,
  loadEmailMessageSettings: vi.fn(),
  applyEmailMessageSettingsToHtml: vi.fn((html: string) => html),
  applyEmailMessageSettingsToSubject: vi.fn((subject: string) => subject),
  buildEmailTemplateGlobalData: vi.fn(() => ({})),
}));

import {
  EXTRA_TEMPLATE_TOKENS,
  getEmailTemplateDefinition,
} from "@/lib/email-message-registry";
import {
  EMPTYABLE_OVERRIDE_TOKENS,
  OPTIONAL_TEMPLATE_TOKENS,
  findDanglingDefaultLines,
} from "@/lib/email-message-token-contract";
import { bookingPaymentDueNote } from "@/lib/email-message-notes";
import { bookingConfirmedTemplate } from "@/lib/email-templates/booking";
import {
  resolveUnpaidCreditNetting,
  unpaidMoneySummaryRows,
  wholeLodgeManualInvoiceAmountCents,
} from "@/lib/booking-money-lines";
import { plainTextEmailTemplate } from "@/lib/email-templates/layout";
import {
  renderTemplateString,
  type EmailTemplateData,
} from "@/lib/email-message-renderer";

// THE FIXTURE. Every assertion below — the flat token, the composed
// {{paymentOutcome}} block, the rendered default body, and the hand-built HTML
// a member actually receives — is checked against this ONE string, which is why
// the two renderers cannot be allowed to drift apart.
const CREDIT_SENTENCE =
  "If the invoice asks for a different amount — for example because the club " +
  "has put account credit you hold towards it — please transfer the amount " +
  "the invoice shows.";

// A short marker for the "renders nowhere else" assertions, so they keep
// working if the sentence is reworded but keep failing if it leaks.
const SENTENCE_MARKER = "the amount the invoice shows";

const GLOBAL_DATA: EmailTemplateData = {
  BASE_URL: "https://bookings.example.org",
  CLUB_LODGE_TRAVEL_NOTE: "Take the Bruce Road.",
};

const NO_CREDIT = { amountCents: 0, settlementMethod: "card" as const };

const CHECK_IN = new Date("2026-08-15");
const CHECK_OUT = new Date("2026-08-17");

beforeEach(() => {
  vi.clearAllMocks();
  loadLodgeSettingsMock.mockResolvedValue({
    lodgeTravelNote: "Take the Bruce Road.",
    doorCode: "1234",
  });
  loadAppliedCreditMock.mockResolvedValue(NO_CREDIT);
});

function renderDefaultBody(templateData: EmailTemplateData): string {
  const definition = getEmailTemplateDefinition("booking-confirmed");
  if (!definition) throw new Error("missing booking-confirmed definition");
  return renderTemplateString(definition.defaultBody, {
    ...GLOBAL_DATA,
    ...templateData,
  });
}

async function send(
  senderOptions: Record<string, unknown> = {},
): Promise<{ templateData: EmailTemplateData; html: string }> {
  const { sendBookingConfirmedEmail } = await import("@/lib/email/booking");
  await sendBookingConfirmedEmail(
    { bookingId: "bk_2444", recipientMemberId: "member_2444" },
    "member@example.org",
    "Sam",
    CHECK_IN,
    CHECK_OUT,
    2,
    30000,
    senderOptions,
  );
  expect(sendEmailMock).toHaveBeenCalledTimes(1);
  const call = sendEmailMock.mock.calls[0][0];
  expect(call.templateName).toBe("booking-confirmed");
  return { templateData: call.templateData, html: call.html };
}

const PAYMENT_DUE = {
  paymentDue: { reference: "BOOKING-ABC123", invoiceEmailed: true },
};

describe("#2444 the unpaid confirmation's pay-what-the-invoice-asks sentence", () => {
  it("tells an unpaid member to transfer what the invoice asks for", async () => {
    const { templateData, html } = await send(PAYMENT_DUE);

    // The flat token an override may place on its own, the pre-composed block
    // the shipped default body renders, and the HTML — one sentence, three
    // paths, from one composer.
    expect(templateData.paymentDueNote).toContain(CREDIT_SENTENCE);
    expect(templateData.paymentOutcome).toContain(CREDIT_SENTENCE);
    expect(html).toContain(CREDIT_SENTENCE);

    // It follows the existing #2263 story rather than replacing any of it: the
    // amount owing, the reference to quote, and what is happening about an
    // invoice all still come first.
    expect(templateData.paymentOutcome).toBe(
      "Total Due: $300.00\n\n" +
        "This booking is confirmed, but payment of $300.00 is still owing. " +
        "Please pay by internet banking quoting reference BOOKING-ABC123. " +
        "An invoice has been emailed to you separately. " +
        CREDIT_SENTENCE,
    );

    const rendered = renderDefaultBody(templateData);
    expect(rendered).toContain(CREDIT_SENTENCE);
    // No line trails off after a label, sign or dash, in the substituted body
    // or in the plain text a member receives.
    for (const text of [rendered, plainTextEmailTemplate(rendered)]) {
      for (const line of text.split("\n")) {
        expect(
          line.trimEnd(),
          `dangling line: ${JSON.stringify(line)}`,
        ).not.toMatch(/[-+:–]$/);
      }
    }
  });

  it("reads as a condition, not as a claim about this member's invoice", async () => {
    // Most invoices ask for exactly the "Total Due" figure, so an unconditional
    // "your invoice asks for less" would be false for nearly everyone. The
    // sentence must open with the condition and must state no figure — there is
    // no Xero read on this path and none is wanted (the send would then carry a
    // provider round-trip, and a provider outage, into a member's
    // confirmation).
    const { templateData, html } = await send(PAYMENT_DUE);

    expect(CREDIT_SENTENCE.startsWith("If the invoice asks for a")).toBe(true);
    // No second money figure anywhere in the paragraph: the only amount an
    // unpaid confirmation names is the booking's own price.
    expect(
      (templateData.paymentDueNote as string).match(/\$[\d,]+\.\d{2}/g),
    ).toEqual(["$300.00"]);
    // And no credit BREAKDOWN — nothing has been settled, so there is no
    // "paid by" story and #2328's pair stays suppressed (its own suite pins
    // why that is safe on this path).
    expect(templateData.creditNote).toBe("");
    expect(html).not.toContain("Account credit applied");
  });

  it("says the same thing when the club raises no invoice automatically", async () => {
    // Xero module off: the club sends the invoice by hand, and the member still
    // must not transfer the figure above it if they hold credit.
    const { templateData } = await send({
      paymentDue: { reference: "BOOKING-ABC123", invoiceEmailed: false },
    });

    expect(templateData.paymentDueNote).toBe(
      "This booking is confirmed, but payment of $300.00 is still owing. " +
        "Please pay by internet banking quoting reference BOOKING-ABC123. " +
        "The club will send you an invoice for it. " +
        CREDIT_SENTENCE,
    );
  });

  it.each([
    ["paid in full", {}],
    [
      "partly paid (#2397)",
      { outstandingBalance: { amountCents: 3000, payableOnline: true } },
    ],
  ])("says nothing about the invoice amount on a %s confirmation", async (
    _label,
    senderOptions,
  ) => {
    const { templateData, html } = await send(senderOptions);

    expect(templateData.paymentDueNote).toBe("");
    expect(templateData.paymentOutcome).not.toContain(SENTENCE_MARKER);
    expect(renderDefaultBody(templateData)).not.toContain(SENTENCE_MARKER);
    expect(html).not.toContain(SENTENCE_MARKER);
  });

  it("says nothing about it when account credit covered the whole stay", async () => {
    // The one settled case where credit really was involved. It is settled, so
    // there is nothing left to transfer and no invoice to check — the #2328
    // pair already explains where the money came from, and this sentence would
    // only invite a member to go looking for a payment they do not owe.
    loadAppliedCreditMock.mockResolvedValue({
      amountCents: 30000,
      settlementMethod: "card" as const,
    });
    const { templateData, html } = await send();

    expect(templateData.creditNote).toBe(
      "Account credit applied: -$300.00\nNothing more to pay: $0.00\n",
    );
    expect(templateData.paymentDueNote).toBe("");
    expect(html).not.toContain(SENTENCE_MARKER);
  });

  it("renders identically from the HTML template and the flat token", async () => {
    // The drift guard proper. #2263 kept two hand-written copies of this
    // paragraph, one per renderer; #2444 had to add a sentence to it, so the
    // paragraph moved to a single composer. Both renderers are driven from the
    // same fixture here, so a change made to one and not the other fails.
    const { templateData, html } = await send(PAYMENT_DUE);
    const composed = bookingPaymentDueNote({
      amount: "$300.00",
      reference: "BOOKING-ABC123",
      invoiceEmailed: true,
    });

    expect(templateData.paymentDueNote).toBe(composed);
    expect(html).toContain(composed);
    expect(
      bookingConfirmedTemplate("Sam", CHECK_IN, CHECK_OUT, 2, 30000, {
        paymentDue: { reference: "BOOKING-ABC123", invoiceEmailed: true },
      }),
    ).toContain(composed);
  });

  it("escapes a club-entered reference on the HTML path only", async () => {
    // The composer takes the reference ALREADY escaped for the caller's medium
    // (it imports nothing and knows nothing about HTML), exactly as the shared
    // money rows do. The plain-text token must keep the raw reference or a
    // member cannot type it into their banking app.
    const html = bookingConfirmedTemplate("Sam", CHECK_IN, CHECK_OUT, 2, 30000, {
      paymentDue: { reference: "A&B<1>", invoiceEmailed: false },
    });

    expect(html).toContain("quoting reference A&amp;B&lt;1&gt;.");
    expect(html).not.toContain("quoting reference A&B<1>.");

    const { templateData } = await send({
      paymentDue: { reference: "A&B<1>", invoiceEmailed: false },
    });
    expect(templateData.paymentDueNote).toContain("quoting reference A&B<1>.");
  });
});

describe("#2444 the shared composer", () => {
  it("appends the sentence to both invoice outcomes and nothing else", () => {
    for (const invoiceEmailed of [true, false]) {
      const note = bookingPaymentDueNote({
        amount: "$120.00",
        reference: "BOOKING-XYZ",
        invoiceEmailed,
      });
      expect(note.endsWith(CREDIT_SENTENCE)).toBe(true);
      expect(note).toContain(
        "This booking is confirmed, but payment of $120.00 is still owing.",
      );
      expect(note).toContain("quoting reference BOOKING-XYZ.");
    }

    expect(
      bookingPaymentDueNote({
        amount: "$120.00",
        reference: "BOOKING-XYZ",
        invoiceEmailed: true,
      }),
    ).toContain("An invoice has been emailed to you separately.");
    expect(
      bookingPaymentDueNote({
        amount: "$120.00",
        reference: "BOOKING-XYZ",
        invoiceEmailed: false,
      }),
    ).toContain("The club will send you an invoice for it.");
  });

  it("is one paragraph, so no body can leave it half-rendered", () => {
    // It is supplied as a single {{paymentDueNote}} value and carried whole
    // inside {{paymentOutcome}}; an override cannot place the payment
    // instruction without the credit caveat that qualifies it.
    const note = bookingPaymentDueNote({
      amount: "$120.00",
      reference: "BOOKING-XYZ",
      invoiceEmailed: true,
    });
    expect(note).not.toContain("\n");
  });

  it("promises no credit netting the system does not actually do", () => {
    // THE REGRESSION GUARD for this issue's own first draft, which said "If you
    // hold account credit with the club, it will be applied to your invoice".
    // Nothing on the one send path applies credit (see the premise test below),
    // so that was a promise the club would silently break. The sentence may
    // point at the invoice and may explain WHY the two figures can differ; it
    // may not assert that anything will happen to this member's invoice.
    const note = bookingPaymentDueNote({
      amount: "$120.00",
      reference: "BOOKING-XYZ",
      invoiceEmailed: true,
    });

    for (const promise of [
      "it will be applied",
      "will be applied to your invoice",
      "has been applied to your invoice",
      "credit has been applied",
    ]) {
      expect(note.toLowerCase(), `unkeepable promise: ${promise}`).not.toContain(
        promise,
      );
    }
    // Whatever it says about credit must sit behind the invoice condition.
    expect(note).toContain("If the invoice asks for a different amount");
    expect(note.indexOf("If the invoice asks for a different amount")).toBeLessThan(
      note.indexOf("account credit"),
    );
  });

  it("rests on a send path that applies no account credit at all", () => {
    // The sentence is worded around what this path really does. It mints a
    // brand-new booking and writes NO MemberCredit row, so the
    // enqueueXeroAppliedCreditAllocationOperation call it makes always
    // short-circuits ("No unallocated applied credit; nothing to allocate.")
    // and the Xero invoice stands at the full price.
    //
    // WHAT THIS PIN NOW MEANS (#2483). It used to say "if that ever changes,
    // the copy can — and should — be revisited", i.e. the state was one the
    // code had no answer for. It has an answer now: the credit shape below
    // states the netting, from these very rows. So this is no longer a
    // correctness precondition — it is why every member on today's live path
    // reads the conditional sentence and not the netted one, and a tripwire
    // saying the netted copy has gone live for real members.
    //
    // If it does go red, the member's email is not the only artefact to check:
    // the PENDING receivable this conversion writes and the admin
    // manual-invoice alert it sends must state the same netted figure the
    // member is asked for. #2483 wired the alert to the same resolver; the
    // receivable is written at the booking's price inside the transaction and
    // equals the netted figure only while no credit is applied, which is what
    // this assertion proves.
    // (#2328's own suite pins the single-send-site half of this premise.)
    const source = readFileSync(
      path.join(process.cwd(), "src", "lib", "school-booking-request.ts"),
      "utf8",
    );

    expect(source).not.toContain("BOOKING_APPLIED");
    expect(source).not.toContain("applyCreditToBooking");
    expect(source).not.toContain("memberCredit");
  });
});

// #2483 — the second half of the owner's "both, in order" decision on #2444.
//
// #2444 shipped an honest sentence because no figure could be stated: netting
// the member's credit off their invoice is done by Xero, asynchronously, and a
// precise number that is wrong is worse than none. The owner's decision (2 Aug
// 2026) took a fifth road past the four options on #2483: the email uses the
// booking app's OWN known credits, so there is no delay and the amount is
// itemised, and a SEPARATE checker (#2501) keeps the club's credits and Xero's
// in sync and warns admins when they are not.
//
// The local figure is not a guess at what Xero will do, and the reason is
// narrower than an earlier draft of this comment claimed (#2483 review, 2 Aug
// 2026). `deriveBookingAppliedCreditCents` is the club's OWN amount-owing law —
// the same figure `prepareManualSettlement` derives an effective price from and
// the same one the Xero deallocation engine converges an invoice to — so the
// netted figure is exactly what the club would accept as full settlement. It is
// NOT the same predicate the allocation gate reads: that aggregates only the
// `xeroCreditNoteId: null` unallocated subset, a work-remaining filter over
// these rows. So a hand edit in Xero, an allocation op that failed or was never
// processed, and a stamp that outlived its invoice can all put email and
// invoice out of step — all of them #2501's job, not the email's.
describe("#2483 the itemised netting on an unpaid confirmation", () => {
  const CREDIT = { amountCents: 12000, settlementMethod: "card" as const };

  // The #2444 sentence, in full, is what a member must NOT be told once the
  // email has done the netting itself: it says to follow the invoice, and the
  // invoice may not have caught up with the allocation yet.
  it("itemises total, credit and what to transfer", async () => {
    loadAppliedCreditMock.mockResolvedValue(CREDIT);
    const { templateData, html } = await send(PAYMENT_DUE);

    // The reconciling trio, in the #2328 shape and the #2397 order: what the
    // stay costs, what has come off it, what is left.
    expect(templateData.paymentOutcome).toBe(
      "Booking Total: $300.00\n" +
        "Account credit applied: -$120.00\n" +
        "Total Due: $180.00\n\n" +
        "This booking is confirmed, but payment of $180.00 is still owing — " +
        "the booking's price of $300.00 less the $120.00 of account credit the " +
        "club has put towards it. Please pay $180.00 by internet banking " +
        "quoting reference BOOKING-ABC123. " +
        "An invoice has been emailed to you separately. " +
        "If the invoice asks for more than that, please still transfer $180.00; " +
        "if it asks for less, please pay what the invoice asks. Either way, let " +
        "the club know, and the club will check its own record of your credit " +
        "against the invoice.",
    );

    // {{totalDue}} has always meant "what is still owed", so it is the netted
    // figure — an override that writes its own money lines out of the per-piece
    // tokens asks for the right amount with no edit at all.
    expect(templateData.totalDue).toBe("$180.00");
    expect(templateData.totalPaid).toBe("");

    // The HTML a member actually receives carries the same three rows in the
    // same order.
    expect(html).toContain(">Booking Total</td>");
    expect(html.indexOf(">Booking Total</td>")).toBeLessThan(
      html.indexOf(">Account credit applied</td>"),
    );
    expect(html.indexOf(">Account credit applied</td>")).toBeLessThan(
      html.indexOf(">Total Due</td>"),
    );
    expect(html).toContain("-$120.00");
    expect(html).toContain("$180.00");

    // No line trails off after a label, sign or dash, in the substituted body
    // or in the plain text a member receives.
    const rendered = renderDefaultBody(templateData);
    for (const text of [rendered, plainTextEmailTemplate(rendered)]) {
      for (const line of text.split("\n")) {
        expect(
          line.trimEnd(),
          `dangling line: ${JSON.stringify(line)}`,
        ).not.toMatch(/[-+:–]$/);
      }
    }
  });

  it("stops telling the member to follow the invoice once it has netted", async () => {
    // THE POINT OF THE INVERSION. #2444's closing sentence defers to the
    // invoice. The allocation that reduces that invoice is processed on the
    // Xero outbox AFTER the send, so a member who opens the invoice first may
    // still see the full price — and "transfer the amount the invoice shows"
    // would produce exactly the overpayment this change exists to prevent.
    loadAppliedCreditMock.mockResolvedValue(CREDIT);
    const { templateData, html } = await send(PAYMENT_DUE);

    expect(templateData.paymentDueNote).not.toContain(SENTENCE_MARKER);
    expect(html).not.toContain(SENTENCE_MARKER);
    // A disagreement is routed to the club, not acted on by the member.
    expect(templateData.paymentDueNote).toContain("let the club know");
    // And the club's side of that is #2501's reconciliation checker, referred
    // to in plain English and promising only a check — never that Xero has
    // already been updated, which the email cannot know.
    expect(templateData.paymentDueNote).toContain(
      "the club will check its own record of your credit against the invoice",
    );
    for (const overclaim of [
      "has been applied to your invoice",
      "your invoice has been reduced",
      "xero",
    ]) {
      expect(
        (templateData.paymentDueNote as string).toLowerCase(),
        `unkeepable promise: ${overclaim}`,
      ).not.toContain(overclaim);
    }
  });

  it("holds the netted figure only against a LARGER invoice, never a smaller one", async () => {
    // THE INVERSION IS ONE-DIRECTIONAL (#2483 review, 2 Aug 2026). Its first
    // draft was symmetric — "if the invoice asks for a different amount, please
    // transfer $180.00" — which also told a member to transfer MORE than an
    // invoice asking for less. That is the #2444 overpayment wearing the new
    // wording, and the drift the change itself names (a hand edit in Xero) is
    // exactly what produces a lower invoice. So: hold the email's figure when
    // the invoice asks for more, pay the invoice when it asks for less, tell
    // the club either way.
    loadAppliedCreditMock.mockResolvedValue(CREDIT);
    const { templateData } = await send(PAYMENT_DUE);
    const note = templateData.paymentDueNote as string;

    expect(note).toContain(
      "If the invoice asks for more than that, please still transfer $180.00; " +
        "if it asks for less, please pay what the invoice asks.",
    );
    // The symmetric wording must not come back.
    expect(note).not.toContain("asks for a different amount, please transfer");
  });

  it("asks for nothing when the credit covers the booking exactly", async () => {
    // THE BOUNDARY THIS SPLIT (#2483 review, 2 Aug 2026). Credit EQUAL to the
    // price used to be folded into the same refusal as credit larger than it,
    // which rendered "Total Due: $300.00" and the #2444 "please pay" imperative
    // — a 100% overpayment instruction on the one booking the member owes
    // nothing on. Equality is not a contradiction: it is the documented steady
    // state of the #1887 reprice clamp, and the state `prepareManualSettlement`
    // refuses as "This booking has nothing owing". So it states $0.00 and asks
    // for nothing.
    loadAppliedCreditMock.mockResolvedValue({
      amountCents: 30000,
      settlementMethod: "card" as const,
    });
    const { templateData, html } = await send(PAYMENT_DUE);

    expect(templateData.paymentOutcome).toBe(
      "Booking Total: $300.00\n" +
        "Account credit applied: -$300.00\n" +
        "Total Due: $0.00\n\n" +
        "This booking is confirmed and there is nothing further to transfer — " +
        "the booking's price of $300.00 is fully covered by the $300.00 of " +
        "account credit the club has put towards it. " +
        "An invoice has been emailed to you separately. " +
        "If the invoice asks for a payment, please let the club know rather " +
        "than paying it, and the club will check its own record of your credit " +
        "against the invoice.",
    );
    expect(templateData.totalDue).toBe("$0.00");
    // No payment imperative survives anywhere in the paragraph.
    expect(templateData.paymentDueNote).not.toContain("is still owing");
    expect(templateData.paymentDueNote).not.toContain("Please pay");
    expect(templateData.paymentDueNote).not.toContain(SENTENCE_MARKER);
    expect(html).toContain(">Total Due</td>");
    expect(html).not.toContain("$300.00 is still owing");
  });

  it("asks for no figure at all when the ledger contradicts the price", async () => {
    // Credit LARGER than the booking's price. That really is a contradiction
    // the #1887 clamp exists to prevent, so no figure derived from the pair
    // belongs in a member's inbox — INCLUDING the gross price, which the first
    // draft printed as "Total Due" with the #2444 "please pay" sentence beneath
    // it. A refusal must never instruct payment of a figure the ledger
    // contradicts. The booking's price is stated as a fact; nothing is asked
    // for; {{totalDue}} is empty so no override can print one either.
    loadAppliedCreditMock.mockResolvedValue({
      amountCents: 45000,
      settlementMethod: "card" as const,
    });
    const { templateData, html } = await send(PAYMENT_DUE);

    expect(templateData.paymentOutcome).toBe(
      "Booking Total: $300.00\n\n" +
        "This booking is confirmed. The club is checking its record of the " +
        "account credit held against this booking and will confirm what, if " +
        "anything, is left to pay. An invoice has been emailed to you " +
        "separately — please wait to hear from the club before transferring " +
        "anything against it.",
    );
    expect(templateData.totalDue).toBe("");
    expect(templateData.paymentOutcome).not.toContain("Total Due");
    expect(templateData.paymentOutcome).not.toContain("is still owing");
    expect(templateData.paymentOutcome).not.toContain("Please pay");
    expect(templateData.paymentOutcome).not.toContain(SENTENCE_MARKER);
    // The internet-banking reference is not quoted either: quoting it is part
    // of an instruction to pay, and there is no instruction to pay.
    expect(templateData.paymentDueNote).not.toContain("BOOKING-ABC123");
    expect(html).not.toContain(">Total Due</td>");
  });

  it("leaves the email exactly as #2444 shipped it when no credit applies", async () => {
    // THE UNCHANGED PIN. Every member on today's live path is here, so this is
    // the case #2483 must not touch at all — not the rows, not the paragraph,
    // not the tokens.
    const { templateData, html } = await send(PAYMENT_DUE);

    expect(templateData.paymentOutcome).toBe(
      "Total Due: $300.00\n\n" +
        "This booking is confirmed, but payment of $300.00 is still owing. " +
        "Please pay by internet banking quoting reference BOOKING-ABC123. " +
        "An invoice has been emailed to you separately. " +
        CREDIT_SENTENCE,
    );
    expect(templateData.totalDue).toBe("$300.00");
    expect(html).not.toContain("Booking Total");
    expect(html).not.toContain("Account credit applied");
    expect(html).toContain(CREDIT_SENTENCE);
  });

  it("falls back to the #2444 paragraph when the ledger read fails", async () => {
    // The credit read FAILS OPEN (#2328): a thrown read must not abort a send
    // that would otherwise happen, or the member is silently owed an email. So
    // a failure degrades to the no-credit rendering — the honest sentence,
    // which is true whatever the ledger would have said — rather than to a
    // half-computed figure.
    loadAppliedCreditMock.mockRejectedValue(new Error("ledger unavailable"));
    const { templateData, html } = await send(PAYMENT_DUE);

    expect(templateData.paymentOutcome).toBe(
      "Total Due: $300.00\n\n" +
        "This booking is confirmed, but payment of $300.00 is still owing. " +
        "Please pay by internet banking quoting reference BOOKING-ABC123. " +
        "An invoice has been emailed to you separately. " +
        CREDIT_SENTENCE,
    );
    expect(html).toContain(CREDIT_SENTENCE);
    expect(html).not.toContain("Account credit applied");
  });

  it("renders identically from the HTML template and the flat token", async () => {
    // The #2444 drift guard, extended to the credit shape: one composer, two
    // renderers, one story about how much to transfer.
    loadAppliedCreditMock.mockResolvedValue(CREDIT);
    const { templateData, html } = await send(PAYMENT_DUE);
    const composed = bookingPaymentDueNote({
      amount: "$180.00",
      reference: "BOOKING-ABC123",
      invoiceEmailed: true,
      accountCredit: {
        outcome: "netted",
        bookingTotal: "$300.00",
        creditApplied: "$120.00",
      },
    });

    expect(templateData.paymentDueNote).toBe(composed);
    expect(html).toContain(composed);
    expect(
      bookingConfirmedTemplate("Sam", CHECK_IN, CHECK_OUT, 2, 30000, {
        paymentDue: { reference: "BOOKING-ABC123", invoiceEmailed: true },
        appliedCredit: CREDIT,
      }),
    ).toContain(composed);
  });

  it("says the same thing when the club raises no invoice automatically", async () => {
    loadAppliedCreditMock.mockResolvedValue(CREDIT);
    const { templateData } = await send({
      paymentDue: { reference: "BOOKING-ABC123", invoiceEmailed: false },
    });

    expect(templateData.paymentDueNote).toContain(
      "The club will send you an invoice for it.",
    );
    expect(templateData.paymentDueNote).toContain("payment of $180.00");
  });

  it("adds no token, and leaves {{creditNote}} to the settled outcomes", async () => {
    // No new token, for the reason #2444 gives: one would be invisible to every
    // club that saved an override before today — on the one branch where
    // following the email can make a member pay the wrong amount. The netting
    // rides on {{paymentOutcome}} and {{totalDue}}, both of which every saved
    // body already understands, and {{paymentDueNote}} states the arithmetic in
    // words for a body that renders it alone.
    //
    // {{creditNote}} stays EMPTY here on purpose: it is the "where the money
    // came from" pair for a booking that has been settled, and an unpaid
    // booking has no such story — its credit is a reduction in what is still
    // owed, which the rows above say.
    loadAppliedCreditMock.mockResolvedValue(CREDIT);
    const { templateData } = await send(PAYMENT_DUE);

    expect(templateData.creditNote).toBe("");
    expect(EXTRA_TEMPLATE_TOKENS["booking-confirmed"]).toEqual([
      "creditNote",
      "discount",
      "doorCode",
      "doorCodeNote",
      "paymentDueNote",
      "paymentOutcome",
      "paymentReference",
      "promoAdjustment",
      "promoCode",
      "promoSummary",
      "provisionalGuestsNote",
      "subtotal",
      "totalDue",
      "totalPaid",
    ]);
  });
});

describe("#2483 the netting arithmetic", () => {
  // Money is integer cents and the only operation is one subtraction, so there
  // is no rounding to get wrong — these pin that no rounding is INTRODUCED, and
  // that each of the four outcomes is reached at exactly the right boundary.
  it("nets in whole cents, including amounts that do not divide evenly", () => {
    expect(
      resolveUnpaidCreditNetting({ totalCents: 30000, appliedCreditCents: 12000 }),
    ).toEqual({ outcome: "netted", creditCents: 12000, toTransferCents: 18000 });
    // $300.01 less $120.34 — awkward cents survive intact.
    expect(
      resolveUnpaidCreditNetting({ totalCents: 30001, appliedCreditCents: 12034 }),
    ).toEqual({ outcome: "netted", creditCents: 12034, toTransferCents: 17967 });
    // One cent of credit, and one cent left to pay: the extremes still reconcile.
    expect(
      resolveUnpaidCreditNetting({ totalCents: 30000, appliedCreditCents: 1 }),
    ).toEqual({ outcome: "netted", creditCents: 1, toTransferCents: 29999 });
    expect(
      resolveUnpaidCreditNetting({ totalCents: 30000, appliedCreditCents: 29999 }),
    ).toEqual({ outcome: "netted", creditCents: 29999, toTransferCents: 1 });
  });

  it("takes the ledger's summed figure, however many credits it came from", () => {
    // `deriveBookingAppliedCreditCents` sums every BOOKING_APPLIED row for the
    // booking — several partial applications, plus any #1887 reprice-clamp
    // offset, net to one number before this is reached. Splitting $120.00 into
    // $50.00 + $70.00 must not change what the member is asked for.
    expect(
      resolveUnpaidCreditNetting({
        totalCents: 30000,
        appliedCreditCents: 5000 + 7000,
      }).toTransferCents,
    ).toBe(18000);
  });

  it("states nothing when there is nothing to state", () => {
    for (const appliedCreditCents of [0, -1, -12000]) {
      expect(
        resolveUnpaidCreditNetting({ totalCents: 30000, appliedCreditCents }),
      ).toEqual({ outcome: "none", creditCents: 0, toTransferCents: 30000 });
    }
    // A free booking has nothing to net against either.
    expect(
      resolveUnpaidCreditNetting({ totalCents: 0, appliedCreditCents: 12000 }),
    ).toEqual({ outcome: "none", creditCents: 0, toTransferCents: 0 });
  });

  it("splits the boundary at the exact cent: covered, then unreconciled", () => {
    // THE FIX (#2483 review, 2 Aug 2026). `creditCents >= totalCents` used to
    // collapse into the no-credit return, so a booking fully covered by credit
    // rendered the FULL price as "Total Due" with the "please pay" imperative.
    // Equality is a legitimate ledger state — the #1887 clamp's documented
    // steady state, and what `prepareManualSettlement` calls "nothing owing" —
    // so it now states $0.00, and only a genuinely larger credit refuses.
    expect(
      resolveUnpaidCreditNetting({ totalCents: 30000, appliedCreditCents: 29999 })
        .outcome,
    ).toBe("netted");
    expect(
      resolveUnpaidCreditNetting({ totalCents: 30000, appliedCreditCents: 30000 }),
    ).toEqual({ outcome: "covered", creditCents: 30000, toTransferCents: 0 });
    expect(
      resolveUnpaidCreditNetting({ totalCents: 30000, appliedCreditCents: 30001 }),
    ).toEqual({ outcome: "unreconciled", creditCents: 0, toTransferCents: 0 });
    expect(
      resolveUnpaidCreditNetting({ totalCents: 30000, appliedCreditCents: 45000 }),
    ).toEqual({ outcome: "unreconciled", creditCents: 0, toTransferCents: 0 });
  });

  it("never leaves a figure a caller could render on the refusal", () => {
    // `toTransferCents` is ZERO on "unreconciled", not the gross price, so a
    // caller that ignored the outcome still cannot print the contradicted
    // figure as an amount to pay.
    expect(
      resolveUnpaidCreditNetting({ totalCents: 30000, appliedCreditCents: 45000 })
        .toTransferCents,
    ).toBe(0);
  });

  it("renders one line without netting and the reconciling trio with it", () => {
    expect(
      unpaidMoneySummaryRows(30000, {
        outcome: "none",
        creditCents: 0,
        toTransferCents: 30000,
      }),
    ).toEqual([{ label: "Total Due", value: "$300.00" }]);
    expect(
      unpaidMoneySummaryRows(30000, {
        outcome: "netted",
        creditCents: 12000,
        toTransferCents: 18000,
      }),
    ).toEqual([
      { label: "Booking Total", value: "$300.00" },
      // The value carries its own minus sign, so no body may prefix one.
      { label: "Account credit applied", value: "-$120.00" },
      { label: "Total Due", value: "$180.00" },
    ]);
    // Fully covered still reconciles, and lands on the honest $0.00.
    expect(
      unpaidMoneySummaryRows(30000, {
        outcome: "covered",
        creditCents: 30000,
        toTransferCents: 0,
      }),
    ).toEqual([
      { label: "Booking Total", value: "$300.00" },
      { label: "Account credit applied", value: "-$300.00" },
      { label: "Total Due", value: "$0.00" },
    ]);
    // The refusal states the price as a FACT and never as an amount due:
    // labelling a figure "Total Due" is an instruction to pay it.
    expect(
      unpaidMoneySummaryRows(30000, {
        outcome: "unreconciled",
        creditCents: 0,
        toTransferCents: 0,
      }),
    ).toEqual([{ label: "Booking Total", value: "$300.00" }]);
  });
});

describe("#2483 the manual-invoice branch asks the admin for the member's figure", () => {
  // The Xero-off branch has no invoice object and no allocation op, so nothing
  // downstream would ever reconcile an admin who invoiced the gross price
  // against a member who was told to transfer the netted one — the club would
  // chase a shortfall its own ledger says does not exist, while the member
  // holds an email telling them not to pay it. One resolver, both messages.
  it("nets the amount to invoice exactly as the member's email nets it", () => {
    expect(wholeLodgeManualInvoiceAmountCents(30000, 0)).toBe(30000);
    expect(wholeLodgeManualInvoiceAmountCents(30000, 12000)).toBe(18000);
    // Fully covered: there is nothing to collect, so nothing is invoiced.
    expect(wholeLodgeManualInvoiceAmountCents(30000, 30000)).toBe(0);
    // Contradictory ledger: the member is asked for nothing and told to wait,
    // so there is no netted figure to agree with — the admin keeps the booking
    // price and the send-time warning is what flags the contradiction.
    expect(wholeLodgeManualInvoiceAmountCents(30000, 45000)).toBe(30000);
  });
});

describe("#2444 the token contract is unchanged", () => {
  it("adds no new token, so every saved override keeps rendering", () => {
    // The sentence rides on {{paymentDueNote}}, which #2263 already supplies
    // and approves. A NEW token would have been invisible to every club that
    // saved an override before today — on the one branch where following the
    // email can make a member overpay.
    //
    // Review (1 Aug 2026): asserting that two pre-existing tokens are present
    // does NOT pin "no token was added" — it would pass unchanged if a later
    // edit added {{creditCaveat}} beside them. The exact supplied-token list is
    // what holds the line, so a token added here has to be argued for in this
    // test rather than slipped in.
    expect(EXTRA_TEMPLATE_TOKENS["booking-confirmed"]).toEqual([
      "creditNote",
      "discount",
      "doorCode",
      "doorCodeNote",
      "paymentDueNote",
      "paymentOutcome",
      "paymentReference",
      "promoAdjustment",
      "promoCode",
      "promoSummary",
      "provisionalGuestsNote",
      "subtotal",
      "totalDue",
      "totalPaid",
    ]);

    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed definition");
    expect(definition.allowedTokens).toContain("paymentDueNote");
    expect(definition.allowedTokens).toContain("paymentOutcome");
  });

  it("previews the real paragraph, not the word 'paymentDueNote'", async () => {
    // Review (1 Aug 2026). The preview IS the admin's only picture of what a
    // member reads, and a pre-composed token whose sample is its own name
    // teaches an admin to lay a body out for a shape no member receives —
    // here, invisible payment advice. #2263 registered the token without a
    // sample; #2444 is what puts the club's payment instructions in it.
    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed definition");

    const sample = definition.sampleData.paymentDueNote;
    expect(sample).not.toBe("paymentDueNote");
    // Composed by the SAME function the send uses, so the preview cannot drift
    // from the message.
    expect(sample).toBe(
      bookingPaymentDueNote({
        amount: "$123.45",
        reference: "BOOKING-1234",
        invoiceEmailed: true,
      }),
    );
    expect(sample).toContain(CREDIT_SENTENCE);
    // And it reconciles: the reference it tells a member to quote is the one
    // {{paymentReference}} previews beside it.
    expect(definition.sampleData.paymentReference).toBe("BOOKING-1234");
    expect(sample).toContain(
      `quoting reference ${definition.sampleData.paymentReference}.`,
    );
  });

  it("is declared EMPTYABLE, so the editor warns about a label typed in front", () => {
    // Review (1 Aug 2026) — mutation pin, mirroring #2328's for {{creditNote}}.
    // The token is "" on every paid, partly-paid and credit-covered send (the
    // cases above), so an override that writes "Payment: {{paymentDueNote}}"
    // sends a bare "Payment:" to everyone who has already paid. Undeclared,
    // guard 4 renders the token with its (non-empty) preview sample, sees a
    // full line and stays quiet. This drives the guard exactly as
    // `GET /api/admin/email-templates` does.
    expect(EMPTYABLE_OVERRIDE_TOKENS["booking-confirmed"]).toContain(
      "paymentDueNote",
    );

    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed definition");
    const findings = findDanglingDefaultLines(
      {
        "booking-confirmed": {
          defaultSubject: "Booking Confirmed",
          defaultBody:
            "Hi {{firstName}}.\n\nPayment: {{paymentDueNote}}\n\nThanks.",
        },
      },
      {
        "booking-confirmed": [
          ...(OPTIONAL_TEMPLATE_TOKENS["booking-confirmed"] ?? []),
          ...(EMPTYABLE_OVERRIDE_TOKENS["booking-confirmed"] ?? []),
        ],
      },
      (token) => definition.sampleData[token] ?? token,
    );

    expect(findings).toEqual([
      {
        key: "booking-confirmed",
        field: "defaultBody",
        detail: '"Payment:"',
      },
    ]);
  });
});
