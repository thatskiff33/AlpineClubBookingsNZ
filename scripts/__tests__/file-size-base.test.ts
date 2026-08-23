import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  baseSizeOf,
  changedFilesSinceBase,
  resolveBaseRef,
  resolveBaseSizes,
  untrackedFiles,
} from "../lib/file-size-base";

/**
 * #2979 — these cases build THROWAWAY GIT REPOSITORIES rather than mocking git.
 *
 * That is deliberate. The whole point of the change is that the previous length
 * comes from git instead of from a file we wrote ourselves, so a test that mocks
 * git would assert nothing about the only question that matters. Rename
 * detection in particular is a git heuristic — asserting that `-M` reports what
 * we expect is asserting git's behaviour, and it can only be done against git.
 *
 * Each repository is a few files in a temp directory and is removed afterwards.
 */

const ROOTS: string[] = [];

/**
 * The scope predicate `resolveBaseSizes` takes, for cases that are not about
 * scope. Everything in these repositories counts as production, which is what
 * makes a rename inherit its predecessor's ceiling. The cases that ARE about
 * scope pass `underSrc` instead.
 */
const EVERYTHING_IN_SCOPE = () => true;

/** The real classifier's shape, small enough to state: production lives in src/. */
const underSrc = (file: string) => file.startsWith("src/");

afterEach(() => {
  for (const root of ROOTS) rmSync(root, { force: true, recursive: true });
  ROOTS.length = 0;
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A repository with one commit, and a helper to write files into it. */
function newRepo(): { root: string; write: (file: string, lines: number) => void; commit: (msg: string) => string } {
  const root = mkdtempSync(path.join(tmpdir(), "acb-fsb-"));
  ROOTS.push(root);
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  // A commit signature would prompt or fail in CI; this suite never signs.
  git(root, "config", "commit.gpgsign", "false");
  const write = (file: string, lines: number) => {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") + "\n", "utf8");
  };
  const commit = (msg: string) => {
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", msg);
    return git(root, "rev-parse", "HEAD").trim();
  };
  return { root, write, commit };
}

describe("resolveBaseRef", () => {
  it("resolves a real ref to its commit", () => {
    const repo = newRepo();
    repo.write("a.ts", 3);
    const sha = repo.commit("first");

    const result = resolveBaseRef(repo.root, "HEAD");

    expect(result).toEqual({ ok: true, sha });
  });

  it("FAILS, rather than passing, when the ref does not exist", () => {
    // The load-bearing case. A gate that cannot read its comparison must not
    // report a green it has not earned - the same rule `npm run pr:check`
    // follows for an unfetched origin/main.
    const repo = newRepo();
    repo.write("a.ts", 3);
    repo.commit("first");

    const result = resolveBaseRef(repo.root, "origin/main");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("origin/main");
      expect(result.error).toContain("git fetch origin main");
    }
  });

  it("returns where this branch LEFT the ref, not where the ref has got to", () => {
    // The merge base, not the tip. Without this, a branch is measured against
    // whatever has landed on `main` since it was cut, so main's own edits are
    // read as the branch's - measured on the #2979 branch itself, where seven
    // untouched `src/` files showed up in `git diff origin/main`.
    const repo = newRepo();
    repo.write("a.ts", 3);
    const forked = repo.commit("shared history");
    git(repo.root, "checkout", "--quiet", "-b", "feature");
    repo.write("feature-only.ts", 3);
    repo.commit("feature work");
    git(repo.root, "checkout", "--quiet", "-");
    repo.write("main-only.ts", 3);
    const mainTip = repo.commit("main moved on");
    git(repo.root, "checkout", "--quiet", "feature");

    const result = resolveBaseRef(repo.root, mainTip);

    expect(result).toEqual({ ok: true, sha: forked });
  });

  it("names the ref it was actually given in the remedy, not always origin/main", () => {
    // Both failure branches used to hard-code `git fetch origin main`, so a run
    // with a different base was handed an instruction about a ref it had never
    // mentioned. An instruction that does not match the input gets followed,
    // does not help, and reads as the gate being broken.
    const repo = newRepo();
    repo.write("a.ts", 3);
    repo.commit("first");

    const other = resolveBaseRef(repo.root, "origin/release-1.2");
    expect(other.ok).toBe(false);
    if (!other.ok) {
      expect(other.error).toContain("git fetch origin release-1.2");
      expect(other.error).not.toContain("git fetch origin main");
    }

    const notARemote = resolveBaseRef(repo.root, "some-local-tag");
    expect(notARemote.ok).toBe(false);
    if (!notARemote.ok) {
      expect(notARemote.error).toContain("pass --base with a ref this checkout has");
    }
  });

  it("FAILS on an all-zero base, which is a push event saying there was no before", () => {
    // GitHub sends 40 zeros as `before` when the pushed ref did not exist
    // beforehand. It resolves to nothing, so the honest answer is to refuse:
    // "no previous state" is not "no growth". Named explicitly rather than left
    // to the generic branch, whose remedy (fetch the ref) cannot ever work.
    const repo = newRepo();
    repo.write("a.ts", 3);
    repo.commit("first");

    for (const zeros of ["0".repeat(40), "0".repeat(64)]) {
      const result = resolveBaseRef(repo.root, zeros);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("all-zero object id");
        expect(result.error).not.toContain("git fetch");
      }
    }
  });

  it("FAILS on a commit this checkout does not have, such as one a force-push orphaned", () => {
    const repo = newRepo();
    repo.write("a.ts", 3);
    repo.commit("first");

    const result = resolveBaseRef(repo.root, "deadbeef".repeat(5));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Could not resolve the base ref");
  });

  it("FAILS when the ref resolves but shares no history with this checkout", () => {
    // The shallow-clone shape: resolving the ref is not the same as being able
    // to compare against it, and the difference must not be a silent pass.
    const repo = newRepo();
    repo.write("a.ts", 3);
    const original = repo.commit("first");
    git(repo.root, "checkout", "--quiet", "--orphan", "unrelated");
    git(repo.root, "rm", "-rq", "--cached", ".");
    repo.write("b.ts", 3);
    repo.commit("unrelated root");

    const result = resolveBaseRef(repo.root, original);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("shares no commit");
      expect(result.error).toContain("git fetch --unshallow");
    }
  });
});

describe("untrackedFiles", () => {
  it("lists what git is neither tracking nor ignoring", () => {
    // `git diff` cannot see an untracked file, so without this a brand-new
    // module is judged by nobody until somebody stages it.
    const repo = newRepo();
    repo.write("tracked.ts", 3);
    writeFileSync(path.join(repo.root, ".gitignore"), "ignored.ts\n", "utf8");
    repo.commit("first");
    repo.write("brand-new.ts", 3);
    repo.write("ignored.ts", 3);

    expect(untrackedFiles(repo.root)).toEqual(["brand-new.ts"]);
  });

  it("returns nothing rather than throwing outside a checkout", () => {
    expect(untrackedFiles(path.join(tmpdir(), "acb-not-a-repo-2979"))).toEqual([]);
  });
});

describe("baseSizeOf", () => {
  it("reports the length a file had at that commit, not now", () => {
    const repo = newRepo();
    repo.write("a.ts", 10);
    const first = repo.commit("first");
    repo.write("a.ts", 40);
    repo.commit("grown");

    expect(baseSizeOf(repo.root, first, "a.ts")).toEqual({ kind: "existed", lines: 10 });
  });

  it("reports absent for a path that did not exist there", () => {
    const repo = newRepo();
    repo.write("a.ts", 10);
    const first = repo.commit("first");
    repo.write("b.ts", 5);
    repo.commit("added b");

    expect(baseSizeOf(repo.root, first, "b.ts")).toEqual({ kind: "absent" });
  });

  it("counts a file with no trailing newline the same way countLines does", () => {
    const repo = newRepo();
    const full = path.join(repo.root, "a.ts");
    writeFileSync(full, "one\ntwo\nthree", "utf8");
    const sha = repo.commit("no trailing newline");

    expect(baseSizeOf(repo.root, sha, "a.ts")).toEqual({ kind: "existed", lines: 3 });
  });
});

describe("changedFilesSinceBase", () => {
  it("lists added and modified files", () => {
    const repo = newRepo();
    repo.write("keep.ts", 4);
    repo.write("grow.ts", 4);
    const base = repo.commit("base");
    repo.write("grow.ts", 9);
    repo.write("new.ts", 2);
    repo.commit("changed");

    const result = changedFilesSinceBase(repo.root, base);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changed.map((c) => c.file).sort()).toEqual(["grow.ts", "new.ts"]);
      expect(result.changed.every((c) => c.renamedFrom === undefined)).toBe(true);
    }
  });

  it("follows a rename, so the file keeps its predecessor rather than reading as new", () => {
    const repo = newRepo();
    repo.write("old-name.ts", 30);
    const base = repo.commit("base");
    git(repo.root, "mv", "old-name.ts", "new-name.ts");
    repo.commit("renamed");

    const result = changedFilesSinceBase(repo.root, base);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changed).toEqual([{ file: "new-name.ts", renamedFrom: "old-name.ts" }]);
    }
  });

  it("keeps the NUL stream aligned when a path needs quoting", () => {
    // A rename consumes two paths and every other status consumes one, so the
    // arity has to be read off the status letter. A space in a filename is the
    // cheapest way to prove the stream is not being split naively.
    const repo = newRepo();
    repo.write("plain.ts", 3);
    const base = repo.commit("base");
    repo.write("has space.ts", 3);
    repo.write("plain.ts", 6);
    repo.commit("added a spaced path");

    const result = changedFilesSinceBase(repo.root, base);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changed.map((c) => c.file).sort()).toEqual(["has space.ts", "plain.ts"]);
    }
  });
});

describe("resolveBaseSizes", () => {
  it("gives every changed file its previous length, and new files absent", () => {
    const repo = newRepo();
    repo.write("grow.ts", 12);
    repo.write("untouched.ts", 99);
    const base = repo.commit("base");
    repo.write("grow.ts", 20);
    repo.write("brand-new.ts", 5);
    repo.commit("changed");

    const result = resolveBaseSizes(repo.root, base, EVERYTHING_IN_SCOPE);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sizes.get("grow.ts")).toEqual({ kind: "existed", lines: 12 });
      expect(result.sizes.get("brand-new.ts")).toEqual({ kind: "absent" });
      // An untouched file is not in the diff at all, which is the point: the
      // check never has to look at a file this pull request did not change.
      expect(result.sizes.has("untouched.ts")).toBe(false);
    }
  });

  it("a renamed file resolves to its OLD path's length and records where from", () => {
    // This is the case the stored ledger got wrong: keyed by path, a rename left
    // the old entry behind and the new path was unlisted, so it passed.
    const repo = newRepo();
    repo.write("big.ts", 1200);
    const base = repo.commit("base");
    git(repo.root, "mv", "big.ts", "big.js");
    repo.commit("renamed to .js");

    const result = resolveBaseSizes(repo.root, base, EVERYTHING_IN_SCOPE);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sizes.get("big.js")).toEqual({
        kind: "existed",
        lines: 1200,
        from: "big.ts",
      });
    }
  });

  it("treats an untracked file as new, so it must simply meet its budget", () => {
    const repo = newRepo();
    repo.write("tracked.ts", 12);
    const base = repo.commit("base");
    repo.write("never-added.ts", 900);

    const result = resolveBaseSizes(repo.root, base, EVERYTHING_IN_SCOPE);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sizes.get("never-added.ts")).toEqual({ kind: "absent" });
    }
  });

  it("resolves a modified file and an untracked one side by side, each correctly", () => {
    // NOT a test of the `if (!sizes.has(file))` guard in the untracked sweep.
    // That guard cannot be reached: `git diff <commit>` reports only paths in
    // the base tree or the index, `git ls-files --others` reports only paths in
    // neither, and the two sets are disjoint by construction — deleting the
    // guard changed nothing across every case in this file. It stays as cheap
    // belt-and-braces; this case pins the behaviour that IS observable, which
    // is that an uncommitted edit to a tracked file keeps the base ref's length
    // while a genuinely untracked file alongside it reads as new.
    const repo = newRepo();
    repo.write("grow.ts", 1200);
    const base = repo.commit("base");
    repo.write("grow.ts", 1300);
    repo.write("never-added.ts", 40);

    const result = resolveBaseSizes(repo.root, base, EVERYTHING_IN_SCOPE);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sizes.get("grow.ts")).toEqual({ kind: "existed", lines: 1200 });
      expect(result.sizes.get("never-added.ts")).toEqual({ kind: "absent" });
    }
  });

  it("gives a file renamed in from OUTSIDE the scope no ceiling to inherit", () => {
    // The regression this closes. Following the rename unconditionally let a
    // 1324-line `prisma/demo-seed.ts` become `src/lib/demo-seed.ts` carrying its
    // own length as its ceiling — so a file entering the policy's scope for the
    // first time, at nearly twice its budget, passed. The ledger this replaced
    // caught it, because it scanned the whole tree.
    const repo = newRepo();
    repo.write("prisma/demo-seed.ts", 1324);
    repo.write("src/lib/keep.ts", 10);
    const base = repo.commit("base");
    mkdirSync(path.join(repo.root, "src/lib"), { recursive: true });
    git(repo.root, "mv", "prisma/demo-seed.ts", "src/lib/demo-seed.ts");
    repo.commit("moved into src");

    const result = resolveBaseSizes(repo.root, base, underSrc);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sizes.get("src/lib/demo-seed.ts")).toEqual({
        kind: "absent",
        movedFrom: "prisma/demo-seed.ts",
      });
    }
  });

  it("still follows a rename WITHIN the scope, so a legitimate move keeps its ceiling", () => {
    // The other half of the same rule: narrowing rename-following must not turn
    // an ordinary move of an oversized module into 1200 lines of new debt.
    const repo = newRepo();
    repo.write("src/lib/old-home.ts", 1200);
    const base = repo.commit("base");
    git(repo.root, "mv", "src/lib/old-home.ts", "src/lib/new-home.ts");
    repo.commit("moved it");

    const result = resolveBaseSizes(repo.root, base, underSrc);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sizes.get("src/lib/new-home.ts")).toEqual({
        kind: "existed",
        lines: 1200,
        from: "src/lib/old-home.ts",
      });
    }
  });

  it("propagates the unresolvable-base failure rather than returning an empty map", () => {
    // An empty map would read as "nothing changed", i.e. a pass. That is exactly
    // the false green this whole design refuses.
    const repo = newRepo();
    repo.write("a.ts", 3);
    repo.commit("first");

    const result = resolveBaseSizes(repo.root, "refs/heads/does-not-exist", EVERYTHING_IN_SCOPE);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does-not-exist");
  });
});
