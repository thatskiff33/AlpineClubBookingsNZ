import { describe, it, expect, vi, beforeEach } from "vitest";

// #2267 — a price-raising FIXED_NIGHTLY/SET_PRICE promo rendered a blank
// "Discount: -" line and an unexplained total in the admin-editable
// booking-confirmed body. These tests render the DEFAULT bodies through
// renderTemplateString with the exact templateData the senders build — the
// override render path prepareEmailMessage takes — for all three promo
// shapes, and pin the flat body to the hand-built HTML template so the two
// money stories can never drift apart again (the 31651e00 failure mode).

const { sendEmailMock, loadLodgeSettingsMock, loadAppliedCreditMock } =
  vi.hoisted(() => ({
    sendEmailMock: vi.fn().mockResolvedValue({ status: "sent" }),
    loadLodgeSettingsMock: vi.fn(),
    loadAppliedCreditMock: vi.fn(),
  }));

vi.mock("@/lib/email/core", () => ({
  sendEmail: sendEmailMock,
}));

// #2328: the sender reads the booking's applied account credit itself, from the
// ledger, rather than trusting a caller to thread it in. Stubbed here so each
// case can state what the booking's persisted records say; defaults to no
// credit, which is the byte-for-byte-unchanged shape every #2267/#2263/#2397
// case below asserts.
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
  // Search key the email `<title>` bakes (C6 #1985); required alongside
  // EMAIL_DEFAULT_LODGE_NAME whenever this module is mocked and a template renders.
  EMAIL_DEFAULT_FROM_NAME: "Example Club - Online Booking System",
  loadEmailMessageSettingsForLodge: loadLodgeSettingsMock,
  loadEmailMessageSettings: vi.fn(),
  applyEmailMessageSettingsToHtml: vi.fn((html: string) => html),
  applyEmailMessageSettingsToSubject: vi.fn((subject: string) => subject),
  buildEmailTemplateGlobalData: vi.fn(() => ({})),
}));

import { getEmailTemplateDefinition } from "@/lib/email-message-registry";
import { plainTextEmailTemplate } from "@/lib/email-templates/layout";
import {
  renderTemplateString,
  validateEmailTemplateContent,
  type EmailTemplateData,
} from "@/lib/email-message-renderer";

// The global tokens prepareEmailMessage merges in from settings; supplied here
// so the rendered default body has no artificial holes at the global tokens.
const GLOBAL_DATA: EmailTemplateData = {
  BASE_URL: "https://bookings.example.org",
  CLUB_LODGE_TRAVEL_NOTE: "Take the Bruce Road.",
};

// Most clubs have a door code; the doorCode-unset cells below override it.
beforeEach(() => {
  loadLodgeSettingsMock.mockResolvedValue({
    lodgeTravelNote: "Take the Bruce Road.",
    doorCode: "1234",
  });
  loadAppliedCreditMock.mockResolvedValue({
    amountCents: 0,
    settlementMethod: "card",
  });
});

function renderDefaultBody(
  templateName: string,
  templateData: EmailTemplateData,
): string {
  const definition = getEmailTemplateDefinition(templateName);
  if (!definition) throw new Error(`missing definition for ${templateName}`);
  return renderTemplateString(definition.defaultBody, {
    ...GLOBAL_DATA,
    ...templateData,
  });
}

// The assertion that would have caught the original bug: no rendered line may
// trail off after a sign, a dash or a colon (the blank "Discount: -" line, the
// dangling "Door code:" line), and bracket authoring notes must never reach a
// member inbox as body text. The en dash is in the class because the date rows
// are written with one.
function expectCleanLines(text: string, label: string) {
  expect(text).not.toContain("[only when");
  expect(text).not.toContain("[when");
  for (const line of text.split("\n")) {
    const trimmed = line.trimEnd();
    expect(trimmed, `dangling ${label} line: ${JSON.stringify(line)}`).not.toMatch(
      /[-+:–]$/,
    );
  }
}

// The delivered email is not the rendered string: prepareEmailMessage feeds a
// stored override through plainTextEmailTemplate, which trims and drops blank
// blocks. Reading the text back out of that HTML is what proves a member never
// sees a dangling label — the rendered-string check alone can be satisfied by
// text the layout would still render badly.
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "\n")
    .replace(/&ndash;/g, "–")
    .replace(/&bull;/g, "•")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

// Both halves of the override render path: the substituted body text, and the
// HTML a member actually receives.
function expectCleanBody(rendered: string) {
  expectCleanLines(rendered, "rendered");
  expectCleanLines(htmlToText(plainTextEmailTemplate(rendered)), "delivered");
}

async function captureConfirmedTemplateData(
  totalCents: number,
  options?: {
    promoAdjustmentCents?: number;
    promoCode?: string;
    // Lodge door code for this send; null models a club that records none.
    doorCode?: string | null;
    // #2263: a CONFIRMED-but-unpaid send (member whole-lodge approval).
    paymentDue?: { reference: string; invoiceEmailed: boolean };
    // #2397: a settled send for LESS than the booking is worth (a cash
    // settlement the admin said did not cover an uncollected price increase).
    outstandingBalance?: { amountCents: number; payableOnline: boolean };
  },
  // #2328: what the booking's PERSISTED records say about account credit — the
  // ledger's applied total and how the rest was settled. A separate argument,
  // not part of the sender's options, because the sender READS this rather than
  // being told it. Omitted here means "no credit", the shape every case below
  // asserts unchanged.
  appliedCredit?: {
    amountCents: number;
    settlementMethod: "card" | "bank_transfer" | "manual";
  },
): Promise<{ templateData: EmailTemplateData; html: string }> {
  if (options && "doorCode" in options) {
    loadLodgeSettingsMock.mockResolvedValue({
      lodgeTravelNote: "Take the Bruce Road.",
      doorCode: options.doorCode,
    });
  }
  if (appliedCredit) {
    loadAppliedCreditMock.mockResolvedValue(appliedCredit);
  }
  const { sendBookingConfirmedEmail } = await import("../email/booking");
  await sendBookingConfirmedEmail(
    { bookingId: "bk_test", recipientMemberId: "member_1" },
    "member@example.org",
    "Sam",
    new Date("2026-08-15"),
    new Date("2026-08-16"),
    options?.promoAdjustmentCents ? 1 : 2,
    totalCents,
    options,
  );
  expect(sendEmailMock).toHaveBeenCalledTimes(1);
  const call = sendEmailMock.mock.calls[0][0];
  expect(call.templateName).toBe("booking-confirmed");
  return { templateData: call.templateData, html: call.html };
}

describe("booking-confirmed promo summary (#2267)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("explains a price-raising SET_PRICE promo with a visibly positive adjustment (the incident shape)", async () => {
    // FULL_LODGE_RATE_2025: 1 guest × 1 night base $30.00, exclusive-use flat
    // rate raises the price by +$1,370.00 to $1,400.00.
    const { templateData, html } = await captureConfirmedTemplateData(140000, {
      promoAdjustmentCents: 137000,
      promoCode: "FULL_LODGE_RATE_2025",
    });

    const rendered = renderDefaultBody("booking-confirmed", templateData);

    // Subtotal, adjustment and total reconcile, and the adjustment is signed.
    expect(rendered).toContain(
      "Guests: 1\n" +
        "Subtotal: $30.00\n" +
        "Promo adjustment (FULL_LODGE_RATE_2025): +$1,370.00\n" +
        "Total Paid: $1,400.00",
    );
    // The old discount-only wording could not express a surcharge — it must
    // not reappear anywhere in the rendered body.
    expect(rendered).not.toContain("Discount");
    expectCleanBody(rendered);

    // Drift guard: the hand-built HTML path shows the identical rows — same
    // labels, same values, in its own info table.
    expect(html).toContain(">Subtotal</td>");
    expect(html).toContain(">$30.00</td>");
    expect(html).toContain(">Promo adjustment (FULL_LODGE_RATE_2025)</td>");
    expect(html).toContain(">+$1,370.00</td>");
    expect(html).toContain(">Total Paid</td>");
    expect(html).toContain(">$1,400.00</td>");
  });

  it("renders a discount promo with a negative adjustment", async () => {
    const { templateData, html } = await captureConfirmedTemplateData(27000, {
      promoAdjustmentCents: -3000,
      promoCode: "SPRING10",
    });

    const rendered = renderDefaultBody("booking-confirmed", templateData);

    expect(rendered).toContain(
      "Guests: 1\n" +
        "Subtotal: $300.00\n" +
        "Promo adjustment (SPRING10): -$30.00\n" +
        "Total Paid: $270.00",
    );
    expectCleanBody(rendered);

    expect(html).toContain(">Subtotal</td>");
    expect(html).toContain(">$300.00</td>");
    expect(html).toContain(">Promo adjustment (SPRING10)</td>");
    expect(html).toContain(">-$30.00</td>");
    expect(html).toContain(">$270.00</td>");
  });

  it("renders no promo lines at all — not ragged, not empty — without a promo", async () => {
    const { templateData, html } = await captureConfirmedTemplateData(30000);

    expect(templateData.promoSummary).toBe("");
    const rendered = renderDefaultBody("booking-confirmed", templateData);

    // The {{promoSummary}} token collapses to nothing: Total Paid follows
    // Guests directly with no blank or ragged line in between.
    expect(rendered).toContain("Guests: 2\nTotal Paid: $300.00");
    expect(rendered).not.toContain("Subtotal");
    expect(rendered).not.toContain("Promo adjustment");
    expectCleanBody(rendered);

    expect(html).not.toContain("Subtotal");
    expect(html).not.toContain("Promo adjustment");
  });

  it("renders a confirmed-but-unpaid send as Total Due plus the owing sentence, never the processed line (#2263)", async () => {
    // The member whole-lodge approval confirms a booking whose money is a
    // PENDING internet-banking receivable. The default body's money story is
    // the single pre-composed {{paymentOutcome}} block, so this send must
    // render the amount OWING and the payment reference — and must not render
    // "Total Paid" or "Payment has been processed successfully", both of which
    // would be false.
    const { templateData } = await captureConfirmedTemplateData(30000, {
      paymentDue: { reference: "BOOKING-ABC123", invoiceEmailed: false },
    });

    // #2444 appends the account-credit sentence to this branch's paragraph (see
    // booking-confirmed-payment-due-credit-email.test.ts); everything before it
    // is the #2263 wording unchanged.
    expect(templateData.paymentOutcome).toBe(
      "Total Due: $300.00\n\nThis booking is confirmed, but payment of $300.00 is still owing. Please pay by internet banking quoting reference BOOKING-ABC123. The club will send you an invoice for it. If the invoice asks for a different amount — for example because the club has put account credit you hold towards it — please transfer the amount the invoice shows.",
    );
    // The per-piece tokens stay honest for overrides that build their own
    // lines: exactly one of the pair carries a figure.
    expect(templateData.totalPaid).toBe("");
    expect(templateData.totalDue).toBe("$300.00");
    expect(templateData.paymentReference).toBe("BOOKING-ABC123");

    const rendered = renderDefaultBody("booking-confirmed", templateData);
    expect(rendered).toContain("Guests: 2\nTotal Due: $300.00");
    expect(rendered).toContain("quoting reference BOOKING-ABC123");
    expect(rendered).not.toContain("Total Paid");
    expect(rendered).not.toContain("Payment has been processed");
    expectCleanBody(rendered);
  });

  it("claims an emailed invoice only when one was actually raised (#2263)", async () => {
    const { templateData } = await captureConfirmedTemplateData(30000, {
      paymentDue: { reference: "BOOKING-ABC123", invoiceEmailed: true },
    });
    expect(templateData.paymentOutcome).toContain(
      "An invoice has been emailed to you separately.",
    );
    expect(templateData.paymentOutcome).not.toContain(
      "The club will send you an invoice for it.",
    );
  });

  it("renders a partly-paid settle as Booking Total / Paid / Still Owing, never the processed line (#2397)", async () => {
    // A $121.00 booking settled in cash for $100.00 because the admin said the
    // money did not cover the $21.00 addition. "Total Paid: $121.00 — Payment
    // has been processed successfully" would be false on both counts, and would
    // contradict the receipt the same request gave the admin.
    const { templateData, html } = await captureConfirmedTemplateData(12100, {
      outstandingBalance: { amountCents: 2100, payableOnline: true },
    });

    expect(templateData.paymentOutcome).toBe(
      "Booking Total: $121.00\nPaid: $100.00\nStill Owing: $21.00\n\n" +
        "Your payment of $100.00 has been recorded and your booking is confirmed. " +
        "$21.00 is still owing from a later change to this booking. " +
        "You can pay it from your booking page.",
    );
    // Both per-piece tokens carry a figure here, and neither is the price.
    expect(templateData.totalPaid).toBe("$100.00");
    expect(templateData.totalDue).toBe("$21.00");
    // No internet-banking reference exists on this path.
    expect(templateData.paymentDueNote).toBe("");
    expect(templateData.paymentReference).toBe("");

    const rendered = renderDefaultBody("booking-confirmed", templateData);
    expect(rendered).toContain(
      "Booking Total: $121.00\nPaid: $100.00\nStill Owing: $21.00",
    );
    expect(rendered).not.toContain("Total Paid");
    expect(rendered).not.toContain("Payment has been processed");
    expectCleanBody(rendered);

    // Drift guard: the hand-built HTML tells the identical money story.
    expect(html).toContain(">Booking Total</td>");
    expect(html).toContain(">Still Owing</td>");
    expect(html).toContain(">$21.00</td>");
    expect(html).not.toContain(">Total Paid</td>");
    expect(html).not.toContain("Payment has been processed successfully");
    expect(html).toContain("You can pay it from your booking page.");
  });

  it("splits the booking's PRICE, not the cash, when account credit paid part of a partly-paid settle (#2397)", async () => {
    // A $200.00 booking with $50.00 of account credit applied and a $30.00
    // addition the cash did not cover: the club took $120.00 in cash. The three
    // rows are derived from the PRICE and what is still owing, so "Paid" is
    // $170.00 — the $120.00 of cash plus the $50.00 of credit, which really did
    // pay for part of the stay. That matches the convention the ordinary
    // confirmation has always used (a credit-paid booking's "Total Paid" is the
    // whole price too), and it keeps the arithmetic the member can check —
    // Paid = Booking Total − Still Owing — true whether or not credit was
    // involved. Reporting the $120.00 of cash instead would read as though the
    // club were still owed the credit the member had already spent.
    //
    // #2328 KEEPS all three rows exactly as pinned here and adds the breakdown
    // BENEATH "Paid" — the ledger is what supplies the credit figure, and this
    // fixture models none, so nothing is added. The same numbers with the
    // $50.00 of credit actually on the ledger are pinned in
    // booking-confirmed-credit-email.test.ts.
    const { templateData, html } = await captureConfirmedTemplateData(20000, {
      outstandingBalance: { amountCents: 3000, payableOnline: true },
    });

    expect(templateData.paymentOutcome).toBe(
      "Booking Total: $200.00\nPaid: $170.00\nStill Owing: $30.00\n\n" +
        "Your payment of $170.00 has been recorded and your booking is confirmed. " +
        "$30.00 is still owing from a later change to this booking. " +
        "You can pay it from your booking page.",
    );
    expect(templateData.totalPaid).toBe("$170.00");
    expect(templateData.totalDue).toBe("$30.00");

    const rendered = renderDefaultBody("booking-confirmed", templateData);
    expect(rendered).toContain(
      "Booking Total: $200.00\nPaid: $170.00\nStill Owing: $30.00",
    );
    expectCleanBody(rendered);

    // Drift guard: the hand-built HTML splits it the same way.
    expect(html).toContain(">Paid</td>");
    expect(html).toContain(">$170.00</td>");
    expect(html).toContain(">$30.00</td>");
  });

  it("points a partly-paid member at the club, not a pay door, when no card instrument survives (#2397)", async () => {
    const { templateData, html } = await captureConfirmedTemplateData(12100, {
      outstandingBalance: { amountCents: 2100, payableOnline: false },
    });

    expect(templateData.paymentOutcome).toContain(
      "The club will be in touch to arrange it.",
    );
    expect(templateData.paymentOutcome).not.toContain("your booking page");
    expect(html).toContain("The club will be in touch to arrange it.");
  });

  it("renders the whole door-code line when the lodge has a code", async () => {
    const { templateData } = await captureConfirmedTemplateData(30000, {
      doorCode: "1234",
    });

    expect(templateData.doorCodeNote).toBe("Door code: 1234");
    const rendered = renderDefaultBody("booking-confirmed", templateData);
    expect(rendered).toContain("Door code: 1234");
    expectCleanBody(rendered);
  });

  it("renders no door-code line at all for a club that records no door code", async () => {
    const { templateData } = await captureConfirmedTemplateData(30000, {
      doorCode: null,
    });

    // The bare value is still supplied (empty) for legacy overrides, but the
    // pre-composed line collapses to nothing, so the default body cannot emit
    // the dangling "Door code:" line it used to.
    expect(templateData.doorCode).toBe("");
    expect(templateData.doorCodeNote).toBe("");
    const rendered = renderDefaultBody("booking-confirmed", templateData);
    expect(rendered).not.toContain("Door code");
    expectCleanBody(rendered);
  });

  it("keeps an existing override that writes its own Door code line valid and re-savable", () => {
    // The pre-#2267 override shape: the label is written by hand around the
    // bare {{doorCode}} value. It must still satisfy the required-token rule,
    // or an operator could no longer re-save their own saved body.
    const legacy = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed",
      bodyText:
        "Hi {{firstName}}, you're confirmed.\n\n{{promoSummary}}Total Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
    });
    expect(legacy.missingRequiredTokens).toEqual([]);
    expect(legacy.valid).toBe(true);

    // The new pre-composed token satisfies it directly.
    const composed = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed",
      bodyText:
        "Hi {{firstName}}, you're confirmed.\n\n{{promoSummary}}Total Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
    });
    expect(composed.valid).toBe(true);

    // Dropping the door code entirely is still rejected.
    const missing = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed",
      bodyText:
        "Hi {{firstName}}, you're confirmed.\n\n{{promoSummary}}Total Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}",
    });
    expect(missing.valid).toBe(false);
    expect(missing.missingRequiredTokens).toContain("doorCodeNote");
  });

  // The owner's decision on PR #2311: the promo explanation is required content
  // on a payment confirmation, with the legacy tokens accepted in its place so
  // no override a club already saved is invalidated.
  it("requires the promo explanation in an override, and says how to satisfy it", () => {
    const missing = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed",
      bodyText:
        "Hi {{firstName}}, you're confirmed.\n\nTotal Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
    });
    expect(missing.valid).toBe(false);
    expect(missing.missingRequiredTokens).toEqual(["promoSummary"]);
    const issue = missing.issues.find(
      (candidate) => candidate.code === "missing_required_token",
    );
    // Plain English, and it names every token that satisfies the rule.
    expect(issue?.message).toContain(
      "must show members how a promo code changed their price",
    );
    for (const token of ["{{promoSummary}}", "{{promoAdjustment}}", "{{discount}}"]) {
      expect(issue?.message).toContain(token);
    }

    // A subtotal with no adjustment beside it is the incident shape, not an
    // explanation, so it does not satisfy the requirement.
    const subtotalOnly = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed",
      bodyText:
        "Hi {{firstName}}\n\nSubtotal: {{subtotal}}\nTotal Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
    });
    expect(subtotalOnly.valid).toBe(false);
    expect(subtotalOnly.missingRequiredTokens).toEqual(["promoSummary"]);
  });

  it.each([
    {
      shape: "the pre-composed block",
      bodyText:
        "Hi {{firstName}}\n\n{{promoSummary}}Total Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
    },
    {
      // The pre-#2267 shipped default body, promo lines and all: this is the
      // exact shape of every override a club saved from it, so it must keep
      // validating and re-saving.
      shape: "the legacy shipped default's subtotal/discount pair",
      bodyText:
        "Hi {{firstName}}, your booking is confirmed.\n\nSubtotal: {{subtotal}}\nDiscount ({{promoCode}}): -{{discount}}\nTotal Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
    },
    {
      shape: "a hand-written subtotal and signed adjustment pair",
      bodyText:
        "Hi {{firstName}}\n\nSubtotal: {{subtotal}}\nPromo {{promoCode}}: {{promoAdjustment}}\nTotal Paid: {{totalPaid}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
    },
  ])("accepts an override that tells the promo story with $shape", ({ bodyText }) => {
    const validation = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed",
      bodyText,
    });
    expect(validation.missingRequiredTokens).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("registers the promo requirement and its alternatives for the editor", () => {
    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed");
    // The chips the editor renders mark it required, and the requirement
    // sentence it prints under them is built from these two fields.
    expect(definition.requiredTokens).toContain("promoSummary");
    expect(definition.requiredTokenAlternatives.promoSummary).toEqual([
      "promoAdjustment",
      "discount",
    ]);
    // Every alternative must itself be usable in this template's body.
    for (const alternative of definition.requiredTokenAlternatives.promoSummary) {
      expect(definition.allowedTokens).toContain(alternative);
    }
  });

  it("never lets the composed door-code line into a subject line", () => {
    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed");
    // The composed line carries the code itself, so it is subject-forbidden
    // exactly like the bare {{doorCode}} value.
    const result = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed {{doorCodeNote}}",
      bodyText: definition.defaultBody,
    });
    expect(result.valid).toBe(false);
    expect(result.sensitiveSubjectTokens).toContain("doorCodeNote");
  });

  it("refuses an override that writes its own minus in front of a signed promo token", () => {
    // "Discount: -{{promoAdjustment}}" is the incident shape re-created by
    // hand: it renders "Discount: -+$1,370.00" on a surcharge promo and a bare
    // "Discount: -" on a booking with no promo at all.
    for (const bodyText of [
      "Hi {{firstName}}\n\nDiscount: -{{promoAdjustment}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
      "Hi {{firstName}}\n\nDiscount: - {{ promoAdjustment }}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
      "Hi {{firstName}}\n\nSurcharge: +{{promoSummary}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
    ]) {
      const result = validateEmailTemplateContent({
        templateName: "booking-confirmed",
        subject: "Booking Confirmed",
        bodyText,
      });
      expect(result.valid, bodyText).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toContain(
        "sign_prefixed_token",
      );
      const issue = result.issues.find(
        (candidate) => candidate.code === "sign_prefixed_token",
      );
      expect(issue?.field).toBe("bodyText");
      // Plain English, and it says what to do about it.
      expect(issue?.message).toContain("already includes its own sign");
    }
  });

  it("accepts the tokens used without a hand-written sign", () => {
    const result = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed",
      bodyText:
        "Hi {{firstName}}\n\n{{promoSummary}}Total Paid: {{totalPaid}}\nAdjustment: {{promoAdjustment}}\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{doorCodeNote}}",
    });
    expect(result.signPrefixedTokens).toEqual([]);
    expect(result.valid).toBe(true);

    // The shipped default body must obviously satisfy its own rule.
    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed");
    expect(
      validateEmailTemplateContent({
        templateName: "booking-confirmed",
        subject: definition.defaultSubject,
        bodyText: definition.defaultBody,
      }).valid,
    ).toBe(true);
  });

  it("previews one coherent set of money samples that actually reconcile", () => {
    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed");
    const sample = definition.sampleData;

    const dollars = (value: string) => {
      const match = value.match(/-?\$[\d,]+\.\d{2}/);
      if (!match) throw new Error(`no money value in ${JSON.stringify(value)}`);
      return Math.round(Number(match[0].replace(/[$,]/g, "")) * 100);
    };

    // Subtotal + signed adjustment = the total the sample body prints.
    expect(dollars(sample.subtotal) + dollars(sample.promoAdjustment)).toBe(
      dollars(sample.totalPaid),
    );
    // The pre-composed block quotes the same two numbers, not a second set.
    const [subtotalRow, adjustmentRow] = sample.promoSummary.trim().split("\n");
    expect(subtotalRow).toBe(`Subtotal: ${sample.subtotal}`);
    expect(adjustmentRow).toBe(
      `Promo adjustment (${sample.promoCode}): ${sample.promoAdjustment}`,
    );
    // The legacy discount token is the same movement without its sign.
    expect(dollars(sample.discount)).toBe(-dollars(sample.promoAdjustment));

    // And the preview an admin actually reads shows that arithmetic.
    const rendered = renderTemplateString(definition.defaultBody, sample);
    expect(rendered).toContain(
      "Subtotal: $153.45\nPromo adjustment (PROMO2026): -$30.00\nTotal Paid: $123.45",
    );
  });

  it("keeps the split provisionalGuestsNote token in the default body (CONFIGURATION.md mandate)", () => {
    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed");
    expect(definition.defaultBody).toContain("{{provisionalGuestsNote}}");
    for (const token of definition.requiredTokens) {
      expect(definition.defaultBody).toContain(`{{${token}}}`);
    }
  });

  it("keeps the legacy per-piece promo tokens valid for existing overrides, including {{promoAdjustment}}", async () => {
    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed");
    expect(definition.allowedTokens).toEqual(
      expect.arrayContaining([
        "discount",
        "promoAdjustment",
        "promoCode",
        "promoSummary",
        "provisionalGuestsNote",
        "subtotal",
      ]),
    );

    // Acceptance (#2267): {{promoAdjustment}} passes admin-editor validation —
    // before this fix it was rejected as both unknown and disallowed.
    const validation = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Booking Confirmed",
      bodyText:
        "Hi {{firstName}}, promo adjustment {{promoAdjustment}} applied.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
    });
    expect(validation.valid).toBe(true);

    // The send still supplies the legacy tokens for such overrides, with the
    // signed value carrying its own +/-.
    const { templateData } = await captureConfirmedTemplateData(140000, {
      promoAdjustmentCents: 137000,
      promoCode: "FULL_LODGE_RATE_2025",
    });
    expect(templateData.promoAdjustment).toBe("+$1,370.00");
    expect(templateData.subtotal).toBe("$30.00");
    expect(templateData.discount).toBe("");
  });
});

describe("booking-modified default body (#2267)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function captureModified(overrides: {
    modificationType?: string;
    newFinalPriceCents: number;
    newCheckIn?: Date;
    newCheckOut?: Date;
    newGuestCount?: number;
    changeFeeCents?: number;
    additionalAmountCents?: number;
    additionalPaymentMethod?: "STRIPE" | "INTERNET_BANKING";
    paymentReference?: string | null;
    xeroInvoiceNumber?: string | null;
  }): Promise<{ templateData: EmailTemplateData; html: string }> {
    const { sendBookingModifiedEmail } = await import("../email/booking");
    await sendBookingModifiedEmail({
      bookingId: "bk_test",
      recipientMemberId: "member_1",
      email: "member@example.org",
      firstName: "Sam",
      modificationType: "DATE_CHANGE",
      oldCheckIn: new Date("2026-08-15"),
      oldCheckOut: new Date("2026-08-18"),
      newCheckIn: new Date("2026-08-16"),
      newCheckOut: new Date("2026-08-19"),
      oldGuestCount: 2,
      newGuestCount: 2,
      oldFinalPriceCents: 30000,
      changeFeeCents: 0,
      refundAmountCents: 0,
      additionalAmountCents: 0,
      ...overrides,
    });
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.templateName).toBe("booking-modified");
    return { templateData: call.templateData, html: call.html };
  }

  // Same fixture, both paths: the rows an admin's editable body renders must be
  // exactly the rows the built-in HTML email shows — no more, no less. The
  // expected rows are hand-written here (not derived from the shared helper),
  // so a change to that helper has to be a deliberate change to these
  // expectations.
  const changeRowCases: Array<{
    name: string;
    send: Parameters<typeof captureModified>[0];
    expectedRows: string[];
    absentLabels: string[];
  }> = [
    {
      name: "dates moved, party and price unchanged",
      send: { newFinalPriceCents: 30000 },
      expectedRows: [
        "Previous Dates: 15 Aug 2026 – 18 Aug 2026",
        "New Dates: 16 Aug 2026 – 19 Aug 2026",
        "Guests: 2",
        "Total: $300.00",
      ],
      absentLabels: [
        "Previous Guests",
        "New Guests",
        "Previous Total",
        "New Total",
        "Change Fee",
      ],
    },
    {
      name: "price changed and a change fee was charged",
      send: { newFinalPriceCents: 37000, changeFeeCents: 2500 },
      expectedRows: [
        "Previous Total: $300.00",
        "New Total: $370.00",
        "Change Fee: $25.00",
      ],
      absentLabels: ["Previous Guests", "New Guests"],
    },
    {
      name: "guests only: same dates, same price, no fee",
      send: {
        modificationType: "GUEST_ADD",
        newCheckIn: new Date("2026-08-15"),
        newCheckOut: new Date("2026-08-18"),
        newGuestCount: 3,
        newFinalPriceCents: 30000,
      },
      expectedRows: [
        "Dates: 15 Aug 2026 – 18 Aug 2026",
        "Previous Guests: 2",
        "New Guests: 3",
        "Total: $300.00",
      ],
      absentLabels: [
        "Previous Dates",
        "New Dates",
        "Previous Total",
        "New Total",
        "Change Fee",
      ],
    },
    {
      name: "batch edit that moved dates, party and price together",
      send: {
        modificationType: "BATCH_MODIFY",
        newGuestCount: 4,
        newFinalPriceCents: 45000,
      },
      expectedRows: [
        "Previous Dates: 15 Aug 2026 – 18 Aug 2026",
        "New Dates: 16 Aug 2026 – 19 Aug 2026",
        "Previous Guests: 2",
        "New Guests: 4",
        "Previous Total: $300.00",
        "New Total: $450.00",
      ],
      absentLabels: ["Change Fee", "Dates", "Guests", "Total"],
    },
  ];

  it.each(changeRowCases)(
    "shows the same change rows on both paths — $name",
    async ({ send, expectedRows, absentLabels }) => {
      const { templateData, html } = await captureModified(send);
      const rendered = renderDefaultBody("booking-modified", templateData);

      for (const row of expectedRows) {
        // The admin-editable body renders the row as a plain "Label: value"
        // line…
        expect(rendered, row).toContain(row);
        // …and the built-in HTML email shows the identical label and value in
        // its info table.
        const [label, value] = row.split(/: (.+)/);
        expect(html, row).toContain(`>${label}</td>`);
        expect(html, row).toContain(`>${value}</td>`);
      }
      for (const label of absentLabels) {
        // Line-anchored: "Dates" must be absent as its own row label without
        // tripping on the "Previous Dates" row that is legitimately there.
        expect(rendered, label).not.toMatch(
          new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`, "m"),
        );
        expect(html, label).not.toContain(`>${label}</td>`);
      }
      expectCleanBody(rendered);
    },
  );

  it("names the modification in words on both paths, including a batch edit", async () => {
    const dateChange = await captureModified({ newFinalPriceCents: 30000 });
    expect(dateChange.templateData.modificationTypeLabel).toBe("Dates Changed");
    expect(
      renderDefaultBody("booking-modified", dateChange.templateData),
    ).toContain("Dates Changed");
    expect(dateChange.html).toContain("Dates Changed");

    vi.clearAllMocks();
    // BATCH_MODIFY had no wording on either path, so members were emailed the
    // raw enum word.
    const batch = await captureModified({
      modificationType: "BATCH_MODIFY",
      newFinalPriceCents: 30000,
    });
    expect(batch.templateData.modificationTypeLabel).toBe("Booking Modified");
    expect(renderDefaultBody("booking-modified", batch.templateData)).not.toContain(
      "BATCH_MODIFY",
    );
    expect(batch.html).not.toContain("BATCH_MODIFY");
  });

  it("carries the additional-payment story through the pre-composed note", async () => {
    const { templateData } = await captureModified({
      newFinalPriceCents: 37000,
      additionalAmountCents: 7000,
      additionalPaymentMethod: "INTERNET_BANKING",
      paymentReference: "ABC123",
      xeroInvoiceNumber: "INV-100",
    });

    const rendered = renderDefaultBody("booking-modified", templateData);
    expect(rendered).toContain(
      "An additional Internet Banking payment of $70.00 is required.",
    );
    expect(rendered).toContain("Xero invoice INV-100");
    expect(rendered).toContain("Payment reference: ABC123.");
    expectCleanBody(rendered);
  });

  it("renders cleanly when no payment movement occurred (empty paymentNote)", async () => {
    const { templateData } = await captureModified({
      newFinalPriceCents: 30000,
    });

    expect(templateData.paymentNote).toBe("");
    const rendered = renderDefaultBody("booking-modified", templateData);
    expectCleanBody(rendered);
  });

  it("previews one coherent modification: every sample tells the same story", () => {
    const definition = getEmailTemplateDefinition("booking-modified");
    if (!definition) throw new Error("missing booking-modified");
    const sample = definition.sampleData;

    // The pre-composed block quotes the same dates, party and totals as the
    // per-piece tokens a legacy override uses.
    expect(sample.changeSummary).toContain(
      `Previous Dates: ${sample.oldCheckIn} – ${sample.oldCheckOut}`,
    );
    expect(sample.changeSummary).toContain(
      `New Dates: ${sample.newCheckIn} – ${sample.newCheckOut}`,
    );
    expect(sample.changeSummary).toContain(`Guests: ${sample.newGuestCount}`);
    expect(sample.changeSummary).toContain(`Previous Total: ${sample.oldTotal}`);
    expect(sample.changeSummary).toContain(`New Total: ${sample.newTotal}`);
    // And the payment note is the difference between those two totals.
    expect(sample.paymentNote).toContain("$26.55");

    const rendered = renderTemplateString(definition.defaultBody, sample);
    expect(rendered).not.toMatch(/\{\{[^{}]+\}\}/);
    expectCleanBody(rendered);
  });

  it("keeps the per-piece tokens the old body used allowed for existing overrides", () => {
    const definition = getEmailTemplateDefinition("booking-modified");
    if (!definition) throw new Error("missing booking-modified");
    expect(definition.allowedTokens).toEqual(
      expect.arrayContaining([
        "additionalPaymentMethod",
        "changeFee",
        "changeSummary",
        "newCheckIn",
        "newCheckOut",
        "newGuestCount",
        "newTotal",
        "oldCheckIn",
        "oldCheckOut",
        "oldGuestCount",
        "oldTotal",
        "paymentNote",
        "paymentReference",
        "xeroInvoiceNumber",
      ]),
    );

    // The pre-#2267 override shape — hand-built Previous/New rows — still
    // validates and still renders from the data the send supplies.
    const legacy = validateEmailTemplateContent({
      templateName: "booking-modified",
      subject: "Booking Modified",
      bodyText:
        "Hi {{firstName}}\n\nPrevious Dates: {{oldCheckIn}} – {{oldCheckOut}}\nNew Dates: {{newCheckIn}} – {{newCheckOut}}\nPrevious Total: {{oldTotal}}\nNew Total: {{newTotal}}\nChange Fee: {{changeFee}}\n\n{{paymentNote}}",
    });
    expect(legacy.valid).toBe(true);
  });
});

describe("reverse-drift guard: no bracket annotations in the money default bodies (#2267)", () => {
  it.each(["booking-confirmed", "booking-modified"] as const)(
    "keeps the %s default body free of [only when …] authoring notes",
    (key) => {
      const definition = getEmailTemplateDefinition(key);
      if (!definition) throw new Error(`missing ${key}`);
      expect(definition.defaultBody).not.toMatch(/\[only when|\[when /);
      expect(definition.defaultSubject).not.toMatch(/\[only when|\[when /);
    },
  );
});
