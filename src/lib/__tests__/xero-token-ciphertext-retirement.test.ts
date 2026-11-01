// #3806 R2 — no production code reads or writes `XeroToken.accessToken` or
// `XeroToken.refreshToken` any more.
//
// Since R2 the Xero tokens live only in the credential store, and the connection
// facts and the refresh lease in `XeroConnection`. The two ciphertext columns stay
// in the database only because the previous release (#3454) can still run beside
// this one, and R3 drops the table. Until then, a write to them would plant a
// token the previous release reads as the newer copy, and a read would mean this
// release still depends on a copy it no longer keeps current.
//
// THREE LAYERS, each covering what the one before cannot:
//
//   * THE SCHEMA marks both fields `@ignore`, with the '' default the R2
//     migration gives the columns;
//   * THE GENERATED CLIENT therefore has no such fields: no call shape can put
//     them in a SELECT, an INSERT column list, a RETURNING or a WHERE (INV-OPS-005).
//     A `select`/`data` naming one still compiles and fails at runtime
//     (INV-OPS-006), so the delegate calls are scanned as well;
//   * RAW SQL is plain text the compiler cannot see. PostgreSQL folds an unquoted
//     identifier to lower case, so a statement can only reach this camel-case
//     table by QUOTING it. A statement can read the ciphertext without naming a
//     column (`SELECT *`, `t.*`, `row_to_json(t)`), so a production file that
//     names the quoted table at all is refused, unless it is on the short
//     allowlist below, each entry with its reason. (The token store itself uses
//     the generated client, so it needs no entry.)
//
// And `XeroConnection`, the table that replaces it, has exactly the six
// non-secret fields: a token column there would hold a secret the credential
// store never attributed (INV-PRIV-020).
//
// Migration history up to and including R2's own migration, and the fixtures
// that verify those migrations, may name the columns; R3's drop names the table,
// not the columns.
import fs from "node:fs";
import path from "node:path";

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { balancedBrackets } from "./support/balanced-brackets";
import { blankLiterals } from "./support/strip-comments";

const REPO_ROOT = process.cwd();
const SCAN_DIRS = ["src", "scripts", "e2e", "prisma"].map((dir) => path.join(REPO_ROOT, dir));
const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|mjs|js|sh|sql)$/;
const R2_MIGRATION = "20261124010000_add_xero_connection";
const R2_PREFIX = R2_MIGRATION.slice(0, 14);
const CIPHERTEXT_COLUMNS = ["accessToken", "refreshToken"] as const;
/** Production files that may name the quoted table, each with its reason. */
const QUOTED_TABLE_ALLOWLIST: Record<string, string> = {
  "scripts/audit/credential-actor-census.ts":
    "a comment explaining how the census matches the table's name",
};
const XERO_CONNECTION_FIELDS = [
  "id",
  "tenantId",
  "expiresAt",
  "refreshInProgressUntil",
  "createdAt",
  "updatedAt",
];
const FAILURE =
  "#3806 R2: production code must not read or write XeroToken.accessToken or " +
  "XeroToken.refreshToken. The tokens live in the credential store (xero-token-store.ts); " +
  "the connection and the lease live in XeroConnection.";

function walk(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "generated") continue;
      walk(full, files);
    } else if (SOURCE_EXTENSIONS.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

function isTestFile(rel: string): boolean {
  return rel.includes("__tests__") || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
}

/** Migration history and its verification fixtures, up to and including R2's. */
function isHistory(rel: string): boolean {
  const match =
    /^prisma\/(?:migrations\/(\d{14})_[^/]*\/[^/]+\.sql|migration-verification\/(\d{14})_[^/]*\.ts)$/.exec(
      rel,
    );
  if (!match) return false;
  return (match[1] ?? match[2])! <= R2_PREFIX;
}

/** Raw SQL naming the quoted table: it can reach the ciphertext without naming a column. */
function rawSqlNamesTable(source: string): boolean {
  return source.includes('"XeroToken"');
}

/** The argument text of every `xeroToken.<method>(…)` call, balanced. */
function xeroTokenDelegateCalls(source: string): string[] {
  if (!source.includes("xeroToken")) return [];
  // Found over masked text: a delegate call named in a comment or string is not one.
  const structure = blankLiterals(source);
  return [...structure.matchAll(/\bxeroToken\s*\.\s*\w+\s*\(/g)].map((match) =>
    balancedBrackets(source, match.index + match[0].length - 1, structure).text.slice(1, -1),
  );
}

function delegateCallNamesCiphertext(args: string): boolean {
  return CIPHERTEXT_COLUMNS.some((column) => new RegExp(`\\b${column}\\b`).test(args));
}

function productionSources(): { rel: string; text: string }[] {
  return SCAN_DIRS.flatMap((dir) => walk(dir))
    .map((file) => ({
      rel: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
      file,
    }))
    .filter(({ rel }) => !isTestFile(rel) && !isHistory(rel))
    .map(({ rel, file }) => ({ rel, text: fs.readFileSync(file, "utf8") }));
}

describe("XeroToken ciphertext retirement (#3806 R2)", () => {
  it("the schema ignores both ciphertext columns, with the migration's '' default", () => {
    const schema = fs.readFileSync(path.join(REPO_ROOT, "prisma", "schema.prisma"), "utf8");
    const model = /model XeroToken \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
    expect(model, FAILURE).not.toBe("");
    for (const column of CIPHERTEXT_COLUMNS) {
      expect(model, FAILURE).toMatch(
        new RegExp(`\\n\\s*${column}\\s+String\\s+@default\\(""\\)\\s+@ignore\\s*\\n`),
      );
    }
    const migration = fs.readFileSync(
      path.join(REPO_ROOT, "prisma", "migrations", R2_MIGRATION, "migration.sql"),
      "utf8",
    );
    for (const column of CIPHERTEXT_COLUMNS) {
      expect(migration).toContain(`ALTER COLUMN "${column}" SET DEFAULT ''`);
    }
  });

  it("the generated client has no field for either column", () => {
    const fields = Object.keys(Prisma.XeroTokenScalarFieldEnum);
    for (const column of CIPHERTEXT_COLUMNS) {
      expect(fields, FAILURE).not.toContain(column);
    }
    // The client is not vacuous: the columns it does read are still there.
    expect(fields).toEqual(expect.arrayContaining(["id", "tenantId", "expiresAt"]));
  });

  it("no production delegate call names either column", () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const { rel, text } of productionSources()) {
      for (const args of xeroTokenDelegateCalls(text)) {
        calls += 1;
        if (delegateCallNamesCiphertext(args)) offenders.push(rel);
      }
    }
    expect(offenders, FAILURE).toEqual([]);
    // The walk found the token store's own calls, so a clean result means something.
    expect(calls).toBeGreaterThanOrEqual(5);
  });

  it("no production raw SQL names the table outside the allowlist", () => {
    const sources = productionSources();
    const naming = sources.filter(({ text }) => rawSqlNamesTable(text)).map(({ rel }) => rel);
    const offenders = naming.filter((rel) => !(rel in QUOTED_TABLE_ALLOWLIST));
    expect(offenders, FAILURE).toEqual([]);
    // Every allowlist entry still earns its place.
    const unused = Object.keys(QUOTED_TABLE_ALLOWLIST).filter((rel) => !naming.includes(rel));
    expect(unused, "a stale allowlist entry hides nothing; delete it").toEqual([]);
    expect(sources.length).toBeGreaterThan(1000);
  });

  it("XeroConnection's generated fields are exactly the six non-secret ones", () => {
    expect(
      Object.keys(Prisma.XeroConnectionScalarFieldEnum).sort(),
      "#3806 R2: XeroConnection holds no token, ciphertext or key. A secret belongs in the " +
        "credential store, where every write is attributed (INV-PRIV-020); a new field here " +
        "must be reviewed and added to this list on purpose.",
    ).toEqual([...XERO_CONNECTION_FIELDS].sort());
  });

  it("the scanners see what they are for (seeded)", () => {
    expect(rawSqlNamesTable('SELECT "refreshToken" FROM "XeroToken"')).toBe(true);
    expect(rawSqlNamesTable('UPDATE "XeroToken" SET "accessToken" = $1')).toBe(true);
    expect(rawSqlNamesTable('SELECT * FROM "XeroToken"')).toBe(true);
    expect(rawSqlNamesTable('SELECT t.* FROM "XeroToken" t')).toBe(true);
    expect(rawSqlNamesTable('SELECT row_to_json(t) FROM "XeroToken" AS t')).toBe(true);
    expect(rawSqlNamesTable('SELECT * FROM "FinanceXeroToken"')).toBe(false);
    expect(rawSqlNamesTable('JSON.stringify({ "accessToken": x })')).toBe(false);

    const calls = xeroTokenDelegateCalls(
      "await tx.xeroToken.findFirst({ select: { refreshToken: true } });\n" +
        "await prisma.xeroToken.updateMany({ where: { id }, data: { expiresAt: f(a, b) } });",
    );
    expect(calls).toHaveLength(2);
    expect(delegateCallNamesCiphertext(calls[0]!)).toBe(true);
    expect(delegateCallNamesCiphertext(calls[1]!)).toBe(false);
    expect(calls[1]).toContain("f(a, b)");
  });

  it("history stops at R2's own migration: a later one naming the columns is scanned", () => {
    expect(isHistory(`prisma/migrations/${R2_MIGRATION}/migration.sql`)).toBe(true);
    expect(isHistory("prisma/migrations/20261201010000_later/migration.sql")).toBe(false);
    expect(isHistory(`prisma/migration-verification/${R2_MIGRATION}.ts`)).toBe(true);
    expect(isHistory("prisma/migration-verification/20261201010000_later.ts")).toBe(false);
  });
});
