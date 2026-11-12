import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shellFunctionSource } from "./helpers/deploy-script";

const script = readFileSync("scripts/run-production-blue-green-deploy.sh", "utf8");
const image = `caddy:2-alpine@sha256:${"a".repeat(64)}`;
const functions = ["compose_service_image_ref", "resolve_caddy_image_ref", "infer_active_service_from_caddy_autosave", "validate_caddy_contract"]
  .map((name) => shellFunctionSource(script, name)).join("\n");
const render = (reference: string) => `services:\n  other:\n    image: other:tag\n  proxy:\n    image: '${reference}'\n    environment:\n      SECRET: do-not-print\n`;
function run(body: string, reference = image) {
  return spawnSync("bash", ["-c", `set -euo pipefail
${functions}
CADDY_SERVICE=proxy
COMPOSE_PROJECT_NAME=fixture
CADDY_CONFIG_VOLUME_SUFFIX=caddy_config
CRON_SERVICE=app
BLUE_SERVICE=app_blue
GREEN_SERVICE=app_green
RESOLVED_COMPOSE_CONFIG=''
WORKSPACE="$PWD"
APP_IMAGE=''
MIGRATE_IMAGE=''
docker() {
  case "$*" in
    'compose '*) printf '%s' "$FIXTURE_RENDER" ;;
    'volume inspect '*) return 0 ;;
    'run '*) [[ "$*" == *"$FIXTURE_IMAGE"* ]] || return 9; printf app_green ;;
    *) return 8 ;;
  esac
}
${body}`], { encoding: "utf8", env: { ...process.env, FIXTURE_RENDER: render(reference), FIXTURE_IMAGE: reference } });
}

describe("compose-pinned Caddy helper", () => {
  it("uses the workspace render during early slot inference without inspecting a local image", () => {
    const result = run("infer_active_service_from_caddy_autosave");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("app_green");
    expect(result.stderr).not.toContain("do-not-print");
  });

  it("uses the existing engine render without re-rendering compose", () => {
    const result = run('RESOLVED_COMPOSE_CONFIG="$FIXTURE_RENDER"; docker() { return 8; }; resolve_caddy_image_ref');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(image);
  });

  it.each(["caddy:2-alpine", "", `caddy@sha256:${"a".repeat(63)}`])("falls back on an unresolved or unpinned image: %s", (reference) => {
    const result = run("infer_active_service_from_caddy_autosave", reference);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const validation = run("validate_caddy_contract", reference);
    expect(validation.status).toBe(1);
    expect(validation.stderr).toContain("Unable to resolve a digest-pinned Caddy image");
  });

  it("returns the existing fallback on a failed compose render or missing volume", () => {
    expect(run('docker() { return 1; }; infer_active_service_from_caddy_autosave').status).toBe(1);
    expect(run('RESOLVED_COMPOSE_CONFIG="$FIXTURE_RENDER"; docker() { return 1; }; infer_active_service_from_caddy_autosave').status).toBe(1);
  });

  it("validates with the pinned image and removes its private environment file", () => {
    const result = run(`
      resolved_service_env_value() { printf example.invalid; }
      compose_service_environment_entries() { printf 'DOMAIN: example.invalid\\n'; }
      compose_render_scalar() { printf '%s' "$1"; }
      grep() { return 0; }
      PROJECT_DIR="$PWD"
      validate_caddy_contract
      test -z "$CADDY_VALIDATION_ENV_FILE"
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("falls back if the pinned image cannot be run locally", () => {
    const result = run('RESOLVED_COMPOSE_CONFIG="$FIXTURE_RENDER"; docker() { [[ "$1" == volume ]]; }; infer_active_service_from_caddy_autosave');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("uses the helper for both Caddy runs and shares the image extraction with app lookup", () => {
    expect(script).not.toMatch(/caddy:2-alpine/);
    for (const name of ["infer_active_service_from_caddy_autosave", "validate_caddy_contract"]) {
      const source = shellFunctionSource(script, name);
      expect(source).toContain('caddy_image_ref="$(resolve_caddy_image_ref)"');
      expect(source).toContain('"$caddy_image_ref" \\\n');
    }
    expect(shellFunctionSource(script, "get_service_image_ref")).toContain('compose_service_image_ref "$rendered" "$service"');
  });
});
