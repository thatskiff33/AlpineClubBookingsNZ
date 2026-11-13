import ts from "typescript";
import { describe, expect, it } from "vitest";

import { readNonTestSources } from "./support/advisory-lock-scan";
import { scanLock1Transactions, type TransactionOpener } from "./support/lock1-transaction-scan";
import { stripComments } from "./support/strip-comments";

/**
 * `INV-LOCK-005`: every interactive transaction that waits for
 * `pg_advisory_xact_lock(1)` runs on `LOCK1_HOLDER_TRANSACTION_BUDGET`
 * (`src/lib/db-transaction.ts`). Prisma counts the advisory wait against the
 * transaction's budget, so a writer left on the 2 s / 5 s defaults fails with
 * P2028 whenever a long holder of the key is running.
 *
 * The reader (`support/lock1-transaction-scan.ts`) starts from the INV-LOCK-003
 * site list and follows each wait out to the transaction that opens it, through
 * named helpers and the modules that import them. This census then accepts an
 * opener's options only as:
 *
 * - the constant itself, or a `const` that is exactly the constant;
 * - `{ ...LOCK1_HOLDER_TRANSACTION_BUDGET, isolationLevel: ... }`, so a writer
 *   that needs an isolation level keeps the budget and cannot override it;
 * - an explicit exception: a comment inside the options argument reading
 *   `INV-LOCK-005 exception:` followed by the reason.
 *
 * The classified list is `docs/audits/lock1-transaction-budgets.md`.
 */

const CONSTANT = "LOCK1_HOLDER_TRANSACTION_BUDGET";
const EXCEPTION_MARKER = /INV-LOCK-005 exception:(.*)$/;
/** A reason shorter than this is a placeholder, not a reason. */
const MIN_EXCEPTION_REASON_LENGTH = 40;

/**
 * Functions that wait for lock(1) in a caller's transaction but that nothing in
 * `src/` calls yet, so the reader cannot reach an opener. Each needs a reason;
 * the test below fails once a caller appears, so the entry cannot go stale.
 */
const UNREACHED_ALLOWED: Readonly<Record<string, string>> = {
  "src/lib/edit-financial-review.ts::raiseEditFinancialReviewTask":
    "Joins its caller's transaction and refuses the root client; no edit path calls it yet, so whichever caller lands is scanned then.",
};

const sources = readNonTestSources();
const scan = scanLock1Transactions(sources);

function withoutComments(text: string): string {
  return stripComments(text).replace(/\s+/g, " ").trim();
}

/** Every `const X = LOCK1_HOLDER_TRANSACTION_BUDGET;` in the tree: another name for the budget. */
function budgetAliases(): Set<string> {
  const aliases = new Set([CONSTANT]);
  const pattern = new RegExp(`\\bconst\\s+([A-Z][A-Z0-9_]*)\\s*=\\s*${CONSTANT}\\s*;`, "g");
  for (const { text } of sources) {
    for (const match of withoutComments(text).matchAll(pattern)) aliases.add(match[1]);
  }
  return aliases;
}

type Verdict = "budget" | "exception" | string;

/**
 * The text of every comment in `text`, joined into one line. TypeScript's own
 * scanner finds them, so a comment marker inside a string is not one.
 */
function commentText(text: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const comments: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const token = scanner.getTokenText();
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia) comments.push(token.slice(2));
    if (kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      comments.push(token.slice(2, -2).replace(/^\s*\*/gm, ""));
    }
  }
  return comments.join(" ").replace(/\s+/g, " ");
}

function classifyOptions(options: string | null, aliases: ReadonlySet<string>): Verdict {
  if (options === null) return "no options: Prisma's 2 s / 5 s defaults";
  // The marker must sit in a comment inside the options argument; the reason
  // may run over several comment lines.
  const exception = EXCEPTION_MARKER.exec(commentText(options));
  if (exception) {
    return exception[1].trim().length >= MIN_EXCEPTION_REASON_LENGTH ? "exception" : "exception without a reason";
  }
  const code = withoutComments(options);
  if (aliases.has(code)) return "budget";
  const spread = /^\{ ?\.\.\.([A-Z][A-Z0-9_]*), isolationLevel: [^,{}]+,? ?\}$/.exec(code);
  if (spread && aliases.has(spread[1])) return "budget";
  return `options other than the shared budget: ${code}`;
}

const describeOpener = (opener: TransactionOpener) =>
  `${opener.rel}:${opener.line} ${opener.opener} via ${opener.via.join(" <- ")}`;

describe("INV-LOCK-005: every lock(1) waiter runs on the shared transaction budget", () => {
  const aliases = budgetAliases();

  it("finds the lock(1) transactions it is meant to police", () => {
    // A reader that silently finds nothing would pass every assertion below.
    expect(scan.openers.length).toBeGreaterThan(100);
    expect(scan.joinedFunctions.length).toBeGreaterThan(10);
    const files = new Set(scan.openers.map((opener) => opener.rel));
    for (const known of [
      "src/lib/booking-create.ts",
      "src/lib/bed-allocation-range-assign.ts",
      "src/lib/group-settlement.ts",
      "src/lib/booking-cancel.ts",
    ]) {
      expect(files, known).toContain(known);
    }
  });

  it("opens each one with the budget, an alias of it, or a reasoned exception", () => {
    const offenders = scan.openers
      .map((opener) => ({ opener, verdict: classifyOptions(opener.options, aliases) }))
      .filter(({ verdict }) => verdict !== "budget" && verdict !== "exception")
      .map(({ opener, verdict }) => `${describeOpener(opener)}: ${verdict}`);
    expect(offenders).toEqual([]);
  });

  it("never waits for lock(1) through withStoreTransaction, which takes no options", () => {
    const offenders = scan.openers.filter((opener) => opener.opener === "withStoreTransaction").map(describeOpener);
    expect(offenders).toEqual([]);
  });

  it("reaches an opener from every lock(1) wait, bar the reasoned allowlist", () => {
    expect([...scan.unreached].sort()).toEqual(Object.keys(UNREACHED_ALLOWED).sort());
  });

  it("keeps the alias list to plain renames of the constant", () => {
    // `budgetAliases` only admits `const X = LOCK1_HOLDER_TRANSACTION_BUDGET;`,
    // so a copied literal cannot pass as an alias. The two the tree names today:
    expect([...aliases].sort()).toEqual(
      [CONSTANT, "ADDITIONAL_ASK_QUEUE_TRANSACTION_OPTIONS", "LINKED_MOVE_TRANSACTION_BUDGET"].sort(),
    );
  });
});

describe("the census's option classifier", () => {
  const aliases = new Set([CONSTANT, "ALIAS"]);

  it("accepts the constant, an alias and the isolation-level spread", () => {
    expect(classifyOptions(CONSTANT, aliases)).toBe("budget");
    expect(classifyOptions("// why\n    ALIAS", aliases)).toBe("budget");
    expect(classifyOptions(`{ ...${CONSTANT}, isolationLevel: "Serializable" }`, aliases)).toBe("budget");
  });

  it("refuses defaults, copied literals and overrides in the spread", () => {
    expect(classifyOptions(null, aliases)).not.toMatch(/^budget$|^exception$/);
    expect(classifyOptions("{ maxWait: 10_000, timeout: 30_000 }", aliases)).not.toMatch(/^budget$|^exception$/);
    expect(classifyOptions(`{ ...${CONSTANT}, timeout: 5_000 }`, aliases)).not.toMatch(/^budget$|^exception$/);
    expect(
      classifyOptions(`{ ...${CONSTANT}, isolationLevel: "Serializable", maxWait: 1 }`, aliases),
    ).not.toMatch(/^budget$|^exception$/);
    expect(classifyOptions("OTHER_OPTIONS", aliases)).not.toMatch(/^budget$|^exception$/);
  });

  it("accepts an exception only with a substantive reason", () => {
    expect(
      classifyOptions(
        "// INV-LOCK-005 exception: Stripe's delivery timeout caps this webhook\n    // handler below the shared budget.\n    { maxWait: 5_000, timeout: 10_000 }",
        aliases,
      ),
    ).toBe("exception");
    expect(classifyOptions("// INV-LOCK-005 exception: tbd\n    { timeout: 1 }", aliases)).toBe(
      "exception without a reason",
    );
  });
});

describe("tracing a lock wait to its transaction budget", () => {
  const lock = "await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;";

  it("finds defaults through an imported helper and a named transaction callback", () => {
    const result = scanLock1Transactions([
      {
        rel: "src/lib/writer.ts",
        text: `export async function write(tx) { ${lock} }`,
      },
      {
        rel: "src/lib/service.ts",
        text: `import { write as save } from "@/lib/writer";
          async function run(tx) { await save(tx); }
          export async function execute() { return prisma.$transaction(run); }`,
      },
    ]);

    expect(result.unreached).toEqual([]);
    expect(result.openers).toHaveLength(1);
    expect(result.openers[0]).toMatchObject({
      rel: "src/lib/service.ts",
      opener: "$transaction",
      options: null,
    });
    expect(result.joinedFunctions).toEqual([
      "src/lib/writer.ts::write",
      "src/lib/service.ts::run",
    ]);
  });

  it("checks every caller of a joined writer, including optional-transaction wrappers", () => {
    const result = scanLock1Transactions([
      {
        rel: "src/lib/writer.ts",
        text: `export async function write(tx) { ${lock} }`,
      },
      {
        rel: "src/lib/service.ts",
        text: `import { write } from "./writer";
          export async function first() {
            return prisma.$transaction(async tx => write(tx), LOCK1_HOLDER_TRANSACTION_BUDGET);
          }
          export async function second(tx) {
            return withOptionalTransaction(tx, async inner => write(inner));
          }`,
      },
    ]);

    expect(result.unreached).toEqual([]);
    expect(result.openers.map(({ opener, options }) => ({ opener, options }))).toEqual([
      { opener: "$transaction", options: CONSTANT },
      { opener: "withOptionalTransaction", options: null },
    ]);
  });

  it("reports a joined writer with no caller instead of silently approving it", () => {
    const result = scanLock1Transactions([
      { rel: "src/lib/writer.ts", text: `export async function write(tx) { ${lock} }` },
    ]);

    expect(result.openers).toEqual([]);
    expect(result.unreached).toEqual(["src/lib/writer.ts::write"]);
  });
});
