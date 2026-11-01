import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { bashFixturePath, bashGateArgs } from "@/lib/__tests__/helpers/bash-fixture-path";
import { readRepoFile } from "@/lib/__tests__/helpers/compose";
import { DEPLOY_SCRIPT, shellFunctionSource } from "@/lib/__tests__/helpers/deploy-script";

/**
 * The #3413 gate variables reach the app containers from `.env` alone (#4027).
 *
 * #3964 passed `PENDING_SCHOOL_ADULTS_ENABLED` and
 * `BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED` through `docker-compose.yml` to every
 * app colour, and Compose prefers a value exported in the invoking shell over
 * `.env`. A windowed deploy is run with `BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1`
 * exported for the migration validator, so the new colour and the cron leader
 * started with it set, and with `PENDING_SCHOOL_ADULTS_ENABLED=1` already in
 * `.env` the admissions gate opened with nobody deciding to.
 *
 * The fix, proved here by RUNNING the deploy script's own lines under a stub
 * `docker` that is a real child process and reports the environment it was
 * given:
 *
 * - `BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED` stays in the deploy shell, where
 *   the validator still receives it, and leaves every child's environment
 *   (`export -n`). Not refused on disagreement: the shell and `.env` copies
 *   legitimately differ on every windowed deploy that is not #3413's activation.
 * - `PENDING_SCHOOL_ADULTS_ENABLED` exported in the shell is refused when it
 *   differs from what Compose would read from `.env` (Part 1's grammar, #4026),
 *   and unset once they agree — the `APP_ENVIRONMENT_ROLE` treatment.
 *
 * `test:related` cannot select this file: it reads the shell script from disk,
 * so it has no import edge to it (`docs/TESTING.md`).
 */

const SCRIPT = readRepoFile(DEPLOY_SCRIPT);
const STOPPED = "BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED";
const PENDING = "PENDING_SCHOOL_ADULTS_ENABLED";
const STOPPED_DEFAULT = `${STOPPED}="\${${STOPPED}:-0}"`;
const STOPPED_UNEXPORT = `export -n ${STOPPED}`;

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "gate-env-shell-precedence-"));
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

/** A script line, exactly, asserted present once. */
function exactLine(line: string): string {
  const occurrences = SCRIPT.split("\n").filter((candidate) => candidate === line);
  expect(occurrences.length, `the deploy script must carry \`${line}\` exactly once`).toBe(1);
  return line;
}

/**
 * A stub `docker` on PATH: a separate process, so it sees only what was
 * EXPORTED to it, which is exactly what `docker compose` interpolates from.
 */
function writeDockerStub(dir: string): string {
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const stub = path.join(bin, "docker");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      `printf 'DOCKER %s ${STOPPED}=%s ${PENDING}=%s\\n' "$*" "\${${STOPPED}-UNSET}" "\${${PENDING}-UNSET}"`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(stub, 0o755);
  return bin;
}

type Shell = { set: false } | { set: true; value: string };

function run(harnessLines: string[], options: { stopped?: Shell; pending?: Shell; envFile?: string }) {
  const dir = mkdtempSync(path.join(fixtureRoot, "case-"));
  const bin = writeDockerStub(dir);
  writeFileSync(path.join(dir, ".env"), options.envFile ?? "", "utf8");
  // The validator the deploy runs, stubbed to report what it was handed.
  mkdirSync(path.join(dir, "scripts"));
  const validator = path.join(dir, "scripts", "validate-blue-green-migrations.sh");
  writeFileSync(
    validator,
    `#!/usr/bin/env bash\nprintf 'VALIDATOR ${STOPPED}=%s\\n' "\${${STOPPED}-UNSET}" >&2\nprintf '0\\n'\n`,
    "utf8",
  );
  chmodSync(validator, 0o755);

  const exportLine = (name: string, shell: Shell | undefined) =>
    shell?.set ? `export ${name}="$SHELL_${name}"` : `unset ${name}`;
  const harness = path.join(dir, "harness.sh");
  writeFileSync(
    harness,
    [
      "set -Eeuo pipefail",
      'cd "$CASE_DIR"',
      'PATH="$STUB_BIN:$PATH"',
      // The operator's shell, as the deploy inherits it.
      exportLine(STOPPED, options.stopped),
      exportLine(PENDING, options.pending),
      ...harnessLines,
      "",
    ].join("\n"),
    "utf8",
  );
  const result = spawnSync(
    "bash",
    bashGateArgs(bashFixturePath(harness), [], {
      CASE_DIR: bashFixturePath(dir),
      STUB_BIN: bashFixturePath(bin),
      [`SHELL_${STOPPED}`]: options.stopped?.set ? options.stopped.value : "",
      [`SHELL_${PENDING}`]: options.pending?.set ? options.pending.value : "",
    }),
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe(`${STOPPED} stays the validator's, never the containers' (#4027)`, () => {
  // Built per test, from the script's own lines, so a removed or reworded line
  // fails every case below rather than one.
  const harness = () => [
    exactLine(STOPPED_DEFAULT),
    exactLine(STOPPED_UNEXPORT),
    'info() { printf "%s\\n" "$1"; }',
    "list_pending_migration_sql_files() { echo prisma/migrations/20990101000000_x/migration.sql; }",
    'ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1',
    'BLUE_GREEN_MIGRATION_OVERRIDE_REASON="window"',
    'MIGRATION_SAFETY_LEDGER=ledger.tsv',
    shellFunctionSource(SCRIPT, "validate_pending_migrations_blue_green_safe"),
    "validate_pending_migrations_blue_green_safe",
    "docker compose up -d --force-recreate app_green",
    "docker compose up -d --force-recreate app",
    `printf 'SHELL ${STOPPED}=%s\\n' "$${STOPPED}"`,
  ];

  it("lifts the script's own default and unexport, in that order", () => {
    const lines = SCRIPT.split("\n");
    const defaultAt = lines.indexOf(exactLine(STOPPED_DEFAULT));
    const unexportAt = lines.indexOf(exactLine(STOPPED_UNEXPORT));
    expect(unexportAt).toBeGreaterThan(defaultAt);
    // Nothing but its own comment between them, so no child is started while it
    // is still exported.
    for (const line of lines.slice(defaultAt + 1, unexportAt)) {
      expect(line.startsWith("#"), `unexpected line before the unexport: ${line}`).toBe(true);
    }
    // And it runs in the inner deploy's preamble, before any line that runs
    // `docker compose` (comments aside).
    const inner = lines.indexOf("run_internal_blue_green_deploy() {");
    expect(inner).toBeGreaterThan(0);
    expect(unexportAt).toBeGreaterThan(inner);
    const firstCompose = lines.findIndex(
      (line, index) =>
        index > inner && !line.trim().startsWith("#") && line.includes("docker compose"),
    );
    expect(firstCompose).toBeGreaterThan(unexportAt);
    // Nothing re-exports it later.
    expect(SCRIPT).not.toMatch(new RegExp(`^\\s*(export|declare -x)\\s+${STOPPED}\\b`, "m"));
  });

  it("hands the validator the shell's 1, and the containers nothing", () => {
    const result = run(harness(), { stopped: { set: true, value: "1" } });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(`VALIDATOR ${STOPPED}=1`);
    expect(result.stdout).toContain(`SHELL ${STOPPED}=1`);
    const dockerLines = result.stdout.split("\n").filter((line) => line.startsWith("DOCKER "));
    expect(dockerLines).toHaveLength(2);
    for (const line of dockerLines) expect(line).toContain(`${STOPPED}=UNSET`);
  });

  it("still defaults the validator to 0 when the shell never set it", () => {
    const result = run(harness(), { stopped: { set: false } });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain(`VALIDATOR ${STOPPED}=0`);
    expect(result.stdout).toContain(`DOCKER compose up -d --force-recreate app ${STOPPED}=UNSET`);
  });
});

describe(`${PENDING} exported in the shell must agree with .env (#4027)`, () => {
  const harness = [
    ...[
      "trim_whitespace",
      "printable_deploy_value",
      "env_assignment_pattern",
      "strip_matching_quotes",
      "compose_env_file_value",
      "require_exported_value_matches_env_file",
    ].map((name) => shellFunctionSource(SCRIPT, name)),
    `require_exported_value_matches_env_file ${PENDING}`,
    "docker compose up -d app_green",
  ];

  it("is checked in validate_env_contract, the step-3 preflight", () => {
    const body = shellFunctionSource(SCRIPT, "validate_env_contract");
    const calls = body
      .split("\n")
      .filter((line) => line === `  require_exported_value_matches_env_file ${PENDING}`);
    expect(calls).toHaveLength(1);
    expect(body.indexOf(calls[0])).toBeGreaterThan(
      body.indexOf("  require_environment_role_env_key\n"),
    );
  });

  it.each([
    ["the shell is silent", { set: false } as Shell, `${PENDING}=1\n`],
    ["both say 1", { set: true, value: "1" } as Shell, `${PENDING}=1\n`],
    ["both are empty", { set: true, value: "" } as Shell, "OTHER=1\n"],
    [
      ".env says 1 in an export-prefixed, quoted form",
      { set: true, value: "1" } as Shell,
      `export ${PENDING}="1"\n`,
    ],
    ["the .env colon form agrees", { set: true, value: "1" } as Shell, `${PENDING}: 1\n`],
  ])("deploys when %s, and Compose reads .env alone", (_label, pending, envFile) => {
    const result = run(harness, { pending, envFile });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`DOCKER compose up -d app_green`);
    expect(result.stdout).toContain(`${PENDING}=UNSET`);
  });

  it.each([
    ["the shell says 1 and .env is silent", "1", "OTHER=1\n", "1", ""],
    ["the shell says 1 and .env says 0", "1", `${PENDING}=0\n`, "1", "0"],
    ["the shell is empty and .env says 1", "", `${PENDING}=1\n`, "", "1"],
    ["the shell has a leading space", " 1", `${PENDING}=1\n`, " 1", "1"],
    ["a later colon line in .env says 0", "1", `${PENDING}=1\n${PENDING}: 0\n`, "1", "0"],
    ["the shell says true", "true", `${PENDING}=1\n`, "true", "1"],
  ])("refuses when %s, naming both values", (_label, shell, envFile, named, inFile) => {
    const result = run(harness, { pending: { set: true, value: shell }, envFile });
    expect(result.code).not.toBe(0);
    // No container was started.
    expect(result.stdout).not.toContain("DOCKER");
    expect(result.stderr).toContain(`${PENDING} disagrees between this shell and .env`);
    expect(result.stderr).toContain(`exported in this shell: '${named}'`);
    expect(result.stderr).toContain(`in .env:                '${inFile}'`);
    expect(result.stderr).toContain(`unset ${PENDING}`);
  });

  it("sanitizes the shell value before echoing it at a terminal", () => {
    const result = run(harness, {
      pending: { set: true, value: "1\u001b[2J" },
      envFile: `${PENDING}=1\n`,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toContain("\u001b");
    expect(result.stderr).toContain("exported in this shell: '1?[2J'");
  });
});

describe(`a shell ${STOPPED}=1 that .env lacks is called out at step 3 (#4027)`, () => {
  const NOTE = "note_shell_stopped_ack_is_validator_only";
  const harness = () => [
    exactLine(STOPPED_DEFAULT),
    exactLine(STOPPED_UNEXPORT),
    'info() { printf "INFO %s\\n" "$1"; }',
    ...[
      "trim_whitespace",
      "printable_deploy_value",
      "env_assignment_pattern",
      "strip_matching_quotes",
      "compose_env_file_value",
      NOTE,
    ].map((name) => shellFunctionSource(SCRIPT, name)),
    NOTE,
    "echo DONE",
  ];

  it("is called from validate_env_contract, after the PENDING check", () => {
    const body = shellFunctionSource(SCRIPT, "validate_env_contract");
    const calls = body.split("\n").filter((line) => line === `  ${NOTE}`);
    expect(calls).toHaveLength(1);
    expect(body.indexOf(`  ${NOTE}\n`)).toBeGreaterThan(
      body.indexOf(`  require_exported_value_matches_env_file ${PENDING}\n`),
    );
  });

  it.each([
    [".env is silent", "OTHER=1\n"],
    [".env says 0", `${STOPPED}=0\n`],
    [".env has 1 first and 0 last", `${STOPPED}=1\n${STOPPED}: 0\n`],
  ])("says the shell value is the validator's only when %s", (_label, envFile) => {
    const result = run(harness(), { stopped: { set: true, value: "1" }, envFile });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`INFO ${STOPPED}=1 is set in this shell but not in .env.`);
    expect(result.stdout).toContain("for the migration validator only");
    expect(result.stdout).toContain("The app reads .env alone");
    // Information only: the deploy carries on.
    expect(result.stdout).toContain("DONE");
  });

  it.each([
    ["the shell says 1 and .env agrees", { set: true, value: "1" } as Shell, `${STOPPED}=1\n`],
    [
      "the shell says 1 and .env agrees in the colon form",
      { set: true, value: "1" } as Shell,
      `export ${STOPPED}: "1"\n`,
    ],
    ["the shell never set it", { set: false } as Shell, "OTHER=1\n"],
    ["the shell says 0", { set: true, value: "0" } as Shell, "OTHER=1\n"],
  ])("stays quiet when %s", (_label, stopped, envFile) => {
    const result = run(harness(), { stopped, envFile });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("INFO");
    expect(result.stdout).toContain("DONE");
  });
});
