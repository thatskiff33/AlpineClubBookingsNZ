#!/usr/bin/env node
/**
 * The one hook entry point for Claude Code and Codex (#4462).
 *
 * Reads the hook event as JSON on stdin and acts on `hook_event_name`:
 *
 * - `PreToolUse`: exits 2 with a one-line reason on stderr when the call breaks
 *   a rule in `rules.mjs`; otherwise exits 0 silently and the normal
 *   permission flow decides.
 * - `Stop`: when the diff of the session's own `cwd` against its merge base
 *   with `origin/main` touches `src/`, sends the lane back once with
 *   `decision: "block"` and a reason naming the pre-push checks (and the same
 *   text as a `systemMessage` for whoever watches). It fires once per session
 *   for a given set of files, and never while `stop_hook_active` is set, so it
 *   cannot loop. A lane editing another worktree by absolute path, from a
 *   session whose `cwd` is elsewhere, is not reminded.
 *
 * It FAILS OPEN. Any internal error exits 1, which both runtimes treat as a
 * non-blocking hook error, with a note on stderr; a broken hook must never
 * stop every Bash call in every session. Only a matched rule exits 2.
 *
 * `--role=implementor` (from `.claude/agents/implementor.md`) applies the
 * implementor-only rules regardless of the input's `agent_type`.
 *
 * Node built-ins only: it runs before every Bash call an agent makes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

import { isMainModule } from "../lib/is-main-module.mjs";
import { blockMessage, findViolation } from "./rules.mjs";

/**
 * The Stop reminder. It names the section rather than copying its commands,
 * so the list has one home (`AGENTS.md` -> "Per-issue pipeline").
 */
export const PRE_PUSH_REMINDER =
  'Before pushing, run the checks in AGENTS.md -> "Per-issue pipeline" -> "Before pushing". ' +
  "If they already ran on this diff, or you are not about to push, say so and stop.";

/** Where reminder state lives: per user, so two accounts on one host do not share it. */
export function defaultStateDir() {
  let user = "user";
  try {
    user = String(userInfo().uid);
  } catch {
    // No passwd entry (some containers): fall back to a fixed name.
  }
  return path.join(tmpdir(), `agent-hooks-reminders-${user}`);
}

const GIT_TIMEOUT_MS = 4000;

/** Files under `src/` this checkout changes relative to its merge base with origin/main. */
export function changedSourceFiles(cwd) {
  const git = (args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
  const base = git(["merge-base", "HEAD", "origin/main"]).trim();
  const tracked = git(["diff", "--name-only", base, "--", "src/"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", "src/"]);
  return [...new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean))].sort();
}

/** Whether this session was already reminded about exactly these files; records it if not. */
function alreadyReminded(sessionId, files, stateDir) {
  const key = createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32);
  const fingerprint = createHash("sha256").update(files.join("\n")).digest("hex");
  const file = path.join(stateDir, `${key}.txt`);
  try {
    if (readFileSync(file, "utf8") === fingerprint) return true;
  } catch {
    // No record yet.
  }
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(file, fingerprint);
  } catch {
    // Without a record the reminder would send the lane back on every turn,
    // so an unwritable state directory skips it instead.
    return true;
  }
  return false;
}

/**
 * Decide one hook event. Pure apart from `listChanges` and the reminder state,
 * both injectable for tests. Returns `{ exitCode, stdout, stderr }`.
 */
export function runHook(input, options = {}) {
  const { role = null, listChanges = changedSourceFiles, stateDir = defaultStateDir() } = options;
  const event = input?.hook_event_name;
  if (event === "PreToolUse") {
    const rule = findViolation(input, role);
    return rule ? { exitCode: 2, stdout: "", stderr: blockMessage(rule) } : { exitCode: 0, stdout: "", stderr: "" };
  }
  if (event === "Stop" && input?.stop_hook_active !== true) {
    let files = [];
    try {
      files = listChanges(typeof input?.cwd === "string" ? input.cwd : process.cwd());
    } catch {
      // No git, no origin/main or a timeout: say nothing.
    }
    if (files.length > 0 && !alreadyReminded(input?.session_id ?? "", files, stateDir)) {
      const message = `This checkout's diff against origin/main touches ${files.length} file(s) under src/. ${PRE_PUSH_REMINDER}`;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "block", reason: message, systemMessage: message }),
        stderr: "",
      };
    }
  }
  return { exitCode: 0, stdout: "", stderr: "" };
}

/** Parse `--role=<name>` from argv. */
export function roleFromArgv(argv) {
  const flag = argv.find((arg) => arg.startsWith("--role="));
  return flag ? flag.slice("--role=".length) : null;
}

function main() {
  let result;
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    result = runHook(input, { role: roleFromArgv(process.argv.slice(2)) });
  } catch (error) {
    result = {
      exitCode: 1,
      stdout: "",
      stderr: `agent-hooks: internal error, call allowed (#4462): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}

// Compared by real path (`is-main-module.mjs`): a checkout reached through a
// symlink gives a different `argv[1]`, and a guard that silently skipped
// `main()` there would exit 0 and enforce nothing.
if (isMainModule(import.meta.url)) main();
