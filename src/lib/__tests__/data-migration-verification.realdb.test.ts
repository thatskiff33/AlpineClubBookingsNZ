import { deepStrictEqual } from "node:assert";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// `INV-SSOT` (#3030): `jobBlock` moved to a shared helper when a third guard
// wanted it, so a weaker copy cannot drift in beside this one.
import { jobBlock } from "./helpers/ci-workflow";
import { DATA_MIGRATION_VERIFICATIONS } from "../../../prisma/migration-verification";
import { splitSqlStatements } from "../../../prisma/migration-verification/split-statements";
import type {
  DataMigrationCase,
  DataMigrationVerification,
} from "../../../prisma/migration-verification/types";

/**
 * #2418 — data-rewriting migrations, executed against a real PostgreSQL.
 *
 * WHAT THIS PROVES THAT NOTHING ELSE DOES
 *
 * `Migration drift check` applies every migration to a real PostgreSQL, but the
 * tables are EMPTY, so a backfill/repair/transform matches no rows: the
 * statement is proven to parse and proven to do nothing. The parity tests that
 * lift a migration's patterns into JavaScript prove the patterns are what the
 * author intended; JavaScript and PostgreSQL regular expressions differ on
 * greediness, on newlines inside character classes, and on backslashes inside
 * brackets, so they cannot prove PostgreSQL executes them the same way.
 *
 * This suite replays the real migration chain up to the migration under test,
 * seeds the pre-state a real club could hold, runs the real `migration.sql`, and
 * reads the rows back.
 *
 * MUTATION, NOT ASSERTION. A post-state check that would pass whether or not the
 * migration ran is coverage that does not exist. So every fixture is also run
 * against deliberately broken copies of its own migration — an inverted WHERE, a
 * dropped predicate, a row-scoped rewrite where the real one is value-scoped —
 * and against the migration not being applied at all. Each of those runs MUST
 * make at least one case fail. That is checked on every CI run, so a fixture
 * cannot rot into a green no-op.
 *
 * NEVER SKIPS SILENTLY. The pre-#2418 convention was `describe.skip` without a
 * database URL, which reads as coverage that does not exist — the very thing
 * this issue was filed about. Here the structural block below runs
 * unconditionally: it fails when CI has no database URL wired, and it fails when
 * the workflow stops running this file or stops running the coverage gate. A
 * developer without a local PostgreSQL still gets those.
 *
 * RUN IT LOCALLY (any throwaway database; the suite creates and drops its own):
 *
 *   DATA_MIGRATION_VERIFICATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx vitest run src/lib/__tests__/data-migration-verification.realdb.test.ts
 */

const REPO_ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(REPO_ROOT, "prisma", "migrations");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const THIS_SUITE =
  "src/lib/__tests__/data-migration-verification.realdb.test.ts";
const DATABASE_URL_ENV = "DATA_MIGRATION_VERIFICATION_DATABASE_URL";
const COVERAGE_GATE = "scripts/check-data-migration-verification.sh";
/** The ci.yml job id that stands up the database and runs this suite. */
const CI_JOB_ID = "data-migration-verification";

const databaseUrl = process.env[DATABASE_URL_ENV];

/** Every committed migration directory, in the order PostgreSQL will see them. */
function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function migrationSql(name: string): string {
  // Test helper: joins the repo's own migrations directory with a name read
  // from that same directory listing; no user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

/**
 * A verification case already owns a rollback transaction. Remove only a
 * migration's complete outer transaction envelope before running it there;
 * replaying the committed migration chain still executes the real envelope.
 */
function sqlInsideVerificationTransaction(sql: string): string {
  const match = sql.match(/^\s*BEGIN\s*;([\s\S]*)COMMIT\s*;\s*$/i);
  if (!match) return sql;
  return match[1];
}

// ---------------------------------------------------------------------------
// Structural checks. These run with or without a database, so the arrangement
// that makes the real checks happen cannot quietly come undone.
// ---------------------------------------------------------------------------

describe("data-migration verification wiring (#2418)", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");

  it("refuses to skip inside its own CI job: the database URL must be wired", () => {
    // The whole point of #2418. A suite that skips itself when no database is
    // present reads as coverage that does not exist. Locally that is a
    // convenience; inside the job built to run it, it is a lie — so it fails.
    // Scoped by GITHUB_JOB rather than by CI, because the `verify` job runs the
    // whole suite deliberately without a database and must stay green.
    if (process.env.GITHUB_JOB !== CI_JOB_ID) return;
    expect(
      databaseUrl,
      `${DATABASE_URL_ENV} is not set inside the ${CI_JOB_ID} job. That job exists to run this suite against a real PostgreSQL — see .github/workflows/ci.yml.`,
    ).toBeTruthy();
  });

  it("is executed by CI against a PostgreSQL service, blocking and unconditional", () => {
    // The job block, not the whole file: a step that lost its env var, or a
    // database URL left behind in an unrelated job, must not read as wiring.
    const job = jobBlock(workflow, CI_JOB_ID);
    expect(job, `ci.yml has no ${CI_JOB_ID} job`).not.toBe("");
    expect(job).toContain("services:");
    expect(job).toContain("image: postgres:16-alpine");
    expect(job).toContain(THIS_SUITE);
    expect(job).toContain(DATABASE_URL_ENV);
    // A green structural test must also mean the job still BLOCKS. `continue-on-
    // error: true` turns it advisory — it is the house idiom two jobs below, on
    // the HIGH-severity trivy step — and a job-level `if:` can make it skip on
    // pull requests. Either neuters the whole #2418 apparatus with every
    // assertion above still green, so forbid both (#2418, C2).
    expect(job, "the executing job must not be continue-on-error").not.toContain(
      "continue-on-error",
    );
    expect(job, "the executing job must not carry a job-level if:").not.toMatch(
      /\n {4}if:/,
    );
  });

  it("runs the coverage gate INSIDE the required migration-drift job", () => {
    // The no-fixture-no-merge rule only bites if the gate runs on a REQUIRED
    // check. Assert the gate step lives inside the migration-drift job block —
    // not merely that it appears somewhere in the file and a job named
    // migration-drift exists. A file-wide count could stay at two while both
    // copies moved into the non-required executing job, unblocking a missing
    // fixture (#2418, C4).
    const driftJob = jobBlock(workflow, "migration-drift");
    expect(driftJob, "ci.yml has no migration-drift job").not.toBe("");
    expect(driftJob).toContain(COVERAGE_GATE);
    // And a second time in the executing job (fail fast before the DB comes up).
    expect(jobBlock(workflow, CI_JOB_ID)).toContain(COVERAGE_GATE);
  });

  it("blocks the release: publish-ghcr-images depends on it", () => {
    // A fixture that proves a migration corrupts data must stop the image an
    // operator would deploy. publish-ghcr-images runs on every push to main, so
    // it must list the executing job in needs:, the way it lists the sibling
    // migration-drift schema gate (#2418, C1).
    const publishJob = jobBlock(workflow, "publish-ghcr-images");
    expect(publishJob, "ci.yml has no publish-ghcr-images job").not.toBe("");
    expect(
      publishJob,
      `publish-ghcr-images must list ${CI_JOB_ID} in needs:`,
    ).toMatch(new RegExp(`\\n {6}- ${CI_JOB_ID}\\b`));
  });

  it("registers at least one fixture", () => {
    expect(DATA_MIGRATION_VERIFICATIONS.length).toBeGreaterThan(0);
  });

  it("runs every fixture file in the directory — imported is not registered", () => {
    // The shell gate proves a fixture is IMPORTED by index.ts, but the runner
    // executes DATA_MIGRATION_VERIFICATIONS, not the imports. A fixture imported
    // yet left out of the array runs zero cases — coverage that does not exist,
    // the exact failure #2418 was filed about — so cross-check true MEMBERSHIP
    // here against the real array, using the same 14-digit filter the gate uses
    // to tell a fixture apart from the registry/types/splitter support files
    // (#2418, F2).
    const fixtureDir = path.join(REPO_ROOT, "prisma", "migration-verification");
    const registered = new Set(
      DATA_MIGRATION_VERIFICATIONS.map((fixture) => fixture.migration),
    );
    const onDisk = readdirSync(fixtureDir)
      .filter((name) => /^[0-9]{14}_.*\.ts$/.test(name))
      .map((name) => name.replace(/\.ts$/, ""));
    expect(onDisk.length).toBeGreaterThan(0);
    const unregistered = onDisk.filter((name) => !registered.has(name));
    expect(
      unregistered,
      `fixture file(s) present but absent from DATA_MIGRATION_VERIFICATIONS, so they never run: ${unregistered.join(", ")}`,
    ).toEqual([]);
  });

  it.each(DATA_MIGRATION_VERIFICATIONS.map((f) => [f.migration, f] as const))(
    "%s is a well-formed fixture",
    (_name, fixture: DataMigrationVerification) => {
      expect(
        existsSync(path.join(MIGRATIONS_DIR, fixture.migration)),
        `${fixture.migration} names no committed migration`,
      ).toBe(true);
      expect(fixture.intent.length).toBeGreaterThan(20);
      expect(fixture.cases.length).toBeGreaterThan(0);

      for (const testCase of fixture.cases) {
        expect(
          testCase.expectations.length,
          `${fixture.migration} / ${testCase.name}: a case with no expectations asserts nothing`,
        ).toBeGreaterThan(0);
        for (const expectation of testCase.expectations) {
          // A naive timestamp is resolved against the CLIENT's zone by the pg
          // driver, so a raw Date comparison passes in UTC CI and fails on a
          // Pacific/Auckland machine. Read the stored characters instead.
          const readsRawTimestamp =
            /"(createdAt|updatedAt)"/.test(expectation.sql) &&
            !expectation.sql.includes("to_char(");
          expect(
            readsRawTimestamp,
            `${fixture.migration} / ${expectation.claim}: select timestamps through to_char(...), never raw — a raw one is zone-dependent`,
          ).toBe(false);
        }
      }

      // The mutants are what give the assertions teeth; a fixture with none is
      // an unproven fixture.
      expect(
        fixture.mutants.length,
        `${fixture.migration}: declare at least one mutant`,
      ).toBeGreaterThan(0);

      const sql = migrationSql(fixture.migration);
      for (const mutant of fixture.mutants) {
        const occurrences = sql.split(mutant.find).length - 1;
        expect(
          occurrences,
          `${fixture.migration}: mutant "${mutant.name}" must match its migration exactly once (found ${occurrences})`,
        ).toBe(1);
        expect(
          mutant.replace,
          `${fixture.migration}: mutant "${mutant.name}" replaces its match with itself`,
        ).not.toBe(mutant.find);
        expect(mutant.harm.length).toBeGreaterThan(20);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// The real thing.
// ---------------------------------------------------------------------------

/** One case, executed once: either it blew up, or here are the rows it read. */
type CaseOutcome = {
  error: string | null;
  readings: { claim: string; expected: unknown[]; actual: unknown[] }[];
};

/** One whole run of a fixture's cases against one version of its migration. */
type RunOutcome = {
  outcomes: Map<string, CaseOutcome>;
  /** True when at least one case failed — raised OR read a mismatching row. */
  detected: boolean;
  /**
   * True when at least one case read a MISMATCHING row. Strictly stronger than
   * `detected`: a mutant that merely makes the SQL invalid is caught by `detected`
   * for free (the case raises), but that proves nothing about the value the
   * migration writes — only a mismatch does (#2418, F3).
   */
  detectedByMismatch: boolean;
};

const runs = new Map<string, RunOutcome>();

const realRunKey = (migration: string) => `${migration}::real`;
const rerunKey = (migration: string) => `${migration}::rerun`;
const noMigrationKey = (migration: string) => `${migration}::not-applied`;
const mutantKey = (migration: string, mutant: string) =>
  `${migration}::mutant::${mutant}`;

/** True when a case read a row that did not match its expectation. */
function outcomeMismatched(outcome: CaseOutcome): boolean {
  return outcome.readings.some((reading) => {
    try {
      deepStrictEqual(reading.actual, reading.expected);
      return false;
    } catch {
      return true;
    }
  });
}

/**
 * True when a version was DETECTED: a case raised, or a case read a mismatching
 * row. Detection-by-error is real — an invalid mutant IS caught — but it says
 * nothing about what the transform writes, so callers that need that stronger
 * proof read `detectedByMismatch` (#2418, F3).
 */
function outcomeDetected(outcome: CaseOutcome): boolean {
  return outcome.error !== null || outcomeMismatched(outcome);
}

const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("data migrations against a real PostgreSQL (#2418)", () => {
  let adminClient: Client | undefined;
  let client: Client | undefined;
  let scratchDatabase = "";
  /** Index of the next migration in the chain that has not been applied yet. */
  let nextMigration = 0;
  const chain = migrationNames();

  /** The scratch-database connection, once `beforeAll` has opened it. */
  function db(): Client {
    if (!client) throw new Error("scratch database connection not open");
    return client;
  }

  /**
   * Statement by statement, the way Prisma applies a migration — not the whole
   * file in one query. `pg` sends a multi-statement string as a single implicit
   * transaction block, and PostgreSQL refuses to use an enum value added in the
   * same block, so 20260528120000 (which adds BookingStatus.AWAITING_REVIEW and
   * then writes it) would fail on history that is live today.
   */
  async function runScript(sql: string, label: string) {
    for (const statement of splitSqlStatements(sql)) {
      try {
        // Test fixture: this repository's own committed migration SQL, against a
        // disposable database; no user input.
        // nosemgrep: javascript.express.db.pg-express.pg-express
        await db().query(statement);
      } catch (error) {
        throw new Error(
          `${label} failed on: ${statement.trim().slice(0, 160)} -- ${(error as Error).message}`,
        );
      }
    }
  }

  async function applyThrough(exclusiveEnd: number) {
    for (; nextMigration < exclusiveEnd; nextMigration += 1) {
      const name = chain[nextMigration];
      await runScript(migrationSql(name), `replaying ${name}`);
    }
  }

  /**
   * Run every case of a fixture against one version of its migration, each case
   * inside its own transaction so nothing survives into the next case or the
   * ongoing replay. `versions` is the list of SQL bodies to apply after the
   * seed: the real migration, a mutated copy, the same migration twice (the
   * idempotence claim), or nothing at all.
   */
  async function runCases(
    fixture: DataMigrationVerification,
    versions: string[],
  ): Promise<RunOutcome> {
    const outcomes = new Map<string, CaseOutcome>();
    for (const testCase of fixture.cases) {
      outcomes.set(testCase.name, await runCase(testCase, versions));
    }
    const outcome: RunOutcome = {
      outcomes,
      detected: [...outcomes.values()].some(outcomeDetected),
      detectedByMismatch: [...outcomes.values()].some(outcomeMismatched),
    };
    return outcome;
  }

  async function runCase(
    testCase: DataMigrationCase,
    versions: string[],
  ): Promise<CaseOutcome> {
    const readings: CaseOutcome["readings"] = [];
    await db().query("BEGIN");
    try {
      if (testCase.seed.trim()) {
        await runScript(testCase.seed, `seeding "${testCase.name}"`);
      }
      for (const version of versions) {
        // The migration under test, or a deliberately mutated copy of it,
        // inside a transaction this case will roll back. A migration may carry
        // its own production BEGIN/COMMIT envelope; do not let that commit the
        // fixture's enclosing transaction.
        await runScript(
          sqlInsideVerificationTransaction(version),
          `applying the migration for "${testCase.name}"`,
        );
      }
      if (testCase.afterMigration?.trim()) {
        await runScript(
          testCase.afterMigration,
          `exercising the migrated shape for "${testCase.name}"`,
        );
      }
      for (const expectation of testCase.expectations) {
        // Test fixture: the fixture's own read-only assertion query.
        // nosemgrep: javascript.express.db.pg-express.pg-express
        const result = await db().query(expectation.sql);
        readings.push({
          claim: expectation.claim,
          expected: expectation.rows,
          actual: result.rows,
        });
      }
      return { error: null, readings };
    } catch (error) {
      return { error: (error as Error).message, readings };
    } finally {
      await db().query("ROLLBACK");
    }
  }

  beforeAll(async () => {
    // A dedicated DATABASE, not a schema: some migrations query
    // information_schema by table name alone, so a search_path trick would
    // grade them against a different catalogue than production does.
    adminClient = new Client({ connectionString: databaseUrl });
    await adminClient.connect();
    scratchDatabase = `dmv_${randomUUID().replaceAll("-", "")}`;
    // Test fixture: a generated UUID-derived database name; no user input.
    // nosemgrep: javascript.express.db.pg-express.pg-express
    await adminClient.query(`CREATE DATABASE "${scratchDatabase}"`);


    const scratchUrl = new URL(databaseUrl as string);
    scratchUrl.pathname = `/${scratchDatabase}`;
    client = new Client({ connectionString: scratchUrl.toString() });
    await client.connect();

    const ordered = [...DATA_MIGRATION_VERIFICATIONS].sort((a, b) =>
      a.migration < b.migration ? -1 : a.migration > b.migration ? 1 : 0,
    );

    for (const fixture of ordered) {
      const index = chain.indexOf(fixture.migration);
      if (index < 0) {
        throw new Error(`${fixture.migration} names no committed migration`);
      }
      if (index < nextMigration) {
        throw new Error(
          `${fixture.migration} was already applied — fixtures must be replayed in migration order`,
        );
      }
      await applyThrough(index);

      const sql = migrationSql(fixture.migration);

      runs.set(realRunKey(fixture.migration), await runCases(fixture, [sql]));
      if (fixture.idempotentReRun) {
        runs.set(
          rerunKey(fixture.migration),
          await runCases(fixture, [sql, sql]),
        );
      }
      // The mutant nobody has to declare: the migration simply never ran.
      runs.set(noMigrationKey(fixture.migration), await runCases(fixture, []));
      for (const mutant of fixture.mutants) {
        // A replacer FUNCTION, not a string: `String.prototype.replace` expands
        // `$$`, `$&`, `$\`` and `$'` in a string replacement, and this repo's SQL
        // is full of `$$`/`$cms$` dollar-quoting — so a string replacement could
        // silently produce different SQL than the fixture declares. A function
        // inserts `mutant.replace` verbatim (#2418, R8).
        const mutated = sql.replace(mutant.find, () => mutant.replace);
        runs.set(
          mutantKey(fixture.migration, mutant.name),
          await runCases(fixture, [mutated]),
        );
      }

      // Advance past this migration so the next fixture replays from here.
      await applyThrough(index + 1);
    }
  }, 900_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
    if (adminClient && scratchDatabase) {
      // Test fixture: drops the disposable database created above.
      // nosemgrep: javascript.express.db.pg-express.pg-express
      await adminClient
        .query(`DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`)
        .catch(() => {});
    }
    await adminClient?.end().catch(() => {});
  }, 120_000);

  for (const fixture of DATA_MIGRATION_VERIFICATIONS) {
    describe(fixture.migration, () => {
      for (const testCase of fixture.cases) {
        it(`post-state: ${testCase.name}`, () => {
          const outcome = runs
            .get(realRunKey(fixture.migration))
            ?.outcomes.get(testCase.name);
          expect(outcome, "the setup did not run this case").toBeDefined();
          expect(outcome?.error, `${testCase.name} raised`).toBeNull();
          for (const reading of outcome?.readings ?? []) {
            expect(reading.actual, reading.claim).toEqual(reading.expected);
          }
        });
      }

      if (fixture.idempotentReRun) {
        it("is idempotent: running the migration twice changes nothing", () => {
          const run = runs.get(rerunKey(fixture.migration));
          expect(run, "the setup did not run the re-run check").toBeDefined();
          for (const [name, outcome] of run?.outcomes ?? []) {
            expect(outcome.error, `${name} raised on the second run`).toBeNull();
            for (const reading of outcome.readings) {
              expect(reading.actual, `${name} — ${reading.claim}`).toEqual(
                reading.expected,
              );
            }
          }
        });
      }

      // ------------------------------------------------------------------
      // Mutation. Without these, every assertion above could be vacuous.
      // ------------------------------------------------------------------

      it("passes cleanly against the unmutated migration", () => {
        // Ties the comparator the mutation checks use to the real behaviour: if
        // this were "detected", every mutant below would pass for free.
        const run = runs.get(realRunKey(fixture.migration));
        expect(run?.detected, `${fixture.migration}: real run failed`).toBe(
          false,
        );
      });

      it("catches the migration not being applied at all", () => {
        const run = runs.get(noMigrationKey(fixture.migration));
        expect(
          run?.detected,
          `${fixture.migration}: every case passed WITHOUT the migration running, so the fixture proves nothing about it`,
        ).toBe(true);
      });

      for (const mutant of fixture.mutants) {
        it(`catches a broken migration: ${mutant.name}`, () => {
          const run = runs.get(mutantKey(fixture.migration, mutant.name));
          expect(
            run?.detected,
            `${fixture.migration}: mutant "${mutant.name}" went UNDETECTED. ${mutant.harm} Sharpen a case until this fails.`,
          ).toBe(true);
        });
      }

      it("proves a mutant by a row MISMATCH, not just a raised error", () => {
        // An execution error counts as detection (an invalid mutant is caught for
        // free), so the per-mutant checks above can be satisfied without any
        // expectation pinning the rewritten value — a fixture could pass with
        // assertions that never look at what the transform writes. Require at
        // least one declared mutant to be caught by a real post-state MISMATCH, so
        // the expectations demonstrably pin the value (#2418, F3).
        const provenByMismatch = fixture.mutants.some(
          (mutant) =>
            runs.get(mutantKey(fixture.migration, mutant.name))
              ?.detectedByMismatch,
        );
        expect(
          provenByMismatch,
          `${fixture.migration}: every mutant was caught only by raising, so no expectation pins the value the migration writes. Add a semantically-valid mutant whose changed row a case compares.`,
        ).toBe(true);
      });
    });
  }
});
