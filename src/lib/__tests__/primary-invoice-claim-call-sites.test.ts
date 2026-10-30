import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { blankLiterals, stripComments } from "@/lib/__tests__/support/strip-comments";
import { balancedBrackets } from "./support/balanced-brackets";

/**
 * #3980 (`INV-PAY-136`, `INV-LOCK-003`'s spirit for a row-lock site): the
 * inventory of the edit's claim on the Payment row. Every ordinary edit door
 * that read no primary invoice link claims it and marks its history row, and
 * the only `xeroInvoiceId: null` guard on a payment write is the claim's.
 *
 * The population is every non-test source file under `src/`, by WALK, so a
 * new writer that guards on the link the same way is seen the day it exists
 * and has to be read against this protocol (`CONCURRENCY_AND_LOCKING.md`,
 * "An edit against the primary invoice's link"). WHAT THIS CANNOT SEE: a door
 * that settles through a renamed helper; the realdb proof
 * (`primary-invoice-edit-race.realdb.test.ts`) is what holds the behaviour.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CLAIM = "src/lib/booking-primary-invoice-claim.ts";
const SETTLEMENT = "src/lib/booking-modify-settlement.ts";
const GUESTS_ROUTE = "src/app/api/bookings/[id]/guests/route.ts";
/** The doors that settle through `applyPaymentAdjustments` and write their own history row. */
const SETTLEMENT_DOORS = [
  "src/lib/booking-batch-modification-service.ts",
  "src/lib/booking-date-modification-service.ts",
  "src/lib/booking-guest-acceptance-reprice.ts",
  "src/lib/booking-guest-removal-service.ts",
];

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(REPO_ROOT, "src"));
  return found.sort();
}

const read = (relative: string): string =>
  stripComments(fs.readFileSync(path.join(REPO_ROOT, relative), "utf8"));

describe("the edit's claim on the unlinked primary invoice: call sites (#3980)", () => {
  it("the population is real, so the census is not vacuous", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(500);
    for (const file of [CLAIM, SETTLEMENT, GUESTS_ROUTE, ...SETTLEMENT_DOORS]) expect(files).toContain(file);
  });

  it("the claim guards on the link still being unset", () => {
    expect(read(CLAIM)).toMatch(/payment\.updateMany\(\{\s*where: \{ id: input\.paymentId, xeroInvoiceId: null \}/);
  });

  /**
   * Review C4: EVERY write that sets `Payment.xeroInvoiceId`. Each takes the
   * Payment row, so a claim that queues behind it sees the link and is refused;
   * only the create's save (`persistPrimaryInvoiceLink`) stores the figures the
   * gap check reads, so an edit that claimed just before one of the others is
   * not measured (`INV-PAY-119`'s limits). A new entry here is a link writer to
   * read against that protocol. Found by reading each payment write's call,
   * including a `data` held in a variable the same file fills with the link.
   */
  it("lists every write that sets Payment.xeroInvoiceId", () => {
    const writers: string[] = [];
    for (const file of sourceFiles()) {
      const source = read(file);
      if (!source.includes(".payment.")) continue;
      // Call sites are found over masked text: a `payment.update(` named in a
      // string is not a call.
      const structure = blankLiterals(source);
      for (const match of structure.matchAll(/\b\w+\.payment\.(update|updateMany|upsert|create|createMany)\(/g)) {
        const { end } = balancedBrackets(source, match.index! + match[0].length - 1, structure);
        const call = source.slice(match.index!, end + 1);
        const data = call.slice(Math.max(0, call.indexOf("data")));
        const variable = /data: (\w+)\b/.exec(data)?.[1];
        const setsLink =
          /xeroInvoiceId/.test(data) ||
          (variable !== undefined &&
            new RegExp(`(const|let) ${variable}\\b[^;]*xeroInvoiceId|${variable}\\.xeroInvoiceId\\s*=`).test(source));
        if (setsLink) writers.push(`${file} ${match[1]}`);
      }
    }
    expect(writers.sort()).toEqual([
      // The mirror of the newest primary transaction's invoice (`reconcilePaymentAggregates`).
      "src/lib/payment-transactions.ts update",
      // An operator's local primary-invoice field repair.
      "src/lib/xero-booking-repair-passes.ts update",
      // The inbound "invoice paid" match (guarded on an unset link) and its settle under lock(1).
      "src/lib/xero-inbound/invoice-paid-effects.ts update",
      "src/lib/xero-inbound/invoice-paid-effects.ts updateMany",
      // The inbound payment's canonical link, where none is set.
      "src/lib/xero-inbound/payment.ts update",
      // The create's save: guarded on an unset link, then a different invoice's overwrite.
      "src/lib/xero-primary-invoice-fee-gap.ts update",
      "src/lib/xero-primary-invoice-fee-gap.ts updateMany",
    ]);
  });

  /**
   * Review round 2 F3: every door that mints a card ask after its commit hands
   * the minted intent to its Xero leg, so a supplementary invoice for money
   * that ask collects waits on its payment (`classifyXeroBookingEditSettlement`).
   * A `null` there leaves such an invoice deferred with no intent to wait on.
   */
  it("every door that mints an ask passes its intent to the Xero leg", () => {
    const doors = sourceFiles().filter(
      (file) =>
        /\bcreateModificationAdditionalPaymentIntent\(/.test(read(file)) &&
        /\b(queueXeroBookingEditSettlement|queueGuestRemovalXeroSettlement)\(/.test(read(file)),
    );
    expect(doors).toEqual([
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
      GUESTS_ROUTE,
      "src/lib/booking-batch-modification-service.ts",
      "src/lib/booking-date-modification-service.ts",
      "src/lib/booking-guest-acceptance-reprice.ts",
      "src/lib/member-guest-consent-service.ts",
    ]);
    for (const door of doors) {
      const source = read(door);
      const structure = blankLiterals(source);
      for (const match of structure.matchAll(/\b(queueXeroBookingEditSettlement|queueGuestRemovalXeroSettlement)\(/g)) {
        const { end } = balancedBrackets(source, match.index! + match[0].length - 1, structure);
        const call = source.slice(match.index!, end + 1);
        expect(call, door).toMatch(/additionalPaymentIntentId/);
        expect(call, door).not.toMatch(/additionalPaymentIntentId: null\b/);
      }
    }
  });

  it("every price writer outside the edit doors that claims does so through the one write", () => {
    const callers = sourceFiles().filter(
      (file) => file !== CLAIM && /\bwriteEditOnPayment\(/.test(read(file)),
    );
    expect(callers).toEqual([
      GUESTS_ROUTE,
      "src/lib/booking-modify-settlement.ts",
      "src/lib/booking-review-price-rebase.ts",
      "src/lib/school-pending-adult-resolution.ts",
    ]);
  });

  it("applyPaymentAdjustments makes it for its doors, and each door marks its history row", () => {
    expect(read(SETTLEMENT)).toContain("await writeEditOnPayment(tx, {");
    for (const door of SETTLEMENT_DOORS) {
      const source = read(door);
      expect(source, door).toContain("applyPaymentAdjustments(");
      expect(source, door).toMatch(/primaryInvoiceSettlementHistory\((payments|paymentImpact|adjusted)\)/);
    }
  });

  it("the guests route, which settles for itself, makes the same write and marks its row", () => {
    const route = read(GUESTS_ROUTE);
    // #4299 (N3): the same write, no fee, now also told the place settles on its organiser's combined invoice.
    expect(route).toContain("await writeEditOnPayment(tx, { payment: booking.payment, changeFeeCents: 0, settledAgainstCombinedInvoice: paidByOrganiserInternetBanking(booking) })");
    expect(route).toContain("primaryInvoiceSettlementHistory({ settledAgainstPrimaryInvoice })");
  });

  it("every caller of applyPaymentAdjustments is a door that marks its row", () => {
    const callers = sourceFiles().filter(
      (file) => file !== SETTLEMENT && /\bapplyPaymentAdjustments\(/.test(read(file)),
    );
    expect(callers).toEqual(SETTLEMENT_DOORS);
  });
});
