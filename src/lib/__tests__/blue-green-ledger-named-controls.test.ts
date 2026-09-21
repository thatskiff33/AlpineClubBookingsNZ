import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MIGRATION_LOCK_TIMEOUT_CEILING_MS,
  MIGRATION_LOCK_TIMEOUT_ENV_VAR,
  readMigrateServiceLockTimeout,
} from "./helpers/migration-lock-timeout-config";

/**
 * A safety-ledger row may not name a control this repository does not
 * implement (#3377).
 *
 * ## What went wrong, so the shape of the guard makes sense
 *
 * `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` is the artifact an operator reads
 * before a production deploy to learn what each pending migration will do and
 * what protects them if it goes wrong. Eighty of its rows ended their
 * lock-impact plan with some form of "let the deploy guard stop on lock
 * timeout" — the named mitigation for the worst case a schema migration has,
 * an `ALTER TABLE` queueing for ACCESS EXCLUSIVE behind a long transaction and
 * putting every later reader of a hot table in the queue behind it.
 *
 * No such guard existed. `lock_timeout` was set at no level, so it resolved to
 * `0` — wait forever. The convention had been copied from row to row for
 * months, and nothing anywhere could notice, because no check connected what
 * the ledger SAYS to what the repository DOES.
 *
 * That is worse than saying nothing. An operator who reads "the deploy guard
 * will stop this" plans for a deploy that fails cleanly; what they actually
 * had was an outage that ends when somebody notices.
 *
 * ## The guard
 *
 * A registry of the controls a lock-impact plan is allowed to name, each paired
 * with the evidence that the repository implements it. If any row names a
 * control, that evidence must hold. Adding a control to the ledger's vocabulary
 * means adding a row here with something real to point at — which is the point:
 * the cost of writing a promise into the ledger is proving it.
 *
 * The registry is deliberately not a closed vocabulary over the whole
 * lock-impact prose. Those cells are long-form English about specific
 * migrations, and a closed word list over them would be almost entirely
 * exemptions. It covers the named, repository-wide MITIGATIONS — the sentences
 * that promise a mechanism rather than describing a migration.
 */

const LEDGER_PATH = "docs/BLUE_GREEN_MIGRATION_SAFETY.tsv";

function readRepoFile(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), "utf8");
}

/** Data rows only: the ledger's header and its explanatory `#` lines are not claims. */
function ledgerDataRows(): string[] {
  return readRepoFile(LEDGER_PATH)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
}

interface NamedControl {
  /** What the ledger calls it, for the failure message. */
  readonly name: string;
  /** Does this row name the control? */
  readonly namedBy: (row: string) => boolean;
  /**
   * The evidence that the repository implements it, or a sentence saying what
   * is missing. Returning a string FAILS the check.
   */
  readonly missingImplementation: () => string | null;
}

const NAMED_CONTROLS: readonly NamedControl[] = [
  {
    name: "the deploy guard's lock timeout",
    // Every phrasing in use: "stop on lock timeout", "stop on lock
    // timeout/failure", "the deploy guard's lock timeout is the backstop",
    // "rely on the deploy guard/lock timeout". They all promise one mechanism.
    namedBy: (row) => /lock[ _-]timeout/i.test(row),
    missingImplementation: () => {
      let wiring: ReturnType<typeof readMigrateServiceLockTimeout>;
      try {
        wiring = readMigrateServiceLockTimeout();
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      if (!wiring.serviceRunsMigrateDeploy) {
        return "the compose service carrying the lock timeout no longer runs `prisma migrate deploy`, so the bound is no longer where migrations run";
      }
      if (!/lock_timeout=\d+/.test(wiring.optionsParameter)) {
        return `the migrate service's libpq options do not set lock_timeout (got: ${wiring.optionsParameter})`;
      }
      if (!(wiring.defaultMs > 0)) {
        return `the shipped lock_timeout default is ${wiring.defaultMs}, and PostgreSQL reads 0 as "wait forever" rather than as unset — the guard would be absent`;
      }
      if (wiring.defaultMs >= MIGRATION_LOCK_TIMEOUT_CEILING_MS) {
        return `the shipped lock_timeout default (${wiring.defaultMs}ms) is at or past the web slots' pool_timeout (${MIGRATION_LOCK_TIMEOUT_CEILING_MS}ms), by which point a blocked table is already refusing member requests — the guard could not fire in time to prevent anything`;
      }
      return null;
    },
  },
];

describe("a safety-ledger row may not name a control the repository does not implement (#3377)", () => {
  const rows = ledgerDataRows();

  it.each(NAMED_CONTROLS.map((control) => [control.name, control] as const))(
    "%s",
    (_name, control) => {
      const naming = rows.filter((row) => control.namedBy(row));
      if (naming.length === 0) {
        return;
      }

      const missing = control.missingImplementation();
      expect(
        missing,
        `${naming.length} row(s) in ${LEDGER_PATH} promise an operator "${control.name}", but ${missing}. ` +
          "Either restore the control or rewrite every one of those rows — a mitigation named in the artifact an operator " +
          "reads before a deploy is worse than no mitigation, because it stops them planning for the case (#3377).",
      ).toBeNull();
    },
  );

  it("still finds the rows it is checking", () => {
    // Without this the check above is vacuous the moment the detector stops
    // matching: zero naming rows means zero assertions, and the suite goes
    // green while the ledger is full of unbacked promises. A FLOOR rather than
    // a census — the exact count moves whenever a lane appends a row, and
    // pinning it would red every unrelated migration PR.
    const naming = rows.filter((row) => NAMED_CONTROLS[0].namedBy(row));
    expect(
      naming.length,
      `Only ${naming.length} of ${rows.length} ledger rows matched the lock-timeout detector. ` +
        "80 did when #3377 shipped, so a number this low means the detector has gone blind, not that the ledger changed.",
    ).toBeGreaterThanOrEqual(60);
  });
});

describe("the migration lock timeout stays wired end to end (#3377)", () => {
  it("names its override variable in the operator documentation", () => {
    // The ledger's promise is only actionable if an operator can find the knob
    // and the recovery. Both are named where they look.
    expect(readRepoFile("CONFIGURATION.md")).toContain(MIGRATION_LOCK_TIMEOUT_ENV_VAR);
    expect(readRepoFile("docs/PRODUCTION_UPGRADE_RUNBOOK.md")).toContain(
      "migrate resolve --rolled-back",
    );
  });

  it("is refused by the deploy script before anything is pulled or built", () => {
    const script = readRepoFile("scripts/run-production-blue-green-deploy.sh");
    expect(script).toContain("validate_migration_lock_timeout_contract");
    // Step 3 is the environment-contract step; the migrate itself is step 13.
    // A check that ran at the point of use would stop the deploy after the
    // images were pulled, which is the expensive half.
    const validator = script.indexOf("validate_migration_lock_timeout_contract\n");
    const migrateStep = script.indexOf('step "13/20" "Running Prisma migrations"');
    expect(validator).toBeGreaterThan(0);
    expect(migrateStep).toBeGreaterThan(validator);
  });

  it("keeps the real-PostgreSQL proof reachable from the CI harness", () => {
    // The behavioural half of this guard lives in a suite that is
    // `describe.skip` without the race flag, so CI reaches it only through this
    // import. Unplug the import and the proof silently becomes a no-op.
    const harness = readRepoFile("src/lib/__tests__/concurrency-lock-races.realdb.test.ts");
    expect(harness).toContain('import "./migration-lock-timeout.realdb.test";');
    expect(readRepoFile(".github/workflows/ci.yml")).toContain(
      "npx vitest run src/lib/__tests__/concurrency-lock-races.realdb.test.ts",
    );
  });

  it("does not leave the concurrency guide saying no lock_timeout is set", () => {
    // The sentence that became false. It is load-bearing: the member-merge
    // bound's docblock reasons from it when it explains why restoring `DEFAULT`
    // rather than `0` is currently a no-op.
    // Whitespace-collapsed before matching: the sentence is prose and a
    // re-wrap would otherwise make this assertion pass vacuously, which on a
    // `not.toContain` is invisible.
    const guide = readRepoFile("docs/CONCURRENCY_AND_LOCKING.md").replace(/\s+/g, " ");
    expect(guide).not.toContain(
      "Nothing in this repository sets `lock_timeout` at any level today",
    );
    expect(guide).toContain(MIGRATION_LOCK_TIMEOUT_ENV_VAR);
  });
});
