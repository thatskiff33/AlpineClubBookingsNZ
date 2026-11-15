import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const script = path.resolve("scripts/ci/sekreton-prepare-base.sh");
const repos = [];
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repo() {
  const cwd = mkdtempSync(path.resolve(".sekreton-base-test-"));
  repos.push(cwd);
  git(cwd, "init", "-b", "main");
  git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base");
  return cwd;
}
function prepare(cwd) {
  return spawnSync("bash", [script], { cwd, encoding: "utf8" });
}
afterEach(() => {
  for (const cwd of repos.splice(0)) rmSync(cwd, { recursive: true, force: true });
});
it("uses local main without a remote, keeping branch changes in the comparison", () => {
  const cwd = repo();
  const base = git(cwd, "rev-parse", "main");
  git(cwd, "checkout", "-b", "task");
  git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "task");
  expect(prepare(cwd).status).toBe(0);
  expect(git(cwd, "rev-parse", "origin/main")).toBe(base);
  expect(git(cwd, "rev-parse", "HEAD")).not.toBe(base);
});
it("fetches a configured origin rather than using stale local main", () => {
  const cwd = repo();
  const remote = repo();
  git(remote, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "new base");
  git(cwd, "remote", "add", "origin", remote);
  expect(prepare(cwd).status).toBe(0);
  expect(git(cwd, "rev-parse", "origin/main")).toBe(git(remote, "rev-parse", "main"));
});
it("fails on a broken configured remote even with local main available", () => {
  const cwd = repo();
  git(cwd, "remote", "add", "origin", path.join(cwd, "missing"));
  expect(prepare(cwd).status).not.toBe(0);
});
it("fails without either baseline rather than using HEAD", () => {
  const cwd = repo();
  git(cwd, "branch", "-m", "task");
  const result = prepare(cwd);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("No origin remote or local main baseline");
});
it("rejects a local main with no shared history", () => {
  const cwd = repo();
  git(cwd, "checkout", "--orphan", "task");
  git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "unrelated task");
  expect(prepare(cwd).status).not.toBe(0);
  expect(spawnSync("git", ["rev-parse", "--verify", "refs/remotes/origin/main"], { cwd }).status).not.toBe(0);
});
