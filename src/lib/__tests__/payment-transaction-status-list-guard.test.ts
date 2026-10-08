import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

/**
 * Every tree that holds production code a captured-status copy could be
 * written into. `prisma/migrations` is skipped: it is SQL history, never
 * edited, and the walk reads script-language files only.
 */
const SCANNED_ROOTS = ["src", "scripts", "prisma"].map((root) => join(process.cwd(), root));
const SKIPPED_DIRECTORIES = new Set(["__tests__", "node_modules", "migrations"]);
const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

/**
 * A total would say the walk was big; these say it reached the right places.
 * Add any one of them to `SKIPPED_DIRECTORIES` (or drop a root) and the guard
 * fails naming the subtree it stopped reading, instead of reporting clean over
 * a fraction of the tree.
 */
const REQUIRED_SCANNED_SUBTREES = [
  "src/app",
  "src/components",
  "src/lib",
  "src/lib/xero-inbound",
  "scripts",
  "scripts/ci",
  "prisma",
  "prisma/migration-verification",
] as const;

const CAPTURED_STATUS_NAMES = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;
/** Every `PaymentStatus` member, matched as a bare word whatever spells it. */
const PAYMENT_STATUS_TOKEN = /\b(PENDING|PROCESSING|SUCCEEDED|FAILED|REFUNDED|PARTIALLY_REFUNDED)\b/g;

type SourceFile = { readonly file: string; readonly source: string };

function productionSourceFiles(roots: readonly string[] = SCANNED_ROOTS): SourceFile[] {
  return roots.flatMap((directory) =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        return SKIPPED_DIRECTORIES.has(entry.name) ? [] : productionSourceFiles([absolute]);
      }
      if (!SOURCE_EXTENSION.test(entry.name)) return [];
      return [{
        file: relative(process.cwd(), absolute).replaceAll("\\", "/"),
        source: readFileSync(absolute, "utf8"),
      }];
    }),
  );
}

function statusSet(text: string): Set<string> {
  return new Set([...text.matchAll(PAYMENT_STATUS_TOKEN)].map((match) => match[1]));
}

/**
 * Exactly the captured three, by set. A superset (captured plus PROCESSING, the
 * full six-member vocabulary) is a different question and is not flagged; a
 * fourth NON-status term is ignored, so it cannot hide a copy.
 */
function isExactlyCaptured(statuses: ReadonlySet<string>): boolean {
  return statuses.size === CAPTURED_STATUS_NAMES.length &&
    CAPTURED_STATUS_NAMES.every((status) => statuses.has(status));
}

type CopyShape = "list" | "comparison-chain" | "switch" | "object-map" | "sql-in";
type CapturedStatusCopy = {
  readonly file: string;
  readonly shape: CopyShape;
  /** The code from the previous `;` up to the end of the copy. */
  readonly statement: string;
};

/**
 * One spelling of a single status as a comparison operand: an enum member under
 * any namespace (`PaymentStatus.`, `Prisma.PaymentStatus.`,
 * `$Enums.PaymentStatus.`) or a quoted / backtick string.
 */
const STATUS_LITERAL =
  String.raw`(?:(?:[\w$]+\.)*PaymentStatus\.(?:SUCCEEDED|PARTIALLY_REFUNDED|REFUNDED|PENDING|PROCESSING|FAILED)\b|["'\x60](?:SUCCEEDED|PARTIALLY_REFUNDED|REFUNDED|PENDING|PROCESSING|FAILED)["'\x60])`;
/** A receiver: a bare identifier, a member chain, optional chaining, `x!.`. */
const OPERAND = String.raw`[\w$](?:[\w$]|\.|[?!]\.)*`;
const COMPARISON = new RegExp(
  String.raw`(${OPERAND})\s*(===?|!==?)\s*(${STATUS_LITERAL})|(${STATUS_LITERAL})\s*(===?|!==?)\s*(${OPERAND})`,
  "g",
);

/**
 * `x === A || x === B || x === C` and its negation `x !== A && x !== B && …`, in
 * any order, with any receiver and any other term mixed in. The unit is a
 * condition: code is cut at `;`, braces, `:` and a ternary `?`, so a status
 * mapping written as a ternary chain or an if/else ladder is not read as one
 * condition.
 */
function comparisonChainCopies(code: string): string[] {
  const conditions = code.split(/[;{}:]|(?<!\?)\?(?![.?])/);
  return conditions.filter((condition) => {
    const byReceiver = new Map<string, Set<string>>();
    for (const match of condition.matchAll(COMPARISON)) {
      const receiver = (match[1] ?? match[6]).replace(/[?!]/g, "");
      const operator = match[2] ?? match[5];
      const literal = match[3] ?? match[4];
      const family = operator.startsWith("!") ? "&&" : "||";
      const key = `${family} ${receiver}`;
      const statuses = byReceiver.get(key) ?? new Set<string>();
      for (const status of statusSet(literal)) statuses.add(status);
      byReceiver.set(key, statuses);
    }
    return [...byReceiver].some(
      ([key, statuses]) => condition.includes(key.slice(0, 2)) && isExactlyCaptured(statuses),
    );
  });
}

function statementEndingAt(code: string, index: number, length: number): string {
  const start = code.lastIndexOf(";", index) + 1;
  return code.slice(start, index + length);
}

/**
 * The shapes a copied captured list has taken or can take. Each one is pinned
 * by a fixture in "fails new hand-written captured readers" below.
 *
 * - list: any bracketed list holding exactly the three — `const`/`let`/`var`,
 *   `Object.freeze([…])`, `new Set<…>([…])`, `[…].includes(<anything>)`,
 *   Prisma `in`/`notIn`, SQL `ARRAY[…]`.
 * - comparison-chain: see `comparisonChainCopies`.
 * - switch: consecutive fall-through `case` labels.
 * - object-map: a status-keyed object whose `true` keys are the three.
 * - sql-in: raw SQL `IN ('SUCCEEDED', …)`, casts included.
 */
function capturedStatusCopies(files: readonly SourceFile[]): CapturedStatusCopy[] {
  return files.flatMap(({ file, source }) => {
    if (file === "src/lib/payment-transaction-status.ts") return [];
    if (file === "src/lib/booking-payment-state.ts") return [];
    const code = stripComments(source);
    const copies: CapturedStatusCopy[] = [];
    const record = (shape: CopyShape, match: RegExpMatchArray) =>
      copies.push({ file, shape, statement: statementEndingAt(code, match.index ?? 0, match[0].length) });

    for (const match of code.matchAll(/\[([^[\]]{0,600})\]/g)) {
      if (isExactlyCaptured(statusSet(match[1]))) record("list", match);
    }
    for (const condition of comparisonChainCopies(code)) {
      copies.push({ file, shape: "comparison-chain", statement: condition.trim() });
    }
    for (const match of code.matchAll(/(?:\bcase\b[^:;{}]*:\s*){2,}/g)) {
      if (isExactlyCaptured(statusSet(match[0]))) record("switch", match);
    }
    for (const match of code.matchAll(/\{([^{}]{0,800})\}/g)) {
      const trueKeys = [...match[1].matchAll(
        /\b(SUCCEEDED|PARTIALLY_REFUNDED|REFUNDED|PENDING|PROCESSING|FAILED)["'\x60]?\s*\]?\s*:\s*true\b/g,
      )].map((entry) => entry[1]);
      if (isExactlyCaptured(new Set(trueKeys))) record("object-map", match);
    }
    for (const match of code.matchAll(/\bIN\s*\(([^()]{0,600})\)/gi)) {
      if (isExactlyCaptured(statusSet(match[1]))) record("sql-in", match);
    }
    return copies;
  });
}

/**
 * The measured copies that are NOT the captured question, each by file, the
 * statement it sits in, and how many there are. The count is exact: a new copy
 * in one of these files, or one of these removed, fails the guard until the
 * list is re-measured.
 */
const NAMED_EXCEPTIONS: ReadonlyArray<{
  readonly file: string;
  readonly statement: RegExp;
  readonly count: number;
  readonly reason: string;
}> = [
  {
    file: "src/lib/admin-operational-state.ts",
    statement: /\bconst\s+XERO_INVOICE_EXPECTED_PAYMENT_STATUSES\s*=/,
    count: 1,
    reason:
      "Admin > Payments' 'is a Xero invoice expected for this payment?' (#2377): an invoice question that may diverge from capture, so it keeps its own home.",
  },
  {
    file: "src/lib/group-settlement.ts",
    statement: /\.groupBookingSettlement\.updateMany\(/,
    count: 3,
    reason:
      "A different record: a status-guarded claim on GroupBookingSettlement.status (#1881) refusing to overwrite a settlement already terminal. It asks 'is this settlement finished?', not 'was this payment captured?'.",
  },
  {
    file: "src/lib/cron-group-settlement-reaper.ts",
    statement: /\.groupBookingSettlement\.updateMany\(/,
    count: 1,
    reason: "The reaper's half of the same GroupBookingSettlement terminal-state claim (#1881).",
  },
];

/** Copies the exceptions do not account for, plus every exception whose measured count no longer holds. */
function unexplainedCapturedStatusCopies(files: readonly SourceFile[]): string[] {
  const copies = capturedStatusCopies(files);
  const unexplained = copies
    .filter((copy) => !NAMED_EXCEPTIONS.some(
      (exception) => exception.file === copy.file && exception.statement.test(copy.statement),
    ))
    .map((copy) => `${copy.file} (${copy.shape})`);
  const scannedFiles = new Set(files.map(({ file }) => file));
  const drifted = NAMED_EXCEPTIONS
    .filter((exception) => scannedFiles.has(exception.file))
    .filter((exception) => copies.filter(
      (copy) => copy.file === exception.file && exception.statement.test(copy.statement),
    ).length !== exception.count)
    .map((exception) => `${exception.file} (exception count drifted from ${exception.count})`);
  return [...unexplained, ...drifted];
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
  ["src/lib/booking-delete.ts", "payment.status in hasCapturedOrCreditedPayment"],
  ["src/lib/booking-ledger-group-child-plan.ts", "a group child's payment.status: which children a settlement paid (#3854)"],
  ["src/lib/booking-ledger-projection-census-classes.ts", "payment.status in nothingCapturedFaceCents (#3583)"],
  ["src/lib/booking-ledger-projection-census-group.ts", "settlement.status: a share's settlement captured, REFUNDED included (#3854 K2)"],
  ["src/lib/booking-ledger-projection-census.ts", "payment.status in hasMoneyColumns (#3583)"],
  ["src/lib/finance-booking-metrics.ts", "payment.status: a change fee is income only once captured (#3750, #3955 F9)"],
  ["src/lib/payment-net-collected.ts", "payment.status in netCollectedPaymentTookMoney (#3372)"],
  ["src/lib/refunded-total-shortfall-audit.ts", "Prisma payment.findMany status filter"],
  ["src/lib/xero-booking-edit-conditions.ts", "primary-invoice payment.status"],
  ["src/lib/xero-booking-invoices.ts", "booking.payment.status for allocation and invoice payment"],
]);

function aggregateCapturedStatusAuthorityReaders(files: readonly SourceFile[]): string[] {
  return files
    .filter(({ file, source }) =>
      file !== "src/lib/booking-payment-state.ts" &&
      /\b(?:isCapturedPaymentStatus|CAPTURED_PAYMENT_STATUS_LIST)\b/.test(stripComments(source)),
    )
    .map(({ file }) => file)
    .sort();
}

function unregisteredAggregateCapturedStatusReaders(files: readonly SourceFile[]): string[] {
  // This is a complete measured registry of production importers of the
  // aggregate authority. It permits modules that legitimately read both
  // aggregate and transaction status, while an arbitrary new transaction
  // reader cannot silently import the wrong home.
  return aggregateCapturedStatusAuthorityReaders(files)
    .filter((file) => !AGGREGATE_CAPTURED_STATUS_AUTHORITY_READERS.has(file));
}

/**
 * Receiver check at the call site: the transaction predicate handed an
 * aggregate `payment.status`, or the aggregate predicate handed a
 * transaction's status. Both spell the same values today, so only the receiver
 * shows the wrong question being asked (#3632).
 *
 * BY NAME ONLY, and that is its whole reach: it reads the argument's spelling,
 * not its type. It catches a receiver whose last segment before `.status` is
 * named `payment` (handed to the transaction leaf) or whose chain names a
 * `transaction` (handed to the aggregate leaf). `hasCapturedPayment(…)` asks
 * the aggregate question of a whole row and type-checks on any `{ status }`, so
 * it is held the same way: handed a value whose chain names a `transaction`, it
 * fails (#3630). A transaction row held in a variable called `row`, `entry` or
 * `p`, or a status first copied into a local, passes. The importer registry above is what bounds the aggregate side
 * structurally; this is a cheap tripwire on top of it, not a type check.
 */
function crossedStatusAuthorityCalls(files: readonly SourceFile[]): string[] {
  const transactionLeafOnPayment =
    /\bisCapturedTransactionStatus\(\s*(?:[\w?.]+\.)?payment\??\.status\b/;
  const aggregateLeafOnTransaction =
    /\bisCapturedPaymentStatus\(\s*[\w?.]*(?:transaction|Transaction)[\w?.]*\.status\b/;
  const aggregateRowPredicateOnTransaction =
    /\bhasCapturedPayment\(\s*[\w?.!]*(?:transaction|Transaction)[\w?.!]*\s*[,)]/;
  return files
    .filter(({ source }) => {
      const code = stripComments(source);
      return transactionLeafOnPayment.test(code) ||
        aggregateLeafOnTransaction.test(code) ||
        aggregateRowPredicateOnTransaction.test(code);
    })
    .map(({ file }) => file);
}

describe("INV-SSOT: captured Payment and PaymentTransaction status guard (#3606, #3632)", () => {
  it("walks every production tree it claims to", () => {
    const scanned = productionSourceFiles().map(({ file }) => file);
    const unreached = REQUIRED_SCANNED_SUBTREES.filter(
      (subtree) => !scanned.some((file) => file.startsWith(`${subtree}/`)),
    );
    expect(unreached).toEqual([]);
  });

  it("rejects handwritten captured triples and unregistered aggregate authority readers", () => {
    const files = productionSourceFiles();
    expect(unexplainedCapturedStatusCopies(files)).toEqual([]);
    // A named exception for a file the walk no longer finds is skipped by the
    // drift count above, so it would sit ready to excuse a copy at a path that
    // is later recreated. Every exception names a file that exists (#3630).
    const scanned = new Set(files.map(({ file }) => file));
    expect(NAMED_EXCEPTIONS.map(({ file }) => file).filter((file) => !scanned.has(file))).toEqual([]);
    expect(aggregateCapturedStatusAuthorityReaders(files)).toEqual(
      [...AGGREGATE_CAPTURED_STATUS_AUTHORITY_READERS.keys()].sort(),
    );
    expect(unregisteredAggregateCapturedStatusReaders(files)).toEqual([]);
    expect(crossedStatusAuthorityCalls(files)).toEqual([]);
  }, 15000);

  it("rejects either predicate handed the other receiver", () => {
    expect(crossedStatusAuthorityCalls([
      { file: "src/lib/a.ts", source: "isCapturedTransactionStatus(booking.payment.status)" },
      { file: "src/lib/b.ts", source: "isCapturedTransactionStatus(booking.payment?.status ?? '')" },
      { file: "src/lib/c.ts", source: "isCapturedPaymentStatus(paymentTransaction.status)" },
      { file: "src/lib/d.ts", source: "isCapturedPaymentStatus(transaction.status)" },
      { file: "src/lib/e.ts", source: "hasCapturedPayment(paymentTransaction)" },
      { file: "src/lib/f.ts", source: "hasCapturedPayment(capturedTransaction!, extra)" },
      { file: "src/lib/ok.ts", source: "isCapturedTransactionStatus(paymentTransaction.status); isCapturedPaymentStatus(payment.status); hasCapturedPayment(child.payment)" },
    ])).toEqual(["src/lib/a.ts", "src/lib/b.ts", "src/lib/c.ts", "src/lib/d.ts", "src/lib/e.ts", "src/lib/f.ts"]);
  });

  it("fails new hand-written captured readers, in every shape", () => {
    const mutations: Record<string, string> = {
      "prisma-in": "const where = { status: { in: [\n  PaymentStatus.SUCCEEDED,\n  PaymentStatus.PARTIALLY_REFUNDED,\n  PaymentStatus.REFUNDED,\n] } };",
      "prisma-not-in": "const where = { status: { notIn: [PaymentStatus.REFUNDED, PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED] } };",
      "set": "const captured = new Set<PaymentStatus>([PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED]);",
      "enums-set": "const captured = new Set<$Enums.PaymentStatus>([$Enums.PaymentStatus.SUCCEEDED, $Enums.PaymentStatus.PARTIALLY_REFUNDED, $Enums.PaymentStatus.REFUNDED]);",
      "string-set": "const captured = new Set<string>([\"SUCCEEDED\", \"PARTIALLY_REFUNDED\", \"REFUNDED\"]);",
      "named-array": "const CAPTURED = [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED]; const where = { status: { in: [...CAPTURED] } };",
      "string-array": "const CAPTURED = [\"SUCCEEDED\", \"PARTIALLY_REFUNDED\", \"REFUNDED\"] as const;",
      "let-array": "let captured: PaymentStatus[] = [PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED];",
      "var-array": "var captured = ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];",
      "frozen-array": "export const CAPTURED = Object.freeze([Prisma.PaymentStatus.SUCCEEDED, Prisma.PaymentStatus.PARTIALLY_REFUNDED, Prisma.PaymentStatus.REFUNDED]);",
      "backtick-array": "const captured = [`SUCCEEDED`, `PARTIALLY_REFUNDED`, `REFUNDED`];",
      "includes-member": "if (['REFUNDED', 'SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(paymentTransaction.status)) {}",
      "includes-bare": "if ([PaymentStatus.REFUNDED, PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED].includes(status)) {}",
      // The two cast spellings #3635's separate guard was written for; folded
      // in here by #3630 once both guards reached `main` together.
      "includes-as-const": "const hit = ([PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED] as const).includes(status);",
      "includes-as-array": "const hit = ([\"SUCCEEDED\", \"PARTIALLY_REFUNDED\", \"REFUNDED\"] as PaymentStatus[]).includes(status);",
      // The exact helper #3632 removed from stripe-webhook-service.ts.
      "bare-parameter-disjunction": "function isCapturedAdditionalPaymentTransaction(status: PaymentStatus) {\n  return (\n    status === PaymentStatus.SUCCEEDED ||\n    status === PaymentStatus.PARTIALLY_REFUNDED ||\n    status === PaymentStatus.REFUNDED\n  );\n}",
      "member-disjunction": "if (paymentTransaction.status === PaymentStatus.SUCCEEDED || paymentTransaction.status === PaymentStatus.PARTIALLY_REFUNDED || paymentTransaction.status === PaymentStatus.REFUNDED) {}",
      "reordered-disjunction": "if (paymentTransaction.status === PaymentStatus.REFUNDED || paymentTransaction.status === PaymentStatus.SUCCEEDED || paymentTransaction.status === PaymentStatus.PARTIALLY_REFUNDED) {}",
      "optional-chaining": "const captured = booking.payment?.status === 'SUCCEEDED' || booking.payment.status === 'PARTIALLY_REFUNDED' || booking.payment?.status === 'REFUNDED';",
      "non-null": "const captured = row!.status === PaymentStatus.SUCCEEDED || row!.status === PaymentStatus.PARTIALLY_REFUNDED || row!.status === PaymentStatus.REFUNDED;",
      "namespaced": "const captured = s === Prisma.PaymentStatus.SUCCEEDED || s === $Enums.PaymentStatus.PARTIALLY_REFUNDED || s === Prisma.PaymentStatus.REFUNDED;",
      "backtick-disjunction": "const captured = status === `SUCCEEDED` || status === `PARTIALLY_REFUNDED` || status === `REFUNDED`;",
      "fourth-term": "const captured = status === 'SUCCEEDED' || row.legacyCaptured || status === 'PARTIALLY_REFUNDED' || status === 'REFUNDED';",
      "yoda": "const captured = PaymentStatus.SUCCEEDED === status || PaymentStatus.PARTIALLY_REFUNDED === status || PaymentStatus.REFUNDED === status;",
      "negated-conjunction": "if (status !== PaymentStatus.SUCCEEDED && status !== PaymentStatus.PARTIALLY_REFUNDED && status !== PaymentStatus.REFUNDED) return;",
      "switch": "switch (status) {\n  case PaymentStatus.SUCCEEDED:\n  case PaymentStatus.PARTIALLY_REFUNDED:\n  case PaymentStatus.REFUNDED:\n    return true;\n  default:\n    return false;\n}",
      "object-map": "const CAPTURED: Partial<Record<PaymentStatus, true>> = { SUCCEEDED: true, PARTIALLY_REFUNDED: true, REFUNDED: true };",
      "full-object-map": "const CAPTURED: Record<PaymentStatus, boolean> = { PENDING: false, PROCESSING: false, [PaymentStatus.SUCCEEDED]: true, FAILED: false, 'REFUNDED': true, \"PARTIALLY_REFUNDED\": true };",
      "sql-in": "await tx.$queryRaw`SELECT 1 FROM \"Payment\" WHERE status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED')`;",
      "sql-in-cast": "const sql = `where p.status in ('SUCCEEDED'::\"PaymentStatus\", 'REFUNDED'::\"PaymentStatus\", 'PARTIALLY_REFUNDED'::\"PaymentStatus\")`;",
      "sql-any-array": "const sql = `WHERE status = ANY(ARRAY['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED']::\"PaymentStatus\"[])`;",
    };
    const files = Object.entries(mutations).map(([name, source]) => ({ file: `src/lib/mutated-${name}.ts`, source }));
    const caught = new Set(unexplainedCapturedStatusCopies(files).map((finding) => finding.replace(/ \(.*$/, "")));
    expect(files.filter(({ file }) => !caught.has(file)).map(({ file }) => file)).toEqual([]);
  });

  it("does not read a different question as a copy", () => {
    // The mapping cases carry an `||` on purpose: without one the connector
    // check alone would pass them, and the condition cut would go untested.
    const negatives: Record<string, string> = {
      "full-vocabulary": "const ALL = ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;",
      "superset": "const where = { status: { in: [PaymentStatus.PROCESSING, PaymentStatus.SUCCEEDED, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED] } };",
      "two-statuses": "const refunded = status === PaymentStatus.REFUNDED || status === PaymentStatus.PARTIALLY_REFUNDED;",
      "different-receivers": "const x = next === PaymentStatus.SUCCEEDED || payment.status === PaymentStatus.REFUNDED || payment.status === PaymentStatus.PARTIALLY_REFUNDED;",
      "ternary-mapping": "const label = status === PaymentStatus.SUCCEEDED || legacy ? 'a' : status === PaymentStatus.REFUNDED ? 'b' : status === PaymentStatus.PARTIALLY_REFUNDED ? 'c' : 'd';",
      "if-else-ladder": "if (status === PaymentStatus.SUCCEEDED || legacy) { a(); } else if (status === PaymentStatus.REFUNDED) { b(); } else if (status === PaymentStatus.PARTIALLY_REFUNDED) { c(); }",
      "mixed-families": "const x = status === PaymentStatus.SUCCEEDED || status !== PaymentStatus.REFUNDED || status === PaymentStatus.PARTIALLY_REFUNDED;",
      "switch-separate-bodies": "switch (status) {\n  case PaymentStatus.SUCCEEDED:\n    return 'a';\n  case PaymentStatus.PARTIALLY_REFUNDED:\n    return 'b';\n  case PaymentStatus.REFUNDED:\n    return 'c';\n}",
      "label-map": "const LABELS = { SUCCEEDED: 'Succeeded', PARTIALLY_REFUNDED: 'Part refunded', REFUNDED: 'Refunded' };",
      "status-assignment": "const data = { status: PaymentStatus.SUCCEEDED }; if (x) data.status = PaymentStatus.REFUNDED; else data.status = PaymentStatus.PARTIALLY_REFUNDED;",
      // A comment recording a removed copy is history, not a copy (`INV-SSOT-004`).
      "comment-only": "// was: [SUCCEEDED, REFUNDED, PARTIALLY_REFUNDED].includes(row.status)\n/* ([SUCCEEDED, REFUNDED, PARTIALLY_REFUNDED] as const).includes(s) */\nconst ok = true;",
    };
    expect(unexplainedCapturedStatusCopies(
      Object.entries(negatives).map(([name, source]) => ({ file: `src/lib/negative-${name}.ts`, source })),
    )).toEqual([]);
  });

  it("holds each named exception to its statement and its measured count", () => {
    const settlementClaim =
      "await tx.groupBookingSettlement.updateMany({ where: { id, status: { notIn: [PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED] } }, data: {} });";
    // The reaper's one measured claim is explained.
    expect(unexplainedCapturedStatusCopies([
      { file: "src/lib/cron-group-settlement-reaper.ts", source: settlementClaim },
    ])).toEqual([]);
    // A second copy in that file is not: the count is exact.
    expect(unexplainedCapturedStatusCopies([
      { file: "src/lib/cron-group-settlement-reaper.ts", source: `${settlementClaim}\n${settlementClaim}` },
    ])).toEqual(["src/lib/cron-group-settlement-reaper.ts (exception count drifted from 1)"]);
    // The same list over a Payment record in an excepted file is a copy.
    expect(unexplainedCapturedStatusCopies([
      {
        file: "src/lib/cron-group-settlement-reaper.ts",
        source: `${settlementClaim}\nawait tx.payment.findMany({ where: { status: { in: [PaymentStatus.SUCCEEDED, PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED] } } });`,
      },
    ])).toEqual(["src/lib/cron-group-settlement-reaper.ts (list)"]);
  });

  it("rejects an inline captured-status copy written to disk", () => {
    const directory = mkdtempSync(join(tmpdir(), "captured-status-guard-"));
    try {
      writeFileSync(
        join(directory, "mutated-reader.ts"),
        "if (transaction.status === 'REFUNDED' || transaction.status === 'PARTIALLY_REFUNDED' || transaction.status === 'SUCCEEDED') {}",
      );

      expect(unexplainedCapturedStatusCopies(productionSourceFiles([directory]))).toHaveLength(1);
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
      expect(unregisteredAggregateCapturedStatusReaders(productionSourceFiles([directory]))).toEqual([
        relative(process.cwd(), join(directory, "third-transaction-reader.ts")).replaceAll("\\", "/"),
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("the refunded-total shortfall audit reads the aggregate's one captured list (#3635 F3)", () => {
    // Folded in from #3635's `captured-status-inline-list-guard.test.ts` (#3630).
    const source = readFileSync(join(process.cwd(), "src/lib/refunded-total-shortfall-audit.ts"), "utf8");
    expect(source).toMatch(
      /import\s*\{\s*CAPTURED_PAYMENT_STATUS_LIST\s*\}\s*from\s*"@\/lib\/booking-payment-state"/,
    );
    expect(source).toMatch(/status:\s*\{\s*in:\s*\[\.\.\.CAPTURED_PAYMENT_STATUS_LIST\]\s*\}/);
  });

  it("finance metrics asks the shared Net Collected fold, not the status list (#3637)", () => {
    // Folded in from #3372's additions to the retired
    // `captured-status-inline-list-guard.test.ts`. Finance (like Reports) no
    // longer reads `Payment.status` itself: its captured question is Net
    // Collected, asked of `summarizeCollectedCash` through the shared fold, so
    // it is not in the aggregate reader registry above.
    const finance = stripComments(
      readFileSync(join(process.cwd(), "src/lib/finance-booking-metrics.ts"), "utf8"),
    );
    expect(finance).toMatch(
      /import\s*\{[^}]*\bsummarizeNetCollectedWithLedgerGap\b[^}]*\}\s*from\s*"@\/lib\/additional-ledger-gap"/,
    );
  });

  it("permits an explicitly registered module that reads both authorities", () => {
    expect(unregisteredAggregateCapturedStatusReaders([
      {
        file: "src/lib/xero-booking-invoices.ts",
        source: "import { isCapturedPaymentStatus } from '@/lib/booking-payment-state'; import { isCapturedTransactionStatus } from '@/lib/payment-transaction-status';",
      },
    ])).toEqual([]);
  });
});
