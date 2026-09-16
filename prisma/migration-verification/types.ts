/**
 * Data-migration verification fixtures (#2418).
 *
 * A migration that only changes the SHAPE of the database is proven by CI's
 * `Migration drift check`. That job applies every migration to an EMPTY
 * PostgreSQL, so a migration that also REWRITES DATA — a backfill, a repair, a
 * value transform — has its `UPDATE` match nothing. It is proven to parse and
 * proven to do nothing.
 *
 * A fixture closes that gap. It declares, in data:
 *
 *   1. the PRE-STATE a real club could plausibly hold, on top of the real
 *      schema (the runner replays every earlier migration first, so the fixture
 *      seeds rows rather than inventing tables);
 *   2. the POST-STATE, as the exact rows named queries must return once the
 *      real `migration.sql` has run against that pre-state; and
 *   3. MUTANTS — deliberate breakages of the migration that the assertions above
 *      must be sharp enough to catch.
 *
 * The mutants are what make the fixture worth having. A post-state assertion
 * that would pass whether or not the migration ran is coverage that does not
 * exist, which is exactly the failure #2418 was filed about; the runner proves
 * each fixture's teeth on every CI run rather than taking the author's word for
 * it. It also runs one mutant nobody has to declare: not applying the migration
 * at all.
 *
 * See `docs/BLUE_GREEN_MIGRATION_POLICY.md` → "Data-migration verification" for
 * the how-to, and `prisma/migration-verification/index.ts` for the registry a
 * new fixture must be added to.
 */

/**
 * One claim about the state of the database after the migration has run,
 * expressed as a query and the rows it must return.
 *
 * TIMESTAMPS: select them through `to_char(...)`, never raw. A naive
 * `timestamp(3)` is resolved by the pg driver against the CLIENT's local zone,
 * so a raw `Date` comparison passes in UTC CI and fails on a Pacific/Auckland
 * machine. Comparing the stored characters is zone-independent.
 */
export type DataMigrationExpectation = {
  /** Plain English: what this query proves. Quoted verbatim on failure. */
  claim: string;
  /** Read-only SQL. Name the columns; never `SELECT *` (the result shape must be reviewable). */
  sql: string;
  /** Exactly the rows, in order, that the query must return. */
  rows: Record<string, unknown>[];
};

/** A stable PostgreSQL failure the real migration is expected to raise. */
export type DataMigrationExpectedError = {
  message: string;
  code?: string;
  constraint?: string;
  /** Strings that must not appear anywhere in the serialized driver error. */
  absentText?: string[];
  /** Set true when PostgreSQL DETAIL and HINT must both be absent. */
  noDetailOrHint?: boolean;
};

/**
 * One pre-state and the claims that must hold about it afterwards.
 *
 * Each case runs inside its own transaction, which is rolled back afterwards,
 * so cases cannot see each other's rows and none of them survive into the next
 * fixture.
 */
export type DataMigrationCase = {
  /** Plain English: the club this pre-state describes. */
  name: string;
  /**
   * SQL that turns the freshly migrated database into that club's pre-state.
   * May be empty when the earlier migrations already produce it — which is the
   * strongest form, because then the pre-state is literally what a real install
   * holds rather than what the fixture author believed it holds.
   */
  seed: string;
  /**
   * Optional SQL run after the migration-under-test and before expectations.
   * Use this only to exercise a schema object the migration creates (for
   * example a trigger); ordinary data migrations keep all pre-state in `seed`.
   * The runner also executes it for mutants and the no-migration control.
   */
  afterMigration?: string;
  expectations: DataMigrationExpectation[];
  /**
   * The reverse scripts, executed against the migrated pre-state this case
   * built, and what must hold once they have. See {@link DataMigrationReverse}.
   */
  reverse?: DataMigrationReverse;
  /** Omit for an ordinary successful migration case. */
  expectedError?: DataMigrationExpectedError;
};

/**
 * A deliberate breakage of the migration, and the reason it must be caught.
 *
 * `find` must appear EXACTLY ONCE in the migration SQL — the runner refuses an
 * ambiguous or absent match rather than silently testing an unmutated file. It is
 * replaced verbatim, so `replace` may contain `$$`/`$cms$` dollar-quoting freely.
 *
 * A mutant that only makes the SQL INVALID proves nothing: the case raises, which
 * counts as detection for free, but says nothing about the value the migration
 * writes. At least one of a fixture's mutants must therefore be a semantically
 * VALID change caught by a real post-state ROW MISMATCH — the runner enforces
 * this, so a fixture cannot pass on expectations that never pin the rewrite
 * (#2418).
 */
export type DataMigrationMutant = {
  /** Plain English: what this mutant does to the migration. */
  name: string;
  /** Plain English: the real-world harm this mutant would cause if it shipped. */
  harm: string;
  find: string;
  replace: string;
};

/**
 * ONE RUN OF THE REVERSE SCRIPTS, and what must be true afterwards.
 *
 * `rollback.sql` beside a windowed migration is validated by
 * `scripts/validate-blue-green-migrations.sh` — which checks that the FILE
 * EXISTS. Nothing executed one. That is how #3369's first cut shipped a reverse
 * that handed one school's bookings, and another school's Xero customer, to the
 * wrong member: the script read correctly, and the only thing that could have
 * caught it was running it against the same pre-state the forward migration is
 * proved against. "A prescribed step nobody has run is not evidence" is this
 * repository's own rule, and this type is what lets a fixture obey it.
 */
export type DataMigrationReverseRun = {
  /** Plain English: what this run of the reverse scripts is doing. */
  name: string;
  /**
   * Migration directory names whose `rollback.sql` is run, in the order an
   * operator runs them — normally the reverse of the order they were applied.
   */
  scripts: string[];
  /**
   * Exactly the rows the named queries must return once the reverses have run.
   * Omitted for a run that must raise.
   */
  expectations?: DataMigrationExpectation[];
  /**
   * When set, the run must RAISE and the error must contain this text. A
   * refusal is a result, and the refusals are half of what a reverse promises.
   */
  raises?: string;
};

/** A deliberate breakage of a REVERSE script, and which script it breaks. */
export type DataMigrationReverseMutant = DataMigrationMutant & {
  /** The migration directory name whose `rollback.sql` this mutates. */
  script: string;
};

/** The reverse scripts a case exercises, and the mutants that give it teeth. */
export type DataMigrationReverse = {
  runs: DataMigrationReverseRun[];
  /**
   * Each one must make at least one run fail. Without these the reverse
   * expectations could be satisfied by a reverse that did nothing.
   */
  mutants: DataMigrationReverseMutant[];
};

export type DataMigrationVerification = {
  /** The migration directory name, exactly. Also the fixture's own file name. */
  migration: string;
  /** Plain English: what this migration must do, and to whom. */
  intent: string;
  cases: DataMigrationCase[];
  mutants: DataMigrationMutant[];
  /**
   * `isolated_database` clones the pre-migration database for every case and
   * sends each migration body as one byte-for-byte query. Use it for an
   * explicit BEGIN/COMMIT migration: translating that envelope to a savepoint
   * would test a different program (INV-SSOT-002).
   */
  executionMode?: "case_transaction" | "isolated_database";
  /**
   * True when running the whole `migration.sql` a second time must change
   * nothing — the property that makes a one-shot repair safe to replay. Only
   * valid for a migration whose statements are all re-runnable (a pure
   * value-scoped DML repair); a migration containing `CREATE TABLE` cannot
   * claim it.
   */
  idempotentReRun: boolean;
};
