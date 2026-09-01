// #2520 — the FamilyGroupMember.role retirement guard, POST-DROP.
//
// The column is gone. `20260803030000_contract_drop_family_group_member_role`
// dropped it under a maintenance window (owner directive, 3 Aug 2026) and this
// release removed the field from prisma/schema.prisma in the same commit.
//
// WHY THIS FILE SURVIVED THE DROP. Its previous version said to delete it here,
// on the reasoning that "once the field is gone from schema.prisma the compiler
// enforces all of it unconditionally". That reasoning is close but not exact, and
// the exact version is what justifies deleting the delegate scans. Measured
// against the generated client on this branch (transcript in
// docs/PRODUCTION_UPGRADE_RUNBOOK.md §7.2):
//
//   * `where: { role: ... }` IS a compile error;
//   * `select: { role: true }` and `create({ data: { role } })` COMPILE, and are
//     rejected at runtime by the client with PrismaClientValidationError before
//     any SQL is emitted.
//
// So no call shape can emit SQL naming the dropped column — the client has no such
// field to put in a SELECT, an INSERT column list, a RETURNING or a WHERE. The
// hazard the old guard existed for was the IMPLICIT one (an `include:` or a bare
// `: true` naming the column with no author intent), and that is now structurally
// impossible rather than merely policed. What is left is explicit, loud and
// unconditional: the first invocation fails, in any test or dev run. On that basis
// the narrowing scans, the nested-relation scans and the write/read scans were all
// deleted, and `familyGroupMember` came out of
// doomed-column-select-guard.test.ts's NARROW_SELECT_MODELS at the same time.
//
// None of that covers the two things kept below:
//
//   * RAW SQL. `$queryRaw`/`$executeRaw` and the psql heredocs in scripts/ are
//     plain strings. The compiler cannot see a dropped column in one, and this is
//     not hypothetical — a retired audit script kept a
//     `SELECT "role" … FROM "FamilyGroupMember"` snapshot query and an
//     `INSERT … ("role") …` fixture right through #2284, invisible to any
//     delegate scan. Because that scan is now the ONLY thing covering raw SQL,
//     three holes it shipped with in #2565 were closed here rather than left to
//     be discovered: it matched the quoted `"role"` only (unquoted `role` is
//     equally valid Postgres and is what 20260407120000's own INSERT column list
//     writes), it looked only 500 characters either side of the table name (a
//     realistic joined query puts the predicate further away than that), and it
//     opened `.ts`/`.tsx` only while claiming to cover the heredocs. The scan is
//     now statement-scoped, matches the column quoted or not, and reads `.sh`
//     and `.sql` too.
//   * THE GENERATED CLIENT'S SHAPE. This is the owner-required proof that the
//     replacement runtime cannot name the dropped column, asserted against the
//     generated client rather than inferred from source. It is also the assertion
//     that fails first if someone re-adds the field to the schema without the
//     migration to match.
//
// The migration and ledger assertions tie the halves together: the field's
// absence from schema.prisma is only correct because a committed migration drops
// the column, and a windowed migration is only valid with a rollback.sql beside
// it.
import fs from "node:fs";
import path from "node:path";

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { stripCommentsAndStrings } from "./support/strip-comments";

const REPO_ROOT = process.cwd();
// scripts/ is walked for the same reason it always was: that is where the last
// survivor hid, in raw fixture SQL a src/+prisma/ scan could never have seen.
const SCAN_DIRS = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "prisma"),
  path.join(REPO_ROOT, "scripts"),
];
const SCHEMA_PATH = path.join(REPO_ROOT, "prisma", "schema.prisma");
const DROP_MIGRATION = "20260803030000_contract_drop_family_group_member_role";
const DROP_MIGRATION_PREFIX = DROP_MIGRATION.slice(0, 14);
const MIGRATION_DIR = path.join(REPO_ROOT, "prisma", "migrations", DROP_MIGRATION);

// Raw SQL is not confined to TypeScript, so the raw-SQL scan is not either:
// `.sh` carries the psql heredocs in scripts/ (four scripts invoke psql today)
// and `.sql` is anything handwritten outside the Prisma migration history.
const RAW_SQL_EXTENSIONS = /\.(ts|tsx|sh|sql)$/;

function walk(dir: string, extensions: RegExp, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, extensions, files);
    } else if (extensions.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

function isTestFile(relPath: string): boolean {
  return (
    relPath.includes("__tests__") ||
    /\.(test|spec)\.tsx?$/.test(relPath) ||
    relPath.includes(".integration.")
  );
}

/** A stretch of candidate SQL, and where in its file it starts. */
type SqlChunk = { text: string; offset: number };

/**
 * Every string / template literal in TypeScript `text`, delimiters included and
 * offsets kept so an offender can still be reported at its real line.
 *
 * Raw SQL always lives inside a literal, so scanning literals rather than whole
 * files is what lets the column pattern below be broad without drowning in false
 * positives: `member.role` in ordinary code is not a literal, while
 * `SELECT fgm.role FROM "FamilyGroupMember" fgm` is. Delimiters are kept because
 * the table name the scan keys on is itself a quoted SQL identifier.
 */
function stringLiterals(text: string): SqlChunk[] {
  const out: SqlChunk[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const openedAt = i;
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      out.push({ text: text.slice(openedAt, i + 1), offset: openedAt });
      continue;
    }
  }
  return out;
}

/**
 * `text` with SQL comments (`--` to end of line, and block comments) replaced by
 * spaces — same length, newlines kept, so offsets and reported lines stay true.
 * Single-quoted SQL literals are skipped so a `--` inside one is not mistaken for
 * a comment.
 *
 * Applied to `.sql` files and to extracted TypeScript literals, so a SQL comment
 * that explains why the column is gone cannot fail the guard that proves it is
 * gone. NOT applied to `.sh`, where `--` is far more often an option separator
 * (`psql --quiet`, `docker compose exec --`) than a comment: blanking there would
 * hide SQL on the same line, and failing closed on a shell comment that names
 * both the table and the column is the cheaper mistake.
 */
function blankSqlComments(text: string): string {
  const out = text.split("");
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      for (let j = i; j < end; j += 1) if (out[j] !== "\n") out[j] = " ";
      i = end - 1;
      continue;
    }
    if (text[i] === "'") {
      i += 1;
      while (i < text.length && text[i] !== "'") i += 1;
      continue;
    }
  }
  return out.join("");
}

/**
 * `chunk` split into statements on `;`, offsets preserved.
 *
 * Statement scope replaced the old fixed 500-character window either side of the
 * table name. That window was a measured hole: a realistic joined query puts
 * `fgm."role" = 'ADMIN'` in a WHERE clause more than 500 characters below the
 * table in the FROM, and passed. A statement is the unit PostgreSQL actually
 * runs, so it is the right unit to ask "does this statement name both?".
 */
function sqlStatements(chunk: SqlChunk): SqlChunk[] {
  const out: SqlChunk[] = [];
  let start = 0;
  for (let i = 0; i < chunk.text.length; i += 1) {
    if (chunk.text[i] === ";") {
      out.push({ text: chunk.text.slice(start, i), offset: chunk.offset + start });
      start = i + 1;
    }
  }
  out.push({ text: chunk.text.slice(start), offset: chunk.offset + start });
  return out;
}

type SqlSource = { rel: string; raw: string; statements: SqlChunk[] };

/**
 * True for committed migration SQL that is allowed to name the column: the
 * statements that CREATED it, the backfill that wrote its labels, and the DROP
 * plus its `rollback.sql`. Applied history is immutable, and the drop pair has to
 * name the column to do its job.
 *
 * The cut is the drop migration's own timestamp prefix, not the whole of
 * `prisma/migrations/`, so a NEW migration naming the dropped column still fails
 * this scan.
 */
function isHistoricalMigrationSql(rel: string): boolean {
  const match = /^prisma\/migrations\/(\d{14})_[^/]*\/[^/]+\.sql$/.exec(rel);
  return match !== null && match[1] <= DROP_MIGRATION_PREFIX;
}

/**
 * Every candidate SQL statement in non-test production sources, keyed to its
 * file. TypeScript contributes its string/template literals; `.sh` contributes
 * the whole file (a heredoc is not a literal any parser here would find); `.sql`
 * contributes the whole file with its comments blanked.
 */
function rawSqlSources(): SqlSource[] {
  const out: SqlSource[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir, RAW_SQL_EXTENSIONS)) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      if (isTestFile(rel) || isHistoricalMigrationSql(rel)) continue;
      const raw = fs.readFileSync(file, "utf8");
      const chunks: SqlChunk[] = rel.endsWith(".sh")
        ? [{ text: raw, offset: 0 }]
        : rel.endsWith(".sql")
          ? [{ text: blankSqlComments(raw), offset: 0 }]
          : stringLiterals(raw).map((literal) => ({
              text: blankSqlComments(literal.text),
              offset: literal.offset,
            }));
      out.push({ rel, raw, statements: chunks.flatMap(sqlStatements) });
    }
  }
  return out;
}

const TABLE_REFERENCE = /"FamilyGroupMember"/;
// `role` as a column reference, quoted or not, optionally table-qualified
// (`fgm."role"`, `fgm.role`). PostgreSQL folds an unquoted identifier to lower
// case, so `SELECT role FROM "FamilyGroupMember"` is exactly as valid as the
// quoted form — and this repo's own history writes it that way, in
// 20260407120000's INSERT column list. Matching only `"role"` was a measured hole.
// Deliberately broad: `roleId`, `accessRole` and `familyGroupRoles` do not match,
// but ordinary prose that says "role" inside a SQL statement naming the table
// will. That is fail-closed and the wording is free to change.
const ROLE_COLUMN = /(^|[^\w"])"?role"?(?![\w"])/i;

describe("#2520 FamilyGroupMember.role is dropped", () => {
  // ---------------------------------------------------------------------------
  // The owner-required proof: the replacement runtime cannot name the column.
  // ---------------------------------------------------------------------------

  it("the generated Prisma Client does not expose the dropped column at all", () => {
    // Asserted against the generated client, not inferred from the source: with
    // no `role` field there is no SELECT, no INSERT column list and no implicit
    // RETURNING the client can emit that names the dropped column, whatever any
    // call site does. This is what makes the DROP safe for the replacement
    // runtime, and it is the assertion that fires if the field is re-added to
    // prisma/schema.prisma without a migration to match.
    const scalars = Object.keys(Prisma.FamilyGroupMemberScalarFieldEnum);
    expect(
      scalars,
      "FamilyGroupMember.role was DROPPED from the database by " +
        `${DROP_MIGRATION}. The generated client must not carry the field: if it ` +
        "does, Prisma will name a column that no longer exists and every read or " +
        "write of the join table fails with Postgres 42703 / Prisma P2022.",
    ).not.toContain("role");
    // Sanity: the enum is really this model's, so the assertion above is not
    // vacuously true of an empty or wrong object. The surviving scalars are
    // exactly these four — a fifth would mean the model gained a field this
    // guard has not reasoned about.
    expect([...scalars].sort()).toEqual([
      "familyGroupId",
      "id",
      "joinedAt",
      "memberId",
    ]);
  });

  it("the schema declares no rank field on the join table", () => {
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    const model = /model FamilyGroupMember \{[\s\S]*?\n\}/.exec(schema);
    expect(model, "FamilyGroupMember model not found in schema.prisma").not.toBeNull();
    const body = model![0];
    // Field declarations only, so the explanatory comment above them (which does
    // name the column, deliberately) cannot fail this.
    const fieldLines = body
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    expect(
      /(^|\s)role\s+\S/.test(fieldLines),
      "FamilyGroupMember must declare no `role` field: the database column is " +
        `dropped (${DROP_MIGRATION}), so a field here would produce SQL naming a ` +
        "column that does not exist. Family-group membership carries no rank — " +
        "see docs/DOMAIN_INVARIANTS.md on the family authorisation boundary.",
    ).toBe(false);
    // The absence is documented rather than accidental, so a future author does
    // not "restore" the column as a live signal.
    expect(body).toContain("NO `role` FIELD");
  });

  // ---------------------------------------------------------------------------
  // The field's absence is only correct because a committed migration drops the
  // column, and a windowed migration is only valid with its reverse script.
  // ---------------------------------------------------------------------------

  it("ships the DROP migration and its reverse script", () => {
    const migrationSql = path.join(MIGRATION_DIR, "migration.sql");
    const rollbackSql = path.join(MIGRATION_DIR, "rollback.sql");
    expect(fs.existsSync(migrationSql), `${DROP_MIGRATION}/migration.sql`).toBe(true);
    expect(
      fs.existsSync(rollbackSql),
      "A windowed migration must ship rollback.sql beside migration.sql " +
        "(docs/BLUE_GREEN_MIGRATION_POLICY.md). The deploy validator enforces " +
        "this too, as a documentation failure the ALLOW_BREAKING override cannot " +
        "rescue.",
    ).toBe(true);

    const migration = fs.readFileSync(migrationSql, "utf8");
    expect(migration).toMatch(/ALTER TABLE "FamilyGroupMember"/);
    expect(migration).toMatch(/DROP COLUMN "role"/);

    // The reverse script must restore the exact shape the previous release's
    // client expects: TEXT, NOT NULL, constant 'MEMBER' default — the shape
    // 20260407120000_add_family_group_member_join_table created.
    const rollback = fs.readFileSync(rollbackSql, "utf8");
    expect(rollback).toMatch(/ADD COLUMN "role" TEXT NOT NULL DEFAULT 'MEMBER'/);
  });

  it("is declared windowed in the blue/green safety ledger", () => {
    const ledger = fs.readFileSync(
      path.join(REPO_ROOT, "docs", "BLUE_GREEN_MIGRATION_SAFETY.tsv"),
      "utf8",
    );
    const row = ledger
      .split("\n")
      .find((line) => line.startsWith(`${DROP_MIGRATION}\t`));
    expect(row, `no ledger row for ${DROP_MIGRATION}`).toBeDefined();
    const fields = row!.split("\t");
    // DROP COLUMN is a destructive removal, so the validator requires
    // phase=contract with a named previous expand release; the owner directive
    // requires the honest `windowed` declaration rather than `yes`; and
    // `windowed` is only meaningful with the window written down.
    expect(fields[1]).toBe("contract");
    expect(fields[2]).not.toBe("n/a");
    expect(fields[2]).not.toBe("");
    expect(fields[3]).toBe("windowed");
    expect(fields[4] ?? "").toContain("MAINTENANCE-WINDOW PLAN");
  });

  // ---------------------------------------------------------------------------
  // The one surface the compiler cannot reach.
  // ---------------------------------------------------------------------------

  it("no raw SQL names the dropped column", () => {
    // Comments are stripped, but STRING BODIES ARE NOT — that is the point, since
    // the SQL lives in them. So prose inside a SQL statement that names the table
    // must not use the word "role"; say "the retired rank label", or move the
    // sentence into a comment, which is blanked.
    const offenders: string[] = [];
    for (const { rel, raw, statements } of rawSqlSources()) {
      for (const statement of statements) {
        if (!TABLE_REFERENCE.test(statement.text)) continue;
        const hit = ROLE_COLUMN.exec(statement.text);
        if (!hit) continue;
        const line = raw.slice(0, statement.offset + hit.index).split("\n").length;
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(
      offenders,
      'Raw SQL naming "FamilyGroupMember" must not name the dropped role ' +
        "column, quoted or unquoted. Raw SQL is the one surface the removed " +
        "Prisma field does not protect: the compiler cannot see a column name " +
        "inside a string or a psql heredoc, so this scan is the only thing " +
        "standing between a stray $queryRaw, $executeRaw or shell heredoc and a " +
        "Postgres 42703 in production. It reads .ts, .tsx, .sh and .sql under " +
        "src/, prisma/ and scripts/, statement by statement; committed migration " +
        `SQL at or before ${DROP_MIGRATION_PREFIX} is exempt because applied ` +
        "history is immutable and the drop pair has to name the column.",
    ).toEqual([]);
  });

  it("finds the raw-SQL surface it is meant to police", () => {
    // If the scan matched no "FamilyGroupMember" raw SQL anywhere it would pass
    // vacuously forever, so prove the surface is still there. The retired audit
    // script's fixture INSERT is the standing example.
    const withTable = rawSqlSources().filter(({ statements }) =>
      statements.some((statement) => TABLE_REFERENCE.test(statement.text)),
    );
    expect(withTable.length).toBeGreaterThan(0);
  });

  it("the raw-SQL scan catches the shapes that once slipped past it", () => {
    // Pins the three holes closed rather than trusting the regex by eye. Each
    // fixture is a shape a probe file proved passed the #2565 version of this
    // scan: an unquoted column, a predicate more than 500 characters from the
    // table name, and a psql heredoc in a shell script.
    const scan = (rel: string, text: string): number => {
      const chunks: SqlChunk[] = rel.endsWith(".sh")
        ? [{ text, offset: 0 }]
        : rel.endsWith(".sql")
          ? [{ text: blankSqlComments(text), offset: 0 }]
          : stringLiterals(text).map((literal) => ({
              text: blankSqlComments(literal.text),
              offset: literal.offset,
            }));
      return chunks
        .flatMap(sqlStatements)
        .filter(
          (statement) =>
            TABLE_REFERENCE.test(statement.text) && ROLE_COLUMN.test(statement.text),
        ).length;
    };

    // (1) unquoted column — valid Postgres, and what 20260407120000 itself writes.
    expect(
      scan(
        "src/probe.ts",
        `prisma.$queryRawUnsafe('SELECT id, role FROM "FamilyGroupMember"');`,
      ),
    ).toBe(1);

    // (2) the predicate far from the table name: >500 characters apart.
    const padding = Array.from(
      { length: 12 },
      (_, i) => `  JOIN "Member" m${i} ON m${i}."id" = fgm."memberId" AND m${i}."active"\n`,
    ).join("");
    expect(padding.length).toBeGreaterThan(500);
    expect(
      scan(
        "src/probe.ts",
        "prisma.$queryRaw`\n  SELECT fgm.\"id\"\n  FROM \"FamilyGroupMember\" fgm\n" +
          padding +
          "  WHERE fgm.\"role\" = 'ADMIN'\n`;",
      ),
    ).toBe(1);

    // (3) a psql heredoc in a shell script — a file type the scan never opened.
    expect(
      scan(
        "scripts/probe.sh",
        `psql <<'SQL'\nSELECT "id", "role" FROM "FamilyGroupMember" WHERE "role" = 'ADMIN';\nSQL`,
      ),
    ).toBe(1);

    // And it stays quiet on the near misses, so the broad pattern is not a
    // standing false positive: a different column ending in the word, a
    // different model's role, and the table with no column reference at all.
    expect(scan("src/probe.ts", `'SELECT "roleId" FROM "FamilyGroupMember"'`)).toBe(0);
    expect(
      scan("src/probe.ts", `'SELECT "accessRole" FROM "FamilyGroupMember"'`),
    ).toBe(0);
    expect(scan("src/probe.ts", `'SELECT COUNT(*) FROM "FamilyGroupMember"'`)).toBe(0);
  });

  it("member-merge carries no vestigial role-merging behaviour", () => {
    // The `maxFamilyRole` upgrade promoted the surviving membership row to the
    // higher of the two labels when a merge collapsed two memberships of the same
    // family group. The label granted nothing after #2284, so PR #2565 removed
    // the behaviour; this pins that it stays removed, and that no substitute
    // update of the surviving row has crept back in.
    //
    // Comments AND string contents are blanked, because the removal is discussed
    // in `member-merge.ts` at the site it was removed from — the postmortem
    // hazard `INV-SSOT-004` is about — and a mention is not a behaviour. #3164
    // converged this off a local `codeOnly` onto the canonical second form; it
    // reports the same on `member-merge.ts` today and is stricter where they
    // differ, since `obj["maxFamilyRole"]` survives the canonical blanking as
    // the property read it is and the local one erased it.
    const mergeText = stripCommentsAndStrings(
      fs.readFileSync(path.join(REPO_ROOT, "src", "lib", "member-merge.ts"), "utf8"),
    );
    expect(mergeText).not.toContain("maxFamilyRole");
    expect(mergeText).not.toMatch(/familyGroupMember\s*\.\s*update\b/);
  });
});
