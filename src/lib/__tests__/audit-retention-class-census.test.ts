import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AUDIT_RETENTION_CLASSES } from "@/lib/audit-retention-classes";
import { expressionAt } from "./support/balanced-brackets";
import { blankLiterals, stripComments } from "./support/strip-comments";

/**
 * #3940: `AuditLog.retentionClass` is free text, so a value outside
 * `AUDIT_RETENTION_CLASSES` is storable. The nightly prune now reads such a
 * row as unclassified (owner decision, 17 Oct 2026), so it no longer lives
 * forever; this census keeps every writer on the known four in the first
 * place, so the fallback stays a safety net rather than a schedule.
 *
 * - `src/`: every quoted string literal in a `retentionClass:` property's
 *   value (up to the next `,` or `}` at the same depth, so both arms of a
 *   ternary and a parenthesised cast count) must name a known class. Typed
 *   writers already get this from `AuditRetentionClass`; this is the backstop
 *   for an untyped or cast write. A template literal there is refused.
 * - `prisma/migrations/`: an insert into "AuditLog" must list "retentionClass"
 *   directly before "expiresAt" (the shape every such migration uses) and write
 *   its class as the literal just before the `expiresAt` expression; any other
 *   shape is unreadable and fails rather than passes. An `UPDATE "AuditLog"`
 *   that sets "retentionClass" must set a known literal.
 *
 * Disk-scanning: run by name.
 */
const ROOT = process.cwd();
const KNOWN = new Set<string>(AUDIT_RETENTION_CLASSES);
const PREFIX = "#3940 audit retention class census (see docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md)";

function walk(dir: string, accept: (file: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : walk(full, accept);
    return accept(full) ? [full] : [];
  });
}

const relative = (file: string) => path.relative(ROOT, file);

/** The text of a property's value: from after the colon to the next `,` or `}` at depth 0. */
function propertyValueAt(source: string, start: number, structure: string): string {
  // A quoted string is skipped whole, so a `,` or bracket inside it never ends the value.
  return expressionAt(source, start, structure).text;
}

function retentionClassLiteralsIn(source: string): string[] {
  const code = stripComments(source);
  if (!code.includes("retentionClass")) return [];
  const structure = blankLiterals(code);
  return [...code.matchAll(/\bretentionClass\s*:/g)].flatMap((match) => {
    const raw = propertyValueAt(code, match.index + match[0].length, structure);
    // A filter or the archive DDL manifest's `{ ddl }` is not a class value;
    // Prisma's `{ set: … }` is a write, so its literals are read like any other.
    if (/^\s*\{\s*(?:in|notIn|not|equals|ddl)\s*:/.test(raw)) return [];
    if (raw.includes("`")) return ["<template literal>"];
    // A comparison operand is a condition, not a value written to the column.
    const value = raw
      .replace(/(?:===|!==|==|!=)\s*["'][^"']*["']/g, "")
      .replace(/["'][^"']*["']\s*(?:===|!==|==|!=)/g, "");
    return [...value.matchAll(/["']([^"']*)["']/g)].map((literal) => literal[1]);
  });
}

function migrationAuditInsertClasses(sql: string): Array<string | null> {
  const statements = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/);
  const inserts = statements
    .filter((statement) => /INSERT\s+INTO\s+"AuditLog"\s*\([^)]*"retentionClass"/i.test(statement))
    .map((statement) => {
      // Readable only when the class column sits directly before expiresAt, so
      // the literal before the expiry expression is provably the class.
      if (!/"retentionClass"\s*,\s*"expiresAt"/.test(statement)) return null;
      const match = statement.match(/'([^']*)'\s*,\s*\n\s*timezone\('UTC',\s*statement_timestamp\(\)\)\s*\+\s*interval/);
      return match ? match[1] : null;
    });
  const setClauseOf = (statement: string) =>
    statement.match(/\bSET\b([\s\S]*?)(?:\bWHERE\b|\bFROM\b|$)/i)?.[1] ?? "";
  // Only a statement whose SET assigns the class is checked, and only a plain
  // literal there is readable; a CASE or other expression reads as null and fails.
  const updates = statements
    .filter((statement) => /UPDATE\s+"AuditLog"/i.test(statement) && /"retentionClass"\s*=/.test(setClauseOf(statement)))
    .map((statement) => setClauseOf(statement).match(/"retentionClass"\s*=\s*'([^']*)'\s*(?:,|$)/)?.[1] ?? null);
  return [...inserts, ...updates];
}

describe("audit retention class writers stay on the known set (#3940)", () => {
  it("every retentionClass literal in src names a known class", () => {
    const offenders = walk(path.join(ROOT, "src"), (file) => /\.(ts|tsx)$/.test(file) && !file.includes("__tests__"))
      .flatMap((file) =>
        retentionClassLiteralsIn(readFileSync(file, "utf8"))
          .filter((value) => !KNOWN.has(value))
          .map((value) => `${relative(file)}: "${value}"`)
      );
    expect(offenders, `${PREFIX}: unknown retentionClass literal`).toEqual([]);
  });

  it("every migration that inserts an audit row writes a known class", () => {
    const migrations = walk(path.join(ROOT, "prisma", "migrations"), (file) => file.endsWith(".sql"));
    const inserts = migrations.flatMap((file) =>
      migrationAuditInsertClasses(readFileSync(file, "utf8")).map((value) => ({ file: relative(file), value }))
    );
    expect(inserts.length, `${PREFIX}: the scan found no audit-row inserts to check`).toBeGreaterThan(0);
    const offenders = inserts
      .filter(({ value }) => value === null || !KNOWN.has(value))
      .map(({ file, value }) => `${file}: ${value === null ? "class not readable by this scan" : `"${value}"`}`);
    expect(offenders, `${PREFIX}: an audit-row insert's class is unknown or unreadable`).toEqual([]);
  });

  it("the scanners catch what they claim to", () => {
    expect(retentionClassLiteralsIn('logAudit({ retentionClass: "standrad" })')).toEqual(["standrad"]);
    expect(retentionClassLiteralsIn('x = { retentionClass: overbooked ? "critical" : undefined }')).toEqual(["critical"]);
    expect(retentionClassLiteralsIn("// retentionClass: \"commented\"\nconst a = 1;")).toEqual([]);
    expect(retentionClassLiteralsIn('{ retentionClass: c ? "critical" : "standrad", x: "y" }')).toEqual(["critical", "standrad"]);
    expect(retentionClassLiteralsIn('{ retentionClass: c ? undefined : "standrad" }')).toEqual(["standrad"]);
    expect(retentionClassLiteralsIn('{ retentionClass: ("standrad" as AuditRetentionClass) }')).toEqual(["standrad"]);
    expect(retentionClassLiteralsIn("{ retentionClass: `${a}` }")).toEqual(["<template literal>"]);
    expect(retentionClassLiteralsIn('{ retentionClass: audience === "admin" ? log.retentionClass : undefined }')).toEqual([]);
    expect(retentionClassLiteralsIn('{ retentionClass: { ddl: "TEXT" } }')).toEqual([]);
    expect(retentionClassLiteralsIn('{ retentionClass: { in: ["critical"] } }')).toEqual([]);
    expect(retentionClassLiteralsIn('{ retentionClass: { set: "standrad" } }')).toEqual(["standrad"]);
    expect(retentionClassLiteralsIn('{ retentionClass: c ? "a,b)" : "standrad" }')).toEqual(["a,b)", "standrad"]);
    const sql = `INSERT INTO "AuditLog" ("id", "retentionClass", "expiresAt")\nSELECT\n  'x',\n  'standrad',\n  timezone('UTC', statement_timestamp()) + interval '7 years';\n`;
    expect(migrationAuditInsertClasses(sql)).toEqual(["standrad"]);
    expect(migrationAuditInsertClasses(`INSERT INTO "AuditLog" ("id", "retentionClass") VALUES ('x', 'critical');`)).toEqual([null]);
    const reordered = `INSERT INTO "AuditLog" ("id", "retentionClass", "severity", "expiresAt")\nSELECT\n  'x',\n  'standrad',\n  'critical',\n  timezone('UTC', statement_timestamp()) + interval '7 years';\n`;
    expect(migrationAuditInsertClasses(reordered)).toEqual([null]);
    expect(migrationAuditInsertClasses(`UPDATE "AuditLog" SET "retentionClass" = 'standrad' WHERE "id" = 'x';`)).toEqual(["standrad"]);
    expect(
      migrationAuditInsertClasses(
        `UPDATE "AuditLog" SET "retentionClass" = CASE WHEN true THEN 'standrad' END WHERE "retentionClass" = 'critical';`
      )
    ).toEqual([null]);
    expect(
      migrationAuditInsertClasses(`UPDATE "AuditLog" SET "category" = 'admin' WHERE "retentionClass" = 'standrad';`)
    ).toEqual([]);
  });
});
