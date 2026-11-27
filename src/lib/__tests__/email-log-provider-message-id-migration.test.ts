import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #5469: the two expand-only migrations that store the mail server's id, held
 * to the schema they must produce (CI's migration drift job applies them to a
 * real database) and to their blue-green ledger rows (the deploy guard and
 * `check-migration-safety-coverage.sh`). The index is in its own file so the
 * column's ACCESS EXCLUSIVE lock is not held through the build. Disk-scanning:
 * run by name.
 */
const ROOT = process.cwd();
const COLUMN = "20270107090000_add_email_log_provider_message_id";
const INDEX = "20270107090100_add_email_log_provider_message_id_index";
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

function sqlStatements(migration: string): string[] {
  return read(`prisma/migrations/${migration}/migration.sql`)
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

describe("the EmailLog.providerMessageId migrations (#5469)", () => {
  it("MUTATION: the column's file adds one nullable column and nothing else", () => {
    expect(sqlStatements(COLUMN)).toEqual(['ALTER TABLE "EmailLog" ADD COLUMN "providerMessageId" TEXT']);
  });

  it("MUTATION: the index is its own file, and keeps an index an operator built beforehand", () => {
    expect(sqlStatements(INDEX)).toEqual([
      'CREATE INDEX IF NOT EXISTS "EmailLog_providerMessageId_idx" ON "EmailLog"("providerMessageId")',
    ]);
  });

  it("matches the schema the drift check compares them with", () => {
    const schema = read("prisma/schema.prisma");
    const model = schema.slice(schema.indexOf("model EmailLog {"), schema.indexOf("model EmailSuppression {"));
    expect(model).toMatch(/^\s*providerMessageId\s+String\?\s*$/m);
    expect(model).toMatch(/^\s*@@index\(\[providerMessageId\]\)\s*$/m);
  });

  it.each([[COLUMN], [INDEX]])("%s has an expand, old-code-compatible row in the blue-green ledger", (migration) => {
    const row = read("docs/BLUE_GREEN_MIGRATION_SAFETY.tsv")
      .split("\n")
      .map((line) => line.split("\t"))
      .find((cells) => cells[0] === migration);
    expect(row?.slice(0, 4)).toEqual([migration, "expand", "n/a", "yes"]);
    expect(row?.[4]).toMatch(/OLD-CODE COMPATIBLE/);
    expect(row?.[4]).toMatch(/LOCK IMPACT/);
  });

  it("the index row says the lock timeout bounds the wait, not the build, and how to build it out of band", () => {
    const row = read("docs/BLUE_GREEN_MIGRATION_SAFETY.tsv")
      .split("\n")
      .find((line) => line.startsWith(`${INDEX}\t`));
    expect(row).toMatch(/bounds only the wait to acquire the lock, not the build/);
    expect(row).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  });

  it("each is the only migration with its timestamp prefix, and the index sorts after the column", () => {
    const folders = readdirSync(path.join(ROOT, "prisma/migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    for (const migration of [COLUMN, INDEX]) {
      expect(folders.filter((name) => name.slice(0, 14) === migration.slice(0, 14))).toEqual([migration]);
    }
    expect([INDEX, COLUMN].sort()).toEqual([COLUMN, INDEX]);
  });
});
