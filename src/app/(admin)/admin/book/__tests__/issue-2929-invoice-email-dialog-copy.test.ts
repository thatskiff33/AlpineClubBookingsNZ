// #2929 — the email-choice dialog may only promise an invoice on a create that
// actually raises one.
//
// WHY THIS MATTERS ENOUGH TO PIN. The dialog now tells the officer that choosing
// not to email "also stops Xero emailing the invoice … The invoice is still
// created, and you can send it from Xero later." That is a POSITIVE PROMISE
// ABOUT AN ARTEFACT, not a claim about an email, and it is only true on the
// Internet Banking path — `createConfirmedBooking` enqueues the booking invoice
// for `paymentMethod === "internet_banking"` and nowhere else. Left
// unconditional it is false in three ordinary situations:
//
//   - the officer picked Card, so no invoice is raised;
//   - the club has Internet Banking switched off, so the payment-method card
//     never renders, EVERY create here is a card create, and the sentence is
//     wrong on every booking that club makes. `/api/payments/options` enables
//     that module only when `xeroIntegration` is on as well, so this is also the
//     club with Xero off entirely, where the create skips the enqueue outright;
//   - the booking is fully covered by credit, so `remainingToPay` is 0, the card
//     never renders, and there is nothing to invoice.
//
// The officer then goes looking in Xero for an invoice that does not exist.
//
// WHY A SOURCE-TEXT CONTRACT AND NOT A RENDER TEST. Same reasoning as
// `issue-2779-save-as-draft-explainer.test.ts`, which pins the neighbouring
// branch in this same file: the wizard is a large client component owning member
// search, a quote round-trip, capacity, promos, credit and two confirm dialogs.
// Standing all of that up tests the mocks. What has to be true here is that one
// sentence sits behind the same discriminator the POST sends.
//
// Comments are stripped before matching, so the paragraph explaining the gate
// can never stand in for the gate.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

const PAGE = "src/app/(admin)/admin/book/page.tsx";

function readPageSource(): string {
  // Test helper: a fixed repo file under process.cwd(), not user input.
  return readFileSync(path.resolve(process.cwd(), PAGE), "utf8");
}

/**
 * Collapse runs of whitespace. JSX prose is wrapped by the formatter at whatever
 * column the surrounding indentation leaves, so matching raw text would fail on
 * a reindent that changed no words.
 */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("#2929 the email-choice dialog's invoice promise", () => {
  const source = stripComments(readPageSource());
  const flat = flatten(source);

  it("is written ONCE and behind a gate, never inline in either wording", () => {
    // The promise itself must not appear as literal prose inside either branch
    // of the dialog description; it lives in one gated value.
    const inlineOccurrences = flat.split("stops Xero emailing").length - 1;
    expect(
      inlineOccurrences,
      "the invoice sentence must be written once, not repeated in both dialog wordings",
    ).toBe(1);
  });

  it("gates the promise on the SAME discriminator the create keys its enqueue on", () => {
    // The gate: Internet Banking chosen, on a create where that choice is even
    // offered. `showPaymentMethodChoice` already folds in "the module is on"
    // (which implies the Xero integration is on) and "there is something left to
    // pay after credit".
    expect(
      flat,
      'the invoice promise must be gated on showPaymentMethodChoice && paymentMethod === "internet_banking"',
    ).toContain(
      'const createRaisesXeroInvoice = showPaymentMethodChoice && paymentMethod === "internet_banking";',
    );

    // And that gate must be what decides whether the sentence renders at all.
    const gateIndex = flat.indexOf("createRaisesXeroInvoice ? (");
    const sentenceIndex = flat.indexOf("stops Xero emailing");
    expect(
      gateIndex,
      "the sentence must hang off a conditional, not be rendered unconditionally",
    ).toBeGreaterThan(-1);
    expect(sentenceIndex).toBeGreaterThan(gateIndex);
  });

  it("uses the same condition the POST body uses to ask for Internet Banking", () => {
    // If these two ever diverge the dialog describes one payment path while the
    // request asks for another.
    expect(flat).toContain(
      'showPaymentMethodChoice && paymentMethod === "internet_banking"',
    );
  });

  it("still states the choice is audited in both wordings, gated or not", () => {
    // The audit sentence is unconditional and true on every path; only the
    // invoice half moved behind the gate.
    const auditOccurrences =
      flat.split("your choice is recorded in the audit log").length - 1;
    expect(auditOccurrences).toBe(2);
  });
});
