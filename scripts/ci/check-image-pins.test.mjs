import { describe, expect, it } from "vitest";
import { checkImagePins, shellImagePinProblems, workflowImagePinProblems } from "./check-image-pins.mjs";

const pinned = `postgres:16@sha256:${"a".repeat(64)}`;
const workflow = (body) => `jobs:\n  check:\n${body}\n`;

describe("container image pins", () => {
  it.each([
    [pinned, true], ["postgres:16", false], [`postgres@sha256:${"a".repeat(63)}`, false],
    [`postgres@sha256:${"g".repeat(64)}`, false], [`${pinned}:extra`, false],
    ["tacbookings-e2e-app:ci", true], ["tacbookings-foreign:latest", false],
    [`ghcr.io/club/alpineclubbookingsnz-app:${"a".repeat(40)}`, true],
    ["ghcr.io/club/alpineclubbookingsnz-app:main", false], ["${PG_IMAGE}", true],
  ])("checks %s", (image, accepted) => {
    expect(workflowImagePinProblems(workflow(`    services:\n      db:\n        image: ${image}`)).length === 0).toBe(accepted);
  });

  it("covers workflow, job and step env plus container short and long forms", () => {
    for (const source of [
      `env:\n  SCANNER_IMAGE: postgres:16\n${workflow("    steps:\n      - run: true")}`,
      workflow("    env:\n      SCANNER_IMAGE: postgres:16"),
      workflow("    steps:\n      - env:\n          SCANNER_IMAGE: postgres:16\n        run: true"),
      workflow("    container: postgres:16"),
      workflow("    container:\n      image: postgres:16"),
    ]) {
      expect(workflowImagePinProblems(source)).not.toEqual([]);
      expect(workflowImagePinProblems(source.replace("postgres:16", pinned))).toEqual([]);
    }
  });

  it.each([
    'docker run --rm -v "$PWD:/repo:ro" postgres:16 scan',
    'docker run --env=MODE=test --entrypoint sh postgres:16',
    'result="$(docker run --rm postgres:16 echo ok)"',
    'docker run --rm \\\n  postgres:16',
    'PG_IMAGE="postgres:16"\ndocker run "$PG_IMAGE"',
    'export PG_IMAGE=postgres:16 # comment',
  ])("finds floating references in shell: %s", (source) => {
    expect(shellImagePinProblems(source)).not.toEqual([]);
    expect(shellImagePinProblems(source.replace("postgres:16", pinned))).toEqual([]);
    expect(workflowImagePinProblems(workflow(`    steps:\n      - run: |\n${source.split("\n").map((line) => `          ${line}`).join("\n")}`))).not.toEqual([]);
  });

  it("fails closed for unsupported shapes and docker flags", () => {
    for (const source of [workflow("    services: [postgres:16]"), workflow("    steps: [unknown]"), workflow("    container:\n      unsupported: postgres:16"), workflow("    env: [unknown]")]) {
      expect(workflowImagePinProblems(source).length).toBeGreaterThan(0);
    }
    expect(() => workflowImagePinProblems("jobs:\n  check:\n      env:\n    bad: true")).toThrow();
    expect(shellImagePinProblems(`docker run --unknown ${pinned}`)).not.toEqual([]);
    expect(shellImagePinProblems("docker run --rm")).not.toEqual([]);
    expect(shellImagePinProblems('PG_IMAGE="$(choose_image)"')).not.toEqual([]);
  });

  it("permits only the explicit computed first-party and pinned-source definitions", () => {
    expect(shellImagePinProblems('APP_IMAGE="${GHCR_APP_IMAGE_REPOSITORY}:${RESOLVED_REF}"')).toEqual([]);
    expect(shellImagePinProblems('PG_IMAGE="${FOREIGN_REPOSITORY}:latest"')).not.toEqual([]);
    expect(workflowImagePinProblems(workflow('    env:\n      PG_IMAGE: ${{ matrix.image }}'))).not.toEqual([]);
  });

  it("checks every repository workflow and targeted script", () => {
    expect(checkImagePins(process.cwd())).toEqual([]);
  });
});
