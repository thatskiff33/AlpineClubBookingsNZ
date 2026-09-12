import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "../../../prisma/migration-verification/split-statements";
import { MIGRATION_GATE_TREE_TIMEOUT_MS } from "./helpers/migration-gate-timeouts";
import {
  bashFixtureEnv,
  bashFixturePath,
  bashGateArgs,
  bashToolArgs,
} from "./helpers/bash-fixture-path";

/**
 * #2418 — the coverage gate that makes a verification fixture non-optional.
 *
 * `scripts/check-data-migration-verification.sh` is the half of #2418 that
 * cannot be forgotten: it classifies every committed migration and fails,
 * naming it, when one rewrites data a club already has and ships no fixture.
 * The gate is only worth having if its classifier is right in both directions —
 * a false negative lets an unverified repair through, and a false positive
 * makes every routine DDL migration demand a fixture until somebody switches
 * the gate off.
 *
 * So these tests drive the real script over throwaway migration trees, the same
 * way `review-findings-contracts.test.ts` drives the blue/green ledger gate. No
 * database is involved: the gate is read-only by design.
 */

const GATE = "scripts/check-data-migration-verification.sh";
const REPO_ROOT = process.cwd();
/**
 * Spawning bash costs ~10s per call on Windows (process creation, not work), so
 * the default 5s test timeout trips on a developer machine while CI finishes in
 * milliseconds. Generous on purpose: a slow gate is not the failure being
 * tested. The full measurements behind this whole family of budgets live in
 * ./helpers/migration-gate-timeouts (#2806); this one covers the FIXTURE tests
 * below, which measure 7.5 s at worst. The one that runs the gate over the
 * whole committed migration tree is an order of magnitude bigger and uses
 * MIGRATION_GATE_TREE_TIMEOUT_MS instead.
 */
const GATE_TIMEOUT_MS = 120_000;

type TempMigration = { name: string; sql: string };

function createTree(
  migrations: TempMigration[],
  options: {
    fixtures?: string[];
    registry?: string | null;
    grandfathered?: string[];
  } = {},
) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "tac-data-migration-"));
  const migrationsDir = path.join(tempDir, "migrations");
  const fixturesDir = path.join(tempDir, "migration-verification");
  const grandfatherFile = path.join(tempDir, "grandfathered.txt");

  for (const migration of migrations) {
    // Test fixture: joins the temp migrations dir with a test-controlled name; no user input.
    const dir = path.join(migrationsDir, migration.name);
    mkdirSync(dir, { recursive: true });
    // Test fixture: appends the hardcoded "migration.sql" filename.
    writeFileSync(path.join(dir, "migration.sql"), migration.sql);
  }

  mkdirSync(fixturesDir, { recursive: true });
  for (const fixture of options.fixtures ?? []) {
    // Test fixture: joins the temp fixtures dir with a test-controlled name; no user input.
    writeFileSync(
      path.join(fixturesDir, `${fixture}.ts`),
      `export default { migration: "${fixture}" };\n`,
    );
  }
  if (options.registry !== null) {
    // Mirror the real index.ts: import each fixture AND export the array the
    // runner executes. A registry that only imports is coverage that does not
    // exist (#2418, F2) — the earlier default modelled exactly that loophole, so
    // the "passes when registered" case blessed it. The membership cross-check in
    // the realdb suite is what proves an imported-but-unlisted fixture never runs.
    const fixtures = options.fixtures ?? [];
    const generated = [
      ...fixtures.map(
        (fixture, index) => `import f${index} from "./${fixture}";`,
      ),
      `export const DATA_MIGRATION_VERIFICATIONS = [${fixtures
        .map((_fixture, index) => `f${index}`)
        .join(", ")}];`,
    ].join("\n");
    writeFileSync(
      path.join(fixturesDir, "index.ts"),
      `${options.registry ?? generated}\n`,
    );
  }

  writeFileSync(
    grandfatherFile,
    `# temp\n${(options.grandfathered ?? []).join("\n")}\n`,
  );

  return { migrationsDir, fixturesDir, grandfatherFile };
}

function runGate(
  tree: ReturnType<typeof createTree>,
  env: Record<string, string> = {},
) {
  // #2886 — the fixture tree is addressed relative to this spawn's `cwd`, and
  // the variables are inlined into the bash command rather than handed to
  // `spawnSync`'s `env`. On Windows `bash` is WSL, which can open neither a
  // drive-letter path nor a Win32 environment variable: the gate used to see
  // MIGRATIONS_DIR unset and sweep the REAL `prisma/migrations` instead of this
  // throwaway tree — a false green in the one place a false green is
  // unacceptable. See ./helpers/bash-fixture-path.
  return spawnSync(
    "bash",
    bashGateArgs(GATE, [], {
      MIGRATIONS_DIR: bashFixturePath(tree.migrationsDir, REPO_ROOT),
      DATA_MIGRATION_VERIFICATION_DIR: bashFixturePath(
        tree.fixturesDir,
        REPO_ROOT,
      ),
      DATA_MIGRATION_GRANDFATHER_FILE: bashFixturePath(
        tree.grandfatherFile,
        REPO_ROOT,
      ),
      EXPECTED_GRANDFATHERED_COUNT: "0",
      // These trees use a far-future synthetic migration name (2099) as the
      // grandfather subject, so push the "authored after the gate" cutoff (#2418,
      // R7) beyond it by default; the dedicated R7 case below sets a real cutoff.
      GATE_INTRODUCED_PREFIX: "29990101000000",
      ...bashFixtureEnv(env, REPO_ROOT),
    }),
    {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: "utf8",
    },
  );
}

/** A migration whose only statement is the given SQL, plus a header comment. */
function migrationWith(sql: string): string {
  return `-- A comment mentioning UPDATE, DELETE FROM and TRUNCATE in prose.\n${sql}\n`;
}

const MIGRATION_NAME = "20990101000000_subject";

/** Runs the gate over a single migration with no fixture and no grandfather row. */
function classify(sql: string) {
  const tree = createTree([{ name: MIGRATION_NAME, sql: migrationWith(sql) }]);
  const result = runGate(tree);
  return {
    dataRewriting: result.status !== 0,
    stderr: result.stderr ?? "",
  };
}

describe("data-migration classifier (#2418)", () => {
  const rewrites: [string, string][] = [
    ["an UPDATE", `UPDATE "Lodge" SET "address" = NULL WHERE "address" = 'x';`],
    ["a DELETE", `DELETE FROM "SiteContent" WHERE "key" = 'FOOTER_BLURB';`],
    ["a TRUNCATE", `TRUNCATE "EmailLog";`],
    [
      "an INSERT that derives from existing rows",
      `INSERT INTO "Lodge" ("id") SELECT "id" FROM "Legacy";`,
    ],
    [
      "an upsert that resolves onto existing rows",
      `INSERT INTO "Setting" ("id", "v") VALUES ('a', 1) ON CONFLICT ("id") DO UPDATE SET "v" = 1;`,
    ],
    [
      "a data-modifying CTE",
      `WITH moved AS (DELETE FROM "Old" RETURNING *) INSERT INTO "New" SELECT * FROM moved;`,
    ],
    [
      "a column type change with a USING transform",
      `ALTER TABLE "Member" ALTER COLUMN "phone" TYPE TEXT USING trim("phone");`,
    ],
    [
      "a DO block that rewrites rows",
      `DO $$ BEGIN UPDATE "Member" SET "canLogin" = true; END $$;`,
    ],
    [
      // #2418 F1: a block-comment header must not hide the UPDATE. The awk
      // splitter used to keep "/* ... */" glued to the front of the statement,
      // so the classifier anchored on "/*" and matched nothing — exit 0, no
      // fixture demanded. The shared splitter now skips block comments.
      "an UPDATE hidden behind a block-comment header",
      `/* Repair addresses corrupted by #1234 */\nUPDATE "Lodge" SET "address" = NULL WHERE "address" = 'x';`,
    ],
    [
      "an UPDATE behind a nested, multi-line block comment",
      `/* repair /* see #1234 */ addresses */\nUPDATE "Lodge" SET "address" = NULL WHERE "address" = 'x';`,
    ],
    [
      // #2418 R5: an implicit assignment cast (no USING) still recasts every
      // stored value — rounds this numeric, truncates a timestamp elsewhere.
      "a column type change without a USING clause",
      `ALTER TABLE "Payment" ALTER COLUMN "amount" SET DATA TYPE numeric(10,0);`,
    ],
    [
      // #2418 R6: a stored procedure invoked at migration time runs its body now.
      "a bare CALL of a stored procedure",
      `CALL public.backfill_member_slugs();`,
    ],
    [
      // #2418 R6: the "helper function plus one invocation" backfill shape — the
      // rewrite escapes classification if only the CREATE is inspected.
      "a helper function this migration defines and then invokes",
      `CREATE OR REPLACE FUNCTION pg_temp.repair() RETURNS void AS $fn$ BEGIN UPDATE "Lodge" SET "address" = NULL; END $fn$ LANGUAGE plpgsql;\nSELECT pg_temp.repair();`,
    ],
  ];

  it.each(rewrites)(
    "treats %s as data-rewriting",
    (_label, sql) => {
      const { dataRewriting, stderr } = classify(sql);
      expect(dataRewriting, stderr).toBe(true);
      expect(stderr).toContain(MIGRATION_NAME);
      expect(stderr).toContain("ships no verification fixture");
    },
    GATE_TIMEOUT_MS,
  );

  const shapeOnly: [string, string][] = [
    [
      "a plain CREATE TABLE",
      `CREATE TABLE "Thing" ("id" TEXT NOT NULL, CONSTRAINT "Thing_pkey" PRIMARY KEY ("id"));`,
    ],
    [
      "an additive column with a default",
      `ALTER TABLE "Lodge" ADD COLUMN "note" TEXT DEFAULT 'x';`,
    ],
    [
      "a foreign key declaring ON UPDATE CASCADE",
      `ALTER TABLE "A" ADD CONSTRAINT "A_b_fkey" FOREIGN KEY ("bId") REFERENCES "B"("id") ON DELETE SET NULL ON UPDATE CASCADE;`,
    ],
    [
      "an INSERT of brand new rows",
      `INSERT INTO "Setting" ("id", "v") VALUES ('a', 1), ('b', 2);`,
    ],
    [
      "a trigger function whose body updates rows at runtime",
      `CREATE FUNCTION touch() RETURNS trigger AS $$ BEGIN UPDATE "A" SET "b" = 1; RETURN NEW; END $$ LANGUAGE plpgsql;`,
    ],
    [
      // #2418 R6: a write-bodied function DEFINED and ATTACHED as a trigger, but
      // never invoked at migration time, stays shape-only — the exact form of the
      // committed 20260802130000 policy-lock migration.
      "a trigger function defined and attached but never invoked",
      `CREATE FUNCTION lock_set() RETURNS trigger AS $$ BEGIN UPDATE "A" SET "b" = 1; RETURN NULL; END $$ LANGUAGE plpgsql;\nCREATE TRIGGER "A_lock" BEFORE INSERT ON "A" FOR EACH STATEMENT EXECUTE FUNCTION lock_set();`,
    ],
    ["a column default change", `ALTER TABLE "A" ALTER COLUMN "b" SET DEFAULT false;`],
  ];

  it.each(shapeOnly)(
    "does not treat %s as data-rewriting",
    (_label, sql) => {
      const { dataRewriting, stderr } = classify(sql);
      expect(dataRewriting, stderr).toBe(false);
    },
    GATE_TIMEOUT_MS,
  );

  it("refuses to classify a migration it cannot tokenise", () => {
    // An unterminated dollar-quote means the splitter cannot see where
    // statements end. Failing closed is the only safe answer: the alternative
    // is grading a file nobody parsed.
    const { dataRewriting, stderr } = classify(
      `UPDATE "A" SET "b" = $cms$never closed;`,
    );
    expect(dataRewriting).toBe(true);
    expect(stderr).toContain("cannot tokenise");
  }, GATE_TIMEOUT_MS);
});

describe("data-migration verification coverage gate (#2418)", () => {
  const REWRITE = `UPDATE "Lodge" SET "address" = NULL WHERE "address" = 'x';`;

  it("passes when the data migration ships a registered fixture", () => {
    const tree = createTree([{ name: MIGRATION_NAME, sql: REWRITE }], {
      fixtures: [MIGRATION_NAME],
    });
    const result = runGate(tree);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("coverage passed");
  }, GATE_TIMEOUT_MS);

  it("passes when the data migration is grandfathered instead", () => {
    const tree = createTree([{ name: MIGRATION_NAME, sql: REWRITE }], {
      grandfathered: [MIGRATION_NAME],
    });
    const result = runGate(tree, { EXPECTED_GRANDFATHERED_COUNT: "1" });
    expect(result.status, result.stderr).toBe(0);
  }, GATE_TIMEOUT_MS);

  it("fails when a fixture exists but is never imported, so it would never run", () => {
    const tree = createTree([{ name: MIGRATION_NAME, sql: REWRITE }], {
      fixtures: [MIGRATION_NAME],
      registry: "// nothing imported here",
    });
    const result = runGate(tree);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not registered");
  }, GATE_TIMEOUT_MS);

  it("fails when a fixture names a migration that does not exist", () => {
    const tree = createTree([{ name: MIGRATION_NAME, sql: REWRITE }], {
      fixtures: [MIGRATION_NAME, "20990202000000_never_committed"],
    });
    const result = runGate(tree);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("names no migration");
  }, GATE_TIMEOUT_MS);

  it("fails when a migration is both grandfathered and verified", () => {
    // The two states are mutually exclusive; allowing both would let the
    // allowlist decay into decoration that nobody prunes.
    const tree = createTree([{ name: MIGRATION_NAME, sql: REWRITE }], {
      fixtures: [MIGRATION_NAME],
      grandfathered: [MIGRATION_NAME],
    });
    const result = runGate(tree, { EXPECTED_GRANDFATHERED_COUNT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has a fixture AND a grandfather row");
  }, GATE_TIMEOUT_MS);

  it("fails when the allowlist grows without the pinned count moving", () => {
    const tree = createTree([{ name: MIGRATION_NAME, sql: REWRITE }], {
      grandfathered: [MIGRATION_NAME],
    });
    const result = runGate(tree, { EXPECTED_GRANDFATHERED_COUNT: "0" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("holds 1 entries, expected 0");
  }, GATE_TIMEOUT_MS);

  it("fails on a stale allowlist row whose migration is gone", () => {
    const tree = createTree([{ name: MIGRATION_NAME, sql: REWRITE }], {
      fixtures: [MIGRATION_NAME],
      grandfathered: ["20200101000000_deleted_long_ago"],
    });
    const result = runGate(tree, { EXPECTED_GRANDFATHERED_COUNT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not exist");
  }, GATE_TIMEOUT_MS);

  it("fails on an allowlist row whose migration no longer rewrites data", () => {
    const tree = createTree(
      [{ name: MIGRATION_NAME, sql: `CREATE TABLE "A" ("id" TEXT);` }],
      { grandfathered: [MIGRATION_NAME] },
    );
    const result = runGate(tree, { EXPECTED_GRANDFATHERED_COUNT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no longer classifies as data-rewriting");
  }, GATE_TIMEOUT_MS);

  it("refuses to grandfather a migration authored on or after the gate", () => {
    // The grandfather list enumerates historical debt; a NEW data-rewriting
    // migration cannot append itself to it to skip its fixture (#2418, R7). The
    // synthetic subject is a 2099 timestamp, so a realistic cutoff refuses it.
    const tree = createTree([{ name: MIGRATION_NAME, sql: REWRITE }], {
      grandfathered: [MIGRATION_NAME],
    });
    const result = runGate(tree, {
      EXPECTED_GRANDFATHERED_COUNT: "1",
      GATE_INTRODUCED_PREFIX: "20260802150000",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot be grandfathered");
  }, GATE_TIMEOUT_MS);

  it("passes over this repository's own migration history", () => {
    // The pinned count and the committed allowlist have to agree with what is
    // actually on disk, or every PR fails for a reason unrelated to its diff.
    const result = spawnSync("bash", [GATE], {
      cwd: REPO_ROOT,
      env: process.env,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    // #2806: this one runs the gate over the WHOLE committed migration tree —
    // 43.5 s on a Windows developer machine, and it blew past 120 s when other
    // shell-out suites ran alongside it.
  }, MIGRATION_GATE_TREE_TIMEOUT_MS);
});

describe("the two statement splitters agree (#2418)", () => {
  /**
   * There are two tokenisers on purpose, with different contracts: the awk one
   * runs in the shell gates before Node exists and normalises each statement
   * onto one line for READING, while the TypeScript one preserves the source
   * byte for byte so the runner can EXECUTE it (a newline inside dollar-quoted
   * HTML is part of the value). Two tokenisers is a drift risk, so this test
   * runs both over every committed migration and fails if they ever disagree
   * about where a statement starts and ends.
   */
  it("split every committed migration the same way", () => {
    const migrationsRoot = path.join(REPO_ROOT, "prisma", "migrations");
    const names = readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names.length).toBeGreaterThan(100);

    const disagreements: string[] = [];
    for (const name of names) {
      // Test helper: joins the repo's own migrations directory with a name read
      // from that same listing; no user input.
      const file = path.join(migrationsRoot, name, "migration.sql");
      const awkResult = spawnSync(
        "bash",
        bashToolArgs("awk", [
          "-v",
          "tool=agreement-test",
          "-f",
          "scripts/lib/split-sql-statements.awk",
          bashFixturePath(file, REPO_ROOT),
        ]),
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      expect(awkResult.status, `${name}: ${awkResult.stderr}`).toBe(0);
      const awkStatements = (awkResult.stdout ?? "")
        .split("\n")
        .filter((line) => line.trim().length > 0);

      const tsStatements = splitSqlStatements(readFileSync(file, "utf8"));

      if (awkStatements.length !== tsStatements.length) {
        disagreements.push(
          `${name}: awk found ${awkStatements.length} statements, TypeScript found ${tsStatements.length}`,
        );
        continue;
      }
      for (let index = 0; index < awkStatements.length; index += 1) {
        // Compare the WHOLE statement — comment-stripped and whitespace-collapsed
        // — not just its first two words. A divergence that preserves the count
        // AND the leading keyword (a block comment one splitter drops mid-
        // statement while the other keeps it, say) must still be caught; the
        // leading-keyword check that shipped first could not see it (#2418, F1).
        const awkText = canonicalize(awkStatements[index]);
        const tsText = canonicalize(tsStatements[index]);
        if (awkText !== tsText) {
          disagreements.push(
            `${name} #${index + 1}: awk read <${awkText}>, TypeScript read <${tsText}>`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
  }, GATE_TIMEOUT_MS);
});

/**
 * A statement reduced to what PostgreSQL actually executes: comments removed and
 * every run of whitespace collapsed to one space. The awk splitter already
 * strips comments and folds each statement onto one line, so canonicalising both
 * sides makes their outputs directly comparable — and compares the executable
 * text of every statement rather than only its leading keyword (#2418, F1).
 *
 * The one deliberate contract difference between the splitters is the terminator:
 * awk flushes a statement WITHOUT its closing `;`, while the TypeScript splitter
 * keeps the source verbatim (`;` included). That is not a tokenisation divergence,
 * so a single trailing `;` is normalised away here; a genuine boundary
 * disagreement still surfaces as a different statement COUNT.
 */
function canonicalize(statement: string): string {
  return stripSqlComments(statement)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "");
}

/**
 * Remove SQL `--` line comments and C-style block comments (nested), leaving
 * every single-quoted, double-quoted and dollar-quoted body untouched — a
 * comment token inside a string is data, not a comment. Mirrors the quote/comment
 * handling both splitters implement, so it strips exactly what they strip.
 */
function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    // Single-quoted string, honouring '' doubling and E'...' backslash escapes.
    if (ch === "'") {
      const escapeAware =
        (sql[i - 1] === "E" || sql[i - 1] === "e") &&
        !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "");
      out += ch;
      i += 1;
      while (i < sql.length) {
        if (escapeAware && sql[i] === "\\") {
          out += sql.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "''";
          i += 2;
          continue;
        }
        out += sql[i];
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    // Double-quoted identifier.
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    // Dollar-quoted body: $tag$ ... $tag$ (tag empty or [A-Za-z_][A-Za-z0-9_]*).
    const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
    if (tag) {
      const close = sql.indexOf(tag, i + tag.length);
      const end = close === -1 ? sql.length : close + tag.length;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    // `--` line comment: drop through the end of the line, keeping the newline.
    if (ch === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i);
      i = newline === -1 ? sql.length : newline;
      continue;
    }
    // `/* */` block comment, nested and multi-line.
    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
          continue;
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
          continue;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

describe("the shell gates share one awk program (#2418)", () => {
  it("neither embeds its own copy of the tokeniser", () => {
    // Two copies of a 60-line tokeniser is two classifications of the same file
    // one edit apart. The deploy gate and the data-rewrite classifier must agree
    // about what PostgreSQL will run, so they load one file. (The TypeScript
    // splitter above is a deliberate second implementation with a different
    // contract — byte-exact, for execution — and the agreement test pins it.)
    const splitter = "scripts/lib/split-sql-statements.awk";
    for (const script of [GATE, "scripts/validate-blue-green-migrations.sh"]) {
      // Test helper: reads a hardcoded repository path.
      const source = readFileSync(path.join(REPO_ROOT, script), "utf8");
      expect(source, `${script} must load ${splitter}`).toContain(
        "split-sql-statements.awk",
      );
      expect(
        source,
        `${script} appears to embed its own dollar-quote tokeniser`,
      ).not.toContain("function dollar_open(");
    }
  });
});
