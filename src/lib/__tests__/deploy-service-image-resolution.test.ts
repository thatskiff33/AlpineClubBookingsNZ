import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { bashFixturePath, bashGateArgs } from "./helpers/bash-fixture-path";
import { readRepoFile } from "./helpers/compose";
import { DEPLOY_SCRIPT, shellFunctionSource } from "./helpers/deploy-script";

// Execute only the real lookup function. Every Docker call is denied unless
// it is a synthetic config render or an image-inspection assertion below.
const ROOT = mkdtempSync(path.join(tmpdir(), "deploy-service-images-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const HARNESS = path.join(ROOT, "lookup.sh");
writeFileSync(HARNESS, `set -Eeuo pipefail
PROJECT_DIR="$PWD"
CRON_SERVICE=app BLUE_SERVICE=app_blue GREEN_SERVICE=app_green MIGRATE_SERVICE=migrate
${shellFunctionSource(readRepoFile(DEPLOY_SCRIPT), "compose_service_image_ref")}
${shellFunctionSource(readRepoFile(DEPLOY_SCRIPT), "get_service_image_ref")}
docker() {
  printf '%s\\n' "$*" >> docker.calls
  if [ "$1" = compose ]; then
    [ "$*" = "compose --profile * config -- $SERVICE" ] || return 91
    cat rendered.yml
    return "$COMPOSE_EXIT"
  fi
  if [ "$1" = image ] && [ "$2" = inspect ] && [ "$#" = 3 ]; then
    [ "$3" = "$EXPECTED_IMAGE" ] || return 92
    return "$INSPECT_EXIT"
  fi
  return 93
}
awk() {
  if [ "$PARSER_EXIT" != 0 ]; then
    printf '%s' "$EXPECTED_IMAGE"
    return "$PARSER_EXIT"
  fi
  command awk "$@"
}
# Deliberately call in a conditional: set -e alone cannot enforce refusals here.
if image="$(get_service_image_ref "$SERVICE")"; then
  printf '%s' "$image"
else
  exit 1
fi
`);

function lookup(options: {
  directory?: string;
  service?: string;
  image?: string;
  rendered?: string;
  envFile?: string;
  env?: Record<string, string>;
}) {
  const parent = mkdtempSync(path.join(ROOT, "case-"));
  const cwd = path.join(parent, options.directory ?? "fixture");
  mkdirSync(cwd);
  const service = options.service ?? "app";
  const image = options.image ?? "resolved-app:local";
  writeFileSync(path.join(cwd, ".env"), options.envFile ?? "");
  writeFileSync(path.join(cwd, "rendered.yml"), options.rendered ?? `
name: resolved
x-app-service:
  image: wrong-anchor:local
services:
  postgres:
    image: postgres:16-alpine
  ${service}:
    environment:
      IMAGE: wrong-environment:local
    image: ${image}
  unrelated:
    image: wrong-service:local
`);
  const result = spawnSync("bash", bashGateArgs(bashFixturePath(HARNESS, cwd), [], {
    SERVICE: service,
    EXPECTED_IMAGE: image,
    APP_IMAGE: "",
    MIGRATE_IMAGE: "",
    COMPOSE_EXIT: "0",
    INSPECT_EXIT: "0",
    PARSER_EXIT: "0",
    ...options.env,
  }), { cwd, encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined();
  return { ...result, calls: readFileSync(path.join(cwd, "docker.calls"), "utf8") };
}

describe("deploy service image resolution (#4393)", () => {
  it.each(["app", "app_blue", "app_green", "migrate"])(
    "uses Compose's normalized directory image for %s, ignoring dependency and anchor images",
    (service) => {
      const image = `mylodge-${service === "migrate" ? "migrate" : "app"}:local`;
      const result = lookup({ directory: "My.Lodge", service, image });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(image);
      expect(result.calls).toContain(`image inspect ${image}\n`);
      expect(result.calls).not.toContain("image inspect my.lodge-");
    },
  );

  it("honors the project name Compose read from .env without exporting it", () => {
    const result = lookup({ envFile: "COMPOSE_PROJECT_NAME=otherclub\n", image: "otherclub-app:local" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("otherclub-app:local");
  });

  it.each(["app", "migrate"])("preserves the wrapper's explicit %s image", (service) => {
    const image = `registry.example.invalid/club/${service}:release`;
    const result = lookup({ service, image, env: {
      COMPOSE_PROJECT_NAME: "wrapper-project",
      APP_IMAGE: service === "app" ? image : "registry.example.invalid/club/app:release",
      MIGRATE_IMAGE: service === "migrate" ? image : "registry.example.invalid/club/migrate:release",
    } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(image);
  });

  it.each(['"123"', "'123'"])("decodes a quoted image scalar: %s", (quoted) => {
    const result = lookup({ image: "123", rendered: `services:\n  app:\n    image: ${quoted}\n` });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("123");
  });

  it("resolves non-app services from Compose too", () => {
    const result = lookup({ service: "postgres", image: "postgres:16-alpine", rendered: "services:\n  postgres:\n    image: postgres:16-alpine\n" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("postgres:16-alpine");
  });

  it("refuses a failed render even when stdout contains a plausible image", () => {
    const result = lookup({ env: { COMPOSE_EXIT: "7" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Compose configuration failed");
    expect(result.stdout).toBe("");
    expect(result.calls).not.toContain("image inspect");
  });

  it.each(["services:\n  app:\n    environment:\n      IMAGE: stale:local\n", "x-app-service:\n  image: stale:local\nservices:\n  other:\n    image: stale:local\n"])(
    "refuses a missing service image rather than guessing a stale local tag",
    (rendered) => {
      const result = lookup({ rendered });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Compose returned no image");
      expect(result.stdout).toBe("");
      expect(result.calls).not.toContain("image inspect");
    },
  );

  it("still refuses an image that is not present locally", () => {
    const result = lookup({ env: { INSPECT_EXIT: "1" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unable to inspect image: resolved-app:local");
    expect(result.stdout).toBe("");
  });

  it("refuses a failed parser even when it printed a plausible image", () => {
    const result = lookup({ env: { PARSER_EXIT: "7" } });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.calls).not.toContain("image inspect");
  });

  it("consumes a large render without a pipefail error after finding the image", () => {
    const result = lookup({ rendered: `services:\n  app:\n    image: resolved-app:local\nx-large-extension:\n  data: ${"x".repeat(512 * 1024)}\n` });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("resolved-app:local");
  });
});
