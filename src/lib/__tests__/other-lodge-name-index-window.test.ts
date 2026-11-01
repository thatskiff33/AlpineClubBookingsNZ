import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { bashGateArgs } from "./helpers/bash-fixture-path";
import { MIGRATION_GATE_TIMEOUT_MS } from "./helpers/migration-gate-timeouts";

/**
 * The other-lodge name-index transition is a WINDOWED migration pair (#4262;
 * owner decision 24 Oct 2026: the enforced maintenance-window repair).
 *
 * `20261126040000_other_lodge_hidden_at` drops the full unique index on
 * `OtherLodge.name`, which the previous release's download upsert needs for its
 * `ON CONFLICT ("name")`; `20261126050000_other_lodge_names_not_unique` then
 * drops the last uniqueness on the name that release's owned-by-name readers
 * rely on. Neither matches a breaking-SQL pattern (a `DROP INDEX` is not one),
 * so the ledger's `windowed` declaration is the ONLY thing that makes the
 * deploy stop and demand the window. These tests drive the real validator over
 * the real migration files and the real ledger, so a row quietly put back to
 * `yes` fails here.
 *
 * The real-PostgreSQL half (the old upsert refused, each reverse script's
 * duplicate-name refusal, the reverse order) is
 * `other-lodge-name-index-window.realdb.test.ts`.
 */

const REPO_ROOT = process.cwd();
const VALIDATOR = "scripts/validate-blue-green-migrations.sh";
const PAIR = [
  "20261126040000_other_lodge_hidden_at",
  "20261126050000_other_lodge_names_not_unique",
] as const;
const files = PAIR.map((name) => `prisma/migrations/${name}/migration.sql`);
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), "utf8");

function validate(env: Record<string, string>, args: string[] = files) {
  const result = spawnSync("bash", bashGateArgs(VALIDATOR, args, env), {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const NO_OVERRIDE = {
  ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "0",
  BLUE_GREEN_MIGRATION_OVERRIDE_REASON: "",
  BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED: "0",
};
const OVERRIDE = {
  ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
  BLUE_GREEN_MIGRATION_OVERRIDE_REASON: "#4262 other-lodge name index window",
};

describe("the other-lodge name-index pair is windowed (#4262)", () => {
  it("declares both rows windowed in the ledger, with the window and the reverse order written down", () => {
    const rows = read("docs/BLUE_GREEN_MIGRATION_SAFETY.tsv").split(/\r?\n/);
    for (const name of PAIR) {
      const row = rows.find((line) => line.startsWith(`${name}\t`));
      expect(row, `${name} has no ledger row`).toBeDefined();
      const [, , , compatible, plan] = row!.split("\t");
      expect(compatible, `${name} must be windowed (#4262)`).toBe("windowed");
      for (const fragment of [
        "ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1",
        "BLUE_GREEN_MIGRATION_OVERRIDE_REASON",
        "BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1",
        "verify_windowed_migration_runtime_drained",
        "MIXED OLD-RUNTIME/NEW-SCHEMA TRAFFIC IS A STOP CONDITION",
        "REVERSE: rollback.sql",
      ]) {
        expect(plan, `${name}: ${fragment}`).toContain(fragment);
      }
    }
  });

  it(
    "is refused by the ordinary deploy path: no override means no migrate",
    () => {
      const run = validate(NO_OVERRIDE);
      expect(run.status, run.output).not.toBe(0);
      for (const file of files) {
        expect(run.output).toContain(
          `Ledger declares this migration windowed (old colour NOT kept compatible; deploy-window only): ${file}`,
        );
      }
    },
    MIGRATION_GATE_TIMEOUT_MS,
  );

  it(
    "is still refused with the override until the old app and workers are acknowledged stopped",
    () => {
      const run = validate({ ...OVERRIDE, BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED: "0" });
      expect(run.status, run.output).not.toBe(0);
      expect(run.output).toContain(
        "Pending windowed migrations cannot run until the old app and every old worker are stopped.",
      );
    },
    MIGRATION_GATE_TIMEOUT_MS,
  );

  it(
    "passes only with the override, its reason and the stopped-runtime acknowledgement, and reports the window to the deploy",
    () => {
      const run = validate({ ...OVERRIDE, BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED: "1" }, [
        "--report-windowed",
        ...files,
      ]);
      expect(run.status, run.output).toBe(0);
      // The deploy engine reads this line to run its drained-runtime checks.
      expect(run.stdout.trim().split("\n").at(-1)).toBe("1");
    },
    MIGRATION_GATE_TIMEOUT_MS,
  );

  it("ships each reverse script as one transaction that refuses duplicate names before any DDL", () => {
    const cases = [
      { name: PAIR[1], code: "other_lodge_names_rollback_blocked", firstDdl: 'DROP INDEX "OtherLodge_name_idx"' },
      { name: PAIR[0], code: "other_lodge_hidden_rollback_blocked", firstDdl: 'DROP INDEX "OtherLodge_name_visible_key"' },
    ];
    for (const { name, code, firstDdl } of cases) {
      const sql = read(`prisma/migrations/${name}/rollback.sql`);
      const body = sql.replace(/^--.*$/gm, "").trim();
      expect(body.startsWith("BEGIN;"), `${name}: one transaction`).toBe(true);
      expect(body.endsWith("COMMIT;"), `${name}: one transaction`).toBe(true);
      const refusal = body.indexOf(`RAISE EXCEPTION '${code}:`);
      expect(refusal, `${name}: names its refusal`).toBeGreaterThan(0);
      expect(body.indexOf(firstDdl), `${name}: refuses before it changes anything`).toBeGreaterThan(refusal);
      // No IF EXISTS: run out of order, the script must stop, not skip.
      expect(body).not.toMatch(/(INDEX|COLUMN)\s+IF\s+EXISTS/i);
      expect(sql).toContain("Step 1:");
      expect(sql).toContain("ORDER: newest first.");
    }
  });

  it("keeps its real-PostgreSQL proof wired into the race harness CI runs", () => {
    expect(read("src/lib/__tests__/concurrency-lock-races.realdb.test.ts")).toContain(
      'import "./other-lodge-name-index-window.realdb.test";',
    );
    const suite = read("src/lib/__tests__/other-lodge-name-index-window.realdb.test.ts");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    for (const scenario of [
      "refuses the previous release's name-keyed upsert once the pair is applied",
      "refuses each reverse script while lodges share a name, changing nothing",
      "stops the older reverse script when it runs first, and reverses the pair newest first after renaming",
    ]) {
      expect(suite).toContain(`it("${scenario}"`);
    }
  });

  // The fork applied both files before the windowed correction, and Prisma
  // records each applied file's checksum (`migrate dev` compares it), so the
  // files stay byte-identical to what was applied. The correction lives in the
  // ledger rows and rollback.sql, which nothing checksums; the rows say their
  // header comment is superseded.
  it("leaves each applied migration.sql byte-identical, with the correction in its ledger row", () => {
    const APPLIED_SHA256: Record<(typeof PAIR)[number], string> = {
      "20261126040000_other_lodge_hidden_at": "48e00d266f674f36a856e5d4c145fc609687c1f2b2ad593cb72c72c8a5c24ab6",
      "20261126050000_other_lodge_names_not_unique": "1195dae711e8d47b22e0230cf61b1628d2df9bfca15b96cd5c752d0103309c6a",
    };
    const rows = read("docs/BLUE_GREEN_MIGRATION_SAFETY.tsv").split(/\r?\n/);
    for (const name of PAIR) {
      const bytes = readFileSync(path.join(REPO_ROOT, `prisma/migrations/${name}/migration.sql`));
      expect(createHash("sha256").update(bytes).digest("hex"), `${name}/migration.sql changed`).toBe(APPLIED_SHA256[name]);
      const plan = rows.find((line) => line.startsWith(`${name}\t`))!.split("\t")[4];
      expect(plan).toContain("THIS ROW SUPERSEDES the migration's header comment");
    }
  });
});
