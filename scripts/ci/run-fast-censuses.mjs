#!/usr/bin/env node
/**
 * The fast tree-wide censuses, run against whatever tree is checked out (#3513).
 *
 * `pnpm run ci:fast-censuses`                 run them all
 * `pnpm run ci:fast-censuses --base <ref>`    judge the file-size ratchet against <ref>
 * `pnpm run ci:fast-censuses --summary <f>`   also write {ok, failed[]} as JSON to <f>
 *
 * WHAT THIS IS FOR. A census pins how many call sites of some shape exist
 * across the whole tree (`docs/TESTING.md` → "Census tests and the merge
 * hazard"). Two branches can each be green against their own base and still
 * compose into a red tree, because each re-measured the count against a base
 * that is no longer the base. It has happened on every kind of merge this
 * repository does:
 *
 * - an epic sync: `.github/workflows/epic-branch-sync.yml` arms auto-merge on
 *   a `main` -> `epic/**` pull request, and the epic branch carries no branch
 *   protection, so the composed tree used to land before any check had run on
 *   it. The epic found out on its next push;
 * - ordinary pull requests into `main` (20 Sep 2026): #3526 published the
 *   `stripComments` importer count as 92 against the base it branched from,
 *   `main` moved underneath it, and it plus #3520 and #3522 merged three green
 *   pull requests into a red `main` (fixed forward in #3534). Branch protection
 *   runs `strict: false`, so nothing re-tested against the merged base.
 *
 * Every one of these suites reads source from DISK, so `pnpm run test:related`
 * can never select them from a diff — the class `AGENTS.md` leaves to CI. This
 * script is the cheap answer the owner chose on #3513 ("Cheap narrow check"):
 * run only those, on the composed tree, in well under a minute, rather than a
 * full CI cycle. The sync workflow runs it before it arms auto-merge; a lane
 * runs it locally after merging `origin/main` into its branch and before it
 * pushes or flips a pull request ready. It is NOT a required check and must not
 * become one through this file.
 *
 * WHY THESE SUITES. Chosen from evidence, not memory: each is a disk-reading
 * census or contract that commits titled "re-measure … after the main merge /
 * on the composed tree / after the epic sync" have had to correct, ranked by
 * how often (the booking-owner census alone, eighty-nine times between 15 Aug
 * and 6 Oct 2026), plus the suite behind the 20 Sep incident. Two such suites
 * are deliberately LEFT OUT: `client-server-boundary-census` and
 * `in-progress-edit-sold-price-census` are the two `docs/TESTING.md` lists as
 * timing out under load and passing alone, and a gate that red-lights on load
 * would teach everyone to ignore it. Add a suite here when a composition has
 * broken it; this list is the one home of the set (INV-SSOT).
 *
 * WHAT IT DOES NOT DO. It does not replace `verify` or the full suite, it does
 * not select censuses for a particular diff (`docs/TESTING.md` → "Selecting
 * the censuses a change can reach" still governs that), and it reads no
 * database, network or provider: the environment below is inert, and the
 * Prisma client it generates is never connected.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The disk-reading suites, each with the reason it is here. Paths are relative
 * to the repository root; `run-fast-censuses.test.mjs` fails on one that does
 * not exist, so a rename cannot silently shrink the set.
 */
export const FAST_CENSUS_SUITES = [
  {
    path: "src/lib/__tests__/booking-owner-census.test.ts",
    why: "pins every booking-owner read by line; re-measured after almost every main merge",
  },
  {
    path: "src/lib/__tests__/audit-writer-census.test.ts",
    why: "the audit-writer site totals, also quoted in docs and diagnostics packs",
  },
  {
    path: "src/lib/__tests__/bed-allocation-audit-category-backfill.test.ts",
    why: "re-states the audit-writer census figures against its migration",
  },
  {
    path: "src/components/admin/__tests__/view-only-banner-contract.test.ts",
    why: "the view-only banner call-site counts published in ARCHITECTURE.md",
  },
  {
    path: "src/lib/__tests__/advisory-lock-guard.test.ts",
    why: "the registered advisory-lock site inventory (INV-LOCK-003)",
  },
  {
    path: "src/lib/__tests__/club-time-escape-hatch-census.test.ts",
    why: "the counted club-time escape hatches",
  },
  {
    path: "src/lib/__tests__/club-time-boundary-guard.test.ts",
    why: "club-time boundary allowlist across src/",
  },
  {
    path: "src/lib/__tests__/e2e-club-day-census.test.ts",
    why: "the counted clock reads under e2e/",
  },
  {
    path: "src/lib/__tests__/ssot-comment-stripper-guard.test.ts",
    why: "the stripComments importer count — the 20 Sep 2026 red main (#3526, #3534)",
  },
  {
    path: "src/lib/__tests__/credential-actor-census.test.ts",
    why: "the credential-actor site census",
  },
  {
    path: "src/lib/__tests__/admin-route-area-matrix.test.ts",
    why: "every admin route area matched against the coverage matrix",
  },
  {
    path: "src/lib/__tests__/booking-guest-night-price-source-census.test.ts",
    why: "the guest-night price-source call sites",
  },
  {
    path: "src/lib/__tests__/lock-bound-club-zone-outside-transaction.test.ts",
    why: "club-zone reads that must stay outside a lock-bound transaction",
  },
  {
    path: "src/lib/__tests__/reshaped-club-day-seams-contract.test.ts",
    why: "the reshaped club-day seams and their counted callers",
  },
];

/**
 * The tree-wide checks that are scripts rather than suites. Both read git and
 * the working tree only. Each is run exactly as its `package.json` script runs
 * it; the `pnpm run` name is what a failure reports.
 */
export const FAST_CENSUS_COMMANDS = [
  {
    name: "docs:indexcheck",
    runner: "node",
    script: "scripts/ci/check-doc-index-integrity.mjs",
    why: "invariant ids, index rows, word budgets and doc reachability",
  },
  {
    name: "quality:budget",
    runner: "tsx",
    script: "scripts/ci/check-file-size-budget.ts",
    acceptsBase: true,
    why: "the file-size ratchet and size-allowances.d/ ceilings",
  },
];

/**
 * Inert values for the variables these suites need merely to IMPORT modules
 * that construct a Prisma client or read auth configuration. Nothing connects
 * to the database URL. A variable already set in the environment wins, so a
 * lane's own `.env`-loaded values are left alone.
 */
export const INERT_TEST_ENV = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/tacbookings",
  AUTH_SECRET: "ci-auth-secret",
  NEXTAUTH_SECRET: "ci-auth-secret",
  NEXTAUTH_URL: "http://localhost:3000",
  AUTH_TRUST_HOST: "false",
  CRON_SECRET: "ci-cron-secret",
};

function binOf(packageName, binName = packageName) {
  const pkgPath = require.resolve(`${packageName}/package.json`, { paths: [REPO_ROOT] });
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin[binName];
  return path.join(path.dirname(pkgPath), rel);
}

/**
 * Spawn with `process.execPath` and a resolved bin rather than `pnpm` or a
 * `.cmd` shim, for the Windows reason `scripts/run-named-tests.mjs` records.
 */
function run(args, env) {
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env,
    stdio: "inherit",
  });
  return result.status === 0;
}

export function parseArgs(argv) {
  const options = { base: undefined, summary: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base" || arg === "--summary") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Which listed suites did not pass, read from vitest's JSON report. A suite
 * MISSING from the report counts as failed: vitest silently drops a named path
 * that matches nothing (#3120), and a census that did not run has not passed.
 */
export function failedSuites(report, suitePaths, repoRoot = REPO_ROOT) {
  const statusByPath = new Map();
  for (const result of report?.testResults ?? []) {
    statusByPath.set(path.relative(repoRoot, result.name).split(path.sep).join("/"), result.status);
  }
  return suitePaths.filter((suitePath) => statusByPath.get(suitePath) !== "passed");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = { ...INERT_TEST_ENV, ...process.env };
  const failed = [];

  const missing = FAST_CENSUS_SUITES.map((s) => s.path).filter(
    (p) => !existsSync(path.join(REPO_ROOT, p)),
  );
  for (const p of missing) failed.push(`${p} (listed in run-fast-censuses.mjs but absent)`);

  // A stale generated client type-checks and imports clean while CI fails
  // (AGENTS.md → "Validation traps"), so regenerate rather than trust it.
  if (!run([binOf("prisma"), "generate"], env)) failed.push("prisma generate");

  const present = FAST_CENSUS_SUITES.map((s) => s.path).filter((p) => !missing.includes(p));
  const scratch = mkdtempSync(path.join(os.tmpdir(), "fast-censuses-"));
  try {
    const reportPath = path.join(scratch, "vitest.json");
    run(
      [
        binOf("vitest"),
        "run",
        ...present,
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${reportPath}`,
      ],
      env,
    );
    const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null;
    failed.push(...failedSuites(report, present));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  for (const command of FAST_CENSUS_COMMANDS) {
    const args = command.runner === "tsx" ? [binOf("tsx"), command.script] : [command.script];
    if (command.acceptsBase && options.base) args.push("--base", options.base);
    if (!run(args, env)) failed.push(command.name);
  }

  const ok = failed.length === 0;
  if (options.summary) writeFileSync(options.summary, `${JSON.stringify({ ok, failed })}\n`);

  process.stdout.write("\n== Fast tree-wide censuses (#3513) ==\n");
  if (ok) {
    process.stdout.write(
      `All ${FAST_CENSUS_SUITES.length} census suites and ${FAST_CENSUS_COMMANDS.length} tree-wide checks passed.\n`,
    );
  } else {
    process.stdout.write("FAILED:\n");
    for (const name of failed) process.stdout.write(`  - ${name}\n`);
    process.stdout.write(
      "Re-derive each count against this tree; never increment it (docs/TESTING.md → " +
        '"Census tests and the merge hazard").\n',
    );
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
