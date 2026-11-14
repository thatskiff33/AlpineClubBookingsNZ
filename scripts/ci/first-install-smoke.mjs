#!/usr/bin/env node
/**
 * Runs the Docker-only first install exactly as `DEPLOYMENT.md` "First
 * Bootstrap" writes it, against an empty database, and proves it leaves a club
 * somebody can sign in to (#4977, INV-OPS-019).
 *
 * ## Why
 *
 * The seed step went missing from that section, and the command three other
 * docs gave ran the seed in the app container, whose image holds no source. CI
 * seeded from the host with `pnpm exec tsx`, so nothing ran what an operator is
 * told to run, and nothing failed. This script reads the commands out of the
 * doc rather than holding its own copy, so the doc cannot drift from what CI
 * runs.
 *
 * ## What it does
 *
 * 1. Takes the section's fenced blocks and finds each step by the command it
 *    contains: copy `.env`, start postgres, migrate as the operator, provision
 *    the database roles, switch the roles on in `.env`, seed, start the app. It
 *    refuses to run if one is missing or they are out of order.
 * 2. Writes `.env` the way the doc does (`cp .env.example .env`, then edit)
 *    with throwaway values generated here, and fills the doc's
 *    `<your-...-password>` placeholders with them. Never a repository secret.
 * 3. Runs postgres, migrate and the role provisioning, applies the doc's `.env`
 *    switch, then runs the seed with SEED_ADMIN_EMAIL emptied: it must fail
 *    naming the variable and write nothing.
 * 4. Runs the seed: exit 0, an active ADMIN member with SEED_ADMIN_EMAIL, and
 *    the lodge kiosk account at the NEXTAUTH_URL domain, not @example.org.
 * 5. Runs the seed again: exit 0, and every table's row count and both seeded
 *    password hashes unchanged.
 * 6. Fails if a seed password appears in anything the seed printed.
 *
 * It does not run the last step, which builds and starts the web slots and
 * Caddy: the app's own image checks run beside it in the same job.
 *
 * ## Isolation
 *
 * Runs under its own Compose project (COMPOSE_PROJECT_NAME, which outranks the
 * directory name without changing the commands), so the closing `down -v`
 * removes only this project's volume. It refuses to start over an existing
 * `.env`, which it would otherwise overwrite and delete.
 *
 * Set MIGRATE_IMAGE to an image already built from the Dockerfile's builder
 * stage (CI builds it from the same cache as the app image); unset, the
 * documented commands build it.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";

import { isMainModule } from "../lib/is-main-module.mjs";

export const DEPLOYMENT_DOC = "DEPLOYMENT.md";
export const FIRST_BOOTSTRAP_HEADING = "## First Bootstrap";
export const SMOKE_PROJECT = "tacbookings-first-install-smoke";

/**
 * The steps the doc must give, in order. Each is found as the first fenced block
 * that holds a line matching `pattern` (shell continuation lines joined).
 * `apply` says what the smoke does with the block: run it, append it to `.env`,
 * or only require that it exists in this place.
 *
 * @type {ReadonlyArray<{ name: string, pattern: RegExp, apply: "run" | "dotenv" | "require" }>}
 */
const STEPS = [
  { name: "copy", pattern: /^cp \.env\.example \.env$/, apply: "require" },
  { name: "postgres", pattern: /^docker compose up -d (?:--build )?postgres$/, apply: "run" },
  {
    name: "migrate",
    pattern: /^docker compose --profile migrate run --rm -e DATABASE_URL migrate$/,
    apply: "run",
  },
  {
    name: "provision",
    pattern: /\bprovision-database-roles\.ts --apply$/,
    apply: "run",
  },
  { name: "switch", pattern: /^APP_DB_USER=\S+$/, apply: "dotenv" },
  { name: "seed", pattern: /^docker compose run --rm seed$/, apply: "run" },
  {
    name: "start",
    pattern: /^docker compose up -d --build app app_blue app_green caddy$/,
    apply: "require",
  },
];

/**
 * The doc's placeholders, and the `.env` value each stands for.
 *
 * @type {Readonly<Record<string, string>>}
 */
const PLACEHOLDERS = {
  "<your-operator-password>": "DB_PASSWORD",
  "<your-migration-password>": "MIGRATION_DB_PASSWORD",
  "<your-app-password>": "APP_DB_PASSWORD",
  "<your-retention-password>": "AUDIT_RETENTION_DB_PASSWORD",
};

/**
 * Every fenced code block under the First Bootstrap heading, in order, however
 * far a list item indents it, with the indent removed.
 *
 * @param {string} markdown
 * @returns {Array<{ lang: string, text: string }>}
 */
export function firstBootstrapBlocks(markdown) {
  const start = markdown.indexOf(`\n${FIRST_BOOTSTRAP_HEADING}\n`);
  if (start < 0) {
    throw new Error(`${DEPLOYMENT_DOC} has no "${FIRST_BOOTSTRAP_HEADING}" section.`);
  }
  const section = markdown.slice(start + 1);
  const nextHeading = section.slice(FIRST_BOOTSTRAP_HEADING.length).search(/\n## /);
  const body = nextHeading < 0
    ? section
    : section.slice(0, FIRST_BOOTSTRAP_HEADING.length + nextHeading);
  /** @type {Array<{ lang: string, text: string }>} */
  const blocks = [];
  const fence = /^([ \t]*)```([a-z]*)\n([\s\S]*?)\n\1```$/gm;
  for (const match of body.matchAll(fence)) {
    const indent = match[1];
    const text = match[3]
      .split("\n")
      .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
      .join("\n");
    blocks.push({ lang: match[2], text });
  }
  if (blocks.length === 0) {
    throw new Error(`"${FIRST_BOOTSTRAP_HEADING}" in ${DEPLOYMENT_DOC} has no fenced command block.`);
  }
  return blocks;
}

/**
 * One shell command per line: a trailing backslash continues the line.
 *
 * @param {string} text
 */
function commandLines(text) {
  return text
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim());
}

/**
 * The step blocks, verbatim from the doc, in the order the doc must give them.
 *
 * @param {string} markdown
 * @returns {Record<string, { text: string, line: string }>} by step name; `line`
 *   is the matching command, `text` the whole block.
 */
export function firstInstallSteps(markdown) {
  const blocks = firstBootstrapBlocks(markdown);
  /** @type {Record<string, { text: string, line: string }>} */
  const found = {};
  let previous = -1;
  for (const step of STEPS) {
    let index = -1;
    let line = "";
    for (let i = 0; i < blocks.length && index < 0; i += 1) {
      const hit = commandLines(blocks[i].text).find((candidate) => step.pattern.test(candidate));
      if (hit !== undefined) {
        index = i;
        line = hit;
      }
    }
    if (index < 0) {
      throw new Error(
        `"${FIRST_BOOTSTRAP_HEADING}" in ${DEPLOYMENT_DOC} has no ${step.name} step ` +
          `(a line matching ${step.pattern}).`,
      );
    }
    if (index < previous) {
      throw new Error(
        `"${FIRST_BOOTSTRAP_HEADING}" in ${DEPLOYMENT_DOC} gives the ${step.name} step out of order.`,
      );
    }
    previous = index;
    found[step.name] = { text: blocks[index].text, line };
  }
  return found;
}

/**
 * The doc's `<your-...-password>` placeholders, replaced by this run's values.
 * A placeholder this script does not know is an error, not a command to run.
 *
 * @param {string} text
 * @param {Record<string, string>} values by `.env` name
 */
export function fillPlaceholders(text, values) {
  let filled = text;
  for (const [placeholder, name] of Object.entries(PLACEHOLDERS)) {
    filled = filled.split(placeholder).join(values[name]);
  }
  const left = /<your-[a-z-]+>/.exec(filled);
  if (left) throw new Error(`${DEPLOYMENT_DOC} gives a placeholder this smoke cannot fill: ${left[0]}`);
  return filled;
}

function secret() {
  return randomBytes(18).toString("hex");
}

/** Throwaway passwords this run generated, so the log never prints one. */
const generated = new Set();

/** @param {string} text */
function redact(text) {
  let out = text;
  for (const value of generated) out = out.split(value).join("<throwaway>");
  return out;
}

/**
 * @param {string} command
 * @param {Record<string, string>} [extraEnv]
 */
function run(command, extraEnv = {}) {
  console.log(`\n$ ${redact(command)}`);
  const result = spawnSync("bash", ["-ec", command], {
    env: { ...process.env, COMPOSE_PROJECT_NAME: SMOKE_PROJECT, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { status: result.status, output };
}

/** @param {string} sql */
function psql(sql) {
  const result = spawnSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-U", "tac", "-d", "tacbookings", "-v", "ON_ERROR_STOP=1", "-tAc", sql],
    { env: { ...process.env, COMPOSE_PROJECT_NAME: SMOKE_PROJECT }, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Every public table's row count plus the seeded accounts' password hashes. */
function fingerprint() {
  return psql(`
    SELECT string_agg(
      table_name || '=' || (xpath('/row/c/text()', query_to_xml(
        format('SELECT count(*) AS c FROM public.%I', table_name), false, true, ''
      )))[1]::text,
      ',' ORDER BY table_name
    ) || ';' || coalesce(
      (SELECT string_agg("passwordHash", ',' ORDER BY email) FROM "Member" WHERE role IN ('ADMIN', 'LODGE')),
      ''
    )
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
}

/**
 * @param {boolean} condition
 * @param {string} message
 */
function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok - ${message}`);
}

function main() {
  const steps = firstInstallSteps(fs.readFileSync(DEPLOYMENT_DOC, "utf8"));
  if (fs.existsSync(".env")) {
    throw new Error("Refusing to run: .env exists, and this smoke writes and deletes its own.");
  }

  const adminEmail = "first-install-smoke@example.org";
  const clubHost = "club.example.test";
  const adminPassword = secret();
  const lodgePassword = secret();
  /** The values the doc's step 2 has the operator choose. */
  const values = {
    DB_PASSWORD: secret(),
    APP_DB_PASSWORD: secret(),
    MIGRATION_DB_PASSWORD: secret(),
    AUDIT_RETENTION_DB_PASSWORD: secret(),
  };
  for (const value of [...Object.values(values), adminPassword, lodgePassword]) generated.add(value);

  // `cp .env.example .env`, then edit, as the doc says. Compose reads the last
  // value of a repeated key, so the overrides go at the end.
  fs.copyFileSync(".env.example", ".env");
  fs.chmodSync(".env", 0o600);
  fs.appendFileSync(
    ".env",
    [
      "",
      "# first-install smoke (scripts/ci/first-install-smoke.mjs): throwaway values",
      ...Object.entries(values).map(([name, value]) => `${name}=${value}`),
      `AUTH_SECRET=${secret()}`,
      `DATA_ENCRYPTION_KEYS=k2026:${randomBytes(32).toString("base64")}`,
      "APP_ENVIRONMENT_ROLE=non-production",
      `NEXTAUTH_URL=https://${clubHost}`,
      `SEED_ADMIN_EMAIL=${adminEmail}`,
      `SEED_ADMIN_PASSWORD=${adminPassword}`,
      `SEED_LODGE_PASSWORD=${lodgePassword}`,
      "",
    ].join("\n"),
  );

  /** @type {string[]} */
  const seedOutput = [];
  try {
    // Everything before the seed, in the doc's order.
    for (const step of STEPS) {
      if (step.name === "seed") break;
      if (step.apply === "dotenv") {
        fs.appendFileSync(".env", `\n${fillPlaceholders(steps[step.name].text, values)}\n`);
        console.log(`\n# appended the doc's ${step.name} block to .env`);
      } else if (step.apply === "run") {
        const result = run(fillPlaceholders(steps[step.name].text, values));
        console.log(redact(result.output));
        check(result.status === 0, `the doc's ${step.name} step exits 0`);
      }
    }

    const seed = steps.seed.line;
    const migrated = fingerprint();
    // An empty shell variable outranks .env in Compose interpolation, so the
    // service receives SEED_ADMIN_EMAIL="" without the command changing.
    const missing = run(seed, { SEED_ADMIN_EMAIL: "" });
    console.log(redact(missing.output));
    seedOutput.push(missing.output);
    check(missing.status !== 0, "the seed fails when SEED_ADMIN_EMAIL is unset");
    check(
      missing.output.includes("SEED_ADMIN_EMAIL is required"),
      "the failure names SEED_ADMIN_EMAIL",
    );
    check(fingerprint() === migrated, "the failed seed wrote nothing");

    const first = run(seed);
    console.log(redact(first.output));
    seedOutput.push(first.output);
    check(first.status === 0, `\`${seed}\` exits 0`);
    const admins = psql(
      `SELECT count(*) FROM "Member" WHERE role = 'ADMIN' AND active AND "canLogin" AND email = '${adminEmail}'`,
    );
    check(admins === "1", "the seed created an active admin who can sign in");
    const lodgeAccounts = psql(`SELECT string_agg(email, ',') FROM "Member" WHERE role = 'LODGE'`);
    check(
      lodgeAccounts === `lodge@${clubHost}`,
      "the seed created one lodge kiosk account, at the club's NEXTAUTH_URL domain",
    );

    const seeded = fingerprint();
    const second = run(seed);
    console.log(redact(second.output));
    seedOutput.push(second.output);
    check(second.status === 0, "a second seed run exits 0");
    check(fingerprint() === seeded, "a second seed run changes nothing");

    const printed = seedOutput.join("\n");
    check(
      !printed.includes(adminPassword) && !printed.includes(lodgePassword),
      "no seed password appears in the seed's output",
    );
  } finally {
    run("docker compose down -v --remove-orphans");
    fs.rmSync(".env", { force: true });
  }
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`first-install smoke failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
