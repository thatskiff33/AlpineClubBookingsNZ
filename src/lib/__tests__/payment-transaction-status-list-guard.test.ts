import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
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
 * The receivers cover Prisma's inline `status.in`, in-memory sets, named
 * arrays later spread into either, and an in-memory status receiver. The
 * receiver matters: `Payment` and `PaymentTransaction` retain different homes
 * even while their captured values agree. The two canonical leaves are exempt.
 */
function handwrittenCapturedTransactionStatusLists(files: readonly SourceFile[]): string[] {
  const namedArray = /(?:export\s+)?const\s+(\w+)(?:\s*:\s*[^=\n]+)?\s*=\s*\[([\s\S]{0,500}?)\]/g;
  const copiedListReceivers = [
    /status\s*:\s*\{\s*in\s*:\s*\[([\s\S]{0,500}?)\]\s*\}/g,
    /new\s+Set(?:<\s*(?:PaymentStatus|string)\s*>)?\s*\(\s*\[([\s\S]{0,500}?)\]\s*\)/g,
    namedArray,
    /\b\w+(?:\.\w+)*\.status\s*===\s*(?:PaymentStatus\.)?(?:["']?SUCCEEDED["']?)\s*\|\|\s*\w+(?:\.\w+)*\.status\s*===\s*(?:PaymentStatus\.)?(?:["']?PARTIALLY_REFUNDED["']?)\s*\|\|\s*\w+(?:\.\w+)*\.status\s*===\s*(?:PaymentStatus\.)?(?:["']?REFUNDED["']?)/g,
  ];
  return files.flatMap(({ file, source }) => {
    if (file.replaceAll("\\", "/") === "src/lib/payment-transaction-status.ts") return [];
    if (file.replaceAll("\\", "/") === "src/lib/booking-payment-state.ts") return [];
    const matches: string[] = [];
    const code = stripComments(source);
    for (const receiver of copiedListReceivers) {
      for (const match of code.matchAll(receiver)) {
        const values = receiver === namedArray ? match[2] : match[1] ?? match[0];
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
        {
          file: "src/lib/mutated-payment-transaction-inline.ts",
          source:
            "if (paymentTransaction.status === PaymentStatus.SUCCEEDED || paymentTransaction.status === PaymentStatus.PARTIALLY_REFUNDED || paymentTransaction.status === PaymentStatus.REFUNDED) {}",
        },
      ]),
    ).toEqual([
      "src/lib/mutated-payment-transaction-reader.ts",
      "src/lib/mutated-payment-transaction-set.ts",
      "src/lib/mutated-payment-transaction-string-set.ts",
      "src/lib/mutated-payment-transaction-array.ts",
      "src/lib/mutated-payment-transaction-string-array.ts",
      "src/lib/mutated-payment-transaction-inline.ts",
    ]);
  });

  it("rejects an inline captured-status copy written to disk", () => {
    const directory = mkdtempSync(join(tmpdir(), "captured-status-guard-"));
    try {
      writeFileSync(
        join(directory, "mutated-reader.ts"),
        "if (transaction.status === 'SUCCEEDED' || transaction.status === 'PARTIALLY_REFUNDED' || transaction.status === 'REFUNDED') {}",
      );

      expect(handwrittenCapturedTransactionStatusLists(productionSourceFiles(directory))).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
