import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { actionPinProblems } from "./check-action-pins.mjs";

const SHA = "a".repeat(40);
const workflow = (uses) => `jobs:
  check:
    steps:
      - uses: ${uses}
`;

describe("action commit pins", () => {
  it.each([
    ["actions/checkout@v7", false],
    ["actions/checkout@abcdef0", false],
    [`actions/checkout@${SHA}`, true],
    [`actions/checkout@${SHA} # v7`, true],
    [`'actions/checkout@${SHA}' # v7`, true],
    [`actions/checkout@${"g".repeat(40)}`, false],
    [`actions/checkout@${SHA}0`, false],
    ["./.github/actions/example", true],
    ["docker://alpine:3.22", false],
    [`docker://alpine@${SHA}`, false],
    [`docker://alpine@sha256:${"a".repeat(64)}`, false],
  ])("checks %s", (uses, accepted) => {
    expect(actionPinProblems(workflow(uses)).length === 0).toBe(accepted);
  });

  it("checks reusable workflow job references too", () => {
    expect(actionPinProblems("jobs:\n  check:\n    uses: owner/repo/.github/workflows/check.yml@main\n"))
      .toEqual([expect.stringContaining("jobs.check.uses")]);
  });

  it("checks jobs named __proto__ rather than losing them to the object prototype", () => {
    const source = workflow("actions/checkout@v7").replace("check:", "__proto__:");
    expect(actionPinProblems(source)).toEqual([
      expect.stringContaining("jobs.__proto__.steps[0]"),
    ]);
    expect(actionPinProblems(source.replace("@v7", `@${SHA}`))).toEqual([]);
  });

  it("does not mistake shell text for an action reference", () => {
    expect(actionPinProblems(`jobs:
  check:
    steps:
      - run: |
          uses: an-example@v1
`)).toEqual([]);
  });

  it("rejects unsupported flow steps rather than silently missing uses", () => {
    expect(actionPinProblems("jobs:\n  check:\n    steps:\n      - { uses: actions/checkout@v7 }\n").length).toBeGreaterThan(0);
  });

  it("fails the CLI for nested composites and yaml workflows, then passes after pinning", () => {
    const root = mkdtempSync(path.join(tmpdir(), "action-pins-"));
    const checker = path.resolve(import.meta.dirname, "check-action-pins.mjs");
    const composite = (uses) => `runs:\n  using: composite\n  steps:\n    - uses: ${uses}\n`;
    const run = () => spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    try {
      mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
      mkdirSync(path.join(root, ".github/actions/nested/check"), { recursive: true });
      const workflowFile = path.join(root, ".github/workflows/check.yaml");
      const actionFile = path.join(root, ".github/actions/nested/check/action.yaml");
      writeFileSync(workflowFile, workflow("actions/checkout@v7"));
      writeFileSync(actionFile, composite("actions/cache@v4"));
      const bad = run();
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain(".github/workflows/check.yaml");
      expect(bad.stderr).toContain("action.yaml");
      writeFileSync(workflowFile, workflow(`actions/checkout@${SHA}`));
      writeFileSync(actionFile, composite("./.github/actions/local"));
      const good = run();
      expect(good.status, good.stderr).toBe(0);
      // Malformed YAML must fail closed too.
      writeFileSync(actionFile, "runs:\n  using: composite\n    steps: invalid\n");
      expect(run().status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
