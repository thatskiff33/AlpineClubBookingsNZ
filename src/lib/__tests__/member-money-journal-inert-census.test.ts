/**
 * M1 (#4513) shipped the member-money journal inert, and M3a (#4626) added the
 * posting command, whose store is the boundary's single writer. M3b (#4627) is
 * the first step where production paths post: the three legacy booking-ledger
 * chokepoints (confirmation, modification with review close, cancellation), the
 * group settle's child confirmations and member merge's D4 transfer, each
 * through the boundary's `./doors` entry, never the command itself. This census
 * reads every non-test source file under `src/` and `scripts/`, and the seeds
 * and other top-level files in `prisma/`, and fails on a journal reference
 * outside the boundary and the files listed below. The migration is SQL,
 * outside the scan. A later child that adds a writer or reader edits these
 * lists in the same PR, so each switch is a reviewed decision, not a side effect.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMBER_MONEY_RELATIONS } from "@/lib/member-money-tables";
import { delegateUsesBeyondReads, productionSourceFiles } from "./support/prisma-delegate-read-scan";
import { stripComments } from "./support/strip-comments";

const ROOT = process.cwd();

/** Files allowed to name the journal, and why. Nothing here writes a row. */
const ALLOWED: Record<string, string> = {
  "src/lib/member-money-tables.ts": "the relation list provisioning and the verifier share",
  "src/lib/database-roles.ts": "least-privilege provisioning (INSERT/SELECT grants, no rows)",
  "src/lib/member-merge-snapshot-columns.ts": "member-merge classification strings",
  "src/lib/privacy-retention-classification.ts": "privacy schedule classification strings; no journal access",
  "scripts/verify-member-money-journal.ts": "operator verifier in a READ ONLY transaction",
};

/**
 * M2 (#4514, D1 on #4482): deletion guards that READ what posted rows retain,
 * through the boundary's index. Each is held to the same "posts nothing" check
 * as the boundary itself, and an `importOnly` reader may name the journal in
 * nothing but its import from `@/lib/member-money` — no delegate, table, enum or
 * SQL function — so a general module cannot grow a journal access unreviewed.
 */
const READERS: Record<string, { reason: string; importOnly: boolean }> = {
  "src/lib/booking-financial-history.ts": {
    reason: "draft hard delete skips a booking a journal leg names (read-only)",
    importOnly: false,
  },
  "src/lib/member-lifecycle-actions.ts": {
    reason: "member hard delete refuses a journal debtor (read-only count)",
    importOnly: true,
  },
  // M3b (#4627): comparison report v1, through `readBookingJournalCharges` in the census snapshot.
  "src/lib/booking-ledger-projection-census-store.ts": {
    reason: "the census reads the journal's charges for each page (read-only)",
    importOnly: false,
  },
  "src/lib/booking-ledger-projection-census-row.ts": {
    reason: "the census row carries the journal's charges (a type import)",
    importOnly: false,
  },
  "src/lib/booking-ledger-projection-census-journal.ts": {
    reason: "the pure JOURNAL comparison of the journal's charges with the bridged lines",
    importOnly: false,
  },
};
/**
 * M3b (#4627): THE POSTING CALLERS, exactly. Each posts through
 * `postBookingLedgerJournal` or `postMemberMergeTransfer` from `./doors`, in the
 * transaction of the business change it records, and is held to the same
 * "reads only, no raw SQL write" checks as the boundary.
 */
const DOORS: Record<string, string> = {
  "src/lib/booking-ledger-confirmation-sync.ts": "R01: a confirmation's lines, beside the legacy write",
  "src/lib/booking-ledger-group-settlement-sync.ts": "R01: a group-settled child's confirmation lines",
  "src/lib/booking-ledger-modification-sync.ts": "R02/R03 an edit's lines; R21 a review closure's",
  "src/lib/booking-ledger-cancellation-sync.ts": "R04: a cancellation's lines",
  "src/lib/member-merge.ts": "D4: the merged-away member's receivable balances, transferred",
};
/**
 * M3b (#4627): the doors' callers, which resolve the posting context BEFORE
 * their transaction (`INV-LOCK-004`) and pass it down. They post nothing and read
 * no journal delegate; each may name only the boundary's `./doors` entry and its
 * context type.
 */
const CONTEXT_RESOLVERS: readonly string[] = [
  "src/app/api/bookings/[id]/guests/route.ts",
  "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
  "src/lib/booking-batch-modification-service.ts",
  "src/lib/booking-cancel.ts",
  "src/lib/booking-date-modification-service.ts",
  "src/lib/booking-guest-acceptance-reprice.ts",
  "src/lib/booking-guest-removal-service.ts",
  "src/lib/cron-confirm-pending.ts",
  "src/lib/group-cancel.ts",
  "src/lib/group-settlement.ts",
  "src/lib/internet-banking-payment-cron.ts",
  "src/lib/manual-refund-task-resolution.ts",
  "src/lib/member-guest-consent-service.ts",
  "src/lib/payment-reconciliation.ts",
  "src/lib/school-booking-request.ts",
  "src/lib/stored-night-price-repair-store.ts",
  "src/lib/xero-inbound/invoice-paid-effects.ts",
];
/** Anything a context resolver may say about the journal: the `./doors` entry, the resolver and the context type. */
const RESOLVER_VOCABULARY = /["']@\/lib\/member-money\/doors["']|\bresolveBookingMoneyPostingContext\b|\bMemberMoneyPostingContext\b/g;
const BOUNDARY = "src/lib/member-money/";
/** M3a (#4626): the one file that creates journal rows. */
const WRITER = "src/lib/member-money/internal/store.ts";
/** The command's entry points: nothing outside the boundary calls them; M3b's doors go through `./doors`. */
const POSTING_COMMAND = /\b(postMemberMoneyEvent|reverseMemberMoneyJournal|writeMemberMoneyBatch)\b/;
/** M3b's door entry points (#4627). */
const DOOR_COMMAND = /\b(postBookingLedgerJournal|postMemberMergeTransfer)\b/;
const DELEGATE_WRITE = /\.memberMoney\w*\s*\.\s*(create|update|upsert|delete)/;
/**
 * Every name that reaches a journal row through Prisma: each relation's
 * delegate, and the relation fields other models carry (`Booking.memberMoneyLines`).
 */
const journalRelations: readonly string[] = MEMBER_MONEY_RELATIONS;
/** Fields of other models whose TYPE is a journal relation, whatever they are named. */
function journalRelationFields(schema: string): string[] {
  return [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)]
    .filter(([, model]) => !journalRelations.includes(model!))
    .flatMap(([, , body]) => [...body!.matchAll(/^\s+(\w+)\s+(\w+)(?:\[\]|\?)?(?:\s|$)/gm)]
      .filter(([, , type]) => journalRelations.includes(type!))
      .map(([, field]) => field!));
}
const JOURNAL_DELEGATES = new Set([
  ...MEMBER_MONEY_RELATIONS.map((relation) => relation[0]!.toLowerCase() + relation.slice(1)),
  ...journalRelationFields(readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8")),
]);
const isJournalDelegate = (name: string) => JOURNAL_DELEGATES.has(name);
/** One `import { … } from "@/lib/member-money";` statement, on its own line(s). */
const BOUNDARY_IMPORT = /^import\s*\{[^}]*\}\s*from\s*["']@\/lib\/member-money["'];?[ \t]*$/gm;

/**
 * A journal table, enum or Prisma delegate; a relation field reaching it from
 * another model (`include: { memberMoneyLines: true }`); one of its SQL
 * functions; or an import of the boundary.
 */
const REFERENCE = [
  /\bMemberMoney[A-Z]\w*/,
  /\bmemberMoney[A-Z]\w*/,
  /\bmember_money_\w+/,
  /["'`](?:@\/lib\/|(?:\.\.?\/)+(?:src\/lib\/|lib\/)?)member-money(?:-tables)?(?:\/[\w/]*)?["'`]/,
];

/**
 * A statement that writes rows, in the forms the verifier could execute:
 * INSERT INTO, an UPDATE of a journal table (ONLY and a quoted or bare `public`
 * schema included), DELETE FROM, MERGE INTO, COPY … FROM and TRUNCATE. The
 * pinned trigger definitions in `database-shape.ts` name TRUNCATE as a trigger
 * EVENT (`BEFORE TRUNCATE ON …`, `INSERT OR TRUNCATE ON …`); a TRUNCATE
 * statement is never followed by `ON` or `OR`, so only that grammar is excluded.
 */
const WRITE_STATEMENT = new RegExp([
  String.raw`\bINSERT\s+INTO\b`,
  String.raw`\bUPDATE\s+(?:ONLY\s+)?(?:"?public"?\.)?"MemberMoney`,
  String.raw`\bDELETE\s+FROM\b`,
  String.raw`\bMERGE\s+INTO\b`,
  String.raw`\bCOPY\s+[^;]*?\bFROM\b`,
  String.raw`\bTRUNCATE\b(?!\s+(?:ON|OR)\b)`,
].join("|"), "i");

function referencing(): string[] {
  return productionSourceFiles(ROOT)
    .filter((file) => REFERENCE.some((pattern) => pattern.test(readFileSync(join(ROOT, file), "utf8"))));
}

describe("member money journal stays inert in M1 (#4513)", () => {
  const found = referencing();

  it("has no reader or writer outside the boundary and its named support files", () => {
    const offenders = found.filter((file) => !file.startsWith(BOUNDARY) && !(file in ALLOWED) && !(file in READERS)
      && !(file in DOORS) && !CONTEXT_RESOLVERS.includes(file));
    expect(offenders, "a production path names the member-money journal outside the reviewed lists").toEqual([]);
  });

  it("is not vacuous: every allowed file and the boundary still match", () => {
    for (const file of [...Object.keys(ALLOWED), ...Object.keys(READERS), ...Object.keys(DOORS), ...CONTEXT_RESOLVERS]) {
      expect(found).toContain(file);
    }
    expect(found.some((file) => file.startsWith(BOUNDARY))).toBe(true);
  });

  it("only reads journal delegates outside the store: no alias, bracket, destructuring or optional-chain escape (#4626)", () => {
    const offenders = found.filter((file) => file !== WRITER).flatMap((file) =>
      delegateUsesBeyondReads(readFileSync(join(ROOT, file), "utf8"), file, isJournalDelegate)
        .map(({ line, text }) => `${file}:${line} ${text}`));
    expect(offenders, "a journal delegate is used for something other than a read").toEqual([]);
  });

  it("writes no raw SQL from the boundary, the verifier or an M2 reader", () => {
    for (const file of [...found.filter((f) => f.startsWith(BOUNDARY)), "scripts/verify-member-money-journal.ts", ...Object.keys(READERS)]) {
      expect(stripComments(readFileSync(join(ROOT, file), "utf8")), file).not.toMatch(WRITE_STATEMENT);
    }
    expect(readFileSync(join(ROOT, "scripts/verify-member-money-journal.ts"), "utf8")).toMatch(/READ ONLY/);
  });

  it("finds every escape a delegate write could take (fixture proof)", () => {
    expect([...JOURNAL_DELEGATES].sort()).toEqual(expect.arrayContaining(["memberMoneyLine", "memberMoneyLines", "memberMoneySourceLink"]));
    // By type, not by name: a relation field called anything else is still found.
    expect(journalRelationFields("model Booking {\n  ledgerRows MemberMoneyLine[]\n  title String\n}\n")).toEqual(["ledgerRows"]);
    const caught = (code: string) => delegateUsesBeyondReads(code, "fixture.ts", isJournalDelegate).length;
    for (const write of [
      "await tx.memberMoneyLine.create({ data });",
      "const lines = tx.memberMoneyLine; await lines.create({ data });",
      'await tx["memberMoneyLine"].create({ data });',
      'await tx.memberMoneyLine["createMany"]({ data });',
      "const { memberMoneyLine } = tx; await memberMoneyLine.deleteMany();",
      "const { memberMoneyLine: lines } = tx;",
      "await tx?.memberMoneyLine?.update({ where, data });",
      "await tx.memberMoneyLine.findMany.call(tx.memberMoneyLine, {});",
      'const name = "memberMoneyLine"; await tx[name].create({ data });',
      "await helper(tx.memberMoneyLine);",
      "await tx.booking.update({ where, data: { memberMoneyLines: { create: [] } } });",
      "await tx.booking.update({ where, data: { memberMoneyLines: nested } });",
      "await tx.booking.update({ where, data: { memberMoneyLines: buildNestedWrite() } });",
      "await tx.booking.update({ where, data: { memberMoneyLines: { ...nestedCreate } } });",
    ]) {
      expect(caught(write), write).toBeGreaterThan(0);
    }
    for (const read of [
      "await tx.memberMoneyLine.findMany({ where });",
      "await tx?.memberMoneyLine.count();",
      'await tx["memberMoneyObligation"].findUnique({ where });',
      "await tx.booking.findMany({ include: { memberMoneyLines: true }, where: { memberMoneyLines: { some: {} } } });",
      'type Db = Pick<Prisma.TransactionClient, "memberMoneyLine" | "memberMoneyObligation">;',
    ]) {
      expect(caught(read), read).toBe(0);
    }
  });

  it("writes only through Prisma delegates in the store, never raw SQL (#4626)", () => {
    const text = stripComments(readFileSync(join(ROOT, WRITER), "utf8"));
    expect(text, "the store is the writer; if it stops writing, retire WRITER").toMatch(DELEGATE_WRITE);
    expect(text).not.toMatch(WRITE_STATEMENT);
    expect(text).not.toMatch(/\$(executeRaw|queryRaw)/);
  });

  it("has no production caller of the posting command outside the boundary (#4626)", () => {
    const callers = found.filter((file) => !file.startsWith(BOUNDARY)
      && POSTING_COMMAND.test(readFileSync(join(ROOT, file), "utf8")));
    expect(callers, "a door calls the command directly; M3b's doors go through ./doors").toEqual([]);
    // Fixture proof: an import of the command is caught.
    expect('import { postMemberMoneyEvent } from "@/lib/member-money";').toMatch(POSTING_COMMAND);
  });

  it("admits exactly the M3b doors as posting callers (#4627)", () => {
    const callers = found.filter((file) => !file.startsWith(BOUNDARY)
      && DOOR_COMMAND.test(stripComments(readFileSync(join(ROOT, file), "utf8"))));
    expect(callers.sort(), "the set of production paths that post to the journal changed").toEqual(Object.keys(DOORS).sort());
    expect('await postBookingLedgerJournal(tx, journal, input);').toMatch(DOOR_COMMAND);
  });

  it("lets a context resolver name only the doors entry, its resolver and the context type (#4627)", () => {
    for (const file of CONTEXT_RESOLVERS) {
      const rest = stripComments(readFileSync(join(ROOT, file), "utf8")).replace(RESOLVER_VOCABULARY, "");
      expect(REFERENCE.filter((pattern) => pattern.test(rest)).map(String), file).toEqual([]);
    }
    // Fixture proof: the vocabulary alone passes, a delegate beside it does not.
    const vocabulary = 'import { resolveBookingMoneyPostingContext, type MemberMoneyPostingContext } from "@/lib/member-money/doors";';
    expect(REFERENCE.some((pattern) => pattern.test(vocabulary.replace(RESOLVER_VOCABULARY, "")))).toBe(false);
    expect(REFERENCE.some((pattern) => pattern.test(`${vocabulary}\nawait tx.memberMoneyLine.count();`.replace(RESOLVER_VOCABULARY, "")))).toBe(true);
  });

  it("lets an import-only reader name the journal in its boundary import and nowhere else (#4514)", () => {
    for (const [file, { importOnly }] of Object.entries(READERS)) {
      if (!importOnly) continue;
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text.match(BOUNDARY_IMPORT), `${file} imports the boundary`).not.toBeNull();
      const rest = text.replace(BOUNDARY_IMPORT, "");
      expect(REFERENCE.filter((pattern) => pattern.test(rest)).map(String), file).toEqual([]);
    }
    // Fixture proof: a delegate beside the import is caught, the import alone is not.
    const importLine = 'import { journalRowsNamingDebtor } from "@/lib/member-money";';
    expect(REFERENCE.some((pattern) => pattern.test(importLine.replace(BOUNDARY_IMPORT, "")))).toBe(false);
    const withDelegate = `${importLine}\nawait tx.memberMoneyLine.count();`;
    expect(REFERENCE.some((pattern) => pattern.test(withDelegate.replace(BOUNDARY_IMPORT, "")))).toBe(true);
  });

  it("recognises every write statement form, and only the pinned definitions' grammar escapes it", () => {
    for (const statement of [
      'INSERT INTO "MemberMoneyLine" VALUES (1)',
      'UPDATE "MemberMoneyLine" SET id = id',
      'UPDATE public."MemberMoneyLine" SET id = id',
      'UPDATE "public"."MemberMoneyLine" SET id = id',
      'UPDATE ONLY "MemberMoneyLine" SET id = id',
      'DELETE FROM "MemberMoneyLine"',
      'MERGE INTO "MemberMoneyLine" USING x ON true WHEN MATCHED THEN DELETE',
      'COPY "MemberMoneyLine" FROM STDIN',
      'COPY public."MemberMoneyLine" (id) FROM \'/tmp/x\'',
      'TRUNCATE "MemberMoneyLine"', "truncate table public.x", "TRUNCATE ONLY x", "TRUNCATE ${table}",
    ]) {
      expect(statement).toMatch(WRITE_STATEMENT);
    }
    for (const definition of [
      'CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON public."MemberMoneyEvent" FOR EACH STATEMENT',
      "AFTER INSERT OR TRUNCATE ON x",
      'CREATE TRIGGER member_money_immutable BEFORE DELETE OR UPDATE ON public."MemberMoneyLine" FOR EACH ROW',
      'FOREIGN KEY ("journalId") REFERENCES "MemberMoneyJournal"(id) ON UPDATE RESTRICT ON DELETE RESTRICT',
      'CREATE CONSTRAINT TRIGGER member_money_complete AFTER INSERT ON public."MemberMoneyLine"',
      'COPY "MemberMoneyLine" TO STDOUT',
    ]) {
      expect(definition).not.toMatch(WRITE_STATEMENT);
    }
  });
});
