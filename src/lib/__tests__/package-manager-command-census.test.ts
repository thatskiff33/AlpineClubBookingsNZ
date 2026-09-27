import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * NO npm COMMAND IS PUBLISHED AS THE WAY TO DO SOMETHING HERE (#3673).
 *
 * The repository installs with pnpm. The failure this census exists for is not
 * a broken build — CI converts cleanly — but a clean merge that brings an npm
 * habit back in: a runbook line, a script's usage text or an agent instruction
 * that says `npm run x -- --flag`. Under pnpm that exact line passes a literal
 * `--` to the script, which a strict parser rejects, and an agent copying it
 * learns the wrong tool. Review found one on an open branch the day this
 * landed. So the places people and agents copy commands FROM are swept, and a
 * hit must either be rewritten in the pnpm spelling (`pnpm run x --flag`,
 * `pnpm exec <tool>`, `pnpm dlx <pkg>`) or be named below with its reason.
 *
 * Scope: the agent and contributor entry points, and every non-test source file
 * under `scripts/`, `e2e/`, `prisma/` and `src/` — which is where usage text,
 * `--help` output and operator-facing error messages live. History (the
 * changelog, release notes, migration SQL) is deliberately out of scope: it
 * records what was run then, and a migration's text must never be edited.
 */

const NPM_COMMAND =
  /(?<![\w/.@-])npm (?:run|test|ci|install|i|exec|start|audit)\b|(?<![\w-])npx(?:\s|$)/g;

const SCOPE = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "README.md",
  "CONFIGURATION.md",
  "docs/agents/",
  "scripts/",
  "e2e/",
  "prisma/",
  "src/",
];
const CODE = /\.(?:[cm]?[jt]sx?|sh)$/;

/**
 * The legitimate npm mentions, each with its reason. A FILE entry exempts a
 * whole file; a LINE entry exempts lines matching its pattern in that file.
 */
const ALLOWED: Array<{ file: string; line?: RegExp; reason: string }> = [
  {
    file: "*",
    line: /npm install -g pnpm@/,
    reason: "the one-time bootstrap that installs pnpm itself",
  },
  {
    file: "CONTRIBUTING.md",
    line: /^\| `np[mx] |^`npm install` or `npm ci` typed|^`npm install` fails first|^`EUNSUPPORTEDPROTOCOL`, `npm ci`|^lockfile\. `npm run` and `npx` may still/,
    reason: "the npm-to-pnpm command map and the description of how npm is refused",
  },
  {
    file: "docs/agents/CODEX_WORKFLOW.md",
    line: /^The old two-phase npm workaround \(`npm ci --ignore-scripts`/,
    reason: "names the retired Windows workaround so a reader recognises it",
  },
  {
    file: "scripts/ci/audit-dependencies.mjs",
    line: /`npm audit --audit-level=high`\. That command asks|moved from `npm audit` to/,
    reason: "the #3254/#3673 history of the gate, which used to be `npm audit`",
  },
  {
    file: "scripts/audit/audit-writer-census-manifest.ts",
    // Only the measurement notes themselves, which all say what was run to get
    // a figure ("Re-measured with", "Taken from", "MEASURED", "on this tree"…).
    line: /audit:census|npx tsx scripts\/audit\/audit-writer-census\.ts|^\/\/ `?npm run$|RE-MEASURED with `npm run$/,
    reason:
      "a dated measurement log: each note records the command that produced a figure at the time",
  },
];

function trackedFilesInScope(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...SCOPE], { encoding: "utf8" });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((file) => file.endsWith(".md") || CODE.test(file))
    .filter((file) => !/(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file));
}

function isAllowed(file: string, line: string): boolean {
  return ALLOWED.some(
    (entry) =>
      (entry.file === "*" || entry.file === file) && (entry.line === undefined || entry.line.test(line.trim())),
  );
}

describe("published commands name pnpm, not npm (#3673)", () => {
  const files = trackedFilesInScope();

  it("found the files it is meant to sweep", () => {
    // A moved directory or a changed filter must not turn this into a pass
    // over nothing.
    expect(files).toContain("AGENTS.md");
    expect(files).toContain("docs/agents/CODEX_WORKFLOW.md");
    expect(files.filter((file) => file.startsWith("scripts/")).length).toBeGreaterThan(50);
    expect(files.filter((file) => file.startsWith("src/")).length).toBeGreaterThan(500);
  });

  it("finds no npm or npx command outside the named exceptions", () => {
    const found: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        NPM_COMMAND.lastIndex = 0;
        if (NPM_COMMAND.test(line) && !isAllowed(file, line)) {
          found.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      found,
      "An npm/npx command is published where people and agents copy commands from. " +
        "Write it the pnpm way — `pnpm run <script> <args>` with no `--`, `pnpm exec <tool>`, " +
        "`pnpm dlx <pkg>@<version>` — or, if it is genuinely about npm (history, the bootstrap), " +
        "add it to ALLOWED in this file with its reason. See CONTRIBUTING.md, \"Package manager: pnpm\".",
    ).toEqual([]);
  });

  it("keeps every exception live, so the list cannot rot into blanket permission", () => {
    for (const entry of ALLOWED) {
      if (entry.file === "*") continue;
      const lines = readFileSync(entry.file, "utf8").split(/\r?\n/);
      const used = lines.some((line) => {
        NPM_COMMAND.lastIndex = 0;
        return NPM_COMMAND.test(line) && (entry.line === undefined || entry.line.test(line.trim()));
      });
      expect(used, `ALLOWED entry for ${entry.file} (${entry.reason}) no longer matches anything`).toBe(true);
    }
  });
});
