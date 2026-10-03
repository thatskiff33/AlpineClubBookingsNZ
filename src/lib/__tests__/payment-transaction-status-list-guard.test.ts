import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

const SOURCE_ROOT = join(process.cwd(), "src");
const CAPTURED_STATUS_NAMES = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"];

type SourceFile = { readonly file: string; readonly source: string };

function productionSourceFiles(directory = SOURCE_ROOT): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : productionSourceFiles(absolute);
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name)) return [];
    return [{ file: relative(process.cwd(), absolute), source: readFileSync(absolute, "utf8") }];
  });
}

/**
 * The receivers cover Prisma's inline `status.in`, in-memory sets, and named
 * arrays later spread into either. #3632 owns the four existing aggregate
 * sets below and removes their exceptions as it converges those readers.
 * The canonical transaction definition is exempt.
 */
function handwrittenCapturedTransactionStatusLists(files: readonly SourceFile[]): string[] {
  const namedArray = /(?:export\s+)?const\s+(\w+)(?:\s*:\s*[^=\n]+)?\s*=\s*\[([\s\S]{0,500}?)\]/g;
  const copiedListReceivers = [
    /status\s*:\s*\{\s*in\s*:\s*\[([\s\S]{0,500}?)\]\s*\}/g,
    /new\s+Set(?:<\s*(?:PaymentStatus|string)\s*>)?\s*\(\s*\[([\s\S]{0,500}?)\]\s*\)/g,
    namedArray,
  ];
  return files.flatMap(({ file, source }) => {
    if (file.replaceAll("\\", "/") === "src/lib/payment-transaction-status.ts") return [];
    if (file.replaceAll("\\", "/") === "src/lib/booking-payment-state.ts") return [];
    const matches: string[] = [];
    const code = stripComments(source);
    for (const receiver of copiedListReceivers) {
      for (const match of code.matchAll(receiver)) {
        const values = receiver === namedArray ? match[2] : match[1];
        if (receiver === namedArray) {
          // Full status vocabularies contain other members. This exact legacy
          // Xero eligibility list asks a different question and is not a
          // captured-payment list.
          const statusNames = values.match(/\b(?:PaymentStatus\.)?(?:PENDING|PROCESSING|SUCCEEDED|FAILED|REFUNDED|PARTIALLY_REFUNDED)\b/g) ?? [];
          if (statusNames.length !== CAPTURED_STATUS_NAMES.length) continue;
          const knownXeroEligibility =
            file.replaceAll("\\", "/") === "src/lib/admin-operational-state.ts" &&
            match[1] === "XERO_INVOICE_EXPECTED_PAYMENT_STATUSES";
          if (knownXeroEligibility) continue;
        }
        const declaration = code.slice(Math.max(0, match.index - 64), match.index);
        const knownAggregateSetName = {
          "src/lib/finance-booking-metrics.ts": "FINANCE_CAPTURED_PAYMENT_STATUSES",
          "src/lib/ib-hold-clearing-audit.ts": "REALIZED_PAYMENT_STATUSES",
          "src/lib/xero-booking-invoices.ts": "STRIPE_CAPTURED_PAYMENT_STATUSES",
          "src/lib/xero-booking-edit-conditions.ts": "UNSAFE_PRIMARY_INVOICE_PAYMENT_STATUSES",
        }[file.replaceAll("\\", "/")];
        if (
          knownAggregateSetName &&
          new RegExp(`const\\s+${knownAggregateSetName}\\s*=\\s*$`).test(declaration)
        ) continue;
        if (CAPTURED_STATUS_NAMES.every((status) => new RegExp(`\\b(?:PaymentStatus\\.)?${status}\\b`).test(values))) {
          matches.push(file);
        }
      }
    }
    return matches;
  });
}

describe("INV-SSOT: captured PaymentTransaction status-list guard (#3606)", () => {
  it("routes every captured transaction Prisma receiver through the status leaf", () => {
    expect(handwrittenCapturedTransactionStatusLists(productionSourceFiles())).toEqual([]);
  }, 15000);

  it("fails new hand-written captured transaction readers", () => {
    const mutation = [
      "const where = { status: { in: [",
      "  PaymentStatus.SUCCEEDED,",
      "  PaymentStatus.PARTIALLY_REFUNDED,",
      "  PaymentStatus.REFUNDED,",
      "] } };",
    ].join("\n");
    expect(
      handwrittenCapturedTransactionStatusLists([
        { file: "src/lib/mutated-payment-transaction-reader.ts", source: mutation },
        {
          file: "src/lib/mutated-payment-transaction-set.ts",
          source:
            "const captured = new Set<PaymentStatus>([PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED]);",
        },
        {
          file: "src/lib/mutated-payment-transaction-string-set.ts",
          source:
            "const captured = new Set<string>([\"SUCCEEDED\", \"PARTIALLY_REFUNDED\", \"REFUNDED\"]);",
        },
        {
          file: "src/lib/mutated-payment-transaction-array.ts",
          source:
            "const CAPTURED = [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED]; const where = { status: { in: [...CAPTURED] } };",
        },
        {
          file: "src/lib/mutated-payment-transaction-string-array.ts",
          source:
            "const CAPTURED = [\"SUCCEEDED\", \"PARTIALLY_REFUNDED\", \"REFUNDED\"] as const; const where = { status: { in: [...CAPTURED] } };",
        },
      ]),
    ).toEqual([
      "src/lib/mutated-payment-transaction-reader.ts",
      "src/lib/mutated-payment-transaction-set.ts",
      "src/lib/mutated-payment-transaction-string-set.ts",
      "src/lib/mutated-payment-transaction-array.ts",
      "src/lib/mutated-payment-transaction-string-array.ts",
    ]);
  });
});
