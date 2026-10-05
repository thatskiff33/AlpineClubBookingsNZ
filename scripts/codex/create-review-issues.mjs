#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

function hasFlag(name) {
  return args.includes(name);
}

function valueAfter(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage() {
  return `Usage:
  node scripts/codex/create-review-issues.mjs [--dry-run] [--create] [--repo owner/name] [--input issues.json]

Default is --dry-run. --create requires gh CLI authentication.`;
}

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
}

function requireGh() {
  const version = run("gh", ["--version"]);
  if (version.error || version.status !== 0) {
    throw new Error("gh CLI is required for --create. Install gh and authenticate before creating issues.");
  }
  const auth = run("gh", ["auth", "status"]);
  if (auth.status !== 0) {
    throw new Error("gh CLI is not authenticated. Run `gh auth login` before creating issues.");
  }
}

function loadIssues(inputPath) {
  if (!inputPath) {
    return [
      {
        title: "[Review plan] Security attack-surface follow-up",
        labels: ["codex-review-plan", "workstream:security", "risk:high"],
        body: [
          "Planning-only review issue.",
          "",
          "Read `AGENTS.md` and its matching routing rows, then `docs/agents/REVIEW_SEVERITY.md`. In `docs/SECURITY-ATTACK-SURFACE.md`, read the headings, then only the sections for the surfaces under review.",
          "",
          "Do not edit application code. Produce focused findings or issue splits with safe validation expectations.",
        ].join("\n"),
      },
      {
        title: "[Review plan] Booking, payment, and lifecycle state machines",
        labels: ["codex-review-plan", "workstream:booking", "workstream:payments", "risk:high"],
        body: [
          "Planning-only review issue.",
          "",
          "Read `AGENTS.md`, then the `INV-*` files its routing table sends you to for the surfaces you touch. In `docs/STATE_MACHINES.md` and `docs/END_TO_END_TEST_MATRIX.md`, read the headings, then only the matching sections. Cite `INV-*` ids, never line numbers.",
          "",
          "Do not edit application code. Verify state-machine assumptions and propose focused implementation issues.",
        ].join("\n"),
      },
    ];
  }

  const raw = fs.readFileSync(inputPath, "utf8");
  const parsed = JSON.parse(raw);
  const issues = Array.isArray(parsed) ? parsed : parsed.issues;
  if (!Array.isArray(issues)) {
    throw new Error("Input JSON must be an array or an object with an `issues` array.");
  }
  return issues.map((issue, index) => {
    if (!issue.title || !issue.body) {
      throw new Error(`Issue at index ${index} must include title and body.`);
    }
    return {
      title: String(issue.title),
      body: String(issue.body),
      labels: Array.isArray(issue.labels) ? issue.labels.map(String) : [],
    };
  });
}

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(usage());
  process.exit(0);
}

const create = hasFlag("--create");
const dryRun = !create || hasFlag("--dry-run");
const repo = valueAfter("--repo");
const inputPath = valueAfter("--input");

try {
  const issues = loadIssues(inputPath);

  if (dryRun) {
    console.log("Dry run: proposed GitHub Issues. No issues were created.");
    console.log(JSON.stringify(issues, null, 2));
    process.exit(0);
  }

  requireGh();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-review-issues-"));
  for (const issue of issues) {
    const bodyFile = path.join(tempDir, `${issue.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 50)}.md`);
    fs.writeFileSync(bodyFile, issue.body);
    const ghArgs = ["issue", "create", "--title", issue.title, "--body-file", bodyFile];
    if (repo) {
      ghArgs.push("--repo", repo);
    }
    for (const label of issue.labels) {
      ghArgs.push("--label", label);
    }
    const result = run("gh", ghArgs, { stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(`gh issue create failed for: ${issue.title}`);
    }
  }
} catch (error) {
  console.error(`create-review-issues: ${error.message}`);
  process.exit(1);
}
