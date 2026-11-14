#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { parseWorkflowYaml, tokenizeShellCommands } from "./check-workflow-suite-checkout-depth.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

const mapping = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const variable = /^(?:\$\{[A-Za-z_][A-Za-z_0-9]*\}|\$[A-Za-z_][A-Za-z_0-9]*)$/;
const digest = /^[^\s@]+@sha256:[a-fA-F0-9]{64}$/;
const firstParty = /^(?:tacbookings-[\w.-]+:(?:ci|local)|ghcr\.io\/[\w.-]+\/alpineclubbookingsnz-(?:app|migrate):[a-fA-F0-9]{40})$/;

function checkReference(value, location, problems) {
  if (typeof value !== "string" || !(digest.test(value) || variable.test(value) || firstParty.test(value))) {
    problems.push(`${location}: expected a digest-pinned third-party image or an explicit first-party image, got ${JSON.stringify(value)}`);
  }
}

// Docker flags before IMAGE. Unknown flags fail closed: guessing whether a
// flag takes a value could mistake its value for the image and miss the real one.
const flags = new Set(["--rm", "-d", "--detach", "-i", "--interactive", "-t", "--tty", "--init", "--privileged", "--read-only"]);
const options = new Set(["-v", "--volume", "-e", "--env", "--env-file", "--entrypoint", "--name", "--tmpfs", "-p", "--publish", "--network", "-w", "--workdir", "-u", "--user", "--platform", "--mount", "--label", "--pull"]);

export function shellImagePinProblems(source) {
  const problems = [];
  const code = source.split(/\r?\n/).filter((line) => !line.trimStart().startsWith("#")).join("\n");
  for (const match of code.matchAll(/\b([A-Za-z_][A-Za-z_0-9]*_IMAGE)=([^\n]*)/g)) {
    const [, name, assignment] = match;
    // These app inputs are validated by the deploy's first-party image contract.
    if (["APP_IMAGE", "MIGRATE_IMAGE"].includes(name) && /^"\$\{(?:APP_IMAGE|MIGRATE_IMAGE):-\}"\s*$/.test(assignment)) continue;
    if (["APP_IMAGE", "MIGRATE_IMAGE"].includes(name) && assignment === ('"${GHCR_' + name + '_REPOSITORY}:${RESOLVED_REF}"')) continue;
    // next-build-cache reads the already pinned Dockerfile base, never a tag.
    if (name === "BASE_IMAGE" && assignment === '"$(sed -n \'s/^FROM \\([^ ]*\\) AS base$/\\1/p\' Dockerfile)"') continue;
    const value = tokenizeShellCommands(assignment)[0]?.[0]?.text;
    checkReference(value, `${name} assignment`, problems);
  }
  // Start at docker even inside a command substitution in double quotes. The
  // shared tokenizer then handles continued lines and quoted option values.
  for (const match of code.matchAll(/\bdocker\s+run\b/g)) {
    const tokens = tokenizeShellCommands(code.slice(match.index))[0]?.map((token) => token.text) ?? [];
    let index = 2;
    for (; index < tokens.length; index++) {
      const token = tokens[index];
      if (flags.has(token)) continue;
      if (options.has(token)) { index++; continue; }
      if (token.startsWith("-") && options.has(token.split("=")[0]) && token.includes("=")) continue;
      // Gitleaks supplies its volume arguments as an array; its image follows.
      if (token === "${mounts[@]}") continue;
      if (token === "--") { index++; break; }
      if (token.startsWith("-")) {
        problems.push(`docker run: unsupported option ${token}`);
        index = tokens.length;
      }
      break;
    }
    checkReference(tokens[index], "docker run image", problems);
  }
  return problems;
}

export function workflowImagePinProblems(source) {
  const document = parseWorkflowYaml(source);
  const problems = [];
  const env = (value, location) => {
    if (value === undefined) return;
    if (!mapping(value)) { problems.push(`${location}: expected an env mapping`); return; }
    for (const [key, image] of Object.entries(value)) {
      if (!key.endsWith("_IMAGE")) continue;
      // Configurable first-party GHCR repositories, always tagged by this commit.
      if (["APP_IMAGE", "MIGRATE_IMAGE"].includes(key) && typeof image === "string" &&
          /^\$\{\{ vars\.GHCR_(?:APP|MIGRATE)_IMAGE_REPOSITORY \|\| format\('ghcr\.io\/\{0\}\/alpineclubbookingsnz-(?:app|migrate)', github\.repository_owner\) \}\}:\$\{\{ github\.sha \}\}$/.test(image)) continue;
      checkReference(image, `${location}.${key}`, problems);
    }
  };
  env(document.env, "env");
  if (!mapping(document.jobs)) return [...problems, "jobs: expected a mapping"];
  for (const [name, job] of Object.entries(document.jobs)) {
    if (!mapping(job)) { problems.push(`jobs.${name}: expected a mapping`); continue; }
    env(job.env, `jobs.${name}.env`);
    if (job.services !== undefined) {
      if (!mapping(job.services)) problems.push(`jobs.${name}.services: expected a mapping`);
      else for (const [service, definition] of Object.entries(job.services)) {
        checkReference(definition?.image, `jobs.${name}.services.${service}.image`, problems);
      }
    }
    if (job.container !== undefined) {
      checkReference(mapping(job.container) ? job.container.image : job.container, `jobs.${name}.container`, problems);
    }
    if (job.steps !== undefined && !Array.isArray(job.steps)) problems.push(`jobs.${name}.steps: expected a sequence`);
    else for (const [index, step] of (job.steps ?? []).entries()) {
      if (!mapping(step)) { problems.push(`jobs.${name}.steps[${index}]: expected a mapping`); continue; }
      env(step.env, `jobs.${name}.steps[${index}].env`);
      if (step.run !== undefined) {
        if (typeof step.run !== "string") problems.push(`jobs.${name}.steps[${index}].run: expected shell text`);
        else problems.push(...shellImagePinProblems(step.run).map((problem) => `jobs.${name}.steps[${index}]: ${problem}`));
      }
    }
  }
  return problems;
}

export function checkImagePins(root) {
  const workflows = fs.readdirSync(path.join(root, ".github/workflows")).filter((name) => /\.ya?ml$/.test(name)).map((name) => `.github/workflows/${name}`);
  const scripts = ["scripts/run-production-blue-green-deploy.sh", "scripts/backup-restore-drill.sh",
    ...fs.readdirSync(path.join(root, "scripts/ci")).filter((name) => name.endsWith(".sh")).map((name) => `scripts/ci/${name}`)];
  return [...workflows, ...scripts].flatMap((file) => {
    try {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      return (workflows.includes(file) ? workflowImagePinProblems(source) : shellImagePinProblems(source)).map((problem) => `${file}: ${problem}`);
    } catch (error) {
      return [`${file}: ${error.message}`];
    }
  });
}

if (isMainModule(import.meta.url)) {
  const problems = checkImagePins(process.cwd());
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  } else console.log("All checked third-party container images are digest-pinned.");
}
