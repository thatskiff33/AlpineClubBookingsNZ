/**
 * M1 (#4513) ships the member-money journal inert: no production path posts to
 * it, and only the deletion guards M2 (#4514) names below read it. This census reads every non-test source file under `src/` and
 * `scripts/`, and the seeds and other top-level files in `prisma/`, and fails on
 * a journal reference outside the module boundary and the files that only name,
 * provision or verify it. The migration is SQL, outside the scan. A later child that adds a writer or reader edits this
 * list in the same PR, so the switch is a reviewed decision, not a side effect.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIPPED_DIRS = new Set(["node_modules", "__tests__", "generated", ".next"]);

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
};
const BOUNDARY = "src/lib/member-money/";
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

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(path);
    return SOURCE.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name) ? [path] : [];
  });
}

/** The top-level files of `prisma/` (seeds, config); not its migration fixtures. */
function prismaFiles(): string[] {
  return readdirSync(join(ROOT, "prisma"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE.test(entry.name))
    .map((entry) => join(ROOT, "prisma", entry.name));
}

function referencing(): string[] {
  return [...["src", "scripts"].flatMap((dir) => sourceFiles(join(ROOT, dir))), ...prismaFiles()]
    .filter((file) => REFERENCE.some((pattern) => pattern.test(readFileSync(file, "utf8"))))
    .map((file) => relative(ROOT, file).split(sep).join("/"));
}

describe("member money journal stays inert in M1 (#4513)", () => {
  const found = referencing();

  it("has no reader or writer outside the boundary and its named support files", () => {
    const offenders = found.filter((file) => !file.startsWith(BOUNDARY) && !(file in ALLOWED) && !(file in READERS));
    expect(offenders, "a production path names the member-money journal; M1 ships it inert").toEqual([]);
  });

  it("is not vacuous: every allowed file and the boundary still match", () => {
    for (const file of [...Object.keys(ALLOWED), ...Object.keys(READERS)]) expect(found).toContain(file);
    expect(found.some((file) => file.startsWith(BOUNDARY))).toBe(true);
  });

  it("posts nothing from inside the boundary, the verifier or an M2 reader", () => {
    for (const file of [
      ...found.filter((f) => f.startsWith(BOUNDARY)),
      "scripts/verify-member-money-journal.ts",
      ...Object.keys(READERS),
    ]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, file).not.toMatch(WRITE_STATEMENT);
      expect(text, file).not.toMatch(/\.memberMoney\w*\s*\.\s*(create|update|upsert|delete)/);
    }
    expect(readFileSync(join(ROOT, "scripts/verify-member-money-journal.ts"), "utf8")).toMatch(/READ ONLY/);
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
