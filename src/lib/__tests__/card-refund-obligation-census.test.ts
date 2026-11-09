/**
 * #4516 (Ledger M4c; plan section 5): EVERY CARD REFUND SENDER NAMES THE DEBT ITS SLICES PAY. A production call of
 * `refundPaymentTransactions` passes `obligation`, so the reservation step claims each keyed slice before Stripe is
 * asked; a call that leaves it out sends with no reservation and its refund posts unapplied, which only the M6
 * organiser and group senders may do (they call `processRefund` directly and are out of this census's reach).
 * Closed-world both ways: a new sender must name its debt, and the list of senders is pinned so a removed one is
 * noticed. The census reads masked source, so a call inside a comment or a string is not a call.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { balancedBrackets } from "./support/balanced-brackets";
import { productionSourceFiles } from "./support/prisma-delegate-read-scan";
import { blankLiterals } from "./support/strip-comments";

const ROOT = process.cwd();
const CALL = /\brefundPaymentTransactions\s*\(/g;

/** The production senders, each with the debt it names: the census fails if this moves. */
const SENDERS: Record<string, number> = {
  "src/app/api/admin/refund-requests/[id]/route.ts": 1, // refund-request
  "src/lib/booking-cancel.ts": 1, // cancellation
  "src/lib/booking-modification-settlement.ts": 1, // modification
  "src/lib/edit-financial-review-card-refund.ts": 1, // review
  "src/lib/late-capture-own-charge-refund.ts": 1, // capture-return (deferred R05)
  "src/lib/late-capture-refund-approval.ts": 1, // capture-return
  "src/lib/payment-reconciliation.ts": 2, // capture-return: duplicate capture, capacity race
  "src/lib/payment-recovery.ts": 2, // the runner: the row's debt (`resolveCardRefundObligation`)
  "src/lib/stripe-webhook-service.ts": 1, // capture-return (deferred R05)
  "src/lib/xero-booking-repair-passes.ts": 1, // capture-return per slice
};

/**
 * Every production edit that posts its lines (`postModificationLedgerLines`), and whether it passes the edit's card
 * refund for the R05 posted beside them. The two that pass none owe nothing back: a guest added, and an admin date
 * shift, which re-dates each night at its own figure.
 */
const MODIFICATION_LINE_SITES: Record<string, { withCardRefund: number; withoutCardRefund: number }> = {
  "src/app/api/bookings/[id]/guests/route.ts": { withCardRefund: 0, withoutCardRefund: 1 }, // guest-add
  "src/lib/booking-batch-modification-service.ts": { withCardRefund: 1, withoutCardRefund: 0 },
  "src/lib/booking-date-modification-service.ts": { withCardRefund: 1, withoutCardRefund: 1 }, // the admin date shift
  "src/lib/booking-guest-acceptance-reprice.ts": { withCardRefund: 1, withoutCardRefund: 0 },
  "src/lib/booking-guest-removal-service.ts": { withCardRefund: 1, withoutCardRefund: 0 },
};

function calls(file: string, call: RegExp = CALL): Array<{ args: string }> {
  const source = readFileSync(join(ROOT, file), "utf8");
  const masked = blankLiterals(source);
  return [...masked.matchAll(call)].flatMap((match) => {
    const open = match.index! + match[0].length - 1;
    // The declaration `function refundPaymentTransactions(` is not a call.
    if (/function\s+$/.test(masked.slice(Math.max(0, match.index! - 20), match.index!))) return [];
    return [{ args: balancedBrackets(source, open, masked).text }];
  });
}

describe("every card refund sender names the debt its slices pay (#4516)", () => {
  const found = productionSourceFiles(ROOT).filter((file) => !file.endsWith("payment-transactions.ts") && calls(file).length > 0);

  it("lists exactly the production senders, each call counted", () => {
    expect(Object.fromEntries(found.map((file) => [file, calls(file).length]))).toEqual(SENDERS);
  });

  it("MUTATION: every production call passes `obligation`", () => {
    const missing = found.flatMap((file) => calls(file).filter((call) => !/\bobligation\b/.test(call.args)).map(() => file));
    expect(missing, "a card refund sender sends without naming its debt; its refund would post unapplied").toEqual([]);
    // Fixture proof: a call without one is caught, a call with one is not.
    expect(/\bobligation\b/.test("({ paymentId, amountCents, allocation, metadata, idempotencyKeyPrefix })")).toBe(false);
    expect(/\bobligation\b/.test("({ paymentId, obligation: { scope: \"cancellation\", id } })")).toBe(true);
  });

  it("MUTATION: every edit that can owe a card refund back passes it to the R05 beside its lines", () => {
    const LINES = /\bpostModificationLedgerLines\s*\(/g;
    const sites = productionSourceFiles(ROOT).flatMap((file) => {
      const found = calls(file, LINES);
      if (found.length === 0) return [];
      const withCardRefund = found.filter((call) => /\bcardRefundCents\s*:/.test(call.args)).length;
      return [[file, { withCardRefund, withoutCardRefund: found.length - withCardRefund }] as const];
    });
    expect(Object.fromEntries(sites), "an edit posts its lines without its card refund: its refund would post unapplied").toEqual(MODIFICATION_LINE_SITES);
  });
});
