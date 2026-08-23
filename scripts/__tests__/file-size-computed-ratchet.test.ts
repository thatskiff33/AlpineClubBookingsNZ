import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { evaluateComputedRatchet } from "../lib/file-size-base";

/**
 * #2979 — the ratchet's decision, with the previous length read from the base.
 *
 * These cases build THROWAWAY GIT REPOSITORIES, like the resolver's own suite,
 * and for a reason worth stating: the decision depends on WHICH FILES ARE IN THE
 * DIFF, and a harness that injects sizes without controlling the diff can only
 * prove the empty case. A first version of this file did exactly that and looked
 * like coverage while exercising neither `new-over-budget` nor
 * `grown-beyond-base` — the two findings that are the whole point.
 *
 * `countLines` is still injected, because "how long is it now" is the one input
 * that is cheaper to state than to construct.
 */

const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS) rmSync(root, { force: true, recursive: true });
  ROOTS.length = 0;
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function newRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "acb-ratchet-"));
  ROOTS.push(root);
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
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

/** Judge a repo, treating every `src/` file as production with a 700 budget. */
function judge(root: string, baseRef: string, now: Record<string, number>) {
  return evaluateComputedRatchet({
    root,
    baseRef,
    unclassified: [],
    isProductionFile: (file) => file.startsWith("src/"),
    budgetForFile: () => ({ category: "domain module", limit: 700 }),
    countLines: (_r, file) => now[file] ?? 0,
  });
}

describe("evaluateComputedRatchet — a NEW file must meet its budget", () => {
  it("fails a new file over the budget", () => {
    const repo = newRepo();
    repo.write("src/existing.ts", 10);
    const base = repo.commit("base");
    repo.write("src/fresh.ts", 10);
    repo.commit("added");

    const result = judge(repo.root, base, { "src/fresh.ts": 900 });

    const finding = result.findings.find((f) => f.file === "src/fresh.ts");
    expect(finding?.kind).toBe("new-over-budget");
    expect(finding?.severity).toBe("regression");
    expect(finding?.current).toContain("over by 200");
    expect(finding?.previous).toBeNull();
  });

  it("passes a new file inside the budget", () => {
    const repo = newRepo();
    repo.write("src/existing.ts", 10);
    const base = repo.commit("base");
    repo.write("src/fresh.ts", 10);
    repo.commit("added");

    expect(judge(repo.root, base, { "src/fresh.ts": 699 }).findings).toEqual([]);
  });

  it("treats the budget as exclusive: exactly at the limit is not over", () => {
    const repo = newRepo();
    repo.write("src/existing.ts", 10);
    const base = repo.commit("base");
    repo.write("src/fresh.ts", 10);
    repo.commit("added");

    expect(judge(repo.root, base, { "src/fresh.ts": 700 }).findings).toEqual([]);
    expect(judge(repo.root, base, { "src/fresh.ts": 701 }).findings).toHaveLength(1);
  });
});

describe("evaluateComputedRatchet — existing debt may stay but may not grow", () => {
  it("passes an already-oversized file that is unchanged in length", () => {
    // The property that lets 283 over-budget files stay without a stored list.
    const repo = newRepo();
    repo.write("src/big.ts", 1200);
    const base = repo.commit("base");
    repo.write("src/big.ts", 1200);
    writeFileSync(path.join(repo.root, "src/big.ts"), "x\n".repeat(1200), "utf8");
    repo.commit("touched, same length");

    expect(judge(repo.root, base, { "src/big.ts": 1200 }).findings).toEqual([]);
  });

  it("fails an already-oversized file that grew by one line", () => {
    const repo = newRepo();
    repo.write("src/big.ts", 1200);
    const base = repo.commit("base");
    repo.write("src/big.ts", 1201);
    repo.commit("grew");

    const finding = judge(repo.root, base, { "src/big.ts": 1201 }).findings[0];
    expect(finding?.kind).toBe("grown-beyond-base");
    expect(finding?.problem).toBe("an already-oversized file grew");
    expect(finding?.previous).toContain("1200 LOC on the base ref");
    expect(finding?.current).toContain("+1 beyond its ceiling");
  });

  it("passes an already-oversized file that SHRANK, and the smaller size becomes the ceiling", () => {
    // No ledger to re-record, and no drift: the next change is judged against
    // the shrunken length because the base ref will carry it.
    const repo = newRepo();
    repo.write("src/big.ts", 1200);
    const base = repo.commit("base");
    repo.write("src/big.ts", 900);
    const shrunk = repo.commit("shrank");

    expect(judge(repo.root, base, { "src/big.ts": 900 }).findings).toEqual([]);

    // And from the shrunken base, growing back toward the old size now fails.
    repo.write("src/big.ts", 1000);
    repo.commit("grew back");
    const after = judge(repo.root, shrunk, { "src/big.ts": 1000 });
    expect(after.findings[0]?.kind).toBe("grown-beyond-base");
  });

  it("reports every regression at once rather than stopping at the first", () => {
    // A gate that names one problem per run costs a full CI cycle per problem.
    const repo = newRepo();
    repo.write("src/big.ts", 1200);
    const base = repo.commit("base");
    repo.write("src/big.ts", 1300);
    repo.write("src/fresh.ts", 800);
    repo.commit("grew one and added another");

    const result = judge(repo.root, base, {
      "src/big.ts": 1300,
      "src/fresh.ts": 800,
    });

    expect(result.findings).toHaveLength(2);
    expect(new Set(result.findings.map((f) => f.kind))).toEqual(
      new Set(["grown-beyond-base", "new-over-budget"]),
    );
  });

  it("fails an under-budget file that crossed its budget", () => {
    const repo = newRepo();
    repo.write("src/mod.ts", 600);
    const base = repo.commit("base");
    repo.write("src/mod.ts", 800);
    repo.commit("crossed");

    const finding = judge(repo.root, base, { "src/mod.ts": 800 }).findings[0];
    expect(finding?.kind).toBe("grown-beyond-base");
    expect(finding?.problem).toBe("the file grew past its budget");
  });
});

describe("evaluateComputedRatchet — a rename cannot launder debt", () => {
  it("keeps the predecessor's ceiling and says where it came from", () => {
    // The old ledger was keyed by path, so a `.ts` to `.js` rename left its
    // entry behind and passed. Here the previous length is looked up under the
    // old path that git reports.
    const repo = newRepo();
    repo.write("src/big.ts", 1200);
    const base = repo.commit("base");
    git(repo.root, "mv", "src/big.ts", "src/big.js");
    repo.commit("renamed");

    const grown = judge(repo.root, base, { "src/big.js": 1300 });
    const finding = grown.findings[0];
    expect(finding?.kind).toBe("grown-beyond-base");
    expect(finding?.previous).toContain("renamed from src/big.ts");

    // And a rename with no growth is not a finding at all.
    expect(judge(repo.root, base, { "src/big.js": 1200 }).findings).toEqual([]);
  });

  it("gives a file moved IN from outside the scope no ceiling, so it must meet its budget", () => {
    // The regression this closes, and the reason it matters: following the
    // rename unconditionally made "move an oversized file into src/" a way to
    // arrive over budget with the gate green. The ledger caught it by scanning
    // the whole tree and finding an over-budget file with no entry.
    const repo = newRepo();
    repo.write("prisma/demo-seed.ts", 1324);
    repo.write("src/keep.ts", 10);
    const base = repo.commit("base");
    mkdirSync(path.join(repo.root, "src"), { recursive: true });
    git(repo.root, "mv", "prisma/demo-seed.ts", "src/demo-seed.ts");
    repo.commit("moved into src");

    const finding = judge(repo.root, base, { "src/demo-seed.ts": 1324 }).findings[0];
    expect(finding?.kind).toBe("new-over-budget");
    expect(finding?.severity).toBe("regression");
    expect(finding?.problem).toBe(
      "a file MOVED INTO the budgeted scope is over its budget",
    );
    expect(finding?.previous).toContain("prisma/demo-seed.ts");
    expect(finding?.current).toContain("over by 624");
  });

  it("passes the same move when the file is UNDER its budget", () => {
    // The rule is the budget, not the move. Moving a small module into src/ is
    // an ordinary thing to do and must not be a finding.
    const repo = newRepo();
    repo.write("prisma/small.ts", 300);
    repo.write("src/keep.ts", 10);
    const base = repo.commit("base");
    mkdirSync(path.join(repo.root, "src"), { recursive: true });
    git(repo.root, "mv", "prisma/small.ts", "src/small.ts");
    repo.commit("moved into src");

    expect(judge(repo.root, base, { "src/small.ts": 300 }).findings).toEqual([]);
  });

  it("closes the two-step launder: out of scope to grow, then back in", () => {
    // Both halves used to pass. PR1 moves `src/big.ts` somewhere this policy does
    // not look and grows it 1200 -> 5000 (nothing in scope changed, so: green).
    // PR2 moves it back, inheriting 5000 as its "previous length" (so: green
    // again). A 5000-line production module lands and no run ever went red.
    const repo = newRepo();
    repo.write("src/big.ts", 1200);
    const base1 = repo.commit("base");

    mkdirSync(path.join(repo.root, "out-of-scope"), { recursive: true });
    git(repo.root, "mv", "src/big.ts", "out-of-scope/big.ts");
    repo.write("out-of-scope/big.ts", 5000);
    const base2 = repo.commit("PR1: moved out and grown");

    // PR1 itself is still green, and correctly so — nothing in scope changed.
    expect(judge(repo.root, base1, { "out-of-scope/big.ts": 5000 }).findings).toEqual([]);

    git(repo.root, "mv", "out-of-scope/big.ts", "src/big2.ts");
    repo.commit("PR2: moved back in");

    const finding = judge(repo.root, base2, { "src/big2.ts": 5000 }).findings[0];
    expect(finding?.kind).toBe("new-over-budget");
    expect(finding?.current).toContain("over by 4300");
  });
});

describe("evaluateComputedRatchet — the unusable cases fail rather than pass", () => {
  it("reports an unresolvable base ref and judges nothing", () => {
    const repo = newRepo();
    repo.write("src/a.ts", 3);
    repo.commit("first");

    const result = judge(repo.root, "refs/heads/definitely-not-a-ref-2979", { "src/a.ts": 5000 });

    expect(result.baseSha).toBeNull();
    expect(result.checkedFiles).toBe(0);
    expect(result.findings.map((f) => f.kind)).toContain("base-unresolvable");
    expect(result.findings.every((f) => f.severity === "unusable")).toBe(true);
  });

  it("reports an unclassifiable source file as a hole in the gate", () => {
    const repo = newRepo();
    repo.write("src/a.ts", 3);
    const base = repo.commit("first");

    const result = evaluateComputedRatchet({
      root: repo.root,
      baseRef: base,
      unclassified: [{ file: "src/weird.mts", reason: "no rule matched" }],
      isProductionFile: () => false,
      budgetForFile: () => ({ category: "domain module", limit: 700 }),
      countLines: () => 0,
    });

    const finding = result.findings.find((f) => f.kind === "unclassified-source-file");
    expect(finding?.severity).toBe("unusable");
    expect(finding?.file).toBe("src/weird.mts");
  });

  it("ignores a non-production file however large", () => {
    const repo = newRepo();
    repo.write("docs/notes.md", 10);
    const base = repo.commit("base");
    repo.write("docs/notes.md", 9000);
    repo.commit("huge doc");

    expect(judge(repo.root, base, { "docs/notes.md": 9000 }).findings).toEqual([]);
  });
});
