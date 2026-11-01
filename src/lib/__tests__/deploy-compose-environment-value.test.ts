import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { bashFixturePath, bashGateArgs } from "./helpers/bash-fixture-path";
import { readRepoFile } from "./helpers/compose";
import { DEPLOY_SCRIPT, shellFunctionSource } from "./helpers/deploy-script";

// #4416: run the real `compose_service_environment_value` under the deploy
// script's own `pipefail`, against renders small and large. It used to `exit`
// on its first match, which closed the pipe under a still-writing `printf`; on
// a large render that SIGPIPE turned a correctly found value into a failure.
const ROOT = mkdtempSync(path.join(tmpdir(), "deploy-env-value-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const HARNESS = path.join(ROOT, "lookup.sh");
writeFileSync(HARNESS, `set -Eeuo pipefail
${shellFunctionSource(readRepoFile(DEPLOY_SCRIPT), "compose_service_environment_entries")}
${shellFunctionSource(readRepoFile(DEPLOY_SCRIPT), "compose_service_environment_value")}
rendered="$(cat rendered.yml)"
# A conditional call, as the script's callers make it: a failed pipeline must
# surface here, not be swallowed.
if value="$(compose_service_environment_value "$rendered" "$SERVICE" "$KEY")"; then
  printf '%s' "$value"
else
  exit 7
fi
`);

const RENDER = `name: resolved
x-app-environment: &app-env
  DATABASE_URL: postgresql://web-anchor
services:
  app:
    environment:
      DATABASE_URL: postgresql://app-own?options=-c%20lock_timeout%3D5000
      DATABASE_URL: postgresql://second-should-not-win
      NODE_ENV: production
    image: app:local
  migrate:
    environment:
      DATABASE_URL: postgresql://migrate-own
    image: migrate:local
`;

/** The render, with ~512 KiB of further services after the matches, as a large real config would carry. */
function largeRender(): string {
  const filler = Array.from({ length: 6000 }, (_, i) =>
    `  filler${i}:\n    environment:\n      FILLER_VALUE: ${"x".repeat(60)}\n    image: filler:local\n`).join("");
  return `${RENDER}${filler}`;
}

function lookup(rendered: string, service: string, key: string) {
  const cwd = mkdtempSync(path.join(ROOT, "case-"));
  writeFileSync(path.join(cwd, "rendered.yml"), rendered);
  const result = spawnSync("bash", bashGateArgs(bashFixturePath(HARNESS, cwd), [], { SERVICE: service, KEY: key }), {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

describe("deploy compose_service_environment_value (#4416)", () => {
  it("returns the service's own value from an ordinary render, never the anchor's or a later duplicate", () => {
    const result = lookup(RENDER, "app", "DATABASE_URL");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("postgresql://app-own?options=-c%20lock_timeout%3D5000");
  });

  it("returns the value with status 0 from a 512 KiB render under pipefail", () => {
    const large = largeRender();
    expect(large.length).toBeGreaterThan(512 * 1024);
    const result = lookup(large, "app", "DATABASE_URL");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("postgresql://app-own?options=-c%20lock_timeout%3D5000");
  });

  it("keeps the service scoping and the missing-value answer, on small and large renders", () => {
    for (const rendered of [RENDER, largeRender()]) {
      expect(lookup(rendered, "migrate", "DATABASE_URL").stdout).toBe("postgresql://migrate-own");
      for (const [service, key] of [["app", "MISSING_KEY"], ["nonexistent", "DATABASE_URL"], ["app", "image"]] as const) {
        const result = lookup(rendered, service, key);
        expect(result.status, `${service}/${key}`).toBe(0);
        expect(result.stdout, `${service}/${key}`).toBe("");
      }
    }
    // Eight bash spawns, half of them over a 512 KiB render: past the default
    // 5 s on a loaded Windows host, so a timeout here is not a finding.
  }, 60_000);
});
