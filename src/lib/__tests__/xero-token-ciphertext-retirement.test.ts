// #3806 — the `XeroToken` table is gone. The tokens live only in the credential
// store, and the connection facts and the refresh lease in `XeroConnection`.
//
//   * THE SCHEMA has no `model XeroToken`, so the generated client has no
//     `Prisma.XeroTokenScalarFieldEnum`;
//   * no production source under `src`, `scripts` or `e2e` calls the
//     `xeroToken` delegate;
//   * raw SQL may quote `"XeroToken"` only in this release's drop
//     (`migration.sql` and `rollback.sql`) and in history at or before R2.
//     `"FinanceXeroToken"` does not match, because the quotes sit before Finance.
//
// `XeroConnection` has exactly the six non-secret fields: a token column there
// would hold a secret the credential store never attributed (INV-PRIV-020).
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
const DROP_MIGRATION = "prisma/migrations/20261210100000_contract_drop_xero_token";
/** This release's drop is the only non-history SQL that may quote the table. */
const QUOTED_TABLE_ALLOWLIST = [
  `${DROP_MIGRATION}/migration.sql`,
  `${DROP_MIGRATION}/rollback.sql`,
];
const CIPHERTEXT_COLUMNS = ["accessToken", "refreshToken"] as const;
const DELEGATE_SCAN_DIRS = ["src", "scripts", "e2e"];
const XERO_CONNECTION_FIELDS = [
  "id",
  "tenantId",
  "expiresAt",
  "refreshInProgressUntil",
  "createdAt",
  "updatedAt",
];
const FAILURE =
  "#3806: the XeroToken table is gone. Tokens live in the credential store " +
  "(xero-token-store.ts); the connection and the lease live in XeroConnection.";

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

describe("XeroToken retirement (#3806)", () => {
  it("the schema has no XeroToken model", () => {
    const schema = fs.readFileSync(path.join(REPO_ROOT, "prisma", "schema.prisma"), "utf8");
    expect(schema, FAILURE).not.toMatch(/\bmodel XeroToken\b/);
  });

  it("the generated client has no XeroToken scalar enum", () => {
    expect("XeroTokenScalarFieldEnum" in Prisma, FAILURE).toBe(false);
  });

  it("no production source under src, scripts or e2e calls the xeroToken delegate", () => {
    const offenders: string[] = [];
    for (const { rel, text } of productionSources()) {
      if (!DELEGATE_SCAN_DIRS.some((dir) => rel.startsWith(`${dir}/`))) continue;
      if (xeroTokenDelegateCalls(text).length > 0) offenders.push(rel);
    }
    expect(offenders, FAILURE).toEqual([]);
  });

  it("raw SQL quotes the table only in this drop and in history", () => {
    const sources = productionSources();
    const naming = sources.filter(({ text }) => rawSqlNamesTable(text)).map(({ rel }) => rel);
    expect(naming.sort(), FAILURE).toEqual([...QUOTED_TABLE_ALLOWLIST].sort());
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
