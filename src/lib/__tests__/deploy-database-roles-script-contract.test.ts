/**
 * #4453 review (O-F2, S-F8): the deploy script's guards for the least-privilege
 * database roles.
 *
 *  - a half-configured switch (APP_DB_USER without MIGRATION_DB_USER and
 *    AUDIT_RETENTION_DATABASE_URL) is refused in the step-3 preflight;
 *  - after the migrate, a relation not owned by the migration role or not
 *    readable by the application role stops the deploy before the new colour;
 *  - the password URL-safety check refuses `%`.
 *
 * The functions are RUN, copied out of the script into a throwaway bash harness
 * (`shellFunctionSource`), the way the other deploy-script suites do. The
 * post-migrate SQL itself is run against PostgreSQL by
 * `database-roles.realdb.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEPLOY_GRANTS_CHECK_SQL } from "@/lib/database-roles";

import { DEPLOY_SCRIPT, shellFunctionSource } from "./helpers/deploy-script";

const script = readFileSync(path.join(process.cwd(), DEPLOY_SCRIPT), "utf8");
const code = script
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

const HELPERS = [
  "trim_whitespace",
  "env_assignment_pattern",
  "compose_env_file_value",
  "strip_matching_quotes",
  "printable_deploy_value",
  "get_env_file_value",
  "require_exported_value_matches_env_file",
  "require_exported_secret_matches_env_file",
];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs one deploy-script function against a `.env`, with only `exported` in the shell. */
function run(fn: string, envFile: string, exported: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "deploy-db-roles-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, ".env"), envFile);
  const harness = [
    "set -Eeuo pipefail",
    ...[...HELPERS, fn].map((name) => shellFunctionSource(script, name)),
    `${fn}`,
  ].join("\n");
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...exported };
  return spawnSync("bash", ["-c", harness], { cwd: dir, env, encoding: "utf8" });
}

describe("require_least_privilege_roles_complete", () => {
  it("allows the stock single-superuser stack", () => {
    const result = run("require_least_privilege_roles_complete", "DB_PASSWORD=x\n");
    expect(result.status, result.stderr).toBe(0);
  });

  it("allows the complete switch", () => {
    const result = run(
      "require_least_privilege_roles_complete",
      "APP_DB_USER=tac_app\nMIGRATION_DB_USER=tac_migrator\nAUDIT_RETENTION_DATABASE_URL=postgresql://r:<your-retention-password>@postgres:5432/tacbookings\n",
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("allows MIGRATION_DB_USER on its own", () => {
    const result = run("require_least_privilege_roles_complete", "MIGRATION_DB_USER=tac_migrator\n");
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["without MIGRATION_DB_USER", "APP_DB_USER=tac_app\nAUDIT_RETENTION_DATABASE_URL=postgresql://r@postgres/tacbookings\n"],
    ["without AUDIT_RETENTION_DATABASE_URL", "APP_DB_USER=tac_app\nMIGRATION_DB_USER=tac_migrator\n"],
    ["on its own", "APP_DB_USER=tac_app\n"],
  ])("refuses APP_DB_USER %s", (_label, envFile) => {
    const result = run("require_least_privilege_roles_complete", envFile);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MIGRATION_DB_USER and AUDIT_RETENTION_DATABASE_URL must be set too");
  });

  const retentionUrl = (secret: string) => `postgresql://tac_audit_retention:${secret}@postgres:5432/tacbookings`;
  const COMPLETE_SPLIT = `APP_DB_USER=tac_app\nMIGRATION_DB_USER=tac_migrator\nAUDIT_RETENTION_DATABASE_URL=${retentionUrl("r".repeat(24))}\n`;

  it.each([
    ["AUDIT_RETENTION_DATABASE_URL (N1)", "AUDIT_RETENTION_DATABASE_URL", retentionUrl],
    ["APP_DB_PASSWORD", "APP_DB_PASSWORD", (secret: string) => secret],
    ["MIGRATION_DB_PASSWORD", "MIGRATION_DB_PASSWORD", (secret: string) => secret],
  ])("refuses a shell %s that disagrees with .env without printing either password", (_label, key, value) => {
    const inEnvFile = `${"0123456789abcdef".repeat(2)}`;
    const inShell = `${"fedcba9876543210".repeat(2)}`;
    const envFile =
      key === "AUDIT_RETENTION_DATABASE_URL"
        ? `APP_DB_USER=tac_app\nMIGRATION_DB_USER=tac_migrator\nAUDIT_RETENTION_DATABASE_URL=${value(inEnvFile)}\n`
        : `${COMPLETE_SPLIT}${key}=${value(inEnvFile)}\n`;
    const result = run("require_least_privilege_roles_complete", envFile, { [key]: value(inShell) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${key} disagrees between this shell and .env`);
    const output = result.stdout + result.stderr;
    for (const secret of [inEnvFile, inShell]) {
      // Not the password, nor any 8-character run of it.
      for (let start = 0; start + 8 <= secret.length; start += 1) {
        expect(output).not.toContain(secret.slice(start, start + 8));
      }
    }
  });

  it("allows role passwords still exported from step 2 when they match .env", () => {
    const appPassword = "a".repeat(24);
    const migrationPassword = "m".repeat(24);
    const result = run(
      "require_least_privilege_roles_complete",
      `${COMPLETE_SPLIT}APP_DB_PASSWORD=${appPassword}\nMIGRATION_DB_PASSWORD=${migrationPassword}\n`,
      { APP_DB_PASSWORD: appPassword, MIGRATION_DB_PASSWORD: migrationPassword },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("still names a disagreeing role NAME, which is not a secret", () => {
    const result = run(
      "require_least_privilege_roles_complete",
      "APP_DB_USER=tac_app\nMIGRATION_DB_USER=tac_migrator\nAUDIT_RETENTION_DATABASE_URL=postgresql://r@postgres/tacbookings\n",
      { APP_DB_USER: "tac_other" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tac_other");
  });

  it("is part of the step-3 env preflight, right after the password check", () => {
    const body = shellFunctionSource(code, "validate_env_contract");
    const safe = body.indexOf("  require_safe_database_password\n");
    const roles = body.indexOf("  require_least_privilege_roles_complete\n");
    expect(safe).toBeGreaterThan(0);
    expect(roles).toBeGreaterThan(safe);
  });
});

describe("require_safe_database_password", () => {
  it.each(["DB_PASSWORD", "APP_DB_PASSWORD", "MIGRATION_DB_PASSWORD"])(
    "refuses a percent sign in %s, which a connection string would percent-decode",
    (key) => {
      const result = run("require_safe_database_password", `${key}=abc%41def\n`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${key} contains URL-unsafe characters`);
    },
  );

  it("accepts a hex password", () => {
    const result = run("require_safe_database_password", "DB_PASSWORD=0123456789abcdef0123\n");
    expect(result.status, result.stderr).toBe(0);
  });
});

describe("verify_least_privilege_role_grants", () => {
  const body = shellFunctionSource(code, "verify_least_privilege_role_grants");

  it("does nothing while the split is off", () => {
    const result = run("verify_least_privilege_role_grants", "DB_PASSWORD=x\n");
    expect(result.status, result.stderr).toBe(0);
  });

  it("asks PostgreSQL as the operator, stops on any error, and names both roles", () => {
    expect(body).toContain('docker compose exec -T "$POSTGRES_SERVICE" psql -U tac -d tacbookings');
    expect(body).toContain("-v ON_ERROR_STOP=1");
    expect(body).toContain('-v migration_role="$migration_user" -v app_role="$app_user"');
    expect(body.match(/return 1/g)?.length).toBe(2);
  });

  it("refuses when PostgreSQL names a relation, and when it cannot be asked", () => {
    const stub = (output: string, status: number) =>
      `docker() { cat >/dev/null; printf '%s' '${output}'; return ${status}; }\nPOSTGRES_SERVICE=postgres`;
    const envFile = "APP_DB_USER=tac_app\nMIGRATION_DB_USER=tac_migrator\n";
    const runWith = (preamble: string) => {
      const dir = mkdtempSync(path.join(tmpdir(), "deploy-db-roles-"));
      dirs.push(dir);
      writeFileSync(path.join(dir, ".env"), envFile);
      const harness = [
        "set -Eeuo pipefail",
        ...[...HELPERS, "verify_least_privilege_role_grants"].map((name) => shellFunctionSource(script, name)),
        preamble,
        "verify_least_privilege_role_grants",
      ].join("\n");
      return spawnSync("bash", ["-c", harness], { cwd: dir, env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" }, encoding: "utf8" });
    };

    const clean = runWith(stub("", 0));
    expect(clean.status, clean.stderr).toBe(0);

    const drifted = runWith(stub("HandMadeTable", 0));
    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toContain("fail the least-privilege grants check: HandMadeTable");
    expect(drifted.stderr).toContain("not owned by tac_migrator, not readable by tac_app");
    expect(drifted.stderr).toContain("db:provision-roles --apply");

    const unreachable = runWith(stub("", 2));
    expect(unreachable.status).toBe(1);
    expect(unreachable.stderr).toContain("Could not check the least-privilege role grants");
  });

  it("carries exactly DEPLOY_GRANTS_CHECK_SQL, the one definition (N3)", () => {
    const block = script.slice(
      script.indexOf("# BEGIN least-privilege-grants-check"),
      script.indexOf("# END least-privilege-grants-check"),
    );
    const sql = block.slice(block.indexOf("<<'SQL'\n") + "<<'SQL'\n".length, block.indexOf("\nSQL\n"));
    expect(sql).toBe(DEPLOY_GRANTS_CHECK_SQL);
    expect(sql).toContain("d.deptype = 'e'");
  });

  it("runs straight after the migrate's status check, before the new colour starts", () => {
    const status = code.indexOf("\nverify_prisma_migration_status\n");
    const grants = code.indexOf("\nverify_least_privilege_role_grants\n");
    const target = code.indexOf('step "14/20"');
    expect(status).toBeGreaterThan(0);
    expect(grants).toBeGreaterThan(status);
    expect(target).toBeGreaterThan(grants);
  });
});
