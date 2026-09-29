import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #3635 (F3, F4, `INV-SSOT`): "has this money been captured?" has two homes,
 * one per question. `CAPTURED_PAYMENT_STATUS_LIST` (`booking-payment-state.ts`)
 * asks it of the aggregate `Payment`; `isCapturedTransactionStatus`
 * (`payment-transaction-status.ts`) asks it of one `PaymentTransaction` row.
 *
 * The concurrent #3606 guard (`payment-transaction-status-list-guard.test.ts`,
 * wave #3503) matches a hand-written triple in a Prisma `status.in`, a `Set`
 * or a named array. It cannot see a membership test on an ANONYMOUS array —
 * `[SUCCEEDED, REFUNDED, PARTIALLY_REFUNDED].includes(row.status)` — which is
 * the copy #3643 wrote into the part-payment cancel claim. This guard covers
 * exactly that receiver and nothing the #3606 guard covers, so the two compose
 * rather than overlap; fold it into that guard once both are on `main`.
 */
const SOURCE_ROOT = join(process.cwd(), "src");
const CAPTURED = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;
const ANONYMOUS_INCLUDES = /\[([^[\]]{0,300})\]\s*\.includes\s*\(/g;

type SourceFile = { readonly file: string; readonly source: string };

function productionSourceFiles(directory = SOURCE_ROOT): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : productionSourceFiles(absolute);
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name)) return [];
    return [
      {
        file: relative(process.cwd(), absolute).replaceAll("\\", "/"),
        source: readFileSync(absolute, "utf8"),
      },
    ];
  });
}

function inlineCapturedIncludes(files: readonly SourceFile[]): string[] {
  return files.flatMap(({ file, source }) =>
    [...source.matchAll(ANONYMOUS_INCLUDES)]
      .filter(([, values]) =>
        CAPTURED.every((status) =>
          new RegExp(`\\b(?:PaymentStatus\\.)?${status}\\b`).test(values),
        ),
      )
      .map(() => file),
  );
}

describe("INV-SSOT: captured-status lists are read from their one home (#3635)", () => {
  it("no production file tests membership in an anonymous captured-status triple", () => {
    expect(
      inlineCapturedIncludes(productionSourceFiles()),
      "Use isCapturedTransactionStatus (one PaymentTransaction row) or CAPTURED_PAYMENT_STATUS_LIST (the aggregate Payment).",
    ).toEqual([]);
  }, 15000);

  it("catches the anonymous-array shape in either spelling", () => {
    expect(
      inlineCapturedIncludes([
        {
          file: "src/lib/mutated-enum.ts",
          source:
            "rows.some((row) => [PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED].includes(row.status));",
        },
        {
          file: "src/lib/mutated-string.ts",
          source: 'const hit = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(status);',
        },
        {
          // Two of the three is a different question and is left alone.
          file: "src/lib/not-captured.ts",
          source: 'const hit = ["SUCCEEDED", "REFUNDED"].includes(status);',
        },
      ]),
    ).toEqual(["src/lib/mutated-enum.ts", "src/lib/mutated-string.ts"]);
  });

  it("the refunded-total shortfall audit reads the aggregate's one captured list (F3)", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/refunded-total-shortfall-audit.ts"),
      "utf8",
    );
    expect(source).toMatch(
      /import\s*\{\s*CAPTURED_PAYMENT_STATUS_LIST\s*\}\s*from\s*"@\/lib\/booking-payment-state"/,
    );
    expect(source).toMatch(/status:\s*\{\s*in:\s*\[\.\.\.CAPTURED_PAYMENT_STATUS_LIST\]\s*\}/);
  });
});
