/**
 * #5228 (`INV-INT-025`): every write that puts a Xero operation row back on
 * PENDING, by file, each with why the request it leaves is one the outbox can
 * claim and send. A row the outbox cannot claim is skipped on every pass and
 * nothing alerts, so a new writer is named here - and, for an outbound row
 * with a queue type, routed through `returnOutboxRowToPending` - before it
 * lands. Enqueues (`startXeroSyncOperation` with `status: "PENDING"`) are not
 * listed: they write the queue type column from the same queued request.
 *
 * #5368: three more shapes are read, from the syntax tree, on every write that
 * can change an existing row of the model (`update`, `updateMany`,
 * `updateManyAndReturn`, `upsert`):
 * - a status that names PENDING any other way - a member such as
 *   `XeroSyncStatus.PENDING`, or one arm of a conditional - counts as a PENDING
 *   write, beside the literal;
 * - a status the source does not spell out - a variable, a call, a `data`
 *   that is not an object literal, or a spread that may carry one - is listed
 *   in `UNREAD_STATUS_WRITERS` with what it can write;
 * - raw SQL that writes the table, under `src`, `scripts` or `prisma` (the
 *   migrations included), is listed in `RAW_SQL_WRITERS`.
 * One of the unread writers, `completeXeroSyncOperation`, takes its status
 * from the completion its caller hands it, so each call is read the same way:
 * a completion that names PENDING fails the census, and one whose status is
 * not spelled at the call (a variable, a builder's result, a spread) is listed
 * in `UNREAD_COMPLETIONS` with what it can carry. What is not read: the inside
 * of a builder or of a wrapper's own callers (each entry says what was read by
 * hand), and a status carried through any other helper.
 *
 * Reads source from disk, so `test:related` cannot select it; run it with
 * `pnpm run test:named` (docs/TESTING.md).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** Each file's count of PENDING writes, with why the request each leaves stays claimable. */
const PENDING_WRITERS: Readonly<Record<string, { writes: number; why: string }>> = {
  "src/lib/xero-outbox-pending-request.ts": {
    writes: 1,
    why: "the one guarded write: the outbox's cooldown and busy-wait give-backs, every Retry requeue and the kept late-capture requeues go through it",
  },
  "src/lib/xero-supplementary-invoice-revive.ts": {
    writes: 1,
    why: "a retired supplementary invoice revived CANCELLED -> PENDING, matched on its queue type column, refused when its request does not read as one",
  },
  "src/lib/xero-operation-outbox.ts": {
    writes: 1,
    why: "releaseWaitingSupplementaryInvoiceOperations: WAITING_PAYMENT rows were never dispatched, so they hold the queued request their enqueue wrote",
  },
  "src/lib/organiser-extra-netting.ts": {
    writes: 1,
    why: "releaseOrganiserExtraRefundNotes: WAITING_PAYMENT rows, never dispatched, holding their enqueue's queued request",
  },
  "src/lib/xero-operation-queue.ts": {
    writes: 1,
    why: "an officer's REQUEUE row handed back on a busy wait: it has no queue type and the outbox never scans it",
  },
};

/**
 * #5368: each file's count of writes whose status the source does not spell out, with what it can write. A new one is
 * read before it lands: if it can write PENDING it belongs in `PENDING_WRITERS`, routed as the header says.
 */
const UNREAD_STATUS_WRITERS: Readonly<Record<string, { writes: number; why: string }>> = {
  "src/lib/xero-sync.ts": {
    writes: 2,
    why: "completeXeroSyncOperation writes its caller's completion status (SUCCEEDED when none is given) and failXeroSyncOperation writes FAILED with the error's fields: a run's outcome, onto its claim. A completion's status is typed string, so the completion check below is what reads a caller naming PENDING",
  },
  "src/lib/xero-operation-claim.ts": {
    writes: 1,
    why: "claimXeroSyncOperationToRunning: the spread is runningClaimTransition, which writes RUNNING; PENDING is only the claim's guard",
  },
  "src/lib/xero-operation-retry.ts": {
    writes: 1,
    why: "a PARTIAL repair that threw gives its row back PARTIAL; the spread after the status is xeroSyncErrorFields, the error's code and message only",
  },
  "src/lib/kept-late-capture-change-receipt.ts": {
    writes: 1,
    why: "withdrawUndecidedKeptCaptureReceipt writes CANCELLED; the spread after the status is the caller's stamp, typed as an error code and message only",
  },
  "src/lib/organiser-extra-note-record.ts": {
    writes: 1,
    why: "recordCreatedOrganiserNote runs createdOrganiserNoteWrites: the note's Xero identifiers onto the run's own, a retaken or a queued row. Only the retake writes a status, RUNNING; a queued row stays PENDING as it was, its request untouched",
  },
  "src/lib/xero-refund-note-record.ts": {
    writes: 1,
    why: "recordCreatedRefundNote runs createdRefundNoteClaim: the note's Xero identifiers only, and no status",
  },
};

/**
 * #5368: each file's count of completions handed to `completeXeroSyncOperation` whose status is not spelled at the
 * call, with what each can carry. None may carry PENDING: a completion is a run's outcome.
 */
const UNREAD_COMPLETIONS: Readonly<Record<string, { writes: number; why: string }>> = {
  "src/lib/additional-capture-xero-receipt.ts": {
    writes: 1,
    why: "standDown passes its own status parameter, typed as SUCCEEDED or CANCELLED and nothing else",
  },
  "src/lib/membership-cancellation-xero.ts": {
    writes: 2,
    why: "two skipped completions spread strandedInvoiceLinks, the stranded invoice's Xero object fields or nothing; neither names a status, so SUCCEEDED",
  },
  "src/lib/xero-contact-create-recovery.ts": {
    writes: 1,
    why: "completeMemberContactOperation, the one completer for a member's contact since #5394, passes on its caller's completion; its three callers (xero-contact-groups.ts, xero-bulk-contact-sync.ts and updateXeroContact in xero-contacts.ts) each build one with no status, so SUCCEEDED",
  },
  "src/lib/xero-contacts.ts": {
    writes: 3,
    why: "contact completions built in this file and handed over as a variable: the resolver's stored completionInput, the create's completionInput and an update with no member; none names a status (the file has no status key), so SUCCEEDED",
  },
  "src/lib/xero-credit-notes.ts": {
    writes: 1,
    why: "refundCreditNoteCompletion: PARTIAL when the note's settling payment failed, SUCCEEDED otherwise",
  },
  "src/lib/xero-refund-note-settlement.ts": {
    writes: 1,
    why: "refundCreditNoteCompletion again: PARTIAL when the note's settling payment failed, SUCCEEDED otherwise",
  },
  "src/lib/xero-group-settlement-invoices.ts": {
    writes: 1,
    why: "boundGroupSettlementInvoiceCompletion: SUCCEEDED, for an invoice already raised for the settlement",
  },
  "src/lib/xero-operation-retry.ts": {
    writes: 2,
    why: "closeRepairOnClaim passes on a repair's completion (repairedPartialInvoiceCompletion or a spelled SUCCEEDED), and the refund note repair uses refundCreditNoteCompletion: PARTIAL or SUCCEEDED each",
  },
};

/**
 * #5368: each file's count of raw SQL statements that write the table. The application writes it through Prisma
 * only; the one statement is a migration's.
 */
const RAW_SQL_WRITERS: Readonly<Record<string, { writes: number; why: string }>> = {
  "prisma/migrations/20260706120000_xero_operation_queue_type_column/migration.sql": {
    writes: 1,
    why: "the queue type column's backfill: it copies requestPayload's queueType into the new column and sets no status, so it puts no row on PENDING",
  },
};

const PENDING_STATUS = /status:\s*"PENDING"/g;
const WHERE_OR_DATA = /\b(where|data)\s*:/g;

/** The `status: "PENDING"` that sit in a write's `data` (the nearest `where:`/`data:` before each is `data:`). */
function pendingWrites(text: string): number {
  let writes = 0;
  for (const status of text.matchAll(PENDING_STATUS)) {
    const before = [...text.slice(0, status.index).matchAll(WHERE_OR_DATA)].at(-1);
    if (before?.[1] === "data") writes += 1;
  }
  return writes;
}

function sourceFiles(dir: string, extensions = /\.tsx?$/): string[] {
  return readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sourceFiles(relative, extensions);
    return extensions.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) ? [relative] : [];
  });
}

// ----------------------------------------------------------------- #5368: the status each row write names

const MODEL = "xeroSyncOperation";
const ROW_WRITES = new Set(["update", "updateMany", "updateManyAndReturn", "upsert"]);

/** What a write says of `status`, worst last: nothing, a literal other than PENDING, PENDING, or nothing this census can read. */
const STATUS_WRITES = ["none", "other", "pending", "unread"] as const;
type StatusWrite = (typeof STATUS_WRITES)[number];
const worst = (...writes: StatusWrite[]): StatusWrite => STATUS_WRITES[Math.max(...writes.map((write) => STATUS_WRITES.indexOf(write)))]!;

function unwrap(node: ts.Expression): ts.Expression {
  let inner = node;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
  return inner;
}

/** A status value: a string literal is read, a conditional by its arms, and anything else only for the word PENDING. */
function statusValue(node: ts.Expression): StatusWrite {
  const value = unwrap(node);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text === "PENDING" ? "pending" : "other";
  if (ts.isConditionalExpression(value)) return worst(statusValue(value.whenTrue), statusValue(value.whenFalse));
  return /\bPENDING\b/.test(value.getText()) ? "pending" : "unread";
}

/** The status an object of written columns leaves, entry by entry: a later entry overrides an earlier one. */
function statusWritten(node: ts.Expression | undefined): StatusWrite {
  const columns = node ? unwrap(node) : undefined;
  if (!columns) return "none";
  if (ts.isConditionalExpression(columns)) return worst(statusWritten(columns.whenTrue), statusWritten(columns.whenFalse));
  if (!ts.isObjectLiteralExpression(columns)) return "unread";
  let written: StatusWrite = "none";
  for (const entry of columns.properties) {
    if (ts.isSpreadAssignment(entry)) {
      const spread = unwrap(entry.expression);
      // A spread of an object written here (or of a conditional between two) is read; any other may carry a status.
      const arms = ts.isConditionalExpression(spread) ? [spread.whenTrue, spread.whenFalse] : [spread];
      written = worst(...arms.map((arm) => {
        const carried = ts.isObjectLiteralExpression(unwrap(arm)) ? statusWritten(arm) : "unread";
        return carried === "none" ? written : carried;
      }));
    } else if (entry.name && ts.isComputedPropertyName(entry.name)) {
      written = "unread";
    } else if (entry.name?.getText().replace(/["']/g, "") === "status") {
      written = ts.isPropertyAssignment(entry) ? statusValue(entry.initializer) : "unread";
    }
  }
  return written;
}

/** Each write on the model in `text` that can change an existing row, as the status it names. */
function rowWrites(file: string, text: string): StatusWrite[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const named = (node: ts.Expression): string | undefined =>
    ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
  // `const operations = tx.xeroSyncOperation` and `const { xeroSyncOperation: operations } = tx` write through another name.
  const delegates = new Set<string>();
  const gather = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && named(unwrap(node.initializer)) === MODEL) delegates.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name)) {
        for (const binding of node.name.elements) {
          if ((binding.propertyName ?? binding.name).getText() === MODEL && ts.isIdentifier(binding.name)) delegates.add(binding.name.text);
        }
      }
    }
    ts.forEachChild(node, gather);
  };
  gather(source);
  const writes: StatusWrite[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const receiver = unwrap(node.expression.expression);
      const onModel = named(receiver) === MODEL || (ts.isIdentifier(receiver) && delegates.has(receiver.text));
      const method = named(node.expression);
      if (onModel && method && ROW_WRITES.has(method)) {
        const args = node.arguments[0] ? unwrap(node.arguments[0]) : undefined;
        if (!args || !ts.isObjectLiteralExpression(args) || args.properties.some(ts.isSpreadAssignment)) {
          writes.push("unread");
        } else {
          const columns = args.properties.find((entry) => entry.name?.getText() === (method === "upsert" ? "update" : "data"));
          writes.push(columns && ts.isPropertyAssignment(columns) ? statusWritten(columns.initializer) : "unread");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return writes;
}

/** Per file, how many row writes name `kind`. */
function rowWritersNaming(kind: StatusWrite): Record<string, number> {
  return Object.fromEntries(
    [...sourceFiles("src"), ...sourceFiles("scripts")].flatMap((file) => {
      const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
      const writes = text.includes(MODEL) ? rowWrites(file, text).filter((write) => write === kind).length : 0;
      return writes > 0 ? [[file, writes]] : [];
    }),
  );
}

/**
 * The completion each `completeXeroSyncOperation` call in `text` is handed, as the status it names. The writer above
 * takes its status from it. `none` is no status (SUCCEEDED); `unread` is a completion not spelled at the call: a
 * variable, a builder's result such as `refundCreditNoteCompletion`, or a spread that may carry a status.
 */
function completions(file: string, text: string): StatusWrite[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const handed: StatusWrite[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (name === "completeXeroSyncOperation" && node.arguments[1]) handed.push(statusWritten(node.arguments[1]));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return handed;
}

/** Per file, how many completions name `kind`. */
function completionsNaming(kind: StatusWrite): Record<string, number> {
  return Object.fromEntries(
    [...sourceFiles("src"), ...sourceFiles("scripts")].flatMap((file) => {
      const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
      const handed = text.includes("completeXeroSyncOperation") ? completions(file, text).filter((write) => write === kind).length : 0;
      return handed > 0 ? [[file, handed]] : [];
    }),
  );
}

/** Raw SQL that writes the table, under either spelling of its name. */
const RAW_SQL_WRITE = /\b(?:INSERT\s+INTO|UPDATE|MERGE\s+INTO|DELETE\s+FROM|COPY)\s+(?:ONLY\s+)?(?:"?public"?\.)?"?(?:XeroSyncOperation|xero_sync_operation)\b/gi;
const rawSqlWrites = (text: string) => [...text.matchAll(RAW_SQL_WRITE)].length;

const counts = (table: Readonly<Record<string, { writes: number }>>) => Object.fromEntries(Object.entries(table).map(([file, { writes }]) => [file, writes]));

describe("Xero operation PENDING writers (#5228)", { timeout: CENSUS_TIMEOUT_MS }, () => {
  it("every PENDING write onto a Xero operation row is counted per file and named, with why its request stays claimable", () => {
    const writers = Object.fromEntries(
      [...sourceFiles("src"), ...sourceFiles("scripts")].flatMap((file) => {
        const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
        const writes = /xeroSyncOperation/i.test(text) ? pendingWrites(text) : 0;
        return writes > 0 ? [[file, writes]] : [];
      }),
    );
    expect(writers).toEqual(Object.fromEntries(Object.entries(PENDING_WRITERS).map(([file, { writes }]) => [file, writes])));
  });

  it("every row write that names PENDING in any form - a literal, a member such as XeroSyncStatus.PENDING, an arm of a conditional - is one of the named writers (#5368)", () => {
    expect(rowWritersNaming("pending")).toEqual(counts(PENDING_WRITERS));
  });

  it("every row write whose status the source does not spell out is named, with what it can write (#5368)", () => {
    expect(rowWritersNaming("unread")).toEqual(counts(UNREAD_STATUS_WRITERS));
    for (const { why } of Object.values(UNREAD_STATUS_WRITERS)) expect(why.length).toBeGreaterThan(40);
  });

  it("no completion handed to completeXeroSyncOperation names PENDING (#5368)", () => {
    expect(completionsNaming("pending")).toEqual({});
  });

  it("every completion whose status is not spelled at the call is named, with what it can carry (#5368)", () => {
    expect(completionsNaming("unread")).toEqual(counts(UNREAD_COMPLETIONS));
    for (const { why } of Object.values(UNREAD_COMPLETIONS)) expect(why.length).toBeGreaterThan(40);
  });

  it("no raw SQL writes the table but what is named (#5368)", () => {
    const writers = Object.fromEntries(
      [...sourceFiles("src", /\.(?:[cm]?[jt]sx?|sql)$/), ...sourceFiles("scripts", /\.(?:[cm]?[jt]sx?|sql|sh)$/), ...sourceFiles("prisma", /\.(?:[cm]?[jt]sx?|sql)$/)].flatMap((file) => {
        const writes = rawSqlWrites(readFileSync(path.join(REPO_ROOT, file), "utf8"));
        return writes > 0 ? [[file, writes]] : [];
      }),
    );
    expect(writers).toEqual(counts(RAW_SQL_WRITERS));
  });

  it("the reading catches each shape: a member, a conditional, a variable, a shorthand, an opaque or spread data, another name for the model, and raw SQL (#5368)", () => {
    const read = (code: string) => rowWrites("probe.ts", code);
    expect(read('tx.xeroSyncOperation.updateMany({ where: { id }, data: { status: "PENDING" } })')).toEqual(["pending"]);
    expect(read("tx.xeroSyncOperation.update({ where: { id }, data: { status: XeroSyncStatus.PENDING } })")).toEqual(["pending"]);
    expect(read('tx.xeroSyncOperation.updateMany({ where: { id }, data: { status: retry ? "PENDING" : "FAILED" } })')).toEqual(["pending"]);
    expect(read("tx.xeroSyncOperation.updateManyAndReturn({ where: { id }, data: { status: `PENDING` } })")).toEqual(["pending"]);
    expect(read('tx.xeroSyncOperation.upsert({ where: { id }, create: { status: "RUNNING" }, update: { status: "PENDING" } })')).toEqual(["pending"]);
    expect(read('tx.xeroSyncOperation.updateMany({ where: { id }, data: { ...UNCLAIMED, status: "PENDING", ...(written ? { requestPayload: written } : {}) } })')).toEqual(["pending"]);
    expect(read("tx.xeroSyncOperation.updateMany({ where: { id }, data: { status: next } })")).toEqual(["unread"]);
    expect(read("tx.xeroSyncOperation.updateMany({ where: { id }, data: { status } })")).toEqual(["unread"]);
    expect(read("tx.xeroSyncOperation.updateMany({ where: { id }, data })")).toEqual(["unread"]);
    expect(read("tx.xeroSyncOperation.updateMany({ where: { id }, data: buildData() })")).toEqual(["unread"]);
    expect(read('tx.xeroSyncOperation.updateMany({ where: { id }, data: { status: "FAILED", ...fields } })')).toEqual(["unread"]);
    expect(read("tx.xeroSyncOperation.updateMany({ ...args })")).toEqual(["unread"]);
    expect(read("tx.xeroSyncOperation.updateMany(claim(row))")).toEqual(["unread"]);
    expect(read('tx["xeroSyncOperation"].update({ where: { id }, data: { status: next } })')).toEqual(["unread"]);
    expect(read("const operations = tx.xeroSyncOperation; operations.updateMany({ where: { id }, data: { status: Status.PENDING } })")).toEqual(["pending"]);
    expect(read("const { xeroSyncOperation: operations } = tx; operations.update({ where: { id }, data })")).toEqual(["unread"]);
    // Not row writes of a status, so not counted: a literal other than PENDING, no status, a status only in `where`, a read, a create.
    expect(read('tx.xeroSyncOperation.updateMany({ where: { status: "PENDING" }, data: { status: "FAILED", ...(code ? { lastErrorCode: code } : {}) } })')).toEqual(["other"]);
    expect(read('tx.xeroSyncOperation.update({ where: { id }, data: { requestPayload: { ...payload, status: "PENDING" } } })')).toEqual(["none"]);
    expect(read('tx.xeroSyncOperation.findMany({ where: { status: "PENDING" } }); tx.xeroSyncOperation.create({ data: { status: "PENDING" } })')).toEqual([]);
    expect(read('tx.payment.update({ where: { id }, data: { status: PaymentStatus.PENDING } })')).toEqual([]);

    const handed = (code: string) => completions("probe.ts", code);
    expect(handed('await completeXeroSyncOperation(claim, { status: "PENDING", responsePayload })')).toEqual(["pending"]);
    expect(handed('await sync.completeXeroSyncOperation(claim, { status: failed ? "PENDING" : "SUCCEEDED" }, { store: tx })')).toEqual(["pending"]);
    expect(handed('await completeXeroSyncOperation(claim, { status: paymentError ? "PARTIAL" : "SUCCEEDED" }); await completeXeroSyncOperation(claim, { responsePayload })')).toEqual(["other", "none"]);
    expect(handed("await completeXeroSyncOperation(claim, completion)")).toEqual(["unread"]);
    expect(handed("await completeXeroSyncOperation(claim, { status, responsePayload: { skipped } })")).toEqual(["unread"]);
    expect(handed("await completeXeroSyncOperation(claim, refundCreditNoteCompletion({ paymentId }))")).toEqual(["unread"]);
    expect(handed("await completeXeroSyncOperation(claim, { responsePayload, ...links })")).toEqual(["unread"]);
    expect(handed('await completeXeroSyncOperation(claim, { responsePayload, ...(failed ? { status: "PARTIAL" as const } : {}) })')).toEqual(["other"]);

    expect(rawSqlWrites(`UPDATE "XeroSyncOperation" SET "status" = 'PENDING' WHERE "id" = $1`)).toBe(1);
    expect(rawSqlWrites("update xero_sync_operation set status = 'PENDING'")).toBe(1);
    expect(rawSqlWrites(`INSERT INTO public."XeroSyncOperation" ("id") VALUES ($1)`)).toBe(1);
    expect(rawSqlWrites(`SELECT id FROM "XeroSyncOperation" WHERE id = $1 FOR UPDATE`)).toBe(0);
  });
});
