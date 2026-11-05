/**
 * THE MONEY MODULES: the one list of source globs that coverage and mutation
 * testing are measured over (#4459, programme #4450; `INV-SSOT`).
 *
 * Three readers import this and nothing else spells the list:
 *
 *   - `vitest.config.mts` (`test.coverage.include`), so a coverage run reports
 *     exactly these files, including the ones no test reaches;
 *   - `scripts/ci/money-test-ratchet.mjs`, which reads the per-file summary
 *     and judges the aggregate against the baseline;
 *   - `stryker.config.mjs`, which mutates the narrower `MUTATION_TARGET_GLOBS`.
 *
 * WHAT COUNTS AS MONEY IS DECIDED IN `.github/CODEOWNERS`, not here (review of
 * #4459): the owner's own list of the `src/lib` modules that mint, charge,
 * refund, credit, settle or size money, which `codeowners-census.test.ts`
 * already keeps from rotting. Every `/src/lib/...` pattern in it is a money
 * glob, read from the file each time, so a new owned module is measured the
 * day it is owned and a second hand-kept list cannot drift from the first.
 * `EXTRA_MONEY_MODULE_GLOBS` adds only what the issue names beyond that
 * ownership: every Xero module (the inbound handlers in `xero-inbound/`
 * included), the booking ledger and the money-named helpers.
 * `money-test-ratchet.test.ts` proves every owned `src/lib` file is listed.
 *
 * Plain `.mjs`, Node built-ins only: a CI script runs it before any build.
 */
import { readFileSync } from "node:fs";

/** The `src/lib` patterns CODEOWNERS owns, as repository-relative globs. */
export function codeownersSrcLibGlobs(
  source = readFileSync(new URL("../../.github/CODEOWNERS", import.meta.url), "utf8"),
) {
  const globs = [];
  for (const line of source.split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;
    const [pattern] = text.split(/\s+/);
    // Owned tests (the guards that enforce the gate) are not modules to measure.
    if (!pattern.startsWith("/src/lib/") || pattern.includes("/__tests__/")) continue;
    const glob = pattern.slice(1);
    if (glob.endsWith("/")) globs.push(`${glob}**/*.ts`);
    else if (/\.tsx?$/.test(glob)) globs.push(glob);
    else throw new Error(`CODEOWNERS pattern ${pattern} is neither a directory nor a .ts glob; teach money-modules.mjs to read it`);
  }
  if (globs.length === 0) throw new Error("CODEOWNERS names no /src/lib/ pattern, so the money module list would be empty");
  return globs;
}

/** What the issue asks to measure beyond what CODEOWNERS owns. */
export const EXTRA_MONEY_MODULE_GLOBS = [
  // The booking ledger and what is derived from it (INV-MONEY, design/booking-ledger.md).
  "src/lib/booking-ledger-*.ts",
  "src/lib/*money*.ts",
  "src/lib/member-money/**/*.ts",
  // Refunds, credits and settlement, whichever lifecycle raises them.
  "src/lib/*refund*.ts",
  "src/lib/*credit*.ts",
  "src/lib/*settle*.ts",
  // Everything that talks to Xero, the inbound handlers included.
  "src/lib/xero-*.ts",
  "src/lib/xero-inbound/**/*.ts",
  // Where a cent figure is made.
  "src/lib/joining-fee*.ts",
  "src/lib/policies/cancellation.ts",
  "src/lib/policies/change-fee.ts",
  "src/lib/policies/member-credit.ts",
];

/** Source files whose coverage is ratcheted. Globs are repository-relative. */
export const MONEY_MODULE_GLOBS = [...new Set([...codeownersSrcLibGlobs(), ...EXTRA_MONEY_MODULE_GLOBS])];

/** Never counted, whichever glob matched them. */
export const MONEY_MODULE_EXCLUDE_GLOBS = ["**/__tests__/**", "**/*.test.*", "**/*.d.ts"];

/**
 * What Stryker mutates (#4459): the pure ledger planners that decide every
 * line the ledger holds, and the refund and settlement arithmetic beside them.
 * Narrower than `MONEY_MODULE_GLOBS` on purpose: a mutant is only informative
 * where a fast unit test can kill it, and the Prisma-facing `*-sync.ts` and
 * `*-store.ts` modules are exercised by real-database suites a mutation run
 * cannot afford. Each entry names a module with a small unit suite.
 */
export const MUTATION_TARGET_GLOBS = [
  "src/lib/booking-ledger-balance.ts",
  "src/lib/booking-ledger-write.ts",
  "src/lib/booking-ledger-charge-line.ts",
  "src/lib/booking-ledger-posting-keys.ts",
  "src/lib/booking-ledger-confirmation-posting.ts",
  "src/lib/booking-ledger-modification-posting.ts",
  "src/lib/booking-ledger-settlement-posting.ts",
  "src/lib/booking-ledger-credit-posting.ts",
  "src/lib/booking-ledger-cancellation-posting.ts",
  "src/lib/paid-cancellation-money.ts",
  "src/lib/cancel-refund-method.ts",
  "src/lib/edit-refund-hand-back.ts",
];

/**
 * The unit suites a mutation run executes against `MUTATION_TARGET_GLOBS`
 * (#4459). Stryker runs the whole configured suite once before it mutates
 * anything, and the full suite is hundreds of files, so its Vitest config
 * (`vitest.stryker.config.mts`) includes only these. No `*.realdb.test.ts`: a
 * mutation run has no database. Add a suite here when it is the one that
 * should kill a mutant of a target above.
 */
export const MUTATION_TEST_FILES = [
  "src/lib/__tests__/booking-ledger-balance.test.ts",
  "src/lib/__tests__/booking-ledger-write.test.ts",
  "src/lib/__tests__/booking-ledger-posting-keys.test.ts",
  "src/lib/__tests__/booking-ledger-confirmation-posting.test.ts",
  "src/lib/__tests__/booking-ledger-modification-posting.test.ts",
  "src/lib/__tests__/booking-ledger-settlement-posting.test.ts",
  "src/lib/__tests__/booking-ledger-credit-posting.test.ts",
  "src/lib/__tests__/booking-ledger-cancellation.test.ts",
  "src/lib/__tests__/booking-ledger-model.property.test.ts",
  "src/lib/__tests__/paid-cancellation-money.test.ts",
  "src/lib/__tests__/cancel-refund-method.test.ts",
  "src/lib/__tests__/edit-refund-hand-back.test.ts",
];
