#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { parseWorkflowYaml } from "./check-workflow-suite-checkout-depth.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

// Source-only so CI can check pins before installing dependencies. Reuse the
// repository's YAML reader, and reject unsupported job/step shapes fail-closed.
export function actionPinProblems(source) {
  const problems = [];
  const document = parseWorkflowYaml(source);
  const isMapping = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const checkUses = (value, location) => {
    const local = typeof value === "string" && value.startsWith("./");
    const pinned = typeof value === "string" &&
      !value.startsWith("docker://") && /^[^\s@]+@[a-fA-F0-9]{40}$/.test(value);
    if (!local && !pinned) {
      problems.push(`${location}: ${JSON.stringify(value)} must be a local ./ action or an action pinned to a full 40-character commit SHA`);
    }
  };
  const checkSteps = (steps, location) => {
    if (!Array.isArray(steps)) {
      problems.push(`${location}: expected a block sequence of steps`);
      return;
    }
    steps.forEach((step, index) => {
      const stepLocation = `${location}[${index}]`;
      if (!isMapping(step) || !("uses" in step || "run" in step)) {
        problems.push(`${stepLocation}: expected a block mapping with uses or run`);
      } else if ("uses" in step) {
        checkUses(step.uses, stepLocation);
      }
    });
  };
  if ("jobs" in document) {
    if (!isMapping(document.jobs)) return ["jobs: expected a block mapping"];
    for (const [name, job] of Object.entries(document.jobs)) {
      if (!isMapping(job)) {
        problems.push(`jobs.${name}: expected a block mapping`);
      } else if ("uses" in job) {
        checkUses(job.uses, `jobs.${name}.uses`);
      } else {
        checkSteps(job.steps, `jobs.${name}.steps`);
      }
    }
  } else if (document.runs?.using === "composite") {
    checkSteps(document.runs.steps, "runs.steps");
  } else {
    problems.push("expected a workflow or composite action");
  }
  return problems;
}

export function checkActionPins(root) {
  const files = fs.readdirSync(path.join(root, ".github/workflows"))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => path.join(".github/workflows", name));
  const actions = path.join(root, ".github/actions");
  if (fs.existsSync(actions)) {
    for (const name of fs.readdirSync(actions, { recursive: true })) {
      if (/(^|[/\\])action\.ya?ml$/.test(name)) files.push(path.join(".github/actions", name));
    }
  }
  return files.flatMap((file) => {
    try {
      return actionPinProblems(fs.readFileSync(path.join(root, file), "utf8"))
        .map((problem) => `${file}: ${problem}`);
    } catch (error) {
      return [`${file}: ${error.message}`];
    }
  });
}

if (isMainModule(import.meta.url)) {
  const problems = checkActionPins(process.cwd());
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("All workflow and composite action uses are local or SHA-pinned.");
  }
}
