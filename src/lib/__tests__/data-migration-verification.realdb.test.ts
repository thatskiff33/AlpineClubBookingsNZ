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
import {
  splitSqlStatements,
  stripSqlComments,
} from "../../../prisma/migration-verification/split-statements";
import type {
  DataMigrationCase,
  DataMigrationReverseRun,
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
  return readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

/**
 * The reverse script a windowed migration ships beside itself.
 *
 * `scripts/validate-blue-green-migrations.sh` proves this file EXISTS. Only the
 * runs below prove it does what its header says.
 */
function rollbackSql(name: string): string {
  // Test helper: the repo's own migrations directory, same as above.
  return readFileSync(path.join(MIGRATIONS_DIR, name, "rollback.sql"), "utf8");
}

/**
 * Statements that would END the transaction a verification case owns, or start
 * a second one. `ROLLBACK TO <savepoint>` is deliberately not one of them: it
 * unwinds to a savepoint and leaves the transaction open.
 */
const TRANSACTION_CONTROL =
  /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK(?!\s+TO\b)|PREPARE\s+TRANSACTION)\b/i;

/**
 * A verification case already owns a rollback transaction. Remove only a
 * migration's complete outer transaction envelope before running it there;
 * replaying the committed migration chain still executes the real envelope.
 *
 * COMMENT-AWARE, AND THAT IS THE WHOLE POINT (#3369). This used to anchor
 * `BEGIN;` at the first byte of the file. Every `migration.sql` in this
 * repository opens with `BEGIN;`, so every one of them was stripped correctly —
 * and every `rollback.sql` opens with its operator header, which is a block of
 * `--` comments, so not one of them matched. Each therefore ran its OWN
 * `BEGIN;`/`COMMIT;` INSIDE the case's transaction, and PostgreSQL answers the
 * nested `BEGIN` with a warning and then honours the `COMMIT`: it commits the
 * CASE, seed rows and all. The harness's later `ROLLBACK` then warns that there
 * is no transaction in progress and does nothing.
 *
 * Measured on a real PostgreSQL before the fix: after #3369's two reverse
 * scripts ran, the chain database — which every case is supposed to leave
 * untouched — still held the case's 4 bookings and 3 members, `Booking`'s
 * `memberId` was back to NOT NULL because `20260928020000/rollback.sql`'s
 * `SET NOT NULL` had committed, and replaying `20260928030000` then died on its
 * own section 4 with "null value in column memberId violates not-null
 * constraint". Nothing in the failure pointed at a rollback script.
 *
 * `stripSqlComments` blanks comments to spaces and keeps every newline, so its
 * result is the same LENGTH as the source and offsets found in it index
 * straight back into the verbatim bytes — which is what lets this locate the
 * envelope without ever executing a re-rendered copy of the SQL. One home for
 * comment-stripping (`INV-SSOT`): the audit-writer census and the backfill
 * contracts read migrations through that same function.
 */
function sqlInsideVerificationTransaction(sql: string): string {
  const bare = stripSqlComments(sql);
  const open = bare.match(/^\s*BEGIN\s*;/i);
  const close = bare.match(/\bCOMMIT\s*;\s*$/i);
  const inner =
    open && close
      ? sql.slice(open[0].length, bare.length - close[0].length)
      : sql;
  const leaked = splitSqlStatements(inner)
    .map((statement) => stripSqlComments(statement).trim())
    .filter((statement) => TRANSACTION_CONTROL.test(statement));
  if (leaked.length > 0) {
    throw new Error(
      `refusing to run SQL that steers the transaction a verification case owns: ${leaked
        .map((statement) => JSON.stringify(statement.slice(0, 60)))
        .join(", ")}. A case wraps its work in BEGIN/ROLLBACK, so a COMMIT reaching PostgreSQL here makes that work permanent in the chain database every later fixture replays into (#3369).`,
    );
  }
  return inner;
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

  it("can take the transaction envelope off every migration and every rollback script", () => {
    // #3369. A case wraps its work in BEGIN/ROLLBACK so the chain database it
    // replays into is left exactly as it was. A `COMMIT;` that survives into
    // that transaction commits it instead: the case's seed rows and schema
    // changes become PERMANENT, the harness's own ROLLBACK then warns that
    // there is no transaction and does nothing, and the failure surfaces
    // migrations later as a replay that cannot fail failing. That is what
    // happened here — the envelope matcher was anchored at the first byte of
    // the file, so it stripped every `migration.sql` and not one `rollback.sql`,
    // because a rollback script opens with its operator header.
    //
    // This needs no database, so it fails in `verify` in seconds rather than in
    // the slow job that stands PostgreSQL up — and it grades every committed
    // script, not only the ones a fixture happens to run today.
    const offenders: string[] = [];
    for (const name of migrationNames()) {
      for (const file of ["migration.sql", "rollback.sql"]) {
        const full = path.join(MIGRATIONS_DIR, name, file);
        if (!existsSync(full)) continue;
        try {
          sqlInsideVerificationTransaction(readFileSync(full, "utf8"));
        } catch (error) {
          offenders.push(`${name}/${file}: ${(error as Error).message}`);
        }
      }
    }
    expect(offenders, offenders.join("\n\n")).toEqual([]);
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

      // A reverse run names scripts that exist, asserts something, and is
      // proved by mutants of its own — a reverse nothing can break is a
      // reverse nothing has checked (#3369).
      for (const testCase of fixture.cases) {
        const reverse = testCase.reverse;
        if (!reverse) continue;
        expect(
          reverse.runs.length,
          `${fixture.migration} / ${testCase.name}: a reverse block with no runs executes nothing`,
        ).toBeGreaterThan(0);
        for (const run of reverse.runs) {
          expect(run.scripts.length).toBeGreaterThan(0);
          for (const script of run.scripts) {
            expect(
              existsSync(path.join(MIGRATIONS_DIR, script, "rollback.sql")),
              `${fixture.migration} / ${run.name}: ${script} ships no rollback.sql`,
            ).toBe(true);
          }
          const asserts =
            (run.expectations?.length ?? 0) > 0 || Boolean(run.raises);
          expect(
            asserts,
            `${fixture.migration} / ${run.name}: a reverse run must either expect rows or expect a refusal`,
          ).toBe(true);
        }
        // Mutants are what stop a reverse's row expectations passing against a
        // reverse that did nothing. A case whose runs only assert a REFUSAL has
        // no such expectations to make vacuous, and the refusal itself is the
        // proof — so the requirement attaches to the runs that assert rows.
        if (reverse.runs.some((run) => (run.expectations?.length ?? 0) > 0)) {
          expect(
            reverse.mutants.length,
            `${fixture.migration} / ${testCase.name}: declare at least one reverse mutant, or the reverse expectations could be satisfied by a reverse that did nothing`,
          ).toBeGreaterThan(0);
        }
        for (const mutant of reverse.mutants) {
          const sql = rollbackSql(mutant.script);
          const occurrences = sql.split(mutant.find).length - 1;
          expect(
            occurrences,
            `${fixture.migration}: reverse mutant "${mutant.name}" must match ${mutant.script}/rollback.sql exactly once (found ${occurrences})`,
          ).toBe(1);
          expect(mutant.replace).not.toBe(mutant.find);
          expect(mutant.harm.length).toBeGreaterThan(20);
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
/**
 * The reverse-script outcomes, keyed the same way. A separate map because a
 * reverse run is ONE execution rather than a fixture's whole set of cases.
 */
const reverseRuns = new Map<string, CaseOutcome>();

const realRunKey = (migration: string) => `${migration}::real`;
const rerunKey = (migration: string) => `${migration}::rerun`;
const noMigrationKey = (migration: string) => `${migration}::not-applied`;
const mutantKey = (migration: string, mutant: string) =>
  `${migration}::mutant::${mutant}`;
const reverseKey = (migration: string, run: string) =>
  `${migration}::reverse::${run}`;
const reverseMutantKey = (migration: string, run: string, mutant: string) =>
  `${migration}::reverse::${run}::mutant::${mutant}`;

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
   * Open the transaction a case owns, and remember WHICH transaction it is.
   * `pg_current_xact_id()` assigns a real id rather than reporting one only if
   * something already wrote, so the identity below is always comparable.
   */
  async function beginCase(): Promise<string> {
    await db().query("BEGIN");
    const result = await db().query<{ xid: string }>(
      "SELECT pg_current_xact_id()::text AS xid",
    );
    const xid = result.rows[0]?.xid;
    if (!xid) throw new Error("BEGIN returned no transaction id");
    return xid;
  }

  /**
   * Roll the case back — then PROVE the transaction just rolled back is the one
   * the case opened (#3369).
   *
   * `sqlInsideVerificationTransaction` refuses SQL that steers the transaction,
   * which is the fix; this is the guard that does not depend on RECOGNISING the
   * SQL that would break it. A case that escaped its transaction has already
   * written its seed rows and its schema changes permanently into the chain
   * database, and every later fixture replays into that — so the symptom
   * surfaces migrations away from the cause, as a replay that cannot fail
   * failing.
   *
   * It raises from the `finally`, deliberately, where no `catch` above can
   * demote it: `runCases` treats a raised error as DETECTION, so a leak
   * recorded as an ordinary case error would read as a mutant caught and pass.
   */
  async function endCase(xid: string, label: string): Promise<void> {
    let current: string | null;
    try {
      const result = await db().query<{ xid: string | null }>(
        "SELECT pg_current_xact_id_if_assigned()::text AS xid",
      );
      current = result.rows[0]?.xid ?? null;
    } catch (error) {
      // `25P02 in_failed_sql_transaction` — "current transaction is aborted,
      // commands ignored until end of transaction block". Most cases here are
      // SUPPOSED to raise: every mutant run, every `raises` reverse run, and the
      // run where the migration is not applied at all. A raise inside the
      // transaction aborts it, and PostgreSQL then refuses this probe too. That
      // refusal is not a problem to work around — it is proof of the very thing
      // being checked, because only a transaction that is still open can be in
      // a failed state. Anything else rethrows.
      if ((error as { code?: string }).code !== "25P02") throw error;
      current = xid;
    }
    await db().query("ROLLBACK");
    if (current !== xid) {
      throw new Error(
        `${label} escaped its verification transaction: it opened ${xid} and ended in ${current ?? "no transaction at all"}. Something it ran issued COMMIT, so the ROLLBACK above changed nothing and this case's rows are now permanent in the chain database (#3369).`,
      );
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

  /**
   * One case, migrated, then REVERSED — the thing nothing executed before
   * #3369. `overrides` lets a mutant replace one script's body; everything
   * else runs verbatim from disk, exactly as an operator would paste it.
   */
  async function runReverse(
    testCase: DataMigrationCase,
    migrationBody: string,
    run: DataMigrationReverseRun,
    overrides: Map<string, string>,
  ): Promise<CaseOutcome> {
    const readings: CaseOutcome["readings"] = [];
    const xid = await beginCase();
    try {
      if (testCase.seed.trim()) {
        await runScript(testCase.seed, `seeding "${testCase.name}"`);
      }
      await runScript(
        sqlInsideVerificationTransaction(migrationBody),
        `applying the migration before reversing it for "${testCase.name}"`,
      );
      for (const script of run.scripts) {
        const body = overrides.get(script) ?? rollbackSql(script);
        await runScript(
          sqlInsideVerificationTransaction(body),
          `running ${script}/rollback.sql for "${run.name}"`,
        );
      }
      for (const expectation of run.expectations ?? []) {
        // Test fixture: the fixture's own read-only assertion query.
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
      await endCase(xid, `reverse "${run.name}" of "${testCase.name}"`);
    }
  }

  async function runCase(
    testCase: DataMigrationCase,
    versions: string[],
  ): Promise<CaseOutcome> {
    const readings: CaseOutcome["readings"] = [];
    const xid = await beginCase();
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
      await endCase(xid, `case "${testCase.name}"`);
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

      // The REVERSE scripts, executed. Same pre-state, same real migration,
      // then the rollback files exactly as an operator runs them (#3369).
      for (const testCase of fixture.cases) {
        const reverse = testCase.reverse;
        if (!reverse) continue;
        for (const run of reverse.runs) {
          reverseRuns.set(
            reverseKey(fixture.migration, run.name),
            await runReverse(testCase, sql, run, new Map()),
          );
          // EVERY run, including one that must RAISE (#3369). The rule used to
          // be that a mutant is only meaningful against a run that must
          // succeed, because a raising run is "detected" whatever the mutant
          // did. That is true only of detection-by-error; a raising run has a
          // second, sharper signal — whether it still refuses for the reason it
          // claims to. Scoring it that way is what gives the wrong-order guard
          // any coverage at all, and that guard is the one thing standing
          // between an operator and a half rollback reported as a success.
          for (const mutant of reverse.mutants) {
            const mutated = rollbackSql(mutant.script).replace(
              mutant.find,
              () => mutant.replace,
            );
            reverseRuns.set(
              reverseMutantKey(fixture.migration, run.name, mutant.name),
              await runReverse(
                testCase,
                sql,
                run,
                new Map([[mutant.script, mutated]]),
              ),
            );
          }
        }
      }

      // Advance past this migration so the next fixture replays from here.
      await applyThrough(index + 1);
    }
  }, 900_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
    if (adminClient && scratchDatabase) {
      // Test fixture: drops the disposable database created above.
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
      // The REVERSE scripts, executed (#3369). Nothing ran these before: the
      // windowed-migration validator checks only that the file exists, so the
      // first cut of #3369's reverse shipped a map with one member per
      // organisation and would have handed a twice-recorded school's second
      // booking — and another school's Xero customer — to the wrong member.
      // ------------------------------------------------------------------
      for (const testCase of fixture.cases) {
        const reverse = testCase.reverse;
        if (!reverse) continue;
        for (const run of reverse.runs) {
          it(`reverse: ${run.name}`, () => {
            const outcome = reverseRuns.get(
              reverseKey(fixture.migration, run.name),
            );
            expect(outcome, "the setup did not run this reverse").toBeDefined();
            if (run.raises) {
              expect(
                outcome?.error ?? "",
                `${run.name} had to refuse with ${run.raises} and did not`,
              ).toContain(run.raises);
              return;
            }
            expect(outcome?.error, `${run.name} raised`).toBeNull();
            for (const reading of outcome?.readings ?? []) {
              expect(reading.actual, reading.claim).toEqual(reading.expected);
            }
          });

        }

        for (const mutant of reverse.mutants) {
          it(`reverse: catches a broken ${mutant.script} rollback — ${mutant.name}`, () => {
            // AT LEAST ONE run, which is what this fixture type has always
            // promised ("Each one must make at least one run fail") and not
            // what the runner used to require. Demanding that EVERY run catch
            // EVERY mutant is a different and wrong rule: the wrong-order guard
            // is deliberately silent when the scripts run in the right order,
            // so the run that proves the data comes back correctly can never
            // notice the guard being removed. Only the run that exercises the
            // wrong order can, and that run is scored on its refusal (#3369).
            const detectedBy = reverse.runs.filter((run) => {
              const outcome = reverseRuns.get(
                reverseMutantKey(fixture.migration, run.name, mutant.name),
              );
              if (!outcome) return false;
              // A run that must refuse is detected by no longer refusing for
              // the declared reason — a different error, or none at all.
              if (run.raises) return !(outcome.error ?? "").includes(run.raises);
              return outcomeDetected(outcome);
            });
            expect(
              detectedBy.length > 0,
              `${fixture.migration}: reverse mutant "${mutant.name}" went UNDETECTED by every run (${reverse.runs.map((run) => `"${run.name}"`).join(", ")}). ${mutant.harm} Sharpen an expectation, or add a run that exercises it, until this fails.`,
            ).toBe(true);
          });
        }
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
