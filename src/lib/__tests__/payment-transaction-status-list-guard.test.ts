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
 * arrays later spread into either. #3632 owns the existing aggregate finance
 * set and removes this exact exception when it replaces that set with the
 * aggregate predicate. The canonical transaction definition is exempt.
 */
function handwrittenCapturedTransactionStatusLists(files: readonly SourceFile[]): string[] {
  const namedEnumArray = /(?:export\s+)?const\s+\w+(?:\s*:\s*[^=\n]+)?\s*=\s*\[([\s\S]{0,500}?)\]/g;
  const copiedListReceivers = [
    /status\s*:\s*\{\s*in\s*:\s*\[([\s\S]{0,500}?)\]\s*\}/g,
    /new\s+Set(?:<\s*PaymentStatus\s*>)?\s*\(\s*\[([\s\S]{0,500}?)\]\s*\)/g,
    namedEnumArray,
  ];
  return files.flatMap(({ file, source }) => {
    if (file.replaceAll("\\", "/") === "src/lib/payment-transaction-status.ts") return [];
    if (file.replaceAll("\\", "/") === "src/lib/booking-payment-state.ts") return [];
    const matches: string[] = [];
    const code = stripComments(source);
    for (const receiver of copiedListReceivers) {
      for (const match of code.matchAll(receiver)) {
        const values = match[1];
        if (receiver === namedEnumArray) {
          // Status vocabularies and Xero aggregate strings are different lists.
          // The copied transaction-list form uses exactly these enum members.
          const enumMembers = values.match(/\bPaymentStatus\.[A-Z_]+\b/g) ?? [];
          if (enumMembers.length !== CAPTURED_STATUS_NAMES.length) continue;
        }
        const declaration = code.slice(Math.max(0, match.index - 64), match.index);
        const knownAggregateFinanceSet =
          file.replaceAll("\\", "/") === "src/lib/finance-booking-metrics.ts" &&
          /const\s+FINANCE_CAPTURED_PAYMENT_STATUSES\s*=\s*$/.test(declaration);
        if (knownAggregateFinanceSet) continue;
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
          file: "src/lib/mutated-payment-transaction-array.ts",
          source:
            "const CAPTURED = [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED]; const where = { status: { in: [...CAPTURED] } };",
        },
      ]),
    ).toEqual([
      "src/lib/mutated-payment-transaction-reader.ts",
      "src/lib/mutated-payment-transaction-set.ts",
      "src/lib/mutated-payment-transaction-array.ts",
    ]);
  });
});
