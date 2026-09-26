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
 * The receiver is intentional: the same three names remain legitimate when
 * they describe an aggregate `Payment.status`, while this guard ratchets only
 * `PaymentTransaction.status` Prisma readers toward the transaction leaf.
 */
function handwrittenCapturedTransactionStatusLists(files: readonly SourceFile[]): string[] {
  const receiver = /status\s*:\s*\{\s*in\s*:\s*\[([\s\S]{0,500}?)\]\s*\}/g;
  return files.flatMap(({ file, source }) => {
    const matches: string[] = [];
    for (const match of stripComments(source).matchAll(receiver)) {
      const values = match[1];
      if (CAPTURED_STATUS_NAMES.every((status) => new RegExp(`\\b(?:PaymentStatus\\.)?${status}\\b`).test(values))) {
        matches.push(file);
      }
    }
    return matches;
  });
}

describe("INV-SSOT: captured PaymentTransaction status-list guard (#3606)", () => {
  it("routes every captured transaction Prisma receiver through the status leaf", () => {
    expect(handwrittenCapturedTransactionStatusLists(productionSourceFiles())).toEqual([]);
  });

  it("fails a new hand-written captured transaction receiver", () => {
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
      ]),
    ).toEqual(["src/lib/mutated-payment-transaction-reader.ts"]);
  });
});
