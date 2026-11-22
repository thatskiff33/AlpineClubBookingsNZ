import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { upstreamTrustFor } from "../lib/budget-upstream-ref";
import { ALLOWANCE_DIR, readSizeAllowances } from "../lib/file-size-allowances";
import { evaluateFunctionLengthRatchet } from "../lib/function-length-ratchet";

/**
 * #4927 — the function-length ratchet's decision, judged against real commits
 * in throwaway repositories, as the file-size ratchet's suites are: which
 * functions are judged depends on which files are in the diff, and only a real
 * diff proves that.
 *
 * A limit of 10 keeps the fixtures readable; the rule does not depend on the
 * number.
 */

const LIMIT = 10;
const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS) rmSync(root, { force: true, recursive: true });
  ROOTS.length = 0;
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A function `name` spanning exactly `lines` lines. */
function fn(name: string, lines: number, statement = "n += 1;"): string {
  const body = Array.from({ length: lines - 2 }, () => `  ${statement}`);
  return [`export function ${name}(n: number) {`, ...body, "}"].join("\n");
}

function newRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "acb-fn-ratchet-"));
  ROOTS.push(root);
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  const write = (file: string, ...functions: string[]) => {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, functions.join("\n\n") + "\n", "utf8");
  };
  const allow = (name: string, body: string) => write(`${ALLOWANCE_DIR}/${name}`, body);
  const remove = (file: string) => unlinkSync(path.join(root, file));
  const commit = (msg: string) => {
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", msg);
    return git(root, "rev-parse", "HEAD").trim();
  };
  const judge = (baseRef: string, upstreamRef?: string) => {
    const declared = readSizeAllowances(root);
    return evaluateFunctionLengthRatchet({
      root,
      baseRef,
      limit: LIMIT,
      isProductionFile: (file) => file.startsWith("src/") && file.endsWith(".ts"),
      allowances: declared.functionAllowances,
      allowanceProblems: declared.problems,
      upstream: upstreamTrustFor(root, baseRef, upstreamRef),
    });
  };
  return { root, write, allow, remove, commit, judge };
}

const kinds = (result: ReturnType<ReturnType<typeof newRepo>["judge"]>) =>
  result.findings.map((f) => `${f.kind} ${f.file}`);

describe("evaluateFunctionLengthRatchet — existing debt may stay, growth may not", () => {
  it("passes an over-limit function the change did not touch, and one it left the same length", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 40));
    repo.write("src/other.ts", fn("small", 3));
    const base = repo.commit("base");
    repo.write("src/other.ts", fn("small", 4));
    repo.write("src/door.ts", fn("cancel", 40), fn("helper", 5));
    repo.commit("touched both files");
    const result = repo.judge(base);
    expect(result.findings).toEqual([]);
    expect(result.checkedFiles).toBe(2);
  });

  it("fails an already-over-limit function that grew by one line, and passes it shrinking", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 40));
    const base = repo.commit("base");

    repo.write("src/door.ts", fn("cancel", 41));
    const grown = repo.judge(base);
    expect(kinds(grown)).toEqual(["grown-beyond-base src/door.ts#cancel"]);
    expect(grown.findings[0]?.previous).toBe("40 lines on the base ref");
    expect(grown.findings[0]?.current).toContain("+1");

    repo.write("src/door.ts", fn("cancel", 39));
    expect(repo.judge(base).findings).toEqual([]);
  });

  it("fails a function crossing the limit for the first time", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", LIMIT));
    const base = repo.commit("base");
    repo.write("src/door.ts", fn("cancel", LIMIT + 1));
    expect(kinds(repo.judge(base))).toEqual(["crossed-limit src/door.ts#cancel"]);
  });

  it("fails a NEW over-limit function, in an existing file and in an untracked one", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 3));
    const base = repo.commit("base");
    repo.write("src/door.ts", fn("cancel", 3), fn("probe", LIMIT + 1));
    repo.write("src/fresh.ts", fn("fresh", LIMIT + 5));
    expect(kinds(repo.judge(base))).toEqual([
      "new-over-limit src/door.ts#probe",
      "new-over-limit src/fresh.ts#fresh",
    ]);
  });

  it("does not judge files outside the policy's scope", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 3));
    const base = repo.commit("base");
    repo.write("scripts/tool.ts", fn("tool", 100));
    expect(repo.judge(base).findings).toEqual([]);
  });
});

describe("evaluateFunctionLengthRatchet — moves and renames", () => {
  it("follows a git rename of the file, keeping each function's base length", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 40), fn("a", 3), fn("b", 3), fn("c", 3));
    const base = repo.commit("base");
    git(repo.root, "mv", "src/door.ts", "src/cancel-door.ts");
    repo.commit("renamed");
    expect(repo.judge(base).findings).toEqual([]);

    repo.write("src/cancel-door.ts", fn("cancel", 41), fn("a", 3), fn("b", 3), fn("c", 3));
    expect(kinds(repo.judge(base))).toEqual(["grown-beyond-base src/cancel-door.ts#cancel"]);
  });

  it("follows a long function moved to its own module, so the move is not refused as new", () => {
    // The partner-sweep move #4927 plans is this shape.
    const repo = newRepo();
    repo.write("src/lifecycle.ts", fn("reconcile", 3), fn("sweep", 40));
    const base = repo.commit("base");
    repo.write("src/lifecycle.ts", fn("reconcile", 3));
    repo.write("src/sweep.ts", fn("sweep", 40));
    expect(repo.judge(base).findings).toEqual([]);

    repo.write("src/sweep.ts", fn("sweep", 41));
    const grown = repo.judge(base);
    expect(kinds(grown)).toEqual(["grown-beyond-base src/sweep.ts#sweep"]);
    expect(grown.findings[0]?.previous).toContain("(in src/lifecycle.ts)");
  });

  it("follows a function out of a file the change deleted", () => {
    const repo = newRepo();
    repo.write("src/old.ts", fn("sweep", 40));
    const base = repo.commit("base");
    repo.remove("src/old.ts");
    repo.write("src/new-home.ts", fn("other", 3), fn("sweep", 40), fn("more", 3), fn("yet", 3));
    expect(repo.judge(base).findings).toEqual([]);
  });

  it("does not guess when the name is ambiguous: two new homes are judged as new", () => {
    const repo = newRepo();
    repo.write("src/old.ts", fn("sweep", 40));
    const base = repo.commit("base");
    repo.write("src/old.ts", fn("kept", 3));
    repo.write("src/one.ts", fn("sweep", 40));
    repo.write("src/two.ts", fn("sweep", 40));
    expect(kinds(repo.judge(base))).toEqual([
      "new-over-limit src/one.ts#sweep",
      "new-over-limit src/two.ts#sweep",
    ]);
  });

  it("does not let a function moved in from outside the scope inherit a length", () => {
    const repo = newRepo();
    repo.write("scripts/big.ts", fn("tool", 40));
    repo.write("src/keep.ts", fn("keep", 3));
    const base = repo.commit("base");
    git(repo.root, "mv", "scripts/big.ts", "src/big.ts");
    repo.commit("moved into scope");
    expect(kinds(repo.judge(base))).toEqual(["new-over-limit src/big.ts#tool"]);
  });
});

describe("evaluateFunctionLengthRatchet — `function:` allowances", () => {
  const reason = "reason: the guard belongs inside the claim it protects, said out loud.\n";

  it("lets an already-over-limit function grow when this change declares its exact length", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 40));
    const base = repo.commit("base");
    repo.write("src/door.ts", fn("cancel", 42));
    repo.allow("4927-door.md", `function: src/door.ts#cancel\nlines: 42\n${reason}`);
    const result = repo.judge(base);
    expect(result.findings).toEqual([]);
    expect(result.allowancesApplied.map((a) => a.key)).toEqual(["src/door.ts#cancel"]);
  });

  it("refuses an allowance whose length is not the function's real length", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 40));
    const base = repo.commit("base");
    repo.write("src/door.ts", fn("cancel", 42));
    repo.allow("4927-door.md", `function: src/door.ts#cancel\nlines: 50\n${reason}`);
    expect(kinds(repo.judge(base))).toEqual(["allowance-mismatched src/door.ts#cancel"]);
  });

  it("refuses an allowance that would carry a function over the limit, or let a new one arrive over it", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 5));
    const base = repo.commit("base");
    repo.write("src/door.ts", fn("cancel", 20), fn("fresh", 20));
    repo.allow(
      "4927-door.md",
      `function: src/door.ts#cancel\nlines: 20\n${reason}\nfunction: src/door.ts#fresh\nlines: 20\n${reason}`,
    );
    expect(kinds(repo.judge(base))).toEqual([
      "allowance-not-permitted src/door.ts#cancel",
      "allowance-not-permitted src/door.ts#fresh",
    ]);
  });

  it("fails an allowance this change did not need", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 40));
    const base = repo.commit("base");
    repo.write("src/door.ts", fn("cancel", 40), fn("helper", 3));
    repo.allow("4927-door.md", `function: src/door.ts#cancel\nlines: 40\n${reason}`);
    expect(kinds(repo.judge(base))).toEqual(["allowance-unused src/door.ts#cancel"]);
  });

  it("ignores an allowance that merged earlier: it is inert, and the growth fails", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 40));
    repo.allow("4000-old.md", `function: src/door.ts#cancel\nlines: 41\n${reason}`);
    const base = repo.commit("base");
    repo.write("src/door.ts", fn("cancel", 41));
    expect(kinds(repo.judge(base))).toEqual(["grown-beyond-base src/door.ts#cancel"]);
  });
});

describe("evaluateFunctionLengthRatchet — fails closed", () => {
  it("fails when the base ref cannot be resolved, rather than reporting a pass", () => {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 3));
    repo.commit("base");
    const result = repo.judge("origin/does-not-exist");
    expect(kinds(result)).toEqual(["base-unresolvable null"]);
    expect(result.baseSha).toBeNull();
  });
});

describe("evaluateFunctionLengthRatchet — a fork syncing down from a trusted upstream (#5196)", () => {
  const reason = "reason: the guard belongs inside the claim it protects, said out loud.\n";

  /**
   * A fork and its upstream, both cut from one commit. Upstream then takes
   * `cancel` over the limit (before any ratchet could refuse it), grows the
   * already-long `big` under its own allowance, and adds a new long `panel`.
   * The fork merges that upstream tip into a sync branch off its own base.
   */
  function syncFixture() {
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 5));
    repo.write("src/big.ts", fn("big", 40));
    repo.commit("common");
    git(repo.root, "branch", "-M", "fork");
    git(repo.root, "checkout", "--quiet", "-b", "upstream");
    repo.write("src/door.ts", fn("cancel", 40));
    repo.write("src/big.ts", fn("big", 45));
    repo.write("src/panel.ts", fn("panel", 40));
    repo.allow("100-big.md", `function: src/big.ts#big\nlines: 45\n${reason}`);
    const upstreamTip = repo.commit("upstream work");
    git(repo.root, "checkout", "--quiet", "fork");
    repo.write("src/fork-only.ts", fn("local", 3));
    const base = repo.commit("fork work");
    git(repo.root, "checkout", "--quiet", "-b", "sync");
    git(repo.root, "merge", "--quiet", "--no-ff", "--no-edit", "upstream");
    return { ...repo, base, upstreamTip };
  }

  it("passes over-limit functions identical to upstream with no allowance, and fails them without trust", () => {
    const repo = syncFixture();
    // Without trust, upstream's fragment is live and applies to `big`; the
    // other two arrive looking new or crossing, which no allowance may cover.
    expect(kinds(repo.judge(repo.base))).toEqual([
      "crossed-limit src/door.ts#cancel",
      "new-over-limit src/panel.ts#panel",
    ]);

    const trusted = repo.judge(repo.base, "upstream");
    expect(trusted.findings).toEqual([]);
    expect(trusted.trustedUpstream).toMatchObject({
      sha: repo.upstreamTip,
      subject: "upstream work",
      lifted: 3,
      ignoredFragments: 1,
    });
  });

  it("still refuses a function the fork lengthens beyond upstream, unless the fork declares it", () => {
    const repo = syncFixture();
    repo.write("src/door.ts", fn("cancel", 41));
    const grown = repo.judge(repo.base, "upstream");
    expect(kinds(grown)).toEqual(["grown-beyond-base src/door.ts#cancel"]);
    expect(grown.findings[0]?.previous).toBe(
      `40 lines on trusted upstream ${repo.upstreamTip.slice(0, 12)}`,
    );

    repo.allow("900-fork.md", `function: src/door.ts#cancel\nlines: 41\n${reason}`);
    const declared = repo.judge(repo.base, "upstream");
    expect(declared.findings).toEqual([]);
    expect(declared.allowancesApplied.map((a) => a.source)).toEqual([`${ALLOWANCE_DIR}/900-fork.md`]);
  });

  it("still refuses a function the fork itself takes over the limit", () => {
    const repo = syncFixture();
    repo.write("src/fork-only.ts", fn("local", LIMIT + 1));
    expect(kinds(repo.judge(repo.base, "upstream"))).toEqual(["crossed-limit src/fork-only.ts#local"]);
  });

  it("keeps upstream's length for a file upstream moved where git no longer sees a rename", () => {
    // The #4800 regrouping's shape: the cumulative diff reads the move as one
    // deletion and one addition, because the rest of the file changed too.
    const repo = newRepo();
    repo.write("src/old/tab.ts", fn("tab", 40), fn("a", 6), fn("b", 6), fn("c", 6));
    repo.commit("common");
    git(repo.root, "branch", "-M", "fork");
    git(repo.root, "checkout", "--quiet", "-b", "upstream");
    repo.remove("src/old/tab.ts");
    repo.write("src/new/tab.ts", fn("tab", 45, "n -= 2;"), fn("x", 6, "n *= 3;"), fn("y", 6, "n *= 3;"));
    repo.commit("upstream regroups admin");
    git(repo.root, "checkout", "--quiet", "fork");
    repo.write("src/fork-only.ts", fn("local", 3));
    const base = repo.commit("fork work");
    git(repo.root, "checkout", "--quiet", "-b", "sync");
    git(repo.root, "merge", "--quiet", "--no-ff", "--no-edit", "upstream");

    const renames = git(repo.root, "diff", "-M", "--name-status", "--diff-filter=R", base);
    expect(renames).toBe("");
    expect(kinds(repo.judge(base))).toEqual(["grown-beyond-base src/new/tab.ts#tab"]);
    expect(repo.judge(base, "upstream").findings).toEqual([]);
  });

  it("judges a fragment the fork edited, and does not collide upstream's with the fork's", () => {
    const repo = syncFixture();
    // Upstream's fragment plus a fork fragment for the same function: only the
    // fork's is live, so there is no "one function, one allowance" collision.
    repo.write("src/big.ts", fn("big", 46));
    repo.allow("900-fork.md", `function: src/big.ts#big\nlines: 46\n${reason}`);
    const both = repo.judge(repo.base, "upstream");
    expect(both.findings).toEqual([]);
    expect(both.trustedUpstream?.ignoredFragments).toBe(1);

    // Two fork fragments for one function still collide.
    repo.allow("901-fork.md", `function: src/big.ts#big\nlines: 46\n${reason}`);
    expect(kinds(repo.judge(repo.base, "upstream"))).toContain("allowance-malformed src/big.ts#big");

    // An upstream fragment the fork edited is the fork's declaration again.
    const edited = syncFixture();
    edited.allow("100-big.md", `function: src/big.ts#big\nlines: 44\n${reason}`);
    expect(kinds(edited.judge(edited.base, "upstream"))).toEqual(["allowance-unused src/big.ts#big"]);
  });

  it("ignores trust that resolves to HEAD, returning exactly the ordinary result", () => {
    // On the upstream branch itself U is HEAD: no fork change to separate out.
    const repo = syncFixture();
    git(repo.root, "checkout", "--quiet", "upstream");
    const common = git(repo.root, "merge-base", "upstream", "fork").trim();
    const ordinary = repo.judge(common);
    expect(kinds(ordinary)).toEqual([
      "crossed-limit src/door.ts#cancel",
      "new-over-limit src/panel.ts#panel",
    ]);
    expect(ordinary.allowancesApplied.map((a) => a.key)).toEqual(["src/big.ts#big"]);
    expect(repo.judge(common, "upstream")).toStrictEqual(ordinary);
    expect(repo.judge(common, undefined)).toStrictEqual(ordinary);
  });

  it("judges a merged upstream side commit against the first-parent commit beneath it", () => {
    // Upstream's pull request branch first takes `cancel` to 60 lines and then
    // splits it back to 40 before merging. A fork that merges only that first
    // commit gets no trust for the 60: upstream's main never carried it.
    const repo = newRepo();
    repo.write("src/door.ts", fn("cancel", 5));
    repo.commit("common");
    git(repo.root, "branch", "-M", "fork");
    git(repo.root, "checkout", "--quiet", "-b", "upstream");
    repo.write("src/door.ts", fn("cancel", 40));
    const upstreamMain = repo.commit("upstream main");
    git(repo.root, "checkout", "--quiet", "-b", "upstream-pr");
    repo.write("src/door.ts", fn("cancel", 60));
    const sideCommit = repo.commit("pr: first draft");
    repo.write("src/door.ts", fn("cancel", 40), fn("rest", 5));
    repo.commit("pr: split it");
    git(repo.root, "checkout", "--quiet", "upstream");
    git(repo.root, "merge", "--quiet", "--no-ff", "--no-edit", "upstream-pr");
    git(repo.root, "checkout", "--quiet", "fork");
    repo.write("src/fork-only.ts", fn("local", 3));
    const base = repo.commit("fork work");
    git(repo.root, "checkout", "--quiet", "-b", "sync");
    git(repo.root, "merge", "--quiet", "--no-ff", "--no-edit", sideCommit);

    const result = repo.judge(base, "upstream");
    expect(result.trustedUpstream?.sha).toBe(upstreamMain);
    expect(kinds(result)).toEqual(["grown-beyond-base src/door.ts#cancel"]);
    expect(result.findings[0]?.previous).toBe(
      `40 lines on trusted upstream ${upstreamMain.slice(0, 12)}`,
    );
  });

  it("fails when the named upstream cannot be resolved, rather than judging without it", () => {
    const repo = syncFixture();
    const result = repo.judge(repo.base, "upstream/does-not-exist");
    expect(kinds(result)).toEqual(["upstream-unusable null"]);
    expect(result.findings[0]?.problem).toContain("--upstream-ref");
  });
});
