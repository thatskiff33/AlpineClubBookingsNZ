/**
 * ONE WRITER of the club's tax treatment (#4632; `INV-CONFIG-007`).
 *
 * M3a (#4626) forbade any writer while the Xero renderers hard-coded their tax
 * code. #4632 routed every Xero document through the one renderer and added
 * the one writer, `club-tax-settings-write.ts`, which only adds or cancels
 * periods that start after the club's today, audits each change, and never
 * touches the baseline. Every other production path — the app, a seed, a
 * script, config transfer — stays a reader, so history cannot be rewritten
 * behind the writer's rules. Migrations (SQL) and tests are outside it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_LEVEL_EXCLUSIONS } from "@/lib/config-transfer/singleton-models";
import { delegateUsesBeyondReads, productionSourceFiles } from "./support/prisma-delegate-read-scan";
import { stripComments } from "./support/strip-comments";

const ROOT = process.cwd();
const DELEGATE = "clubTaxSettings";
const WRITER = "src/lib/club-tax-settings-write.ts";
/** A SQL statement that writes the table, however its name is quoted or qualified. */
const SQL_WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE|COPY)\s+(?:TABLE\s+)?(?:ONLY\s+)?(?:"?public"?\.)?"?ClubTaxSettings\b/i;

const naming = productionSourceFiles(ROOT)
  .map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }))
  .filter(({ text }) => /clubTaxSettings|ClubTaxSettings/.test(text));

/** Shell and SQL files outside the migrations, where an operator write would live. */
function shellAndSqlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "migrations", ".next", ".git"].includes(entry.name) ? [] : shellAndSqlFiles(path);
    return /\.(sql|sh)$/.test(entry.name) ? [relative(ROOT, path).split(sep).join("/")] : [];
  });
}

describe("the club tax treatment has one writer (#4632)", () => {
  it("is written through its delegate by the one writer only", () => {
    const offenders = naming
      .filter(({ file }) => file !== WRITER)
      .flatMap(({ file, text }) =>
        delegateUsesBeyondReads(text, file, (name) => name === DELEGATE).map(({ line, text: code }) => `${file}:${line} ${code}`));
    expect(offenders, `a production path other than ${WRITER} writes ClubTaxSettings`).toEqual([]);
  });

  it("the writer only creates periods and deletes non-baseline ones", () => {
    const writer = naming.find(({ file }) => file === WRITER);
    expect(writer, "the writer was not scanned").toBeDefined();
    const lines = writer!.text.split("\n");
    const writes = delegateUsesBeyondReads(writer!.text, WRITER, (name) => name === DELEGATE).map(({ line }) => lines[line - 1]!);
    expect(writes.length).toBe(2);
    expect(writes.some((text) => /\.create\(/.test(text))).toBe(true);
    expect(writes.some((text) => /\.deleteMany\(/.test(text))).toBe(true);
    // The delete is fenced off the baseline row in its own where clause.
    expect(stripComments(writer!.text)).toMatch(/deleteMany\(\{\s*where: \{[^}]*\}?[^}]*id: \{ not: CLUB_TAX_SETTINGS_ID \}/);
  });

  it("is written by no raw SQL, in source or in a shell or SQL file outside the migrations", () => {
    expect(naming.filter(({ text }) => SQL_WRITE.test(stripComments(text))).map(({ file }) => file)).toEqual([]);
    const scripts = ["scripts", "prisma", "docker"].flatMap((dir) => {
      try { return shellAndSqlFiles(join(ROOT, dir)); } catch { return []; }
    });
    expect(scripts.length, "the shell and SQL scan found nothing to read").toBeGreaterThan(0);
    expect(scripts.filter((file) => SQL_WRITE.test(readFileSync(join(ROOT, file), "utf8")))).toEqual([]);
  });

  it("does not travel by config transfer", () => {
    expect(Object.keys(MODEL_LEVEL_EXCLUSIONS)).toContain("ClubTaxSettings");
  });

  it("is not vacuous: the reader is scanned, and every writer shape is caught", () => {
    expect(naming.map(({ file }) => file)).toContain("src/lib/club-tax-settings.ts");
    expect(naming.map(({ file }) => file)).toContain(WRITER);
    for (const write of [
      "await prisma.clubTaxSettings.upsert({ where, create, update });",
      'await db["clubTaxSettings"].update({ where, data });',
      "const { clubTaxSettings } = prisma; await clubTaxSettings.create({ data });",
      "await prisma?.clubTaxSettings?.deleteMany();",
    ]) {
      expect(delegateUsesBeyondReads(write, "fixture.ts", (name) => name === DELEGATE).length, write).toBeGreaterThan(0);
    }
    expect('await prisma.$executeRaw`UPDATE "ClubTaxSettings" SET "gstRegistered" = false`').toMatch(SQL_WRITE);
    expect("INSERT INTO public.ClubTaxSettings VALUES (1)").toMatch(SQL_WRITE);
  });
});
