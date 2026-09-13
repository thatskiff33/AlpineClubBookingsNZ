import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  relativeSource,
  sourceFiles,
} from "@/lib/__tests__/support/booking-guest-night-writer-scan";
import { stripComments } from "@/lib/__tests__/support/strip-comments";
import { BOOKING_MONEY_BUILD_UP_INVARIANT } from "@/lib/booking-money-build-up";

/**
 * #3277 (INV-MONEY-030, INV-SSOT-001): every Stage 3 money reader is named,
 * loads through the canonical projection, selects through the D3 discriminator,
 * and records the discriminator on an existing atomic history seam.
 *
 * This source census is intentionally exact. Adding a reader, duplicating a
 * call in an existing file, or replacing selection with `stored ?? headline`
 * fails until the new shape is reviewed and declared here.
 */

const REPO = process.cwd();
const READ = /(?<!function\s)\breadBookingMoneyBuildUp\s*\(/g;
const SELECT = /\bselectLoadedBookingMoneyBuildUp\s*\(/g;
const RESOLVE = /(?<!function\s)\bd3CompatibleBookingMoneyBuildUpCents\s*\(/g;

type ReaderSite = {
  reads: number;
  selections: number;
  resolutions: number;
  operation: string;
  historySink: RegExp;
  amountSink: RegExp;
};

const NAMED_READERS: Record<string, ReaderSite> = {
  "src/lib/booking-guest-removal-service.ts": {
    reads: 1,
    selections: 1,
    resolutions: 1,
    operation: "GUEST_REMOVAL",
    historySink: /\.\.\.moneyBuildUpSelection\.historyMetadata/,
    amountSink: /const priceDiffCents = d3CompatibleBookingMoneyBuildUpCents\(moneyBuildUpSelection\)/,
  },
  "src/lib/booking-review-price-rebase.ts": {
    reads: 2,
    selections: 2,
    resolutions: 1,
    operation: "REVIEW_REBASE",
    historySink: /\.\.\.(?:outcome\.)?moneyBuildUpSelection\.historyMetadata/,
    amountSink: /const verifiedNewFinalPriceCents = d3CompatibleBookingMoneyBuildUpCents\([\s\S]{0,100}moneyBuildUpSelection[\s\S]{0,800}finalPriceCents: verifiedNewFinalPriceCents/,
  },
  "src/lib/booking-credit-election.ts": {
    reads: 1,
    selections: 1,
    resolutions: 1,
    operation: "CREDIT_ELECTION",
    historySink: /moneyBuildUp:\s*moneyBuildUpSelection\.historyMetadata/,
    amountSink: /const verifiedFinalPriceCents = d3CompatibleBookingMoneyBuildUpCents\([\s\S]{0,100}moneyBuildUpSelection[\s\S]{0,800}verifiedFinalPriceCents - alreadyAppliedCents/,
  },
  "src/lib/xero-booking-invoices.ts": {
    reads: 1,
    selections: 1,
    resolutions: 1,
    operation: "XERO_PROMO_LINE",
    historySink: /moneyBuildUp:\s*promoMoneyBuildUpSelection\.historyMetadata/,
    amountSink: /const xeroPromoAdjustmentCents = d3CompatibleBookingMoneyBuildUpCents\([\s\S]{0,100}promoMoneyBuildUpSelection[\s\S]{0,5000}unitAmount: xeroPromoAdjustmentCents \/ 100/,
  },
};

function productionCode(file: string): string {
  return stripComments(readFileSync(join(REPO, file), "utf8"));
}

export function canonicalReaderShape(code: string, site: ReaderSite): boolean {
  return (
    [...code.matchAll(READ)].length === site.reads &&
    [...code.matchAll(SELECT)].length === site.selections &&
    [...code.matchAll(RESOLVE)].length === site.resolutions &&
    code.includes(`purpose: "${site.operation}"`) &&
    code.includes("mismatchClassification:") &&
    site.historySink.test(code) &&
    site.amountSink.test(code)
  );
}

describe("#3277 canonical stored-money reader census", () => {
  it("declares every production call to the canonical loader", () => {
    const discovered = sourceFiles()
      .filter((file) => [...stripComments(readFileSync(file, "utf8")).matchAll(READ)].length > 0)
      .map(relativeSource)
      .sort();
    expect(discovered).toEqual(Object.keys(NAMED_READERS).sort());
  });

  it("requires every named reader to select, classify disagreement, and record history", () => {
    for (const [file, site] of Object.entries(NAMED_READERS)) {
      expect(
        canonicalReaderShape(productionCode(file), site),
        `${BOOKING_MONEY_BUILD_UP_INVARIANT}: ${file} must use the canonical ${site.operation} result and its existing atomic history seam`,
      ).toBe(true);
    }
  });

  it("pins the canonical D3 amount resolver into every member-visible amount sink", () => {
    for (const [file, site] of Object.entries(NAMED_READERS)) {
      const code = productionCode(file);
      expect([...code.matchAll(RESOLVE)]).toHaveLength(site.resolutions);
      expect(code, `${file} must feed the resolved amount into its money sink`).toMatch(
        site.amountSink,
      );
    }
  });

  it("pins each reader on the safe side of its mutation or provider boundary", () => {
    const before = (code: string, first: string, second: string) => {
      expect(code.indexOf(first), `${first} must exist`).toBeGreaterThanOrEqual(0);
      expect(code.indexOf(second), `${second} must exist`).toBeGreaterThanOrEqual(0);
      expect(code.indexOf(first), `${first} must precede ${second}`).toBeLessThan(
        code.indexOf(second),
      );
    };

    const removal = productionCode("src/lib/booking-guest-removal-service.ts");
    before(removal, "const recordedMoneyBuildUp", "removeGuestChoreAssignments(tx, guestId)");
    before(removal, "const moneyBuildUpSelection", "await tx.bookingGuest.delete");

    const credit = productionCode("src/lib/booking-credit-election.ts");
    before(credit, "const moneyBuildUpSelection", "await tx.booking.updateMany");

    const xero = productionCode("src/lib/xero-booking-invoices.ts");
    before(xero, "readBookingMoneyBuildUp(prisma", "getAuthenticatedXeroClient()");
    expect(xero).toMatch(
      /buildRequestPayload:[\s\S]{0,240}moneyBuildUp:\s*promoMoneyBuildUpSelection\.historyMetadata/,
    );

    const rebase = productionCode("src/lib/booking-review-price-rebase.ts");
    before(rebase, "const freshlyRecordedMoneyBuildUp", "store.booking.updateMany");
  });

  it("renders modification source metadata where guest removal and review rebase appear", () => {
    const history = productionCode("src/lib/booking-history.ts");
    expect(history).toMatch(
      /const moneyBuildUpNote = moneyBuildUpNoteOf\(modification\);[\s\S]{0,120}detailParts\.push\(moneyBuildUpNote\)/,
    );
    const narrative = productionCode(
      "src/lib/booking-history-modification-narrative.ts",
    );
    for (const source of [
      "STORED",
      "DERIVED_COMPATIBILITY_FALLBACK",
      "BASE_EVIDENCE_UNKNOWN",
    ]) {
      expect(narrative).toContain(`source === "${source}"`);
    }
  });

  it("mutation-proves that dropping loader, selection, classification, or history is caught", () => {
    const site: ReaderSite = {
      reads: 1,
      selections: 1,
      resolutions: 1,
      operation: "CREDIT_ELECTION",
      historySink: /moneyBuildUp:\s*selection\.historyMetadata/,
      amountSink: /const amount = d3CompatibleBookingMoneyBuildUpCents\(selection\);[\s\S]*write\(amount\)/,
    };
    const complete = `
      readBookingMoneyBuildUp(tx, { purpose: "CREDIT_ELECTION" });
      selectLoadedBookingMoneyBuildUp(loaded, { mismatchClassification: "STORED_SIDE_DEFECT" });
      const amount = d3CompatibleBookingMoneyBuildUpCents(selection);
      write(amount);
      return { moneyBuildUp: selection.historyMetadata };
    `;
    expect(canonicalReaderShape(complete, site)).toBe(true);
    for (const token of [
      "readBookingMoneyBuildUp",
      "selectLoadedBookingMoneyBuildUp",
      "d3CompatibleBookingMoneyBuildUpCents",
      "write(amount)",
      "mismatchClassification:",
      "moneyBuildUp: selection.historyMetadata",
    ]) {
      expect(canonicalReaderShape(complete.replace(token, "dropped"), site)).toBe(false);
    }
    expect(
      canonicalReaderShape(
        complete.replace(
          "const amount = d3CompatibleBookingMoneyBuildUpCents(selection);",
          "const amount = selection.derivedCents;",
        ),
        site,
      ),
    ).toBe(false);
  });
});
