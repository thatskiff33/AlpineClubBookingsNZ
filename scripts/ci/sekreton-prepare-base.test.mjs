import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve("scripts/ci/sekreton-prepare-base.sh");
const fixtures = [];
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repository() {
  const cwd = mkdtempSync(path.join(tmpdir(), "sekreton-base-"));
  fixtures.push(cwd);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Test Agent");
  git(cwd, "config", "user.email", "test@example.invalid");
  commit(cwd);
  return cwd;
}
function commit(cwd, message = "Add fixture commit") {
  git(cwd, "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}
const prepare = (cwd) => spawnSync("bash", [script], { cwd, encoding: "utf8" });
afterEach(() => { for (const cwd of fixtures.splice(0)) rmSync(cwd, { recursive: true, force: true }); });

describe("Sekreton check baseline", () => {
  it("uses local main without a remote and keeps branch changes in the diff", () => {
    const cwd = repository();
    const main = git(cwd, "rev-parse", "HEAD");
    git(cwd, "checkout", "-b", "task");
    const head = commit(cwd);
    // A stale remote-tracking ref must not override the supplied main branch.
    git(cwd, "update-ref", "refs/remotes/origin/main", head);
    expect(prepare(cwd).status).toBe(0);
    expect(git(cwd, "rev-parse", "origin/main")).toBe(main);
    expect(git(cwd, "rev-list", "--count", "origin/main..HEAD")).toBe("1");
  });

  it("fetches the remote main even with no configured fetch refspec", () => {
    const remote = repository();
    const cwd = repository();
    git(cwd, "config", "remote.origin.url", remote);
    const latest = commit(remote);
    expect(prepare(cwd).status).toBe(0);
    expect(git(cwd, "rev-parse", "origin/main")).toBe(latest);
  });

  it("fails on an unreachable configured remote despite a local main", () => {
    const cwd = repository();
    git(cwd, "remote", "add", "origin", path.join(cwd, "missing.git"));
    git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    expect(prepare(cwd).status).not.toBe(0);
  });

  it("fails without local main even if a stale origin/main is present", () => {
    const cwd = repository();
    git(cwd, "branch", "-m", "task");
    git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    const result = prepare(cwd);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("neither origin nor a local main branch exists");
  });

  it("refuses a local main unrelated to the task history", () => {
    const cwd = repository();
    git(cwd, "checkout", "--orphan", "task");
    commit(cwd, "Add unrelated root");
    expect(prepare(cwd).status).not.toBe(0);
  });
});
