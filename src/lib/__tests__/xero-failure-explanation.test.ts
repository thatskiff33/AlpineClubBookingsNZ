import { describe, expect, it } from "vitest";
import { CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE } from "@/lib/xero-credit-note-spent-outside-app";
import { explainXeroFailure, type XeroFailureKind } from "@/lib/xero-failure-explanation";
import { XERO_ORPHANED_STALE_RUNNING_ERROR_CODE } from "@/lib/xero-stale-operations";

function xeroBody(message: string): string {
  return JSON.stringify({
    response: { body: { Type: "ValidationException", Message: "A validation exception occurred", Elements: [{ ValidationErrors: [{ Message: message }] }] } },
  });
}

describe("explainXeroFailure: known Xero wording", () => {
  const cases: Array<{
    label: string;
    code: string | null;
    message: string;
    entityType?: string;
    kind: XeroFailureKind;
  }> = [
    {
      label: "daily limit",
      code: "429",
      message: "Xero daily API limit reached. Retry after 4140 seconds.",
      entityType: "INVOICE",
      kind: "DAILY_LIMIT",
    },
    {
      label: "invoice already paid off",
      code: "400",
      message: xeroBody("Invoice not of valid status for modification: this document has already been paid off"),
      kind: "INVOICE_ALREADY_PAID",
    },
    {
      label: "credit note over-allocation",
      code: "400",
      message: xeroBody("Credit Note cannot be allocated as the allocation amount is greater than the amount remaining on the Credit Note"),
      entityType: "ALLOCATION",
      kind: "CREDIT_TOO_LOW",
    },
    {
      label: "duplicate contact name",
      code: "400",
      message: xeroBody("The contact name Pat Example is already assigned to another contact. The contact name must be unique across all active contacts."),
      kind: "DUPLICATE_CONTACT",
    },
    {
      label: "no linked invoice",
      code: "NO_INVOICE",
      message: "No Xero invoice linked to payment 123",
      entityType: "PAYMENT",
      kind: "NO_LINKED_INVOICE",
    },
    {
      label: "idempotency key reused",
      code: "400",
      message: "The Idempotency-Key was already used for a different request",
      kind: "REQUEST_KEY_REUSED",
    },
    {
      label: "stale running",
      code: "ANY",
      message: "Operation was stuck running past the staleness threshold and was reset",
      kind: "LOST_TRACK",
    },
    {
      label: "period locked",
      code: "400",
      message: xeroBody("The document date cannot be before the lock date"),
      kind: "PERIOD_LOCKED",
    },
    {
      label: "account code",
      code: "400",
      message: xeroBody("Account code '200' is archived or not valid"),
      kind: "ACCOUNT_CODE",
    },
    {
      label: "contact archived",
      code: "400",
      message: xeroBody("The contact is archived and cannot be used"),
      kind: "CONTACT_ARCHIVED",
    },
    {
      label: "record voided",
      code: "400",
      message: xeroBody("This invoice has been voided"),
      entityType: "INVOICE",
      kind: "RECORD_VOIDED",
    },
    {
      label: "timed out",
      code: "ETIMEDOUT",
      message: "request to https://api.xero.com failed, reason: connect ETIMEDOUT",
      kind: "TIMED_OUT",
    },
    {
      label: "rate limit wording without a status",
      code: null,
      message: "Too many requests, slow down",
      kind: "RATE_LIMITED",
    },
  ];

  for (const c of cases) {
    it(`explains ${c.label} as ${c.kind}`, () => {
      const result = explainXeroFailure({ code: c.code, message: c.message, entityType: c.entityType });
      expect(result.kind).toBe(c.kind);
      expect(result.headline.length).toBeGreaterThan(10);
      expect(result.whatItMeans.length).toBeGreaterThan(10);
      expect(result.nextStep.length).toBeGreaterThan(10);
      expect(result.technicalDetail).toContain(c.message.slice(0, 40));
    });
  }

  it("reads Xero's sentence from the end of a long stored dump, and prefers the paid-off cause", () => {
    // Stored 400s echo the request first (about 2,900 characters) and Xero's sentences come last.
    const echo = JSON.stringify({ Elements: [{ Note: "n".repeat(5000) }] });
    const message = `{"response":{"statusCode":400,"body":${echo.slice(0, -1)},"ValidationErrors":[{"Message":"Credit Note cannot be allocated as amount is greater than amount outstanding"},{"Message":"The invoice you are trying to allocate to has already been paid off"}]}}}`;
    const result = explainXeroFailure({ code: "400", message, entityType: "ALLOCATION" });
    expect(result.kind).toBe("INVOICE_ALREADY_PAID");
  });

  it("recognises the amount-outstanding wording of an over-allocation", () => {
    const result = explainXeroFailure({
      code: "400",
      message: xeroBody("Credit Note cannot be allocated as amount is greater than amount outstanding"),
    });
    expect(result.kind).toBe("CREDIT_TOO_LOW");
  });

  it("gives the daily limit wait in rounded words", () => {
    const at = (s: number) =>
      explainXeroFailure({ code: "429", message: `Xero daily API limit reached. Retry after ${s} seconds.` }).whatItMeans;
    expect(at(30)).toContain("about a minute");
    expect(at(1080)).toContain("about 18 minutes");
    expect(at(14400)).toContain("about 4 hours");
    expect(explainXeroFailure({ code: "429", message: "Xero daily API limit reached." }).whatItMeans).toContain(
      "until Xero allows requests again",
    );
  });

  it("uses the record noun for the entity type, and a neutral one when unknown", () => {
    const msg = "Xero daily API limit reached. Retry after 60 seconds.";
    expect(explainXeroFailure({ code: "429", message: msg, entityType: "CREDIT_NOTE" }).whatItMeans).toContain("credit note");
    expect(explainXeroFailure({ code: "429", message: msg, entityType: "SOMETHING_NEW" }).whatItMeans).toContain("record");
    expect(explainXeroFailure({ code: "429", message: msg }).whatItMeans).toContain("record");
  });

  it("never repeats the contact name Xero echoed in the plain text", () => {
    const result = explainXeroFailure({
      code: "400",
      message: xeroBody("The contact name Pat Example is already assigned to another contact."),
    });
    const plain = [result.headline, result.whatItMeans, result.nextStep].join(" ");
    expect(plain).not.toContain("Pat Example");
    expect(result.technicalDetail).toContain("Pat Example");
  });
});

describe("explainXeroFailure: codes the app names itself", () => {
  it("explains a credit note spent outside the app", () => {
    const result = explainXeroFailure({ code: CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE, message: "anything", entityType: "ALLOCATION" });
    expect(result.kind).toBe("CREDIT_TOO_LOW");
    expect(result.nextStep).toContain("by itself");
  });

  it("explains an orphaned stale running row whatever its message", () => {
    const result = explainXeroFailure({ code: XERO_ORPHANED_STALE_RUNNING_ERROR_CODE, message: null, entityType: "INVOICE" });
    expect(result.kind).toBe("LOST_TRACK");
    expect(result.nextStep).toContain("invoice");
  });
});

describe("explainXeroFailure: fallbacks", () => {
  it("says the detail is hidden for a blank or fully redacted message", () => {
    for (const message of [null, undefined, "", "   ", "[REDACTED]", "400: [REDACTED]"]) {
      expect(explainXeroFailure({ code: "400", message }).kind).toBe("DETAIL_HIDDEN");
    }
  });

  it("falls back to the HTTP status when the wording is not recognised", () => {
    const kind = (code: string) => explainXeroFailure({ code, message: "something odd" }).kind;
    expect(kind("401")).toBe("NOT_CONNECTED");
    expect(kind("403")).toBe("NOT_CONNECTED");
    expect(kind("404")).toBe("NOT_FOUND");
    expect(kind("429")).toBe("RATE_LIMITED");
    expect(kind("500")).toBe("XERO_DOWN");
    expect(kind("503")).toBe("XERO_DOWN");
    expect(kind("422")).toBe("XERO_REJECTED");
  });

  it("quotes what Xero said for an unrecognised 4xx, from the readable field only", () => {
    const result = explainXeroFailure({ code: "400", message: xeroBody("Some brand new complaint") });
    expect(result.kind).toBe("XERO_REJECTED");
    expect(result.whatItMeans).toBe("Xero said: “Some brand new complaint”");
  });

  it("is generic, not blank, for an unknown shape with no status", () => {
    const result = explainXeroFailure({ code: "WEIRD", message: "{\"response\":{}}" });
    expect(result.kind).toBe("UNKNOWN");
    expect(result.whatItMeans).toContain("could not read a reason");
  });

  it("quotes an unknown plain-text message only after redacting and clipping it", () => {
    const long = `Unexpected ${"x".repeat(400)}`;
    const result = explainXeroFailure({ code: "WEIRD", message: long });
    expect(result.kind).toBe("UNKNOWN");
    const quoted = /“(.*)”/.exec(result.whatItMeans)?.[1] ?? "";
    expect(quoted.length).toBeLessThanOrEqual(200);
    expect(quoted.endsWith("…")).toBe(true);

    const email = explainXeroFailure({ code: "WEIRD", message: "Failed for someone@example.com today" });
    expect(email.whatItMeans).not.toContain("someone@example.com");
  });

  it("ignores generic Xero titles when looking for a cause", () => {
    const result = explainXeroFailure({
      code: "400",
      message: JSON.stringify({ response: { body: { Message: "A validation exception occurred" } } }),
    });
    expect(result.kind).toBe("XERO_REJECTED");
    expect(result.whatItMeans).toBe("Xero did not give a reason the app could read.");
  });

  it("keeps the stored code and message unchanged in the technical detail", () => {
    expect(explainXeroFailure({ code: "500", message: "boom" }).technicalDetail).toBe("500: boom");
    expect(explainXeroFailure({ code: null, message: null }).technicalDetail).toBe("No detail was recorded.");
  });

  it("never throws and never returns blank text, whatever it is given", () => {
    const awkward: unknown[] = [
      "\u0000",
      "{",
      '{"Message":"unterminated',
      '"Message":"\\u12"',
      "x".repeat(100_000),
      '{"Message": "' + "\\".repeat(5001) + '"}',
      "🙂".repeat(1000),
      "null",
      "[]",
    ];
    for (const message of awkward) {
      for (const code of [null, "", "400", "500", "NOT_A_CODE", "9999"]) {
        const result = explainXeroFailure({ code, message: message as string });
        expect(result.headline.trim()).not.toBe("");
        expect(result.whatItMeans.trim()).not.toBe("");
        expect(result.nextStep.trim()).not.toBe("");
        expect(result.technicalDetail.trim()).not.toBe("");
      }
    }
    // Non-string inputs from a hand-edited row must not throw either.
    expect(() => explainXeroFailure({ code: 400 as unknown as string, message: { a: 1 } as unknown as string })).not.toThrow();
  });
});
