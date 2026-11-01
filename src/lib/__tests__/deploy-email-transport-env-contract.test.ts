import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { bashFixturePath, bashGateArgs } from "./helpers/bash-fixture-path";
import { readRepoFile } from "./helpers/compose";
import { DEPLOY_SCRIPT, shellFunctionSource } from "./helpers/deploy-script";
import { resolveEmailDeliveryConfigFromEnv } from "@/lib/email-delivery";

/*
  The settings #4275 made configurable for a production host behind a
  TLS-terminating proxy, on an SMTP relay, or running a fork's images — each
  checked as the thing that will READ it receives it, and each check RUN here
  against synthetic fixtures rather than pinned as source text (#4276 review).

  - The wrapper reads GHCR_*_IMAGE_REPOSITORY from the source repository's .env
    with the file-level Compose-grammar reader (`compose_env_file_value KEY
    FILE`), not a second grammar: quotes removed, `export` honoured, last
    duplicate wins.
  - Step 3 renders the Compose model once (`render_resolved_compose_config`) and
    checks the email transport, Caddy's TLS mode and Postgres's max_connections
    against what each service would receive: Compose's defaults (USE_AWS_SES
    defaults to true), the shell's precedence over .env, and YAML's quoting of
    the render (`USE_AWS_SES: "true"`).
  - Step 4 validates the Caddyfile with the caddy service's whole resolved
    environment, so a local-mode installation validates local mode.

  `test:related` cannot select this file: it reads the shell script from disk.
  Run it with `pnpm run test:named`.
*/

const SCRIPT = readRepoFile(DEPLOY_SCRIPT);

const ROOT = mkdtempSync(path.join(tmpdir(), "deploy-proxied-host-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/**
 * Each case spawns bash several times; Windows hosts measured ~0.7 s a spawn
 * under load, so the default 5 s is a false red, not a slow gate.
 */
const RUN = { timeout: 60_000 };

/** A script line, exactly, asserted present once. */
function exactLine(line: string): string {
  const occurrences = SCRIPT.split("\n").filter((candidate) => candidate === line);
  expect(occurrences.length, `the deploy script must carry \`${line}\` exactly once`).toBe(1);
  return line;
}

function lift(names: string[]): string {
  return names.map((name) => shellFunctionSource(SCRIPT, name)).join("\n");
}

type Run = { code: number | null; stdout: string; stderr: string; dir: string };

/** Writes `files` into a fresh case directory and runs `harness` there. */
function runHarness(harness: string, files: Record<string, string>, env: Record<string, string> = {}): Run {
  const dir = mkdtempSync(path.join(ROOT, "case-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content, "utf8");
  const harnessPath = path.join(dir, "harness.sh");
  writeFileSync(harnessPath, harness, "utf8");
  const result = spawnSync("bash", bashGateArgs(bashFixturePath(harnessPath, dir), [], env), {
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, dir };
}

// ---------------------------------------------------------------------------
// The wrapper's image-repository lookup
// ---------------------------------------------------------------------------

const UPSTREAM_APP = "ghcr.io/thatskiff33/alpineclubbookingsnz-app";
const WRAPPER_HARNESS = `set -Eeuo pipefail
${lift(["trim_whitespace", "printable_deploy_value", "env_assignment_pattern", "strip_matching_quotes", "compose_env_file_value", "resolve_image_repository"])}
info() { printf 'INFO %s\\n' "$1"; }
SOURCE_REPO="$PWD"
resolve_image_repository GHCR_APP_IMAGE_REPOSITORY "$SHELL_VALUE" "${UPSTREAM_APP}"
`;

function resolveRepository(envFile: string, shellValue = "") {
  const result = runHarness(WRAPPER_HARNESS, { ".env": envFile }, { SHELL_VALUE: shellValue });
  expect(result.code, result.stderr).toBe(0);
  return { value: result.stdout.trim(), provenance: result.stderr.trim() };
}

describe("the wrapper reads a fork's image repositories with Compose's .env grammar (#4275)", RUN, () => {
  it("keeps one reader: the wrapper calls the file-level compose_env_file_value with the source .env", () => {
    const body = shellFunctionSource(SCRIPT, "resolve_image_repository");
    expect(body).toContain('compose_env_file_value "$key" "$SOURCE_REPO/.env"');
    expect(SCRIPT).not.toContain("read_source_env_value");
    // Defined above both nested halves, so the wrapper process has it.
    const reader = SCRIPT.indexOf("\ncompose_env_file_value() {");
    expect(reader).toBeGreaterThan(0);
    expect(reader).toBeLessThan(SCRIPT.indexOf("\nrun_production_wrapper() {"));
  });

  it.each([
    ["plain", "GHCR_APP_IMAGE_REPOSITORY=ghcr.io/fork/app"],
    ["double-quoted", 'GHCR_APP_IMAGE_REPOSITORY="ghcr.io/fork/app"'],
    ["single-quoted with an inline comment", "GHCR_APP_IMAGE_REPOSITORY='ghcr.io/fork/app' # our images"],
    ["export-prefixed", "export GHCR_APP_IMAGE_REPOSITORY=ghcr.io/fork/app"],
    ["indented, spaced", "   GHCR_APP_IMAGE_REPOSITORY = ghcr.io/fork/app"],
    [
      "a later duplicate, which Compose applies",
      "GHCR_APP_IMAGE_REPOSITORY=ghcr.io/old/app\nGHCR_APP_IMAGE_REPOSITORY=ghcr.io/fork/app",
    ],
  ])("reads the %s form as the fork's repository", (_label, line) => {
    const resolved = resolveRepository(`OTHER=1\n${line}\n`);
    expect(resolved.value).toBe("ghcr.io/fork/app");
    expect(resolved.provenance).toContain("/.env");
  });

  it("prefers the shell, then the file, then the upstream default, and says which", () => {
    const shell = resolveRepository("GHCR_APP_IMAGE_REPOSITORY=ghcr.io/fork/app\n", "ghcr.io/shell/app");
    expect(shell.value).toBe("ghcr.io/shell/app");
    expect(shell.provenance).toContain("from the shell environment");
    const fallback = resolveRepository("# GHCR_APP_IMAGE_REPOSITORY=ghcr.io/commented/app\nOTHER=1\n");
    expect(fallback.value).toBe(UPSTREAM_APP);
    expect(fallback.provenance).toContain("using the upstream default");
  });
});

// ---------------------------------------------------------------------------
// The step-3 checks of the resolved Compose model
// ---------------------------------------------------------------------------

type EnvMap = Record<string, string>;

/** A value spelled as `docker compose config` writes it: YAML-quoted where YAML would read it as something else. */
function yamlScalar(value: string): string {
  // YAML also quotes a string with leading or trailing whitespace.
  return value === "" || value.trim() !== value || /^(true|false|yes|no|on|off|null|~|[0-9.]+)$/i.test(value)
    ? `"${value}"`
    : value;
}

const SES_ENV: EnvMap = {
  USE_AWS_SES: "true",
  USE_SMTP_RELAY: "false",
  USE_LOCAL_CAPTURE: "false",
  SMTP_HOST: "email-smtp.ap-southeast-2.amazonaws.com",
  SMTP_PORT: "587",
  AWS_SES_ACCESS_KEY_ID: "AKIAFIXTUREKEY",
  AWS_SES_SECRET_ACCESS_KEY: "ses-secret",
  SES_SNS_TOPIC_ARN: "arn:aws:sns:ap-southeast-2:123456789012:ses",
  EMAIL_SERVER_HOST: "",
  EMAIL_SERVER_PORT: "",
  EMAIL_SERVER_USER: "",
  EMAIL_SERVER_PASSWORD: "",
};
const RELAY_ENV: EnvMap = {
  ...SES_ENV,
  USE_AWS_SES: "false",
  USE_SMTP_RELAY: "true",
  AWS_SES_ACCESS_KEY_ID: "",
  AWS_SES_SECRET_ACCESS_KEY: "",
  SES_SNS_TOPIC_ARN: "",
  SMTP_HOST: "",
  SMTP_PORT: "",
  EMAIL_SERVER_HOST: "smtp.relay.test",
  EMAIL_SERVER_PORT: "587",
  EMAIL_SERVER_USER: "club",
  EMAIL_SERVER_PASSWORD: "relay-secret",
};
const CADDY_ENV: EnvMap = {
  DOMAIN: "bookings.club.test",
  MEET_HOST: "meet.club.test",
  MIROTALK_UPSTREAM: "host.docker.internal:3010",
  CADDY_TLS_MODE: "acme",
  CADDY_TRUSTED_PROXIES: "10.0.0.2/32",
};
const POSTGRES_COMMAND = ["postgres", "-c", "shared_buffers=128MB", "-c", "max_connections=40"];

function url(limit: number | string) {
  return `postgresql://tac:pw@postgres:5432/tacbookings?connection_limit=${limit}&pool_timeout=10`;
}

/** A render shaped like `docker compose --profile migrate config` output. */
function render(
  options: {
    app?: EnvMap;
    perService?: Record<string, EnvMap>;
    caddy?: EnvMap;
    postgresCommand?: string[];
  } = {},
): string {
  const env = (map: EnvMap) =>
    Object.keys(map)
      .sort()
      .map((key) => `      ${key}: ${yamlScalar(map[key])}`)
      .join("\n");
  const app = { ...SES_ENV, ...options.app };
  const appService = (name: string, limit: number) =>
    `  ${name}:\n    environment:\n${env({ ...app, DATABASE_URL: url(limit), ...options.perService?.[name] })}\n    image: app:local`;
  return [
    "name: resolved",
    "services:",
    appService("app", 5),
    appService("app_blue", 10),
    appService("app_green", 10),
    `  caddy:\n    environment:\n${env({ ...CADDY_ENV, ...options.caddy })}\n    image: caddy:2-alpine\n    volumes:\n      - type: volume`,
    `  migrate:\n    environment:\n${env({ DATABASE_URL: url(2) })}\n    image: migrate:local`,
    `  postgres:\n    command:\n${(options.postgresCommand ?? POSTGRES_COMMAND).map((item) => `      - ${item}`).join("\n")}\n    environment:\n      POSTGRES_DB: tacbookings\n    image: postgres:16-alpine`,
    "volumes:",
    "  caddy_data: {}",
    "",
  ].join("\n");
}

/** What docker-compose.yml hands Caddy when .env leaves CADDY_TRUSTED_PROXIES unset. */
const TRUSTED_PROXIES_SENTINEL = "set-CADDY_TRUSTED_PROXIES-for-local-mode";

const ENGINE_HARNESS = `set -Eeuo pipefail
CRON_SERVICE=app BLUE_SERVICE=app_blue GREEN_SERVICE=app_green MIGRATE_SERVICE=migrate
CADDY_SERVICE=caddy POSTGRES_SERVICE=postgres
${exactLine("POSTGRES_MAX_CONNECTIONS_MAX=1000")}
${exactLine(`CADDY_TRUSTED_PROXIES_UNSET="${TRUSTED_PROXIES_SENTINEL}"`)}
VALIDATED_ENVIRONMENT_ROLE="$ROLE"
PROJECT_DIR="$PWD"
${lift([
  "trim_whitespace",
  "printable_deploy_value",
  "strip_matching_quotes",
  "compose_service_environment_entries",
  "compose_service_environment_value",
  "compose_render_scalar",
  "resolved_service_env_value",
  "compose_service_command_items",
  "value_looks_like_placeholder",
  "email_flag_is_true",
  "require_email_flag_is_boolean",
  "require_resolved_service_value",
  "require_resolved_email_transport_for_service",
  "validate_resolved_email_transport",
  "require_resolved_caddy_tls_mode",
  "require_resolved_caddy_trusted_proxies",
  "require_integer_setting_in_range",
  "validate_resolved_postgres_max_connections",
  "validate_caddy_contract",
])}
${exactLine('CADDY_VALIDATION_ENV_FILE=""')}
# A stub that records its arguments and a copy of the --env-file it was handed.
docker() {
  local previous=""
  local argument
  printf '%s\\n' "$@" > docker.args
  for argument in "$@"; do
    if [ "$previous" = --env-file ]; then
      cp "$argument" docker.env
      printf '%s' "$argument" > docker.envpath
      stat -c %a "$argument" > docker.envmode 2>/dev/null || true
    fi
    previous="$argument"
  done
}
RESOLVED_COMPOSE_CONFIG="$(cat rendered.yml)"
"$ENTRY"
if [ -f docker.envpath ] && [ -e "$(cat docker.envpath)" ]; then echo LEFTOVER-ENV-FILE; fi
echo PASSED
`;

function check(entry: string, rendered: string, role = "production"): Run & { passed: boolean } {
  const result = runHarness(
    ENGINE_HARNESS,
    { "rendered.yml": rendered, Caddyfile: "{$DOMAIN} {\n}\n" },
    { ENTRY: entry, ROLE: role },
  );
  return { ...result, passed: result.code === 0 && result.stdout.includes("PASSED") };
}

describe("step 3 checks the email transport each app service would receive (#4275)", RUN, () => {
  const email = (rendered: string, role?: string) => check("validate_resolved_email_transport", rendered, role);

  it("passes the shipped AWS SES defaults with the SES keys set", () => {
    const result = email(render());
    expect(result.passed, result.stderr).toBe(true);
  });

  it("refuses USE_SMTP_RELAY=true alone, because Compose still hands the app USE_AWS_SES=true", () => {
    // The .env names only the relay; docker-compose.yml's `${USE_AWS_SES:-true}`
    // fills in the other, and the app refuses two enabled providers.
    const result = email(render({ app: { ...RELAY_ENV, USE_AWS_SES: "true" } }));
    expect(result.passed).toBe(false);
    expect(result.stderr).toContain("Only one of USE_AWS_SES, USE_SMTP_RELAY and USE_LOCAL_CAPTURE may be true");
    expect(result.stderr).toContain("sets USE_AWS_SES=false in .env as well as USE_SMTP_RELAY=true");
  });

  it("passes a relay with USE_AWS_SES=false and its four settings, SES keys blank", () => {
    const result = email(render({ app: RELAY_ENV }));
    expect(result.passed, result.stderr).toBe(true);
  });

  it("accepts a quoted or capitalised true, as Compose and the app do", () => {
    expect(email(render({ app: { ...RELAY_ENV, USE_SMTP_RELAY: "True" } })).passed).toBe(true);
    // A render that kept a .env's own quotes around the flag.
    expect(email(render({ app: { ...RELAY_ENV, USE_SMTP_RELAY: "'true'" } })).passed).toBe(true);
  });

  it("refuses a relay missing any of its four settings, naming it", () => {
    for (const key of ["EMAIL_SERVER_HOST", "EMAIL_SERVER_PORT", "EMAIL_SERVER_USER", "EMAIL_SERVER_PASSWORD"]) {
      const result = email(render({ app: { ...RELAY_ENV, [key]: "" } }));
      expect(result.passed, key).toBe(false);
      expect(result.stderr).toContain(`${key} is empty`);
    }
  });

  it("refuses a flag that is not true or false, and the state with none true", () => {
    const yes = email(render({ app: { ...RELAY_ENV, USE_SMTP_RELAY: "yes" } }));
    expect(yes.passed).toBe(false);
    expect(yes.stderr).toContain("USE_SMTP_RELAY must be true or false");
    const none = email(render({ app: { USE_AWS_SES: "false" } }));
    expect(none.passed).toBe(false);
    expect(none.stderr).toContain("Exactly one email provider flag must be true");
  });

  it("treats all three flags empty as the app's legacy AWS SES default", () => {
    const blank = { USE_AWS_SES: "", USE_SMTP_RELAY: "", USE_LOCAL_CAPTURE: "" };
    expect(email(render({ app: blank })).passed).toBe(true);
    const missingKey = email(render({ app: { ...blank, AWS_SES_SECRET_ACCESS_KEY: "" } }));
    expect(missingKey.passed).toBe(false);
    expect(missingKey.stderr).toContain("AWS_SES_SECRET_ACCESS_KEY is empty");
  });

  it("refuses a placeholder the provider needs", () => {
    const result = email(render({ app: { AWS_SES_ACCESS_KEY_ID: "changeme" } }));
    expect(result.passed).toBe(false);
    expect(result.stderr).toContain("AWS_SES_ACCESS_KEY_ID appears to be a placeholder");
  });

  it("checks every app service, so an overlay that changes one colour is caught", () => {
    const result = email(render({ perService: { app_green: { USE_SMTP_RELAY: "true" } } }));
    expect(result.passed).toBe(false);
    expect(result.stderr).toContain("'app_green' service");
  });

  describe("a capture mailbox", () => {
    const capture = { ...RELAY_ENV, USE_SMTP_RELAY: "false", USE_LOCAL_CAPTURE: "TRUE" };

    it("is refused on the role the gate validated as production, and when no role was validated", () => {
      for (const role of ["production", ""]) {
        const result = email(render({ app: capture }), role);
        expect(result.passed, role).toBe(false);
        expect(result.stderr).toContain("USE_LOCAL_CAPTURE=true is refused on the club's live site");
      }
    });

    it("needs the same four settings as a relay, as src/lib/email-delivery.ts reads them", () => {
      const ok = email(render({ app: capture }), "non-production");
      expect(ok.passed, ok.stderr).toBe(true);
      for (const key of ["EMAIL_SERVER_USER", "EMAIL_SERVER_PASSWORD"]) {
        const result = email(render({ app: { ...capture, [key]: "" } }), "non-production");
        expect(result.passed, key).toBe(false);
        expect(result.stderr).toContain(`${key} is empty`);
      }
    });

    it("consumes the role gate's canonical value rather than re-reading or re-folding it", () => {
      const body = shellFunctionSource(SCRIPT, "require_resolved_email_transport_for_service");
      expect(body).toContain('"$VALIDATED_ENVIRONMENT_ROLE" != "non-production"');
      expect(body).not.toMatch(/(env_file_value|env_value) APP_ENVIRONMENT_ROLE/);
      expect(shellFunctionSource(SCRIPT, "require_environment_role_env_key")).toContain(
        'VALIDATED_ENVIRONMENT_ROLE="$normalised"',
      );
    });
  });
});

/**
 * The preflight's provider rule is a MIRROR of the app's, so the two are run
 * side by side over the same inputs (INV-SSOT-002): every combination of the
 * three flags through `resolveEmailDeliveryConfigFromEnv`
 * (src/lib/email-delivery.ts) and through the extracted bash rule, with every
 * provider's settings present so only the flags decide. One bash process walks
 * every render, so the matrix costs one spawn rather than sixty-four.
 */
describe("the preflight's provider rule agrees with the app's (#4276 review)", { timeout: 240_000 }, () => {
  // `" true "` and `"  "` because the app's parseBooleanFlag trims.
  const FLAG_VALUES = ["", "true", "FALSE", "yes", " true ", "  "];
  const ALL_SETTINGS: EnvMap = {
    ...SES_ENV,
    EMAIL_SERVER_HOST: "mailpit",
    EMAIL_SERVER_PORT: "1025",
    EMAIL_SERVER_USER: "capture",
    EMAIL_SERVER_PASSWORD: "capture-secret",
  };
  const PARITY_HARNESS = `set -Eeuo pipefail
VALIDATED_ENVIRONMENT_ROLE=non-production
${lift([
  "trim_whitespace",
  "printable_deploy_value",
  "strip_matching_quotes",
  "compose_service_environment_entries",
  "compose_service_environment_value",
  "compose_render_scalar",
  "resolved_service_env_value",
  "value_looks_like_placeholder",
  "email_flag_is_true",
  "require_email_flag_is_boolean",
  "require_resolved_service_value",
  "require_resolved_email_transport_for_service",
])}
for render_file in renders/*.yml; do
  RESOLVED_COMPOSE_CONFIG="$(cat "$render_file")"
  if require_resolved_email_transport_for_service app 2>/dev/null; then
    printf '%s PASS\\n' "$render_file"
  else
    printf '%s REFUSE\\n' "$render_file"
  fi
done
`;

  type Case = { label: string; env: EnvMap };

  /** Only the service the rule reads, so each render is small. */
  function appRender(env: EnvMap): string {
    const lines = Object.keys(env)
      .sort()
      .map((key) => `      ${key}: ${yamlScalar(env[key])}`);
    return ["name: resolved", "services:", "  app:", "    environment:", ...lines, "    image: app:local", ""].join("\n");
  }

  /** One bash process per chunk, run concurrently: the matrix is a few hundred renders. */
  async function verdicts(cases: Case[]): Promise<Map<string, boolean>> {
    const CHUNKS = 8;
    const chunks = Array.from({ length: CHUNKS }, (_, chunk) =>
      cases.map((entry, index) => ({ entry, index })).filter(({ index }) => index % CHUNKS === chunk),
    ).filter((chunk) => chunk.length > 0);
    const outputs = await Promise.all(
      chunks.map(
        (chunk) =>
          new Promise<string>((resolve, reject) => {
            const dir = mkdtempSync(path.join(ROOT, "parity-"));
            mkdirSync(path.join(dir, "renders"));
            for (const { entry, index } of chunk) {
              writeFileSync(path.join(dir, "renders", `${String(index).padStart(3, "0")}.yml`), appRender(entry.env), "utf8");
            }
            writeFileSync(path.join(dir, "harness.sh"), PARITY_HARNESS, "utf8");
            const child = spawn("bash", bashGateArgs(bashFixturePath(path.join(dir, "harness.sh"), dir)), { cwd: dir });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (data: Buffer) => (stdout += data.toString("utf8")));
            child.stderr.on("data", (data: Buffer) => (stderr += data.toString("utf8")));
            child.on("error", reject);
            child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`parity harness exited ${code}: ${stderr}`))));
          }),
      ),
    );
    const lines = outputs.flatMap((output) => output.trim().split("\n"));
    expect(lines).toHaveLength(cases.length);
    return new Map(
      lines.map((line) => {
        const [file, verdict] = line.split(" ");
        return [cases[Number(path.basename(file, ".yml"))].label, verdict === "PASS"];
      }),
    );
  }

  function appAccepts(env: EnvMap): boolean {
    return resolveEmailDeliveryConfigFromEnv({ ...env, EMAIL_FROM: "bookings@club.test" }).ok;
  }

  it("accepts exactly the flag combinations the app accepts", async () => {
    const cases: Case[] = [];
    for (const ses of FLAG_VALUES)
      for (const relay of FLAG_VALUES)
        for (const capture of FLAG_VALUES)
          cases.push({
            label: `USE_AWS_SES=${ses} USE_SMTP_RELAY=${relay} USE_LOCAL_CAPTURE=${capture}`,
            env: { ...ALL_SETTINGS, USE_AWS_SES: ses, USE_SMTP_RELAY: relay, USE_LOCAL_CAPTURE: capture },
          });
    const bash = await verdicts(cases);
    const disagreements = cases
      .filter((entry) => bash.get(entry.label) !== appAccepts(entry.env))
      .map((entry) => `${entry.label}: preflight ${bash.get(entry.label) ? "passes" : "refuses"}, app ${appAccepts(entry.env) ? "accepts" : "refuses"}`);
    expect(disagreements).toEqual([]);
    // Both outcomes are exercised, so an always-pass or always-refuse rule fails.
    expect(new Set(bash.values()).size).toBe(2);
  });

  it("refuses wherever the app refuses for a missing setting of the selected provider", async () => {
    const modes: Array<[string, EnvMap, string[]]> = [
      ["aws-ses", { USE_AWS_SES: "true", USE_SMTP_RELAY: "false", USE_LOCAL_CAPTURE: "false" }, ["AWS_SES_ACCESS_KEY_ID", "AWS_SES_SECRET_ACCESS_KEY"]],
      ["smtp-relay", { USE_AWS_SES: "false", USE_SMTP_RELAY: "true", USE_LOCAL_CAPTURE: "false" }, ["EMAIL_SERVER_HOST", "EMAIL_SERVER_PORT", "EMAIL_SERVER_USER", "EMAIL_SERVER_PASSWORD"]],
      ["local-capture", { USE_AWS_SES: "false", USE_SMTP_RELAY: "false", USE_LOCAL_CAPTURE: "true" }, ["EMAIL_SERVER_HOST", "EMAIL_SERVER_PORT", "EMAIL_SERVER_USER", "EMAIL_SERVER_PASSWORD"]],
    ];
    const cases: Case[] = modes.flatMap(([mode, flags, keys]) =>
      keys.map((key) => ({ label: `${mode} without ${key}`, env: { ...ALL_SETTINGS, ...flags, [key]: "" } })),
    );
    for (const entry of cases) expect(appAccepts(entry.env), entry.label).toBe(false);
    const bash = await verdicts(cases);
    for (const entry of cases) expect(bash.get(entry.label), entry.label).toBe(false);
  });
});

describe("step 3 checks Postgres's max_connections as the postgres command would carry it (#4275)", RUN, () => {
  const pg = (setting: string | string[] | null) =>
    check(
      "validate_resolved_postgres_max_connections",
      render({
        postgresCommand:
          setting === null
            ? ["postgres", "-c", "shared_buffers=128MB"]
            : ["postgres", ...(Array.isArray(setting) ? setting : [setting]).flatMap((item) => ["-c", item])],
      }),
    );

  it("passes the shipped 40 and a raised, quoted 80", () => {
    expect(pg("max_connections=40").passed).toBe(true);
    expect(pg('"max_connections=80"').passed).toBe(true);
  });

  it("refuses a value PostgreSQL could not parse, before the container is recreated, saying where to set it", () => {
    const result = pg("max_connections=abc");
    expect(result.passed).toBe(false);
    expect(result.stderr).toContain("POSTGRES_MAX_CONNECTIONS must be a whole number between 28 and 1000");
    expect(result.stderr).toContain("set POSTGRES_MAX_CONNECTIONS in .env. Got: abc");
  });

  it("reads a leading-zero connection_limit as decimal, not octal", () => {
    // app_blue's pool is 08 here: eight, so the pools sum to 25 and the floor is 26.
    const rendered = (maxConnections: number) =>
      render({
        perService: { app_blue: { DATABASE_URL: url("08") } },
        postgresCommand: ["postgres", "-c", `max_connections=${maxConnections}`],
      });
    const at = check("validate_resolved_postgres_max_connections", rendered(26));
    expect(at.passed, at.stderr).toBe(true);
    const below = check("validate_resolved_postgres_max_connections", rendered(25));
    expect(below.passed).toBe(false);
    expect(below.stderr).toContain("must be between 26 and 1000");
  });

  it("refuses a ceiling at or below the pools the render can open together (10+10+5+2)", () => {
    const low = pg("max_connections=27");
    expect(low.passed).toBe(false);
    expect(low.stderr).toContain("must be between 28 and 1000");
    expect(pg("max_connections=28").passed).toBe(true);
  });

  it("refuses a typo above the ceiling", () => {
    expect(pg("max_connections=1000").passed).toBe(true);
    expect(pg("max_connections=8000").passed).toBe(false);
  });

  it("reads the LAST setting, as PostgreSQL does, and leaves a command without one alone", () => {
    expect(pg(["max_connections=40", "max_connections=abc"]).passed).toBe(false);
    expect(pg(null).passed).toBe(true);
  });
});

describe("Caddy is validated with the TLS mode and settings it will run with (#4275)", RUN, () => {
  it("refuses a TLS mode with no snippet, as the caddy service would receive it", () => {
    for (const mode of ["acme", "local"]) {
      const result = check("require_resolved_caddy_tls_mode", render({ caddy: { CADDY_TLS_MODE: mode } }));
      expect(result.passed, `${mode}: ${result.stderr}`).toBe(true);
    }
    for (const mode of ["", "Local", "staging"]) {
      const result = check("require_resolved_caddy_tls_mode", render({ caddy: { CADDY_TLS_MODE: mode } }));
      expect(result.passed, mode).toBe(false);
      expect(result.stderr).toContain("CADDY_TLS_MODE must be 'acme'");
      expect(result.stderr).toContain("Set it in .env.");
    }
  });

  it("requires an explicit trusted proxy in local mode, and never every address", () => {
    const proxies = (mode: string, value: string) =>
      check(
        "require_resolved_caddy_trusted_proxies",
        render({ caddy: { CADDY_TLS_MODE: mode, CADDY_TRUSTED_PROXIES: value } }),
      );
    expect(proxies("local", "10.0.0.2/32").passed).toBe(true);
    expect(proxies("local", "10.0.0.5 10.0.0.2/32").passed).toBe(true);
    // Unused in acme mode, so nothing is demanded there.
    expect(proxies("acme", "").passed).toBe(true);
    const missing = proxies("local", "");
    expect(missing.passed).toBe(false);
    expect(missing.stderr).toContain("CADDY_TLS_MODE=local needs CADDY_TRUSTED_PROXIES");
    expect(missing.stderr).toContain("set in .env");
    // What Compose hands Caddy when .env leaves it unset.
    const sentinel = proxies("local", TRUSTED_PROXIES_SENTINEL);
    expect(sentinel.passed).toBe(false);
    expect(sentinel.stderr).toContain("CADDY_TLS_MODE=local needs CADDY_TRUSTED_PROXIES");
    for (const everything of [
      "0.0.0.0/0",
      "10.0.0.2/32 ::/0",
      "0::/0",
      "::0/0",
      "0:0:0:0:0:0:0:0/0",
      "10.0.0.2/32 0.0.0.0/00",
    ]) {
      const result = proxies("local", everything);
      expect(result.passed, everything).toBe(false);
      expect(result.stderr).toContain("not every address");
    }
    for (const notAnAddress of ["10.0.0.2/32 }", "10.0.0.2/32,10.0.0.3/32", "proxy.lan", "10.0.0.2\\n10.0.0.3"]) {
      const result = proxies("local", notAnAddress);
      expect(result.passed, notAnAddress).toBe(false);
      expect(result.stderr).toContain("must be IP addresses or CIDRs");
    }
    for (const broad of ["private_ranges", "10.0.0.2/32 private_ranges"]) {
      const result = proxies("local", broad);
      expect(result.passed, broad).toBe(false);
      expect(result.stderr).toContain("not private_ranges");
    }
  });

  it("gives an unset trusted-proxy list a placeholder Caddy rejects, not an empty list", () => {
    // Set-but-empty would validate and trust no proxy; Caddy's own default
    // applies only when the variable is unset, which Compose never leaves it.
    expect(readRepoFile("docker-compose.yml")).toContain(
      `CADDY_TRUSTED_PROXIES: \${CADDY_TRUSTED_PROXIES:-${TRUSTED_PROXIES_SENTINEL}}`,
    );
  });

  it("refuses a render whose caddy service has no DOMAIN", () => {
    const result = check("validate_caddy_contract", render({ caddy: { DOMAIN: "" } }));
    expect(result.passed).toBe(false);
    expect(result.stderr).toContain("DOMAIN is empty");
  });

  it("hands the validation container the caddy service's whole resolved environment, decoded, in a file", () => {
    const result = check(
      "validate_caddy_contract",
      render({
        caddy: {
          CADDY_TLS_MODE: "local",
          CADDY_TRUSTED_PROXIES: "10.0.0.3/32",
          MEET_HOST: "",
          // As the render writes them: Compose's `$$` for a literal `$`, and a
          // double-quoted scalar with an escaped quote.
          MIROTALK_UPSTREAM: "mirotalk$$1:3010",
          EXTRA_SETTING: '"say \\"hi\\""',
        },
      }),
    );
    expect(result.passed, result.stderr).toBe(true);
    const envFile = readFileSync(path.join(result.dir, "docker.env"), "utf8").trimEnd().split("\n");
    expect(envFile.sort()).toEqual(
      [
        "CADDY_TLS_MODE=local",
        "CADDY_TRUSTED_PROXIES=10.0.0.3/32",
        "DOMAIN=bookings.club.test",
        'EXTRA_SETTING=say "hi"',
        "MEET_HOST=",
        "MIROTALK_UPSTREAM=mirotalk$1:3010",
      ].sort(),
    );
    // Nothing from the environment on the command line, where a process
    // listing would show it.
    const args = readFileSync(path.join(result.dir, "docker.args"), "utf8").trimEnd().split("\n");
    expect(args).not.toContain("-e");
    expect(args.join(" ")).not.toContain("10.0.0.3/32");
    expect(args.slice(-3)).toEqual(["validate", "--config", "/etc/caddy/Caddyfile"]);
    // Removed once validated, and private while it existed.
    expect(result.stdout).not.toContain("LEFTOVER-ENV-FILE");
    if (process.platform !== "win32") {
      expect(readFileSync(path.join(result.dir, "docker.envmode"), "utf8").trim()).toBe("600");
    }
  });
});

describe("the step-3 wiring (#4275)", () => {
  it("renders the Compose model once, then runs every resolved check before step 4", () => {
    expect(SCRIPT.split('docker compose --profile "$MIGRATE_SERVICE" config').length - 1).toBe(1);
    const step3 = SCRIPT.indexOf('step "3/20"');
    const step4 = SCRIPT.indexOf('step "4/20"');
    const calls = [
      "\nvalidate_env_contract\n",
      "\nrender_resolved_compose_config\n",
      "\nvalidate_migration_lock_timeout_contract\n",
      "\nvalidate_resolved_email_transport\n",
      "\nrequire_resolved_caddy_tls_mode\n",
      "\nrequire_resolved_caddy_trusted_proxies\n",
      "\nvalidate_resolved_postgres_max_connections\n",
    ].map((call) => {
      expect(SCRIPT.split(call).length - 1, call).toBe(1);
      return SCRIPT.indexOf(call);
    });
    expect(calls[0]).toBeGreaterThan(step3);
    for (let i = 1; i < calls.length; i++) expect(calls[i]).toBeGreaterThan(calls[i - 1]);
    expect(calls[calls.length - 1]).toBeLessThan(step4);
    // The Caddy validation at step 4 reads that render; both run before the migration.
    const caddy = SCRIPT.indexOf("\nvalidate_caddy_contract\n");
    expect(caddy).toBeGreaterThan(step4);
    expect(SCRIPT.indexOf('step "13/20"')).toBeGreaterThan(caddy);
  });

  it("no longer reads the provider flags or the TLS mode from the .env file", () => {
    expect(SCRIPT).not.toMatch(/get_env_file_value (USE_AWS_SES|USE_SMTP_RELAY|USE_LOCAL_CAPTURE|CADDY_TLS_MODE)\b/);
    const contract = shellFunctionSource(SCRIPT, "validate_env_contract");
    for (const key of ["AWS_SES_ACCESS_KEY_ID", "AWS_SES_SECRET_ACCESS_KEY", "SES_SNS_TOPIC_ARN", "SMTP_HOST", "SMTP_PORT"]) {
      expect(contract).not.toContain(`require_non_placeholder_env_key ${key}`);
    }
    // EMAIL_FROM is provider-independent and stays where it was.
    expect(contract).toContain("require_non_placeholder_env_key EMAIL_FROM");
  });

  it("keeps the flag test in the engine, never the wrapper's looser env_flag_is_true", () => {
    // Everything above `run_internal_blue_green_deploy` (bar the file-level
    // readers) is nested inside `run_production_wrapper`, which the engine
    // re-entry never calls — so a wrapper helper is "command not found" at step 3.
    const engineStart = SCRIPT.indexOf("\nrun_internal_blue_green_deploy() {");
    for (const name of ["email_flag_is_true", "require_resolved_email_transport_for_service"]) {
      expect(SCRIPT.indexOf(`\n${name}() {`), name).toBeGreaterThan(engineStart);
    }
    expect(shellFunctionSource(SCRIPT, "require_resolved_email_transport_for_service")).not.toMatch(
      /(^|[^_])env_flag_is_true/,
    );
  });
});

/** The acme snippet as #4275 shipped it; local mode's trust change must not touch it. */
const ACME_SNIPPET = `# CADDY_TLS_MODE=acme (the default): Caddy is the public edge and obtains its
# certificates from Let's Encrypt itself, which is Caddy's own default — so
# this snippet adds nothing. It exists so the Caddyfile's single
# \`import /etc/caddy/deploy/tls-{$CADDY_TLS_MODE:acme}.caddy\` resolves to a
# file in every mode. The alternative is \`tls-local.caddy\`.
# No proxy is trusted in this mode: Caddy IS the edge, so \`{client_ip}\` is the
# connecting peer and a visitor cannot forge it through X-Forwarded-For.
`;

describe("the remaining #4275 settings", () => {
  it("treats the legacy dashboard export token as optional, refusing only a placeholder", () => {
    const contract = shellFunctionSource(SCRIPT, "validate_env_contract");
    expect(contract).not.toContain("require_non_placeholder_env_key LEGACY_DASHBOARD_EXPORT_TOKEN");
    expect(contract).toContain("require_optional_non_placeholder_env_key LEGACY_DASHBOARD_EXPORT_TOKEN");
    const helper = shellFunctionSource(SCRIPT, "require_optional_non_placeholder_env_key");
    expect(helper).toContain('if [ -z "$value" ]; then\n    return 0');
    expect(helper).toContain("value_looks_like_placeholder");
    expect(helper).not.toContain("require_env_key");
  });

  it("accepts exactly the TLS modes there are snippet files for", () => {
    const snippets = ["acme", "local"].map((mode) => readRepoFile(`deploy/caddy/tls-${mode}.caddy`));
    expect(snippets[0]).not.toMatch(/^\s*local_certs/m);
    expect(snippets[1]).toMatch(/^local_certs$/m);
    expect(shellFunctionSource(SCRIPT, "require_resolved_caddy_tls_mode")).toContain("acme|local) return 0 ;;");
    expect(readRepoFile("Caddyfile")).toContain("import /etc/caddy/deploy/tls-{$CADDY_TLS_MODE:acme}.caddy");
    expect(readRepoFile("docker-compose.yml")).toContain("CADDY_TLS_MODE: ${CADDY_TLS_MODE:-acme}");
  });

  it("forwards the visitor's IP, not the proxy's, in both TLS modes", () => {
    const local = readRepoFile("deploy/caddy/tls-local.caddy").replace(/\r\n/g, "\n");
    // Local mode trusts exactly the configured proxy list — no default — and
    // reads the forwarded header strictly, inside the one `servers` block.
    const servers = /^servers \{\n([\s\S]*?)\n\}$/m.exec(local)?.[1] ?? "";
    expect(servers.split("\n").map((line) => line.trim())).toEqual([
      "trusted_proxies static {$CADDY_TRUSTED_PROXIES}",
      "trusted_proxies_strict",
      "client_ip_headers X-Forwarded-For",
    ]);
    expect(local).not.toMatch(/^[^#]*private_ranges/m);
    // ACME mode is unchanged, byte for byte: it trusts no proxy at all.
    expect(readRepoFile("deploy/caddy/tls-acme.caddy").replace(/\r\n/g, "\n")).toBe(ACME_SNIPPET);
    const forward = "header_up X-Forwarded-For {client_ip}";
    expect(readRepoFile("deploy/caddy/tacbookings-active.caddy")).toContain(forward);
    expect(readRepoFile("Caddyfile.staging")).toContain(forward);
    // Both generators of the active snippet (the wrapper's and the engine's).
    expect(SCRIPT.split(`echo "  ${forward}"`).length - 1).toBe(2);
    expect(readRepoFile("docker-compose.yml")).toContain(
      `CADDY_TRUSTED_PROXIES: \${CADDY_TRUSTED_PROXIES:-${TRUSTED_PROXIES_SENTINEL}}`,
    );
  });
});
