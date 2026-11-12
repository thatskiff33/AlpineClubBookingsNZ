import { readFileSync } from "node:fs";
import path from "node:path";

import { expect } from "vitest";

/**
 * Lifting one function out of `scripts/run-production-blue-green-deploy.sh` so a
 * suite can RUN it under a stub harness rather than grep its text (#3965,
 * #4026, #4027).
 *
 * The deploy script needs a production host, Docker and a live release, so it is
 * never executed whole in a test. Several suites instead copy the functions they
 * prove into a throwaway harness, stub `docker` and friends, and run that. They
 * all need the same bounds rule, so it lives here once.
 */

/** The deploy script's path, relative to the repository root. */
export const DEPLOY_SCRIPT = "scripts/run-production-blue-green-deploy.sh";

/**
 * The files the deploy script sources before anything else, in its order
 * (#4980): the shared `.env` readers, then the live-site role check that First
 * Bootstrap's `scripts/check-environment-role.sh` sources too.
 */
export const DEPLOY_SCRIPT_LIBRARIES = [
  "scripts/lib/compose-env-file.sh",
  "scripts/lib/environment-role-check.sh",
] as const;

/**
 * Every top-level function the deploy script can call, as one text to lift
 * from with {@link shellFunctionSource}: each library it sources, then the
 * script itself, the order bash defines them in. A suite that lifts a shared
 * reader (`compose_env_file_value`) or the role check reads this rather than
 * the script alone, which no longer defines them.
 */
export function deployShellSource(): string {
  return [...DEPLOY_SCRIPT_LIBRARIES, DEPLOY_SCRIPT]
    .map((file) => readFileSync(path.resolve(process.cwd(), file), "utf8"))
    .join("\n");
}

/**
 * A top-level shell function's whole definition, from `name() {` at the start of
 * a line to the next `}` at the start of a line, closing brace and newline
 * included, ready to paste into a harness.
 *
 * Anchored at a line start so `foo` cannot match inside `bar_foo() {`, and
 * asserted present, so a renamed function fails the suite by name instead of
 * pasting nothing into the harness.
 */
export function shellFunctionSource(script: string, name: string): string {
  const start = script.indexOf(`\n${name}() {`);
  expect(start, `${name} must be defined in the deploy script or a library it sources`).toBeGreaterThan(0);
  const end = script.indexOf("\n}\n", start);
  expect(end, `${name} must have a closing brace`).toBeGreaterThan(start);
  return script.slice(start + 1, end + 3);
}
