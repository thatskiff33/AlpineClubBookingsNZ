import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { bookingAmountOwedCents, bookingWorthCents, savedCardChargeCents } from "@/lib/booking-payment-state";

/**
 * #3750 (owner decision, 7 Oct 2026, "Add fee to amount owed"): what an unpaid
 * booking owes is its price PLUS the change fee recorded on its payment, less
 * applied credit — and every pay step reads that from ONE home,
 * `bookingAmountOwedCents` / `bookingWorthCents`. A surface that still
 * subtracted credit from the bare price would ask for less than the booking
 * owes, and a settle that compared against the bare price would refuse the
 * payment that did collect the fee.
 *
 * Four shapes, read as text with comments stripped (#3955 review F6):
 *  - over every non-test file under `src/`, by walk: a final price less
 *    anything named for credit, under ANY name and either case
 *    (`newFinalPriceCents - clamp.appliedCreditCents`,
 *    `booking.finalPriceCents -\n (await deriveBookingAppliedCreditCents(…))`);
 *  - over the pay steps: an `amountCents` set to a bare final price — an
 *    intent, a charge or a payment row sized without the recorded fee;
 *  - over every non-test file under `src/`: applied credit compared (`<`, `>`,
 *    `<=`, `>=`, either way round) with a bare final price — "does the credit
 *    cover the booking?" asked without the fee (#3955 round 5, finding 1:
 *    `appliedCreditCents + reviewGiveBacksCents < previousFinalPriceCents`);
 *  - over every non-test file under `src/`: an `amountDueCents` property set
 *    from a bare final price. It is the field the member-facing emails that
 *    quote what is owed take (the exception-approved email, the pay-link
 *    emails), so a bare price there tells a member to pay less than the page
 *    asks (#4058). `readBookingAmountOwed` is the one reader. (`priceCents`
 *    on those emails is the booking's PRICE and stays one.)
 *  - over every file that calls one of those senders: each `amountDueCents`
 *    property, shorthand included, reads `readBookingAmountOwed` or is pinned
 *    by its text with the reason it cannot owe more than the price.
 *
 * Every file that resolves a booking narrative reads what is owed through
 * `readBookingAmountOwed` (`booking-amount-owed.ts`, the one read of the figure
 * with its ledger credit, #3991), and none may hand it a bare price as
 * `dueCents`; the booking page's figures themselves are pinned by
 * `booking-detail-history-amount-owed.test.ts`.
 *
 * WHAT THIS CANNOT SEE: an amount spelled another way (a sum in a different
 * order, a helper of its own, a variable that holds the bare price); and a
 * narrative caller that imports the resolver under another name
 * (`import { resolveBookingNarrative as resolve }`), which the by-name walk
 * below never finds.
 */

const REPO = path.resolve(__dirname, "..", "..", "..");
const PAY_STEPS = [
  "src/app/api/payments/create-payment-intent/route.ts",
  "src/app/api/payments/switch-to-internet-banking/route.ts",
  "src/app/(authenticated)/bookings/[id]/_lib/booking-detail-payment.ts",
  "src/app/api/bookings/[id]/confirm-payment/route.ts",
  "src/lib/stripe-webhook-service.ts",
  "src/lib/payment-reconciliation.ts",
  "src/lib/manual-booking-payment-state.ts",
  // #3955 review F1-F3: the edit lifecycle's credit clamp and $0 decision, the
  // date-only edit's, the payment link's intent, the saved-card charge and the
  // organiser's group total.
  "src/lib/booking-modify-settlement.ts",
  "src/lib/booking-date-modification-service.ts",
  "src/lib/payment-link-intent.ts",
  "src/lib/cron-confirm-pending.ts",
  "src/lib/group-settlement-invoice-binding.ts",
  // #4357: the charge-saved-method route and the officer's confirm-pending-guests
  // route, which charge what the cron does.
  "src/app/api/payments/charge-saved-method/route.ts",
  "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts",
  // #3955 round 3: the public pay page's amount, which its intent charges.
  // #4058: it reads `readBookingAmountOwed`, the one reader the pay-link emails
  // share, so the page and the email agree.
  "src/lib/payment-link-context.ts",
  // #4058: not a pay step, but the email that tells a member what to pay once an
  // exception is approved - it must quote what the pay step will ask for.
  "src/lib/booking-exception-approval.ts",
  // #3991: the booking page's history narrative, which quotes the amount due,
  // and the one read every surface here shares.
  "src/app/(authenticated)/bookings/[id]/_lib/booking-detail-history.ts",
  "src/lib/booking-amount-owed.ts",
];
const ONE_HOME_READ = "src/lib/booking-amount-owed.ts";
// #3991, #4058: the surfaces that read what is owed ONLY through the one read —
// what they quote and what they charge cannot part.
const ONE_READ_USERS = [
  "src/app/(authenticated)/bookings/[id]/_lib/booking-detail-history.ts",
  "src/lib/payment-link-context.ts",
  "src/lib/payment-link-intent.ts",
  "src/app/api/payments/create-payment-intent/route.ts",
  // #4058: the emails that quote what is owed, read through the same helper.
  "src/lib/booking-exception-approval.ts",
  "src/lib/cron-confirm-pending.ts",
  "src/lib/payment-link-reissue.ts",
  "src/lib/payment-link-split-guest.ts",
  // #4944: the member dashboard's Payment Owed card.
  "src/lib/member-dashboard.ts",
];
// The files that still compose it themselves, named in `booking-amount-owed.ts`.
const KNOWN_COMPOSERS = [
  "src/app/api/bookings/[id]/confirm-payment/route.ts",
  "src/app/api/payments/switch-to-internet-banking/route.ts",
  "src/lib/stripe-webhook-service.ts",
  "src/lib/manual-booking-payment-state.ts",
  "src/lib/payment-reconciliation.ts",
  "src/lib/booking-modify-settlement.ts",
  "src/lib/booking-date-modification-service.ts",
  "src/lib/booking-credit-election.ts",
  "src/lib/edit-financial-review-account-credit.ts",
  "src/lib/policies/booking-route-decisions.ts",
];
// Reading the one home: the two helpers, the one read built on them (#3991),
// or the saved-card figure built on worth (#4357).
const READS_ONE_HOME = /\b(?:booking(?:AmountOwed|Worth)Cents|readBookingAmountOwed|savedCardChargeCents)\(/;
// #4357: every door that makes a saved-card charge attempt durable, and so
// charges the saved card, found by its call to the attempt writer.
const ATTEMPT_WRITER_HOME = "src/lib/saved-card-charge-attempt.ts";
const SAVED_CARD_DOORS = [
  "src/lib/cron-confirm-pending.ts",
  "src/app/api/payments/charge-saved-method/route.ts",
  "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts",
];
// A final price, then a minus, then — within the same expression — anything
// named for credit or for what is already applied (#3955 round 3:
// `verifiedFinalPriceCents - alreadyAppliedCents`). `[^;,{}]` keeps it inside
// one expression across lines.
const BARE_PRICE_LESS_CREDIT = /[\w.?!]*[Ff]inalPriceCents\s*-\s*[^;,{}]{0,120}?(?:[Cc]redit|[Aa]pplied)\w*/g;
// Credit (or what is applied) compared with a bare final price, either way
// round, within one expression. `(?<![=-])` keeps arrows (`=>`, `->`) out, and
// a price followed by `+` is a sum, not a bare price.
const CREDIT_VS_BARE_PRICE =
  /(?:[Cc]redit|[Aa]pplied)\w*[^;,{}()]{0,80}?(?<![=-])[<>]=?(?!=)\s*[\w.?!]*[Ff]inalPriceCents\b(?!\s*\+)|[\w.?!]*[Ff]inalPriceCents\s*[<>]=?(?!=)[^;,{}]{0,80}?(?:[Cc]redit|[Aa]pplied)\w*/g;
// An intent, charge or payment amount that is a bare final price, in a pay step.
const BARE_PRICE_AMOUNT = /\bamountCents:\s*[\w.?!]*[Ff]inalPriceCents\b(?!\s*[-+])/;
// #3991: the narrative's figures (`amountOwed.owedCents` / `.dueCents`) set to
// a bare price.
const BARE_PRICE_DUE = /\b(?:owed|due)Cents:\s*[\w.?!]*[Ff]inalPriceCents\b(?!\s*[-+])/;

// An email's amount-due field set from a bare final price (#4058).
const BARE_PRICE_QUOTED = /\bamountDueCents:\s*[^,;}]*[Ff]inalPriceCents\b/g;
// A pay-link or exception-approved email send, and the `amountDueCents` property
// inside it, shorthand (`amountDueCents,`) included - a type position
// (`amountDueCents: number`) and a read (`params.amountDueCents`) are not one.
const QUOTING_SENDER =
  /\bsend(?:BookingRequestApproved|SplitGuestPaymentLink|BookingPolicyExceptionApproved)Email\(/;
const DUE_PROPERTY = /(?<![.\w])amountDueCents\b(?!\s*\??:\s*number\b)(?:\s*:\s*([^,;}]*))?/g;

/**
 * The exact expressions allowed to stay, each pinned by its text (whitespace
 * collapsed) rather than its file, so a new subtraction in the same file is
 * still caught (#3955 round 3, finding 8).
 *
 * The member's edit PREVIEW, not a pay step: each shows what an edit's quote
 * leaves to pay against the credit an election would use, from figures the
 * quote returns (its own fee on its own row). Nothing is charged from them —
 * the pay step reads the one home — and a fee recorded on an unpaid booking's
 * payment comes from an officer's finished-stay correction, on a stay no
 * member can edit.
 */
const ALLOWED_EXPRESSIONS: Readonly<Record<string, readonly string[]>> = {
  "src/components/edit-booking/price-summary-card.tsx": [
    "quote.newFinalPriceCents - displayedAppliedCreditCents",
  ],
  "src/components/edit-booking-panel.tsx": ["quoteFinalPriceCents - ledgerAppliedCreditCents"],
};

/**
 * The comparisons allowed to stay, pinned the same way.
 *
 * The shared credit-application policy at booking creation and election: its
 * `finalPriceCents` parameter is the ceiling the caller hands it. A new booking
 * has no Payment row, so no fee can be recorded on it, and the election hands
 * it what is owed through `bookingAmountOwedCents` (fee included).
 */
const ALLOWED_COMPARISONS: Readonly<Record<string, readonly string[]>> = {
  "src/lib/policies/booking-route-decisions.ts": ["CreditCents > finalPriceCents"],
};

/**
 * The amount-due properties on a quoting send that may read something other
 * than `readBookingAmountOwed`, pinned by text (#4058). Both send the pay link
 * of a booking created a moment before: its Payment row is new (no recorded
 * change fee) and no credit election has reached it, so what it owes is its
 * price. A held request booking is still AWAITING_REVIEW, which holds no credit.
 */
const ALLOWED_DUE_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  "src/lib/booking-request.ts": ["amountDueCents: priceCents"],
  "src/lib/group-booking.ts": ["amountDueCents: priceCents"],
};

const matchesIn = (text: string) =>
  [...text.matchAll(BARE_PRICE_LESS_CREDIT)].map((match) => match[0].replace(/\s+/g, " "));
const quotesIn = (text: string) =>
  [...text.matchAll(BARE_PRICE_QUOTED)].map((match) => match[0].replace(/\s+/g, " "));
const duePropertiesIn = (text: string) =>
  [...text.matchAll(DUE_PROPERTY)]
    // The floored `dueCents`, never `owedCents`, which goes negative when credit exceeds the price.
    .filter((match) => !/readBookingAmountOwed\([^)]*\)\)\.dueCents\b/.test(match[1] ?? ""))
    .map((match) => match[0].replace(/\s+/g, " ").trim());
const comparisonsIn = (text: string) =>
  [...text.matchAll(CREDIT_VS_BARE_PRICE)].map((match) => match[0].replace(/\s+/g, " "));

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") sourceFiles(full, found);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(path.relative(REPO, full).split(path.sep).join("/"));
    }
  }
  return found;
}
const read = (file: string) => stripComments(fs.readFileSync(path.join(REPO, file), "utf8"));

describe("the amount an unpaid booking owes has one home (#3750)", () => {
  it("adds the recorded change fee to the price, then takes off applied credit", () => {
    expect(bookingWorthCents({ finalPriceCents: 10_000, changeFeeCents: 2_500 })).toBe(12_500);
    expect(bookingWorthCents({ finalPriceCents: 10_000, changeFeeCents: null })).toBe(10_000);
    expect(
      bookingAmountOwedCents({ finalPriceCents: 10_000, changeFeeCents: 2_500, appliedCreditCents: 3_000 }),
    ).toBe(9_500);
  });

  it("every pay step reads it there", () => {
    for (const file of PAY_STEPS) {
      expect(read(file), file).toMatch(READS_ONE_HOME);
    }
    // The one read is itself built on the one home, with the ledger credit.
    expect(read(ONE_HOME_READ)).toMatch(/\bbookingAmountOwedCents\(/);
    expect(read(ONE_HOME_READ)).toMatch(/\bderiveBookingAppliedCreditCents\(/);
  });

  it("the one read's users take credit and the owed figure from it alone (#3991)", () => {
    for (const file of ONE_READ_USERS) {
      const text = read(file);
      expect(text, file).toMatch(/\breadBookingAmountOwed\(/);
      expect(text, `${file} composes its own figure`).not.toMatch(
        /\b(?:bookingAmountOwedCents|deriveBookingAppliedCreditCents)\(/,
      );
    }
  });

  it("every other composer of the owed figure is a known one (#3991)", () => {
    const composers = sourceFiles(path.join(REPO, "src"))
      .filter((file) => /\bbookingAmountOwedCents\(/.test(read(file)))
      .filter((file) => file !== ONE_HOME_READ && file !== "src/lib/booking-payment-state.ts");
    expect(composers.sort(), "INV-PAY-119: read it through readBookingAmountOwed, or list it in booking-amount-owed.ts").toEqual(
      [...KNOWN_COMPOSERS].sort(),
    );
    // Its docblock names exactly these — no missing one, and no extra one left
    // behind once a composer moves to the one read (read raw: it is a comment).
    const docblock = fs.readFileSync(path.join(REPO, ONE_HOME_READ), "utf8");
    const paragraph = docblock.slice(
      docblock.indexOf("NOT YET EVERY READER"),
      docblock.indexOf("`amount-owed-one-home.test.ts` pins"),
    );
    const named = [...paragraph.matchAll(/`([\w./[\]-]+\.ts)`/g)].map((match) => match[1]).sort();
    const expected = KNOWN_COMPOSERS.map((file) =>
      file.split("/").slice(-2).join("/").replace(/^lib\//, ""),
    ).sort();
    expect(named, "booking-amount-owed.ts's docblock names exactly the known composers").toEqual(expected);
  });

  // #3991 review: the booking page reads ledger credit ONCE, in the history
  // loader through `readBookingAmountOwed`; nothing else on the page derives it
  // again — not the pay card's projection, not the edit panel's payload.
  it("no booking-page module derives the applied credit itself", () => {
    const pageDir = "src/app/(authenticated)/bookings/[id]";
    const pageFiles = sourceFiles(path.join(REPO, pageDir));
    for (const required of [
      `${pageDir}/_lib/booking-detail-editor-data.ts`,
      `${pageDir}/_lib/booking-detail-payment.ts`,
      `${pageDir}/_lib/booking-detail-history.ts`,
    ]) {
      expect(pageFiles, `the walk reached ${required}`).toContain(required);
    }
    const offenders = pageFiles.filter((file) => /\bderiveBookingAppliedCreditCents\(/.test(read(file)));
    expect(offenders, "INV-PAY-119: take history.amountOwed, the page's one read").toEqual([]);
  });

  it("no pay step sizes an amount at the bare price", () => {
    const offenders = PAY_STEPS.filter((file) => BARE_PRICE_AMOUNT.test(read(file))).map(
      (file) => `${file}: ${read(file).match(BARE_PRICE_AMOUNT)?.[0]}`,
    );
    expect(offenders, "INV-PAY-119: size it through bookingAmountOwedCents / bookingWorthCents").toEqual([]);
  });

  // #4357 (`INV-PAY-119`): the cron charged worth while the charge-saved-method
  // route and the officer's confirm-pending-guests route charged the bare price,
  // so a change fee recorded on an unpaid booking was left off - and the settle,
  // which admits only worth, refused it. Each door sizes its attempt from the
  // one figure, imported from its one home (a local copy fails here).
  it("every saved-card door charges the one figure, savedCardChargeCents (#4357)", () => {
    const doors = sourceFiles(path.join(REPO, "src")).filter(
      (file) => file !== ATTEMPT_WRITER_HOME && /\bbeginSavedCardChargeAttempt\(/.test(read(file)),
    );
    expect(doors.sort(), "INV-PAY-119: a new saved-card door charges savedCardChargeCents").toEqual(
      [...SAVED_CARD_DOORS].sort(),
    );
    for (const file of SAVED_CARD_DOORS) {
      const text = read(file);
      expect(text, `${file} charges savedCardChargeCents`).toMatch(/\bsavedCardChargeCents\(/);
      expect(text, `${file} imports the figure from its one home`).toMatch(
        /import\s*\{[^}]*\bsavedCardChargeCents\b[^}]*\}\s*from\s*"@\/lib\/booking-payment-state"/,
      );
      expect(text, `${file} defines its own figure`).not.toMatch(
        /\b(?:function|const|let|var)\s+savedCardChargeCents\b/,
      );
      expect(PAY_STEPS, file).toContain(file);
    }
    // The officer's confirm dialog quotes - and decides "no charge" on - the
    // same figure the route charges.
    const section = read("src/app/(authenticated)/bookings/[id]/_components/booking-admin-tools-section.tsx");
    expect(section).toMatch(/savedCardChargeCents=\{savedCardChargeCents\(booking\)\}/);
    expect(read("src/components/admin/confirm-pending-guests-button.tsx")).not.toMatch(/\bfinalPriceCents\b/);
    expect(savedCardChargeCents({ finalPriceCents: 10_000, payment: { changeFeeCents: 2_500 } })).toBe(12_500);
    expect(savedCardChargeCents({ finalPriceCents: 10_000, payment: null })).toBe(10_000);
  });

  // #4399: the two pending-guest doors that confirm a booking worth $0 write its
  // Payment row through one helper, on their claim's transaction client - one
  // had drifted to writing it after its transaction committed.
  it("both $0 confirms write their payment row through writeZeroWorthConfirmPayment on the claim's tx (#4399)", () => {
    for (const file of ["src/lib/cron-confirm-pending.ts", "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts"]) {
      const text = read(file);
      expect(text, `${file} writes the $0 payment through the helper, on its tx`).toMatch(
        /\bwriteZeroWorthConfirmPayment\(tx,/,
      );
      expect(text, `${file} spells the $0 SUCCEEDED row itself`).not.toMatch(
        /amountCents:\s*0,\s*status:\s*PaymentStatus\.SUCCEEDED/,
      );
    }
    // Every call anywhere passes the caller's transaction client, never the root client.
    const offCallers = sourceFiles(path.join(REPO, "src")).flatMap((file) =>
      [...read(file).matchAll(/\bwriteZeroWorthConfirmPayment\(\s*(\w+)/g)]
        .filter((match) => match[1] !== "tx")
        .map((match) => `${file}: ${match[0]}`),
    );
    expect(offCallers, "write the $0 payment on the claim's tx, never the root client").toEqual([]);
    expect(read("src/app/api/payments/charge-saved-method/route.ts"), "charge-saved-method refuses worth $0 under its locks").toMatch(
      /if \(savedCardChargeCents\(locked\) === 0\)/,
    );
  });

  // #3991: the narrative quotes "$X is due" from what it is handed, so every
  // file that resolves one reads the one home, and none hands it the bare price.
  it("every source file that resolves a booking narrative reads the amount owed there", () => {
    const callers = sourceFiles(path.join(REPO, "src")).filter((file) =>
      /\bresolveBookingNarrative\(/.test(read(file)) && file !== "src/lib/booking-narrative.ts",
    );
    expect(callers.length, "the census found no narrative caller").toBeGreaterThan(0);
    for (const file of callers) {
      expect(read(file), `INV-PAY-119: ${file} reads it through readBookingAmountOwed`).toMatch(
        /\breadBookingAmountOwed\(/,
      );
      expect(PAY_STEPS, `INV-PAY-119: add ${file} to PAY_STEPS`).toContain(file);
    }
    const bareDue = sourceFiles(path.join(REPO, "src")).filter((file) => BARE_PRICE_DUE.test(read(file)));
    expect(bareDue, "INV-PAY-119: the narrative's dueCents comes from bookingAmountOwedCents").toEqual([]);
  });

  it("no source file subtracts credit from the bare price any more", () => {
    const offenders = sourceFiles(path.join(REPO, "src")).flatMap((file) => {
      const allowed = ALLOWED_EXPRESSIONS[file] ?? [];
      return matchesIn(read(file))
        .filter((match) => !allowed.includes(match))
        .map((match) => `${file}: ${match}`);
    });
    expect(offenders, "INV-PAY-119: read it through bookingAmountOwedCents").toEqual([]);
  });

  it("every allowed expression is still there, exactly once", () => {
    for (const [file, allowed] of Object.entries(ALLOWED_EXPRESSIONS)) {
      expect(matchesIn(read(file)).sort(), file).toEqual([...allowed].sort());
    }
  });

  it("no source file asks whether credit covers the booking against the bare price", () => {
    const offenders = sourceFiles(path.join(REPO, "src")).flatMap((file) => {
      const allowed = ALLOWED_COMPARISONS[file] ?? [];
      return comparisonsIn(read(file))
        .filter((match) => !allowed.includes(match))
        .map((match) => `${file}: ${match}`);
    });
    expect(offenders, "INV-PAY-119: compare credit with bookingWorthCents, not the bare price").toEqual([]);
  });

  it("every allowed comparison is still there, exactly once", () => {
    for (const [file, allowed] of Object.entries(ALLOWED_COMPARISONS)) {
      expect(comparisonsIn(read(file)).sort(), file).toEqual([...allowed].sort());
    }
  });

  it("no source file sets an amount-due field from a bare final price (#4058)", () => {
    const offenders = sourceFiles(path.join(REPO, "src")).flatMap((file) =>
      quotesIn(read(file)).map((match) => `${file}: ${match}`),
    );
    expect(offenders, "INV-PAY-119: quote it through readBookingAmountOwed").toEqual([]);
  });

  it("every send that quotes what is owed reads it through readBookingAmountOwed (#4058)", () => {
    const callers = sourceFiles(path.join(REPO, "src")).filter(
      (file) => !file.startsWith("src/lib/email/") && QUOTING_SENDER.test(read(file)),
    );
    // The five senders of a pay link plus the exception-approved email.
    expect(callers.sort()).toEqual([
      "src/lib/booking-exception-approval.ts",
      "src/lib/booking-request.ts",
      "src/lib/cron-confirm-pending.ts",
      "src/lib/group-booking.ts",
      "src/lib/payment-link-reissue.ts",
      "src/lib/payment-link-split-guest.ts",
    ]);
    const offenders = callers.flatMap((file) => {
      const text = read(file);
      expect(text, `${file} passes amountDueCents`).toMatch(/amountDueCents\b/);
      return duePropertiesIn(text)
        .filter((match) => !(ALLOWED_DUE_PROPERTIES[file] ?? []).includes(match))
        .map((match) => `${file}: ${match}`);
    });
    expect(offenders, "INV-PAY-119: read it through readBookingAmountOwed, or pin it by text").toEqual([]);
  });

  it("every allowed amount-due property is still there, exactly once", () => {
    for (const [file, allowed] of Object.entries(ALLOWED_DUE_PROPERTIES)) {
      expect(duePropertiesIn(read(file)).sort(), file).toEqual([...allowed].sort());
    }
  });

  it("catches an amount-due field set from a bare final price", () => {
    for (const expression of [
      "amountDueCents: settled ? 0 : booking.finalPriceCents",
      "amountDueCents: resolution.booking.finalPriceCents",
    ]) {
      expect(quotesIn(expression), expression).toHaveLength(1);
    }
    expect(quotesIn("amountDueCents: (await readBookingAmountOwed(booking)).dueCents,")).toEqual([]);
  });

  it("catches a shorthand or locally derived amount-due property on a send", () => {
    for (const expression of [
      "{ priceCents, amountDueCents, bookingReference }",
      "{ amountDueCents: priceCents, bookingReference }",
      "{ amountDueCents: settled ? 0 : booking.finalPriceCents }",
      "amountDueCents: (await readBookingAmountOwed(booking)).owedCents,",
    ]) {
      expect(duePropertiesIn(expression), expression).toHaveLength(1);
    }
    for (const expression of [
      "amountDueCents: (await readBookingAmountOwed(booking)).dueCents,",
      "amountDueCents: settled ? 0 : (await readBookingAmountOwed(booking)).dueCents,",
      "  amountDueCents: number;",
      "data.amountDueCents",
    ]) {
      expect(duePropertiesIn(expression), expression).toEqual([]);
    }
  });

  it("catches a credit-against-bare-price comparison in either order and any strictness", () => {
    for (const expression of [
      "appliedCreditCents + reviewGiveBacksCents < previousFinalPriceCents",
      "appliedCreditCents + reviewGiveBacksCents <\n previousFinalPriceCents",
      "creditAppliedCents >= booking.finalPriceCents",
      "alreadyAppliedCents <= finalPriceCents",
      "booking.finalPriceCents > payment.creditAppliedCents",
    ]) {
      expect(comparisonsIn(expression), expression).toHaveLength(1);
    }
    for (const expression of [
      "appliedCreditCents < bookingWorthCents({ finalPriceCents, changeFeeCents })",
      "(appliedCreditCents) => finalPriceCents",
      "appliedCreditCents < finalPriceCents + changeFeeCents",
      "newFinalPriceCents < previousFinalPriceCents",
    ]) {
      expect(comparisonsIn(expression), expression).toEqual([]);
    }
  });

  it("catches credit and already-applied operands under any name", () => {
    for (const expression of [
      "newFinalPriceCents - clamp.appliedCreditCents",
      "booking.finalPriceCents -\n (await deriveBookingAppliedCreditCents(id))",
      "verifiedFinalPriceCents - alreadyAppliedCents",
    ]) {
      expect(matchesIn(expression), expression).toHaveLength(1);
    }
    expect(matchesIn("newFinalPriceCents - booking.finalPriceCents")).toEqual([]);
  });
});
