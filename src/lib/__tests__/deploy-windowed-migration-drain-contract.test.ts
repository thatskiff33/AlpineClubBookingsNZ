import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { bashFixturePath, bashGateArgs } from "./helpers/bash-fixture-path";
import { readRepoFile } from "./helpers/compose";
import { DEPLOY_SCRIPT, shellFunctionSource } from "./helpers/deploy-script";
import { MIGRATION_GATE_TIMEOUT_MS } from "./helpers/migration-gate-timeouts";

// Run only extracted production functions and the real step 12–14 slice, never
// the deploy engine. Docker/database responses are synthetic; no service runs.
// These disk readers need test:named because test:related cannot see the edge.
const SCRIPT = readRepoFile(DEPLOY_SCRIPT);
const ROOT = mkdtempSync(path.join(tmpdir(), "windowed-drain-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const WINDOWED = "20260101000000_windowed";
const ORDINARY = "20260102000000_ordinary";
const HEADER = "# migration_name\tphase\tprevious_expand_release\told_code_compatible\tlock_impact_plan";
const FUNCTIONS = [
  "list_pending_migration_sql_files",
  "validate_pending_migrations_blue_green_safe",
  "verify_windowed_migration_runtime_drained",
].map((name) => shellFunctionSource(SCRIPT, name)).join("\n");
const START = SCRIPT.indexOf('step "12/20"');
const END = SCRIPT.indexOf('step "15/20"');
expect(START).toBeGreaterThan(0);
expect(END).toBeGreaterThan(START);
const SLICE = SCRIPT.slice(START, END);

function fixture() {
  const dir = mkdtempSync(path.join(ROOT, "case-"));
  mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
  for (const name of [WINDOWED, ORDINARY]) {
    const migration = path.join(dir, "prisma", "migrations", name);
    mkdirSync(migration, { recursive: true });
    writeFileSync(path.join(migration, "migration.sql"), "SELECT 1;\n");
    writeFileSync(path.join(migration, "rollback.sql"), "-- No schema change in this fixture.\n");
  }
  writeFileSync(path.join(dir, "ledger.tsv"), [
    HEADER,
    `${WINDOWED}\texpand\tn/a\twindowed\tStop all old clients during this maintenance window.`,
    `${ORDINARY}\texpand\tn/a\tyes\tAdditive and compatible.`,
    "",
  ].join("\n"));
  writeFileSync(path.join(dir, "scripts", "validate-blue-green-migrations.sh"), readRepoFile("scripts/validate-blue-green-migrations.sh"));
  chmodSync(path.join(dir, "scripts", "validate-blue-green-migrations.sh"), 0o755);
  writeFileSync(path.join(dir, "scripts", "lib", "split-sql-statements.awk"), readRepoFile("scripts/lib/split-sql-statements.awk"));
  return dir;
}

// The stub fails closed for every unrecognised Docker call. All actual query
// arguments are saved to prove the production SQL's filters independently of
// the supplied counts. Failed commands deliberately emit plausible output too.
const STUBS = `
info() { printf '%s\\n' "$*"; }
step() { printf '%s\\n' "$*" >> events; }
validate_prisma_schema_matches_migrations() { echo shadow >> events; }
verify_prisma_migration_status() { :; }
# #4453: the post-migrate role-grants check is proven by
# deploy-database-roles-script-contract.test.ts; stubbed here like its neighbour.
verify_least_privilege_role_grants() { :; }
wait_for_health() { :; }
verify_internal_health() { :; }
find() { if [ "$ENUM_FAIL" = 1 ]; then command find "$@"; return 7; fi; command find "$@"; }
sort() { if [ "$SORT_FAIL" = 1 ]; then command sort "$@"; return 7; fi; command sort "$@"; }
mktemp() { if [ "\${MKTEMP_FAIL:-0}" = 1 ]; then return 7; fi; command mktemp "$@"; }
grep() { if [ "\${COMPARE_FAIL:-0}" = 1 ]; then return 2; fi; command grep "$@"; }
docker() {
  case "$*" in
    "compose exec -T postgres psql -U tac -d tacbookings -Atqc SELECT EXISTS "*)
      printf '%s\\n' "$TABLE_RESULT"
      [ "$DB_FAIL" != exists ] ;;
    "compose exec -T postgres psql -U tac -d tacbookings -Atqc SELECT migration_name "*)
      printf '%s' "$APPLIED"
      [ "$DB_FAIL" != applied ] ;;
    "compose ps --all --quiet "*)
      service="\${*: -1}"
      echo "probe $service" >> events
      case "$service" in
        app) printf '%s' "$APP_IDS" ;;
        app_blue) printf '%s' "$BLUE_IDS" ;;
        app_green) printf '%s' "$GREEN_IDS" ;;
        *) return 90 ;;
      esac
      [ "$PS_FAIL" != "$service" ] ;;
    "inspect --format {{.State.Running}} "*)
      cid="\${*: -1}"
      echo "inspect $cid" >> events
      if [ "$cid" = "$RUNNING_ID" ]; then printf '%s' true; else printf '%s' "$STATE"; fi
      [ "$INSPECT_FAIL" != "$cid" ] ;;
    "compose exec -T postgres psql -U tac -d tacbookings -Atqc SELECT count(*) FROM pg_stat_activity "*)
      printf '%s\\n' "\${*: -1}" > query
      echo db-probe >> events
      printf '%s' "$CLIENT_COUNT"
      if [ "$DB_FAIL" = clients ]; then echo "PRIVATE_FAILURE secret@host SELECT count" >&2; return 7; fi ;;
    "compose --profile migrate run --rm migrate") touch migrated ;;
    "compose up -d --force-recreate app_green") touch started ;;
    *) echo "Unexpected synthetic Docker call" >&2; return 91 ;;
  esac
}
`;

function run(options: Record<string, string> = {}, setup?: (dir: string) => void) {
  const dir = fixture();
  setup?.(dir);
  writeFileSync(path.join(dir, "harness.sh"), [
    "set -Eeuo pipefail", 'cd "$CASE_DIR"',
    "CRON_SERVICE=app", "BLUE_SERVICE=app_blue", "GREEN_SERVICE=app_green",
    "POSTGRES_SERVICE=postgres", "MIGRATE_SERVICE=migrate", "TARGET_SERVICE=app_green",
    "HEALTH_TIMEOUT_SECONDS=1", "MIGRATION_LOCK_TIMEOUT_MS_EFFECTIVE=1000",
    STUBS, FUNCTIONS, options.DRAIN_ONLY
      ? 'PENDING_WINDOWED_MIGRATIONS="$DRAIN_STATUS"\nverify_windowed_migration_runtime_drained\ntouch migrated\ntouch started'
      : SLICE,
  ].join("\n"));
  const result = spawnSync("bash", bashGateArgs(bashFixturePath(path.join(dir, "harness.sh")), [], {
    CASE_DIR: bashFixturePath(dir),
    ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1", BLUE_GREEN_MIGRATION_OVERRIDE_REASON: "synthetic window",
    BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED: "1", MIGRATION_SAFETY_LEDGER: "ledger.tsv",
    TABLE_RESULT: "t", APPLIED: "", DB_FAIL: "", ENUM_FAIL: "0", SORT_FAIL: "0",
    APP_IDS: "aa", BLUE_IDS: "bb", GREEN_IDS: "cc", RUNNING_ID: "", STATE: "false",
    PS_FAIL: "", INSPECT_FAIL: "", CLIENT_COUNT: "0", DRAIN_STATUS: "1", ...options,
  }), { encoding: "utf8", timeout: MIGRATION_GATE_TIMEOUT_MS });
  const read = (name: string) => existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), "utf8") : "";
  return {
    code: result.status, output: result.stdout + result.stderr, stderr: result.stderr,
    migrated: existsSync(path.join(dir, "migrated")), started: existsSync(path.join(dir, "started")),
    events: read("events"), query: read("query"),
  };
}

function refuses(result: ReturnType<typeof run>, message: RegExp) {
  expect(result.code, result.output).toBe(1);
  expect(result.output).toMatch(message);
  expect(result.migrated, result.output).toBe(false);
  expect(result.started, result.output).toBe(false);
  expect(result.events).not.toContain("13/20");
  expect(result.stderr).not.toMatch(/PRIVATE_FAILURE|secret@|SELECT count/);
}

describe("windowed app-database migration boundary (#3963 / #4071)", () => {
  it("checks the drain immediately before the real step-13 marker and migrate, before startup", () => {
    expect(SLICE).toMatch(/verify_windowed_migration_runtime_drained\n\nstep "13\/20"/);
    const result = run();
    expect(result.code, result.output).toBe(0);
    expect(result.migrated).toBe(true);
    expect(result.started).toBe(true);
    expect(result.events).toMatch(/shadow[\s\S]*probe app\n[\s\S]*probe app_blue\n[\s\S]*probe app_green\n[\s\S]*db-probe\n13\/20/);
  }, MIGRATION_GATE_TIMEOUT_MS);

  it.each(["app", "app_blue", "app_green"])("refuses a running %s replica (including paused-running)", (service) => {
    const id = { app: "aa", app_blue: "bb", app_green: "cc" }[service];
    refuses(run({ RUNNING_ID: id! }), new RegExp(`${service} has a running container`));
  }, MIGRATION_GATE_TIMEOUT_MS);

  it("checks every replica, including a running second replica among stopped ones", () => {
    refuses(run({ BLUE_IDS: "bb\ndd\nee", RUNNING_ID: "dd" }), /app_blue has a running container/);
  }, MIGRATION_GATE_TIMEOUT_MS);

  it.each([
    { STATE: "false\n", CLIENT_COUNT: "0\n" },
    { APP_IDS: "", BLUE_IDS: "", GREEN_IDS: "" },
    { APP_IDS: "aa\ndd", BLUE_IDS: "", GREEN_IDS: "cc\nee" },
  ] as Record<string, string>[])("accepts stopped or absent services: %j", (options) => {
    const result = run(options);
    expect(result.code, result.output).toBe(0);
    expect(result.migrated).toBe(true);
  }, MIGRATION_GATE_TIMEOUT_MS);

  it.each([
    [{ PS_FAIL: "app" }, /Could not enumerate app/],
    [{ PS_FAIL: "app_green", GREEN_IDS: "" }, /Could not enumerate app_green/],
    [{ INSPECT_FAIL: "bb" }, /Could not inspect app_blue/],
    [{ BLUE_IDS: "not a container" }, /Invalid container enumeration/],
    [{ GREEN_IDS: "cc\n\ndd" }, /Invalid container enumeration/],
    ...["", "paused", "False", "false\ntrue", "false\n\n", " false"].map((STATE) => [{ STATE }, /Invalid running state/] as const),
  ] as [Record<string, string>, RegExp][])("refuses unreadable/malformed container evidence %j", (options, message) => {
    refuses(run(options), message);
  }, MIGRATION_GATE_TIMEOUT_MS);

  it.each(["1", "2", "999999999999999999999999999999999999999"])("refuses %s other app-database clients", (CLIENT_COUNT) => {
    refuses(run({ CLIENT_COUNT }), /other client backend\(s\), including idle clients/);
  }, MIGRATION_GATE_TIMEOUT_MS);

  it.each(["", "-1", " 0", "0 ", "0\n1", "0\n\n", "1.0", "zero"])("refuses malformed client count %j", (CLIENT_COUNT) => {
    refuses(run({ CLIENT_COUNT }), /Invalid app-database client count/);
  }, MIGRATION_GATE_TIMEOUT_MS);

  it("refuses a failed client read even if it printed zero, without leaking raw diagnostics", () => {
    refuses(run({ DB_FAIL: "clients", CLIENT_COUNT: "0" }), /Could not read app-database client count/);
  }, MIGRATION_GATE_TIMEOUT_MS);

  it("counts every other same-database client backend, including idle/admin/external users", () => {
    const result = run();
    // Exact predicate contract: adding a state/usename/application_name filter,
    // dropping current_database or own-PID/background exclusions fails this.
    expect(result.query.trim()).toBe("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()");
  }, MIGRATION_GATE_TIMEOUT_MS);

  it.each(["exists", "applied"])("failed %s discovery refuses before validation/migrate", (DB_FAIL) => {
    const result = run({ DB_FAIL, TABLE_RESULT: "t" });
    refuses(result, /Pending migration discovery failed/);
    expect(result.events).not.toContain("probe");
    expect(result.output).not.toMatch(/No pending Prisma|Ledger declares/);
  }, MIGRATION_GATE_TIMEOUT_MS);

  it.each([{ ENUM_FAIL: "1" }, { SORT_FAIL: "1" }, { TABLE_RESULT: "" }, { TABLE_RESULT: "unknown" }] as Record<string, string>[])("refuses failed/unknown enumeration %j", (options) => {
    refuses(run(options), /Pending migration discovery failed/);
  }, MIGRATION_GATE_TIMEOUT_MS);

  it.each([
    [{ MKTEMP_FAIL: "1" }, /Could not prepare pending migration discovery/],
    [{ COMPARE_FAIL: "1" }, /Could not compare applied migrations/],
  ] as [Record<string, string>, RegExp][])("refuses failed pending-discovery setup or comparison %j", (options, producerMessage) => {
    const result = run(options);
    refuses(result, producerMessage);
    expect(result.output).toContain("Pending migration discovery failed");
    expect(result.events).not.toContain("probe");
    expect(result.events).not.toContain("13/20");
  }, MIGRATION_GATE_TIMEOUT_MS);

  it.each([
    { APPLIED: `${WINDOWED}\n` },
    { APPLIED: `${WINDOWED}\n${ORDINARY}\n` },
  ])("ordinary/already-applied sets skip every drain probe: %j", (options) => {
    const result = run({ ...options, DB_FAIL: "clients", PS_FAIL: "app", RUNNING_ID: "aa", BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED: "0" });
    expect(result.code, result.output).toBe(0);
    expect(result.events).not.toContain("probe");
    expect(result.migrated).toBe(true);
  }, MIGRATION_GATE_TIMEOUT_MS);

  it("a missing migration table is a successful pending discovery, requiring the window", () => {
    refuses(run({ TABLE_RESULT: "f", RUNNING_ID: "aa" }), /app has a running container/);
  }, MIGRATION_GATE_TIMEOUT_MS);

  it.each(["0", "true", " 1", "1 "])("the drain guard independently requires exact shell acknowledgement: %j", (ack) => {
    refuses(run({ DRAIN_ONLY: "1", BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED: ack }), /deploy-shell.*acknowledgement/);
  }, MIGRATION_GATE_TIMEOUT_MS);

  it.each(["unknown", "", "2"])("the drain guard refuses unknown classification: %j", (DRAIN_STATUS) => {
    refuses(run({ DRAIN_ONLY: "1", DRAIN_STATUS }), /Pending-windowed status is unknown/);
  }, MIGRATION_GATE_TIMEOUT_MS);

  it.each(["0", "true", " 1", "1 "])("retains exact shell acknowledgement requirement: %j", (ack) => {
    refuses(run({ BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED: ack }), /Pending windowed migrations cannot run/);
  }, MIGRATION_GATE_TIMEOUT_MS);

  it.each([
    ["", 0], ["2\n", 0], ["1\nnoise\n", 0], ["1\n\n", 0], ["1", 0], ["0\n", 7], ["1\n", 7],
  ])("refuses malformed/failed validator report %j status %s", (report, status) => {
    refuses(run({}, (dir) => {
      writeFileSync(path.join(dir, "report"), report);
      writeFileSync(path.join(dir, "scripts", "validate-blue-green-migrations.sh"), `#!/usr/bin/env bash\ncat report\nexit ${status}\n`);
    }), status ? /safety validation failed/ : /Invalid pending-windowed report/);
  }, MIGRATION_GATE_TIMEOUT_MS);
});

// Drive the actual validator independently: only its successful canonical
// found_windowed value is emitted, and only for the supplied pending list.
describe("validator --report-windowed protocol", () => {
  function validate(names: string[], env: Record<string, string> = {}, report = true, setup?: (dir: string) => void) {
    const dir = fixture();
    setup?.(dir);
    return spawnSync("bash", bashGateArgs("scripts/validate-blue-green-migrations.sh", [
      ...(report ? ["--report-windowed"] : []),
      ...names.map((name) => bashFixturePath(path.join(dir, "prisma", "migrations", name, "migration.sql"))),
    ], {
      MIGRATION_SAFETY_LEDGER: bashFixturePath(path.join(dir, "ledger.tsv")),
      ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1", BLUE_GREEN_MIGRATION_OVERRIDE_REASON: "synthetic window",
      BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED: "1", ...env,
    }), { encoding: "utf8", timeout: MIGRATION_GATE_TIMEOUT_MS });
  }

  it.each([[[], "0\n"], [[ORDINARY], "0\n"], [[WINDOWED], "1\n"], [[ORDINARY, WINDOWED], "1\n"]] as [string[], string][])("reports only the validated pending list %j", (names, expected) => {
    const result = validate(names);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(expected);
  }, MIGRATION_GATE_TIMEOUT_MS);

  it("preserves the default caller's empty stdout and stderr diagnostics", () => {
    const result = validate([WINDOWED], {}, false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Ledger declares this migration windowed");
  }, MIGRATION_GATE_TIMEOUT_MS);

  it.each([
    { ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "0" },
    { BLUE_GREEN_MIGRATION_OVERRIDE_REASON: "" },
    { BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED: "0" },
  ] as Record<string, string>[])("failed validation emits no usable report: %j", (env) => {
    const result = validate([WINDOWED], env);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  }, MIGRATION_GATE_TIMEOUT_MS);

  it("missing rollback refuses before emitting a classification", () => {
    const result = validate([WINDOWED], {}, true, (dir) => rmSync(path.join(dir, "prisma", "migrations", WINDOWED, "rollback.sql")));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must ship a reverse script");
    expect(result.stdout).toBe("");
  }, MIGRATION_GATE_TIMEOUT_MS);
});
