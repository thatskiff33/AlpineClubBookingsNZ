/**
 * THE MONEY MODULES: the one list of source globs that coverage and mutation
 * testing are measured over (#4459, programme #4450; `INV-SSOT`).
 *
 * Three readers import this and nothing else spells the list:
 *
 *   - `vitest.config.mts` (`test.coverage.include`), so a coverage run reports
 *     exactly these files, including the ones no test reaches;
 *   - `scripts/ci/money-coverage-ratchet.mjs`, which reads the per-file summary
 *     and judges the aggregate against the committed baseline;
 *   - `stryker.config.mjs`, which mutates the narrower `MUTATION_TARGET_GLOBS`.
 *
 * "Money" here follows `AGENTS.md`'s routing row: anything holding cents, and
 * the ledger, refund, credit, settlement and Xero modules that move them. The
 * globs are by file-name family rather than a hand-kept file list, so a new
 * module such as `xero-foo.ts` or `foo-refund.ts` joins the ratchet without an
 * edit here; `money-modules.test.ts` proves the list still matches files.
 *
 * Plain `.mjs`, Node built-ins only: a CI script runs it before any build.
 */

/** Source files whose coverage is ratcheted. Globs are repository-relative. */
export const MONEY_MODULE_GLOBS = [
  // The booking ledger and what is derived from it (INV-MONEY, design/booking-ledger.md).
  "src/lib/booking-ledger-*.ts",
  "src/lib/*money*.ts",
  "src/lib/member-money/**/*.ts",
  // Refunds, credits and settlement, whichever lifecycle raises them.
  "src/lib/*refund*.ts",
  "src/lib/*credit*.ts",
  "src/lib/*settle*.ts",
  // Everything that talks to Xero about money.
  "src/lib/xero-*.ts",
  // Where a cent figure is made: prices, fees and the payment rows.
  "src/lib/pricing.ts",
  "src/lib/authoritative-fees.ts",
  "src/lib/booking-final-price.ts",
  "src/lib/required-price-cents.ts",
  "src/lib/change-fee*.ts",
  "src/lib/joining-fee*.ts",
  "src/lib/payment-settler.ts",
  "src/lib/payment-transactions.ts",
  "src/lib/payment-transaction-status.ts",
  "src/lib/payment-ledger-order.ts",
  "src/lib/payment-net-collected.ts",
  "src/lib/policies/pricing.ts",
  "src/lib/policies/cancellation.ts",
  "src/lib/policies/change-fee.ts",
  "src/lib/policies/member-credit.ts",
];

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
