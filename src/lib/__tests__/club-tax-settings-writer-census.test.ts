/**
 * Nothing writes the club's tax setting yet (#4626, Ledger M3a).
 *
 * Two places answer "how is this club taxed?" today: `ClubTaxSettings`, which
 * the member-money journal splits charges under, and the Xero renderers, which
 * hard-code the GST-inclusive OUTPUT2 code (#4632). They agree only while the
 * setting holds its default. So until the change that routes Xero's tax type
 * through the setting, no production code may write the row: not the app, a
 * seed, a script, nor config transfer. This census fails on any such writer.
 * Migrations (SQL) and tests are outside it. When #4632's surface lands, it
 * retires this census in the same change.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_LEVEL_EXCLUSIONS } from "@/lib/config-transfer/singleton-models";
import { delegateUsesBeyondReads, productionSourceFiles } from "./support/prisma-delegate-read-scan";
import { stripComments } from "./support/strip-comments";

const ROOT = process.cwd();
const DELEGATE = "clubTaxSettings";
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

describe("the club tax setting has no writer until Xero reads it (#4632)", () => {
  it("is only ever read through its delegate", () => {
    const offenders = naming.flatMap(({ file, text }) =>
      delegateUsesBeyondReads(text, file, (name) => name === DELEGATE).map(({ line, text: code }) => `${file}:${line} ${code}`));
    expect(offenders, "a production path writes ClubTaxSettings while Xero still hard-codes its tax type").toEqual([]);
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
