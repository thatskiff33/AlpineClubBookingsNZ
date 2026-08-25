import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Shared reading of this repository's tracked Compose files, for the census
 * tests that assert what a deployment actually receives.
 *
 * EXTRACTED RATHER THAN COPIED (ENV-SAFETY 2, #3035). Two censuses now read
 * these files — `deploy-environment-role-contract.test.ts` for the environment
 * declaration and `env-delivery-census.test.ts` for every other variable — and
 * each hard lesson learned here was learned by a probe defeating a parser. A
 * second copy would drift from the first, and the drifting copy is the one that
 * silently returns zero services and passes.
 *
 * None of this is application code: it reads repository files from disk, so no
 * test that imports it can be selected by `npm run test:related`
 * (`docs/TESTING.md`). Run those files explicitly.
 */

export function readRepoFile(relativePath: string): string {
  // Test helper: reads a fixed repo file under process.cwd(); relativePath is test-controlled, not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/** Directories that never hold a tracked Compose file. */
export const COMPOSE_SEARCH_SKIP = new Set([
  "node_modules",
  ".git",
  ".next",
  ".artifacts",
  "coverage",
  "playwright-report",
  "test-results",
  "dist",
]);

/**
 * Which filenames are a Compose file.
 *
 * `docker-compose*.yml` AND Compose's own modern defaults, `compose.yaml` /
 * `compose.yml` / `compose-*.y[a]ml`. The narrow `^docker-compose` glob was the
 * ONE fully silent defeat of the role census: a `compose.yaml` was never scanned
 * while every assertion still passed.
 *
 * A MODULE CONSTANT so a test can assert THIS value rather than a copy of it.
 * The first version of that case declared its own regex literal inline, which
 * made it vacuous — narrowing the glob back left it green (measured). No `g`
 * flag, so sharing one RegExp carries no `lastIndex` state between callers.
 */
export const COMPOSE_FILENAME = /^(docker-)?compose.*\.ya?ml$/;

export function findComposeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (COMPOSE_SEARCH_SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) findComposeFiles(full, out);
    else if (COMPOSE_FILENAME.test(name)) out.push(full);
  }
  return out;
}

export const BASE_COMPOSE = "docker-compose.yml";

/** Every tracked Compose file, repo-relative and sorted. Discovered, never listed. */
export const composeFiles: string[] = findComposeFiles(process.cwd())
  .map((file) => path.relative(process.cwd(), file).split(path.sep).join("/"))
  .sort();

/**
 * A Compose file's `services:` blocks, by name.
 *
 * A deliberately small indentation parser rather than a YAML dependency — this
 * repository has none, and the shape being read is two levels deep.
 *
 * TOLERANT OF THREE SHAPES IT USED TO RETURN ZERO SERVICES FOR, each of which
 * made the role census pass vacuously (#3034 third review lens, measured against
 * synthetic files): a trailing comment on the `services:` line, an indentation
 * other than two spaces, and a YAML anchor or trailing comment on a service key
 * (`app: &app`). The indent is LEARNED from the first child line rather than
 * assumed, and every caller asserts the result is non-empty, so an unparsed file
 * fails loudly instead of silently declaring nothing to check.
 */
export function composeServices(relativePath: string): Map<string, string> {
  const lines = readRepoFile(relativePath).split(/\r?\n/);
  const services = new Map<string, string>();
  let inServices = false;
  let indent: string | null = null;
  let current: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (current) services.set(current, body.join("\n"));
    current = null;
    body = [];
  };

  for (const line of lines) {
    if (/^services:\s*(#.*)?$/.test(line)) {
      inServices = true;
      indent = null;
      continue;
    }
    if (!inServices) continue;
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    // Any content back at column 0 ends the services mapping (volumes:,
    // networks:, an x-anchor).
    if (/^[^\s]/.test(line)) {
      flush();
      inServices = false;
      indent = null;
      continue;
    }
    const leading = line.slice(0, line.length - line.trimStart().length);
    if (indent === null) indent = leading;
    // A service key sits at exactly the learned indent. The value may carry a
    // YAML anchor and/or a trailing comment and still be a mapping key.
    if (leading === indent) {
      const name = line
        .trim()
        .match(/^([A-Za-z0-9_.-]+):\s*(&[A-Za-z0-9_.-]+)?\s*(#.*)?$/);
      if (name) {
        flush();
        current = name[1];
        continue;
      }
    }
    if (current) body.push(line);
  }
  flush();
  return services;
}

/**
 * Services that do NOT run application code, and may therefore have no
 * environment declaration.
 *
 * AN ALLOWLIST OF INFRASTRUCTURE, not an allowlist of app services, and the
 * inversion is load-bearing. The role census used to skip any service whose name
 * was not one of the base file's three app services, so renaming one in an
 * override file — `app_e2e:` — silently excused it. Anything a census does not
 * RECOGNISE as infrastructure has to declare, which is the fail-closed direction.
 *
 * `migrate` runs `prisma migrate deploy` and imports no application code; the
 * other three are Postgres, Caddy and the mailpit SMTP capture. The set is
 * asserted to be exactly these four in `deploy-environment-role-contract.test.ts`,
 * so widening it is a visible edit rather than a quiet one.
 */
export const NON_APP_COMPOSE_SERVICES = new Set([
  "postgres",
  "caddy",
  "mailpit",
  "migrate",
]);

/**
 * The services that run APPLICATION CODE, taken from the base file's own anchor
 * usage rather than from a hand-kept list — `migrate` merges no app environment
 * and runs `prisma migrate deploy` with no application code.
 */
export function appServiceNames(): string[] {
  return [...composeServices(BASE_COMPOSE)]
    .filter(([, body]) => body.includes("<<: *app-environment"))
    .map(([name]) => name)
    .sort();
}
