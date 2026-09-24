/**
 * The member dietary/allergy access census (#2941, `INV-PRIV-022`).
 *
 * WHAT THIS GATE IS FOR. `Member.dietaryRequirements` is special-category
 * personal data, children's included. It is protected by RUNTIME absence, not
 * by a filter: every application Prisma client is constructed with
 * `omit: PRISMA_CLIENT_GLOBAL_OMIT`, so a Member read that does not ask for the
 * column never carries it, and `src/lib/member-dietary.ts` is the one module
 * that asks — for a caller holding a grant.
 *
 * `src/lib/prisma.ts` TYPES the client as the plain `PrismaClient` (an omit-typed
 * client is not assignable to `Prisma.TransactionClient`, and re-typing ~160
 * helpers was measured and rejected there). So the compiler still believes the
 * field is on every row, and this census is what holds the boundary. Five rules:
 *
 *  1. SELECT/OMIT — `dietaryRequirements: true|false` (a select, an include, a
 *     local `omit` override) appears only in the canonical module and the omit
 *     constant.
 *  2. RAW SQL — no file that issues raw SQL names the column, and no file reads
 *     a whole row through `SELECT *`, `"Member".*` or a JSON row function
 *     (the one exemption is the diagnostics wrapper, fenced by column grants).
 *  3. CONSTRUCTOR — every `new PrismaClient(` in application code passes
 *     `omit: PRISMA_CLIENT_GLOBAL_OMIT`.
 *  4. REACH — the identifier appears, outside comments, only in a closed,
 *     counted list of files, each with its reason. A new file that handles the
 *     value is an edit here, in the same diff, where a reviewer sees it.
 *  5. EGRESS — none of those files is a Xero, analytics, notification, email,
 *     roster, lodge-screen, kiosk, family, booking or finance-export surface.
 *
 * Scanned from disk, so `vitest related` cannot reach it: run it by name,
 * `npm run test:named -- member-dietary-access-census`.
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
 * Rule 4's closed list: every application file allowed to name
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
  "src/lib/member-merge.ts":
    "Full Admin merge: attaches both values, redacts the audit row",
  "src/lib/member-merge-field-rules.ts": "fill-if-blank merge rule",
  "src/lib/member-merge-field-kinds.ts": "merge screen value kind",
};

/**
 * Rule 5: path fragments of surfaces the value must never reach. A reach entry
 * matching one of these fails even when it is listed, so widening the list
 * onto an egress surface is refused rather than rubber-stamped.
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

const RAW_SQL_API = /\$queryRaw|\$queryRawUnsafe|\$executeRaw|\$executeRawUnsafe|Prisma\.sql|Prisma\.raw/;
const SELECT_OR_OMIT = /["']?\bdietaryRequirements\b["']?\s*:\s*(?:true|false)\b/;
const IDENTIFIER = /\bdietaryRequirements\b/;
const RAW_WILDCARD = /\bSELECT\s+\*|"Member"\s*\.\s*\*|\b(?:row_to_json|to_jsonb?)\s*\(/i;

type Finding = { rule: string; file: string; detail: string };

/** Pure scanner, so the mutation block below can seed it without the tree. */
export function scanDietaryAccessSource(file: string, source: string): Finding[] {
  const code = stripComments(source);
  const findings: Finding[] = [];

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
      detail: "reads a whole row through SELECT *, \"Member\".* or a JSON row function",
    });
  }

  let index = code.indexOf("new PrismaClient(");
  while (index !== -1) {
    const args = constructorArguments(code, index + "new PrismaClient(".length);
    if (!/\bomit\s*:\s*PRISMA_CLIENT_GLOBAL_OMIT\b/.test(args)) {
      findings.push({
        rule: "constructor",
        file,
        detail: "constructs a PrismaClient without omit: PRISMA_CLIENT_GLOBAL_OMIT",
      });
    }
    index = code.indexOf("new PrismaClient(", index + 1);
  }

  if (IDENTIFIER.test(code) && !(file in DIETARY_REACH)) {
    findings.push({
      rule: "reach",
      file,
      detail: "names dietaryRequirements but is not in DIETARY_REACH",
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

function applicationSourceFiles(dir: string = SRC_ROOT): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      files.push(...applicationSourceFiles(full));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.(ts|tsx)$/.test(entry.name) &&
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

let cached: { files: string[]; findings: Finding[]; reached: string[] } | null =
  null;
function census() {
  if (cached) return cached;
  const files = applicationSourceFiles().map(relative);
  const findings: Finding[] = [];
  const reached: string[] = [];
  for (const file of files) {
    const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
    findings.push(...scanDietaryAccessSource(file, source));
    if (IDENTIFIER.test(stripComments(source))) reached.push(file);
  }
  cached = { files, findings, reached: reached.sort() };
  return cached;
}

function report(findings: Finding[]): string {
  return findings.map((f) => `  ${f.rule}: ${f.file} — ${f.detail}`).join("\n");
}

describe(`member dietary access census (${INVARIANT_ID})`, () => {
  it("walks the application tree", () => {
    // A walk that found nothing would pass every rule below vacuously.
    expect(census().files.length).toBeGreaterThan(500);
    expect(census().files).toContain(CANONICAL_MODULE);
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
    // prisma.ts and the audit archive client. If this drops, the constructor
    // rule above could be passing because the scan no longer sees either one.
    const constructing = census().files.filter((file) =>
      stripComments(readFileSync(path.join(REPO_ROOT, file), "utf8")).includes(
        "new PrismaClient(",
      ),
    );
    expect(constructing.sort()).toEqual([
      "src/lib/audit-retention.ts",
      "src/lib/prisma.ts",
    ]);
  });

  it("the reach list is exact: every listed file still names the field", () => {
    const stale = Object.keys(DIETARY_REACH).filter(
      (file) => !census().reached.includes(file),
    );
    expect(
      stale,
      `${INVARIANT_ID}: these DIETARY_REACH entries no longer name dietaryRequirements; remove them so the list stays the population.`,
    ).toEqual([]);
    expect(census().reached).toEqual(Object.keys(DIETARY_REACH).sort());
  });

  it("no reach entry is an egress surface", () => {
    const egress = Object.keys(DIETARY_REACH).filter((file) =>
      EGRESS_SURFACE_PATTERNS.some((pattern) => pattern.test(file)),
    );
    expect(
      egress,
      `${INVARIANT_ID}: dietary/allergy data must not reach Xero, analytics, notifications, email, rosters, lodge screens, family views, booking or finance exports, or logs.`,
    ).toEqual([]);
  });
});

describe(`member dietary access census scanner (${INVARIANT_ID}) — mutation proofs`, () => {
  const file = "src/lib/some-new-reader.ts";

  it("reports a select outside the canonical module", () => {
    const rules = scanDietaryAccessSource(
      file,
      `await prisma.member.findMany({ select: { id: true, dietaryRequirements: true } });`,
    ).map((f) => f.rule);
    expect(rules).toContain("select-or-omit");
  });

  it("reports a local omit override, quoted key included", () => {
    const rules = scanDietaryAccessSource(
      file,
      `await prisma.member.findMany({ omit: { "dietaryRequirements": false } });`,
    ).map((f) => f.rule);
    expect(rules).toContain("select-or-omit");
  });

  it("allows the select inside the canonical module", () => {
    const rules = scanDietaryAccessSource(
      CANONICAL_MODULE,
      `await db.member.findUnique({ where: { id }, select: { dietaryRequirements: true } });`,
    ).map((f) => f.rule);
    expect(rules).not.toContain("select-or-omit");
    expect(rules).not.toContain("reach");
  });

  it("reports a raw-SQL read of the column", () => {
    const rules = scanDietaryAccessSource(
      file,
      'await prisma.$queryRaw`SELECT "dietaryRequirements" FROM "Member"`;',
    ).map((f) => f.rule);
    expect(rules).toContain("raw-sql");
  });

  it("reports a whole-row raw read", () => {
    for (const sql of [
      'SELECT * FROM "Member" WHERE id = $1',
      'SELECT m.id, "Member".* FROM "Member"',
      'SELECT row_to_json(m) FROM "Member" m',
    ]) {
      const rules = scanDietaryAccessSource(
        file,
        `await prisma.$queryRawUnsafe(\`${sql}\`);`,
      ).map((f) => f.rule);
      expect(rules, sql).toContain("raw-wildcard");
    }
  });

  it("reports a PrismaClient constructed without the omission", () => {
    const rules = scanDietaryAccessSource(
      file,
      `const client = new PrismaClient({ adapter: createPrismaPgAdapter(url) });`,
    ).map((f) => f.rule);
    expect(rules).toContain("constructor");
    expect(
      scanDietaryAccessSource(
        file,
        `const client = new PrismaClient({ adapter: a(), omit: PRISMA_CLIENT_GLOBAL_OMIT });`,
      ).map((f) => f.rule),
    ).not.toContain("constructor");
  });

  it("reports an unlisted file that names the field, and ignores a comment", () => {
    expect(
      scanDietaryAccessSource(file, `const x = row.dietaryRequirements;`).map(
        (f) => f.rule,
      ),
    ).toContain("reach");
    expect(
      scanDietaryAccessSource(
        file,
        `// dietaryRequirements is discussed here only\nconst y = 1;`,
      ),
    ).toEqual([]);
  });

  it("does not mistake the settings toggle for the field", () => {
    expect(
      scanDietaryAccessSource(file, `const on = flags.showDietaryRequirements;`),
    ).toEqual([]);
  });
});
