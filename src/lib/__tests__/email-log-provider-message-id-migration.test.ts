import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #5469: the expand-only migration that stores the mail server's id, held to
 * the schema it must produce (CI's migration drift job applies it to a real
 * database) and to its blue-green ledger row (the deploy guard and
 * `check-migration-safety-coverage.sh`). Disk-scanning: run by name.
 */
const ROOT = process.cwd();
const MIGRATION = "20270107090000_add_email_log_provider_message_id";
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

function sqlStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

describe("the EmailLog.providerMessageId migration (#5469)", () => {
  it("adds one nullable column and its index, and nothing else", () => {
    expect(sqlStatements(read(`prisma/migrations/${MIGRATION}/migration.sql`))).toEqual([
      'ALTER TABLE "EmailLog" ADD COLUMN "providerMessageId" TEXT',
      'CREATE INDEX "EmailLog_providerMessageId_idx" ON "EmailLog"("providerMessageId")',
    ]);
  });

  it("matches the schema the drift check compares it with", () => {
    const schema = read("prisma/schema.prisma");
    const model = schema.slice(schema.indexOf("model EmailLog {"), schema.indexOf("model EmailSuppression {"));
    expect(model).toMatch(/^\s*providerMessageId\s+String\?\s*$/m);
    expect(model).toMatch(/^\s*@@index\(\[providerMessageId\]\)\s*$/m);
  });

  it("has an expand, old-code-compatible row in the blue-green ledger", () => {
    const row = read("docs/BLUE_GREEN_MIGRATION_SAFETY.tsv")
      .split("\n")
      .map((line) => line.split("\t"))
      .find((cells) => cells[0] === MIGRATION);
    expect(row?.slice(0, 4)).toEqual([MIGRATION, "expand", "n/a", "yes"]);
    expect(row?.[4]).toMatch(/OLD-CODE COMPATIBLE/);
  });

  it("is the only migration with its timestamp prefix", () => {
    const folders = readdirSync(path.join(ROOT, "prisma/migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(folders.filter((name) => name.slice(0, 14) === MIGRATION.slice(0, 14))).toEqual([MIGRATION]);
  });
});
