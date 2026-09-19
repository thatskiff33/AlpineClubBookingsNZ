import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * The four deploy-integrity guards on `run-production-blue-green-deploy.sh` (#3539).
 *
 * Back-ported from the Tokoroa deployment fork after two production incidents: a
 * two-hour 502, and a release that existed on no remote and could not be rebuilt
 * from GitHub. Every adopter self-hosting with blue/green had the same exposure.
 *
 * The script cannot be executed here — it needs a production host, Docker, a
 * registry and a live release — so its CONTRACT is asserted from the source, the
 * convention `deploy-warmup-gate-script-contract.test.ts` and
 * `deployment-image-contracts.test.ts` already use. Each case names the property
 * that would be a production incident if it silently changed.
 */

function readRepoFile(relativePath: string) {
  // Test helper: reads a fixed repo file under process.cwd(); relativePath is test-controlled, not user input.
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

const script = readRepoFile("scripts/run-production-blue-green-deploy.sh");

/**
 * The script with its whole-line shell comments removed.
 *
 * This repository documents a defect at the site it removed it, so this file is
 * unusually dense in prose that NAMES the very things these cases ban —
 * `docker system prune`, `finished_at`, `git rev-parse HEAD`. A raw-text scan
 * would pass on the comment and never read the code, which is the "falsely
 * green" failure `INV-SSOT-004` describes. `deployment-image-contracts.test.ts`
 * uses this same line filter for shell and dotenv sources; it is not a second
 * JavaScript comment stripper.
 */
const code = script
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

describe("guard 1: a commit that exists on no remote is refused", () => {
  it("asks git whether a REMOTE branch contains the resolved commit", () => {
    // A local branch, a detached HEAD, or a tag that was never pushed all answer
    // empty. Anything weaker — a `git log` reachability check from the local
    // `main`, say — passes for a commit only this disk holds, which is the whole
    // incident.
    expect(code).toContain(
      'git -C "$SOURCE_REPO" branch -r --contains "$RESOLVED_REF"',
    );
    expect(code).toContain("validate_deploy_commit_is_published() {");
  });

  it("runs before the workspace is built, so an unpublished commit is never archived", () => {
    const resolve = code.indexOf("\nresolve_ref\n");
    const published = code.indexOf("\nvalidate_deploy_commit_is_published\n");
    const workspace = code.indexOf("\ncreate_workspace\n");

    expect(resolve).toBeGreaterThan(0);
    expect(published).toBeGreaterThan(resolve);
    expect(workspace).toBeGreaterThan(published);
  });

  it("takes BOTH a named override and a written reason, never one alone", () => {
    const guard = code.slice(
      code.indexOf("validate_deploy_commit_is_published() {"),
      code.indexOf("resolve_image_refs() {"),
    );

    expect(guard).toContain(
      'if ! env_flag_is_true "$ALLOW_UNPUBLISHED_DEPLOY_COMMIT"; then',
    );
    expect(guard).toContain(
      'if [ -z "$UNPUBLISHED_DEPLOY_COMMIT_REASON" ]; then',
    );
    // Two independent refusals: the flag alone does not unlock it.
    expect(guard.match(/return 1/g)?.length).toBe(2);
    // The override is loud in the deploy log, the way the other two overrides are.
    expect(guard).toContain("DEPLOYING AN UNPUBLISHED COMMIT");
  });

  it("defaults to refusing", () => {
    expect(code).toContain(
      'ALLOW_UNPUBLISHED_DEPLOY_COMMIT="${ALLOW_UNPUBLISHED_DEPLOY_COMMIT:-0}"',
    );
    expect(code).toContain(
      'UNPUBLISHED_DEPLOY_COMMIT_REASON="${UNPUBLISHED_DEPLOY_COMMIT_REASON:-}"',
    );
  });
});

describe("guard 2: the previous release's rollback images survive the prune", () => {
  it("pins the image ID read off the running container, never the tag", () => {
    // In local-build mode the running colour's image is the MUTABLE
    // `<project>-app:local`, and this deploy's own build re-tags that name onto
    // the new image. A hold written against the tag protects the image being
    // deployed, lets the real rollback image fall dangling into the prune, and
    // reports it retained — a hold that lies is worse than no hold.
    expect(code).toContain("capture_rollback_image_ids() {");
    expect(code).toContain(
      "image_id=\"$(docker inspect --format '{{.Image}}' \"$container_id\" 2>/dev/null || true)\"",
    );

    const capture = code.slice(
      code.indexOf("capture_rollback_image_ids() {"),
      code.indexOf("release_stale_rollback_holds() {"),
    );
    // Never resolved through the tag-shaped helper, which is what returns
    // `<project>-app:local`.
    expect(capture).not.toContain("get_service_image_ref");
    expect(capture).not.toContain("$APP_IMAGE");
  });

  it("holds each image with a stopped placeholder container", () => {
    const hold = code.slice(
      code.indexOf("hold_rollback_images() {"),
      code.indexOf("run_prune_command() {"),
    );

    expect(hold).toContain(
      'docker create --name "$holder" --label "$ROLLBACK_HOLD_LABEL=1"',
    );
    expect(hold).toContain('"$image_id"');
    // Created, never started: a prune will not remove an image any container
    // references, running or not.
    expect(hold).not.toContain("docker run");
    expect(hold).not.toContain("docker start");
  });

  it("splits the system prune, and creates the holds between the container and image passes", () => {
    const prune = code.slice(
      code.indexOf("prune_stale_docker_assets() {"),
      code.indexOf("get_service_image_ref() {"),
    );

    // `docker system prune` removes stopped containers BEFORE images and applies
    // `until` to that pass too, so a short PRUNE_UNTIL sweeps the placeholders
    // moments before the image pass they exist to guard.
    expect(prune).not.toContain("docker system prune");

    const containerPrune = prune.indexOf("docker container prune -f");
    const holds = prune.indexOf("hold_rollback_images");
    const imagePrune = prune.indexOf("docker image prune -af");

    expect(containerPrune).toBeGreaterThan(0);
    expect(holds).toBeGreaterThan(containerPrune);
    expect(imagePrune).toBeGreaterThan(holds);
    expect(prune).toContain("docker network prune -f");
  });

  it("captures the rollback images before anything is pulled, built or re-tagged", () => {
    const capture = code.indexOf("\ncapture_rollback_image_ids\n");
    const firstPrune = code.indexOf(
      'prune_stale_docker_assets "before image preparation"',
    );
    const imagePrep = code.indexOf(
      'step "9/20" "Preparing app, target web, and migration images"',
    );

    expect(capture).toBeGreaterThan(0);
    expect(firstPrune).toBeGreaterThan(capture);
    expect(imagePrep).toBeGreaterThan(firstPrune);
  });

  it("does not let placeholders accumulate one per release", () => {
    expect(code).toContain("release_stale_rollback_holds");
    expect(code).toContain(
      'docker ps -a --filter "label=$ROLLBACK_HOLD_LABEL"',
    );
  });
});

describe("guard 3: a deploy that dies after migrating leaves a record", () => {
  it("is armed before the migrate runs, not after it returns", () => {
    const migrateStep = code.indexOf('step "13/20" "Running Prisma migrations"');
    const armed = code.indexOf("MIGRATE_STEP_REACHED=1");
    const migrateRun = code.indexOf(
      'docker compose --profile "$MIGRATE_SERVICE" run --rm "$MIGRATE_SERVICE"',
    );

    expect(migrateStep).toBeGreaterThan(0);
    expect(armed).toBeGreaterThan(migrateStep);
    expect(migrateRun).toBeGreaterThan(armed);
  });

  it("selects on started_at, never on finished_at", () => {
    // A migration that fails part-way leaves `finished_at` NULL. A `finished_at`
    // filter therefore reports "the schema is very likely untouched" in exactly
    // the case where it most likely moved — the one case this record exists for.
    const query = code.slice(
      code.indexOf("query_started_migrations() {"),
      code.indexOf("fail() {", code.indexOf("query_started_migrations() {")),
    );

    expect(query).toContain("WHERE started_at IS NOT NULL");
    expect(query).not.toContain("finished_at IS NOT NULL");
    expect(query).not.toContain("finished_at IS NULL");
    // `finished_at` is reported as a VALUE, so a NULL is visible in the record
    // rather than being a filter that hides the row.
    expect(query).toContain("COALESCE(finished_at::text, 'NULL')");
  });

  it("reports an unreachable database as its own state, not as 'nothing happened'", () => {
    const writer = code.slice(
      code.indexOf("write_deploy_failure_record() {"),
      code.indexOf("query_started_migrations() {"),
    );

    expect(writer).toContain("NONE STARTED.");
    expect(writer).toContain("UNKNOWN.");
    expect(writer).toContain("The database could not be reached");
    expect(writer).toContain("treat the schema as possibly changed");
    // The two states come from different branches of the same query, so one
    // cannot silently become the other.
    expect(writer).toContain(
      'if started_output="$(query_started_migrations 2>/dev/null)"; then',
    );
  });

  it("names the step it died on, the release attempted, and whether traffic moved", () => {
    const writer = code.slice(
      code.indexOf("write_deploy_failure_record() {"),
      code.indexOf("query_started_migrations() {"),
    );

    expect(writer).toContain('echo "- Died on step: ${CURRENT_DEPLOY_STEP}"');
    expect(writer).toContain('echo "- Release attempted: ${release_attempted}"');
    expect(writer).toContain('echo "- App image: ${APP_IMAGE:-local build}"');
    expect(writer).toContain('echo "- Traffic moved: ${traffic_state}"');
    expect(writer).toContain('if [ "$SWITCHED_TRAFFIC" = "1" ]; then');
    expect(writer).toContain("## Migrations pending when this deploy began");

    // The step label is recorded by `step` itself rather than by twenty separate
    // assignments that could drift from the twenty step lines.
    expect(code).toContain('CURRENT_DEPLOY_STEP="$1 $2"');
  });

  it("writes the record before the traffic restore rewrites the state it describes", () => {
    const failBody = code.slice(
      code.lastIndexOf("fail() {"),
      code.indexOf("drop_shadow_database() {"),
    );

    const write = failBody.indexOf("write_deploy_failure_record");
    const rollback = failBody.indexOf("rollback_traffic_if_needed");

    expect(write).toBeGreaterThan(0);
    expect(rollback).toBeGreaterThan(write);
    // A failing record must not swallow the failure path itself.
    expect(failBody).toContain("write_deploy_failure_record || true");
  });

  it("tells the operator where the record went", () => {
    expect(code).toContain(
      'DEPLOY_FAILURE_RECORD_DIR="${DEPLOY_FAILURE_RECORD_DIR:-$HOME/tacbookings-deploy-failures}"',
    );
    expect(code).toContain(
      'warn "Deploy failed after the migrate step. Record written to: ${record_path}"',
    );
  });
});

describe("guard 4: host-built images carry the release identifier", () => {
  it("is a supported mode of the script, not a hand-rolled docker command", () => {
    expect(code).toContain("  --build-and-push-images)");
    expect(code).toContain("run_production_wrapper build-and-push-images");
    expect(code).toContain(
      'Usage: $0 [--build-and-push-images | --internal-blue-green-deploy]',
    );
  });

  it("exports the same build args the CI path passes", () => {
    const build = code.slice(
      code.indexOf("build_application_images_from_workspace() {"),
      code.indexOf("verify_built_image_carries_release_id() {"),
    );

    expect(build).toContain('GIT_COMMIT_SHA="$RESOLVED_REF" \\');
    expect(build).toContain('KNOWLEDGE_BUNDLE_OBSERVED_AT="$observed_at" \\');
    expect(build).toContain('RELEASE_ID="$RESOLVED_REF" \\');
    expect(build).toContain("docker compose build --pull app migrate");

    // Every one of those is a declared build arg on the app service, or the
    // export silently reaches nothing.
    const compose = readRepoFile("docker-compose.yml");
    expect(compose).toContain("GIT_COMMIT_SHA: ${GIT_COMMIT_SHA:-}");
    expect(compose).toContain(
      "KNOWLEDGE_BUNDLE_OBSERVED_AT: ${KNOWLEDGE_BUNDLE_OBSERVED_AT:-}",
    );
    expect(compose).toContain("RELEASE_ID: ${RELEASE_ID:-${GIT_COMMIT_SHA:-}}");

    // And the runner stage has to declare it, or the arg reaches the builder and
    // stops there — which is the failure the read-back below exists to catch.
    const dockerfile = readRepoFile("Dockerfile");
    expect(dockerfile).toContain("ENV RELEASE_ID=$RELEASE_ID");
  });

  it("reads the identifier back out of the built image BEFORE pushing", () => {
    const verify = code.slice(
      code.indexOf("verify_built_image_carries_release_id() {"),
      code.indexOf("push_application_images() {"),
    );

    // Asked of the image's own runtime environment, not of the build that was
    // requested — a build arg that never reached the runtime stage is invisible
    // from outside the image.
    expect(verify).toContain(
      "docker run --rm --entrypoint sh \"$APP_IMAGE\" -lc 'printf %s \"${RELEASE_ID:-}\"'",
    );
    expect(verify).toContain('if [ "$observed" != "$RESOLVED_REF" ]; then');
    expect(verify).toContain("return 1");
    expect(verify).toContain("Nothing has been pushed.");

    const verifyCall = code.indexOf("\n  verify_built_image_carries_release_id\n");
    const pushCall = code.indexOf("\n  push_application_images\n");
    expect(verifyCall).toBeGreaterThan(0);
    expect(pushCall).toBeGreaterThan(verifyCall);
  });

  it("builds only a commit that passed the published-commit check", () => {
    const mode = code.slice(
      code.indexOf('if [ "$WRAPPER_MODE" = "build-and-push-images" ]; then'),
      code.indexOf("Built and pushed ${RESOLVED_REF}"),
    );

    expect(mode).toContain("validate_source_repo_state");
    expect(mode).toContain("validate_deploy_commit_is_published");
    // A `:local` tag is a local-build placeholder, never a release.
    expect(code).toContain("Refusing to push ${image_ref}");
  });

  it("no longer aborts on `git rev-parse` inside the .git-less deploy workspace", () => {
    // The wrapper builds the workspace with `git archive`, so the local-build
    // path's bare `git rev-parse HEAD` failed and `set -e` killed the deploy with
    // no explanation. Unreachable only while the wrapper always supplies a
    // prebuilt image — and reachable the moment SKIP_APP_IMAGE_BUILD=0 is used
    // with no APP_IMAGE, which is the documented recovery path.
    const prepare = code.slice(
      code.indexOf("prepare_application_images() {"),
      code.indexOf("ROLLBACK_HOLD_LABEL="),
    );

    expect(prepare).toContain('if [ -n "${DEPLOY_COMMIT_SHA:-}" ]; then');
    expect(prepare).toContain(
      'elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
    );
    expect(prepare).toContain("is not a Git checkout");
    expect(prepare).toContain("return 1");
    // The unguarded read that aborted is gone from every branch, including the
    // `info` line that repeated it.
    expect(prepare).not.toContain("$(git rev-parse --short=12 HEAD)");

    // And the wrapper passes the commit in, so the guarded branch is the one the
    // supported path takes.
    expect(code).toContain('DEPLOY_COMMIT_SHA="$RESOLVED_REF" \\');
    expect(code).toContain(
      'DEPLOY_COMMIT_OBSERVED_AT="$(git -C "$SOURCE_REPO" show -s --format=%cI "$RESOLVED_REF")" \\',
    );
  });
});

describe("the guards do not weaken anything that already existed", () => {
  it("keeps the twenty-step engine, the warm-up gate and the migration validator", () => {
    const stepNumbers = [...code.matchAll(/step "(\d+)\/20"/g)].map((match) =>
      Number(match[1]),
    );

    expect(stepNumbers).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(code).toContain("run_warmup_gate");
    expect(code).toContain("validate_pending_migrations_blue_green_safe");
    expect(code).toContain("validate_prisma_schema_matches_migrations");
    expect(code).toContain('verify_external_health "$TARGET_SERVICE"');
  });

  it("keeps the wrapper's eight steps and its existing source-repo contract", () => {
    const stepNumbers = [...code.matchAll(/step "(\d+)\/8"/g)].map((match) =>
      Number(match[1]),
    );

    expect(stepNumbers).toEqual(
      Array.from({ length: 8 }, (_, index) => index + 1),
    );
    expect(code).toContain("Source repository must be on main before deploy.");
  });

  it("documents every new setting in CONFIGURATION.md", () => {
    const configuration = readRepoFile("CONFIGURATION.md");

    for (const name of [
      "ALLOW_UNPUBLISHED_DEPLOY_COMMIT",
      "UNPUBLISHED_DEPLOY_COMMIT_REASON",
      "DEPLOY_FAILURE_RECORD_DIR",
      "DEPLOY_COMMIT_SHA",
      "DEPLOY_COMMIT_OBSERVED_AT",
    ]) {
      expect(configuration).toContain(`\`${name}\``);
    }
  });
});
