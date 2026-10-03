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
  const inlineArrayMembership = /\[([\s\S]{0,500}?)\]\s*\.includes\s*\(\s*\w+(?:\.\w+)*\.status\s*\)/g;
  // Match the same receiver three times, then compare status membership below;
  // the equivalent inline disjunction can be written in any order.
  const inlineDisjunction = /\b(\w+(?:\.\w+)*)\.status\s*===\s*(?:PaymentStatus\.)?["']?(SUCCEEDED|PARTIALLY_REFUNDED|REFUNDED)["']?\s*\|\|\s*\1\.status\s*===\s*(?:PaymentStatus\.)?["']?(SUCCEEDED|PARTIALLY_REFUNDED|REFUNDED)["']?\s*\|\|\s*\1\.status\s*===\s*(?:PaymentStatus\.)?["']?(SUCCEEDED|PARTIALLY_REFUNDED|REFUNDED)["']?/g;
  const copiedListReceivers = [
    /status\s*:\s*\{\s*in\s*:\s*\[([\s\S]{0,500}?)\]\s*\}/g,
    /new\s+Set(?:<\s*(?:PaymentStatus|string)\s*>)?\s*\(\s*\[([\s\S]{0,500}?)\]\s*\)/g,
    namedArray,
    inlineArrayMembership,
    inlineDisjunction,
  ];
  return files.flatMap(({ file, source }) => {
    if (file.replaceAll("\\", "/") === "src/lib/payment-transaction-status.ts") return [];
    if (file.replaceAll("\\", "/") === "src/lib/booking-payment-state.ts") return [];
    const matches: string[] = [];
    const code = stripComments(source);
    for (const receiver of copiedListReceivers) {
      for (const match of code.matchAll(receiver)) {
        const values = receiver === namedArray
          ? match[2]
          : receiver === inlineDisjunction
            ? match.slice(2).join(" ")
            : match[1] ?? match[0];
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

const AGGREGATE_CAPTURED_STATUS_AUTHORITY_READERS = new Set([
  "src/app/api/bookings/[id]/guests/route.ts",
  "src/lib/additional-payment-ask.ts",
  "src/lib/admin-reports.ts",
  "src/lib/booking-delete.ts",
  "src/lib/finance-booking-metrics.ts",
  "src/lib/xero-booking-edit-conditions.ts",
  "src/lib/xero-booking-invoices.ts",
]);

function unregisteredAggregateCapturedStatusReaders(files: readonly SourceFile[]): string[] {
  // This is a complete measured registry of production importers of the
  // aggregate authority. It permits modules that legitimately read both
  // aggregate and transaction status, while an arbitrary new transaction
  // reader cannot silently import the wrong home.
  return files
    .filter(({ file, source }) =>
      file.replaceAll("\\", "/") !== "src/lib/booking-payment-state.ts" &&
      /\b(?:isCapturedPaymentStatus|CAPTURED_PAYMENT_STATUS_LIST)\b/.test(stripComments(source)) &&
      !AGGREGATE_CAPTURED_STATUS_AUTHORITY_READERS.has(file.replaceAll("\\", "/")),
    )
    .map(({ file }) => file);
}

function aggregateCapturedStatusAuthorityReaders(files: readonly SourceFile[]): string[] {
  return files
    .filter(({ file, source }) =>
      file.replaceAll("\\", "/") !== "src/lib/booking-payment-state.ts" &&
      /\b(?:isCapturedPaymentStatus|CAPTURED_PAYMENT_STATUS_LIST)\b/.test(stripComments(source)),
    )
    .map(({ file }) => file.replaceAll("\\", "/"))
    .sort();
}

describe("INV-SSOT: captured Payment and PaymentTransaction status guard (#3606, #3632)", () => {
  it("rejects handwritten captured triples and unregistered aggregate authority readers", () => {
    expect(handwrittenCapturedTransactionStatusLists(productionSourceFiles())).toEqual([]);
    expect(aggregateCapturedStatusAuthorityReaders(productionSourceFiles())).toEqual(
      [...AGGREGATE_CAPTURED_STATUS_AUTHORITY_READERS].sort(),
    );
    expect(unregisteredAggregateCapturedStatusReaders(productionSourceFiles())).toEqual([]);
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
        {
          file: "src/lib/mutated-payment-transaction-inline-reordered.ts",
          source:
            "if (paymentTransaction.status === PaymentStatus.REFUNDED || paymentTransaction.status === PaymentStatus.SUCCEEDED || paymentTransaction.status === PaymentStatus.PARTIALLY_REFUNDED) {}",
        },
        {
          file: "src/lib/mutated-payment-transaction-inline-includes.ts",
          source:
            "if (['REFUNDED', 'SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(paymentTransaction.status)) {}",
        },
      ]),
    ).toEqual([
      "src/lib/mutated-payment-transaction-reader.ts",
      "src/lib/mutated-payment-transaction-set.ts",
      "src/lib/mutated-payment-transaction-string-set.ts",
      "src/lib/mutated-payment-transaction-array.ts",
      "src/lib/mutated-payment-transaction-string-array.ts",
      "src/lib/mutated-payment-transaction-inline.ts",
      "src/lib/mutated-payment-transaction-inline-reordered.ts",
      "src/lib/mutated-payment-transaction-inline-includes.ts",
    ]);
  });

  it("rejects an inline captured-status copy written to disk", () => {
    const directory = mkdtempSync(join(tmpdir(), "captured-status-guard-"));
    try {
      writeFileSync(
        join(directory, "mutated-reader.ts"),
        "if (transaction.status === 'REFUNDED' || transaction.status === 'PARTIALLY_REFUNDED' || transaction.status === 'SUCCEEDED') {}",
      );

      expect(handwrittenCapturedTransactionStatusLists(productionSourceFiles(directory))).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects aggregate authority in an arbitrary transaction reader written to disk", () => {
    const directory = mkdtempSync(join(tmpdir(), "aggregate-status-authority-"));
    try {
      writeFileSync(
        join(directory, "third-transaction-reader.ts"),
        "import { isCapturedPaymentStatus } from '@/lib/booking-payment-state'; export const captured = (transaction: { status: string }) => isCapturedPaymentStatus(transaction.status);",
      );
      expect(unregisteredAggregateCapturedStatusReaders(productionSourceFiles(directory))).toEqual([
        relative(process.cwd(), join(directory, "third-transaction-reader.ts")),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("permits an explicitly registered module that reads both authorities", () => {
    expect(unregisteredAggregateCapturedStatusReaders([
      {
        file: "src/lib/admin-reports.ts",
        source: "import { isCapturedPaymentStatus } from '@/lib/booking-payment-state'; import { isCapturedTransactionStatus } from '@/lib/payment-transaction-status';",
      },
    ])).toEqual([]);
  });
});
