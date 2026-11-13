import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.join(import.meta.dirname, "sekreton-fetch-base.sh");
const repos = [];
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repository() {
  const cwd = mkdtempSync(path.join(tmpdir(), "sekreton-base-"));
  repos.push(cwd);
  git(cwd, "init", "--initial-branch=main");
  git(cwd, "config", "user.name", "Test Agent");
  git(cwd, "config", "user.email", "agent@example.test");
  git(cwd, "commit", "--allow-empty", "-m", "Initial base");
  return cwd;
}

function prepare(cwd) {
  return spawnSync("bash", [script], { cwd, encoding: "utf8" });
}

afterEach(() => {
  for (const cwd of repos.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("Sekreton check base", () => {
  it("installs the local main snapshot without confusing it with the task head", () => {
    const cwd = repository();
    const base = git(cwd, "rev-parse", "main");
    git(cwd, "checkout", "-b", "task");
    git(cwd, "commit", "--allow-empty", "-m", "Task change");
    const head = git(cwd, "rev-parse", "HEAD");
    const result = prepare(cwd);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("local main snapshot");
    expect(git(cwd, "rev-parse", "origin/main")).toBe(base);
    expect(git(cwd, "rev-parse", "HEAD")).toBe(head);
    expect(git(cwd, "remote")).toBe("");
  });

  it("fetches the configured origin instead of trusting an older local main", () => {
    const upstream = repository();
    const cwd = repository();
    git(upstream, "commit", "--allow-empty", "-m", "New upstream base");
    git(cwd, "remote", "add", "origin", upstream);
    const result = prepare(cwd);
    expect(result.status, result.stderr).toBe(0);
    expect(git(cwd, "rev-parse", "origin/main")).toBe(git(upstream, "rev-parse", "main"));
    expect(git(cwd, "rev-parse", "main")).not.toBe(git(cwd, "rev-parse", "origin/main"));
  });

  it("fails a broken origin even when a local main is available", () => {
    const cwd = repository();
    git(cwd, "remote", "add", "origin", path.join(cwd, "missing-remote"));
    expect(prepare(cwd).status).not.toBe(0);
  });

  it("fails without a local main instead of measuring against HEAD", () => {
    const cwd = repository();
    git(cwd, "branch", "-m", "task");
    expect(prepare(cwd).status).not.toBe(0);
  });

  it("refuses a local main that is not an ancestor of the task", () => {
    const cwd = repository();
    git(cwd, "checkout", "-b", "task");
    git(cwd, "commit", "--allow-empty", "-m", "Task change");
    git(cwd, "checkout", "main");
    git(cwd, "commit", "--allow-empty", "-m", "Unmerged main change");
    git(cwd, "checkout", "task");
    expect(prepare(cwd).status).not.toBe(0);
  });

  it("prepares the shared base before both required jobs run their checks", () => {
    const config = readFileSync(path.join(import.meta.dirname, "../../.sekreton/config.toml"), "utf8");
    for (const [job, command] of [
      ["fast-censuses", "pnpm run ci:fast-censuses"],
      ["migrations", "bash scripts/ci/sekreton-migration-checks.sh"],
    ]) {
      const block = config.split(`[jobs.${job}]`)[1].split("\n[")[0];
      expect(block).toContain(`bash scripts/ci/sekreton-fetch-base.sh && ${command}`);
    }
  });
});
