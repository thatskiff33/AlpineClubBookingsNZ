import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  bashFixtureEnv,
  bashGateArgs,
} from "../../src/lib/__tests__/helpers/bash-fixture-path";
import { MIGRATION_GATE_TIMEOUT_MS } from "../../src/lib/__tests__/helpers/migration-gate-timeouts";

/**
 * Check 4 of `scripts/check-migration-safety-coverage.sh` (#3002): an expand and
 * its own contract may not land in one deploy.
 *
 * WHY THESE BUILD THROWAWAY GIT REPOSITORIES. "Added on this branch" is a fact
 * only git holds, so a test that mocked git would assert nothing about the one
 * question this check asks. Each case is a few files in a temp directory with
 * `git init`, a base branch, and commits on top — the shape
 * `scripts/__tests__/file-size-base.test.ts` established for the file-size
 * ratchet, for the same reason.
 *
 * The gate is RUN, not modelled: `bash scripts/check-migration-safety-coverage.sh`
 * against the fixture, with the real validator behind it. A gate that is only
 * modelled is a gate nobody has proved.
 *
 * WINDOWS. These spawn `bash`, which on a stock Windows 11 box is the WSL
 * launcher, so fixture paths and gate variables go through the helpers in
 * `src/lib/__tests__/helpers/bash-fixture-path.ts` (#2886) — an env var put on
 * `spawnSync`'s `env` option is silently NOT forwarded into WSL, which would run
 * the gate against the repository's real ledger while looking like it worked.
 * Measured for this suite: WSL's git reads these throwaway repositories on
 * /mnt/c correctly, though it cannot read a git WORKTREE — which is why the gate
 * skips rather than fails when git cannot see a work tree on a developer machine.
 */

const LEDGER_HEADER =
  "# migration_name\tphase\tprevious_expand_release\told_code_compatible\tlock_impact_plan";

/** The ledger's first data row: everything at or after it is in scope. */
const BASELINE_ROW = "20260507000000_base\texpand\tn/a\tyes\tbaseline row";

const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS) rmSync(root, { force: true, recursive: true });
  ROOTS.length = 0;
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

type Fixture = {
  root: string;
  migrationsDir: string;
  ledgerPath: string;
  addMigration: (name: string, sql?: string) => void;
  addFileToMigration: (name: string, file: string, body: string) => void;
  writeLedger: (rows: string[]) => void;
  commit: (message: string) => string;
  branch: (name: string) => void;
};

/** A git repository shaped like this one: prisma/migrations plus a ledger TSV. */
function newFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "acb-samerelease-"));
  ROOTS.push(root);
  git(root, "init", "--quiet", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  // A commit signature would prompt or fail in CI; this suite never signs.
  git(root, "config", "commit.gpgsign", "false");
  // The fixture's own content must not be rewritten on checkout: this repository
  // pins migration SQL to LF (#2399) and a throwaway repo has no .gitattributes.
  git(root, "config", "core.autocrlf", "false");

  const migrationsDir = path.join(root, "prisma", "migrations");
  const ledgerPath = path.join(root, "safety.tsv");
  mkdirSync(migrationsDir, { recursive: true });

  const addMigration = (name: string, sql = "SELECT 1;\n") => {
    // Test fixture: joins the fixture's own migrations directory with a
    // test-controlled name; no user input.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const dir = path.join(migrationsDir, name);
    mkdirSync(dir, { recursive: true });
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    writeFileSync(path.join(dir, "migration.sql"), sql, "utf8");
  };

  const addFileToMigration = (name: string, file: string, body: string) => {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const dir = path.join(migrationsDir, name);
    mkdirSync(dir, { recursive: true });
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    writeFileSync(path.join(dir, file), body, "utf8");
  };

  const writeLedger = (rows: string[]) => {
    writeFileSync(ledgerPath, [LEDGER_HEADER, BASELINE_ROW, ...rows].join("\n") + "\n", "utf8");
  };

  const commit = (message: string) => {
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", message);
    return git(root, "rev-parse", "HEAD").trim();
  };

  const branch = (name: string) => {
    git(root, "branch", name);
  };

  writeLedger([]);
  return {
    root,
    migrationsDir,
    ledgerPath,
    addMigration,
    addFileToMigration,
    writeLedger,
    commit,
    branch,
  };
}

/** Run the real gate against a fixture. `base` is passed as `--base`. */
function runGate(
  fixture: Pick<Fixture, "migrationsDir" | "ledgerPath">,
  base: string,
): { status: number | null; stderr: string } {
  const result = spawnSync(
    "bash",
    bashGateArgs(
      "scripts/check-migration-safety-coverage.sh",
      ["--base", base],
      bashFixtureEnv({
        MIGRATIONS_DIR: fixture.migrationsDir,
        MIGRATION_SAFETY_LEDGER: fixture.ledgerPath,
      }),
    ),
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  return { status: result.status, stderr: result.stderr ?? "" };
}

/**
 * The contract row shape these cases use, with the expand it names.
 * `old_code_compatible=yes` keeps the other three checks quiet: a `windowed` row
 * with no `rollback.sql` fails the pre-existing ledger-coverage check, which
 * would mask which check actually fired.
 */
function contractRow(
  contract: string,
  expand: string,
  plan = "Probe contract row.",
  oldCodeCompatible = "yes",
): string {
  return `${contract}\tcontract\t${expand}\t${oldCodeCompatible}\t${plan}`;
}

function expandRow(name: string): string {
  return `${name}\texpand\tn/a\tno\tProbe expand row.`;
}

describe("same-release expand/contract check (#3002)", () => {
  it(
    "FAILS when a branch adds an expand and its own contract",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // The load-bearing case. Since #3002 an epic reaches `main` as one merge,
      // so both of these land in a single deploy and nothing has drained.
      const fixture = newFixture();
      fixture.commit("base with no migrations");
      fixture.branch("base-main");

      fixture.addMigration("20990101000000_add_thing");
      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow("20990102000000_drop_thing", "20990101000000_add_thing"),
      ]);
      fixture.commit("the epic adds both halves");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain(
        "Same-release expand/contract check FAILED: an expand and its own contract land in one deploy.",
      );
      // Both migrations named, so the reader does not have to go looking.
      expect(result.stderr).toContain("20990102000000_drop_thing");
      expect(result.stderr).toContain("20990101000000_add_thing");
      // And it says what to do, which is what stops a gate being worked around.
      expect(result.stderr).toContain("move the contract half to a release");
      // It is THIS check that failed, not one of the three that came before.
      expect(result.stderr).toContain("Ledger well-formedness check passed");
      expect(result.stderr).toContain("Ledger coverage check passed");
    },
  );

  it(
    "passes when the branch adds only the expand half",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      const fixture = newFixture();
      fixture.commit("base with no migrations");
      fixture.branch("base-main");

      fixture.addMigration("20990101000000_add_thing");
      fixture.writeLedger([expandRow("20990101000000_add_thing")]);
      fixture.commit("the epic adds the expand half only");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain(
        "Same-release expand/contract check passed for 1 migration(s)",
      );
    },
  );

  it(
    "passes when the contract's named expand is already on the base ref",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // The ordinary, correct two-release retirement. The expand shipped and
      // drained in an earlier release; only the contract half is new here.
      const fixture = newFixture();
      fixture.addMigration("20990101000000_add_thing");
      fixture.writeLedger([expandRow("20990101000000_add_thing")]);
      fixture.commit("the expand shipped in an earlier release");
      fixture.branch("base-main");

      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow("20990102000000_drop_thing", "20990101000000_add_thing"),
      ]);
      fixture.commit("this release contracts it");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("Same-release expand/contract check passed");
    },
  );

  it(
    "FAILS rather than passing when the base ref cannot be resolved",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // A gate that cannot read its comparison must not report a green it has
      // not earned — the rule `npm run pr:check` and the file-size ratchet
      // follow. On CI this is the depth-1-checkout case.
      const fixture = newFixture();
      fixture.addMigration("20990101000000_add_thing");
      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow("20990102000000_drop_thing", "20990101000000_add_thing"),
      ]);
      fixture.commit("everything in one commit");

      const result = runGate(fixture, "origin/no-such-ref");

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain(
        "Same-release expand/contract check FAILED: the base ref origin/no-such-ref does not resolve",
      );
      expect(result.stderr).toContain("must not report a green it has not earned");
      expect(result.stderr).toContain("git fetch origin no-such-ref");
    },
  );

  it(
    "FAILS on a shallow clone rather than narrowing the diff silently",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // A shallow clone does not error on `merge-base`: it hands back HEAD, so
      // the added-migration set comes back empty and the check would pass over a
      // tree holding the very pair it exists to catch. ci.yml records the same
      // trap for the file-size ratchet, where it cost an accepted debt increase.
      const fixture = newFixture();
      fixture.addMigration("20990101000000_add_thing");
      fixture.writeLedger([expandRow("20990101000000_add_thing")]);
      fixture.commit("one commit");

      const cloneRoot = mkdtempSync(path.join(tmpdir(), "acb-samerelease-shallow-"));
      ROOTS.push(cloneRoot);
      const clone = path.join(cloneRoot, "clone");
      execFileSync(
        "git",
        ["clone", "--quiet", "--depth", "1", pathToFileURL(fixture.root).href, clone],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );

      const result = runGate(
        {
          migrationsDir: path.join(clone, "prisma", "migrations"),
          ledgerPath: path.join(clone, "safety.tsv"),
        },
        "HEAD",
      );

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("this is a shallow clone");
      expect(result.stderr).toContain("fetch-depth: 0");
    },
  );

  it(
    "treats an UNCOMMITTED new migration as added, so the pair is caught before the commit",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      const fixture = newFixture();
      fixture.commit("base with no migrations");
      fixture.branch("base-main");

      // Never committed: exactly what an implementor's working tree looks like
      // mid-change, and the cheapest moment to be told.
      fixture.addMigration("20990101000000_add_thing");
      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow("20990102000000_drop_thing", "20990101000000_add_thing"),
      ]);

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("an expand and its own contract land in one deploy");
    },
  );

  it(
    "does not treat a pre-existing migration that only GAINS a rollback.sql as added",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // Keyed on migration.sql on purpose. A migration that shipped in an
      // earlier release and gains a reverse script here is not new, and reading
      // it as new would fail a correct two-release retirement.
      const fixture = newFixture();
      fixture.addMigration("20990101000000_add_thing");
      fixture.writeLedger([expandRow("20990101000000_add_thing")]);
      fixture.commit("the expand shipped earlier");
      fixture.branch("base-main");

      fixture.addFileToMigration("20990101000000_add_thing", "rollback.sql", "SELECT 1;\n");
      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow("20990102000000_drop_thing", "20990101000000_add_thing"),
      ]);
      fixture.commit("contract half, plus a rollback for the old expand");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("Same-release expand/contract check passed for 1 migration(s)");
    },
  );

  it(
    "lets an owner-chosen one-release drop through when the LEDGER says so, with a reason",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // The escape hatch, and the reason it exists: a gate with no way to say
      // "the owner chose a maintenance window" gets deleted rather than
      // satisfied. It lives in the contract row's own lock_impact_plan so the
      // justification cannot drift away from the row it excuses.
      //
      // THE ROW DECLARES `windowed` AND SHIPS A rollback.sql, and both are now
      // required of an acknowledgement rather than merely described. This case
      // originally declared `yes` and shipped no reverse script, which is what
      // made docs/BLUE_GREEN_MIGRATION_POLICY.md's "is `windowed` by definition,
      // and the pre-existing coverage check then still demands its
      // `rollback.sql`" false — the demand fires on the declaration and nothing
      // required the declaration. The second half of this test is that pair
      // working: take the reverse script away and the coverage check bites.
      const fixture = newFixture();
      fixture.commit("base with no migrations");
      fixture.branch("base-main");

      fixture.addMigration("20990101000000_add_thing");
      fixture.addMigration("20990102000000_drop_thing");
      fixture.addFileToMigration("20990102000000_drop_thing", "rollback.sql", "SELECT 1;\n");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow(
          "20990102000000_drop_thing",
          "20990101000000_add_thing",
          "SAME-RELEASE EXPAND/CONTRACT ACKNOWLEDGED: owner chose a one-release drop behind an announced window; old app and workers stopped before migrate.",
          "windowed",
        ),
      ]);
      fixture.commit("windowed one-release drop");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain(
        "Same-release expand/contract ACKNOWLEDGED for 20990102000000_drop_thing against 20990101000000_add_thing",
      );
      // Counted in the summary, so an acknowledgement is never silent.
      expect(result.stderr).toContain("(1 acknowledged)");

      rmSync(path.join(fixture.migrationsDir, "20990102000000_drop_thing", "rollback.sql"));
      const withoutRollback = runGate(fixture, "base-main");

      expect(withoutRollback.status, withoutRollback.stderr).not.toBe(0);
      expect(withoutRollback.stderr).toContain("windowed migrations must ship a reverse script");
    },
  );

  it(
    "refuses a bare acknowledgement marker with no reason behind it",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      const fixture = newFixture();
      fixture.commit("base with no migrations");
      fixture.branch("base-main");

      fixture.addMigration("20990101000000_add_thing");
      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow(
          "20990102000000_drop_thing",
          "20990101000000_add_thing",
          "SAME-RELEASE EXPAND/CONTRACT ACKNOWLEDGED: because",
        ),
      ]);
      fixture.commit("marker with no reason");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("an expand and its own contract land in one deploy");
    },
  );

  it(
    "ignores a contract row whose previous_expand_release is n/a",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // `n/a` names no migration, so there is no pair. The validator already
      // requires a real previous release for a DESTRUCTIVE contract migration;
      // this check must not invent a second, different rule for the rest.
      const fixture = newFixture();
      fixture.commit("base with no migrations");
      fixture.branch("base-main");

      fixture.addMigration("20990101000000_add_thing");
      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow("20990102000000_drop_thing", "n/a"),
      ]);
      fixture.commit("contract row naming nothing");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("Same-release expand/contract check passed");
    },
  );

  it(
    "SKIPS, loudly, when the migrations directory is in no git work tree",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // What keeps the pre-existing fixture-based gate tests green: their
      // migration trees live under os.tmpdir() with no repository, so there is
      // no branch to read "added on this branch" from. It says so rather than
      // inventing an answer, and the three checks around it still run.
      const bare = mkdtempSync(path.join(tmpdir(), "acb-samerelease-bare-"));
      ROOTS.push(bare);
      const migrationsDir = path.join(bare, "migrations");
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      mkdirSync(path.join(migrationsDir, "20990101000000_add_thing"), { recursive: true });
      writeFileSync(
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        path.join(migrationsDir, "20990101000000_add_thing", "migration.sql"),
        "SELECT 1;\n",
        "utf8",
      );
      const ledgerPath = path.join(bare, "safety.tsv");
      writeFileSync(
        ledgerPath,
        [LEDGER_HEADER, BASELINE_ROW, expandRow("20990101000000_add_thing")].join("\n") + "\n",
        "utf8",
      );

      const result = runGate({ migrationsDir, ledgerPath }, "HEAD");

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("Same-release expand/contract check SKIPPED");
      expect(result.stderr).toContain("Ledger well-formedness check passed");
      expect(result.stderr).toContain("Migration safety coverage check passed");
    },
  );

  it(
    "FAILS on the all-zero base a ref-CREATING push carries",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // The case `.github/workflows/ci.yml`'s `github.event.created == false`
      // guard routes around, asserted here so the gate's half of that contract
      // is proved rather than assumed. An all-zero `before` means the ref did
      // not exist until this push, so there is no "before" to measure against
      // and no pass to report. Epic branches are created routinely since #3002,
      // which is what made this reachable.
      const fixture = newFixture();
      fixture.addMigration("20990101000000_add_thing");
      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow("20990102000000_drop_thing", "20990101000000_add_thing"),
      ]);
      fixture.commit("the branch-creating push");

      const result = runGate(fixture, "0".repeat(40));

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("the base is the all-zero object id");
      expect(result.stderr).toContain("re-run with --base naming a commit");
    },
  );

  it(
    "FAILS when the expand landed in an EARLIER COMMIT on the same branch",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // The epic-wide reach, which was correct by construction and unproven.
      // On an integration branch each child is its own commit, so the expand and
      // its contract are rarely in one commit — they are two children. The check
      // compares against the BASE REF rather than against HEAD^1 precisely so
      // the whole branch counts as one deploy, which since #3002 it is.
      const fixture = newFixture();
      fixture.commit("base with no migrations");
      fixture.branch("base-main");

      fixture.addMigration("20990101000000_add_thing");
      fixture.writeLedger([expandRow("20990101000000_add_thing")]);
      fixture.commit("child one: the expand half");

      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow("20990102000000_drop_thing", "20990101000000_add_thing"),
      ]);
      fixture.commit("child two: the contract half, a commit later");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain(
        "Same-release expand/contract check FAILED: an expand and its own contract land in one deploy.",
      );
      expect(result.stderr).toContain("20990101000000_add_thing  (added on this branch too)");
    },
  );

  it(
    "FAILS a previous_expand_release that names a migration which does not exist",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // Check 5. The contract row names `20990101000000_add_thing`; the
      // directory is `20990101000000_expand_add_thing` — one dropped word in a
      // hand-typed 40-to-60 character name.
      //
      // WHAT THIS TEST IS ACTUALLY FOR: check 4 matches that value against the
      // migrations the branch adds, so a name matching NOTHING matches the added
      // expand either, and check 4 passes over the exact pair it exists to
      // catch. The assertion below that it "passed" is therefore deliberate,
      // not an oversight — it pins the blindness that makes check 5 necessary.
      // Nothing else validated this field: the deploy validator requires only
      // that it be non-empty and not `n/a`.
      const fixture = newFixture();
      fixture.commit("base with no migrations");
      fixture.branch("base-main");

      fixture.addMigration("20990101000000_expand_add_thing");
      fixture.addMigration("20990102000000_contract_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_expand_add_thing"),
        contractRow("20990102000000_contract_drop_thing", "20990101000000_add_thing"),
      ]);
      fixture.commit("the epic adds both halves, and the ledger drops a word");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain(
        "previous_expand_release check FAILED: a ledger row names a release that does not exist.",
      );
      expect(result.stderr).toContain("previous_expand_release : 20990101000000_add_thing");
      // The near-miss is offered, because the fix is almost always a copy-paste.
      expect(result.stderr).toContain("20990101000000_expand_add_thing");
      // The blindness this exists to cover: check 4 saw nothing to compare.
      expect(result.stderr).toContain("Same-release expand/contract check passed");
    },
  );

  it(
    "FAILS a previous_expand_release that is a strict SUBSTRING of a real migration",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      /*
        THE SIBLING VACUITY, and the reason this case exists rather than a fourth
        source assertion. `list_contains_line` matches a whole LINE, using newline
        padding on both sides. Drop that padding — `case "$2" in *"$1"*` — and it
        becomes a SUBSTRING match, which passes every source assertion in this
        file: the helper is still there, both sites still call it, and there is
        still no pipeline.

        The existing check-5 case cannot see the difference either: its ledger
        names `20990101000000_add_thing` against a directory
        `20990101000000_expand_add_thing`, and that is not a substring of it. So
        this case names a strict PREFIX instead —
        `20990101000000_expand_add` against `20990101000000_expand_add_foo` — which
        is exactly the dropped-word shape check 5 exists to catch, and which a
        substring match would silently accept. In check 4 the same degradation
        answers a false YES, which is the SILENT-pass direction: an expand and its
        own contract in one deploy, reported as a pass.
      */
      const fixture = newFixture();
      fixture.commit("base with no migrations");
      fixture.branch("base-main");

      fixture.addMigration("20990101000000_expand_add_foo");
      fixture.addMigration("20990102000000_contract_drop_foo");
      fixture.writeLedger([
        expandRow("20990101000000_expand_add_foo"),
        contractRow(
          "20990102000000_contract_drop_foo",
          // One word short of the real directory name, and a strict prefix of it.
          "20990101000000_expand_add",
        ),
      ]);
      fixture.commit("the ledger drops the last word of the expand's name");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain(
        "previous_expand_release check FAILED: a ledger row names a release that does not exist.",
      );
      expect(result.stderr).toContain(
        "previous_expand_release : 20990101000000_expand_add",
      );
      // The near-miss offered is the real directory, so the fix is a copy-paste.
      expect(result.stderr).toContain("20990101000000_expand_add_foo");
      // And check 4 was blind to the pair, which is what check 5 covers for.
      expect(result.stderr).toContain("Same-release expand/contract check passed");
    },
  );

  it(
    "REFUSES an acknowledgement on a row that does not declare itself windowed",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      // docs/BLUE_GREEN_MIGRATION_POLICY.md says an acknowledged row "is
      // `windowed` by definition, and the pre-existing coverage check then still
      // demands its `rollback.sql`". That was untrue: the rollback demand fires
      // only on a `windowed` declaration, and nothing required one — so an
      // acknowledged row could declare `yes` (asserting the old colour stays
      // compatible, which the acknowledgement itself contradicts) and ship no
      // reverse script at all.
      const fixture = newFixture();
      fixture.commit("base with no migrations");
      fixture.branch("base-main");

      fixture.addMigration("20990101000000_add_thing");
      fixture.addMigration("20990102000000_drop_thing");
      fixture.writeLedger([
        expandRow("20990101000000_add_thing"),
        contractRow(
          "20990102000000_drop_thing",
          "20990101000000_add_thing",
          "SAME-RELEASE EXPAND/CONTRACT ACKNOWLEDGED: owner chose a one-release drop behind an announced window; old app and workers stopped before migrate.",
          "yes",
        ),
      ]);
      fixture.commit("acknowledged, but declared yes and shipping no rollback.sql");

      const result = runGate(fixture, "base-main");

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain(
        "Same-release expand/contract ACKNOWLEDGEMENT REFUSED: only a windowed row may be acknowledged.",
      );
      expect(result.stderr).toContain("old_code_compatible: yes");
      // Not counted as an acknowledgement, so the summary cannot read as a pass.
      expect(result.stderr).not.toContain("(1 acknowledged)");
    },
  );

  it(
    "refuses an unrecognised argument instead of running with the defaults",
    { timeout: MIGRATION_GATE_TIMEOUT_MS },
    () => {
      const result = spawnSync(
        "bash",
        bashGateArgs("scripts/check-migration-safety-coverage.sh", ["--basse", "main"]),
        { cwd: process.cwd(), env: process.env, encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unrecognised argument --basse");
    },
  );
});

/**
 * The membership test both checks depend on, and the pipeline that broke it.
 *
 * Checks 4 and 5 each ask "is this name one of these names". Both used to ask it
 * as `printf '%s\n' "$list" | grep -Fxq -- "$name"`, and that construct answers
 * WRONGLY — "absent" for a name that is present — whenever the payload does not
 * fit in the pipe's buffer: `grep -q` exits at its first match and closes the
 * pipe, `printf` takes EPIPE and dies with 141, and `set -o pipefail` hands that
 * 141 to the `if`. Measured on `debian:bookworm-slim`, needle on the FIRST line:
 * 38 KB of candidates answers FOUND, 208 KB answers `NOT FOUND (status 141)`.
 * The same 208 KB through `list_contains_line` answers FOUND.
 *
 * It is not reproducible on a Windows developer machine — MSYS pipes do not
 * deliver the signal — which is exactly how it reached CI: the committed tree
 * passed locally and failed there, reporting "no such directory X" while listing
 * X two lines later in its own message. So this is a SOURCE contract rather than
 * a behavioural one: a behavioural case would need a fixture larger than the
 * pipe buffer AND could not discriminate on the platform this is written on.
 *
 * Check 5's direction is a loud false failure. Check 4's is the dangerous one:
 * `is_added_on_this_branch` answering a false "no" makes it `continue` past a
 * real expand/contract pair and print a pass.
 */
describe("check-migration-safety-coverage membership test", () => {
  const GATE = "scripts/check-migration-safety-coverage.sh";
  const source = readFileSync(
    path.resolve(process.cwd(), GATE),
    "utf8",
  );

  it("really is the gate script, so the assertions below judge something", () => {
    expect(source).toContain(
      "previous_expand_release check FAILED: a ledger row names a release that does not exist.",
    );
    expect(source).toContain("Same-release expand/contract check FAILED");
    expect(source).toContain("set -Eeuo pipefail");
  });

  it("keeps the membership test a WHOLE-LINE match, not a substring one", () => {
    /*
      Dropping the newline padding is invisible to every other assertion here and
      turns the check into a substring match — which accepts the dropped-word name
      check 5 exists to catch, and makes check 4 answer a false YES over a real
      expand/contract pair. The behavioural half is the strict-prefix fixture in
      the suite above; this is the source half, because the padding is the whole
      of the mechanism and it is one character each side.
    */
    const helper = source.slice(
      source.indexOf("list_contains_line() {"),
      source.indexOf("if [ ! -f "),
    );
    expect(helper.length, "the helper body must be bounded").toBeGreaterThan(120);
    // Both sides padded, on the haystack and inside the pattern.
    const padded = [...helper.matchAll(/\$'\\n'/g)];
    expect(
      padded.length,
      "the haystack and the pattern must each be padded on both sides, so a " +
        "needle can only match a complete line",
    ).toBe(4);
    expect(helper).toContain('case "$haystack" in');
    expect(
      helper,
      "an unpadded `case \"$2\" in *\"$1\"*` is a substring match",
    ).not.toMatch(/case\s+"\$2"\s+in/);
  });

  it("resolves membership without a pipeline, from one shared helper", () => {
    expect(source, `${GATE} must define the pipeline-free membership helper`).toMatch(
      /^list_contains_line\(\) \{$/m,
    );
    // Called by BOTH sites: check 4's `is_added_on_this_branch` and check 5's
    // directory lookup. Two, so a fix applied to one site cannot pass this.
    const calls = [...source.matchAll(/^\s*(?:if )?list_contains_line /gm)];
    expect(
      calls.length,
      "both membership sites must go through the helper",
    ).toBeGreaterThanOrEqual(2);
  });

  it("never pipes into a short-circuiting grep again", () => {
    /*
      Comments are stripped first: this file's own explanation of the defect
      spells the defective construct, and a census that matched its own
      documentation would be unfixable.
    */
    const code = source
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    // Anti-vacuity: stripping comments left the executable body intact.
    expect(code).toContain("list_contains_line() {");
    expect(code.length, "the stripped body must still be the script").toBeGreaterThan(
      4000,
    );
    expect(
      code,
      "A pipe into `grep -q` (or any short-circuiting reader) loses the writer's " +
        "exit status to EPIPE under `set -o pipefail`, and answers \"absent\" for a " +
        "line that is present. Use list_contains_line, or read the payload from a " +
        "file rather than a pipe.",
    ).not.toMatch(/\|\s*grep\s+(?:-[A-Za-z]*\s+)*-[A-Za-z]*q/);
  });
});
