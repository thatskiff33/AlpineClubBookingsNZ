import { describe, expect, it } from "vitest";
import { EMAIL_AUDIT_DEFAULTS } from "@/lib/email-message-audit-defaults";
import {
  APPROVED_EMAIL_TEMPLATE_TOKEN_SET,
  EXTRA_TEMPLATE_TOKENS,
  EMAIL_TEMPLATE_DEFINITIONS,
  EMAIL_TEMPLATE_KEY_SET,
  getEmailTemplateDefinition,
  sampleValue,
} from "@/lib/email-message-registry";
import {
  EMPTYABLE_OVERRIDE_TOKENS,
  OPTIONAL_TEMPLATE_TOKENS,
  findBracketAnnotations,
  findDanglingDefaultLines,
  findStaleOptionalTokens,
  findUnapprovedDefaultTokens,
  findUnapprovedSuppliedTokens,
  findUnconditionalLines,
  findUnsupportedEmptyableTokens,
  type EmailTemplateDefaults,
} from "@/lib/email-message-token-contract";
import {
  renderTemplateString,
  validateEmailTemplateContent,
} from "@/lib/email-message-renderer";
import {
  ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES,
  isBookingSuppressibleTemplate,
} from "@/lib/booking-email-suppression";
import {
  BOOKING_URL_TEMPLATE_NAMES,
  findBookingUrlTemplateContractFindings,
} from "@/lib/booking-email-template-contract";

// #2268 — the guard these replace was circular. The old check ran
// validateEmailTemplateContent over every default body, but the per-template
// `allowedTokens` it validated against is built by scraping tokens out of that
// same default body, so a token was allowed *because* an author had put it
// there. It could not fail on a default, which is how 33 templates shipped
// carrying "[only when ...]" authoring notes as literal member-facing text.
//
// Every guard below takes its registry as an ARGUMENT, and every one is
// exercised twice: once against the real shipped registry, and once against a
// deliberately broken fixture that proves it actually bites.

const DEFAULTS = EMAIL_AUDIT_DEFAULTS as unknown as Record<
  string,
  EmailTemplateDefaults
>;

function renderWithLegacyWholeLineBookingUrlRemoval(
  template: string,
  data: Record<string, string>,
): string {
  return template
    .replace(/^.*\{\{\s*bookingUrl\s*\}\}.*(?:\r?\n|$)/gm, "")
    .replace(/\{\{([^{}]+)\}\}/g, (_match, tokenName: string) => {
      return data[tokenName.trim()] ?? "";
    });
}

function renderWithPerLineOnlyBookingUrlRemoval(
  template: string,
  data: Record<string, string>,
): string {
  return template
    .replace(
      /^[ \t]*\{\{\s*bookingUrl\s*\}\}[ \t]*(?:\r\n|\n|\r|$)/gm,
      "",
    )
    .replace(/\{\{([^{}]+)\}\}/g, (_match, tokenName: string) => {
      return data[tokenName.trim()] ?? "";
    });
}

function renderWithSplitLineSuffixPattern(
  template: string,
  data: Record<string, string>,
  suffixPattern: RegExp,
): string {
  const parts = template.split(/(\r\n|\n|\r)/);
  const replacements = new Map<number, string | null>();
  const tokenOnly = /^[ \t]*\{\{\s*bookingUrl\s*\}\}[ \t]*$/i;
  let rendered = "";

  for (let index = 0; index + 2 < parts.length; index += 2) {
    const line = parts[index] ?? "";
    const nextLine = parts[index + 2] ?? "";
    if (parts[index + 1] === undefined || !tokenOnly.test(nextLine)) continue;
    const withoutCta = line.replace(suffixPattern, "").trimEnd();
    if (withoutCta !== line.trimEnd()) {
      replacements.set(index, withoutCta || null);
      replacements.set(index + 2, null);
    }
  }

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? "";
    const lineEnding = parts[index + 1] ?? "";
    if (replacements.has(index)) {
      const replacement = replacements.get(index);
      if (replacement) rendered += replacement + lineEnding;
    } else if (!tokenOnly.test(line)) {
      rendered += line + lineEnding;
    }
  }

  return rendered.replace(/\{\{([^{}]+)\}\}/g, (_match, tokenName: string) => {
    return data[tokenName.trim()] ?? "";
  });
}

describe("#2362 booking detail URL template contract", () => {
  it("classifies exactly the live registered booking-scoped inventory", () => {
    expect(
      findBookingUrlTemplateContractFindings({
        bookingScopedInventory: ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES,
        registeredTemplates: EMAIL_TEMPLATE_KEY_SET,
        bookingUrlTemplates: BOOKING_URL_TEMPLATE_NAMES,
      }),
    ).toEqual([]);
  });

  it("detects a deliberately removed booking template classification", () => {
    const mutated = new Set(BOOKING_URL_TEMPLATE_NAMES);
    mutated.delete("booking-confirmed");

    expect(
      findBookingUrlTemplateContractFindings({
        bookingScopedInventory: ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES,
        registeredTemplates: EMAIL_TEMPLATE_KEY_SET,
        bookingUrlTemplates: mutated,
      }),
    ).toContainEqual({ kind: "missing", templateName: "booking-confirmed" });
  });

  it("makes bookingUrl optional, sampled, and visible in every classified default", () => {
    for (const templateName of BOOKING_URL_TEMPLATE_NAMES) {
      const definition = getEmailTemplateDefinition(templateName);
      expect(definition, templateName).toBeDefined();
      expect(definition?.allowedTokens, templateName).toContain("bookingUrl");
      expect(definition?.requiredTokens, templateName).not.toContain("bookingUrl");
      expect(definition?.defaultBody, templateName).toContain("{{bookingUrl}}");
      expect(definition?.sampleData.bookingUrl, templateName).toBe(
        "https://bookings.example.org/bookings/bkg_example",
      );
    }
  });

  it("renders the preview sample but removes the entire optional line when unauthorized", () => {
    const definition = getEmailTemplateDefinition("booking-confirmed");
    if (!definition) throw new Error("missing booking-confirmed");

    expect(renderTemplateString(definition.defaultBody, definition.sampleData)).toContain(
      "View this booking: https://bookings.example.org/bookings/bkg_example",
    );
    const withoutAuthority = renderTemplateString(definition.defaultBody, {
      ...definition.sampleData,
      bookingUrl: "",
    });
    expect(withoutAuthority).not.toContain("View this booking:");
    expect(withoutAuthority).not.toContain("/bookings/bkg_example");
  });

  it("does not alter or invalidate an existing override that omits bookingUrl", () => {
    const storedBody = "Hi {{firstName}}, your booking is confirmed.";
    expect(renderTemplateString(storedBody, { firstName: "Aroha", bookingUrl: "" })).toBe(
      "Hi Aroha, your booking is confirmed.",
    );
    expect(
      validateEmailTemplateContent({
        templateName: "booking-pending",
        subject: "Booking pending",
        bodyText: storedBody,
      }).valid,
    ).toBe(true);
  });

  it.each([
    {
      name: "payment action separated by a pipe",
      template:
        "Pay now: {{paymentUrl}} | View this booking: {{bookingUrl}}",
      data: { paymentUrl: "https://pay.example.test/p/bearer-payment" },
      expected: "Pay now: https://pay.example.test/p/bearer-payment",
    },
    {
      name: "respond action after an unavailable booking CTA",
      template:
        "View booking: {{bookingUrl}} • Respond: {{respondUrl}}",
      data: { respondUrl: "https://book.example.test/respond/bearer-response" },
      expected: "Respond: https://book.example.test/respond/bearer-response",
    },
    {
      name: "consent action beside an em-dash-separated booking CTA",
      template:
        "Consent: {{consentUrl}} — Open booking details: {{bookingUrl}}",
      data: { consentUrl: "https://book.example.test/consent/bearer-consent" },
      expected: "Consent: https://book.example.test/consent/bearer-consent",
    },
    {
      name: "HTML-shaped actions separated by a break",
      template:
        '<a href="{{consentUrl}}">Give consent</a><br><a href="{{bookingUrl}}">View booking</a>',
      data: { consentUrl: "https://book.example.test/consent/bearer-html" },
      expected:
        '<a href="https://book.example.test/consent/bearer-html">Give consent</a>',
    },
    {
      name: "unrelated prose sharing a fragment with the booking CTA",
      template:
        "Payment remains due. View this booking: {{bookingUrl}}",
      data: {},
      expected: "Payment remains due.",
    },
    {
      name: "a bearer action after an unrecognised booking-link label",
      template:
        "Use this private page: {{bookingUrl}} then pay: {{paymentUrl}}",
      data: { paymentUrl: "https://pay.example.test/p/bearer-after" },
      expected: "pay: https://pay.example.test/p/bearer-after",
    },
    {
      name: "a bearer action before an unrecognised booking-link label",
      template:
        "Pay: {{paymentUrl}} then use this private page: {{bookingUrl}}",
      data: { paymentUrl: "https://pay.example.test/p/bearer-before" },
      expected: "Pay: https://pay.example.test/p/bearer-before",
    },
  ])("preserves $name when bookingUrl is unavailable", ({ template, data, expected }) => {
    expect(renderTemplateString(template, { ...data, bookingUrl: "" })).toBe(expected);
  });

  it("removes an unrecognised standalone booking CTA instead of leaving a dangling label", () => {
    expect(
      renderTemplateString("Use this private page: {{bookingUrl}}", {
        bookingUrl: "",
      }),
    ).toBe("");
  });

  it("removes a dedicated optional booking-link line without changing surrounding CRLF lines", () => {
    expect(
      renderTemplateString(
        "Keep the payment instructions.\r\nView this booking: {{bookingUrl}}\r\nKeep the consent instructions.",
        { bookingUrl: "" },
      ),
    ).toBe("Keep the payment instructions.\r\nKeep the consent instructions.");
  });

  it("removes an immediately preceding standalone CTA label with a token-only CRLF line", () => {
    const template =
      "View this booking:\r\n{{bookingUrl}}\r\nKeep this operational sentence.";

    expect(renderTemplateString(template, { bookingUrl: "" })).toBe(
      "Keep this operational sentence.",
    );
  });

  it.each([
    {
      name: "unrelated preceding copy",
      template:
        "Payment instructions:\r\n{{bookingUrl}}\r\nKeep this operational sentence.",
      data: { bookingUrl: "" },
      expected:
        "Payment instructions:\r\nKeep this operational sentence.",
    },
    {
      name: "unrelated prose before a recognized CTA suffix",
      template:
        "Payment remains due — View this booking:\r\n{{bookingUrl}}\r\nKeep this operational sentence.",
      data: { bookingUrl: "" },
      expected:
        "Payment remains due\r\nKeep this operational sentence.",
    },
    {
      name: "a bearer action before a recognized CTA suffix",
      template:
        "Pay now: {{paymentUrl}} | View this booking:\r\n{{bookingUrl}}\r\nKeep this operational sentence.",
      data: {
        bookingUrl: "",
        paymentUrl: "https://pay.example.test/p/bearer-previous-line",
      },
      expected:
        "Pay now: https://pay.example.test/p/bearer-previous-line\r\nKeep this operational sentence.",
    },
    {
      name: "a preceding line where the CTA words are not a standalone suffix",
      template:
        "View this booking: call support if it fails.\r\n{{bookingUrl}}\r\nKeep this operational sentence.",
      data: { bookingUrl: "" },
      expected:
        "View this booking: call support if it fails.\r\nKeep this operational sentence.",
    },
    {
      name: "a non-adjacent CTA label",
      template:
        "View this booking:\r\n\r\n{{bookingUrl}}\r\nKeep this operational sentence.",
      data: { bookingUrl: "" },
      expected:
        "View this booking:\r\n\r\nKeep this operational sentence.",
    },
    {
      name: "a next line that also carries a bearer action",
      template:
        "View this booking:\r\n{{bookingUrl}} | Pay now: {{paymentUrl}}\r\nKeep this operational sentence.",
      data: {
        bookingUrl: "",
        paymentUrl: "https://pay.example.test/p/bearer-near-miss",
      },
      expected:
        "View this booking:\r\nPay now: https://pay.example.test/p/bearer-near-miss\r\nKeep this operational sentence.",
    },
  ])("does not delete $name", ({ template, data, expected }) => {
    expect(renderTemplateString(template, data)).toBe(expected);
  });

  it.each([
    "The committee will review this booking:",
    "If the request is withdrawn, do not review this booking:",
  ])(
    "preserves unrelated split-line prose: %s",
    (prose) => {
      const template = `${prose}\n{{bookingUrl}}\nKeep this operational sentence.`;
      expect(renderTemplateString(template, { bookingUrl: "" })).toBe(
        `${prose}\nKeep this operational sentence.`,
      );
    },
  );

  it.each([
    "**View this booking:**",
    "__Open your booking details:__",
  ])("removes an emphasized split-line CTA: %s", (label) => {
    expect(
      renderTemplateString(
        `${label}\r\n{{bookingUrl}}\r\nKeep this operational sentence.`,
        { bookingUrl: "" },
      ),
    ).toBe("Keep this operational sentence.");
  });

  it("keeps a bearer action before an emphasized split-line CTA", () => {
    expect(
      renderTemplateString(
        "Pay now: {{paymentUrl}} | **View this booking:**\n{{bookingUrl}}\nKeep this operational sentence.",
        {
          bookingUrl: "",
          paymentUrl: "https://pay.example.test/p/bearer-emphasis",
        },
      ),
    ).toBe(
      "Pay now: https://pay.example.test/p/bearer-emphasis\nKeep this operational sentence.",
    );
  });

  it("keeps an authorized emphasized split-line CTA byte-for-byte", () => {
    expect(
      renderTemplateString(
        "**View this booking:**\r\n{{bookingUrl}}\r\nKeep this operational sentence.",
        { bookingUrl: "https://book.example.test/bookings/bk_1" },
      ),
    ).toBe(
      "**View this booking:**\r\nhttps://book.example.test/bookings/bk_1\r\nKeep this operational sentence.",
    );
  });

  it("would truncate prose if the split-line suffix lost its start/separator boundary", () => {
    const template =
      "The committee will review this booking:\n{{bookingUrl}}\nKeep this operational sentence.";
    const mutatedUnboundedSuffix =
      /\b(?:review\s+(?:this\s+)?booking)[ \t]*:[ \t]*$/i;

    expect(
      renderWithSplitLineSuffixPattern(
        template,
        { bookingUrl: "" },
        mutatedUnboundedSuffix,
      ),
    ).toBe("The committee will\nKeep this operational sentence.");
    expect(renderTemplateString(template, { bookingUrl: "" })).toBe(
      "The committee will review this booking:\nKeep this operational sentence.",
    );
  });

  it("would leave emphasis dangling if the split-line suffix dropped its balanced variants", () => {
    const template =
      "**View this booking:**\n{{bookingUrl}}\nKeep this operational sentence.";
    const mutatedPlainOnlySuffix =
      /(?:^|[ \t]*\|[ \t]*)\bview\s+(?:this\s+)?booking[ \t]*:[ \t]*$/i;

    expect(
      renderWithSplitLineSuffixPattern(
        template,
        { bookingUrl: "" },
        mutatedPlainOnlySuffix,
      ),
    ).toBe("**View this booking:**\nKeep this operational sentence.");
    expect(renderTemplateString(template, { bookingUrl: "" })).toBe(
      "Keep this operational sentence.",
    );
  });

  it("keeps the authorized two-line CTA byte-for-byte apart from token substitution", () => {
    expect(
      renderTemplateString(
        "View this booking:\r\n{{bookingUrl}}\r\nKeep this operational sentence.",
        { bookingUrl: "https://book.example.test/bookings/bk_1" },
      ),
    ).toBe(
      "View this booking:\r\nhttps://book.example.test/bookings/bk_1\r\nKeep this operational sentence.",
    );
  });

  it("preserves unrelated subject text when the optional booking CTA is unavailable", () => {
    expect(
      renderTemplateString(
        "Payment response needed — View this booking: {{bookingUrl}}",
        { bookingUrl: "" },
      ),
    ).toBe("Payment response needed");
  });

  it("keeps authorized mixed-line overrides rendered normally", () => {
    expect(
      renderTemplateString(
        "Pay: {{paymentUrl}} | View this booking: {{bookingUrl}}",
        {
          paymentUrl: "https://pay.example.test/p/bearer-payment",
          bookingUrl: "https://book.example.test/bookings/bk_1",
        },
      ),
    ).toBe(
      "Pay: https://pay.example.test/p/bearer-payment | View this booking: https://book.example.test/bookings/bk_1",
    );
  });

  it("would fail under the removed whole-line deletion", () => {
    const template =
      "Pay now: {{paymentUrl}} | View this booking: {{bookingUrl}}";
    const data = {
      paymentUrl: "https://pay.example.test/p/bearer-payment",
      bookingUrl: "",
    };

    expect(renderWithLegacyWholeLineBookingUrlRemoval(template, data)).toBe("");
    expect(renderTemplateString(template, data)).toBe(
      "Pay now: https://pay.example.test/p/bearer-payment",
    );
  });

  it("would leave the preceding CTA label under the per-line-only implementation", () => {
    const template =
      "View this booking:\r\n{{bookingUrl}}\r\nKeep this operational sentence.";
    const data = { bookingUrl: "" };

    expect(renderWithPerLineOnlyBookingUrlRemoval(template, data)).toBe(
      "View this booking:\r\nKeep this operational sentence.",
    );
    expect(renderTemplateString(template, data)).toBe(
      "Keep this operational sentence.",
    );
  });
});

describe("#2268 guard 1 — no authoring annotations in a shipped default", () => {
  it("finds none in the shipped defaults", () => {
    expect(findBracketAnnotations(DEFAULTS)).toEqual([]);
  });

  it("fails on a deliberately broken fixture", () => {
    const findings = findBracketAnnotations({
      "broken-body": {
        defaultSubject: "All good",
        defaultBody: "Door code: {{doorCode}} [only when a door code is set]",
      },
      "broken-subject": {
        defaultSubject: "Refund [only when approved]",
        defaultBody: "All good",
      },
    });

    expect(findings).toEqual([
      {
        key: "broken-body",
        field: "defaultBody",
        detail: "[only when a door code is set]",
      },
      {
        key: "broken-subject",
        field: "defaultSubject",
        detail: "[only when approved]",
      },
    ]);
  });
});

describe("#2268 guard 2 — shipped defaults only use approved tokens", () => {
  it("finds none in the shipped defaults", () => {
    expect(
      findUnapprovedDefaultTokens(DEFAULTS, APPROVED_EMAIL_TEMPLATE_TOKEN_SET),
    ).toEqual([]);
  });

  it("is not circular: it fails on a token the defaults themselves introduce", () => {
    // The old guard passed this exact input, because the token was allowed by
    // virtue of appearing in the body being checked.
    const findings = findUnapprovedDefaultTokens(
      {
        "booking-confirmed": {
          defaultSubject: "Booking Confirmed",
          defaultBody: "Hi {{firstName}}, your total is {{madeUpToken}}.",
        },
      },
      APPROVED_EMAIL_TEMPLATE_TOKEN_SET,
    );

    expect(findings).toEqual([
      {
        key: "booking-confirmed",
        field: "defaultBody",
        detail: "madeUpToken",
      },
    ]);
  });
});

describe("#2268 guard 3 — every supplied override token is approved", () => {
  it("finds none in the shipped registry", () => {
    expect(
      findUnapprovedSuppliedTokens(
        EXTRA_TEMPLATE_TOKENS,
        APPROVED_EMAIL_TEMPLATE_TOKEN_SET,
      ),
    ).toEqual([]);
  });

  it("fails on the {{promoAdjustment}} shape: supplied and allowed, but unusable", () => {
    // Correctly computed, passed to the renderer, allowed for the template —
    // and still rejected by the editor's own validator as an unknown token, so
    // no admin could ever put it in a body. That was the #2267 bug.
    const findings = findUnapprovedSuppliedTokens(
      { "booking-confirmed": ["subtotal", "neverApprovedToken"] },
      APPROVED_EMAIL_TEMPLATE_TOKEN_SET,
    );

    expect(findings).toEqual([
      {
        key: "booking-confirmed",
        field: "defaultBody",
        detail: "neverApprovedToken",
      },
    ]);
  });
});

describe("#2268 guard 4 — no dangling line when an optional value is empty", () => {
  it("finds none in the shipped defaults", () => {
    expect(
      findDanglingDefaultLines(
        DEFAULTS,
        OPTIONAL_TEMPLATE_TOKENS,
        sampleValue,
      ),
    ).toEqual([]);
  });

  it("fails on the door-code shape a bare annotation strip would have left", () => {
    const findings = findDanglingDefaultLines(
      {
        "pre-arrival-reminder": {
          defaultSubject: "Pre-arrival Information",
          defaultBody: "Check-in: {{checkIn}}\nDoor code: {{doorCode}}\n\nSee you soon.",
        },
      },
      { "pre-arrival-reminder": ["doorCode"] },
      sampleValue,
    );

    expect(findings).toEqual([
      {
        key: "pre-arrival-reminder",
        field: "defaultBody",
        detail: '"Door code:"',
      },
    ]);
  });

  it("fails on an orphaned possessive when an optional name is empty", () => {
    const findings = findDanglingDefaultLines(
      {
        "school-attendee-confirmation": {
          defaultSubject: "Confirm your attendee list",
          defaultBody: "Hi {{firstName}}, {{schoolName}}'s stay is coming up.",
        },
      },
      { "school-attendee-confirmation": ["schoolName"] },
      sampleValue,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("'s stay");
  });
});

describe("#2268 guard 5 — the optional-token contract cannot rot", () => {
  it("names only tokens that are really in the default it describes", () => {
    expect(
      findStaleOptionalTokens(DEFAULTS, OPTIONAL_TEMPLATE_TOKENS),
    ).toEqual([]);
  });

  it("fails on a declaration for a token that is no longer in the body", () => {
    const findings = findStaleOptionalTokens(
      {
        "booking-confirmed": {
          defaultSubject: "Booking Confirmed",
          defaultBody: "Hi {{firstName}}.",
        },
      },
      { "booking-confirmed": ["promoSummary"], "gone-away": ["reasonNote"] },
    );

    expect(findings).toEqual([
      {
        key: "booking-confirmed",
        field: "defaultBody",
        detail: "promoSummary",
      },
      {
        key: "gone-away",
        field: "defaultBody",
        detail: "no such registered template",
      },
    ]);
  });
});

describe("#2269 guard 6 — the empty-able override contract cannot rot either", () => {
  // EMPTYABLE_OVERRIDE_TOKENS is a SECOND hand-maintained token table, and its
  // own comment used to claim it was kept "under the same discipline as
  // OPTIONAL_TEMPLATE_TOKENS" — which guard 5 plus the registry test police,
  // and which nothing policed here. This is the discipline it now names.
  it("holds every shipped declaration to all three properties", () => {
    expect(
      findUnsupportedEmptyableTokens(
        DEFAULTS,
        EXTRA_TEMPLATE_TOKENS,
        EMPTYABLE_OVERRIDE_TOKENS,
      ),
    ).toEqual([]);
  });

  it("fails when the sender has stopped supplying a declared token", () => {
    // The failure that matters most: guard 4 would keep reporting the line as
    // conditionally empty when it is now UNCONDITIONALLY empty, which is a
    // different and worse fault that `retired_token` covers.
    const findings = findUnsupportedEmptyableTokens(
      {
        "booking-confirmed": {
          defaultSubject: "Booking Confirmed",
          defaultBody: "Hi {{firstName}}.",
        },
      },
      { "booking-confirmed": ["subtotal"] },
      { "booking-confirmed": ["subtotal", "discount"] },
    );

    expect(findings).toEqual([
      {
        key: "booking-confirmed",
        field: "defaultBody",
        detail: "discount is not supplied by this template any more",
      },
    ]);
  });

  it("fails when a declared token comes back into the default body", () => {
    // That token now belongs in OPTIONAL_TEMPLATE_TOKENS, where guard 5 keeps
    // it honest and guard 4 holds the shipped default to rendering without it.
    const findings = findUnsupportedEmptyableTokens(
      {
        "booking-confirmed": {
          defaultSubject: "Booking Confirmed",
          defaultBody: "Hi {{firstName}}.\n\nSubtotal: {{subtotal}}",
        },
      },
      { "booking-confirmed": ["subtotal"] },
      { "booking-confirmed": ["subtotal"] },
    );

    expect(findings).toEqual([
      {
        key: "booking-confirmed",
        field: "defaultBody",
        detail:
          "subtotal is back in the default body — declare it in OPTIONAL_TEMPLATE_TOKENS instead",
      },
    ]);
  });

  it("fails on a declaration for a template that does not exist", () => {
    expect(
      findUnsupportedEmptyableTokens(DEFAULTS, EXTRA_TEMPLATE_TOKENS, {
        "gone-away": ["subtotal"],
      }),
    ).toEqual([
      {
        key: "gone-away",
        field: "defaultBody",
        detail: "no such registered template",
      },
    ]);
  });
});

describe("#2269 — the lines a removed note used to mark as conditional", () => {
  // Guard 4 cannot see these: it renders tokens and inspects the result, so a
  // conditional line with NO token is structurally invisible to it, and a line
  // ending in ":" is exempt as a heading. Both of the lines below are wording
  // this project shipped.
  it("names a prose line that keeps its content after the strip", () => {
    expect(
      findUnconditionalLines(
        "Hi Ada.\n\nPayment has been processed successfully. [only when the booking is already paid]\n\nSee you soon.",
      ),
    ).toEqual(["Payment has been processed successfully."]);
  });

  it("names a heading line, which guard 4 exempts by design", () => {
    expect(
      findUnconditionalLines("Your arrival day chores: [only when chores exist]"),
    ).toEqual(["Your arrival day chores:"]);
  });

  it("says nothing about a note that had the whole line to itself", () => {
    // The strip takes that line away, so nothing new is sent.
    expect(
      findUnconditionalLines(
        "Door code: {{doorCode}}\n[only when a door code is set]\n\nSee you soon.",
      ),
    ).toEqual([]);
  });

  it("says nothing about wording that carries no shipped note at all", () => {
    expect(
      findUnconditionalLines(
        "Ring the bell [whenever you arrive after 8pm].\nRing the lodge [when you are 30 minutes away].",
      ),
    ).toEqual([]);
  });

  it("reports each distinct line once however often it appeared", () => {
    expect(
      findUnconditionalLines(
        "Open Xero object [only when xeroObjectUrl exists]\nOpen Xero object [only when xeroObjectUrl exists]",
      ),
    ).toEqual(["Open Xero object"]);
  });
});

describe("#2268 — the swept defaults still validate and still re-save", () => {
  it("keeps every shipped default acceptable to the admin editor's validator", () => {
    const invalid = EMAIL_TEMPLATE_DEFINITIONS.filter(
      (definition) =>
        !validateEmailTemplateContent({
          templateName: definition.key,
          subject: definition.defaultSubject,
          bodyText: definition.defaultBody,
        }).valid,
    ).map((definition) => definition.key);

    expect(invalid).toEqual([]);
  });

  it("keeps a pre-#2268 override that uses the raw optional token valid", () => {
    // The whole point of leaving the raw values supplied: an admin who saved
    // "Door code: {{doorCode}}" before the sweep must not have their template
    // become unsaveable — including the required-token rule, which now names
    // {{doorCodeNote}} for pre-arrival-reminder.
    //
    // {{outstandingAdditionalNote}} rides along because #2350 pinned it on the
    // same template (it is the only place a pre-arrival reminder says money is
    // still owed). This case is about the door-code SWAP, so the fixture
    // carries the unrelated pin rather than letting it mask the swap.
    const validation = validateEmailTemplateContent({
      templateName: "pre-arrival-reminder",
      subject: "Pre-arrival Information",
      bodyText:
        "Hi {{firstName}}.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{outstandingAdditionalNote}}\n\nDoor code: {{doorCode}}",
    });

    expect(validation.valid).toBe(true);
    expect(validation.missingRequiredTokens).toEqual([]);
  });

  it("accepts the new pre-composed token for the same required rule", () => {
    const validation = validateEmailTemplateContent({
      templateName: "pre-arrival-reminder",
      subject: "Pre-arrival Information",
      bodyText:
        "Hi {{firstName}}.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\n{{outstandingAdditionalNote}}\n\n{{doorCodeNote}}",
    });

    expect(validation.valid).toBe(true);
    expect(validation.missingRequiredTokens).toEqual([]);
  });

  it.each([
    ["membership-cancellation-approved", "adminNote"],
    ["booking-review-rejected", "adminNotes"],
    ["admin-new-booking", "reviewReason"],
    ["admin-refund-request", "requestedAmount"],
    ["split-guest-portion-cancelled", "bookingReference"],
    ["membership-payment-recorded", "amount"],
    ["admin-duplicate-capture-refund", "errorMessage"],
  ])("keeps %s's raw {{%s}} usable in an override", (key, token) => {
    const definition = getEmailTemplateDefinition(key);
    if (!definition) throw new Error(`missing definition for ${key}`);
    expect(definition.allowedTokens).toContain(token);
    expect(APPROVED_EMAIL_TEMPLATE_TOKEN_SET.has(token)).toBe(true);
  });

  it("no longer registers the dead credit-applied-to-booking template", () => {
    // Registered and admin-editable, but with no send site anywhere in src/ —
    // an admin could carefully word an email that was never sent (#2268).
    expect(getEmailTemplateDefinition("credit-applied-to-booking")).toBeUndefined();
  });
});

// #2321 — refund-request-resolved was ONE registered template serving BOTH
// outcomes, with a default body that said "approved" and a sentence reading
// "A refund of {{amount}} will be processed" that the declined send fed an
// empty string. The HTML path always branched correctly, so only a club that
// had saved an override was affected — but that club told declined members
// their appeal had been approved. It is now one template per outcome, and the
// declined template has no {{amount}} on its surface at all.
describe("#2321 refund-appeal outcome templates", () => {
  // Affirmative approval wording only — "was not approved at this time" is the
  // declined template's own correct copy, so a bare "approved" would be a
  // false positive.
  const APPROVAL_WORDING = [
    "has been approved",
    "Appeal Approved",
    "A refund of",
    "will be processed",
    "original payment method",
  ];

  it("registers one template per outcome and retires the combined one", () => {
    expect(getEmailTemplateDefinition("refund-request-approved")).toBeDefined();
    expect(getEmailTemplateDefinition("refund-request-declined")).toBeDefined();
    expect(getEmailTemplateDefinition("refund-request-resolved")).toBeUndefined();
  });

  it("never lets approval wording reach a declined member", () => {
    const declined = getEmailTemplateDefinition("refund-request-declined");
    if (!declined) throw new Error("missing refund-request-declined");

    // Rendered end to end, both with an admin note and without one.
    for (const adminNotesLine of ["Notes: Outside the refund window.\n\n", ""]) {
      const rendered = renderTemplateString(declined.defaultBody, {
        ...declined.sampleData,
        adminNotesLine,
      });
      const subject = renderTemplateString(
        declined.defaultSubject,
        declined.sampleData,
      );

      for (const phrase of APPROVAL_WORDING) {
        expect(rendered, `declined body contains "${phrase}"`).not.toContain(
          phrase,
        );
        expect(subject, `declined subject contains "${phrase}"`).not.toContain(
          phrase,
        );
      }
      expect(rendered).toContain("was not approved at this time");
      // The empty-amount sentence that started this: no money figure, and no
      // line that trails off, on either shape.
      expect(rendered).not.toMatch(/\$/);
      for (const line of rendered.split("\n")) {
        expect(line.trimEnd()).not.toMatch(/[-:–—]$/);
      }
    }
  });

  it("gives the declined template no {{amount}} surface to reach for", () => {
    const declined = getEmailTemplateDefinition("refund-request-declined");
    if (!declined) throw new Error("missing refund-request-declined");

    // Not allowed, so an override that writes {{amount}} is refused at SAVE
    // time rather than rendering "A refund of  will be processed".
    expect(declined.allowedTokens).not.toContain("amount");
    const validation = validateEmailTemplateContent({
      templateName: "refund-request-declined",
      subject: "Refund Appeal Update",
      bodyText: "Hi {{firstName}}, a refund of {{amount}} is on its way.",
    });
    expect(validation.valid).toBe(false);
    expect(validation.disallowedTokens).toContain("amount");
  });

  it("still renders the approved outcome with its money figure", () => {
    const approved = getEmailTemplateDefinition("refund-request-approved");
    if (!approved) throw new Error("missing refund-request-approved");

    expect(approved.allowedTokens).toContain("amount");
    const rendered = renderTemplateString(
      approved.defaultBody,
      approved.sampleData,
    );
    expect(rendered).toContain("has been approved");
    expect(rendered).toContain("A refund of $123.45");
    for (const line of rendered.split("\n")) {
      expect(line.trimEnd()).not.toMatch(/[-:–—]$/);
    }
  });

  it("keeps both outcomes member-audience and withholdable by the booking switch", () => {
    // Fail-closed: both are member-facing mail about a booking, so the
    // per-booking "No emails" switch must still be able to withhold them and
    // the retry cron must still refuse to replay a NULL-bookingId row.
    for (const key of [
      "refund-request-approved",
      "refund-request-declined",
    ] as const) {
      const definition = getEmailTemplateDefinition(key);
      if (!definition) throw new Error(`missing ${key}`);
      expect(definition.audience).toBe("member");
      expect(isBookingSuppressibleTemplate(key)).toBe(true);
      expect(ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES.has(key)).toBe(true);
    }
    // The RETIRED combined name stays in the set on purpose: the set's whole
    // job is the NULL-bookingId legacy window, and a fork jumping several
    // releases in one deploy can still hold pre-#2258 FAILED rows queued under
    // the old name with no bookingId at all. Membership here is what makes the
    // retry cron (cron-email-retry.ts) refuse to replay those rows blind — the
    // fail-closed audience gate in isBookingSuppressibleTemplate never sees
    // them, because it only runs when a caller supplies a real bookingId. No
    // live sender uses the name, so the entry can never withhold current mail.
    expect(
      ALWAYS_BOOKING_SCOPED_TEMPLATE_NAMES.has("refund-request-resolved"),
    ).toBe(true);
  });
});

// #2320 review (LOW-6): guard 4 only exercises tokens DECLARED in
// OPTIONAL_TEMPLATE_TOKENS — an optional a sender supplies but nobody declares
// renders with its non-empty preview sample and is invisible to the guard. Pin
// the two declarations that were live-but-undeclared when the review found
// them, so removing either turns guard 4 back off for a token whose sender
// really does supply "".
describe("#2320 review — live optional tokens are declared", () => {
  it.each([
    // sendBookingCancelledEmail composes "" when no applied credit was restored.
    ["booking-cancelled", "creditRestoredMessage"],
    // sendBookingConfirmedEmail composes "" for a lodge with no door code.
    ["booking-confirmed", "doorCodeNote"],
    // Fork #35: sendBookingConfirmedEmail composes "" when the recipient's
    // booking-link authority denies the id in outbound mail, or link building
    // fails.
    ["booking-confirmed", "ical"],
  ])("declares %s's optional {{%s}}", (key, token) => {
    expect(OPTIONAL_TEMPLATE_TOKENS[key]).toContain(token);
  });
});
