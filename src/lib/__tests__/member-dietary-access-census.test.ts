/**
 * The member dietary/allergy access census (#2941, `INV-PRIV-022`).
 *
 * WHAT THIS GATE IS FOR. `Member.dietaryRequirements` is special-category
 * personal data, children's included. It is protected by RUNTIME absence, not
 * by a filter: every application Prisma client is constructed with
 * `omit: PRISMA_CLIENT_GLOBAL_OMIT`, so a Member read that does not ask for the
 * column never carries it, and `src/lib/member-dietary.ts` is the one module
 * that asks, for a caller holding a grant.
 *
 * `src/lib/prisma.ts` TYPES the client as the plain `PrismaClient` (an omit-typed
 * client is not assignable to `Prisma.TransactionClient`, and re-typing ~160
 * helpers was measured and rejected there). So the compiler still believes the
 * field is on every row. This census is a TEXT scan over `src/`, `scripts/`,
 * `prisma/` and `e2e/`, and it holds exactly these rules:
 *
 *  1. SELECT/OMIT: `dietaryRequirements: true|false` (a select, an include, a
 *     local `omit` override) appears only in the canonical module and the omit
 *     constant.
 *  2. RAW SQL: no file that issues raw SQL names the column, and no file reads a
 *     whole row (`SELECT *` in its spellings, `alias.*`, `TABLE "Member"`, a
 *     JSON row function). One classified exemption, fenced by column grants.
 *  3. CONSTRUCTOR: every `new …PrismaClient(`, including namespaced and aliased
 *     spellings, passes `omit: PRISMA_CLIENT_GLOBAL_OMIT`, except the seeds,
 *     E2E harnesses and the deploy rehearsal, each classified with its reason.
 *  4. REACH: in `src/`, the identifier's SPELLING outside comments is confined
 *     to a listed set of files.
 *  5. IMPORT: in every root, importing the canonical module is confined to a
 *     listed set of files, and no file re-exports a grant or reader.
 *  6. EGRESS: no file on either list sits on a Xero, analytics, notification,
 *     email, roster, lodge-screen, kiosk, family, booking, finance or logging
 *     path.
 *
 * WHAT IT CANNOT SEE, stated so nobody reads it as stronger than it is. It
 * matches text, not data flow. A listed file that reads `.dietaryRequirements`
 * off an ordinary row gets `undefined` (never the value) and stays green; so
 * does code that walks a row's keys generically. A value, once a listed file
 * holds it, can be passed on to anything; rules 5 and 6 confine who can obtain
 * it, not where it goes next. Those are review's job, and INV-PRIV-022 says so.
 *
 * Scanned from disk, so `vitest related` cannot reach it: run it by name,
 * `npm run test:named -- src/lib/__tests__/member-dietary-access-census.test.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PRISMA_CLIENT_GLOBAL_OMIT } from "@/lib/prisma-global-omit";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

const INVARIANT_ID = "INV-PRIV-022";
const REPO_ROOT = path.resolve(__dirname, "../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

const CANONICAL_MODULE = "src/lib/member-dietary.ts";
const OMIT_CONSTANT_MODULE = "src/lib/prisma-global-omit.ts";

/**
 * Rule 4's list: every application file allowed to SPELL
 * `dietaryRequirements` outside a comment, and why.
 */
const DIETARY_REACH: Readonly<Record<string, string>> = {
  [CANONICAL_MODULE]: "the one door: grants, selects and the write patch",
  [OMIT_CONSTANT_MODULE]: "the client-wide omission itself",
  "src/components/member-dietary-requirements-field.tsx":
    "the one input, shared by self and admin screens",
  "src/app/api/profile/route.ts": "self writer (profile and onboarding)",
  "src/app/(authenticated)/profile/page.tsx": "self reader, ON only",
  "src/app/(authenticated)/profile/profile-details-card.tsx":
    "passes the self value to the form",
  "src/app/(authenticated)/profile/profile-form.tsx":
    "self form state; sends the key only while ON",
  "src/app/api/member/onboarding/route.ts": "self reader for onboarding, ON only",
  "src/components/member-onboarding-wizard.tsx": "onboarding form props",
  "src/app/api/member/data-export/route.ts":
    "the subject's own full export (ON or OFF, owner decision 20 Sep 2026)",
  "src/lib/admin-member-detail-service.ts":
    "membership-admin detail reader and editor writer",
  "src/lib/admin-member-edit-groups.ts": "admin Contact group form/payload",
  "src/app/(admin)/admin/members/[id]/_types.ts": "admin detail DTO type",
  "src/app/(admin)/admin/members/[id]/_components/member-contact-group.tsx":
    "admin Contact group display/editor",
  "src/lib/admin-members-service.ts": "membership-admin create writer",
  "src/app/(admin)/admin/members/_types.ts": "admin create form type",
  "src/app/(admin)/admin/members/_utils.ts": "admin create form default",
  "src/app/(admin)/admin/members/_components/member-editor-dialog.tsx":
    "admin create (never edit-from-list, whose DTO has no value)",
  "src/lib/member-csv-import.ts": "member CSV import parser",
  "src/app/api/admin/members/import/route.ts":
    "member CSV import writer, ON and membership:edit only",
  "src/lib/member-merge-field-rules.ts": "fill-if-blank merge rule",
  "src/lib/member-merge-field-kinds.ts": "merge screen value kind",
};

/**
 * Rule 5: the closed list of files that IMPORT the canonical module. Naming the
 * field is not the only way to reach the value: a file can mint a grant and
 * call a reader without ever spelling `dietaryRequirements`, so the import is
 * confined too, and every entry here is also checked against the egress
 * patterns.
 */
const DIETARY_MODULE_IMPORTERS: Readonly<Record<string, string>> = {
  "src/app/(authenticated)/profile/page.tsx": "self display grant",
  "src/app/api/profile/route.ts": "self write (profile and onboarding)",
  "src/app/api/member/onboarding/route.ts": "self display grant",
  "src/app/api/member/data-export/route.ts": "self data-export grant",
  "src/app/api/admin/members/[id]/route.ts": "membership grant from requireAdmin",
  "src/app/api/admin/members/route.ts": "membership grant for create",
  "src/app/api/admin/members/export/route.ts": "membership grant for the CSV column",
  "src/app/api/admin/members/import/route.ts": "membership grant for the CSV column",
  "src/app/api/admin/deletion-requests/[id]/route.ts":
    "the erasure patch only (no grant, no read)",
  "src/lib/admin-member-detail-service.ts": "admin detail read and edit",
  "src/lib/admin-members-service.ts": "admin create write",
  "src/lib/member-merge.ts": "merge: attach through the scoped merge grant, redact the audit",
};

/**
 * Rule 6: path fragments of surfaces the value must never reach. A reach or
 * importer entry matching one of these fails even when it is listed, so
 * widening either list onto an egress surface is refused rather than
 * rubber-stamped.
 */
const EGRESS_SURFACE_PATTERNS: readonly RegExp[] = [
  /xero/i,
  /analytics|gtag|telemetry/i,
  /notification|email|mailer|\bmail\b/i,
  /roster|lodge-screen|lobby|kiosk|hut-leader/i,
  /family/i,
  /booking/i,
  /finance|payment|invoice/i,
  /sentry|logger/i,
];

/** Rule 2's exemption: the only whole-row raw read, and why it is safe. */
const RAW_WILDCARD_EXEMPT: Readonly<Record<string, string>> = {
  "src/lib/diagnostics/tools/database.ts":
    "wraps operator SQL under the SELECT-only diagnostics role, whose Member " +
    "grant is a column allowlist that does not include dietaryRequirements " +
    "(provision-role.ts); PostgreSQL refuses the column (42501)",
};

/**
 * Rule 3's classification: clients that are NOT the application's and so do
 * not carry the omission. Each is a tool that never returns a Member value to
 * a person or a payload.
 */
const CONSTRUCTOR_EXEMPT: Readonly<Record<string, string>> = {
  "prisma/seed.ts": "seeds a fresh database; writes rows, returns none to anyone",
  "prisma/demo-seed.ts": "seeds demo data; writes rows, returns none to anyone",
  "scripts/rehearse-epic-deploy.ts":
    "rehearsal against a scratch database with the OLD generated client; reads " +
    "take:1 per model only to prove the columns resolve, and records counts",
  "e2e/helpers/rate-limit-counter.ts": "E2E harness against the test database",
  "e2e/helpers/setup-state.ts": "E2E harness against the test database",
  "e2e/setup/enable-e2e-modules.ts": "E2E harness against the test database",
  "e2e/setup/relativize-seasons.ts": "E2E harness against the test database",
  "e2e/setup/seed-second-lodge.ts": "E2E harness against the test database",
};

const RAW_SQL_API =
  /\$queryRaw|\$queryRawUnsafe|\$executeRaw|\$executeRawUnsafe|Prisma\.sql|Prisma\.raw/;
const SELECT_OR_OMIT = /["']?\bdietaryRequirements\b["']?\s*:\s*(?:true|false)\b/;
const IDENTIFIER = /\bdietaryRequirements\b/;
/**
 * A whole-row raw read: `SELECT *`, `SELECT*`, `SELECT DISTINCT *`,
 * `SELECT m.*` or `SELECT id, "Member".*`, a bare `TABLE "Member"` statement,
 * or a whole row turned into JSON (`row_to_json(m)`, `to_json(b)(m)`,
 * `json(b)_agg(m)`).
 */
const RAW_WILDCARD = new RegExp(
  [
    String.raw`\bSELECT\s*(?:DISTINCT\s+)?(?:(?:"?[A-Za-z_]\w*"?\s*\.\s*)?\*)`,
    String.raw`\bSELECT\b[^;\`]{0,400}?,\s*(?:"?[A-Za-z_]\w*"?\s*\.\s*)\*`,
    // `TABLE "Member"` as a statement of its own, not `ALTER TABLE "Member"`.
    String.raw`(?:^|[;(\`])\s*TABLE\s+"?Member"?\b`,
    // A whole row (a bare alias) turned into JSON; `jsonb_agg(col ->> 'x')`
    // aggregates an expression, not a row, and is not matched.
    String.raw`\b(?:row_to_json|to_jsonb?|jsonb?_agg)\s*\(\s*"?[A-Za-z_]\w*"?\s*\)`,
  ].join("|"),
  "im",
);
const DIETARY_MODULE_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](?:@\/lib\/|(?:\.{1,2}\/)+(?:[\w-]+\/)*)member-dietary["']/;
const DIETARY_REEXPORT =
  /export\s*\*\s*from\s*["'][^"']*member-dietary["']|export\s*\{[^}]*\b(?:grant\w*Dietary\w*|read\w*Dietary\w*|load\w*Dietary\w*|attachMergeDietary\w*)\b/;

type Finding = { rule: string; file: string; detail: string };

/** Every `new …PrismaClient(` call, including aliased and namespaced ones. */
function prismaConstructorStarts(code: string): number[] {
  const names = ["PrismaClient"];
  for (const match of code.matchAll(/\bPrismaClient\s+as\s+([A-Za-z_$][\w$]*)/g)) {
    names.push(match[1]!);
  }
  const alternation = names.map((name) => name.replace(/\$/g, "\\$")).join("|");
  const pattern = new RegExp(
    String.raw`\bnew\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)*(?:${alternation})\s*\(`,
    "g",
  );
  return [...code.matchAll(pattern)].map((match) => match.index! + match[0].length);
}

/** Pure scanner, so the mutation block below can seed it without the tree. */
export function scanDietaryAccessSource(file: string, source: string): Finding[] {
  const code = stripComments(source);
  const findings: Finding[] = [];
  const isApplication = file.startsWith("src/");

  if (
    SELECT_OR_OMIT.test(code) &&
    file !== CANONICAL_MODULE &&
    file !== OMIT_CONSTANT_MODULE
  ) {
    findings.push({
      rule: "select-or-omit",
      file,
      detail: "selects or overrides the omission of dietaryRequirements",
    });
  }

  if (RAW_SQL_API.test(code) && IDENTIFIER.test(code)) {
    findings.push({
      rule: "raw-sql",
      file,
      detail: "issues raw SQL and names dietaryRequirements",
    });
  }

  if (RAW_WILDCARD.test(code) && !(file in RAW_WILDCARD_EXEMPT)) {
    findings.push({
      rule: "raw-wildcard",
      file,
      detail:
        'reads a whole row through SELECT *, alias.*, TABLE "Member" or a JSON row function',
    });
  }

  if (!(file in CONSTRUCTOR_EXEMPT)) {
    for (const start of prismaConstructorStarts(code)) {
      const args = constructorArguments(code, start);
      if (!/\bomit\s*:\s*PRISMA_CLIENT_GLOBAL_OMIT\b/.test(args)) {
        findings.push({
          rule: "constructor",
          file,
          detail: "constructs a PrismaClient without omit: PRISMA_CLIENT_GLOBAL_OMIT",
        });
      }
    }
  }

  if (isApplication && IDENTIFIER.test(code) && !(file in DIETARY_REACH)) {
    findings.push({
      rule: "reach",
      file,
      detail: "names dietaryRequirements but is not in DIETARY_REACH",
    });
  }

  if (
    file !== CANONICAL_MODULE &&
    DIETARY_MODULE_IMPORT.test(code) &&
    !(file in DIETARY_MODULE_IMPORTERS)
  ) {
    findings.push({
      rule: "import",
      file,
      detail: "imports the dietary module but is not in DIETARY_MODULE_IMPORTERS",
    });
  }

  if (file !== CANONICAL_MODULE && DIETARY_REEXPORT.test(code)) {
    findings.push({
      rule: "reexport",
      file,
      detail: "re-exports a dietary grant or reader, widening the importer list unseen",
    });
  }

  return findings;
}

/** The text between a constructor's opening paren and its matching close. */
function constructorArguments(code: string, start: number): string {
  let depth = 1;
  for (let i = start; i < code.length; i += 1) {
    const char = code[i];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(start, i);
    }
  }
  return code.slice(start);
}

/**
 * The scanned roots. `src/` is the application; `scripts/`, `prisma/` and
 * `e2e/` hold operator CLIs, seeds and harnesses, which are held to every rule
 * except REACH (they may not name the field either way — none do) and whose
 * non-application clients are classified in CONSTRUCTOR_EXEMPT.
 */
const SCANNED_ROOTS = ["src", "scripts", "prisma", "e2e"] as const;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "__tests__" ||
        entry.name === "node_modules" ||
        entry.name === "migrations"
      ) {
        continue;
      }
      files.push(...sourceFiles(full));
    } else if (
      /\.(ts|tsx|mts|cts|mjs|js)$/.test(entry.name) &&
      !/\.(test|spec)\.(ts|tsx|mts|mjs|js)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

let cached: {
  files: string[];
  findings: Finding[];
  reached: string[];
  importers: string[];
} | null = null;
function census() {
  if (cached) return cached;
  const files = SCANNED_ROOTS.flatMap((root) =>
    sourceFiles(path.join(REPO_ROOT, root)),
  ).map(relative);
  const findings: Finding[] = [];
  const reached: string[] = [];
  const importers: string[] = [];
  for (const file of files) {
    const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
    findings.push(...scanDietaryAccessSource(file, source));
    const code = stripComments(source);
    if (file.startsWith("src/") && IDENTIFIER.test(code)) reached.push(file);
    if (file !== CANONICAL_MODULE && DIETARY_MODULE_IMPORT.test(code)) {
      importers.push(file);
    }
  }
  cached = { files, findings, reached: reached.sort(), importers: importers.sort() };
  return cached;
}

function report(findings: Finding[]): string {
  return findings.map((f) => `  ${f.rule}: ${f.file} — ${f.detail}`).join("\n");
}

describe(`member dietary access census (${INVARIANT_ID})`, () => {
  it("walks every scanned root", () => {
    // A walk that found nothing would pass every rule below vacuously.
    const { files } = census();
    expect(files.filter((f) => f.startsWith("src/")).length).toBeGreaterThan(500);
    for (const root of ["scripts/", "prisma/", "e2e/"]) {
      expect(files.some((f) => f.startsWith(root)), root).toBe(true);
    }
    expect(files).toContain(CANONICAL_MODULE);
  });

  it("the client-wide omission names Member.dietaryRequirements", () => {
    expect(PRISMA_CLIENT_GLOBAL_OMIT).toEqual({
      member: { dietaryRequirements: true },
    });
  });

  for (const rule of [
    "select-or-omit",
    "raw-sql",
    "raw-wildcard",
    "constructor",
    "reach",
    "import",
    "reexport",
  ] as const) {
    it(`finds no ${rule} violation`, () => {
      const violations = census().findings.filter((f) => f.rule === rule);
      expect(
        violations,
        `${INVARIANT_ID}: dietary/allergy data may be selected only by ${CANONICAL_MODULE}, ` +
          `for a caller holding a grant, from a client that omits it by default.\n` +
          report(violations),
      ).toEqual([]);
    });
  }

  it("every application PrismaClient constructor was actually seen", () => {
    // If this drops, the constructor rule could be passing because the scan no
    // longer sees either client.
    const constructing = census().files.filter(
      (file) =>
        !(file in CONSTRUCTOR_EXEMPT) &&
        prismaConstructorStarts(
          stripComments(readFileSync(path.join(REPO_ROOT, file), "utf8")),
        ).length > 0,
    );
    expect(constructing.sort()).toEqual([
      "src/lib/audit-retention.ts",
      "src/lib/prisma.ts",
    ]);
  });

  it("the constructor exemptions are exact: each still constructs a client", () => {
    const stale = Object.keys(CONSTRUCTOR_EXEMPT).filter(
      (file) =>
        prismaConstructorStarts(
          stripComments(readFileSync(path.join(REPO_ROOT, file), "utf8")),
        ).length === 0,
    );
    expect(stale).toEqual([]);
  });

  it("the reach list is exact: every listed file still names the field", () => {
    const stale = Object.keys(DIETARY_REACH).filter(
      (file) => !census().reached.includes(file),
    );
    expect(
      stale,
      `${INVARIANT_ID}: these DIETARY_REACH entries no longer name dietaryRequirements; remove them so the list matches the tree.`,
    ).toEqual([]);
    expect(census().reached).toEqual(Object.keys(DIETARY_REACH).sort());
  });

  it("the importer list is exact: every listed file still imports the module", () => {
    expect(census().importers).toEqual(Object.keys(DIETARY_MODULE_IMPORTERS).sort());
  });

  it("the real-database omission proof stays wired into the CI harness", () => {
    // It self-skips without RUN_CONCURRENCY_RACE_TESTS, so an unwired file
    // would pass everywhere while proving nothing.
    const harness = readFileSync(
      path.join(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./member-dietary-omit.realdb.test";');
  });

  it("no reach or importer entry is an egress surface", () => {
    const egress = [
      ...Object.keys(DIETARY_REACH),
      ...Object.keys(DIETARY_MODULE_IMPORTERS),
    ].filter((file) => EGRESS_SURFACE_PATTERNS.some((pattern) => pattern.test(file)));
    expect(
      egress,
      `${INVARIANT_ID}: dietary/allergy data must not reach Xero, analytics, notifications, email, rosters, lodge screens, family views, booking or finance exports, or logs.`,
    ).toEqual([]);
  });
});

describe(`member dietary access census scanner (${INVARIANT_ID}) — mutation proofs`, () => {
  const file = "src/lib/some-new-reader.ts";
  const rulesOf = (source: string, at = file) =>
    scanDietaryAccessSource(at, source).map((f) => f.rule);

  it("reports a select outside the canonical module", () => {
    expect(
      rulesOf(`await prisma.member.findMany({ select: { id: true, dietaryRequirements: true } });`),
    ).toContain("select-or-omit");
  });

  it("reports a local omit override, quoted key included", () => {
    expect(
      rulesOf(`await prisma.member.findMany({ omit: { "dietaryRequirements": false } });`),
    ).toContain("select-or-omit");
  });

  it("allows the select inside the canonical module", () => {
    const rules = rulesOf(
      `await db.member.findUnique({ where: { id }, select: { dietaryRequirements: true } });`,
      CANONICAL_MODULE,
    );
    expect(rules).not.toContain("select-or-omit");
    expect(rules).not.toContain("reach");
  });

  it("reports a raw-SQL read of the column", () => {
    expect(
      rulesOf('await prisma.$queryRaw`SELECT "dietaryRequirements" FROM "Member"`;'),
    ).toContain("raw-sql");
  });

  it("reports every whole-row raw read spelling", () => {
    for (const sql of [
      'SELECT * FROM "Member" WHERE id = $1',
      'SELECT* FROM "Member"',
      'SELECT DISTINCT * FROM "Member"',
      'SELECT m.* FROM "Member" m',
      'SELECT m.id, "Member".* FROM "Member"',
      'SELECT id, m.* FROM "Member" m',
      'TABLE "Member"',
      'SELECT row_to_json(m) FROM "Member" m',
      'SELECT to_jsonb(m) FROM "Member" m',
      'SELECT json_agg(m) FROM "Member" m',
      'SELECT jsonb_agg(m) FROM "Member" m',
    ]) {
      expect(rulesOf(`await prisma.$queryRawUnsafe(\`${sql}\`);`), sql).toContain(
        "raw-wildcard",
      );
    }
    for (const sql of [
      'SELECT count(*) FROM "Member"',
      'ALTER TABLE "Member" ADD COLUMN "x" TEXT',
      "SELECT jsonb_agg(row_value ->> 'guestRef') FROM t",
    ]) {
      expect(rulesOf(`await prisma.$queryRawUnsafe(\`${sql}\`);`), sql).not.toContain(
        "raw-wildcard",
      );
    }
  });

  it("reports a PrismaClient constructed without the omission, however it is spelled", () => {
    for (const source of [
      `const client = new PrismaClient({ adapter: a() });`,
      `import * as P from "@prisma/client";\nconst client = new P.PrismaClient({ adapter: a() });`,
      `import { PrismaClient as Db } from "@prisma/client";\nconst client = new Db({ adapter: a() });`,
    ]) {
      expect(rulesOf(source), source).toContain("constructor");
    }
    expect(
      rulesOf(`const client = new PrismaClient({ adapter: a(), omit: PRISMA_CLIENT_GLOBAL_OMIT });`),
    ).not.toContain("constructor");
  });

  it("reports an unlisted file that names the field, and ignores a comment", () => {
    expect(rulesOf(`const x = row.dietaryRequirements;`)).toContain("reach");
    expect(rulesOf(`// dietaryRequirements is discussed here only\nconst y = 1;`)).toEqual([]);
  });

  it("reports an unlisted file that imports the module without naming the field", () => {
    const source = [
      `import { grantMemberMergeDietaryAccess, readMemberDietaryRequirementsByIds } from "@/lib/member-dietary";`,
      `const grant = await grantMemberMergeDietaryAccess(db, scope);`,
      `const values = await readMemberDietaryRequirementsByIds(grant!, ids);`,
    ].join("\n");
    expect(rulesOf(source)).toContain("import");
    expect(rulesOf(`const m = await import("../lib/member-dietary");`)).toContain("import");
    expect(
      rulesOf(`import { x } from "@/lib/member-dietary-field";`),
    ).not.toContain("import");
  });

  it("reports a re-export of a grant or reader", () => {
    expect(
      rulesOf(`export { readMemberDietaryRequirementsByIds } from "@/lib/member-dietary";`),
    ).toContain("reexport");
    expect(rulesOf(`export * from "@/lib/member-dietary";`)).toContain("reexport");
  });

  it("does not mistake the settings toggle for the field", () => {
    expect(rulesOf(`const on = flags.showDietaryRequirements;`)).toEqual([]);
  });
});
