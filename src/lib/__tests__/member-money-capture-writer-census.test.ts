import ts from "typescript";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { captureWriterSites } from "./support/capture-writer-scan";
import { productionSourceFiles } from "./support/prisma-delegate-read-scan";

// Every mutation is classified, including non-capturing ones: a computed data/status value cannot evade the inventory.
const REVIEWED: Record<string, string> = {
  "prisma/demo-seed.ts|cleanup|deleteMany|1": "synthetic demo teardown only",
  "prisma/demo-seed.ts|main|create|7": "synthetic demo seed only",
  "prisma/demo-seed.ts|main|createMany|1": "synthetic demo seed only",
  "prisma/demo-seed.ts|seedNadiaPaidCardBooking|create|1": "synthetic demo seed only",
  "src/app/api/payments/switch-to-internet-banking/route.ts|POST|recordInternetBankingPaymentTransaction|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/additional-ask-reduction.ts|retireUnpaidAskChainUnderLocks|updateMany|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/additional-intent-currency.ts|reissueAdditionalIntentInClubCurrency|upsertPaymentIntentTransaction|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/additional-payment-withdraw.ts|withdrawAdditionalPaymentAsk|updateMany|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/booking-create.ts|createConfirmedBooking|recordInternetBankingPaymentTransaction|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/booking-modification-settlement.ts|mintModificationAdditionalAsk|upsertPaymentIntentTransaction|2": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/card-intent-attach.ts|attachMintedCardIntent|upsertPaymentIntentTransaction|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/credit-release-ask-close.ts|closeCreditReleaseAsksPaidInXero|recordInternetBankingPaymentTransaction|1": "W8: paid bank receipt hook; unpaid card row retired",
  "src/lib/credit-release-ask-close.ts|closeCreditReleaseAsksPaidInXero|updateMany|1": "W8: paid bank receipt hook; unpaid card row retired",
  "src/lib/credit-release-ask-close.ts|recordReleasePaidInXeroCash|recordInternetBankingPaymentTransaction|1": "W8: paid bank receipt hook",
  "src/lib/credit-release-ask.ts|processCreditReleaseAskOperation|upsertPaymentIntentTransaction|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/internet-banking-part-payment-at-cancel.ts|recordPartPaymentInClaim|recordInternetBankingPaymentTransaction|1": "W7: recognised part receipt posted after legacy convergence",
  "src/lib/internet-banking-part-payment-at-cancel.ts|recordPartPaymentInClaim|update|1": "W7: recognised part receipt posted after legacy convergence",
  "src/lib/organiser-extra-receipt.ts|receipt|create|1": "organiser cash and shares belong to M6, not M4b",
  "src/lib/organiser-extra-receipt.ts|syncOrganiserExtraInvoiceCash|create|1": "organiser cash belongs to M6",
  "src/lib/organiser-extra-receipt.ts|syncOrganiserExtraInvoiceCash|update|1": "organiser cash belongs to M6",
  "src/lib/payment-intent-ledger-row-write.ts|updateOurs|updateMany|2": "generic intent writer: captures arrive through the classified W1/W4 upsert calls",
  "src/lib/payment-intent-ledger-row-write.ts|writePaymentIntentTransaction|createMany|1": "generic intent writer: capturing callers W1/W4 are classified separately",
  "src/lib/payment-reconciliation.ts|reverseManualBookingPayment|updateMany|3": "R08: exact reversal hook after settlement convergence; other writes retire unpaid asks",
  "src/lib/payment-reconciliation.ts|settleBookingPaymentInTransaction|create|2": "W1: receipt hook in settleBookingPaymentInTransaction, after every outcome and R01",
  "src/lib/payment-reconciliation.ts|settleBookingPaymentInTransaction|updateMany|2": "W1: receipt hook in settleBookingPaymentInTransaction, after every outcome and R01",
  "src/lib/payment-reconciliation.ts|settleBookingPaymentInTransaction|upsertPaymentIntentTransaction|1": "W1: receipt hook in settleBookingPaymentInTransaction, after every outcome and R01",
  "src/lib/payment-recovery.ts|markSupersededTransactionFailed|updateMany|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/payment-recovery.ts|markSupersededTransactionSucceeded|update|1": "W6: held receipt in its Payment-row transaction",
  "src/lib/payment-recovery.ts|processCreateAdditionalPaymentIntentOperation|upsertPaymentIntentTransaction|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/payment-transactions.ts|compareAndSetRefundedAmount|updateMany|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/payment-transactions.ts|ensurePaymentTransactionsBackfilled|create|1": "legacy compatibility: materialises existing captured mirrors; the hook catches up every receipt on its payment",
  "src/lib/payment-transactions.ts|markPaymentIntentTransactionFailed|updateMany|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/payment-transactions.ts|markPaymentIntentTransactionSucceeded|update|1": "W3: explicit collect/hold receipt hook in the same Payment-row transaction",
  "src/lib/payment-transactions.ts|recordInternetBankingPaymentTransaction|create|1": "generic bank writer: capturing callers are W7/W8; new callers must be classified here",
  "src/lib/payment-transactions.ts|writeRaisedAdditionalRequestAmount|updateMany|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/saved-card-charge-attempt.ts|beginSavedCardChargeAttempt|create|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/saved-card-charge-attempt.ts|beginSavedCardChargeAttempt|update|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/saved-card-charge-attempt.ts|beginSavedCardChargeAttempt|updateMany|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/saved-card-charge-failure.ts|retireUnusableSavedCard|updateMany|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/saved-card-charge-request.ts|failSavedCardChargeAttempt|updateMany|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/saved-card-charge-request.ts|reviveSupersededAttemptRow|updateMany|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/saved-card-charge-settle.ts|keepExistingRow|deleteMany|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/saved-card-charge-settle.ts|keepExistingRow|updateMany|1": "unpaid/failed request bookkeeping only; cannot introduce captured cash",
  "src/lib/saved-card-charge-settle.ts|settleSavedCardChargeAttemptUnderLock|updateMany|1": "W2: outer settleSavedCardChargeAttempt posts newly captured money held",
  "src/lib/stripe-webhook-service.ts|handleCancelledBookingPaymentSucceeded|upsertPaymentIntentTransaction|1": "W4: held receipt in the new Payment-row transaction",
  "src/lib/xero-booking-invoices.ts|createXeroInvoiceForBooking|updateMany|1": "invoice identifiers only; never changes status or amount",
  "src/lib/xero-inbound/invoice-paid-effects.ts|syncInternetBankingPaymentsForPaidInvoice|create|1": "R07: finally posts after the writer and confirmation; second instrument is held",
  "src/lib/xero-inbound/invoice-paid-effects.ts|syncInternetBankingPaymentsForPaidInvoice|updateMany|2": "R07: finally posts after the writer and confirmation; second instrument is held",
};

describe("M4b capture-writer census", () => {
  it("classifies every production transaction mutation and every generic receipt/upsert caller", () => {
    const found = productionSourceFiles(process.cwd()).flatMap((file) => captureWriterSites(file, readFileSync(file, "utf8")));
    const counts = new Map<string, number>();
    for (const site of found) counts.set(site, (counts.get(site) ?? 0) + 1);
    expect([...counts].map(([site, n]) => `${site}|${n}`).sort()).toEqual(Object.keys(REVIEWED).sort());
    for (const reason of Object.values(REVIEWED)) expect(reason.length).toBeGreaterThan(20);
  }, 15_000);
  it("discovers direct, bracket, alias, computed-data and nested writers, and a new generic capture caller", () => {
    for (const write of [
      'tx.paymentTransaction.create({ data: { status: "SUCCEEDED" } })',
      'tx["paymentTransaction"].update({ data })',
      'const rows = tx.paymentTransaction; rows.updateMany({ data: unknown })',
      'const { paymentTransaction: rows } = tx; rows.create({ data })',
      'const key = "paymentTransaction"; tx[key].upsert({ create, update })',
      'tx.payment.update({ data: { transactions: { create: captured } } })',
      'upsertPaymentIntentTransaction({ status: answer })',
      'recordInternetBankingPaymentTransaction({ status: "SUCCEEDED" })',
    ]) expect(captureWriterSites("new.ts", write), write).toHaveLength(1);
    expect(captureWriterSites("new.ts", 'tx.paymentTransaction.findMany({ where: { status: "SUCCEEDED" } })')).toEqual([]);
  });
  it("keeps a receipt hook at every capturing chokepoint", () => {
    const sites: Record<string, string[]> = {
      "payment-reconciliation.ts": ["settleAndPostBookingReceipts", "reverseManualBookingPayment"],
      "saved-card-charge-settle.ts": ["settleSavedCardChargeAttempt"],
      "payment-recovery.ts": ["markSupersededTransactionSucceeded"],
      "payment-transactions.ts": ["markPaymentIntentTransactionSucceeded"],
      "stripe-webhook-service.ts": ["handleCancelledBookingPaymentSucceeded"],
      "internet-banking-part-payment-at-cancel.ts": ["recordPartPaymentInClaim"],
      "credit-release-ask-close.ts": ["closeCreditReleaseAsksPaidInXero", "recordReleasePaidInXeroCash"],
      "xero-inbound/invoice-paid-effects.ts": ["syncInternetBankingPaymentsForPaidInvoice"],
    };
    for (const [file, functions] of Object.entries(sites)) {
      const source = ts.createSourceFile(file, readFileSync(`src/lib/${file}`, "utf8"), ts.ScriptTarget.Latest, true);
      for (const fn of functions) {
        const declaration = source.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === fn);
        expect(declaration, `${file}:${fn}`).toBeDefined();
        const calls: ts.Node[] = [];
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "postBookingReceipts") calls.push(node);
          ts.forEachChild(node, visit);
        };
        visit(declaration!);
        expect(calls, `${file}:${fn}`).toHaveLength(1);
      }
    }
  });
});
