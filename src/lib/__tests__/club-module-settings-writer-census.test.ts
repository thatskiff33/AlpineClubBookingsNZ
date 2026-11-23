/**
 * EVERY WAY AI DIAGNOSTICS CAN BE SWITCHED ON GOES THROUGH THE DISCLOSURE (#5243).
 *
 * Switching Diagnostics on sends excerpts of club data to its provider, so the
 * Modules route refuses to turn it on until the administrator has acknowledged
 * the provider disclosure (ADR-006 §2). That gate holds only while the route is
 * the one place the flag can turn on. This census pins the rest:
 *
 * - a fresh install, a migration or a derived flag never starts it on;
 * - the settings row is written by exactly the writers named below, each
 *   accounted for: the Modules route (gated), config transfer (which never
 *   carries the flag — its own tests apply a hand-edited bundle) and the E2E
 *   bootstrap (which must not name the flag);
 * - no raw SQL outside the migrations writes the row.
 *
 * A direct database edit or a backup restore is outside the application and
 * cannot be gated; `docs/ai-diagnostics/deployment.md` says so.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_KEYS,
  getEffectiveModuleFlags,
  type ModuleSettingsValues,
} from "@/config/modules";
import { CENSUS_TIMEOUT_MS } from "@/test/census-timeout";
import { delegateUsesBeyondReads, productionSourceFiles } from "./support/prisma-delegate-read-scan";
import { schemaDefaultToken } from "./support/prisma-schema-default";
import { stripComments } from "./support/strip-comments";

const ROOT = process.cwd();
const DELEGATE = "clubModuleSettings";
/** A SQL statement that writes the table, however its name is quoted or qualified. */
const SQL_WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE|COPY)\s+(?:TABLE\s+)?(?:ONLY\s+)?(?:"?public"?\.)?"?ClubModuleSettings\b/i;

/** The writers of the settings row, and why each cannot switch Diagnostics on unacknowledged. */
const WRITERS: Record<string, string> = {
  "src/app/api/admin/modules/route.ts":
    "the Modules route: refuses to switch Diagnostics on without the disclosure acknowledgement",
  "src/lib/config-transfer/categories/club-settings.ts":
    "config transfer's singleton spec: aiDiagnostics is excluded from the travelling fields",
  "e2e/setup/enable-e2e-modules.ts":
    "the E2E bootstrap: its MODULES never include aiDiagnostics (pinned below)",
};

/**
 * Places that name the delegate without writing through it: they hand it to a
 * function whose parameter type allows reads only, or list it as a model
 * name. Each was read when this census was written; a new entry needs the same.
 */
const NON_WRITING_USES: Record<string, string> = {
  "src/config/modules.ts": "declares the column select and a read-only client type",
  "src/lib/admin-modules.ts": "passes the delegate to a findUnique-only reader",
  "src/lib/lodge-capacity.ts": "passes the delegate to a findUnique-only reader",
  "src/lib/member-guest-add-policy.ts": "types the delegate as findUnique-only to probe for it",
  "src/lib/step-up-routes.ts": "lists the model's write methods for the step-up rule",
};

/** Non-test source under `e2e/` (helpers, setup), which drives the E2E database directly. */
function e2eSourceFiles(): string[] {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "__tests__"].includes(entry.name) ? [] : walk(path);
    return /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)
      ? [relative(ROOT, path).split(sep).join("/")]
      : [];
  });
  return walk(join(ROOT, "e2e"));
}

/** Shell and SQL files outside the migrations, where an operator write would live. */
function shellAndSqlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "migrations", ".next", ".git"].includes(entry.name) ? [] : shellAndSqlFiles(path);
    return /\.(sql|sh)$/.test(entry.name) ? [relative(ROOT, path).split(sep).join("/")] : [];
  });
}

const naming = [...productionSourceFiles(ROOT), ...e2eSourceFiles()]
  .map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }))
  .filter(({ text }) => /clubModuleSettings|ClubModuleSettings/.test(text));

const usesBeyondReads = (text: string, file: string) =>
  delegateUsesBeyondReads(text, file, (name) => name === DELEGATE);

describe("AI Diagnostics starts off everywhere (#5243)", () => {
  it("defaults off in the schema and in the application defaults", () => {
    const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
    expect(schemaDefaultToken(schema, "ClubModuleSettings", "aiDiagnostics")).toBe("false");
    expect(DEFAULT_MODULE_SETTINGS.aiDiagnostics).toBe(false);
  });

  it("is not derived from any other flag", () => {
    const everyOtherOn = Object.fromEntries(
      MODULE_KEYS.map((key) => [key, key !== "aiDiagnostics"]),
    ) as ModuleSettingsValues;
    expect(getEffectiveModuleFlags(everyOtherOn).aiDiagnostics).toBe(false);
  });

  it("is switched on by no migration", () => {
    const dir = join(ROOT, "prisma", "migrations");
    const sqlFiles = readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? readdirSync(join(dir, entry.name)).filter((name) => name.endsWith(".sql")).map((name) => `${entry.name}/${name}`)
        : [],
    );
    expect(sqlFiles.length, "the migration scan found nothing to read").toBeGreaterThan(0);
    const offenders = sqlFiles.filter((file) =>
      readFileSync(join(dir, file), "utf8")
        .replace(/--.*$/gm, "")
        .split(";")
        .some((statement) => /"?aiDiagnostics"?/.test(statement) && /\btrue\b/i.test(statement)));
    expect(offenders).toEqual([]);
  });
});

describe("the module settings row has known writers only (#5243)", { timeout: CENSUS_TIMEOUT_MS }, () => {
  it("is written through its delegate by the named writers only", () => {
    const found = Object.fromEntries(
      naming
        .map(({ file, text }) => [file, usesBeyondReads(text, file)] as const)
        .filter(([, uses]) => uses.length > 0)
        .map(([file, uses]) => [file, uses.map(({ line, text }) => `${line}: ${text}`)]),
    );
    expect(Object.keys(found).sort()).toEqual(
      [...Object.keys(WRITERS), ...Object.keys(NON_WRITING_USES)].sort(),
    );
  });

  it("the E2E bootstrap never switches Diagnostics on", () => {
    const text = stripComments(readFileSync(join(ROOT, "e2e/setup/enable-e2e-modules.ts"), "utf8"));
    expect(text).toMatch(/const MODULES = \{/);
    expect(text).not.toMatch(/aiDiagnostics/);
  });

  it("is written by no raw SQL, in source or in a shell or SQL file outside the migrations", () => {
    expect(naming.filter(({ text }) => SQL_WRITE.test(stripComments(text))).map(({ file }) => file)).toEqual([]);
    const scripts = ["scripts", "prisma", "docker", "e2e"].flatMap((dir) => {
      try { return shellAndSqlFiles(join(ROOT, dir)); } catch { return []; }
    });
    expect(scripts.length, "the shell and SQL scan found nothing to read").toBeGreaterThan(0);
    expect(scripts.filter((file) => SQL_WRITE.test(readFileSync(join(ROOT, file), "utf8")))).toEqual([]);
  });

  it("is not vacuous: the writers are scanned, and every writer shape is caught", () => {
    const scanned = naming.map(({ file }) => file);
    for (const writer of Object.keys(WRITERS)) expect(scanned).toContain(writer);
    for (const write of [
      "await prisma.clubModuleSettings.upsert({ where, create, update });",
      'await db["clubModuleSettings"].update({ where, data });',
      "const { clubModuleSettings } = prisma; await clubModuleSettings.create({ data });",
      'const spec = { delegate: "clubModuleSettings" };',
    ]) {
      expect(usesBeyondReads(write, "fixture.ts").length, write).toBeGreaterThan(0);
    }
    expect('await prisma.$executeRaw`UPDATE "ClubModuleSettings" SET "aiDiagnostics" = true`').toMatch(SQL_WRITE);
  });
});
