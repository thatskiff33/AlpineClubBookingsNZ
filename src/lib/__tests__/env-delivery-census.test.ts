import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BASE_COMPOSE,
  composeFiles,
  composeServices,
  NON_APP_COMPOSE_SERVICES,
  readRepoFile,
} from "@/lib/__tests__/helpers/compose";

/**
 * A SETTING AN OPERATOR CAN SEE IN THEIR `.env` MUST ACTUALLY REACH THE APP
 * (ENV-SAFETY 2, #3035; epic #2986; INV-CONFIG-004).
 *
 * ## The defect this exists for, and why nothing else caught it
 *
 * `docker compose --env-file X` feeds Compose **interpolation** only. It injects
 * nothing into a container. A variable that is not named in a service's
 * `environment:` map — directly or through the `x-app-environment` anchor —
 * simply does not exist for the application, however carefully an env file, an
 * env example or a CI heredoc sets it.
 *
 * #3035's first cut shipped exactly that. `.env.staging.example` and both E2E
 * workflow heredocs set `USE_LOCAL_CAPTURE=true`; no Compose file named it; so
 * the E2E app container saw `USE_AWS_SES=false`, `USE_SMTP_RELAY=false` and no
 * capture declaration.
 *
 * AND THE FAILURE WAS SILENT, which is the part that matters for how this file is
 * written. Both legacy flags were *defined and false*, so the parser never
 * reached its implicit-legacy-default branch: it took the "exactly one email
 * provider flag must be true" issue, resolved mode `invalid`, transport
 * `unresolved`, and the delivery policy answered `suppress_non_production`. That
 * is a NORMAL terminal outcome — logged at info, one `SKIPPED_NON_PRODUCTION` row
 * per message, no error anywhere. An operator log-diving finds nothing. The
 * browser suite simply reads an empty mailbox and fails five specs on a symptom
 * that names nothing.
 *
 * The census that was supposed to catch it greped the four stack FILES for the
 * declaration text and was green, because the text was there. A text census over
 * the files cannot see whether the container gets the variable. So:
 *
 * - **GUARD A** (no Docker, unconditional) asserts the property that
 *   generalises: every variable this repository DECLARES and READS must be
 *   DELIVERED by some Compose service, or be listed with a reason. It would have
 *   caught `USE_LOCAL_CAPTURE` without anybody having to think of it.
 * - **GUARD B** (`docker compose config`) asserts the RENDER: the real resolved
 *   environment of every service that runs app code, including that exactly one
 *   transport flag is true. Presence alone catches this whole class.
 *
 * ## Anti-vacuity rules, because four guards in this epic have shipped vacuous
 *
 * Every case below asserts its own inputs are non-empty before it judges them,
 * and the reason map is asserted to hold no stale entry. Guard B FAILS on a
 * non-zero `docker compose` exit rather than skipping, and reports the stderr.
 *
 * `test:related` CANNOT select this file: it reads YAML, shell and `src/` from
 * disk with `fs`, so it has no import edge to anything it scans. Run it
 * explicitly and expect CI to be the backstop (`docs/TESTING.md`).
 */

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// The DECLARED set: every variable this repository tells an operator to set.
// ---------------------------------------------------------------------------

/**
 * An assignment in a dotenv-style file.
 *
 * Deliberately tolerant of the shapes Compose honours and a naive `-F=` reader
 * does not: leading whitespace, an `export ` prefix, and spaces around the `=`.
 * The deploy script learned the same lesson the hard way (#3034 second review).
 */
const ENV_ASSIGNMENT = /^[ \t]*(?:export[ \t]+)?([A-Z][A-Z0-9_]*)[ \t]*=/;

/** Tracked dotenv files and examples at the repository root, discovered. */
function envFileSources(): string[] {
  return readdirSync(ROOT)
    .filter((name) => /^\.env($|\.)/.test(name))
    .sort();
}

/**
 * Every `cat > <something> <<EOF` heredoc in every workflow, as
 * `<workflow>#<target>#<n>`.
 *
 * PER HEREDOC, not per file. Both E2E jobs write their own `.env.staging` and
 * the multi-lodge copy has drifted from the single-lodge one before.
 */
function workflowHeredocs(): { id: string; body: string }[] {
  const dir = path.join(ROOT, ".github", "workflows");
  const out: { id: string; body: string }[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = readFileSync(path.join(dir, name), "utf8");
    const opener = /cat > ([^\s]+) <<'?EOF'?/g;
    let match: RegExpExecArray | null;
    let index = 0;
    while ((match = opener.exec(text)) !== null) {
      index += 1;
      const rest = text.slice(match.index + match[0].length);
      const end = rest.indexOf("\nEOF");
      out.push({
        id: `.github/workflows/${name}#${match[1]}#${index}`,
        body: end === -1 ? rest : rest.slice(0, end),
      });
    }
  }
  return out;
}

/** name -> the sources that assign it. */
function declaredVariables(): Map<string, Set<string>> {
  const declared = new Map<string, Set<string>>();
  const add = (name: string, source: string) => {
    const sources = declared.get(name) ?? new Set<string>();
    sources.add(source);
    declared.set(name, sources);
  };
  for (const file of envFileSources()) {
    for (const line of readRepoFile(file).split(/\r?\n/)) {
      const match = line.match(ENV_ASSIGNMENT);
      if (match) add(match[1], file);
    }
  }
  for (const { id, body } of workflowHeredocs()) {
    for (const line of body.split(/\r?\n/)) {
      const match = line.match(ENV_ASSIGNMENT);
      if (match) add(match[1], id);
    }
  }
  return declared;
}

// ---------------------------------------------------------------------------
// The DELIVERED set: every variable some Compose service actually hands over.
// ---------------------------------------------------------------------------

/**
 * Keys in a Compose file's `environment:` mappings — the shared anchor AND every
 * service's own block.
 *
 * BOTH HALVES ARE LOAD-BEARING. `measurement/stack/docker-compose.measure.yml`
 * delivers literals per service and `docker-compose.staging.yml` delivers
 * `APP_ENVIRONMENT_ROLE` and the transport flags per service, so a reader that
 * only parsed the base anchor would call those stacks broken. A reader that only
 * parsed services would miss the anchor that supplies almost everything.
 *
 * `build.args:` is deliberately NOT counted. A build arg is baked into an image
 * and is not a runtime environment variable — `RELEASE_ID` is exactly that, and
 * counting it would make this census claim a delivery that does not happen.
 */
function deliveredKeys(relativePath: string): Set<string> {
  const keys = new Set<string>();
  let inEnvironment = false;
  let indent: string | null = null;
  for (const line of readRepoFile(relativePath).split(/\r?\n/)) {
    // A top-level `x-*-environment:` anchor, or any `environment:` mapping.
    if (/^x-[\w-]*environment:\s*(&[\w.-]+)?\s*(#.*)?$/.test(line)) {
      inEnvironment = true;
      indent = null;
      continue;
    }
    if (/^\s*environment:\s*(#.*)?$/.test(line)) {
      inEnvironment = true;
      indent = null;
      continue;
    }
    if (!inEnvironment) continue;
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const leading = line.slice(0, line.length - line.trimStart().length);
    if (indent === null) indent = leading;
    if (leading.length < indent.length) {
      inEnvironment = false;
      indent = null;
      continue;
    }
    const key = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*):/);
    if (key) keys.add(key[1]);
  }
  return keys;
}

function deliveredVariables(): Set<string> {
  const delivered = new Set<string>();
  for (const file of composeFiles) {
    for (const key of deliveredKeys(file)) delivered.add(key);
  }
  return delivered;
}

// ---------------------------------------------------------------------------
// The READ set: names the application actually looks at.
// ---------------------------------------------------------------------------

/**
 * Every production `.ts`/`.tsx` under `src/`, as one string.
 *
 * MATCHED ON THE BARE NAME, not on `process.env.X`, and that is not laziness.
 * `USE_LOCAL_CAPTURE` is read as `readEnv(env, "USE_LOCAL_CAPTURE")` against an
 * injected map, so a `process\.env\.` pattern misses it entirely — the very
 * variable this census exists for. Noise is controlled by intersecting with the
 * DECLARED set, which is small and specific, rather than by narrowing the read
 * side until it stops seeing things.
 *
 * A consequence, stated so it is not mistaken for a bug: a name that survives
 * only inside a comment ("the legacy BACKUP_S3_* vars are no longer read")
 * counts as read. Those land in the reason map below, which is the right place
 * for them — the map is what an author has to justify.
 */
function sourceCorpus(): { text: string; files: number } {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        files.push(full);
      }
    }
  };
  walk(path.join(ROOT, "src"));
  return {
    text: files.map((file) => readFileSync(file, "utf8")).join("\n"),
    files: files.length,
  };
}

/**
 * Variables that are declared and named in `src/` but deliberately NOT delivered
 * to a container, each with the reason.
 *
 * A REASON, NOT AN ALLOWLIST. Every entry has to be one of a small number of
 * true statements about the variable, and the case below fails if an entry stops
 * being declared-and-read at all — so a stale exemption cannot sit here
 * pretending to protect something.
 *
 * The alternative — adding a variable here because the census complained — is
 * recording the defect instead of fixing it. #3035 delivered eleven variables
 * rather than list them: the three Xero switches, `SES_SNS_ALLOW_SIGNATURE_V1`,
 * `CURRENCY`, `LOCALE`, both audit-archive URLs, `CRON_LEADER_RUNTIME_STATUS_URL`
 * and `CONFIG_BUNDLE_IMPORT_PATH` were all documented, read, and inert on every
 * Compose deployment.
 */
const DELIBERATELY_NOT_DELIVERED: Record<string, string> = {
  // NOTE `DB_PASSWORD` needs no entry here, and the stale-exemption case below
  // is what said so: Compose composes it into DATABASE_URL / POSTGRES_PASSWORD
  // and no production file under `src/` names it at all, so it never reaches the
  // intersection this census judges.

  // Stripe credentials are DB-only since #2082 — captured in-app and stored
  // encrypted. The names survive only in docblocks saying they are not read.
  STRIPE_SECRET_KEY: "DB-only since #2082; no STRIPE_* env var is read",
  STRIPE_WEBHOOK_SECRET: "DB-only since #2082; no STRIPE_* env var is read",
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
    "DB-only since #2082; the publishable key is fetched at runtime, never inlined",

  // Backups are configured in-app and stored encrypted since #2095; only the
  // nightly schedule and the container path stay in the environment.
  BACKUP_ENABLED: "legacy, no longer read since #2095",
  BACKUP_RETENTION_DAYS: "legacy, no longer read since #2095",
  BACKUP_RESTORE_VALIDATION_URL: "legacy, no longer read since #2095",
  BACKUP_S3_BUCKET: "legacy, no longer read since #2095",
  BACKUP_S3_REGION: "legacy, no longer read since #2095",
  BACKUP_S3_ACCESS_KEY_ID: "legacy, no longer read since #2095",
  BACKUP_S3_SECRET_ACCESS_KEY: "legacy, no longer read since #2095",

  // The HOST side of the backup mount. A host path is not visible from inside
  // the container, so giving it to the app would be actively misleading; the app
  // reads BACKUP_LOCAL_DIR, the mount target, which IS delivered.
  BACKUP_LOCAL_HOST_DIR: "host-side only; the container reads BACKUP_LOCAL_DIR",
  // Epic #2992, same shape as its backup twin above: the HOST side of the
  // post-images bind mount. The app must never see a host path -- it is not
  // meaningful inside the container -- so delivering it would be the bug.
  POST_IMAGE_HOST_DIR: "host-side only; the container reads POST_IMAGE_DIR",

  // A build arg (docker-compose.yml `build.args`), not a runtime variable: the
  // per-release CSP nonce has to be fixed for the life of the image.
  RELEASE_ID: "build arg, baked into the image; see #2352 D1",

  // NEXT_PUBLIC_* are inlined into the browser bundle at BUILD time. Delivering
  // one at runtime would let the server and the browser disagree about the same
  // value. The server-side spellings (CURRENCY, LOCALE, TZ) are delivered.
  NEXT_PUBLIC_CURRENCY: "inlined into the client bundle at build time; CURRENCY is delivered",
  NEXT_PUBLIC_LOCALE: "inlined into the client bundle at build time; LOCALE is delivered",
  NEXT_PUBLIC_TZ: "inlined into the client bundle at build time; TZ is delivered",
};

describe("GUARD A: every declared, read variable is delivered (INV-CONFIG-004)", () => {
  const declared = declaredVariables();
  const delivered = deliveredVariables();
  const corpus = sourceCorpus();
  const readInSource = [...declared.keys()].filter((name) =>
    new RegExp(`\\b${name}\\b`).test(corpus.text),
  );

  it("has non-empty inputs, so it cannot pass by finding nothing", () => {
    /*
      The assertion that stops this whole file going vacuous. A silently-empty
      declared set, delivered set or source corpus makes every case below pass
      while checking nothing — the exact shape that has now bitten this epic four
      times. The floors are deliberately far below today's values (90 declared,
      70 delivered, ~3600 files) so ordinary growth never touches them, and far
      above zero so a broken reader cannot hide.
    */
    expect(envFileSources().length, "no tracked .env* files were found").toBeGreaterThan(1);
    expect(workflowHeredocs().length, "no workflow env heredocs were found").toBeGreaterThan(1);
    expect(declared.size, "no variable assignments were parsed").toBeGreaterThan(50);
    expect(delivered.size, "no compose environment keys were parsed").toBeGreaterThan(40);
    expect(corpus.files, "no source files were read").toBeGreaterThan(500);
    expect(readInSource.length, "no declared variable was found in src/").toBeGreaterThan(40);
  });

  it("parses environment keys out of EVERY compose file, not just the base one", () => {
    // The measurement stack delivers per service and declares nothing in an
    // anchor, so a reader that only understood anchors would return zero for it
    // and wrongly report the stack broken.
    for (const file of composeFiles) {
      expect(
        deliveredKeys(file).size,
        `${file} parsed to no environment keys at all, so it contributed nothing`,
      ).toBeGreaterThan(0);
    }
  });

  it("delivers every variable an env file or workflow declares and src/ reads", () => {
    const offenders = readInSource
      .filter((name) => !delivered.has(name))
      .filter((name) => !(name in DELIBERATELY_NOT_DELIVERED))
      .map((name) => `${name} (declared in ${[...declared.get(name)!].sort().join(", ")})`)
      .sort();

    expect(
      offenders,
      "These variables are documented for an operator to set and are named in " +
        "src/, but no Compose service delivers them — and `--env-file` feeds " +
        "Compose INTERPOLATION only, so setting one changes nothing inside the " +
        "container. That is how #3035 shipped an E2E stack whose mailbox stayed " +
        "empty, SILENTLY: every send was suppressed as a normal outcome with no " +
        "error anywhere. Add each one to the x-app-environment anchor in " +
        "docker-compose.yml, or, if it genuinely must not be delivered, add it to " +
        "DELIBERATELY_NOT_DELIVERED in this file with the reason " +
        "(INV-CONFIG-004).",
    ).toEqual([]);
  });

  it("holds no stale exemption", () => {
    /*
      An exemption for a variable nobody declares any more, or that `src/` no
      longer names, reads as protection and protects nothing. Failing here is how
      the map stays a list of live decisions rather than a graveyard.
    */
    const stale = Object.keys(DELIBERATELY_NOT_DELIVERED)
      .filter((name) => !declared.has(name) || !readInSource.includes(name))
      .sort();
    expect(
      stale,
      "DELIBERATELY_NOT_DELIVERED names variables that are no longer both " +
        "declared in an env file/workflow and named under src/. Remove them.",
    ).toEqual([]);

    const empty = Object.entries(DELIBERATELY_NOT_DELIVERED)
      .filter(([, reason]) => reason.trim().length < 10)
      .map(([name]) => name);
    expect(empty, "every exemption must carry a real reason").toEqual([]);
  });

  it("delivers the whole email transport family through the shared anchor", () => {
    /*
      The specific case, kept as its own assertion because it is the one the
      epic is judged on and because a named case fails more legibly than a list.
      All three flags plus the four relay settings and the sender identity, in
      the base anchor, so every service that merges it receives every one.
    */
    const anchorKeys = deliveredKeys(BASE_COMPOSE);
    for (const name of [
      "APP_ENVIRONMENT_ROLE",
      "USE_AWS_SES",
      "USE_SMTP_RELAY",
      "USE_LOCAL_CAPTURE",
      "EMAIL_SERVER_HOST",
      "EMAIL_SERVER_PORT",
      "EMAIL_SERVER_USER",
      "EMAIL_SERVER_PASSWORD",
      "EMAIL_FROM",
    ]) {
      expect(
        anchorKeys.has(name),
        `${name} is not delivered by docker-compose.yml, so no container gets it`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// GUARD B: the real render.
// ---------------------------------------------------------------------------

/** The safety-critical closed list, whose mere PRESENCE catches this class. */
const REQUIRED_IN_EVERY_APP_SERVICE = [
  "APP_ENVIRONMENT_ROLE",
  "USE_AWS_SES",
  "USE_SMTP_RELAY",
  "USE_LOCAL_CAPTURE",
  "EMAIL_SERVER_HOST",
  "EMAIL_SERVER_PORT",
  "EMAIL_SERVER_USER",
  "EMAIL_SERVER_PASSWORD",
  "EMAIL_FROM",
];

const TRANSPORT_FLAGS = ["USE_AWS_SES", "USE_SMTP_RELAY", "USE_LOCAL_CAPTURE"];

/**
 * Host names that ARE a capture mailbox, for this test over this repository's own
 * tracked configuration only.
 *
 * The application never infers capture mode from a host name and must not — see
 * `email-delivery.ts`. This is a test over files we control, where the inference
 * is a check rather than a behaviour.
 */
const CAPTURE_HOSTS = new Set(["mailpit", "mailhog"]);

/**
 * `parseBooleanFlag`'s rule, so the guard and the application cannot disagree.
 * Trim, case-fold, and accept only `true`/`false`.
 */
function booleanFlag(value: string | null | undefined): boolean | "invalid" | undefined {
  if (value === null || value === undefined) return undefined;
  const normalised = value.trim().toLowerCase();
  if (normalised === "") return undefined;
  if (normalised === "true") return true;
  if (normalised === "false") return false;
  return "invalid";
}

/**
 * The compose-file combinations this repository actually runs, extracted from the
 * scripts that run them.
 *
 * DERIVED, NOT LISTED, so a new stack cannot be silently unchecked — the same
 * lesson as discovering the compose files themselves. A `$SOURCE_REPO/` style
 * prefix is stripped: the production deploy script runs the base file out of a
 * checkout path.
 */
const STACK_SCRIPTS = [
  "scripts/run-production-blue-green-deploy.sh",
  "scripts/e2e-stack.sh",
  "measurement/stack/measure-stack.sh",
];

function composeCombinations(): string[][] {
  const seen = new Map<string, string[]>();
  for (const script of STACK_SCRIPTS) {
    for (const line of readRepoFile(script).split(/\r?\n/)) {
      const files = [...line.matchAll(/-f\s+"?(?:\$\{?\w+\}?\/)?([\w./-]+\.ya?ml)"?/g)].map(
        (match) => match[1],
      );
      if (files.length === 0) continue;
      seen.set(files.join("|"), files);
    }
  }
  return [...seen.values()];
}

/** Every rendered service that is not recognised infrastructure. */
function appServicesInRender(render: {
  services: Record<string, { environment?: Record<string, string | null> }>;
}): string[] {
  return Object.keys(render.services)
    .filter((name) => !NON_APP_COMPOSE_SERVICES.has(name))
    .sort();
}

type ComposeRender = {
  services: Record<
    string,
    { image?: string; environment?: Record<string, string | null> }
  >;
};

/**
 * The per-test budget for the `it()` blocks that render a stack (#3083).
 *
 * Vitest's default is 5000 ms, which was never chosen for a test that LAUNCHES A
 * PROCESS. It reddened `verify` on #3081 with
 * `Error: Test timed out in 5000ms` at this file, while the same suite passed on
 * #3077 and #3079 minutes earlier at the same base and #3081 touches no compose
 * file, no env file and nothing else this census reads. A false red on a
 * deployment-safety gate is worse than a slow one: it teaches its reader to wave
 * the gate through.
 *
 * Measured rather than picked, on a 20-core Windows host with Compose v5.3.1:
 *
 * | scenario                          | slowest single render |
 * | --------------------------------- | --------------------- |
 * | idle, 7 runs x 3 combinations     | 204 ms                |
 * | 24 renders at once                | 530 ms                |
 * | 72 renders at once                | 2104 ms               |
 *
 * So the work itself is ~200 ms and CONTENTION is the whole variable — which is
 * exactly what a 4-core CI runner executing the rest of the suite in parallel
 * supplies, and why CI has already been seen past 5000 ms while the worst local
 * contention reached 2104 ms. 30 s is ~147x the idle render, ~14x the worst
 * contended one measured, and >=6x the budget that actually blew on CI, while
 * still failing a genuinely hung `docker compose` in half a minute instead of
 * hanging the job.
 *
 * A HANG-CATCHER, NOT A PASS MARK — the same footing as
 * `./helpers/migration-gate-timeouts.ts`, which budgets the bash gate suites at
 * 60 s for the same fork-cost reason. On CI these finish in well under a second,
 * so this number never decides a pull request; if one ever burns 30 s, something
 * is genuinely wrong and the test SHOULD fail.
 *
 * DELIBERATELY PER-TEST. The global `testTimeout` stays at its 5 s default: it is
 * what catches a hung test everywhere else in this suite, and widening it for
 * six subprocess tests would blunt it for thousands of others — `vitest.setup.ts`
 * also states that 5,000 ms and calibrates the 4,000 ms RTL window against it.
 * The two GUARD B cases that do not shell out keep the default too.
 */
const COMPOSE_RENDER_TIMEOUT_MS = 30_000;

function renderCompose(files: string[], envFile: string): ComposeRender {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      envFile,
      "--project-directory",
      ROOT,
      ...files.flatMap((file) => ["-f", path.join(ROOT, file)]),
      "--profile",
      "production-bluegreen",
      "--profile",
      "production-caddy",
      "--profile",
      "migrate",
      "config",
      "--format",
      "json",
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  /*
    A MISSING OR FAILING `docker compose` FAILS THIS TEST. It does not skip, and
    it does not warn. A guard that quietly excuses itself on the machine where the
    tooling is absent is exactly the shape that let #3035's compose defect reach
    CI: something was green and nothing had been checked. `docker compose config`
    is a client-side render and needs no running daemon, so this is a check on the
    Compose CLI being installed, not on Docker being up.
  */
  expect(
    result.error ? `${result.error.message}` : null,
    `could not run \`docker compose config\` for ${files.join(" + ")}. ` +
      "Install the Docker Compose CLI; this guard renders configuration and " +
      "never starts a container.",
  ).toBeNull();
  expect(
    result.status === 0 ? "" : `exit ${result.status}: ${result.stderr}`,
    `\`docker compose config\` failed for ${files.join(" + ")}`,
  ).toBe("");
  return JSON.parse(result.stdout) as ComposeRender;
}

describe("GUARD B: the rendered compose environment (INV-CONFIG-004)", () => {
  /*
    The fixture is the repository's own tracked staging template plus the one
    `:?`-required variable no tracked file supplies. Placeholder values only —
    nothing secret is written anywhere.
  */
  const combinations = composeCombinations();
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "env-delivery-census-"));
  const envFile = path.join(fixtureDir, "census.env");
  writeFileSync(
    envFile,
    `${readRepoFile(".env.staging.example")}\nMEASURE_APP_IMAGE=env-delivery-census-fixture:local\n`,
    "utf8",
  );

  it("derives the stack combinations from the scripts that run them", () => {
    /*
      Non-empty AND exactly the set the scripts name. If a fourth stack appears,
      this fails and its combination has to be acknowledged rather than skipped.
    */
    expect(combinations.length).toBeGreaterThan(0);
    expect(combinations.map((files) => files.join(" + ")).sort()).toEqual([
      "docker-compose.yml",
      "docker-compose.yml + docker-compose.staging.yml",
      "docker-compose.yml + measurement/stack/docker-compose.measure.yml",
    ]);
  });

  for (const files of combinations) {
    const label = files.join(" + ");
    const isOverrideStack = files.length > 1;

    it(`gives every app service the whole safety-critical set: ${label}`, () => {
      const render = renderCompose(files, envFile);
      const services = appServicesInRender(render);
      expect(services.length, `${label} rendered no app services`).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const name of services) {
        const environment = render.services[name].environment ?? {};
        expect(
          Object.keys(environment).length,
          `${label} -> ${name} rendered an empty environment`,
        ).toBeGreaterThan(0);
        for (const key of REQUIRED_IN_EVERY_APP_SERVICE) {
          if (!(key in environment)) offenders.push(`${name}: ${key}`);
        }
      }
      expect(
        offenders,
        `${label}: these services run application code and do not receive these ` +
          "variables at all. Presence is what this asserts, because an absent " +
          "variable fails SILENTLY — the app resolves a safe-looking default and " +
          "holds mail back with no error. Add the name to the " +
          "x-app-environment anchor in docker-compose.yml (INV-CONFIG-004).",
      ).toEqual([]);
    }, COMPOSE_RENDER_TIMEOUT_MS);

    it(`resolves exactly one transport flag and a legal role: ${label}`, () => {
      const render = renderCompose(files, envFile);
      const services = appServicesInRender(render);
      expect(services.length, `${label} rendered no app services`).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const name of services) {
        const environment = render.services[name].environment ?? {};
        const flags = TRANSPORT_FLAGS.map((flag) => booleanFlag(environment[flag]));
        const invalid = TRANSPORT_FLAGS.filter(
          (_flag, index) => flags[index] === "invalid",
        );
        if (invalid.length > 0) {
          offenders.push(`${name}: ${invalid.join(", ")} is neither true nor false`);
        }
        const trueCount = flags.filter((flag) => flag === true).length;
        if (trueCount !== 1) {
          offenders.push(
            `${name}: ${trueCount} of ${TRANSPORT_FLAGS.join("/")} are true — exactly one must be`,
          );
        }

        const host = (environment.EMAIL_SERVER_HOST ?? "").trim().toLowerCase();
        if (CAPTURE_HOSTS.has(host) && flags[2] !== true) {
          offenders.push(
            `${name}: EMAIL_SERVER_HOST is the capture container "${host}" but USE_LOCAL_CAPTURE is not true`,
          );
        }

        const role = (environment.APP_ENVIRONMENT_ROLE ?? "").trim();
        if (role !== "" && role !== "production" && role !== "non-production") {
          offenders.push(`${name}: APP_ENVIRONMENT_ROLE is "${role}"`);
        }
        if (isOverrideStack && role !== "non-production") {
          offenders.push(
            `${name}: an override stack is a copy by construction and must render APP_ENVIRONMENT_ROLE=non-production, not "${role}"`,
          );
        }
      }
      expect(
        offenders,
        `${label}: the rendered configuration is not one this application can ` +
          "use. Two or zero transport flags true resolves mode `invalid`, which a " +
          "copy then treats as an ordinary suppression — silently, with no error " +
          "(INV-CONFIG-004).",
      ).toEqual([]);
    }, COMPOSE_RENDER_TIMEOUT_MS);
  }

  it("cleans up its fixture", () => {
    rmSync(fixtureDir, { recursive: true, force: true });
    expect(composeServices(BASE_COMPOSE).size).toBeGreaterThan(0);
  });
});
