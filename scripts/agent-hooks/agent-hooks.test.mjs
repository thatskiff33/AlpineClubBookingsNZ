import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { changedSourceFiles, roleFromArgv, runHook } from "./dispatch.mjs";
import { BASH_RULES, FORBIDDEN_EFFORT, IMPLEMENTOR_ROLE, PERMISSION_DENY_RULES, findViolation } from "./rules.mjs";
import { simpleCommands } from "./shell-commands.mjs";

const ROOT = process.cwd();
const DISPATCH = path.join(ROOT, "scripts/agent-hooks/dispatch.mjs");

const bash = (command, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...extra });
const ruleFor = (command, extra = {}, role = null) => findViolation(bash(command, extra), role)?.id ?? null;

describe("the Bash rules, for the main session and orchestrators", () => {
  const blocked = [
    ["git push --force", "force-push"],
    ["git push -f origin x", "force-push"],
    ["git push origin +x", "force-push"],
    ["git push origin +HEAD:refs/heads/x", "force-push"],
    ["git push --force-with-lease origin x", "force-push"],
    ["git push --force-with-lease=x:abc origin x", "force-push"],
    ["git push -uf origin x", "force-push"],
    ["git push --mirror", "force-push"],
    ["git -C ../wt push -f", "force-push"],
    ["cd x && git push -f", "force-push"],
    ["git status; git push --force", "force-push"],
    ["true || git push -f", "force-push"],
    ["env GIT_TRACE=1 git push -f", "force-push"],
    ["GIT_TRACE=1 git push -f", "force-push"],
    ["timeout 30 git push --force", "force-push"],
    ["nohup git push -f", "force-push"],
    ["command git push -f", "force-push"],
    ["exec git push -f", "force-push"],
    ["time npx x", "download-runner"],
    ["sudo -u me git push -f", "force-push"],
    ["xargs -n1 git push -f", "force-push"],
    ["/usr/bin/git push -f", "force-push"],
    ["bash -c 'git push -f'", "force-push"],
    ["echo \"$(git push -f)\"", "force-push"],
    ["echo `git push -f`", "force-push"],
    ["(cd x && git push -f)", "force-push"],
    ["if true; then git push -f; fi", "force-push"],
    ["git push -f 2>&1 | tail", "force-push"],
    ["gh pr merge 1 --squash", "squash-or-rebase-merge"],
    ["gh pr merge 1 -s", "squash-or-rebase-merge"],
    ["gh pr merge 1 --rebase --auto", "squash-or-rebase-merge"],
    ["gh pr merge 1 -r", "squash-or-rebase-merge"],
    ["gh pr merge 1 -ds", "squash-or-rebase-merge"],
    ["gh api -X PUT repos/o/r/pulls/1/merge -f merge_method=squash", "squash-or-rebase-merge"],
    ["npx tsx a.ts", "download-runner"],
    ["npx -y some-package@1.0.0", "download-runner"],
    ["pnpm dlx x", "download-runner"],
    ["pnpm --dir x dlx y", "download-runner"],
    ["pnpx x", "download-runner"],
    ["npm exec x", "download-runner"],
    ["yarn dlx x", "download-runner"],
    ["cd a && npx prisma generate", "download-runner"],
    ["pnpm exec prisma format", "prisma-format"],
    ["pnpm prisma format", "prisma-format"],
    ["prisma format --schema prisma/schema.prisma", "prisma-format"],
    ["./node_modules/.bin/prisma format", "prisma-format"],
    ["gh issue view 1", "gh-issue-view"],
    ["gh issue view 1 --comments", "gh-issue-view"],
    ["git commit -m \"fix $(npx something)\"", "download-runner"],
  ];
  it.each(blocked)("blocks %s", (command, id) => {
    expect(ruleFor(command)).toBe(id);
  });

  const allowed = [
    "git push origin HEAD",
    "git push -u origin fix/4462-agent-rules-as-hooks",
    "git push --follow-tags origin main",
    "git push origin feature-fix",
    "git push origin :old-branch",
    "gh pr merge 1 --merge --match-head-commit abc",
    "gh pr merge 1 --auto --merge",
    "gh pr merge 1 --merge -R owner/repo --delete-branch",
    "pnpm exec tsx a.ts",
    "pnpm exec prisma generate",
    "pnpm run db:generate",
    "pnpm install --frozen-lockfile",
    "gh issue list",
    "gh issue comment 1 --body-file x.md",
    "gh pr view 1",
    "gh api repos/o/r/pulls/1",
    // Quoted text that only MENTIONS a banned command is data.
    "git commit -m \"never use npx\"",
    "git commit -m \"x && git push -f; npx y\"",
    "git commit -m 'x && git push -f; npx y'",
    "git commit -m x\\ \\&\\&\\ git\\ push\\ -f",
    "git commit -m 'stop git push --force and gh pr merge --squash'",
    "echo \"gh issue view is banned; use pnpm run issue\"",
    "grep -rn \"prisma format\" docs/",
    "rg 'npx' AGENTS.md",
    "git commit -F - <<'EOF'\nnpx is banned\ngit push -f\ngh issue view 1\nEOF",
    "git commit -m \"$(cat <<'EOF'\nfix (thing)) npx\ngit push -f\nEOF\n)\"",
    "cat <<< 'git push -f'",
    "# git push -f\ngit status",
    "command -v npx",
    "",
  ];
  it.each(allowed)("allows %j", (command) => {
    expect(ruleFor(command)).toBeNull();
  });
});

describe("the implementor-only rules", () => {
  it("blocks git push and every gh command for the implementor role", () => {
    for (const extra of [{ agent_type: IMPLEMENTOR_ROLE }, { agent_type: `plugin:${IMPLEMENTOR_ROLE}` }]) {
      expect(ruleFor("git push origin HEAD", extra)).toBe("implementor-push");
      expect(ruleFor("cd wt && git push", extra)).toBe("implementor-push");
      expect(ruleFor("gh pr view 1", extra)).toBe("implementor-gh");
      expect(ruleFor("gh issue list", extra)).toBe("implementor-gh");
      expect(ruleFor("git commit -m x && git status", extra)).toBeNull();
      expect(ruleFor("pnpm run lint", extra)).toBeNull();
      expect(ruleFor("node scripts/issue-thread.mjs 1", extra)).toBeNull();
    }
    // The frontmatter hook passes the role on the command line instead.
    expect(ruleFor("git push origin HEAD", {}, IMPLEMENTOR_ROLE)).toBe("implementor-push");
    expect(ruleFor("gh pr view 1", {}, IMPLEMENTOR_ROLE)).toBe("implementor-gh");
  });

  it("leaves git push and gh to orchestrators and other agents", () => {
    for (const extra of [{}, { agent_type: "reviewer" }, { agent_type: "general-purpose" }, { agent_type: "not-implementor-x" }]) {
      expect(ruleFor("git push origin HEAD", extra)).toBeNull();
      expect(ruleFor("gh pr view 1", extra)).toBeNull();
      expect(ruleFor("gh pr merge 1 --auto --merge", extra)).toBeNull();
    }
  });

  it("parses the --role flag", () => {
    expect(roleFromArgv(["--role=implementor"])).toBe(IMPLEMENTOR_ROLE);
    expect(roleFromArgv([])).toBeNull();
  });
});

describe("the Agent effort ceiling", () => {
  const agent = (effort) => ({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { prompt: "x", effort } });
  it("blocks max and allows xhigh and below", () => {
    expect(findViolation(agent(FORBIDDEN_EFFORT))?.id).toBe("effort-max");
    expect(findViolation(agent(" MAX "))?.id).toBe("effort-max");
    expect(findViolation({ ...agent("max"), tool_name: "Task" })?.id).toBe("effort-max");
    for (const effort of ["xhigh", "high", "medium", "low", undefined]) expect(findViolation(agent(effort))).toBeNull();
  });
  it("ignores tools it does not govern", () => {
    expect(findViolation({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "x" } })).toBeNull();
    expect(findViolation({ hook_event_name: "PreToolUse", tool_name: "Bash" })).toBeNull();
  });
  it("reads a Codex argument vector as a command", () => {
    expect(findViolation(bash(["git", "push", "-f"]))?.id).toBe("force-push");
    expect(findViolation(bash(["bash", "-lc", "cd x && npx y"]))?.id).toBe("download-runner");
    expect(findViolation(bash(["git", "commit", "-m", "never use npx"]))).toBeNull();
  });
});

describe("the shell splitter", () => {
  it("returns each simple command with assignments and wrappers stripped", () => {
    expect(simpleCommands("A=1 env B=2 timeout 5 /usr/bin/git push && echo 'x; y' | tee z > out 2>&1")).toEqual([
      ["git", "push"],
      ["echo", "x; y"],
      ["tee", "z"],
    ]);
    expect(simpleCommands("unterminated 'quote")).toEqual([["unterminated", "quote"]]);
    expect(simpleCommands(undefined)).toEqual([]);
  });
});

describe("the settings files wire every rule to this module", () => {
  const settings = JSON.parse(readFileSync(path.join(ROOT, ".claude/settings.json"), "utf8"));

  it("denies exactly the module's native rules", () => {
    expect(settings.permissions.deny).toEqual(PERMISSION_DENY_RULES);
  });

  it("never denies natively what the hook would allow", () => {
    for (const rule of PERMISSION_DENY_RULES) {
      const [, tool, pattern] = rule.match(/^(\w+)\((.*)\)$/);
      if (tool === "Agent") {
        const [key, value] = pattern.split(":");
        expect(findViolation({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { [key]: value } })).not.toBeNull();
      } else {
        expect(findViolation(bash(pattern.replaceAll("*", "x"))), rule).not.toBeNull();
      }
    }
  });

  it("runs the dispatcher on Bash and Agent calls, failing open, and on Stop", () => {
    const [pre] = settings.hooks.PreToolUse;
    expect(pre.matcher.split("|").sort()).toEqual(["Agent", "Bash"]);
    expect(pre.hooks).toEqual([
      expect.objectContaining({ type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/scripts/agent-hooks/dispatch.mjs"], onFailure: "continue" }),
    ]);
    expect(settings.hooks.Stop[0].hooks[0]).toEqual(
      expect.objectContaining({ type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/scripts/agent-hooks/dispatch.mjs"] }),
    );
  });

  it("gives the implementor role its own hook", () => {
    const frontmatter = readFileSync(path.join(ROOT, ".claude/agents/implementor.md"), "utf8").split("\n---")[0];
    expect(frontmatter).toContain(`name: ${IMPLEMENTOR_ROLE}`);
    expect(frontmatter).toMatch(/matcher: "Bash"/);
    expect(frontmatter).toContain('args: ["${CLAUDE_PROJECT_DIR}/scripts/agent-hooks/dispatch.mjs", "--role=implementor"]');
  });

  it("runs the same dispatcher under Codex", () => {
    const codex = JSON.parse(readFileSync(path.join(ROOT, ".codex/hooks.json"), "utf8"));
    for (const event of ["PreToolUse", "Stop"]) {
      expect(codex.hooks[event][0].hooks[0].command).toContain("scripts/agent-hooks/dispatch.mjs");
    }
    expect(codex.hooks.PreToolUse[0].matcher).toBe("^Bash$");
  });

  it("is not ignored, so it is committed with the repository", () => {
    // `git check-ignore` exits 1 when the path is NOT ignored.
    expect(spawnSync("git", ["check-ignore", "--no-index", "-q", ".claude/settings.json"], { cwd: ROOT }).status).toBe(1);
  }, 10_000);
});

describe("the dispatcher as a process", () => {
  const run = (input, args = [], script = DISPATCH) =>
    spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8", timeout: 20_000 });

  it("exits 2 with the reason on a broken rule and 0 silently otherwise", () => {
    const blocked = run(JSON.stringify(bash("git push --force")));
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toMatch(/^Blocked by agent rule "force-push"/);
    const allowed = run(JSON.stringify(bash("git push origin HEAD")));
    expect([allowed.status, allowed.stdout, allowed.stderr]).toEqual([0, "", ""]);
    expect(run(JSON.stringify(bash("git push origin HEAD")), ["--role=implementor"]).status).toBe(2);
  });

  it("fails open: bad input is a non-blocking error, never a block", () => {
    for (const input of ["not json", "", "null", "[]"]) {
      const result = run(input);
      expect(result.status).not.toBe(2);
      expect([0, 1]).toContain(result.status);
    }
    const garbage = run("not json");
    expect(garbage.status).toBe(1);
    expect(garbage.stderr).toContain("internal error, call allowed");
  });

  it("still enforces when reached through a symlinked checkout", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-hooks-link-"));
    try {
      const link = path.join(dir, "dispatch.mjs");
      symlinkSync(DISPATCH, link);
      expect(run(JSON.stringify(bash("npx x")), [], link).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the Stop reminder", () => {
  const stop = (extra = {}) => ({ hook_event_name: "Stop", session_id: "s1", cwd: "/x", stop_hook_active: false, ...extra });

  it("reminds once per session and set of src/ files, and never blocks", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "agent-hooks-state-"));
    try {
      const listChanges = () => ["src/lib/a.ts"];
      const first = runHook(stop(), { listChanges, stateDir });
      expect(first.exitCode).toBe(0);
      expect(JSON.parse(first.stdout).systemMessage).toContain("pnpm run db:generate, lint, typecheck");
      expect(runHook(stop(), { listChanges, stateDir })).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(runHook(stop(), { listChanges: () => ["src/lib/a.ts", "src/lib/b.ts"], stateDir }).stdout).not.toBe("");
      expect(runHook(stop({ session_id: "s2" }), { listChanges, stateDir }).stdout).not.toBe("");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("is silent with no src/ change, while continuing a stop hook, or when git fails", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "agent-hooks-state-"));
    try {
      const quiet = { exitCode: 0, stdout: "", stderr: "" };
      expect(runHook(stop(), { listChanges: () => [], stateDir })).toEqual(quiet);
      expect(runHook(stop({ stop_hook_active: true }), { listChanges: () => ["src/a.ts"], stateDir })).toEqual(quiet);
      expect(runHook(stop(), { listChanges: () => { throw new Error("no git"); }, stateDir })).toEqual(quiet);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("lists src/ changes against the merge base with origin/main, including untracked files", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "agent-hooks-repo-"));
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@example.invalid");
      git("config", "user.name", "t");
      mkdirSync(path.join(repo, "src"));
      writeFileSync(path.join(repo, "src/kept.ts"), "1\n");
      writeFileSync(path.join(repo, "README.md"), "x\n");
      git("add", ".");
      git("commit", "-q", "-m", "base");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      expect(changedSourceFiles(repo)).toEqual([]);
      writeFileSync(path.join(repo, "README.md"), "y\n");
      expect(changedSourceFiles(repo)).toEqual([]);
      writeFileSync(path.join(repo, "src/kept.ts"), "2\n");
      writeFileSync(path.join(repo, "src/new.ts"), "3\n");
      expect(changedSourceFiles(repo)).toEqual(["src/kept.ts", "src/new.ts"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20_000);
});

it("names a decision or document for every rule", () => {
  for (const rule of BASH_RULES) {
    expect(rule.source, rule.id).toMatch(/^(?:#\d+|AGENTS\.md -> )/);
    expect(rule.reason.length, rule.id).toBeGreaterThan(20);
  }
});
