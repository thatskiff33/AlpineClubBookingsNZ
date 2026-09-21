import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Reads the deploy guard's migration lock timeout out of `docker-compose.yml`
 * (#3377) — the one place it is configured, and therefore the only honest place
 * for a test to learn it.
 *
 * Two suites need these facts and they must agree:
 * `migration-lock-timeout.realdb.test.ts` proves the bound against a real
 * PostgreSQL, and `blue-green-ledger-named-controls.test.ts` refuses a safety
 * ledger row that names a control the repository does not implement. A test
 * that re-declared the number would keep passing after somebody deleted the
 * thing it exists to pin, which is exactly the failure #3377 was filed about.
 *
 * Everything here is deliberately parsed rather than assumed, and every
 * unreadable shape throws. A helper that returned a plausible default when it
 * could not find the setting would hand both callers a green they had no
 * evidence for.
 */

/** What the `migrate` service's `command` must still be for the bound to matter. */
const MIGRATE_COMMAND_MARKER = "prisma migrate deploy";

export interface MigrateServiceLockTimeout {
  /** The decoded libpq startup options, e.g. `-c lock_timeout=5000`. */
  optionsParameter: string;
  /**
   * The same thing in the SHIPPED bytes — the `options=` query value exactly as
   * `docker-compose.yml` writes it, with only the Compose interpolation
   * resolved to its default: `-c%20lock_timeout%3D5000`.
   *
   * A probe that wants to connect the way the migrate container does has to
   * append this rather than re-encode the decoded form. `URLSearchParams`
   * serialises a space as `+`, so assigning `optionsParameter` through
   * `searchParams` produces `-c+lock_timeout%3D5000` — which decodes
   * identically, and is still not what ships.
   */
  encodedOptionsParameter: string;
  /** The shipped default in milliseconds, from `${MIGRATION_LOCK_TIMEOUT_MS:-NNNN}`. */
  defaultMs: number;
  /** The env var an operator overrides it with. */
  overrideEnvVar: string;
  /** Whether the service carrying it still runs `prisma migrate deploy`. */
  serviceRunsMigrateDeploy: boolean;
}

export const MIGRATION_LOCK_TIMEOUT_ENV_VAR = "MIGRATION_LOCK_TIMEOUT_MS";

function readComposeFile(): string {
  return readFileSync(path.join(process.cwd(), "docker-compose.yml"), "utf8");
}

/**
 * The `migrate:` service block: from its own key to the next top-level service
 * key or the `volumes:` section. Sliced rather than YAML-parsed on purpose —
 * Compose's own interpolation syntax is what is being inspected, and a parser
 * would either resolve it or refuse the required-variable form outright.
 *
 * (Deliberately no literal environment-variable name in this docblock:
 * `env-delivery-census.test.ts` walks every non-`.test.ts` file under `src/`
 * as one string, so a name mentioned only in a comment here joins its READ set
 * and trips the census — measured, on the first draft of this file.)
 */
function migrateServiceBlock(compose: string): string {
  const start = compose.indexOf("\n  migrate:\n");
  if (start < 0) {
    throw new Error(
      "docker-compose.yml has no `migrate:` service; the deploy guard's lock timeout (#3377) has nowhere to live.",
    );
  }
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n(?:volumes|networks|secrets|configs):|\n {2}[A-Za-z_][\w.-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * The web slots' `pool_timeout`, in milliseconds — the ceiling the migration
 * bound has to stay under, derived rather than restated.
 *
 * A reader blocked behind a migration's ACCESS EXCLUSIVE request holds its
 * Prisma pool connection while it waits (the mechanism the pool note in
 * `docker-compose.yml` records for advisory-lock waiters), so once
 * `connection_limit` requests are queued every further one is refused with
 * Prisma `P2024` after `pool_timeout`. A lock timeout at or above that point
 * cannot fire before the serving colour is failing member requests, so it would
 * be decoration. Deriving it here means raising `pool_timeout` moves the ceiling
 * with it instead of leaving a stale number in a comment.
 */
export const MIGRATION_LOCK_TIMEOUT_CEILING_MS = (() => {
  const compose = readComposeFile();
  const match = /postgresql:\/\/[^\n"']*connection_limit=10[^\n"']*pool_timeout=(\d+)/.exec(
    compose,
  );
  if (!match) {
    throw new Error(
      "Could not read the web slots' pool_timeout from docker-compose.yml, so the migration lock-timeout ceiling (#3377) cannot be derived.",
    );
  }
  return Number(match[1]) * 1000;
})();

/** Parse the migrate service's lock-timeout wiring out of `docker-compose.yml`. */
export function readMigrateServiceLockTimeout(): MigrateServiceLockTimeout {
  const block = migrateServiceBlock(readComposeFile());

  const urlMatch = /^\s*DATABASE_URL:\s*(\S.*)$/m.exec(block);
  if (!urlMatch) {
    throw new Error("The `migrate` service in docker-compose.yml has no DATABASE_URL.");
  }
  const url = urlMatch[1].trim();

  // `%20` and `%3D` are how the space and the equals sign survive a URL query
  // value; libpq receives `-c lock_timeout=NNNN`.
  const optionsMatch = /[?&]options=(\S+?)(?:&|\s|$)/.exec(url);
  if (!optionsMatch) {
    throw new Error(
      "The `migrate` service's DATABASE_URL carries no `options=` parameter, so no lock_timeout reaches the connection migrations run on (#3377).",
    );
  }
  const optionsRaw = optionsMatch[1];

  const defaultMatch = new RegExp(
    String.raw`lock_timeout%3D\$\{${MIGRATION_LOCK_TIMEOUT_ENV_VAR}:-(\d+)\}`,
  ).exec(optionsRaw);
  if (!defaultMatch) {
    throw new Error(
      `The migrate service's \`options\` parameter does not set lock_timeout from \${${MIGRATION_LOCK_TIMEOUT_ENV_VAR}:-<ms>} (#3377). Got: ${optionsRaw}`,
    );
  }
  const defaultMs = Number(defaultMatch[1]);

  // The shipped bytes, with the Compose interpolation resolved to its default —
  // character for character what the migrate container's URL carries when
  // nothing overrides it.
  const encodedOptionsParameter = optionsRaw.replace(
    new RegExp(String.raw`\$\{${MIGRATION_LOCK_TIMEOUT_ENV_VAR}:-\d+\}`),
    String(defaultMs),
  );
  // And what libpq is handed once the query value is decoded.
  const optionsParameter = decodeURIComponent(encodedOptionsParameter);

  return {
    optionsParameter,
    encodedOptionsParameter,
    defaultMs,
    overrideEnvVar: MIGRATION_LOCK_TIMEOUT_ENV_VAR,
    serviceRunsMigrateDeploy: block.includes(MIGRATE_COMMAND_MARKER),
  };
}
