import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveUpstreamCommit, resolveUpstreamTrust } from "../lib/budget-upstream-ref";

/**
 * #5196 — what the size ratchets may trust from a named upstream, judged in
 * throwaway repositories: which commit is U, and which paths it vouches for.
 */

const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS) rmSync(root, { force: true, recursive: true });
  ROOTS.length = 0;
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Fork and upstream from one commit holding `src/a.ts` and `src/b.ts`.
 * Upstream changes only `src/a.ts`; the fork adds a file of its own.
 */
function forkAndUpstream() {
  const root = mkdtempSync(path.join(tmpdir(), "acb-upstream-ref-"));
  ROOTS.push(root);
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text, "utf8");
  };
  const commit = (message: string) => {
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", message);
    return git(root, "rev-parse", "HEAD").trim();
  };
  write("src/a.ts", "a\n");
  write("src/b.ts", "b\n");
  const common = commit("common");
  git(root, "branch", "-M", "fork");
  git(root, "checkout", "--quiet", "-b", "upstream");
  write("src/a.ts", "a\na\n");
  const upstreamTip = commit("upstream changes a");
  git(root, "checkout", "--quiet", "fork");
  write("src/fork.ts", "f\n");
  const base = commit("fork work");
  return { root, write, commit, common, upstreamTip, base };
}

describe("resolveUpstreamCommit", () => {
  it("ignores an upstream that resolves to HEAD, and fails one that does not resolve", () => {
    const repo = forkAndUpstream();
    git(repo.root, "checkout", "--quiet", "upstream");
    expect(resolveUpstreamCommit(repo.root, "upstream")).toEqual({
      kind: "ignored-head",
      sha: repo.upstreamTip,
    });

    const missing = resolveUpstreamCommit(repo.root, "upstream/nope");
    expect(missing.kind).toBe("unusable");
  });

  it("takes U as the upstream commit this checkout contains, not the upstream tip", () => {
    const repo = forkAndUpstream();
    git(repo.root, "checkout", "--quiet", "-b", "sync");
    git(repo.root, "merge", "--quiet", "--no-ff", "--no-edit", "upstream");
    git(repo.root, "checkout", "--quiet", "upstream");
    repo.write("src/a.ts", "a\na\na\n");
    repo.commit("upstream moves on");
    git(repo.root, "checkout", "--quiet", "sync");
    expect(resolveUpstreamCommit(repo.root, "upstream")).toEqual({
      kind: "commit",
      sha: repo.upstreamTip,
    });
  });
});

describe("resolveUpstreamCommit — only upstream main's first-parent history is trusted", () => {
  /**
   * Upstream merges a pull request branch with two commits; the fork merges
   * the FIRST of them, a commit upstream's main never carried on its own.
   */
  function sideCommitFixture() {
    const repo = forkAndUpstream();
    git(repo.root, "checkout", "--quiet", "upstream");
    git(repo.root, "checkout", "--quiet", "-b", "upstream-pr");
    repo.write("src/a.ts", "half-done\n");
    const sideCommit = repo.commit("pr: first half");
    repo.write("src/a.ts", "done\n");
    repo.commit("pr: second half");
    git(repo.root, "checkout", "--quiet", "upstream");
    git(repo.root, "merge", "--quiet", "--no-ff", "--no-edit", "upstream-pr");
    git(repo.root, "checkout", "--quiet", "fork");
    git(repo.root, "checkout", "--quiet", "-b", "sync");
    git(repo.root, "merge", "--quiet", "--no-ff", "--no-edit", sideCommit);
    return { ...repo, sideCommit };
  }

  it("trusts the first-parent commit beneath a merged pull request's side commit, not the side commit", () => {
    const repo = sideCommitFixture();
    // A plain merge base would have trusted the half-finished side commit.
    expect(git(repo.root, "merge-base", "upstream", "HEAD").trim()).toBe(repo.sideCommit);
    expect(resolveUpstreamCommit(repo.root, "upstream")).toEqual({
      kind: "commit",
      sha: repo.upstreamTip,
    });
  });

  it("fails when HEAD shares history with upstream but holds no first-parent commit of it", () => {
    const repo = forkAndUpstream();
    // An unrelated history joins upstream main through a side branch; the
    // fork contains only that side branch.
    git(repo.root, "checkout", "--quiet", "--orphan", "side");
    git(repo.root, "rm", "-rf", "--quiet", ".");
    repo.write("src/side.ts", "s\n");
    const side = repo.commit("side root");
    git(repo.root, "checkout", "--quiet", "upstream");
    git(repo.root, "merge", "--quiet", "--no-ff", "--no-edit", "--allow-unrelated-histories", "side");
    git(repo.root, "checkout", "--quiet", "-b", "side-only", side);

    const result = resolveUpstreamCommit(repo.root, "upstream");
    expect(result.kind).toBe("unusable");
    if (result.kind !== "unusable") return;
    expect(result.error).toContain("first-parent");
  });
});

describe("resolveUpstreamTrust", () => {
  it("vouches only for the paths upstream changed since the fork's base met it", () => {
    const repo = forkAndUpstream();
    git(repo.root, "checkout", "--quiet", "-b", "sync");
    git(repo.root, "merge", "--quiet", "--no-ff", "--no-edit", "upstream");
    const trust = resolveUpstreamTrust(repo.root, "upstream", repo.base);
    expect(trust.kind).toBe("trusted");
    if (trust.kind !== "trusted") return;
    expect(trust.sha).toBe(repo.upstreamTip);
    expect(trust.subject).toBe("upstream changes a");
    expect(trust.mergeBase).toBe(repo.common);
    expect([...trust.changedPaths]).toEqual(["src/a.ts"]);
    expect(trust.contentAt("src/a.ts")?.toString("utf8")).toBe("a\na\n");
    // Unchanged between M and U: no upstream baseline, though U has the file.
    expect(trust.contentAt("src/b.ts")).toBeNull();
  });

  it("vouches for nothing once the fork's base already contains U", () => {
    const repo = forkAndUpstream();
    git(repo.root, "merge", "--quiet", "--no-ff", "--no-edit", "upstream");
    const syncedBase = git(repo.root, "rev-parse", "HEAD").trim();
    git(repo.root, "checkout", "--quiet", "-b", "later");
    repo.write("src/fork.ts", "f\nf\n");
    repo.commit("later fork work");
    const trust = resolveUpstreamTrust(repo.root, "upstream", syncedBase);
    expect(trust.kind).toBe("trusted");
    if (trust.kind !== "trusted") return;
    expect(trust.changedPaths.size).toBe(0);
  });

  it("vouches for nothing when the fork has not merged the upstream tip", () => {
    const repo = forkAndUpstream();
    git(repo.root, "checkout", "--quiet", "-b", "no-sync");
    repo.write("src/a.ts", "mine\n");
    repo.commit("fork edits a itself");
    const trust = resolveUpstreamTrust(repo.root, "upstream", repo.base);
    expect(trust.kind).toBe("trusted");
    if (trust.kind !== "trusted") return;
    expect(trust.sha).toBe(repo.common);
    expect(trust.changedPaths.size).toBe(0);
    expect(trust.contentAt("src/a.ts")).toBeNull();
  });

  it("fails, rather than ignoring, an upstream ref that does not resolve", () => {
    const repo = forkAndUpstream();
    const trust = resolveUpstreamTrust(repo.root, "upstream/nope", repo.base);
    expect(trust.kind).toBe("unusable");
    if (trust.kind !== "unusable") return;
    expect(trust.error).toContain("upstream/nope");
  });

  it("fails when the trusted upstream shares no history with the fork's base", () => {
    const repo = forkAndUpstream();
    git(repo.root, "checkout", "--quiet", "--orphan", "lonely");
    git(repo.root, "rm", "-rf", "--quiet", ".");
    repo.write("src/lonely.ts", "l\n");
    const lonelyBase = repo.commit("unrelated base");
    git(repo.root, "merge", "--quiet", "--no-ff", "--no-edit", "--allow-unrelated-histories", "upstream");

    const trust = resolveUpstreamTrust(repo.root, "upstream", lonelyBase);
    expect(trust.kind).toBe("unusable");
    if (trust.kind !== "unusable") return;
    expect(trust.error).toContain("shares no readable history");
  });
});
