#!/usr/bin/env node
/**
 * Runs the Docker-only first install exactly as `DEPLOYMENT.md` "First
 * Bootstrap" writes it, against an empty database, and proves it leaves a club
 * somebody can sign in to (#4977, INV-OPS-017).
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
 * 1. Takes `docker compose up -d --build postgres`, `docker compose run --rm
 *    migrate` and `docker compose run --rm seed` from the section's fenced
 *    block, refusing to run if any is missing or they are out of order.
 * 2. Writes `.env` the way the doc does — `cp .env.example .env`, then edit —
 *    with throwaway values generated here. Never a repository secret.
 * 3. Runs postgres and migrate, then the seed with SEED_ADMIN_EMAIL emptied:
 *    it must fail naming the variable and write nothing.
 * 4. Runs the seed: exit 0, an active ADMIN member with SEED_ADMIN_EMAIL, and
 *    the lodge kiosk account at the NEXTAUTH_URL domain, not @example.org.
 * 5. Runs the seed again: exit 0, and every table's row count and both seeded
 *    password hashes unchanged.
 * 6. Fails if a seed password appears in anything the seed printed.
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

/** The three steps the smoke runs, in the order the doc must give them. */
const STEPS = [
  { name: "postgres", pattern: /^docker compose up -d (?:--build )?postgres$/ },
  { name: "migrate", pattern: /^docker compose run --rm migrate$/ },
  { name: "seed", pattern: /^docker compose run --rm seed$/ },
];

/**
 * The first fenced code block under the First Bootstrap heading.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function firstBootstrapBlock(markdown) {
  const start = markdown.indexOf(`\n${FIRST_BOOTSTRAP_HEADING}\n`);
  if (start < 0) {
    throw new Error(`${DEPLOYMENT_DOC} has no "${FIRST_BOOTSTRAP_HEADING}" section.`);
  }
  const section = markdown.slice(start + 1);
  const nextHeading = section.slice(FIRST_BOOTSTRAP_HEADING.length).search(/\n## /);
  const body = nextHeading < 0
    ? section
    : section.slice(0, FIRST_BOOTSTRAP_HEADING.length + nextHeading);
  const fence = /```[a-z]*\n([\s\S]*?)\n```/.exec(body);
  if (!fence) {
    throw new Error(`"${FIRST_BOOTSTRAP_HEADING}" in ${DEPLOYMENT_DOC} has no fenced command block.`);
  }
  return fence[1];
}

/**
 * The postgres, migrate and seed commands, verbatim from the doc, in order.
 *
 * @param {string} markdown
 * @returns {{ postgres: string, migrate: string, seed: string }}
 */
export function firstInstallCommands(markdown) {
  const lines = firstBootstrapBlock(markdown).split("\n").map((line) => line.trim());
  /** @type {Record<string, string>} */
  const found = {};
  let previous = -1;
  for (const step of STEPS) {
    const index = lines.findIndex((line) => step.pattern.test(line));
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
    found[step.name] = lines[index];
  }
  return { postgres: found.postgres, migrate: found.migrate, seed: found.seed };
}

function secret() {
  return randomBytes(18).toString("hex");
}

/**
 * @param {string} command
 * @param {Record<string, string>} [extraEnv]
 */
function run(command, extraEnv = {}) {
  console.log(`\n$ ${command}`);
  const result = spawnSync("bash", ["-c", command], {
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
  const commands = firstInstallCommands(fs.readFileSync(DEPLOYMENT_DOC, "utf8"));
  if (fs.existsSync(".env")) {
    throw new Error("Refusing to run: .env exists, and this smoke writes and deletes its own.");
  }

  const adminEmail = "first-install-smoke@example.org";
  const clubHost = "club.example.test";
  const adminPassword = secret();
  const lodgePassword = secret();
  // `cp .env.example .env`, then edit — as the doc says. Compose reads the
  // last value of a repeated key, so the overrides go at the end.
  fs.copyFileSync(".env.example", ".env");
  fs.chmodSync(".env", 0o600);
  fs.appendFileSync(
    ".env",
    [
      "",
      "# first-install smoke (scripts/ci/first-install-smoke.mjs): throwaway values",
      `DB_PASSWORD=${secret()}`,
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
    for (const step of ["postgres", "migrate"]) {
      const result = run(commands[step]);
      console.log(result.output);
      check(result.status === 0, `\`${commands[step]}\` exits 0`);
    }

    const migrated = fingerprint();
    // An empty shell variable outranks .env in Compose interpolation, so the
    // service receives SEED_ADMIN_EMAIL="" without the command changing.
    const missing = run(commands.seed, { SEED_ADMIN_EMAIL: "" });
    console.log(missing.output);
    seedOutput.push(missing.output);
    check(missing.status !== 0, "the seed fails when SEED_ADMIN_EMAIL is unset");
    check(
      missing.output.includes("SEED_ADMIN_EMAIL is required"),
      "the failure names SEED_ADMIN_EMAIL",
    );
    check(fingerprint() === migrated, "the failed seed wrote nothing");

    const first = run(commands.seed);
    console.log(first.output);
    seedOutput.push(first.output);
    check(first.status === 0, `\`${commands.seed}\` exits 0`);
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
    const second = run(commands.seed);
    console.log(second.output);
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
