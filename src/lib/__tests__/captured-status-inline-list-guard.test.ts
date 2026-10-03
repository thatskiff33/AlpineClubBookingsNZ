import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

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
 * exactly that receiver — bare, or parenthesised with a cast as TypeScript
 * usually spells it (`([...] as const).includes(`) — and nothing the #3606
 * guard covers, so the two compose rather than overlap; fold it into that
 * guard once both are on `main`. Comments are stripped first with the one
 * `stripComments` (`INV-SSOT-004`), so a comment recording the removed copy
 * does not trip it.
 */
const SOURCE_ROOT = join(process.cwd(), "src");
const CAPTURED = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;
const ANONYMOUS_INCLUDES =
  /\[([^[\]]{0,300})\](?:\s+as\s+[^()]{0,120})?\s*\)?\s*\.includes\s*\(/g;

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
    [...stripComments(source).matchAll(ANONYMOUS_INCLUDES)]
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
          file: "src/lib/mutated-as-const.ts",
          source:
            "const hit = ([PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED] as const).includes(status);",
        },
        {
          file: "src/lib/mutated-as-array.ts",
          source:
            'const hit = (["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] as PaymentStatus[]).includes(status);',
        },
        {
          // A comment recording the removed copy is history, not a copy.
          file: "src/lib/comment-only.ts",
          source:
            [
              "// was: [SUCCEEDED, REFUNDED, PARTIALLY_REFUNDED].includes(row.status)",
              "/* ([SUCCEEDED, REFUNDED, PARTIALLY_REFUNDED] as const).includes(s) */",
              "const ok = true;",
            ].join("\n"),
        },
        {
          // Two of the three is a different question and is left alone.
          file: "src/lib/not-captured.ts",
          source: 'const hit = ["SUCCEEDED", "REFUNDED"].includes(status);',
        },
      ]),
    ).toEqual([
      "src/lib/mutated-enum.ts",
      "src/lib/mutated-string.ts",
      "src/lib/mutated-as-const.ts",
      "src/lib/mutated-as-array.ts",
    ]);
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

  /*
    #3637: the finance dashboard's `FINANCE_CAPTURED_PAYMENT_STATUSES` and the
    Xero invoice module's `STRIPE_CAPTURED_PAYMENT_STATUSES` were NAMED `Set`
    copies of the trio - a shape the anonymous-`.includes` scan above cannot
    see. Any array literal that spells exactly the trio (a `Set`, a named
    constant, a Prisma `status.in`) fails here; Finance's all-status
    `PAYMENT_STATUS_KEYS` is not the trio and is left alone.
  */
  function spellsTheCapturedTrio(source: string): boolean {
    return [...stripComments(source).matchAll(/\[([^[\]]{0,300})\]/g)].some(
      ([, values]) => {
        const members = values
          .split(",")
          .map((value) => value.trim().replace(/^PaymentStatus\.|["'`]/g, ""))
          .filter(Boolean);
        return (
          members.length === CAPTURED.length &&
          CAPTURED.every((status) => members.includes(status))
        );
      },
    );
  }

  function productionSource(file: string): string {
    return readFileSync(join(process.cwd(), file), "utf8");
  }

  it("finance metrics and Xero invoices ask the one captured list, not a copy (#3637)", () => {
    const finance = productionSource("src/lib/finance-booking-metrics.ts");
    const xero = productionSource("src/lib/xero-booking-invoices.ts");
    expect(spellsTheCapturedTrio(finance), "finance-booking-metrics.ts").toBe(false);
    expect(spellsTheCapturedTrio(xero), "xero-booking-invoices.ts").toBe(false);
    // Finance's captured question is Net collected, asked of the shared fold.
    expect(stripComments(finance)).toMatch(
      /import\s*\{[^}]*\bsummarizeNetCollectedWithLedgerGap\b[^}]*\}\s*from\s*"@\/lib\/additional-ledger-gap"/,
    );
    expect(stripComments(xero)).toMatch(
      /import\s*\{[^}]*\bisCapturedPaymentStatus\b[^}]*\}\s*from\s*"@\/lib\/booking-payment-state"/,
    );
  });

  it("catches the named-Set shapes #3637 removed", () => {
    expect(
      [
        [
          "const FINANCE_CAPTURED_PAYMENT_STATUSES = new Set<PaymentStatus>([",
          "  PaymentStatus.SUCCEEDED,",
          "  PaymentStatus.PARTIALLY_REFUNDED,",
          "  PaymentStatus.REFUNDED,",
          "]);",
        ].join("\n"),
        'const STRIPE_CAPTURED_PAYMENT_STATUSES = new Set<string>(["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"]);',
        "where: { status: { in: [PaymentStatus.REFUNDED, PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED] } }",
        // History in a comment, a pair, and the all-status list are not copies.
        '// was: new Set(["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"])',
        'const pair = ["SUCCEEDED", "REFUNDED"];',
        'const all = ["PENDING", "SUCCEEDED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED", "CANCELLED"];',
      ].map(spellsTheCapturedTrio),
    ).toEqual([true, true, true, false, false, false]);
  });
});
