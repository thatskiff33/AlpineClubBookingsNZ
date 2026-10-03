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
          // Full status vocabularies contain other members. One distinct
          // operational list is exempt by exact name: Admin > Payments' "is a
          // Xero invoice expected for this payment?" (#2377). It is an invoice
          // question that may diverge from capture, so it keeps its own home.
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

/**
 * Every production importer of the AGGREGATE authority, with the `Payment`
 * receiver it reads. A module reading `PaymentTransaction.status` asks
 * `payment-transaction-status.ts` instead; registering a module here is the
 * claim that its reader is an aggregate `Payment` row (#3503, #3632).
 */
const AGGREGATE_CAPTURED_STATUS_AUTHORITY_READERS = new Map([
  ["src/app/api/bookings/[id]/guests/route.ts", "booking.payment.status (guest-add collection)"],
  ["src/lib/additional-payment-ask.ts", "census SQL over payment.status"],
  ["src/lib/admin-reports.ts", "payment.status in summarizeNetCollectedCash"],
  ["src/lib/booking-delete.ts", "payment.status in hasCapturedOrCreditedPayment"],
  ["src/lib/finance-booking-metrics.ts", "payment.status for capturedGrossCents"],
  ["src/lib/refunded-total-shortfall-audit.ts", "Prisma payment.findMany status filter"],
  ["src/lib/xero-booking-edit-conditions.ts", "primary-invoice payment.status"],
  ["src/lib/xero-booking-invoices.ts", "booking.payment.status for allocation and invoice payment"],
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

/**
 * Receiver check at the call site: the transaction predicate handed an
 * aggregate `payment.status`, or the aggregate predicate handed a
 * transaction's status. Both spell the same values today, so only the receiver
 * shows the wrong question being asked (#3632).
 */
function crossedStatusAuthorityCalls(files: readonly SourceFile[]): string[] {
  const transactionLeafOnPayment =
    /\bisCapturedTransactionStatus\(\s*(?:[\w?.]+\.)?payment\??\.status\b/;
  const aggregateLeafOnTransaction =
    /\bisCapturedPaymentStatus\(\s*[\w?.]*(?:transaction|Transaction)[\w?.]*\.status\b/;
  return files
    .filter(({ source }) => {
      const code = stripComments(source);
      return transactionLeafOnPayment.test(code) || aggregateLeafOnTransaction.test(code);
    })
    .map(({ file }) => file);
}

describe("INV-SSOT: captured Payment and PaymentTransaction status guard (#3606, #3632)", () => {
  it("rejects handwritten captured triples and unregistered aggregate authority readers", () => {
    expect(handwrittenCapturedTransactionStatusLists(productionSourceFiles())).toEqual([]);
    expect(aggregateCapturedStatusAuthorityReaders(productionSourceFiles())).toEqual(
      [...AGGREGATE_CAPTURED_STATUS_AUTHORITY_READERS.keys()].sort(),
    );
    expect(unregisteredAggregateCapturedStatusReaders(productionSourceFiles())).toEqual([]);
    expect(crossedStatusAuthorityCalls(productionSourceFiles())).toEqual([]);
  }, 15000);

  it("rejects either predicate handed the other receiver", () => {
    expect(crossedStatusAuthorityCalls([
      { file: "src/lib/a.ts", source: "isCapturedTransactionStatus(booking.payment.status)" },
      { file: "src/lib/b.ts", source: "isCapturedTransactionStatus(booking.payment?.status ?? '')" },
      { file: "src/lib/c.ts", source: "isCapturedPaymentStatus(paymentTransaction.status)" },
      { file: "src/lib/d.ts", source: "isCapturedPaymentStatus(transaction.status)" },
      { file: "src/lib/ok.ts", source: "isCapturedTransactionStatus(paymentTransaction.status); isCapturedPaymentStatus(payment.status)" },
    ])).toEqual(["src/lib/a.ts", "src/lib/b.ts", "src/lib/c.ts", "src/lib/d.ts"]);
  });

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
